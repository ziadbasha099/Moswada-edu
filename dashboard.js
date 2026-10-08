/* ============================================================
   DASHBOARD.JS — loaded only by app.html
   ------------------------------------------------------------
   Everything about folders, links, videos, and their modals
   lives here. Sign-in itself happens on index.html (auth.js);
   by the time this file's route guard lets someone stay on this
   page, Firebase has already confirmed they're signed in.

   Data model — every signed-in user gets their own private data:
     users/{uid}/folders/{folderId}
     users/{uid}/links/{linkId}
   Firestore security rules (Firebase console) must restrict
   users/{uid}/** to request.auth.uid == uid — see the setup
   notes inside firebase-config.js.

   Security notes:
   - User-entered text (tags, titles...) is never placed inside inline
     onclick="..." code. HTML-escaping cannot make a value safe inside a
     JS string (the browser decodes &#39; back to ' before running the
     handler). Tags use data-* attributes + delegated listeners instead.
   - firestore.rules requires email_verified, so after verification we
     force-refresh the ID token (getIdToken(true)) to pick up the claim.
 ============================================================ */
import { signOut, onAuthStateChanged, sendEmailVerification } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, setDoc, getDoc, getDocs,
  getCountFromServer, runTransaction, writeBatch, increment,
  onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, t, showToast, escapeHtml, escapeAttr, setDynamicTranslationHook, getStoredTheme, setTheme } from "./shared.js";
import { SHARED_FOLDERS_COLLECTION } from "./firebase-config.js";

// الحد الأقصى لعدد الروابط لكل حساب — يجب أن يطابق القيمة (200) المكتوبة
// في firestore.rules، لأن هذا الرقم هنا مجرد تحقّق سريع للواجهة فقط.
const MAX_LINKS_PER_USER = 200;

/* ============================================================
   MOCK IMAGE HELPERS (generates a lightweight branded SVG
   placeholder thumbnail when a link has no real thumbnail yet)
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
   IN-MEMORY CACHE (mirrors Firestore in realtime via onSnapshot —
   folders/links scoped to whichever user is signed in)
   ============================================================ */
let currentUser = null;
let unsubFolders = null;
let unsubLinks = null;
let folders = [];
let links = [];

let activeFolder = 'all';
let searchQuery = '';
let activeTag = null;
let editingLinkId = null;
let composingTags = [];
let currentDetailLinkId = null;
let tagsExpanded = false;

/** عدد المجلدات الظاهرة قبل زر "عرض المزيد". */
const VISIBLE_FOLDERS_LIMIT = 5;
const FOLDER_MENU_GAP_PX = 4;
const FOLDER_MENU_VIEWPORT_MARGIN_PX = 8;

let foldersExpanded = false;
let folderMenuTargetId = null;
let deleteFolderTargetId = null;

/* Tags being edited live from the video player modal (kept separate
   from `composingTags`, which belongs to the Add/Edit link modal). */
let playerComposingTags = [];

function getInitials(name, email){
  const source = (name && name.trim()) || (email ? email.split('@')[0] : '') || '';
  const parts = source.trim().split(/\s+/).filter(Boolean);
  if(parts.length === 0) return '?';
  if(parts.length === 1) return parts[0].slice(0,2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function updateUserRow(user){
  document.getElementById('userAvatar').textContent = getInitials(user.displayName, user.email);
  document.getElementById('userName').textContent = user.displayName || (user.email ? user.email.split('@')[0] : '');
  document.getElementById('userEmail').textContent = user.email || '';
}

function startListening(uid){
  ensureLinksCounter(uid);
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

/* ============================================================
   عدّاد الروابط — users/{uid}.linksCount هو الأساس الذي يعتمد عليه
   الحد الأقصى (200) في firestore.rules. تُهيَّأ مرة واحدة فقط لكل
   حساب، اعتماداً على عدّ حقيقي من السيرفر (getCountFromServer)، ولا
   تُعاد كتابتها أبداً إذا كانت موجودة بالفعل.
   ============================================================ */
async function ensureLinksCounter(uid){
  try{
    const userRef = doc(db, 'users', uid);
    const userSnap = await getDoc(userRef);
    if(userSnap.exists() && typeof userSnap.data().linksCount === 'number') return;
    const countSnap = await getCountFromServer(collection(db, 'users', uid, 'links'));
    await setDoc(userRef, { linksCount: countSnap.data().count }, { merge: true });
  }catch(err){
    console.error('Failed to initialize links counter:', err);
  }
}

/**
 * Forces Firebase to issue a fresh ID token so the `email_verified` claim
 * that firestore.rules checks is up to date. Without this, a user who just
 * verified their email would keep getting permission-denied until the old
 * token expired (up to an hour). Failure is logged, never fatal.
 * @param {import('firebase/auth').User} user
 * @returns {Promise<void>}
 */
async function refreshAuthToken(user){
  try{
    await user.getIdToken(true);
  }catch(err){
    console.error('Failed to refresh ID token:', err);
  }
}

/* ------------------------------------------------------------
   ROUTE GUARD — this page is only for signed-in users. A visitor
   with no session gets sent straight back to the landing/auth
   page. A first-time arrival (coming from sign-in) shows the
   welcome toast; a plain page refresh while already signed in
   quietly resumes without repeating it.
   ------------------------------------------------------------ */
let hasEnteredOnce = false;
onAuthStateChanged(auth, async (user) => {
  if(user){
    if(!user.emailVerified){
      // Signed in, but the email isn't verified yet — hold this user on
      // the verification gate instead of the dashboard, and make sure
      // no private data listener is running for them in the meantime.
      currentUser = user;
      stopListening();
      document.getElementById('app').classList.add('hidden');
      document.getElementById('verifyView').classList.remove('hidden');
      document.getElementById('verifyEmailAddr').textContent = user.email || '';
      return;
    }

    document.getElementById('verifyView').classList.add('hidden');
    currentUser = user;
    // Make sure the token carries email_verified=true before the first
    // Firestore read, otherwise the rules would reject the listeners.
    await refreshAuthToken(user);
    if(currentUser !== user) return; // signed out / switched while refreshing
    updateUserRow(user);
    stopListening();
    startListening(user.uid);
    updateTopbarTitle();
    if(!hasEnteredOnce){
      hasEnteredOnce = true;
      document.getElementById('app').classList.remove('hidden');
      showToast(t('welcomeToast')(user.displayName || (user.email ? user.email.split('@')[0] : '')));
    }
  } else {
    currentUser = null;
    stopListening();
    window.location.href = 'index.html';
  }
});

/* ============================================================
   EMAIL VERIFICATION GATE — actions for the screen shown above
   ============================================================ */
async function resendVerification(){
  if(!currentUser) return;
  const btn = document.getElementById('verifyResendBtn');
  const errEl = document.getElementById('verifyError');
  errEl.classList.add('hidden');
  btn.disabled = true;
  try{
    await sendEmailVerification(currentUser);
    showToast(t('verificationSentToast'));
  }catch(err){
    console.error(err);
    errEl.textContent = err.code === 'auth/too-many-requests' ? t('authTooMany') : t('authGeneric');
    errEl.classList.remove('hidden');
  }finally{
    btn.disabled = false;
  }
}

async function checkVerification(){
  if(!currentUser) return;
  const btn = document.getElementById('verifyCheckBtn');
  const errEl = document.getElementById('verifyError');
  errEl.classList.add('hidden');
  btn.disabled = true;
  try{
    await currentUser.reload(); // refreshes emailVerified from Firebase
    if(currentUser.emailVerified){
      // Pick up the email_verified claim required by firestore.rules.
      await refreshAuthToken(currentUser);
      document.getElementById('verifyView').classList.add('hidden');
      updateUserRow(currentUser);
      stopListening();
      startListening(currentUser.uid);
      updateTopbarTitle();
      document.getElementById('app').classList.remove('hidden');
      hasEnteredOnce = true;
      showToast(t('welcomeToast')(currentUser.displayName || (currentUser.email ? currentUser.email.split('@')[0] : '')));
    } else {
      errEl.textContent = t('stillNotVerifiedToast');
      errEl.classList.remove('hidden');
    }
  }catch(err){
    console.error(err);
  }finally{
    btn.disabled = false;
  }
}

async function verifyExitApp(){
  try{
    await signOut(auth);
  }catch(err){
    console.error(err);
  }
}

/* ============================================================
   THEME TOGGLE — persisted (shared across app.html/settings.html)
   ============================================================ */
function syncThemeSwitch(){
  const pref = getStoredTheme();
  const isDarkNow = pref === 'dark' ||
    (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const themeSwitch = document.getElementById('themeSwitch');
  if(themeSwitch) themeSwitch.classList.toggle('on', isDarkNow);
}
function toggleTheme(){
  const pref = getStoredTheme();
  const isDarkNow = pref === 'dark' ||
    (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  setTheme(isDarkNow ? 'light' : 'dark');
  syncThemeSwitch();
}
document.addEventListener('DOMContentLoaded', syncThemeSwitch);

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
/**
 * Returns the folders to display. When collapsed, only the first
 * VISIBLE_FOLDERS_LIMIT are shown, but the active folder is always kept
 * visible so the user never loses track of where they are.
 * @returns {Array<object>}
 */
function getVisibleFolders(){
  if(foldersExpanded) return folders;
  return folders.filter((f, index) => index < VISIBLE_FOLDERS_LIMIT || f.id === activeFolder);
}

/** Builds the HTML for one folder row. Ids go in data-* attributes (never inline JS). */
function folderRowHtml(folder){
  const count = links.filter(l => l.folder === folder.id).length;
  return `<div class="nav-item ${activeFolder===folder.id?'active':''}" data-action="select-folder" data-folder="${escapeAttr(folder.id)}">
      <span class="folder-dot" style="background:${escapeAttr(folder.color)}"></span>
      <span>${escapeHtml(folder.name)}</span>
      <span class="count">${count}</span>
      <button type="button" class="folder-menu-btn" data-action="toggle-folder-menu" data-folder-id="${escapeAttr(folder.id)}" title="${t('folderMenuLabel')}" aria-label="${t('folderMenuLabel')}" aria-haspopup="menu">
        <svg class="icon" style="width:16px;height:16px;" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>
      </button>
    </div>`;
}

function renderFolderNav(){
  const nav = document.getElementById('folderNav');
  let html = getVisibleFolders().map(folderRowHtml).join('');

  if(folders.length > VISIBLE_FOLDERS_LIMIT){
    html += `<button type="button" class="chip chip-more folder-more-btn" data-action="toggle-more-folders">${foldersExpanded ? t('showLessTags') : t('showMoreTags')}</button>`;
  }
  nav.innerHTML = html;

  document.getElementById('countAll').textContent = links.length;
  document.getElementById('countVideos').textContent = links.filter(l => l.type === 'video').length;
}

/** Single delegated click handler for the whole folder list. */
function handleFolderNavClick(event){
  const actionEl = event.target.closest('[data-action]');
  if(!actionEl) return;
  const { action } = actionEl.dataset;

  if(action === 'toggle-folder-menu'){
    event.stopPropagation();
    toggleFolderMenu(actionEl.dataset.folderId, actionEl);
  } else if(action === 'toggle-more-folders'){
    foldersExpanded = !foldersExpanded;
    renderFolderNav();
  } else if(action === 'select-folder'){
    selectFolder(actionEl.dataset.folder);
  }
}
document.getElementById('folderNav').addEventListener('click', handleFolderNavClick);

/* ============================================================
   FOLDER ⋮ MENU (share / delete)
   One floating element positioned with fixed coordinates, so the
   sidebar's overflow never clips it.
   ============================================================ */
function closeFolderMenu(){
  document.getElementById('folderMenu').classList.add('hidden');
  folderMenuTargetId = null;
}

/**
 * Opens the menu next to the clicked ⋮ button (or closes it if already open for that folder).
 * @param {string} folderId
 * @param {HTMLElement} anchorButton
 */
function toggleFolderMenu(folderId, anchorButton){
  const menu = document.getElementById('folderMenu');
  if(folderMenuTargetId === folderId){ closeFolderMenu(); return; }

  folderMenuTargetId = folderId;
  menu.classList.remove('hidden'); // must be visible to be measured

  const anchor = anchorButton.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const isRtl = document.documentElement.dir === 'rtl';

  const unclampedLeft = isRtl ? anchor.left : anchor.right - size.width;
  const maxLeft = window.innerWidth - size.width - FOLDER_MENU_VIEWPORT_MARGIN_PX;
  const left = Math.min(Math.max(unclampedLeft, FOLDER_MENU_VIEWPORT_MARGIN_PX), maxLeft);

  let top = anchor.bottom + FOLDER_MENU_GAP_PX;
  if(top + size.height > window.innerHeight - FOLDER_MENU_VIEWPORT_MARGIN_PX){
    top = anchor.top - size.height - FOLDER_MENU_GAP_PX; // flip upward near the bottom edge
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

document.getElementById('folderMenu').addEventListener('click', (event) => {
  const actionEl = event.target.closest('[data-action]');
  if(!actionEl || !folderMenuTargetId) return;
  const folderId = folderMenuTargetId;
  closeFolderMenu();
  if(actionEl.dataset.action === 'share-folder') openShareModal(folderId);
  else if(actionEl.dataset.action === 'delete-folder') openDeleteFolderModal(folderId);
});

// Close on outside click, Escape, or when the sidebar scrolls.
document.addEventListener('click', (event) => {
  if(!event.target.closest('#folderMenu, .folder-menu-btn')) closeFolderMenu();
});
document.addEventListener('keydown', (event) => { if(event.key === 'Escape') closeFolderMenu(); });
document.getElementById('sidebar').addEventListener('scroll', closeFolderMenu);

/* ============================================================
   DELETE FOLDER — removes the folder, every link inside it
   (decrementing users/{uid}.linksCount in the same batch), and
   its public share mirror if it was shared.
   ============================================================ */
function openDeleteFolderModal(folderId){
  const folder = folders.find(f => f.id === folderId);
  if(!folder) return;
  deleteFolderTargetId = folderId;
  const linksCount = links.filter(l => l.folder === folderId).length;
  document.getElementById('deleteFolderBody').textContent = t('deleteFolderBody')(folder.name, linksCount);
  document.getElementById('deleteFolderModalBackdrop').classList.add('show');
}
function closeDeleteFolderModal(){
  document.getElementById('deleteFolderModalBackdrop').classList.remove('show');
  deleteFolderTargetId = null;
}

async function confirmDeleteFolder(){
  if(!currentUser || !deleteFolderTargetId) return;
  const folder = folders.find(f => f.id === deleteFolderTargetId);
  if(!folder) return;

  const button = document.getElementById('confirmDeleteFolderBtn');
  button.disabled = true;
  try{
    if(folder.shared && folder.shareId) await removeSharedMirror(folder);

    const folderLinks = links.filter(l => l.folder === folder.id);
    const batch = writeBatch(db); // max 200 links + 2 writes, under the 500 batch limit
    folderLinks.forEach(l => batch.delete(doc(db, 'users', currentUser.uid, 'links', l.id)));
    batch.delete(doc(db, 'users', currentUser.uid, 'folders', folder.id));
    if(folderLinks.length){
      batch.set(doc(db, 'users', currentUser.uid), { linksCount: increment(-folderLinks.length) }, { merge: true });
    }
    await batch.commit();

    if(activeFolder === folder.id) selectFolder('all');
    closeDeleteFolderModal();
    showToast(t('folderDeletedToast'));
  }catch(err){
    console.error('Failed to delete folder:', err);
    showToast(t('authGeneric'));
  }finally{
    button.disabled = false;
  }
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
  if(activeTag){ list = list.filter(l => l.tags && l.tags.includes(activeTag)); }
  if(searchQuery){
    const cleanQuery = searchQuery.trim().toLowerCase().replace(/^#/, '');
    list = list.filter(l =>
      l.title.toLowerCase().includes(searchQuery) ||
      (l.notes||'').toLowerCase().includes(searchQuery) ||
      (l.tags||[]).some(tg => tg.toLowerCase().trim().includes(cleanQuery))
    );
  }
  return list;
}

/**
 * Renders the tag filter chips. Tag text goes in a data-tag attribute and is
 * read back by the delegated click listener below — never inside inline
 * onclick code (see the security note at the top of this file).
 */
function renderTagChips(){
  const allTags = [...new Set(links.flatMap(l => l.tags || []))].sort();
  const chips = document.getElementById('tagChips');
  if(allTags.length === 0){ chips.innerHTML = ''; return; }

  const TAG_LIMIT = 5;
  const visibleTags = tagsExpanded ? allTags : allTags.slice(0, TAG_LIMIT);

  let html = visibleTags.map(tag =>
    `<button type="button" class="chip ${activeTag===tag?'active':''}" data-action="filter-tag" data-tag="${escapeAttr(tag)}">#${escapeHtml(tag)}</button>`
  ).join('');

  if(allTags.length > TAG_LIMIT){
    html += `<button type="button" class="chip chip-more" data-action="toggle-more-tags">${tagsExpanded ? t('showLessTags') : t('showMoreTags')}</button>`;
  }

  chips.innerHTML = html;
}

/** Single delegated click handler for the tag filter chips. */
function handleTagChipsClick(event){
  const chip = event.target.closest('[data-action]');
  if(!chip) return;
  if(chip.dataset.action === 'filter-tag') toggleTag(chip.dataset.tag);
  else if(chip.dataset.action === 'toggle-more-tags') toggleTagsExpanded();
}
document.getElementById('tagChips').addEventListener('click', handleTagChipsClick);

function toggleTag(tag){
  activeTag = activeTag === tag ? null : tag;
  renderLinks();
}
function toggleTagsExpanded(){
  tagsExpanded = !tagsExpanded;
  renderTagChips();
}

function renderTagDatalist(){
  const dl = document.getElementById('existingTags');
  if(!dl) return;
  const allTags = [...new Set(links.flatMap(l => l.tags || []))].sort();
  dl.innerHTML = allTags.map(tag => `<option value="${escapeAttr(tag)}"></option>`).join('');
}

function renderLinks(){
  renderFolderNav();
  renderTagChips();
  renderTagDatalist();
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
    return `<div class="link-card" onclick="openCard('${escapeAttr(l.id)}')">
      <div class="thumb"><img src="${escapeAttr(thumbFor(l, folderObj))}" onerror="handleThumbError(this, '${escapeAttr(extractYouTubeId(l.url) || '')}', '${placeholderThumb(l.title, folderObj ? hashCode(folderObj.id)%360 : undefined)}')" alt="">${playBadge}</div>
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
   مشاركة مجلد الفيديوهات — ينشئ نسخة عامة (mirror) في
   sharedFolders/{shareId}/links فقط للفيديوهات، بدون كشف باقي
   بيانات المستخدم الخاصة.
   ============================================================ */
let shareModalFolderId = null;

function openShareModal(folderId){
  shareModalFolderId = folderId;
  renderShareModal();
  document.getElementById('shareModalBackdrop').classList.add('show');
}
function closeShareModal(){
  document.getElementById('shareModalBackdrop').classList.remove('show');
  shareModalFolderId = null;
}

function shareUrlFor(shareId){
  return `${location.origin}${location.pathname.replace(/app\.html$/, '')}share.html?id=${shareId}`;
}

function renderShareModal(){
  const folder = folders.find(f => f.id === shareModalFolderId);
  const body = document.getElementById('shareModalBody');
  if(!folder || !body) return;

  if(folder.shared && folder.shareId){
    body.innerHTML = `
      <p class="hint">${t('shareHintActive')}</p>
      <div class="field">
        <label>${t('shareLinkLabel')}</label>
        <div class="tag-input-row">
          <input type="text" readonly value="${escapeAttr(shareUrlFor(folder.shareId))}" id="shareUrlInput"
            style="border:none;background:transparent;flex:1;outline:none;font-size:13px;">
        </div>
      </div>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-outline btn-sm" onclick="copyShareUrl()">${t('copyLink')}</button>
        <button class="btn btn-ghost btn-sm" onclick="stopSharingFolder()">${t('stopSharing')}</button>
      </div>`;
  } else {
    body.innerHTML = `
      <p class="hint">${t('shareHintInactive')}</p>
      <button class="btn btn-primary" onclick="createShareLink()">${t('createShareLink')}</button>`;
  }
}

function copyShareUrl(){
  const input = document.getElementById('shareUrlInput');
  if(!input) return;
  input.select();
  if(navigator.clipboard){
    navigator.clipboard.writeText(input.value).then(() => showToast(t('linkCopiedToast'))).catch(() => {});
  }
}

async function createShareLink(){
  if(!currentUser || !shareModalFolderId) return;
  const folder = folders.find(f => f.id === shareModalFolderId);
  if(!folder) return;

  const shareId = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

  try{
    await setDoc(doc(db, SHARED_FOLDERS_COLLECTION, shareId), {
      ownerUid: currentUser.uid,
      folderId: folder.id,
      name: folder.name,
      color: folder.color,
      createdAt: serverTimestamp()
    });

    const videosInFolder = links.filter(l => l.folder === folder.id && l.type === 'video');
    await Promise.all(videosInFolder.map(l => setDoc(doc(db, SHARED_FOLDERS_COLLECTION, shareId, 'links', l.id), {
      title: l.title, url: l.url, type: l.type, domain: l.domain, thumb: l.thumb || null,
      createdAt: serverTimestamp()
    })));

    await updateDoc(doc(db, 'users', currentUser.uid, 'folders', folder.id), { shared: true, shareId });
    renderShareModal();
    showToast(t('shareCreatedToast'));
  }catch(err){ console.error(err); }
}

/** Deletes a folder's public mirror (sharedFolders/{shareId} and its links). */
async function removeSharedMirror(folder){
  const linksSnap = await getDocs(collection(db, SHARED_FOLDERS_COLLECTION, folder.shareId, 'links'));
  await Promise.all(linksSnap.docs.map(d => deleteDoc(d.ref)));
  await deleteDoc(doc(db, SHARED_FOLDERS_COLLECTION, folder.shareId));
}

async function stopSharingFolder(){
  if(!currentUser || !shareModalFolderId) return;
  const folder = folders.find(f => f.id === shareModalFolderId);
  if(!folder || !folder.shareId) return;

  try{
    await removeSharedMirror(folder);
    await updateDoc(doc(db, 'users', currentUser.uid, 'folders', folder.id), { shared: false, shareId: null });
    renderShareModal();
    showToast(t('shareStoppedToast'));
  }catch(err){ console.error(err); }
}

async function mirrorLinkIfShared(folderId, linkId, data){
  const folder = folders.find(f => f.id === folderId);
  if(!folder || !folder.shared || !folder.shareId) return;
  if(data.type !== 'video') return;
  try{
    await setDoc(doc(db, SHARED_FOLDERS_COLLECTION, folder.shareId, 'links', linkId), {
      title: data.title, url: data.url, type: data.type, domain: data.domain, thumb: data.thumb || null,
      createdAt: serverTimestamp()
    });
  }catch(err){ console.error(err); }
}
async function unmirrorLink(folderId, linkId){
  const folder = folders.find(f => f.id === folderId);
  if(!folder || !folder.shareId) return;
  try{ await deleteDoc(doc(db, SHARED_FOLDERS_COLLECTION, folder.shareId, 'links', linkId)); }catch(err){ /* no-op */ }
}

/* ============================================================
   VIDEO ID EXTRACTION (YouTube) — always embeds, never redirects
   ============================================================ */
function extractYouTubeId(url){
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}

function youTubeThumbUrl(url, quality){
  const id = extractYouTubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/${quality || 'hqdefault'}.jpg` : null;
}
function thumbFor(l, folderObj){
  if(l.type === 'video'){
    const yt = youTubeThumbUrl(l.url);
    if(yt) return yt;
  }
  return l.thumb || placeholderThumb(l.title, folderObj ? hashCode(folderObj.id)%360 : undefined);
}

window.handleThumbError = function(img, videoId, fallbackSrc){
  const step = Number(img.dataset.thumbStep || 0);
  const chain = ['hqdefault', 'mqdefault', 'default'];
  if(videoId && step < chain.length - 1){
    img.dataset.thumbStep = step + 1;
    img.src = `https://i.ytimg.com/vi/${videoId}/${chain[step + 1]}.jpg`;
  } else {
    img.onerror = null;
    img.src = fallbackSrc;
  }
};

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
  sel.innerHTML = folders.map(f => `<option value="${escapeAttr(f.id)}">${escapeHtml(f.name)}</option>`).join('');
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
  updatePlaylistImportVisibility();
  document.getElementById('linkModalBackdrop').classList.add('show');
  setTimeout(()=>document.getElementById('fUrl').focus(), 50);
}
function closeLinkModal(){ document.getElementById('linkModalBackdrop').classList.remove('show'); }

function autoFillTitle(){
  updatePlaylistImportVisibility();
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

/**
 * Builds one removable tag "pill" with DOM APIs (textContent + addEventListener)
 * so the tag text can never be interpreted as HTML or JavaScript.
 * @param {string} tagText
 * @param {(tag: string) => void} onRemove
 * @returns {HTMLSpanElement}
 */
function createTagPill(tagText, onRemove){
  const pill = document.createElement('span');
  pill.className = 'tag-pill';
  pill.appendChild(document.createTextNode(`#${tagText} `));

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.textContent = '\u00d7';
  removeButton.addEventListener('click', () => onRemove(tagText));
  pill.appendChild(removeButton);
  return pill;
}

function renderTagRow(){
  const row = document.getElementById('tagRow');
  const input = document.getElementById('fTagInput');
  row.querySelectorAll('.tag-pill').forEach(el => el.remove());
  composingTags.forEach(tg => row.insertBefore(createTagPill(tg, removeTag), input));
}

// Only http/https links are ever allowed to be stored or opened. Without
// this, a crafted "javascript:" or "data:" URI could be saved as a link and
// later executed when assigned to an <a href> (openDetailModal/safeHref).
function isSafeUrl(url){
  return /^https?:\/\/.+/i.test(String(url || '').trim());
}

async function saveLink(){
  if(!currentUser) return;

  const url = document.getElementById('fUrl').value.trim();
  if(!url){ showToast(t('addUrlToast')); return; }
  if(!isSafeUrl(url)){ showToast(t('invalidUrlToast') || 'Please enter a valid http:// or https:// link'); return; }

  // حد أقصى لإجمالي الروابط لكل حساب — يمنع استخدام حساب واحد (أو
  // سكربت يستدعي Firestore مباشرة) لإغراق قاعدة البيانات بمستندات
  // بلا حدود. هذا مجرد تحقّق سريع وودّي؛ الإنفاذ الحقيقي في firestore.rules.
  if(!editingLinkId && links.length >= MAX_LINKS_PER_USER){
    showToast(t('linkLimitReachedToast'));
    return;
  }

  let title = document.getElementById('fTitle').value.trim();
  const folder = document.getElementById('fFolder').value;
  const notes = document.getElementById('fNotes').value.trim();
  const type = detectType(url);
  const domain = domainOf(url);
  if(!title){ title = t('untitledFrom')(domain); }

  const pendingTag = document.getElementById('fTagInput') ? document.getElementById('fTagInput').value.trim().replace(/^#/, '') : '';
  if (pendingTag && !composingTags.includes(pendingTag)) {
    composingTags.push(pendingTag);
    const input = document.getElementById('fTagInput');
    if(input) input.value = '';
  }

  const data = { url, title, folder, notes, tags: [...composingTags], type, domain };
  const saveBtn = document.querySelector('#linkModalBackdrop .btn-primary');
  if(saveBtn) saveBtn.disabled = true;

  try{
    if(editingLinkId){
      await updateDoc(doc(db, 'users', currentUser.uid, 'links', editingLinkId), data);
      await mirrorLinkIfShared(folder, editingLinkId, data);
    } else {
      const newLinkId = await createLinkWithCounter(currentUser.uid, { ...data, timeNotes: [], progress: 0 });
      await mirrorLinkIfShared(folder, newLinkId, data);
    }
    closeLinkModal();
    showToast(t('linkSavedToast'));
  }catch(err){
    console.error(err);
    showToast(err && err.code === 'permission-denied' ? t('linkLimitReachedToast') : t('authGeneric'));
  }finally{
    if(saveBtn) saveBtn.disabled = false;
  }
}

/* ------------------------------------------------------------
   ينشئ الرابط الجديد ويزيد users/{uid}.linksCount في نفس المعاملة
   الذرية (transaction)، حتى تبقى الكتابتان متزامنتين دائماً وتستطيع
   firestore.rules التحقّق بأمان من أن العدّاد لا يزيد إلا بمقدار 1
   لكل رابط جديد، ولا يتجاوز أبداً MAX_LINKS_PER_USER.
   ------------------------------------------------------------ */
async function createLinkWithCounter(uid, data){
  const userRef = doc(db, 'users', uid);
  const newLinkRef = doc(collection(db, 'users', uid, 'links'));

  await runTransaction(db, async (tx) => {
    const userSnap = await tx.get(userRef);
    const currentCount = (userSnap.exists() && typeof userSnap.data().linksCount === 'number')
      ? userSnap.data().linksCount
      : 0;

    if(currentCount >= MAX_LINKS_PER_USER){
      throw Object.assign(new Error('Link limit reached'), { code: 'permission-denied' });
    }

    tx.set(userRef, { linksCount: currentCount + 1 }, { merge: true });
    tx.set(newLinkRef, { ...data, createdAt: serverTimestamp() });
  });

  return newLinkRef.id;
}

/* ============================================================
   YOUTUBE PLAYLIST IMPORT
   ------------------------------------------------------------
   The YouTube API key lives only on the server (/api/playlist).
   Here we send the playlist ID plus the user's Firebase ID token,
   then save every returned video as its own link card through
   createLinkWithCounter(), so the 200-link limit still applies.
   ============================================================ */
const PLAYLIST_API_PATH = '/api/playlist';
const PLAYLIST_FOLDER_COLORS = ['#226864','#e07a5f','#9c6644','#3e6563','#5f7161','#8d6a9f'];
const PLAYLIST_ID_IN_URL = /^[A-Za-z0-9_-]{13,64}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com']);
const PLAYLIST_ERROR_TOASTS = {
  playlist_not_found: 'playlistNotFoundToast',
  invalid_playlist_id: 'playlistNotFoundToast',
  quota_exceeded: 'playlistQuotaToast',
};
let playlistImportRunning = false;

/** Returns the playlist ID from a YouTube URL's ?list= parameter, or '' if none. */
function extractPlaylistId(rawUrl){
  try{
    const parsed = new URL(String(rawUrl || '').trim());
    if(!YOUTUBE_HOSTS.has(parsed.hostname)) return '';
    const listId = parsed.searchParams.get('list') || '';
    return PLAYLIST_ID_IN_URL.test(listId) ? listId : '';
  }catch(e){
    return '';
  }
}

/** Shows the import button only while the URL field holds a playlist link (add mode only). */
function updatePlaylistImportVisibility(){
  const box = document.getElementById('playlistImportBox');
  const urlField = document.getElementById('fUrl');
  if(!box || !urlField) return;
  box.style.display = (editingLinkId === null && extractPlaylistId(urlField.value)) ? '' : 'none';
}

/** Asks our serverless function for the playlist's title and videos. */
async function fetchPlaylist(playlistId){
  const idToken = await currentUser.getIdToken();
  const response = await fetch(`${PLAYLIST_API_PATH}?id=${encodeURIComponent(playlistId)}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const body = await response.json().catch(() => ({}));
  if(!response.ok) throw Object.assign(new Error('Playlist request failed'), { apiCode: body.error || `http_${response.status}` });
  return body;
}

/** Finds a folder with this name (case-insensitive) or creates it; returns its ID. */
async function getOrCreatePlaylistFolder(title){
  const wanted = title.trim().toLowerCase();
  const existing = folders.find(f => String(f.name || '').trim().toLowerCase() === wanted);
  if(existing) return existing.id;
  const color = PLAYLIST_FOLDER_COLORS[folders.length % PLAYLIST_FOLDER_COLORS.length];
  const ref = await addDoc(collection(db, 'users', currentUser.uid, 'folders'), { name: title, color, createdAt: serverTimestamp() });
  return ref.id;
}

/** Saves each new video as a link card; stops cleanly at the link limit. */
async function saveVideosAsLinks(videos, folderId){
  const knownUrls = new Set(links.map(l => l.url));
  let added = 0;
  let skipped = 0;
  let hitLimit = false;
  for(const video of videos){
    const url = `https://www.youtube.com/watch?v=${video.videoId}`;
    if(knownUrls.has(url)){ skipped++; continue; }
    if(links.length + added >= MAX_LINKS_PER_USER){ hitLimit = true; break; }
    const data = { url, title: video.title || t('untitledFrom')('youtube.com'), folder: folderId, notes: '', tags: [], type: detectType(url), domain: domainOf(url), timeNotes: [], progress: 0 };
    try{
      const newLinkId = await createLinkWithCounter(currentUser.uid, data);
      await mirrorLinkIfShared(folderId, newLinkId, data);
      added++;
    }catch(err){
      if(err && err.code === 'permission-denied'){ hitLimit = true; break; }
      throw err;
    }
  }
  return { added, skipped, hitLimit };
}

/** Click handler of the "Import the whole playlist" button. */
async function importPlaylist(){
  if(!currentUser || playlistImportRunning) return;
  const playlistId = extractPlaylistId(document.getElementById('fUrl').value);
  if(!playlistId) return;

  const button = document.getElementById('importPlaylistBtn');
  playlistImportRunning = true;
  button.disabled = true;
  showToast(t('playlistImporting'));
  try{
    const playlist = await fetchPlaylist(playlistId);
    if(!Array.isArray(playlist.videos) || playlist.videos.length === 0){ showToast(t('playlistEmptyToast')); return; }
    const folderId = await getOrCreatePlaylistFolder(playlist.title);
    const { added, skipped, hitLimit } = await saveVideosAsLinks(playlist.videos, folderId);
    closeLinkModal();
    const message = hitLimit ? t('playlistPartialToast')(added) : t('playlistImportedToast')(added, skipped);
    showToast(playlist.truncated ? message + t('playlistTruncatedNote') : message);
  }catch(err){
    console.error(err);
    const knownToastKey = PLAYLIST_ERROR_TOASTS[err && err.apiCode];
    // Unknown failures show their short code so the real cause can be diagnosed.
    const debugCode = knownToastKey ? '' : ` [${(err && (err.apiCode || err.message)) || 'unknown'}]`;
    showToast(t(knownToastKey || 'playlistFailedToast') + debugCode);
  }finally{
    playlistImportRunning = false;
    button.disabled = false;
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
   VIDEO PLAYER MODAL
   ============================================================ */
let ytPlayer = null;
let ytApiReady = false;
let activePlayerLink = null;
let progressSaveInterval = null;

window.onYouTubeIframeAPIReady = function(){
  ytApiReady = true;
  if(activePlayerLink){ mountYouTubePlayer(activePlayerLink); }
};

(function loadYouTubeIframeAPI(){
  if(window.YT && window.YT.Player){ ytApiReady = true; return; }
  if(document.getElementById('yt-iframe-api-script')) return;
  const tag = document.createElement('script');
  tag.id = 'yt-iframe-api-script';
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
})();

function waitForYouTubeAPI(l){
  if(window.YT && window.YT.Player){
    ytApiReady = true;
    if(activePlayerLink === l) mountYouTubePlayer(l);
    return;
  }
  setTimeout(() => { if(activePlayerLink === l) waitForYouTubeAPI(l); }, 200);
}

function openPlayerModal(l){
  activePlayerLink = l;
  if(!l.timeNotes) l.timeNotes = [];
  destroyYtPlayer();
  resetVideoLock();

  const vid = extractYouTubeId(l.url);
  const wrap = document.getElementById('playerWrap');
  if(vid){
    wrap.innerHTML = `<div id="ytPlayerEl" style="position:absolute; inset:0; width:100%; height:100%;"></div>`;
    if(ytApiReady && window.YT && YT.Player){
      mountYouTubePlayer(l);
    } else {
      waitForYouTubeAPI(l);
    }
  } else {
    wrap.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;">${t('previewUnavailable')}</div>`;
  }

  document.getElementById('playerTitle').textContent = l.title;
  document.getElementById('playerDomain').innerHTML = `<span class="favicon-dot"></span>${escapeHtml(l.domain)}`;

  playerComposingTags = [...(l.tags || [])];
  renderPlayerTagRow();

  document.getElementById('playerNotes').value = l.notes || '';
  document.getElementById('deleteVideoBtn').onclick = () => { const id = l.id; activePlayerLink = null; deleteLink(id); closePlayerModal(); };
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
  const playerVars = { rel: 0, modestbranding: 1, playsinline: 1 };
  if(l.progress && l.progress > 3){ playerVars.start = Math.floor(l.progress); }

  ytPlayer = new YT.Player('ytPlayerEl', {
    videoId: vid,
    playerVars,
    events: {
      onReady: function(){
        startProgressAutosave();
      },
      onStateChange: function(e){
        if(e.data === 0){
          stopProgressAutosave();
          resetPlaybackProgress();
        }
      },
      onError: function(){
        stopProgressAutosave();
        const w = document.getElementById('playerWrap');
        if(w){
          w.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;text-align:center;padding:20px;">${t('previewUnavailable')}</div>`;
        }
      }
    }
  });
}

function destroyYtPlayer(){
  stopProgressAutosave();
  if(ytPlayer && typeof ytPlayer.destroy === 'function'){
    try{ ytPlayer.destroy(); } catch(e){ /* no-op */ }
  }
  ytPlayer = null;
}

function closePlayerModal(){
  savePlayerNotes();
  savePlayerTags();
  savePlaybackProgress();
  stopProgressAutosave();
  resetVideoLock();
  if(document.fullscreenElement){ document.exitFullscreen(); }
  document.getElementById('playerModalBackdrop').classList.remove('show');
  destroyYtPlayer();
  document.getElementById('playerWrap').innerHTML = '';
  activePlayerLink = null;
}

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

let isVideoLocked = false;
let lockBtnHideTimer = null;

function showLockBtn(){
  const container = document.getElementById('playerVideoContainer');
  if(!container) return;
  container.classList.add('lock-btn-visible');
  clearTimeout(lockBtnHideTimer);
  lockBtnHideTimer = setTimeout(() => {
    container.classList.remove('lock-btn-visible');
  }, 3000);
}

function toggleVideoLock(e){
  if(e) e.stopPropagation();
  const container = document.getElementById('playerVideoContainer');
  if(!container) return;
  isVideoLocked = !isVideoLocked;
  container.classList.toggle('controls-locked', isVideoLocked);

  const openIcon = document.getElementById('lockIconOpen');
  const closedIcon = document.getElementById('lockIconClosed');
  if(openIcon) openIcon.classList.toggle('hidden', isVideoLocked);
  if(closedIcon) closedIcon.classList.toggle('hidden', !isVideoLocked);

  const lockBtn = document.getElementById('playerLockBtn');
  if(lockBtn){
    const label = isVideoLocked ? t('unlockControls') : t('lockControls');
    lockBtn.title = label;
    lockBtn.setAttribute('aria-label', label);
  }

  showLockBtn();
}

function handleLockOverlayTap(){
  showLockBtn();
}

function resetVideoLock(){
  const container = document.getElementById('playerVideoContainer');
  if(!container) return;
  isVideoLocked = false;
  container.classList.remove('controls-locked', 'lock-btn-visible');
  clearTimeout(lockBtnHideTimer);
  const openIcon = document.getElementById('lockIconOpen');
  const closedIcon = document.getElementById('lockIconClosed');
  if(openIcon) openIcon.classList.remove('hidden');
  if(closedIcon) closedIcon.classList.add('hidden');
}

function handleFullscreenChange(){
  updateZoomBtnState();
  if(!document.fullscreenElement && !document.webkitFullscreenElement){
    resetVideoLock();
  }
}
document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

async function savePlayerNotes(){
  if(!currentUser || !activePlayerLink) return;
  const textarea = document.getElementById('playerNotes');
  if(!textarea) return;
  const notes = textarea.value.trim();
  if((activePlayerLink.notes || '') === notes) return;
  try{
    await updateDoc(doc(db, 'users', currentUser.uid, 'links', activePlayerLink.id), { notes });
    activePlayerLink.notes = notes;
    const link = links.find(x => x.id === activePlayerLink.id);
    if(link) link.notes = notes;
    showToast(t('notesSavedToast'));
  }catch(err){
    console.error(err);
  }
}

function renderPlayerTagRow(){
  const row = document.getElementById('playerTagRow');
  const input = document.getElementById('playerTagInput');
  if(!row || !input) return;
  row.querySelectorAll('.tag-pill').forEach(el => el.remove());
  playerComposingTags.forEach(tg => row.insertBefore(createTagPill(tg, removePlayerTag), input));
}

function handlePlayerTagKey(e){
  if(e.key === 'Enter' || e.key === ','){
    e.preventDefault();
    const input = document.getElementById('playerTagInput');
    const val = input.value.trim().replace(/^#/,'');
    if(val && !playerComposingTags.includes(val)){
      playerComposingTags.push(val);
      renderPlayerTagRow();
      savePlayerTags();
    }
    input.value = '';
  } else if(e.key === 'Backspace' && document.getElementById('playerTagInput').value === ''){
    if(playerComposingTags.length){
      playerComposingTags.pop();
      renderPlayerTagRow();
      savePlayerTags();
    }
  }
}

function removePlayerTag(tg){
  playerComposingTags = playerComposingTags.filter(x => x !== tg);
  renderPlayerTagRow();
  savePlayerTags();
}

async function savePlayerTags(){
  if(!currentUser || !activePlayerLink) return;
  const pendingTag = document.getElementById('playerTagInput') ? document.getElementById('playerTagInput').value.trim().replace(/^#/, '') : '';
  if (pendingTag && !playerComposingTags.includes(pendingTag)) {
    playerComposingTags.push(pendingTag);
    const input = document.getElementById('playerTagInput');
    if(input) input.value = '';
    renderPlayerTagRow();
  }
  const tags = [...playerComposingTags];
  try{
    await updateDoc(doc(db, 'users', currentUser.uid, 'links', activePlayerLink.id), { tags });
    activePlayerLink.tags = tags;
    const link = links.find(x => x.id === activePlayerLink.id);
    if(link) link.tags = tags;
  }catch(err){
    console.error(err);
  }
}

async function savePlaybackProgress(){
  if(!currentUser || !activePlayerLink || !ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;
  const progress = Math.floor(ytPlayer.getCurrentTime());
  if(!progress || progress < 3) return;
  if(activePlayerLink.progress === progress) return;
  try{
    await updateDoc(doc(db, 'users', currentUser.uid, 'links', activePlayerLink.id), { progress });
    activePlayerLink.progress = progress;
    const link = links.find(x => x.id === activePlayerLink.id);
    if(link) link.progress = progress;
  }catch(err){
    console.error(err);
  }
}

function startProgressAutosave(){
  stopProgressAutosave();
  progressSaveInterval = setInterval(() => {
    if(ytPlayer && typeof ytPlayer.getPlayerState === 'function' && ytPlayer.getPlayerState() === 1){
      savePlaybackProgress();
    }
  }, 5000);
}
function stopProgressAutosave(){
  if(progressSaveInterval){ clearInterval(progressSaveInterval); progressSaveInterval = null; }
}

async function resetPlaybackProgress(){
  if(!currentUser || !activePlayerLink) return;
  if(!activePlayerLink.progress) return;
  try{
    await updateDoc(doc(db, 'users', currentUser.uid, 'links', activePlayerLink.id), { progress: 0 });
    activePlayerLink.progress = 0;
    const link = links.find(x => x.id === activePlayerLink.id);
    if(link) link.progress = 0;
  }catch(err){
    console.error(err);
  }
}

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
      <button type="button" class="time-note-badge" ${canSeek ? `onclick="seekToTime(${Number(n.time) || 0})"` : 'disabled'}>${formatTime(n.time)}</button>
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
  currentDetailLinkId = l.id;
  document.getElementById('detailTitle').textContent = l.title;
  document.getElementById('detailThumb').src = thumbFor(l, folderObj);
  document.getElementById('detailThumb').dataset.thumbStep = '0';
  document.getElementById('detailThumb').onerror = function(){
    handleThumbError(this, extractYouTubeId(l.url), placeholderThumb(l.title, folderObj ? hashCode(folderObj.id)%360 : undefined));
  };
  document.getElementById('detailDomain').innerHTML = `<span class="favicon-dot"></span>${escapeHtml(l.domain)} · ${folderObj?escapeHtml(folderObj.name):''}`;
  document.getElementById('detailTags').innerHTML = (l.tags||[]).map(tg=>`<span class="tag">#${escapeHtml(tg)}</span>`).join('') || '<span class="hint">No tags yet</span>';
  document.getElementById('detailNotes').value = l.notes || '';
  document.getElementById('detailOpenBtn').href = isSafeUrl(l.url) ? l.url : '#';
  document.getElementById('deleteLinkBtn').onclick = () => { currentDetailLinkId = null; deleteLink(l.id); closeDetailModal(); };
  document.getElementById('detailModalBackdrop').classList.add('show');
}
function closeDetailModal(){
  saveDetailNotes();
  document.getElementById('detailModalBackdrop').classList.remove('show');
  currentDetailLinkId = null;
}

async function saveDetailNotes(){
  if(!currentUser || !currentDetailLinkId) return;
  const textarea = document.getElementById('detailNotes');
  if(!textarea) return;
  const notes = textarea.value.trim();
  const link = links.find(x => x.id === currentDetailLinkId);
  if(link && (link.notes || '') === notes) return;
  try{
    await updateDoc(doc(db, 'users', currentUser.uid, 'links', currentDetailLinkId), { notes });
    if(link) link.notes = notes;
    showToast(t('notesSavedToast'));
  }catch(err){
    console.error(err);
  }
}

async function deleteLink(id){
  if(!currentUser) return;
  const link = links.find(x => x.id === id);
  try{
    const batch = writeBatch(db);
    batch.delete(doc(db, 'users', currentUser.uid, 'links', id));
    batch.set(doc(db, 'users', currentUser.uid), { linksCount: increment(-1) }, { merge: true });
    await batch.commit();
    if(link) await unmirrorLink(link.folder, id);
    showToast(t('linkRemovedToast'));
  }catch(err){
    console.error(err);
  }
}

/* ============================================================
   SIGN OUT
   ============================================================ */
async function exitApp(){
  try{
    await signOut(auth);
  }catch(err){
    console.error(err);
  }
}

/* ============================================================
   i18n
   ============================================================ */
setDynamicTranslationHook(() => {
  updateTopbarTitle();
  renderLinks();
  if(currentUser){ updateUserRow(currentUser); }
  if(activePlayerLink){
    renderTimeNotes(activePlayerLink);
    updateZoomBtnState();
  }
});

/* ============================================================
   Expose functions for inline HTML event handlers.
   (toggleTag / removeTag / removePlayerTag are no longer exposed:
   tag interactions go through delegated listeners and DOM-built
   buttons instead of inline onclick strings.)
   ============================================================ */
Object.assign(window, {
  toggleTheme, openSidebar, closeSidebar, selectFolder, handleSearch,
  openCard, openLinkModal, closeLinkModal, autoFillTitle, handleTagKey,
  saveLink, openFolderModal, closeFolderModal, createFolder, toggleVideoZoom,
  useCurrentTime, addTimeNote, deleteTimeNote, seekToTime, closeDetailModal,
  saveDetailNotes, savePlayerNotes, closePlayerModal, exitApp,
  handlePlayerTagKey,
  toggleVideoLock, handleLockOverlayTap,
  openShareModal, closeShareModal, copyShareUrl, createShareLink, stopSharingFolder,
  resendVerification, checkVerification, verifyExitApp,
  importPlaylist,
  closeDeleteFolderModal, confirmDeleteFolder,
});
