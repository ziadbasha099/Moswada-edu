/* ============================================================
   FLASHCARDS.JS — loaded only by games.html
   ------------------------------------------------------------
   Everything about the "Flashcards" game lives here: creating
   subjects/folders on the fly, adding cards, and running a
   shuffled study session with self-graded correct/wrong scoring.

   Data model — every signed-in user gets their own private data,
   mirroring the folders/links pattern already used for saved
   links elsewhere in the app:
     users/{uid}/flashcardSubjects/{subjectId}          { name, createdAt }
     users/{uid}/flashcardFolders/{folderId}             { subjectId, name, createdAt }
     users/{uid}/flashcards/{cardId}                     { subjectId, folderId, term, definition, createdAt }

   Firestore security rules (Firebase console) must restrict all
   three collections to request.auth.uid == uid, the same way
   users/{uid}/folders and users/{uid}/links already are — see
   the note added to firestore.rules.
   ============================================================ */
import {
  collection, addDoc, onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth, db, showToast, setDynamicTranslationHook, currentLang } from "./shared.js";

/* ============================================================
   CONSTANTS
   ============================================================ */
const FLASHCARD_SUBJECTS_COLLECTION = 'flashcardSubjects';
const FLASHCARD_FOLDERS_COLLECTION = 'flashcardFolders';
const FLASHCARDS_COLLECTION = 'flashcards';
const NEW_OPTION_VALUE = '__new__';

/* ============================================================
   i18n — small dictionary for the dynamic strings this feature
   needs (toasts, the live card-count hint). Everything else in
   the markup is static and already handled by shared.js via
   data-en/data-ar attributes.
   ============================================================ */
const FLASHCARDS_I18N = {
  en: {
    cardSavedToast: 'Card saved',
    enterTermAndDefinition: 'Enter both the term and the definition',
    enterSubjectName: 'Enter a subject name',
    enterFolderName: 'Enter a folder name',
    noCardsInFolder: 'This folder has no cards yet — add one first',
    cardsCount: (count) => `${count} card${count === 1 ? '' : 's'} in this folder`,
    genericError: 'Something went wrong. Please try again.',
  },
  ar: {
    cardSavedToast: 'تم حفظ البطاقة',
    enterTermAndDefinition: 'أدخل المصطلح والتعريف',
    enterSubjectName: 'أدخل اسم المادة',
    enterFolderName: 'أدخل اسم المجلد',
    noCardsInFolder: 'لا توجد بطاقات في هذا المجلد بعد — أضف واحدة أولاً',
    cardsCount: (count) => `${count} بطاقة في هذا المجلد`,
    genericError: 'حدث خطأ ما. حاول مرة أخرى.',
  }
};

/**
 * Translates a flashcards-specific key into the current language.
 * @param {string} key
 * @returns {string|Function}
 */
function ft(key){
  return FLASHCARDS_I18N[currentLang][key];
}

/* ============================================================
   STATE
   ------------------------------------------------------------
   Subjects/folders/cards are kept in memory (mirrored in
   realtime via onSnapshot), the same pattern dashboard.js uses
   for links/folders, so every read below is a cheap client-side
   filter instead of a fresh Firestore query.
   ============================================================ */
let currentUser = null;
let unsubSubjects = null;
let unsubFolders = null;
let unsubCards = null;

let subjects = [];   // { id, name }
let folders = [];    // { id, subjectId, name }
let allCards = [];   // { id, subjectId, folderId, term, definition }

let selectedSubjectId = '';
let selectedFolderId = '';

// Active study session
let studyCards = [];
let studyIndex = 0;
let correctCount = 0;
let wrongCount = 0;
let isAnswerRevealed = false;

/* ============================================================
   AUTH — mirrors games.js's own guard so this module works
   independently of it (both simply listen to the same Firebase
   auth instance from shared.js).
   ============================================================ */
onAuthStateChanged(auth, (user) => {
  if(user){
    currentUser = user;
    startListening(user.uid);
  } else {
    currentUser = null;
    stopListening();
  }
});

/**
 * Subscribes to this user's flashcard subjects/folders/cards.
 * @param {string} uid
 */
function startListening(uid){
  const subjectsQuery = query(collection(db, 'users', uid, FLASHCARD_SUBJECTS_COLLECTION), orderBy('createdAt', 'asc'));
  unsubSubjects = onSnapshot(subjectsQuery, (snap) => {
    subjects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    populateSubjectSelect();
  }, (err) => console.error('flashcard subjects listener:', err));

  const foldersQuery = query(collection(db, 'users', uid, FLASHCARD_FOLDERS_COLLECTION), orderBy('createdAt', 'asc'));
  unsubFolders = onSnapshot(foldersQuery, (snap) => {
    folders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    populateFolderSelect();
  }, (err) => console.error('flashcard folders listener:', err));

  const cardsQuery = query(collection(db, 'users', uid, FLASHCARDS_COLLECTION), orderBy('createdAt', 'asc'));
  unsubCards = onSnapshot(cardsQuery, (snap) => {
    allCards = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    updateCardsCountHint();
  }, (err) => console.error('flashcards listener:', err));
}

/** Tears down the listeners above and clears in-memory data on sign-out. */
function stopListening(){
  if(unsubSubjects){ unsubSubjects(); unsubSubjects = null; }
  if(unsubFolders){ unsubFolders(); unsubFolders = null; }
  if(unsubCards){ unsubCards(); unsubCards = null; }
  subjects = [];
  folders = [];
  allCards = [];
}

/* ============================================================
   SUBJECT / FOLDER SELECTS
   Same "pick an existing one, or create a new one" pattern
   already used for MediaFire download folders in admin.js.
   ============================================================ */

/** Repopulates the subject <select>, keeping its "+ New subject" option. */
function populateSubjectSelect(){
  const select = document.getElementById('fcSubject');
  if(!select) return;
  const previousValue = select.value;
  const newOption = select.querySelector(`option[value="${NEW_OPTION_VALUE}"]`);

  select.innerHTML = '';
  if(newOption) select.appendChild(newOption);
  subjects.forEach((subject) => {
    const option = document.createElement('option');
    option.value = subject.id;
    option.textContent = subject.name; // textContent — never innerHTML — for untrusted user text
    select.appendChild(option);
  });

  if([...select.options].some(o => o.value === previousValue)) select.value = previousValue;
}

/** Repopulates the folder <select>, scoped to whichever subject is selected. */
function populateFolderSelect(){
  const select = document.getElementById('fcFolder');
  if(!select) return;
  const previousValue = select.value;
  const newOption = select.querySelector(`option[value="${NEW_OPTION_VALUE}"]`);

  select.innerHTML = '';
  if(newOption) select.appendChild(newOption);
  folders
    .filter(folder => folder.subjectId === selectedSubjectId)
    .forEach((folder) => {
      const option = document.createElement('option');
      option.value = folder.id;
      option.textContent = folder.name;
      select.appendChild(option);
    });

  select.disabled = !selectedSubjectId;
  if([...select.options].some(o => o.value === previousValue)) select.value = previousValue;
  toggleNewFolderInputVisibility();
}

function toggleNewSubjectInputVisibility(){
  const select = document.getElementById('fcSubject');
  document.getElementById('fcNewSubject').classList.toggle('hidden', select.value !== NEW_OPTION_VALUE);
}
function toggleNewFolderInputVisibility(){
  const select = document.getElementById('fcFolder');
  document.getElementById('fcNewFolder').classList.toggle('hidden', select.value !== NEW_OPTION_VALUE);
}

/** Called on the subject <select>'s onchange. */
function handleSubjectSelectChange(){
  const select = document.getElementById('fcSubject');
  selectedSubjectId = select.value === NEW_OPTION_VALUE ? '' : select.value;
  toggleNewSubjectInputVisibility();

  // A folder chosen for the previous subject can't carry over.
  selectedFolderId = '';
  document.getElementById('fcFolder').value = NEW_OPTION_VALUE;
  populateFolderSelect();
  updateCardsCountHint();
}

/** Called on the folder <select>'s onchange. */
function handleFolderSelectChange(){
  const select = document.getElementById('fcFolder');
  selectedFolderId = select.value === NEW_OPTION_VALUE ? '' : select.value;
  toggleNewFolderInputVisibility();
  updateCardsCountHint();
}

/** Shows how many cards already exist in the selected subject/folder. */
function updateCardsCountHint(){
  const hintEl = document.getElementById('fcCardsCountHint');
  if(!hintEl) return;
  if(!selectedSubjectId || !selectedFolderId){ hintEl.textContent = ''; return; }
  const count = allCards.filter(c => c.subjectId === selectedSubjectId && c.folderId === selectedFolderId).length;
  hintEl.textContent = ft('cardsCount')(count);
}

/**
 * Resolves the subject to save under, creating one in Firestore if the
 * "+ New subject" option is selected.
 * @returns {Promise<string|null>} The subject id, or null if validation failed.
 */
async function resolveSubjectId(){
  const select = document.getElementById('fcSubject');
  if(select.value !== NEW_OPTION_VALUE) return select.value;

  const name = document.getElementById('fcNewSubject').value.trim();
  if(!name){ showToast(ft('enterSubjectName')); return null; }

  try{
    const ref = await addDoc(collection(db, 'users', currentUser.uid, FLASHCARD_SUBJECTS_COLLECTION), {
      name, createdAt: serverTimestamp()
    });
    // Reflected locally right away so the folder select can find it
    // immediately, without waiting on the realtime listener round-trip.
    subjects.push({ id: ref.id, name });
    return ref.id;
  }catch(err){
    console.error('Failed to create flashcard subject:', err);
    showToast(ft('genericError'));
    return null;
  }
}

/**
 * Resolves the folder to save under, creating one in Firestore if the
 * "+ New folder" option is selected.
 * @param {string} subjectId
 * @returns {Promise<string|null>} The folder id, or null if validation failed.
 */
async function resolveFolderId(subjectId){
  const select = document.getElementById('fcFolder');
  if(select.value !== NEW_OPTION_VALUE) return select.value;

  const name = document.getElementById('fcNewFolder').value.trim();
  if(!name){ showToast(ft('enterFolderName')); return null; }

  try{
    const ref = await addDoc(collection(db, 'users', currentUser.uid, FLASHCARD_FOLDERS_COLLECTION), {
      subjectId, name, createdAt: serverTimestamp()
    });
    folders.push({ id: ref.id, subjectId, name });
    return ref.id;
  }catch(err){
    console.error('Failed to create flashcard folder:', err);
    showToast(ft('genericError'));
    return null;
  }
}

/* ============================================================
   FLASHCARD EDITOR MODAL
   ============================================================ */

/** Opens the editor modal with a clean slate. */
function openFlashcardModal(){
  document.getElementById('fcTerm').value = '';
  document.getElementById('fcDefinition').value = '';
  document.getElementById('fcNewSubject').value = '';
  document.getElementById('fcNewFolder').value = '';
  document.getElementById('fcSubject').value = NEW_OPTION_VALUE;
  selectedSubjectId = '';
  selectedFolderId = '';
  toggleNewSubjectInputVisibility();
  populateFolderSelect();
  document.getElementById('flashcardModalBackdrop').classList.add('show');
  setTimeout(() => document.getElementById('fcSubject').focus(), 50);
}
function closeFlashcardModal(){
  document.getElementById('flashcardModalBackdrop').classList.remove('show');
}

/**
 * Reads and validates the term/definition fields.
 * @returns {{term: string, definition: string}|null} null if exactly one
 *   of the two fields was filled in (an incomplete card).
 */
function readCardFields(){
  const term = document.getElementById('fcTerm').value.trim();
  const definition = document.getElementById('fcDefinition').value.trim();
  const isPartiallyFilled = (term && !definition) || (!term && definition);
  if(isPartiallyFilled){
    showToast(ft('enterTermAndDefinition'));
    return null;
  }
  return { term, definition };
}

/**
 * Saves a flashcard under the given subject/folder.
 * @param {string} subjectId
 * @param {string} folderId
 * @param {string} term
 * @param {string} definition
 * @returns {Promise<boolean>} true on success.
 */
async function saveFlashcard(subjectId, folderId, term, definition){
  try{
    await addDoc(collection(db, 'users', currentUser.uid, FLASHCARDS_COLLECTION), {
      subjectId, folderId, term, definition, createdAt: serverTimestamp()
    });
    return true;
  }catch(err){
    console.error('Failed to save flashcard:', err);
    showToast(ft('genericError'));
    return false;
  }
}

/** "تم" — saves the current card (if filled in) and keeps the modal open for the next one. */
async function handleDoneClick(){
  if(!currentUser) return;
  const fields = readCardFields();
  if(!fields) return;

  if(!fields.term && !fields.definition){
    closeFlashcardModal();
    return;
  }

  const subjectId = await resolveSubjectId();
  if(!subjectId) return;
  const folderId = await resolveFolderId(subjectId);
  if(!folderId) return;

  const saved = await saveFlashcard(subjectId, folderId, fields.term, fields.definition);
  if(!saved) return;

  // Quick-add loop: clear just the card fields, keep the same subject/folder
  // selected, so the user can add several cards in a row without re-picking.
  document.getElementById('fcTerm').value = '';
  document.getElementById('fcDefinition').value = '';
  selectedSubjectId = subjectId;
  selectedFolderId = folderId;
  document.getElementById('fcSubject').value = subjectId;
  toggleNewSubjectInputVisibility();
  populateFolderSelect();
  document.getElementById('fcFolder').value = folderId;
  toggleNewFolderInputVisibility();
  updateCardsCountHint();
  showToast(ft('cardSavedToast'));
  document.getElementById('fcTerm').focus();
}

/** "ابدأ اللعب" — saves any pending card, then launches the study session. */
async function handleStartPlayingClick(){
  if(!currentUser) return;
  const fields = readCardFields();
  if(!fields) return;

  const subjectId = await resolveSubjectId();
  if(!subjectId) return;
  const folderId = await resolveFolderId(subjectId);
  if(!folderId) return;

  let pendingCard = null;
  if(fields.term && fields.definition){
    const saved = await saveFlashcard(subjectId, folderId, fields.term, fields.definition);
    if(!saved) return;
    pendingCard = fields;
  }

  const cardsForSession = allCards.filter(c => c.subjectId === subjectId && c.folderId === folderId);
  // The realtime listener may not have caught up with the card just saved
  // above yet — include it explicitly so the session always has it.
  if(pendingCard && !cardsForSession.some(c => c.term === pendingCard.term && c.definition === pendingCard.definition)){
    cardsForSession.push(pendingCard);
  }

  if(cardsForSession.length === 0){
    showToast(ft('noCardsInFolder'));
    return;
  }

  closeFlashcardModal();
  startStudySession(cardsForSession);
}

/* ============================================================
   STUDY SESSION
   ============================================================ */

/**
 * Returns a shuffled copy of an array (Fisher–Yates), without mutating it.
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
function shuffleArray(items){
  const shuffled = [...items];
  for(let i = shuffled.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Starts (or restarts) a study session over a set of cards.
 * @param {{term: string, definition: string}[]} cards
 */
function startStudySession(cards){
  studyCards = shuffleArray(cards);
  studyIndex = 0;
  correctCount = 0;
  wrongCount = 0;
  document.getElementById('correctCount').textContent = '0';
  document.getElementById('wrongCount').textContent = '0';
  showQuestionView();
  renderCurrentCard();
  document.getElementById('studyModalBackdrop').classList.add('show');
}

/**
 * Speaks text aloud using the browser's built-in speech synthesis
 * (Web Speech API) — the simplest option since it needs no external
 * service, API key, or extra dependency, and works fully offline in
 * every modern browser. Silently no-ops where unsupported.
 * @param {string} text
 */
function speakText(text){
  if(!text || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel(); // stop any utterance already playing
  const utterance = new SpeechSynthesisUtterance(text);
  // Naive but effective language guess: Arabic script vs. everything else,
  // so the term is read with a matching voice/accent when one is available.
  utterance.lang = /[\u0600-\u06FF]/.test(text) ? 'ar-SA' : 'en-US';
  window.speechSynthesis.speak(utterance);
}

/** Reads the current study card's term aloud (the speaker button above it). */
function speakCurrentTerm(){
  const card = studyCards[studyIndex];
  if(card) speakText(card.term);
}

/** Renders the card at studyIndex and resets its reveal state. */
function renderCurrentCard(){
  const card = studyCards[studyIndex];
  if(!card) return;
  document.getElementById('studyTerm').textContent = card.term;
  document.getElementById('studyDefinition').textContent = card.definition;
  document.getElementById('studyCounter').textContent = `${studyIndex + 1} / ${studyCards.length}`;
  hideAnswer();
}

/** Hides the definition and disables grading until "Show answer" is pressed. */
function hideAnswer(){
  isAnswerRevealed = false;
  document.getElementById('studyDefinition').classList.add('hidden');
  document.getElementById('studyRevealBtn').classList.remove('hidden');
  document.getElementById('correctBtn').disabled = true;
  document.getElementById('wrongBtn').disabled = true;
}

/** Reveals the definition and enables the correct/wrong grading buttons. */
function revealAnswer(){
  isAnswerRevealed = true;
  document.getElementById('studyDefinition').classList.remove('hidden');
  document.getElementById('studyRevealBtn').classList.add('hidden');
  document.getElementById('correctBtn').disabled = false;
  document.getElementById('wrongBtn').disabled = false;
}

/** Advances past the current card, or shows results if it was the last one. */
function advanceOrFinish(){
  if(studyIndex >= studyCards.length - 1){
    showResultsView();
  } else {
    studyIndex++;
    renderCurrentCard();
  }
}

function markCorrect(){
  if(!isAnswerRevealed) return;
  correctCount++;
  document.getElementById('correctCount').textContent = String(correctCount);
  advanceOrFinish();
}
function markWrong(){
  if(!isAnswerRevealed) return;
  wrongCount++;
  document.getElementById('wrongCount').textContent = String(wrongCount);
  advanceOrFinish();
}

/** Plain navigation, with no effect on the score. */
function prevCard(){
  if(studyIndex === 0) return;
  studyIndex--;
  renderCurrentCard();
}
function nextCard(){
  if(studyIndex >= studyCards.length - 1){
    showResultsView();
    return;
  }
  studyIndex++;
  renderCurrentCard();
}

function showResultsView(){
  document.getElementById('studyQuestionView').classList.add('hidden');
  document.getElementById('studyControls').classList.add('hidden');
  document.getElementById('resultCorrect').textContent = String(correctCount);
  document.getElementById('resultWrong').textContent = String(wrongCount);
  document.getElementById('studyResultsView').classList.remove('hidden');
  closeStudyMenu();
}
function showQuestionView(){
  document.getElementById('studyResultsView').classList.add('hidden');
  document.getElementById('studyQuestionView').classList.remove('hidden');
  document.getElementById('studyControls').classList.remove('hidden');
}

/** The ⋮ menu's only action for now: jump straight to the results screen. */
function endStudySession(){
  closeStudyMenu();
  showResultsView();
}

/** Reshuffles the same set of cards and starts over from question 1. */
function restartSession(){
  startStudySession(studyCards);
}

function closeStudyModal(){
  document.getElementById('studyModalBackdrop').classList.remove('show');
  closeStudyMenu();
  studyCards = [];
  studyIndex = 0;
}

function toggleStudyMenu(event){
  event.stopPropagation();
  document.getElementById('studyMenu').classList.toggle('hidden');
}
function closeStudyMenu(){
  const menu = document.getElementById('studyMenu');
  if(menu) menu.classList.add('hidden');
}
// Clicking anywhere outside the ⋮ menu closes it.
document.addEventListener('click', closeStudyMenu);

/* ============================================================
   i18n — refresh the one piece of dynamic text this page has
   whenever the language is switched.
   ============================================================ */
setDynamicTranslationHook(() => {
  updateCardsCountHint();
});

/* ============================================================
   Expose functions used as inline HTML event handlers (onclick=...)
   ============================================================ */
Object.assign(window, {
  openFlashcardModal, closeFlashcardModal,
  handleSubjectSelectChange, handleFolderSelectChange,
  handleDoneClick, handleStartPlayingClick,
  toggleStudyMenu, endStudySession, speakCurrentTerm,
  revealAnswer, markCorrect, markWrong, prevCard, nextCard,
  restartSession, closeStudyModal,
});
