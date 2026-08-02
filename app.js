/* ============================================================
   MOCK IMAGE HELPERS (no external asset uploads available —
   generate lightweight branded SVG placeholders on the fly)
   ============================================================ */
function placeholderThumb(seedText, hue){
  const h = hue !== undefined ? hue : Math.abs(hashCode(seedText)) % 360;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='480' height='270'>
    <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
      <stop offset='0%' stop-color='hsl(${h},45%,88%)'/><stop offset='100%' stop-color='hsl(${(h+40)%360},40%,78%)'/>
    </linearGradient></defs>
    <rect width='480' height='270' fill='url(#g)'/>
    <circle cx='240' cy='135' r='34' fill='hsl(${h},35%,40%)' opacity='0.35'/>
  </svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
}
function hashCode(str){ let hash=0; for(let i=0;i<str.length;i++){ hash = str.charCodeAt(i) + ((hash<<5)-hash); } return hash; }

/* ============================================================
   FIREBASE — Auth + Firestore
   Every signed-in user gets their own private data:
     users/{uid}/folders/{folderId}
     users/{uid}/links/{linkId}
   Firestore security rules (paste in Firebase console) must
   restrict users/{uid}/** to request.auth.uid == uid — see
   README notes shared alongside this file.
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, addDoc, updateDoc, deleteDoc, doc,
  onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

let currentUser = null;
let unsubFolders = null;
let unsubLinks = null;

/* ============================================================
   IN-MEMORY CACHE (mirrors Firestore in realtime via onSnapshot —
   folders/links scoped to whichever user is signed in)
   ============================================================ */
let folders = [];
let links = [];

let activeFolder = 'all';
let searchQuery = '';
let activeTag = null;
let editingLinkId = null;
let composingTags = [];

/* ============================================================
   i18n — DYNAMIC TEXT DICTIONARY
   (Static markup text lives in index.html via data-en/data-ar
   attributes; anything generated in JS is translated from here.)
   ============================================================ */
let currentLang = 'en';

const I18N = {
  en: {
    welcomeToast: name => `Welcome back, ${name}`,
    allLinks: 'All Links',
    videosTitle: 'Videos',
    resultCount: n => `${n} saved link${n===1?'':'s'}`,
    playsInApp: 'Plays in-app',
    article: 'Article',
    noNotesYet: 'No notes yet.',
    noNotesYetClick: 'No notes yet — click Remove to edit later from Add link.',
    previewUnavailable: 'Preview unavailable for this source',
    addALink: 'Add a link',
    editLink: 'Edit link',
    untitledFrom: host => `Untitled link from ${host}`,
    addUrlToast: 'Add a URL to save this link',
    linkSavedToast: 'Link saved',
    giveFolderNameToast: 'Give the folder a name',
    folderCreatedToast: name => `Folder "${name}" created`,
    linkRemovedToast: 'Link removed',
    welcomeBackTitle: 'Welcome back',
    createAccountTitle: 'Create your account',
    signInSub: 'Sign in to pick up where you left off.',
    signUpSub: 'Start saving links, notes, and videos in one focused place.',
    signIn: 'Sign In',
    signUpFree: 'Sign Up for Free',
    noAccount: "Don't have an account? ",
    signUpLink: 'Sign up',
    haveAccount: 'Already have an account? ',
    signInLink: 'Sign in',
    validEmail: 'Enter a valid email address.',
    passwordLen: 'Password must be at least 8 characters.',
    enterName: 'Enter your name to create an account.',
    googleNotWired: "Google sign-in isn't wired up in this demo yet",
    enterFullscreen: 'Fullscreen',
    exitFullscreen: 'Exit fullscreen',
    noTimeNotesYet: 'No timestamped notes yet — add one at your favorite moment.',
    invalidTimeToast: 'Enter a valid time, like 1:23',
    emptyTimeNoteToast: 'Write a note to pin at this timestamp',
    timeNoteAddedToast: 'Note pinned to video',
    timeNoteRemovedToast: 'Timestamped note removed',
    currentTimeUnavailable: "Can't read the current time for this video yet",
    deleteTimeNoteTitle: 'Remove note',
    authEmailInUse: 'An account with this email already exists.',
    authBadCreds: 'Incorrect email or password.',
    authTooMany: 'Too many attempts. Try again in a bit.',
    authWeakPassword: 'Choose a stronger password.',
    authGeneric: 'Something went wrong. Please try again.',
  },
  ar: {
    welcomeToast: name => `أهلاً بعودتك يا ${name}`,
    allLinks: 'كل الروابط',
    videosTitle: 'الفيديوهات',
    resultCount: n => `${n} رابط محفوظ`,
    playsInApp: 'يُشغَّل داخل التطبيق',
    article: 'مقالة',
    noNotesYet: 'لا توجد ملاحظات بعد.',
    noNotesYetClick: 'لا توجد ملاحظات بعد — اضغط إزالة لتعديلها لاحقاً من إضافة رابط.',
    previewUnavailable: 'المعاينة غير متاحة لهذا المصدر',
    addALink: 'إضافة رابط',
    editLink: 'تعديل الرابط',
    untitledFrom: host => `رابط بلا عنوان من ${host}`,
    addUrlToast: 'أضف رابطاً لحفظه',
    linkSavedToast: 'تم حفظ الرابط',
    giveFolderNameToast: 'أعطِ المجلد اسماً',
    folderCreatedToast: name => `تم إنشاء مجلد "${name}"`,
    linkRemovedToast: 'تمت إزالة الرابط',
    welcomeBackTitle: 'أهلاً بعودتك',
    createAccountTitle: 'أنشئ حسابك',
    signInSub: 'سجّل الدخول لتكمل من حيث توقفت.',
    signUpSub: 'ابدأ بحفظ الروابط والملاحظات والفيديوهات في مكان واحد هادئ.',
    signIn: 'تسجيل الدخول',
    signUpFree: 'إنشاء حساب مجاني',
    noAccount: 'ليس لديك حساب؟ ',
    signUpLink: 'إنشاء حساب',
    haveAccount: 'لديك حساب بالفعل؟ ',
    signInLink: 'تسجيل الدخول',
    validEmail: 'أدخل بريداً إلكترونياً صحيحاً.',
    passwordLen: 'يجب أن تتكوّن كلمة المرور من 8 أحرف على الأقل.',
    enterName: 'أدخل اسمك لإنشاء حساب.',
    googleNotWired: 'تسجيل الدخول عبر جوجل غير مفعّل في هذا العرض التجريبي',
    enterFullscreen: 'ملء الشاشة',
    exitFullscreen: 'إنهاء ملء الشاشة',
    noTimeNotesYet: 'لا توجد ملاحظات موقوتة بعد — أضف ملاحظة عند لحظتك المفضلة.',
    invalidTimeToast: 'أدخل وقتاً صحيحاً، مثل 1:23',
    emptyTimeNoteToast: 'اكتب ملاحظة لتثبيتها عند هذا الوقت',
    timeNoteAddedToast: 'تم تثبيت الملاحظة على الفيديو',
    timeNoteRemovedToast: 'تمت إزالة الملاحظة الموقوتة',
    currentTimeUnavailable: 'تعذّرت قراءة الوقت الحالي لهذا الفيديو',
    deleteTimeNoteTitle: 'إزالة الملاحظة',
    authEmailInUse: 'يوجد حساب بهذا البريد الإلكتروني بالفعل.',
    authBadCreds: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    authTooMany: 'محاولات كثيرة جداً. حاول بعد قليل.',
    authWeakPassword: 'اختر كلمة مرور أقوى.',
    authGeneric: 'حدث خطأ ما. حاول مرة أخرى.',
  }
};
function t(key){ return I18N[currentLang][key]; }

function mapAuthError(code){
  switch(code){
    case 'auth/email-already-in-use': return t('authEmailInUse');
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found': return t('authBadCreds');
    case 'auth/too-many-requests': return t('authTooMany');
    case 'auth/weak-password': return t('authWeakPassword');
    default: return t('authGeneric');
  }
}

/* ============================================================
   AUTH STATE — this is the single source of truth for whether
   the app view or the landing/auth view is shown. Persisted
   Firebase sessions mean a returning signed-in user lands
   straight in the app on page load.
   ============================================================ */
function getInitials(name, email){
  const source = (name && name.trim()) || (email ? email.split('@')[0] : '') || '';
  const parts = source.trim().split(/\s+/).filter(Boolean);
  if(parts.length === 0) return '?';
  if(parts.length === 1) return parts[0].slice(0,2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function updateUserRow(user){
  const avatar = document.getElementById('userAvatar');
  const name = document.getElementById('userName');
  const email = document.getElementById('userEmail');
  if(!avatar || !name || !email) return; // index.html not yet updated with these ids
  avatar.textContent = getInitials(user.displayName, user.email);
  name.textContent = user.displayName || (user.email ? user.email.split('@')[0] : '');
  email.textContent = user.email || '';
}

function startListening(uid){
  const foldersQ = query(collection(db, 'users', uid, 'folders'), orderBy('createdAt', 'asc'));
  unsubFolders = onSnapshot(foldersQ, snap => {
    folders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFolderNav();
    populateFolderSelect();
  }, err => console.error('folders listener:', err));

  const linksQ = query(collection(db, 'users', uid, 'links'), orderBy('createdAt', 'desc'));
  unsubLinks = onSnapshot(linksQ, snap => {
    links = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderLinks();
  }, err => console.error('links listener:', err));
}

function stopListening(){
  if(unsubFolders){ unsubFolders(); unsubFolders = null; }
  if(unsubLinks){ unsubLinks(); unsubLinks = null; }
  folders = [];
  links = [];
  activeFolder = 'all';
  activeTag = null;
  searchQuery = '';
}

onAuthStateChanged(auth, (user) => {
  if(user){
    currentUser = user;
    updateUserRow(user);
    startListening(user.uid);
    if(document.getElementById('app').classList.contains('hidden')){
      enterApp(user);
    }
  } else {
    currentUser = null;
    stopListening();
    if(!document.getElementById('app').classList.contains('hidden')){
      document.getElementById('app').classList.add('hidden');
      document.getElementById('landing').classList.remove('hidden');
      window.scrollTo(0,0);
    }
  }
});

/* ============================================================
   LANDING <-> APP TRANSITIONS
   ============================================================ */
function enterApp(user){
  document.getElementById('landing').classList.add('hidden');
  document.getElementById('auth').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  window.scrollTo(0,0);
  updateTopbarTitle();
  showToast(t('welcomeToast')(user.displayName || (user.email ? user.email.split('@')[0] : '')));
}

/* ============================================================
   AUTH PAGE — email sign-in / sign-up (real Firebase Authentication)
   ============================================================ */
let authMode = 'signin';

function showAuth(mode){
  document.getElementById('landing').classList.add('hidden');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('auth').classList.remove('hidden');
  window.scrollTo(0,0);
  switchAuthMode(mode || 'signin');
}

function backToLanding(){
  document.getElementById('auth').classList.add('hidden');
  document.getElementById('landing').classList.remove('hidden');
  window.scrollTo(0,0);
}

function switchAuthMode(mode){
  authMode = mode;
  const isSignUp = mode === 'signup';
  hideAuthError();

  document.getElementById('authTitle').textContent = isSignUp ? t('createAccountTitle') : t('welcomeBackTitle');
  document.getElementById('authSub').textContent = isSignUp ? t('signUpSub') : t('signInSub');
  document.getElementById('authNameField').classList.toggle('hidden', !isSignUp);
  document.getElementById('authName').required = isSignUp;
  document.getElementById('authPassword').setAttribute('autocomplete', isSignUp ? 'new-password' : 'current-password');
  document.getElementById('authSubmitBtn').textContent = isSignUp ? t('signUpFree') : t('signIn');

  const switchEl = document.getElementById('authSwitch');
  switchEl.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = isSignUp ? t('haveAccount') : t('noAccount');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = isSignUp ? t('signInLink') : t('signUpLink');
  btn.onclick = () => switchAuthMode(isSignUp ? 'signin' : 'signup');
  switchEl.appendChild(label);
  switchEl.appendChild(btn);

  document.getElementById('authForm').reset();
}

function showAuthError(msg){
  const el = document.getElementById('authError');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideAuthError(){
  document.getElementById('authError').classList.add('hidden');
}

async function handleAuthSubmit(e){
  e.preventDefault();
  hideAuthError();

  const name = document.getElementById('authName').value.trim();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if(!emailPattern.test(email)){ showAuthError(t('validEmail')); return; }
  if(password.length < 8){ showAuthError(t('passwordLen')); return; }
  if(authMode === 'signup' && !name){ showAuthError(t('enterName')); return; }

  const submitBtn = document.getElementById('authSubmitBtn');
  submitBtn.disabled = true;

  try{
    if(authMode === 'signup'){
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
    // onAuthStateChanged() picks this up and calls enterApp() automatically
  } catch(err){
    console.error(err);
    showAuthError(mapAuthError(err.code));
  } finally {
    submitBtn.disabled = false;
  }
}

function showToastOnAuth(){
  showToast(t('googleNotWired'));
}

/* ============================================================
   THEME TOGGLE
   ============================================================ */
let isDark = false;
function toggleTheme(){
  isDark = !isDark;
  document.body.setAttribute('data-theme', isDark ? 'dark' : 'light');
  document.getElementById('themeSwitch').classList.toggle('on', isDark);
}

/* ============================================================
   MOBILE SIDEBAR DRAWER
   ============================================================ */
function openSidebar(){
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('scrim').classList.add('show');
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('scrim').classList.remove('show');
}

/* ============================================================
   FOLDER NAV
   ============================================================ */
function renderFolderNav(){
  const nav = document.getElementById('folderNav');
  nav.innerHTML = folders.map(f => {
    const count = links.filter(l => l.folder === f.id).length;
    return `<div class="nav-item ${activeFolder===f.id?'active':''}" data-folder="${f.id}" onclick="selectFolder('${f.id}')">
      <span class="folder-dot" style="background:${f.color}"></span>
      <span>${escapeHtml(f.name)}</span>
      <span class="count">${count}</span>
    </div>`;
  }).join('');
  document.getElementById('countAll').textContent = links.length;
  document.getElementById('countVideos').textContent = links.filter(l => l.type === 'video').length;
}

function updateTopbarTitle(){
  const titles = { all: t('allLinks'), videos: t('videosTitle') };
  const folderObj = folders.find(f => f.id === activeFolder);
  document.getElementById('topbarTitle').textContent = folderObj ? folderObj.name : (titles[activeFolder] || t('allLinks'));
}

function selectFolder(id){
  activeFolder = id;
  activeTag = null;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.folder === id));
  updateTopbarTitle();
  renderLinks();
  closeSidebar();
}

/* ============================================================
   SEARCH
   ============================================================ */
function handleSearch(val){
  searchQuery = val.toLowerCase();
  document.getElementById('sidebarSearch').value = val;
  document.getElementById('topbarSearch').value = val;
  renderLinks();
}

/* ============================================================
   RENDER LINK GRID
   ============================================================ */
function currentList(){
  let list = links.slice();
  if(activeFolder === 'videos'){ list = list.filter(l => l.type === 'video'); }
  else if(activeFolder !== 'all'){ list = list.filter(l => l.folder === activeFolder); }
  if(activeTag){ list = list.filter(l => l.tags.includes(activeTag)); }
  if(searchQuery){
    list = list.filter(l =>
      l.title.toLowerCase().includes(searchQuery) ||
      (l.notes||'').toLowerCase().includes(searchQuery) ||
      (l.tags||[]).some(tg => tg.toLowerCase().includes(searchQuery))
    );
  }
  return list;
}

function renderTagChips(){
  const allTags = [...new Set(links.flatMap(l => l.tags || []))].sort();
  const chips = document.getElementById('tagChips');
  if(allTags.length === 0){ chips.innerHTML = ''; return; }
  chips.innerHTML = allTags.map(tag =>
    `<button class="chip ${activeTag===tag?'active':''}" onclick="toggleTag('${escapeAttr(tag)}')">#${escapeHtml(tag)}</button>`
  ).join('');
}
function toggleTag(tag){
  activeTag = activeTag === tag ? null : tag;
  renderLinks();
}

function renderLinks(){
  renderFolderNav();
  renderTagChips();
  const list = currentList();
  const grid = document.getElementById('linkGrid');
  const empty = document.getElementById('emptyState');
  document.getElementById('resultCount').textContent = t('resultCount')(list.length);

  if(list.length === 0){
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  grid.innerHTML = list.map(l => {
    const folderObj = folders.find(f => f.id === l.folder);
    const playBadge = l.type === 'video'
      ? `<div class="play-badge"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg></div>`
      : '';
    return `<div class="link-card" onclick="openCard('${l.id}')">
      <div class="thumb"><img src="${l.thumb || placeholderThumb(l.title, folderObj ? hashCode(folderObj.id)%360 : undefined)}" alt="">${playBadge}</div>
      <div class="card-body">
        <div class="card-top">
          <div>
            <div class="card-title">${escapeHtml(l.title)}</div>
            <div class="card-domain"><span class="favicon-dot"></span>${escapeHtml(l.domain)}</div>
          </div>
        </div>
        <p class="card-notes">${escapeHtml(l.notes || t('noNotesYet'))}</p>
        <div class="card-tags">${(l.tags||[]).map(tg=>`<span class="tag">#${escapeHtml(tg)}</span>`).join('')}</div>
        <div class="card-meta"><span>${folderObj ? escapeHtml(folderObj.name) : ''}</span><span>${l.type==='video'?t('playsInApp'):t('article')}</span></div>
      </div>
    </div>`;
  }).join('');
}

function openCard(id){
  const l = links.find(x => x.id === id);
  if(!l) return;
  if(l.type === 'video'){ openPlayerModal(l); }
  else{ openDetailModal(l); }
}

/* ============================================================
   VIDEO ID EXTRACTION (YouTube) — always embeds, never redirects
   ============================================================ */
function extractYouTubeId(url){
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}
function detectType(url){
  return /youtube\.com|youtu\.be|vimeo\.com/.test(url) ? 'video' : 'article';
}
function domainOf(url){
  try{ return new URL(url).hostname.replace('www.',''); }catch(e){ return url; }
}

/* ============================================================
   ADD / EDIT LINK MODAL
   ============================================================ */
function populateFolderSelect(){
  const sel = document.getElementById('fFolder');
  if(!sel) return;
  const current = sel.value;
  sel.innerHTML = folders.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');
  if([...sel.options].some(o => o.value === current)) sel.value = current;
}
function openLinkModal(){
  editingLinkId = null;
  composingTags = [];
  document.getElementById('linkModalTitle').textContent = t('addALink');
  document.getElementById('fUrl').value = '';
  document.getElementById('fTitle').value = '';
  document.getElementById('fNotes').value = '';
  populateFolderSelect();
  if(activeFolder !== 'all' && activeFolder !== 'videos'){ document.getElementById('fFolder').value = activeFolder; }
  renderTagRow();
  document.getElementById('linkModalBackdrop').classList.add('show');
  setTimeout(()=>document.getElementById('fUrl').focus(), 50);
}
function closeLinkModal(){ document.getElementById('linkModalBackdrop').classList.remove('show'); }

function autoFillTitle(){
  const titleField = document.getElementById('fTitle');
  const url = document.getElementById('fUrl').value.trim();
  if(!titleField.value && url){
    try{
      const host = domainOf(url);
      titleField.placeholder = t('untitledFrom')(host);
    }catch(e){}
  }
}

function handleTagKey(e){
  if(e.key === 'Enter' || e.key === ','){
    e.preventDefault();
    const input = document.getElementById('fTagInput');
    const val = input.value.trim().replace(/^#/,'');
    if(val && !composingTags.includes(val)){
      composingTags.push(val);
      renderTagRow();
    }
    input.value = '';
  } else if(e.key === 'Backspace' && document.getElementById('fTagInput').value === ''){
    composingTags.pop();
    renderTagRow();
  }
}
function removeTag(tg){
  composingTags = composingTags.filter(x => x !== tg);
  renderTagRow();
}
function renderTagRow(){
  const row = document.getElementById('tagRow');
  const input = document.getElementById('fTagInput');
  row.querySelectorAll('.tag-pill').forEach(el => el.remove());
  composingTags.forEach(tg => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.innerHTML = `#${escapeHtml(tg)} <button type="button" onclick="removeTag('${escapeAttr(tg)}')">&times;</button>`;
    row.insertBefore(pill, input);
  });
}

async function saveLink(){
  if(!currentUser) return;
  const url = document.getElementById('fUrl').value.trim();
  if(!url){ showToast(t('addUrlToast')); return; }
  let title = document.getElementById('fTitle').value.trim();
  const folder = document.getElementById('fFolder').value;
  const notes = document.getElementById('fNotes').value.trim();
  const type = detectType(url);
  const domain = domainOf(url);
  if(!title){ title = t('untitledFrom')(domain); }

  const data = { url, title, folder, notes, tags:[...composingTags], type, domain };
  const saveBtn = document.querySelector('#linkModalBackdrop .btn-primary');
  if(saveBtn) saveBtn.disabled = true;

  try{
    if(editingLinkId){
      await updateDoc(doc(db, 'users', currentUser.uid, 'links', editingLinkId), data);
    } else {
      await addDoc(collection(db, 'users', currentUser.uid, 'links'), { ...data, timeNotes: [], createdAt: serverTimestamp() });
    }
    closeLinkModal();
    showToast(t('linkSavedToast'));
  }catch(err){
    console.error(err);
  }finally{
    if(saveBtn) saveBtn.disabled = false;
  }
}

/* ============================================================
   FOLDER MODAL
   ============================================================ */
function openFolderModal(){
  document.getElementById('fFolderName').value = '';
  document.getElementById('folderModalBackdrop').classList.add('show');
  setTimeout(()=>document.getElementById('fFolderName').focus(), 50);
}
function closeFolderModal(){ document.getElementById('folderModalBackdrop').classList.remove('show'); }
async function createFolder(){
  if(!currentUser) return;
  const name = document.getElementById('fFolderName').value.trim();
  if(!name){ showToast(t('giveFolderNameToast')); return; }
  const palette = ['#226864','#e07a5f','#9c6644','#3e6563','#5f7161','#8d6a9f'];
  const color = palette[folders.length % palette.length];

  try{
    await addDoc(collection(db, 'users', currentUser.uid, 'folders'), { name, color, createdAt: serverTimestamp() });
    closeFolderModal();
    showToast(t('folderCreatedToast')(name));
  }catch(err){
    console.error(err);
  }
}

/* ============================================================
   VIDEO PLAYER MODAL — in-app embed, per anti-distraction rule
   Uses the YouTube IFrame API (not a plain <iframe>) so we can
   read the current playback time and seek to a saved timestamp —
   that's what powers the timestamped-notes feature below.
   ============================================================ */
let ytPlayer = null;          // current YT.Player instance (YouTube videos only)
let ytApiReady = false;       // becomes true once the IFrame API script has loaded
let activePlayerLink = null;  // the link object currently open in the player modal

// Called automatically by the YouTube IFrame API script once it finishes loading.
window.onYouTubeIframeAPIReady = function(){
  ytApiReady = true;
  // If the modal was opened before the API finished loading, build the player now.
  if(activePlayerLink){ mountYouTubePlayer(activePlayerLink); }
};

function openPlayerModal(l){
  activePlayerLink = l;
  if(!l.timeNotes) l.timeNotes = [];
  destroyYtPlayer();

  const vid = extractYouTubeId(l.url);
  const wrap = document.getElementById('playerWrap');
  if(vid){
    wrap.innerHTML = `<div id="ytPlayerEl" style="position:absolute; inset:0; width:100%; height:100%;"></div>`;
    if(ytApiReady && window.YT && YT.Player){ mountYouTubePlayer(l); }
    // else: onYouTubeIframeAPIReady() will mount it once the script finishes loading
  } else {
    wrap.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;">${t('previewUnavailable')}</div>`;
  }

  document.getElementById('playerTitle').textContent = l.title;
  document.getElementById('playerDomain').innerHTML = `<span class="favicon-dot"></span>${escapeHtml(l.domain)}`;
  document.getElementById('playerTags').innerHTML = (l.tags||[]).map(tg=>`<span class="tag">#${escapeHtml(tg)}</span>`).join('');
  document.getElementById('playerNotes').textContent = l.notes || t('noNotesYetClick');
  document.getElementById('deleteVideoBtn').onclick = () => { deleteLink(l.id); closePlayerModal(); };
  document.getElementById('timeNoteTime').value = '';
  document.getElementById('timeNoteText').value = '';
  document.getElementById('useCurrentTimeBtn').disabled = !vid;
  renderTimeNotes(l);
  updateZoomBtnState();
  document.getElementById('playerModalBackdrop').classList.add('show');
}

function mountYouTubePlayer(l){
  const vid = extractYouTubeId(l.url);
  const el = document.getElementById('ytPlayerEl');
  if(!vid || !el) return;
  ytPlayer = new YT.Player('ytPlayerEl', {
    videoId: vid,
    playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
  });
}

function destroyYtPlayer(){
  if(ytPlayer && typeof ytPlayer.destroy === 'function'){
    try{ ytPlayer.destroy(); } catch(e){ /* no-op */ }
  }
  ytPlayer = null;
}

function closePlayerModal(){
  if(document.fullscreenElement){ document.exitFullscreen(); }
  document.getElementById('playerModalBackdrop').classList.remove('show');
  destroyYtPlayer();
  document.getElementById('playerWrap').innerHTML = ''; // stop playback
  activePlayerLink = null;
}

/* ------------------------------------------------------------
   ZOOM / FULLSCREEN — expands the video area to fill the screen,
   using the native Fullscreen API (same behavior users expect
   from any video player).
   ------------------------------------------------------------ */
function toggleVideoZoom(){
  const container = document.getElementById('playerVideoContainer');
  if(!document.fullscreenElement){
    (container.requestFullscreen || container.webkitRequestFullscreen || function(){}).call(container);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen || function(){}).call(document);
  }
}
function updateZoomBtnState(){
  const btn = document.getElementById('playerZoomBtn');
  const isFs = !!document.fullscreenElement;
  btn.classList.toggle('is-fullscreen', isFs);
  const label = isFs ? t('exitFullscreen') : t('enterFullscreen');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}
document.addEventListener('fullscreenchange', updateZoomBtnState);
document.addEventListener('webkitfullscreenchange', updateZoomBtnState);

/* ------------------------------------------------------------
   TIMESTAMPED NOTES — pin a note to a moment in the video,
   the same pattern used by course/e-learning sites. Persisted
   to Firestore so they survive a refresh.
   ------------------------------------------------------------ */
function formatTime(totalSeconds){
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2,'0') : String(m);
  const ss = String(sec).padStart(2,'0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function parseTime(str){
  const parts = String(str).trim().split(':').map(p => p.trim());
  if(!parts.length || parts.some(p => p === '' || isNaN(Number(p)))) return null;
  let seconds = 0;
  for(const part of parts){ seconds = seconds * 60 + Number(part); }
  return seconds >= 0 ? seconds : null;
}

function useCurrentTime(){
  if(!ytPlayer || typeof ytPlayer.getCurrentTime !== 'function'){
    showToast(t('currentTimeUnavailable'));
    return;
  }
  const seconds = ytPlayer.getCurrentTime();
  document.getElementById('timeNoteTime').value = formatTime(seconds);
}

async function addTimeNote(){
  if(!activePlayerLink || !currentUser) return;
  const timeStr = document.getElementById('timeNoteTime').value;
  const text = document.getElementById('timeNoteText').value.trim();
  const seconds = parseTime(timeStr);

  if(seconds === null){ showToast(t('invalidTimeToast')); return; }
  if(!text){ showToast(t('emptyTimeNoteToast')); return; }

  const updated = [...(activePlayerLink.timeNotes || []), { time: seconds, text }].sort((a,b) => a.time - b.time);

  try{
    await updateDoc(doc(db, 'users', currentUser.uid, 'links', activePlayerLink.id), { timeNotes: updated });
    activePlayerLink.timeNotes = updated;
    document.getElementById('timeNoteTime').value = '';
    document.getElementById('timeNoteText').value = '';
    renderTimeNotes(activePlayerLink);
    showToast(t('timeNoteAddedToast'));
  }catch(err){
    console.error(err);
  }
}

async function deleteTimeNote(index){
  if(!activePlayerLink || !activePlayerLink.timeNotes || !currentUser) return;
  const updated = activePlayerLink.timeNotes.filter((_, i) => i !== index);

  try{
    await updateDoc(doc(db, 'users', currentUser.uid, 'links', activePlayerLink.id), { timeNotes: updated });
    activePlayerLink.timeNotes = updated;
    renderTimeNotes(activePlayerLink);
    showToast(t('timeNoteRemovedToast'));
  }catch(err){
    console.error(err);
  }
}

function seekToTime(seconds){
  if(ytPlayer && typeof ytPlayer.seekTo === 'function'){
    ytPlayer.seekTo(seconds, true);
    if(typeof ytPlayer.playVideo === 'function') ytPlayer.playVideo();
  }
}

function renderTimeNotes(l){
  const list = document.getElementById('timeNotesList');
  const notes = l.timeNotes || [];
  if(!notes.length){
    list.innerHTML = `<p class="hint">${t('noTimeNotesYet')}</p>`;
    return;
  }
  const canSeek = !!ytPlayer;
  list.innerHTML = notes.map((n, i) => `
    <div class="time-note-item">
      <button type="button" class="time-note-badge" ${canSeek ? `onclick="seekToTime(${n.time})"` : 'disabled'}>${formatTime(n.time)}</button>
      <span class="time-note-text">${escapeHtml(n.text)}</span>
      <button type="button" class="time-note-delete" onclick="deleteTimeNote(${i})" title="${t('deleteTimeNoteTitle')}" aria-label="${t('deleteTimeNoteTitle')}">
        <svg class="icon" style="width:14px;height:14px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>`).join('');
}

/* ============================================================
   DETAIL / NOTES MODAL (non-video links)
   ============================================================ */
function openDetailModal(l){
  const folderObj = folders.find(f => f.id === l.folder);
  document.getElementById('detailTitle').textContent = l.title;
  document.getElementById('detailThumb').src = l.thumb || placeholderThumb(l.title, folderObj ? hashCode(folderObj.id)%360 : undefined);
  document.getElementById('detailDomain').innerHTML = `<span class="favicon-dot"></span>${escapeHtml(l.domain)} · ${folderObj?escapeHtml(folderObj.name):''}`;
  document.getElementById('detailTags').innerHTML = (l.tags||[]).map(tg=>`<span class="tag">#${escapeHtml(tg)}</span>`).join('') || '<span class="hint">No tags yet</span>';
  document.getElementById('detailNotes').textContent = l.notes || t('noNotesYet');
  document.getElementById('detailOpenBtn').href = l.url;
  document.getElementById('deleteLinkBtn').onclick = () => { deleteLink(l.id); closeDetailModal(); };
  document.getElementById('detailModalBackdrop').classList.add('show');
}
function closeDetailModal(){ document.getElementById('detailModalBackdrop').classList.remove('show'); }

async function deleteLink(id){
  if(!currentUser) return;
  try{
    await deleteDoc(doc(db, 'users', currentUser.uid, 'links', id));
    showToast(t('linkRemovedToast'));
  }catch(err){
    console.error(err);
  }
}

/* ============================================================
   TOAST
   ============================================================ */
let toastTimer;
function showToast(msg){
  const tt = document.getElementById('toast');
  tt.textContent = msg;
  tt.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>tt.classList.remove('show'), 2400);
}

/* ============================================================
   تبديل اللغة (English / العربية)
   - Static text: any element with [data-en]/[data-ar] has its
     textContent swapped.
   - Placeholders: [data-en-placeholder]/[data-ar-placeholder].
   - Title tooltips: [data-en-title]/[data-ar-title].
   - Anything generated dynamically in JS (toasts, modal titles,
     the topbar title, result counts, auth copy) is re-rendered
     through the I18N dictionary above so it never gets stale.
   ============================================================ */
const langBtn = document.getElementById('lang-btn');

function applyStaticTranslations(lang){
  document.querySelectorAll('[data-en]').forEach(el => {
    const val = el.getAttribute(`data-${lang}`);
    if(val !== null) el.textContent = val;
  });
  document.querySelectorAll('[data-en-placeholder]').forEach(el => {
    const val = el.getAttribute(`data-${lang}-placeholder`);
    if(val !== null) el.placeholder = val;
  });
  document.querySelectorAll('[data-en-title]').forEach(el => {
    const val = el.getAttribute(`data-${lang}-title`);
    if(val !== null) el.title = val;
  });
}

function refreshDynamicTranslations(){
  updateTopbarTitle();
  renderLinks();
  if(!document.getElementById('auth').classList.contains('hidden')){
    switchAuthMode(authMode);
  }
  if(currentUser){ updateUserRow(currentUser); }
  if(activePlayerLink){
    renderTimeNotes(activePlayerLink);
    updateZoomBtnState();
  }
}

function setLanguage(lang){
  currentLang = lang;

  if(lang === 'ar'){
    document.documentElement.dir = 'rtl';
    document.documentElement.lang = 'ar';
    langBtn.querySelector('.lang-btn-label').textContent = 'English';
  } else {
    document.documentElement.dir = 'ltr';
    document.documentElement.lang = 'en';
    langBtn.querySelector('.lang-btn-label').textContent = 'العربية';
  }

  applyStaticTranslations(lang);
  refreshDynamicTranslations();

  localStorage.setItem('preferred-language', lang);
}

langBtn.addEventListener('click', () => {
  const newLang = currentLang === 'en' ? 'ar' : 'en';
  setLanguage(newLang);
});

document.addEventListener('DOMContentLoaded', () => {
  const savedLang = localStorage.getItem('preferred-language') || 'en';
  setLanguage(savedLang);
});

/* ============================================================
   SIGN OUT — Firestore listeners are torn down and the landing
   page is shown automatically by the onAuthStateChanged handler
   above once Firebase confirms the session ended.
   ============================================================ */
async function exitApp(){
  try{
    await signOut(auth);
  }catch(err){
    console.error(err);
  }
}

/* ============================================================
   UTIL
   ============================================================ */
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function escapeAttr(str){ return escapeHtml(str).replace(/`/g,'&#96;'); }

/* ============================================================
   Expose functions used as inline HTML event handlers (onclick=...)
   Required because this file is loaded as an ES module — module
   scope is not global scope, so inline handlers can't see these
   otherwise.
   ============================================================ */
Object.assign(window, {
  showAuth, backToLanding, switchAuthMode, handleAuthSubmit, showToastOnAuth,
  toggleTheme, openSidebar, closeSidebar, selectFolder, handleSearch, toggleTag,
  openCard, openLinkModal, closeLinkModal, autoFillTitle, handleTagKey, removeTag,
  saveLink, openFolderModal, closeFolderModal, createFolder, toggleVideoZoom,
  useCurrentTime, addTimeNote, deleteTimeNote, seekToTime, closeDetailModal,
  closePlayerModal, exitApp,
});

/* New */
function navigateTo(pageId) {
    // 1. إخفاء جميع الصفحات والأقسام
    document.querySelectorAll('.landing-page').forEach(section => {
        section.classList.remove('active');
        section.style.display = 'none';
    });

    // 2. إظهار الصفحة المطلوبة فقط
    const targetPage = document.getElementById(pageId);
    if (.app) {
        app.classList.add('active');
        app.style.display = 'block'; // أو flex
    }
}

