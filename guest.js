/* ============================================================
   GUEST.JS — loaded only by guest.html
   ------------------------------------------------------------
   Same dashboard as app.html/dashboard.js, but for visitors
   without an account. NOTHING is sent to Firestore: folders and
   links live in this browser's localStorage only.

   Data model (one JSON object under GUEST_STORAGE_KEY):
     { folders: [{ id, name, color }],
       links:   [{ id, url, title, folder, notes, tags, type,
                   domain, timeNotes, progress, createdAt }] }

   Security notes:
   - localStorage can be edited by the user (or by browser
     extensions), so everything read from it is validated again
     (see normalizeLink / normalizeFolder) before being rendered.
   - Only http/https links are stored or opened.
   - Ids and tags are never put inside inline onclick code; they
     go in data-* attributes handled by delegated listeners.
   - Signed-in users are sent to app.html automatically.
 ============================================================ */
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  auth, SESSION_FLAG_KEY, t, showToast, escapeHtml, escapeAttr,
  setDynamicTranslationHook, getStoredTheme, setTheme, currentLang
} from "./shared.js";

/* ---------------- Constants ---------------- */
const GUEST_STORAGE_KEY = 'moswada-guest-data';
const APP_PAGE = 'app.html';
const MAX_LINKS_PER_GUEST = 200;           // same limit as signed-in accounts
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_FOLDER_COLOR = '#226864';
const FOLDER_COLORS = ['#226864', '#e07a5f', '#9c6644', '#3e6563', '#5f7161', '#8d6a9f'];
const DEFAULT_FOLDER_NAMES = { ar: 'عام', en: 'General' };
const VISIBLE_FOLDERS_LIMIT = 5;
const VISIBLE_TAGS_LIMIT = 5;
const FOLDER_MENU_GAP_PX = 4;
const FOLDER_MENU_VIEWPORT_MARGIN_PX = 8;
const PROGRESS_SAVE_INTERVAL_MS = 5000;
const MIN_PROGRESS_SECONDS = 3;
const LOCK_BUTTON_HIDE_DELAY_MS = 3000;
const YT_PLAYER_STATE_PLAYING = 1;
const YT_PLAYER_STATE_ENDED = 0;

/* ---------------- Guest-only i18n strings ---------------- */
const GUEST_I18N = {
  en: {
    invalidUrlToast: 'Please enter a valid http:// or https:// link',
    noTagsYet: 'No tags yet',
    storageErrorToast: "Couldn't save on this device. Your browser storage may be full or blocked.",
  },
  ar: {
    invalidUrlToast: 'أدخل رابطاً صحيحاً يبدأ بـ http:// أو https://',
    noTagsYet: 'لا توجد وسوم بعد',
    storageErrorToast: 'تعذّر الحفظ على هذا الجهاز. قد تكون مساحة التخزين ممتلئة أو محظورة.',
  }
};
function guestText(key){ return GUEST_I18N[currentLang][key]; }

/* ---------------- Redirect signed-in users to the real app ---------------- */
try{
  if(localStorage.getItem(SESSION_FLAG_KEY) === '1') location.replace(APP_PAGE);
}catch(err){ console.error('Session pre-check failed:', err); }

onAuthStateChanged(auth, (user) => { if(user) location.replace(APP_PAGE); });

/* ============================================================
   LOCAL STORAGE LAYER
   ============================================================ */
let folders = [];
let links = [];

/** Only http/https URLs may ever be stored or opened. */
function isSafeUrl(url){
  return /^https?:\/\/.+/i.test(String(url || '').trim());
}

function generateId(){
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Returns a clean folder object, or null if the stored value is unusable. */
function normalizeFolder(raw){
  if(!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string' || !raw.name.trim()) return null;
  return {
    id: raw.id,
    name: raw.name,
    color: HEX_COLOR_PATTERN.test(String(raw.color || '')) ? raw.color : DEFAULT_FOLDER_COLOR
  };
}

/** Returns a clean link object, or null if the stored value is unusable. */
function normalizeLink(raw){
  if(!raw || typeof raw.id !== 'string' || !isSafeUrl(raw.url)) return null;
  const timeNotes = Array.isArray(raw.timeNotes)
    ? raw.timeNotes
        .filter(n => n && Number.isFinite(Number(n.time)) && typeof n.text === 'string')
        .map(n => ({ time: Number(n.time), text: n.text }))
    : [];
  return {
    id: raw.id,
    url: String(raw.url).trim(),
    title: String(raw.title || ''),
    folder: String(raw.folder || ''),
    notes: String(raw.notes || ''),
    tags: Array.isArray(raw.tags) ? raw.tags.filter(tag => typeof tag === 'string') : [],
    type: raw.type === 'video' ? 'video' : 'article',
    domain: String(raw.domain || ''),
    thumb: null,
    timeNotes,
    progress: Number.isFinite(Number(raw.progress)) ? Number(raw.progress) : 0,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : 0
  };
}

/** Reads and validates the saved guest data; falls back to empty on any problem. */
function loadGuestData(){
  try{
    const raw = localStorage.getItem(GUEST_STORAGE_KEY);
    if(!raw) return;
    const parsed = JSON.parse(raw);
    folders = (Array.isArray(parsed.folders) ? parsed.folders : []).map(normalizeFolder).filter(Boolean);
    links = (Array.isArray(parsed.links) ? parsed.links : []).map(normalizeLink).filter(Boolean);
  }catch(err){
    console.error('Could not read guest data:', err);
    folders = [];
    links = [];
  }
}

/** Writes folders/links to localStorage. Returns false (and warns) on failure. */
function saveGuestData(){
  try{
    localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify({ folders, links }));
    return true;
  }catch(err){
    console.error('Could not save guest data:', err);
    showToast(guestText('storageErrorToast'));
    return false;
  }
}

/** Links need a folder, so make sure at least one always exists. */
function ensureDefaultFolder(){
  if(folders.length > 0) return;
  folders.push({ id: generateId(), name: DEFAULT_FOLDER_NAMES[currentLang] || DEFAULT_FOLDER_NAMES.ar, color: DEFAULT_FOLDER_COLOR });
  saveGuestData();
}

/** Links without a valid folder are moved into the first folder. */
function repairOrphanLinks(){
  const folderIds = new Set(folders.map(f => f.id));
  links.forEach(l => { if(!folderIds.has(l.folder)) l.folder = folders[0].id; });
}

function sortLinksNewestFirst(){
  links.sort((a, b) => b.createdAt - a.createdAt);
}

/* ============================================================
   UI STATE
   ============================================================ */
let activeFolder = 'all';
let searchQuery = '';
let activeTag = null;
let composingTags = [];
let playerComposingTags = [];
let currentDetailLinkId = null;
let tagsExpanded = false;
let foldersExpanded = false;
let folderMenuTargetId = null;
let deleteFolderTargetId = null;

/* ============================================================
   THUMBNAILS
   ============================================================ */
function hashCode(str){ let hash=0; for(let i=0;i<str.length;i++){ hash = str.charCodeAt(i) + ((hash<<5)-hash); } return hash; }

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

function extractYouTubeId(url){
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}
function youTubeThumbUrl(url){
  const id = extractYouTubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}
function fallbackHueFor(folderObj){
  return folderObj ? hashCode(folderObj.id) % 360 : undefined;
}
function thumbFor(link, folderObj){
  if(link.type === 'video'){
    const ytThumb = youTubeThumbUrl(link.url);
    if(ytThumb) return ytThumb;
  }
  return placeholderThumb(link.title, fallbackHueFor(folderObj));
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
   THEME + MOBILE SIDEBAR
   ============================================================ */
function isDarkNow(){
  const pref = getStoredTheme();
  return pref === 'dark' ||
    (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
function syncThemeSwitch(){
  const themeSwitch = document.getElementById('themeSwitch');
  if(themeSwitch) themeSwitch.classList.toggle('on', isDarkNow());
}
function toggleTheme(){
  setTheme(isDarkNow() ? 'light' : 'dark');
  syncThemeSwitch();
}
document.addEventListener('DOMContentLoaded', syncThemeSwitch);

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
/** Collapsed list keeps the active folder visible. */
function getVisibleFolders(){
  if(foldersExpanded) return folders;
  return folders.filter((f, index) => index < VISIBLE_FOLDERS_LIMIT || f.id === activeFolder);
}

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

/* ---------------- Folder ⋮ menu (delete only) ---------------- */
function closeFolderMenu(){
  document.getElementById('folderMenu').classList.add('hidden');
  folderMenuTargetId = null;
}

function toggleFolderMenu(folderId, anchorButton){
  const menu = document.getElementById('folderMenu');
  if(folderMenuTargetId === folderId){ closeFolderMenu(); return; }

  folderMenuTargetId = folderId;
  menu.classList.remove('hidden');

  const anchor = anchorButton.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const isRtl = document.documentElement.dir === 'rtl';
  const unclampedLeft = isRtl ? anchor.left : anchor.right - size.width;
  const maxLeft = window.innerWidth - size.width - FOLDER_MENU_VIEWPORT_MARGIN_PX;
  const left = Math.min(Math.max(unclampedLeft, FOLDER_MENU_VIEWPORT_MARGIN_PX), maxLeft);

  let top = anchor.bottom + FOLDER_MENU_GAP_PX;
  if(top + size.height > window.innerHeight - FOLDER_MENU_VIEWPORT_MARGIN_PX){
    top = anchor.top - size.height - FOLDER_MENU_GAP_PX;
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

document.getElementById('folderMenu').addEventListener('click', (event) => {
  const actionEl = event.target.closest('[data-action]');
  if(!actionEl || !folderMenuTargetId) return;
  const folderId = folderMenuTargetId;
  closeFolderMenu();
  if(actionEl.dataset.action === 'delete-folder') openDeleteFolderModal(folderId);
});
document.addEventListener('click', (event) => {
  if(!event.target.closest('#folderMenu, .folder-menu-btn')) closeFolderMenu();
});
document.addEventListener('keydown', (event) => { if(event.key === 'Escape') closeFolderMenu(); });
document.getElementById('sidebar').addEventListener('scroll', closeFolderMenu);

/* ---------------- Delete folder ---------------- */
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
function confirmDeleteFolder(){
  const folder = folders.find(f => f.id === deleteFolderTargetId);
  if(!folder) return;

  folders = folders.filter(f => f.id !== folder.id);
  links = links.filter(l => l.folder !== folder.id);
  ensureDefaultFolder();
  repairOrphanLinks();
  saveGuestData();

  if(activeFolder === folder.id) selectFolder('all');
  closeDeleteFolderModal();
  renderAll();
  showToast(t('folderDeletedToast'));
}

function updateTopbarTitle(){
  const titles = { all: t('allLinks'), videos: t('videosTitle') };
  const folderObj = folders.find(f => f.id === activeFolder);
  document.getElementById('topbarTitle').textContent = folderObj ? folderObj.name : (titles[activeFolder] || t('allLinks'));
}

function selectFolder(id){
  activeFolder = id;
  activeTag = null;
  document.querySelectorAll('.nav-item[data-folder]').forEach(el => el.classList.toggle('active', el.dataset.folder === id));
  updateTopbarTitle();
  renderLinks();
  closeSidebar();
}

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
    const cleanQuery = searchQuery.trim().replace(/^#/, '');
    list = list.filter(l =>
      l.title.toLowerCase().includes(searchQuery) ||
      l.notes.toLowerCase().includes(searchQuery) ||
      l.tags.some(tg => tg.toLowerCase().trim().includes(cleanQuery))
    );
  }
  return list;
}

function renderTagChips(){
  const allTags = [...new Set(links.flatMap(l => l.tags))].sort();
  const chips = document.getElementById('tagChips');
  if(allTags.length === 0){ chips.innerHTML = ''; return; }

  const visibleTags = tagsExpanded ? allTags : allTags.slice(0, VISIBLE_TAGS_LIMIT);
  let html = visibleTags.map(tag =>
    `<button type="button" class="chip ${activeTag===tag?'active':''}" data-action="filter-tag" data-tag="${escapeAttr(tag)}">#${escapeHtml(tag)}</button>`
  ).join('');
  if(allTags.length > VISIBLE_TAGS_LIMIT){
    html += `<button type="button" class="chip chip-more" data-action="toggle-more-tags">${tagsExpanded ? t('showLessTags') : t('showMoreTags')}</button>`;
  }
  chips.innerHTML = html;
}

document.getElementById('tagChips').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-action]');
  if(!chip) return;
  if(chip.dataset.action === 'filter-tag'){
    activeTag = activeTag === chip.dataset.tag ? null : chip.dataset.tag;
    renderLinks();
  } else if(chip.dataset.action === 'toggle-more-tags'){
    tagsExpanded = !tagsExpanded;
    renderTagChips();
  }
});

function renderTagDatalist(){
  const datalist = document.getElementById('existingTags');
  const allTags = [...new Set(links.flatMap(l => l.tags))].sort();
  datalist.innerHTML = allTags.map(tag => `<option value="${escapeAttr(tag)}"></option>`).join('');
}

function linkCardHtml(link){
  const folderObj = folders.find(f => f.id === link.folder);
  const playBadge = link.type === 'video'
    ? `<div class="play-badge"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg></div>`
    : '';
  const fallback = placeholderThumb(link.title, fallbackHueFor(folderObj));
  return `<div class="link-card" data-link-id="${escapeAttr(link.id)}">
      <div class="thumb"><img src="${escapeAttr(thumbFor(link, folderObj))}" onerror="handleThumbError(this, '${escapeAttr(extractYouTubeId(link.url) || '')}', '${fallback}')" alt="">${playBadge}</div>
      <div class="card-body">
        <div class="card-top">
          <div>
            <div class="card-title">${escapeHtml(link.title)}</div>
            <div class="card-domain"><span class="favicon-dot"></span>${escapeHtml(link.domain)}</div>
          </div>
        </div>
        <p class="card-notes">${escapeHtml(link.notes || t('noNotesYet'))}</p>
        <div class="card-tags">${link.tags.map(tg => `<span class="tag">#${escapeHtml(tg)}</span>`).join('')}</div>
        <div class="card-meta"><span>${folderObj ? escapeHtml(folderObj.name) : ''}</span><span>${link.type==='video'?t('playsInApp'):t('article')}</span></div>
      </div>
    </div>`;
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
  grid.innerHTML = list.map(linkCardHtml).join('');
}

function renderAll(){
  updateTopbarTitle();
  populateFolderSelect();
  renderLinks();
}

document.getElementById('linkGrid').addEventListener('click', (event) => {
  const card = event.target.closest('[data-link-id]');
  if(card) openCard(card.dataset.linkId);
});

function openCard(id){
  const link = links.find(x => x.id === id);
  if(!link) return;
  if(link.type === 'video') openPlayerModal(link);
  else openDetailModal(link);
}

/* ============================================================
   ADD LINK MODAL
   ============================================================ */
function populateFolderSelect(){
  const select = document.getElementById('fFolder');
  const current = select.value;
  select.innerHTML = folders.map(f => `<option value="${escapeAttr(f.id)}">${escapeHtml(f.name)}</option>`).join('');
  if([...select.options].some(o => o.value === current)) select.value = current;
}

function openLinkModal(){
  composingTags = [];
  document.getElementById('linkModalTitle').textContent = t('addALink');
  document.getElementById('fUrl').value = '';
  document.getElementById('fTitle').value = '';
  document.getElementById('fNotes').value = '';
  populateFolderSelect();
  if(activeFolder !== 'all' && activeFolder !== 'videos'){ document.getElementById('fFolder').value = activeFolder; }
  renderTagRow();
  document.getElementById('linkModalBackdrop').classList.add('show');
  setTimeout(() => document.getElementById('fUrl').focus(), 50);
}
function closeLinkModal(){ document.getElementById('linkModalBackdrop').classList.remove('show'); }

function autoFillTitle(){
  const titleField = document.getElementById('fTitle');
  const url = document.getElementById('fUrl').value.trim();
  if(!titleField.value && url){
    titleField.placeholder = t('untitledFrom')(domainOf(url));
  }
}

/** Builds one removable tag pill with DOM APIs, so tag text is never parsed as HTML. */
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
function removeTag(tag){
  composingTags = composingTags.filter(x => x !== tag);
  renderTagRow();
}
function handleTagKey(e){
  const input = document.getElementById('fTagInput');
  if(e.key === 'Enter' || e.key === ','){
    e.preventDefault();
    const value = input.value.trim().replace(/^#/, '');
    if(value && !composingTags.includes(value)){
      composingTags.push(value);
      renderTagRow();
    }
    input.value = '';
  } else if(e.key === 'Backspace' && input.value === ''){
    composingTags.pop();
    renderTagRow();
  }
}

function saveLink(){
  const url = document.getElementById('fUrl').value.trim();
  if(!url){ showToast(t('addUrlToast')); return; }
  if(!isSafeUrl(url)){ showToast(guestText('invalidUrlToast')); return; }
  if(links.length >= MAX_LINKS_PER_GUEST){ showToast(t('linkLimitReachedToast')); return; }

  const domain = domainOf(url);
  const title = document.getElementById('fTitle').value.trim() || t('untitledFrom')(domain);

  const pendingTag = document.getElementById('fTagInput').value.trim().replace(/^#/, '');
  if(pendingTag && !composingTags.includes(pendingTag)) composingTags.push(pendingTag);
  document.getElementById('fTagInput').value = '';

  const newLink = {
    id: generateId(),
    url,
    title,
    folder: document.getElementById('fFolder').value || folders[0].id,
    notes: document.getElementById('fNotes').value.trim(),
    tags: [...composingTags],
    type: detectType(url),
    domain,
    thumb: null,
    timeNotes: [],
    progress: 0,
    createdAt: Date.now()
  };

  links.unshift(newLink);
  if(!saveGuestData()){ links.shift(); return; }
  closeLinkModal();
  renderLinks();
  showToast(t('linkSavedToast'));
}

/* ============================================================
   FOLDER MODAL
   ============================================================ */
function openFolderModal(){
  document.getElementById('fFolderName').value = '';
  document.getElementById('folderModalBackdrop').classList.add('show');
  setTimeout(() => document.getElementById('fFolderName').focus(), 50);
}
function closeFolderModal(){ document.getElementById('folderModalBackdrop').classList.remove('show'); }

function createFolder(){
  const name = document.getElementById('fFolderName').value.trim();
  if(!name){ showToast(t('giveFolderNameToast')); return; }
  const color = FOLDER_COLORS[folders.length % FOLDER_COLORS.length];
  folders.push({ id: generateId(), name, color });
  if(!saveGuestData()){ folders.pop(); return; }
  closeFolderModal();
  renderAll();
  showToast(t('folderCreatedToast')(name));
}

/* ============================================================
   VIDEO PLAYER MODAL
   ============================================================ */
let ytPlayer = null;
let ytApiReady = false;
let activePlayerLink = null;
let progressSaveInterval = null;
let isVideoLocked = false;
let lockBtnHideTimer = null;

window.onYouTubeIframeAPIReady = function(){
  ytApiReady = true;
  if(activePlayerLink) mountYouTubePlayer(activePlayerLink);
};

(function loadYouTubeIframeAPI(){
  if(window.YT && window.YT.Player){ ytApiReady = true; return; }
  if(document.getElementById('yt-iframe-api-script')) return;
  const tag = document.createElement('script');
  tag.id = 'yt-iframe-api-script';
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
})();

function waitForYouTubeAPI(link){
  if(window.YT && window.YT.Player){
    ytApiReady = true;
    if(activePlayerLink === link) mountYouTubePlayer(link);
    return;
  }
  setTimeout(() => { if(activePlayerLink === link) waitForYouTubeAPI(link); }, 200);
}

function previewUnavailableHtml(){
  return `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;text-align:center;padding:20px;">${t('previewUnavailable')}</div>`;
}

function openPlayerModal(link){
  activePlayerLink = link;
  destroyYtPlayer();
  resetVideoLock();

  const videoId = extractYouTubeId(link.url);
  const wrap = document.getElementById('playerWrap');
  if(videoId){
    wrap.innerHTML = `<div id="ytPlayerEl" style="position:absolute; inset:0; width:100%; height:100%;"></div>`;
    if(ytApiReady && window.YT && YT.Player) mountYouTubePlayer(link);
    else waitForYouTubeAPI(link);
  } else {
    wrap.innerHTML = previewUnavailableHtml();
  }

  document.getElementById('playerTitle').textContent = link.title;
  document.getElementById('playerDomain').innerHTML = `<span class="favicon-dot"></span>${escapeHtml(link.domain)}`;
  playerComposingTags = [...link.tags];
  renderPlayerTagRow();
  document.getElementById('playerNotes').value = link.notes;
  document.getElementById('deleteVideoBtn').onclick = () => { const id = link.id; activePlayerLink = null; deleteLink(id); closePlayerModal(); };
  document.getElementById('timeNoteTime').value = '';
  document.getElementById('timeNoteText').value = '';
  document.getElementById('useCurrentTimeBtn').disabled = !videoId;
  renderTimeNotes(link);
  updateZoomBtnState();
  document.getElementById('playerModalBackdrop').classList.add('show');
}

function mountYouTubePlayer(link){
  const videoId = extractYouTubeId(link.url);
  const el = document.getElementById('ytPlayerEl');
  if(!videoId || !el) return;
  const playerVars = { rel: 0, modestbranding: 1, playsinline: 1 };
  if(link.progress > MIN_PROGRESS_SECONDS) playerVars.start = Math.floor(link.progress);

  ytPlayer = new YT.Player('ytPlayerEl', {
    videoId,
    playerVars,
    events: {
      onReady: startProgressAutosave,
      onStateChange: (e) => {
        if(e.data === YT_PLAYER_STATE_ENDED){
          stopProgressAutosave();
          resetPlaybackProgress();
        }
      },
      onError: () => {
        stopProgressAutosave();
        const wrap = document.getElementById('playerWrap');
        if(wrap) wrap.innerHTML = previewUnavailableHtml();
      }
    }
  });
}

function destroyYtPlayer(){
  stopProgressAutosave();
  if(ytPlayer && typeof ytPlayer.destroy === 'function'){
    try{ ytPlayer.destroy(); }catch(e){ /* no-op */ }
  }
  ytPlayer = null;
}

function closePlayerModal(){
  savePlayerNotes();
  savePlayerTags();
  savePlaybackProgress();
  stopProgressAutosave();
  resetVideoLock();
  if(document.fullscreenElement) document.exitFullscreen();
  document.getElementById('playerModalBackdrop').classList.remove('show');
  destroyYtPlayer();
  document.getElementById('playerWrap').innerHTML = '';
  activePlayerLink = null;
}

/* ---------------- Fullscreen + control lock ---------------- */
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
  const isFullscreen = !!document.fullscreenElement;
  btn.classList.toggle('is-fullscreen', isFullscreen);
  const label = isFullscreen ? t('exitFullscreen') : t('enterFullscreen');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function showLockBtn(){
  const container = document.getElementById('playerVideoContainer');
  container.classList.add('lock-btn-visible');
  clearTimeout(lockBtnHideTimer);
  lockBtnHideTimer = setTimeout(() => container.classList.remove('lock-btn-visible'), LOCK_BUTTON_HIDE_DELAY_MS);
}

function toggleVideoLock(e){
  if(e) e.stopPropagation();
  const container = document.getElementById('playerVideoContainer');
  isVideoLocked = !isVideoLocked;
  container.classList.toggle('controls-locked', isVideoLocked);
  document.getElementById('lockIconOpen').classList.toggle('hidden', isVideoLocked);
  document.getElementById('lockIconClosed').classList.toggle('hidden', !isVideoLocked);

  const lockBtn = document.getElementById('playerLockBtn');
  const label = isVideoLocked ? t('unlockControls') : t('lockControls');
  lockBtn.title = label;
  lockBtn.setAttribute('aria-label', label);
  showLockBtn();
}

function handleLockOverlayTap(){ showLockBtn(); }

function resetVideoLock(){
  const container = document.getElementById('playerVideoContainer');
  isVideoLocked = false;
  container.classList.remove('controls-locked', 'lock-btn-visible');
  clearTimeout(lockBtnHideTimer);
  document.getElementById('lockIconOpen').classList.remove('hidden');
  document.getElementById('lockIconClosed').classList.add('hidden');
}

function handleFullscreenChange(){
  updateZoomBtnState();
  if(!document.fullscreenElement && !document.webkitFullscreenElement) resetVideoLock();
}
document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

/* ---------------- Notes / tags / progress (all local) ---------------- */
function savePlayerNotes(){
  if(!activePlayerLink) return;
  const notes = document.getElementById('playerNotes').value.trim();
  if(activePlayerLink.notes === notes) return;
  activePlayerLink.notes = notes;
  if(saveGuestData()) showToast(t('notesSavedToast'));
}

function renderPlayerTagRow(){
  const row = document.getElementById('playerTagRow');
  const input = document.getElementById('playerTagInput');
  row.querySelectorAll('.tag-pill').forEach(el => el.remove());
  playerComposingTags.forEach(tg => row.insertBefore(createTagPill(tg, removePlayerTag), input));
}

function handlePlayerTagKey(e){
  const input = document.getElementById('playerTagInput');
  if(e.key === 'Enter' || e.key === ','){
    e.preventDefault();
    const value = input.value.trim().replace(/^#/, '');
    if(value && !playerComposingTags.includes(value)){
      playerComposingTags.push(value);
      renderPlayerTagRow();
      savePlayerTags();
    }
    input.value = '';
  } else if(e.key === 'Backspace' && input.value === '' && playerComposingTags.length){
    playerComposingTags.pop();
    renderPlayerTagRow();
    savePlayerTags();
  }
}

function removePlayerTag(tag){
  playerComposingTags = playerComposingTags.filter(x => x !== tag);
  renderPlayerTagRow();
  savePlayerTags();
}

function savePlayerTags(){
  if(!activePlayerLink) return;
  const input = document.getElementById('playerTagInput');
  const pendingTag = input.value.trim().replace(/^#/, '');
  if(pendingTag && !playerComposingTags.includes(pendingTag)){
    playerComposingTags.push(pendingTag);
    input.value = '';
    renderPlayerTagRow();
  }
  activePlayerLink.tags = [...playerComposingTags];
  saveGuestData();
}

function savePlaybackProgress(){
  if(!activePlayerLink || !ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;
  const progress = Math.floor(ytPlayer.getCurrentTime());
  if(!progress || progress < MIN_PROGRESS_SECONDS || activePlayerLink.progress === progress) return;
  activePlayerLink.progress = progress;
  saveGuestData();
}

function startProgressAutosave(){
  stopProgressAutosave();
  progressSaveInterval = setInterval(() => {
    if(ytPlayer && typeof ytPlayer.getPlayerState === 'function' && ytPlayer.getPlayerState() === YT_PLAYER_STATE_PLAYING){
      savePlaybackProgress();
    }
  }, PROGRESS_SAVE_INTERVAL_MS);
}
function stopProgressAutosave(){
  if(progressSaveInterval){ clearInterval(progressSaveInterval); progressSaveInterval = null; }
}

function resetPlaybackProgress(){
  if(!activePlayerLink || !activePlayerLink.progress) return;
  activePlayerLink.progress = 0;
  saveGuestData();
}

/* ---------------- Timestamped notes ---------------- */
function formatTime(totalSeconds){
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(sec).padStart(2, '0');
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
  document.getElementById('timeNoteTime').value = formatTime(ytPlayer.getCurrentTime());
}

function addTimeNote(){
  if(!activePlayerLink) return;
  const seconds = parseTime(document.getElementById('timeNoteTime').value);
  const text = document.getElementById('timeNoteText').value.trim();
  if(seconds === null){ showToast(t('invalidTimeToast')); return; }
  if(!text){ showToast(t('emptyTimeNoteToast')); return; }

  activePlayerLink.timeNotes = [...activePlayerLink.timeNotes, { time: seconds, text }].sort((a, b) => a.time - b.time);
  if(!saveGuestData()) return;
  document.getElementById('timeNoteTime').value = '';
  document.getElementById('timeNoteText').value = '';
  renderTimeNotes(activePlayerLink);
  showToast(t('timeNoteAddedToast'));
}

function deleteTimeNote(index){
  if(!activePlayerLink) return;
  activePlayerLink.timeNotes = activePlayerLink.timeNotes.filter((_, i) => i !== index);
  if(!saveGuestData()) return;
  renderTimeNotes(activePlayerLink);
  showToast(t('timeNoteRemovedToast'));
}

function seekToTime(seconds){
  if(ytPlayer && typeof ytPlayer.seekTo === 'function'){
    ytPlayer.seekTo(seconds, true);
    if(typeof ytPlayer.playVideo === 'function') ytPlayer.playVideo();
  }
}

function renderTimeNotes(link){
  const list = document.getElementById('timeNotesList');
  if(!link.timeNotes.length){
    list.innerHTML = `<p class="hint">${t('noTimeNotesYet')}</p>`;
    return;
  }
  const canSeek = !!ytPlayer;
  list.innerHTML = link.timeNotes.map((n, i) => `
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
function openDetailModal(link){
  const folderObj = folders.find(f => f.id === link.folder);
  currentDetailLinkId = link.id;
  const thumb = document.getElementById('detailThumb');
  thumb.src = thumbFor(link, folderObj);
  thumb.dataset.thumbStep = '0';
  thumb.onerror = function(){
    window.handleThumbError(this, extractYouTubeId(link.url), placeholderThumb(link.title, fallbackHueFor(folderObj)));
  };
  document.getElementById('detailTitle').textContent = link.title;
  document.getElementById('detailDomain').innerHTML = `<span class="favicon-dot"></span>${escapeHtml(link.domain)} · ${folderObj ? escapeHtml(folderObj.name) : ''}`;
  document.getElementById('detailTags').innerHTML = link.tags.map(tg => `<span class="tag">#${escapeHtml(tg)}</span>`).join('') || `<span class="hint">${guestText('noTagsYet')}</span>`;
  document.getElementById('detailNotes').value = link.notes;
  document.getElementById('detailOpenBtn').href = isSafeUrl(link.url) ? link.url : '#';
  document.getElementById('deleteLinkBtn').onclick = () => { currentDetailLinkId = null; deleteLink(link.id); closeDetailModal(); };
  document.getElementById('detailModalBackdrop').classList.add('show');
}

function closeDetailModal(){
  saveDetailNotes();
  document.getElementById('detailModalBackdrop').classList.remove('show');
  currentDetailLinkId = null;
}

function saveDetailNotes(){
  if(!currentDetailLinkId) return;
  const link = links.find(x => x.id === currentDetailLinkId);
  if(!link) return;
  const notes = document.getElementById('detailNotes').value.trim();
  if(link.notes === notes) return;
  link.notes = notes;
  if(saveGuestData()){
    renderLinks();
    showToast(t('notesSavedToast'));
  }
}

function deleteLink(id){
  links = links.filter(x => x.id !== id);
  saveGuestData();
  renderLinks();
  showToast(t('linkRemovedToast'));
}

/* ============================================================
   INIT + i18n
   ============================================================ */
loadGuestData();
ensureDefaultFolder();
repairOrphanLinks();
sortLinksNewestFirst();
renderAll();

setDynamicTranslationHook(() => {
  updateTopbarTitle();
  renderLinks();
  if(activePlayerLink){
    renderTimeNotes(activePlayerLink);
    updateZoomBtnState();
  }
});

/* Functions used by inline HTML handlers (module scope is not global). */
Object.assign(window, {
  toggleTheme, openSidebar, closeSidebar, selectFolder, handleSearch,
  openLinkModal, closeLinkModal, autoFillTitle, handleTagKey, saveLink,
  openFolderModal, closeFolderModal, createFolder,
  toggleVideoZoom, useCurrentTime, addTimeNote, deleteTimeNote, seekToTime,
  closeDetailModal, saveDetailNotes, savePlayerNotes, closePlayerModal,
  handlePlayerTagKey, toggleVideoLock, handleLockOverlayTap,
  closeDeleteFolderModal, confirmDeleteFolder,
});
