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
 ============================================================ */
import { signOut, onAuthStateChanged, sendEmailVerification } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, setDoc, getDocs,
  onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, t, showToast, escapeHtml, escapeAttr, setDynamicTranslationHook, getStoredTheme, setTheme } from "./shared.js";
import { SHARED_FOLDERS_COLLECTION } from "./firebase-config.js";

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

/* ------------------------------------------------------------
   ROUTE GUARD — this page is only for signed-in users. A visitor
   with no session gets sent straight back to the landing/auth
   page. A first-time arrival (coming from sign-in) shows the
   welcome toast; a plain page refresh while already signed in
   quietly resumes without repeating it.
   ------------------------------------------------------------ */
let hasEnteredOnce = false;
onAuthStateChanged(auth, (user) => {
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
    updateUserRow(user);
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
      document.getElementById('verifyView').classList.add('hidden');
      updateUserRow(currentUser);
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
function renderFolderNav(){
  const nav = document.getElementById('folderNav');
  nav.innerHTML = folders.map(f => {
    const count = links.filter(l => l.folder === f.id).length;
    return `<div class="nav-item ${activeFolder===f.id?'active':''}" data-folder="${f.id}" onclick="selectFolder('${f.id}')">
      <span class="folder-dot" style="background:${f.color}"></span>
      <span>${escapeHtml(f.name)}</span>
      <span class="count">${count}</span>
      <button type="button" class="folder-share-btn" onclick="event.stopPropagation(); openShareModal('${f.id}')" title="${t('shareFolder')}" aria-label="${t('shareFolder')}">
        <svg class="icon" style="width:14px;height:14px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.5l6.8-3.9M8.6 13.5l6.8 3.9"/></svg>
      </button>
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

function renderTagChips(){
  const allTags = [...new Set(links.flatMap(l => l.tags || []))].sort();
  const chips = document.getElementById('tagChips');
  if(allTags.length === 0){ chips.innerHTML = ''; return; }

  const TAG_LIMIT = 5;
  const visibleTags = tagsExpanded ? allTags : allTags.slice(0, TAG_LIMIT);

  let html = visibleTags.map(tag =>
    `<button class="chip ${activeTag===tag?'active':''}" onclick="toggleTag('${escapeAttr(tag)}')">#${escapeHtml(tag)}</button>`
  ).join('');

  if(allTags.length > TAG_LIMIT){
    html += `<button class="chip chip-more" onclick="toggleTagsExpanded()">${tagsExpanded ? t('showLessTags') : t('showMoreTags')}</button>`;
  }

  chips.innerHTML = html;
}
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
    return `<div class="link-card" onclick="openCard('${l.id}')">
      <div class="thumb"><img src="${thumbFor(l, folderObj)}" onerror="handleThumbError(this, '${extractYouTubeId(l.url) || ''}', '${placeholderThumb(l.title, folderObj ? hashCode(folderObj.id)%360 : undefined)}')" alt="">${playBadge}</div>
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

async function stopSharingFolder(){
  if(!currentUser || !shareModalFolderId) return;
  const folder = folders.find(f => f.id === shareModalFolderId);
  if(!folder || !folder.shareId) return;

  try{
    const linksSnap = await getDocs(collection(db, SHARED_FOLDERS_COLLECTION, folder.shareId, 'links'));
    await Promise.all(linksSnap.docs.map(d => deleteDoc(d.ref)));
    await deleteDoc(doc(db, SHARED_FOLDERS_COLLECTION, folder.shareId));
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
      const ref = await addDoc(collection(db, 'users', currentUser.uid, 'links'), { ...data, timeNotes: [], progress: 0, createdAt: serverTimestamp() });
      await mirrorLinkIfShared(folder, ref.id, data);
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
  playerComposingTags.forEach(tg => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.innerHTML = `#${escapeHtml(tg)} <button type="button" onclick="removePlayerTag('${escapeAttr(tg)}')">&times;</button>`;
    row.insertBefore(pill, input);
  });
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
    await deleteDoc(doc(db, 'users', currentUser.uid, 'links', id));
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
   Expose functions for inline HTML event handlers
   ============================================================ */
Object.assign(window, {
  toggleTheme, openSidebar, closeSidebar, selectFolder, handleSearch, toggleTag,
  toggleTagsExpanded,
  openCard, openLinkModal, closeLinkModal, autoFillTitle, handleTagKey, removeTag,
  saveLink, openFolderModal, closeFolderModal, createFolder, toggleVideoZoom,
  useCurrentTime, addTimeNote, deleteTimeNote, seekToTime, closeDetailModal,
  saveDetailNotes, savePlayerNotes, closePlayerModal, exitApp,
  handlePlayerTagKey, removePlayerTag,
  toggleVideoLock, handleLockOverlayTap,
  openShareModal, closeShareModal, copyShareUrl, createShareLink, stopSharingFolder,
  resendVerification, checkVerification, verifyExitApp,
});
