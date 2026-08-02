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
import {
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc,
  onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, t, showToast, escapeHtml, escapeAttr, setDynamicTranslationHook } from "./shared.js";

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
   SIGN OUT — Firestore listeners are torn down and the redirect
   to index.html happens automatically via the route guard above
   once Firebase confirms the session ended.
   ============================================================ */
async function exitApp(){
  try{
    await signOut(auth);
  }catch(err){
    console.error(err);
  }
}

/* ============================================================
   i18n — re-render whatever this page generates dynamically
   (topbar title, link grid, user row, video player notes)
   whenever the language is switched
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
   Expose functions used as inline HTML event handlers (onclick=...)
   Required because this file is loaded as an ES module — module
   scope is not global scope, so inline handlers can't see these
   otherwise.
   ============================================================ */
Object.assign(window, {
  toggleTheme, openSidebar, closeSidebar, selectFolder, handleSearch, toggleTag,
  openCard, openLinkModal, closeLinkModal, autoFillTitle, handleTagKey, removeTag,
  saveLink, openFolderModal, closeFolderModal, createFolder, toggleVideoZoom,
  useCurrentTime, addTimeNote, deleteTimeNote, seekToTime, closeDetailModal,
  closePlayerModal, exitApp,
});
