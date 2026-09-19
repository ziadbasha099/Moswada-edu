/* ============================================================
   SHARE.JS — loaded only by share.html
   ------------------------------------------------------------
   Public read-only view of a folder someone shared. Anyone can
   watch the videos in-app without an account. A signed-in
   visitor can also copy any of them into their own account —
   filed automatically under a folder named after the shared
   folder (reused if they already have one with that name).

   Also lets any visitor (signed in or not) report the folder.
   A report is a single Firestore doc keyed by shareId itself
   (see submitReport()) — firestore.rules then blocks read access
   to that sharedFolders/{shareId} doc and its links the instant
   the report exists, with no server code required. An admin
   reviews reports/{shareId} manually in the Firebase console or
   a simple admin page and decides whether to ban the owner.

   Security notes:
   - Everything under sharedFolders/* is written by the folder owner,
     so it is untrusted input. Values are HTML-escaped when rendered,
     and only sanitized fields are copied into a visitor's account
     (see buildImportedLinkData / toSafeFolderColor).
   - Links are created through createLinkWithCounter() so the
     200-link limit in firestore.rules is enforced.
   ============================================================ */
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth, db, t, showToast, escapeHtml, escapeAttr, setDynamicTranslationHook } from "./shared.js";
import {
  MAX_LINKS_PER_USER, ensureLinksCounter, createLinkWithCounter, isLinkLimitError
} from "./links-counter.js";
import { SHARED_FOLDERS_COLLECTION } from "./firebase-config.js";

const REPORTS_COLLECTION = "reports";

const DEFAULT_FOLDER_COLOR = '#226864';
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const shareId = new URLSearchParams(location.search).get('id');

let currentUser = null;
let folderMeta = null;
let sharedLinks = [];
let activePlayerLink = null;
let ytPlayer = null;
let ytApiReady = false;
let importFolderCache = null;
let isAddingAll = false;

onAuthStateChanged(auth, (user) => { currentUser = user; });

/* ------------------------------------------------------------
   YouTube helpers — same extraction logic as dashboard.js
   ------------------------------------------------------------ */
function extractYouTubeId(url){
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}
function youTubeThumbUrl(url){
  const id = extractYouTubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

/**
 * Only http/https URLs are ever used (same rule as dashboard.js).
 * @param {unknown} url
 * @returns {boolean}
 */
function isSafeUrl(url){
  return /^https?:\/\/.+/i.test(String(url || '').trim());
}

/**
 * Picks a thumbnail for a shared link. The YouTube thumbnail is derived
 * from a strictly validated video ID; a stored thumb is used only if it is
 * an http(s) URL. Callers must still escape the result before using it.
 * @param {{url?: string, thumb?: string}} sharedLink
 * @returns {string}
 */
function getThumbnailSrc(sharedLink){
  return youTubeThumbUrl(sharedLink.url) || (isSafeUrl(sharedLink.thumb) ? sharedLink.thumb : '');
}

/* ------------------------------------------------------------
   LOAD SHARED FOLDER
   ------------------------------------------------------------ */
async function loadSharedFolder(){
  const loading = document.getElementById('shareLoading');
  const notFound = document.getElementById('shareNotFound');
  const empty = document.getElementById('shareEmpty');

  if(!shareId){
    loading.classList.add('hidden');
    notFound.classList.remove('hidden');
    return;
  }

  try{
    const folderSnap = await getDoc(doc(db, SHARED_FOLDERS_COLLECTION, shareId));
    if(!folderSnap.exists()){
      // Either the link never existed, the owner stopped sharing it, OR
      // it was just reported — firestore.rules denies read access to a
      // reported sharedFolders/{shareId} doc, so this same "not found"
      // branch is what a reported link falls into too. That's fine: we
      // don't want visitors to be able to tell the difference.
      loading.classList.add('hidden');
      notFound.classList.remove('hidden');
      return;
    }
    folderMeta = folderSnap.data();
    document.getElementById('shareTitle').textContent = folderMeta.name;
    document.title = `${folderMeta.name} — Moswada`;

    const linksSnap = await getDocs(collection(db, SHARED_FOLDERS_COLLECTION, shareId, 'links'));
    sharedLinks = linksSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    loading.classList.add('hidden');
    document.getElementById('reportBtn').classList.remove('hidden');
    if(sharedLinks.length === 0){
      empty.classList.remove('hidden');
      updateAddAllVisibility();
      return;
    }
    renderGrid();
    updateAddAllVisibility();
  }catch(err){
    console.error(err);
    loading.classList.add('hidden');
    notFound.classList.remove('hidden');
  }
}

/**
 * Renders the shared videos. Link IDs are chosen by the folder owner, so they
 * are never put inside inline onclick="..." code (HTML-escaping cannot make a
 * value safe inside a JS string). They go in data-* attributes and are read by
 * the delegated click handler below.
 */
function renderGrid(){
  const grid = document.getElementById('shareGrid');
  grid.innerHTML = sharedLinks.map(l => `
    <div class="link-card">
      <div class="thumb" data-action="play" data-link-id="${escapeAttr(l.id)}">
        <img src="${escapeAttr(getThumbnailSrc(l))}" alt="">
        <div class="play-badge"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg></div>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(l.title)}</div>
        <div class="card-domain"><span class="favicon-dot"></span>${escapeHtml(l.domain)}</div>
        <button class="btn btn-outline btn-sm" style="margin-top:auto;" data-action="add" data-link-id="${escapeAttr(l.id)}">${t('addToMyList')}</button>
      </div>
    </div>`).join('');
}

/** Single click listener for every card (play / add), see renderGrid(). */
function handleGridClick(event){
  const actionElement = event.target.closest('[data-action]');
  if(!actionElement) return;
  const linkId = actionElement.dataset.linkId;
  if(actionElement.dataset.action === 'play') openPlayerFor(linkId);
  else if(actionElement.dataset.action === 'add') addToMyList(linkId);
}
document.getElementById('shareGrid').addEventListener('click', handleGridClick);

/* ------------------------------------------------------------
   "ADD ALL" BUTTON — only worth showing once there's more than
   one video to bulk-import; toggled after every load/render.
   ------------------------------------------------------------ */
function updateAddAllVisibility(){
  const btn = document.getElementById('addAllBtn');
  if(!btn) return;
  btn.classList.toggle('hidden', sharedLinks.length < 2);
}

/* ------------------------------------------------------------
   PLAYER MODAL — same YT IFrame API pattern as dashboard.js,
   trimmed down since there's nothing private to edit here.
   ------------------------------------------------------------ */
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

function openPlayerFor(id){
  const l = sharedLinks.find(x => x.id === id);
  if(!l) return;
  activePlayerLink = l;

  const vid = extractYouTubeId(l.url);
  const wrap = document.getElementById('playerWrap');
  if(vid){
    wrap.innerHTML = `<div id="ytPlayerEl" style="position:absolute; inset:0; width:100%; height:100%;"></div>`;
    if(ytApiReady && window.YT && YT.Player){ mountYouTubePlayer(l); }
  } else {
    wrap.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;">${t('previewUnavailable')}</div>`;
  }

  document.getElementById('playerTitle').textContent = l.title;
  document.getElementById('playerDomain').innerHTML = `<span class="favicon-dot"></span>${escapeHtml(l.domain)}`;
  document.getElementById('playerAddBtn').onclick = () => addToMyList(l.id);
  document.getElementById('playerModalBackdrop').classList.add('show');
}

function mountYouTubePlayer(l){
  const vid = extractYouTubeId(l.url);
  const el = document.getElementById('ytPlayerEl');
  if(!vid || !el) return;
  ytPlayer = new YT.Player('ytPlayerEl', { videoId: vid, playerVars: { rel: 0, modestbranding: 1, playsinline: 1 } });
}
function destroyYtPlayer(){
  if(ytPlayer && typeof ytPlayer.destroy === 'function'){
    try{ ytPlayer.destroy(); }catch(e){ /* no-op */ }
  }
  ytPlayer = null;
}
function closePlayerModal(){
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

/* ------------------------------------------------------------
   IMPORT HELPERS
   ------------------------------------------------------------ */

/**
 * Sends anonymous visitors to sign-in and remembers this page so auth.js
 * brings them straight back after logging in.
 * @returns {boolean} true if the visitor was redirected.
 */
function redirectToSignInIfAnonymous(){
  if(currentUser) return false;
  localStorage.setItem('post-login-redirect', location.href);
  location.href = 'index.html';
  return true;
}

/**
 * Folder colors are later injected into a style="" attribute by the
 * dashboard, so anything that is not a plain #rrggbb value is dropped.
 * @param {unknown} color
 * @returns {string}
 */
function toSafeFolderColor(color){
  return HEX_COLOR_PATTERN.test(String(color || '')) ? color : DEFAULT_FOLDER_COLOR;
}

/**
 * Builds the document saved in the visitor's own account from an untrusted
 * shared link. Only known-safe shapes are copied; thumb is left empty because
 * the dashboard derives YouTube thumbnails itself.
 * @param {object} sharedLink
 * @param {string} folderId
 * @returns {object}
 */
function buildImportedLinkData(sharedLink, folderId){
  return {
    url: sharedLink.url,
    title: String(sharedLink.title || ''),
    folder: folderId,
    notes: '',
    tags: [],
    type: sharedLink.type === 'video' ? 'video' : 'article',
    domain: String(sharedLink.domain || ''),
    thumb: null,
    timeNotes: [],
    progress: 0
  };
}

/** Logs the error and shows the limit message or a generic one. */
function showImportError(error){
  console.error('Import failed:', error);
  showToast(isLinkLimitError(error) ? t('linkLimitReachedToast') : t('authGeneric'));
}

/**
 * Imports links ONE AT A TIME. Each link needs its own transaction because
 * firestore.rules only accepts a +1 change of users/{uid}.linksCount per commit.
 * @param {string} uid
 * @param {object[]} linksToImport
 * @param {string} folderId
 * @returns {Promise<number>} How many links were created.
 */
async function importLinksSequentially(uid, linksToImport, folderId){
  let importedCount = 0;
  for(const sharedLink of linksToImport){
    await createLinkWithCounter(uid, buildImportedLinkData(sharedLink, folderId));
    importedCount++;
  }
  return importedCount;
}

/* ------------------------------------------------------------
   ADD TO MY LIST (single video)
   - Not signed in  → remember this page, send to sign-in, auth.js
                       brings the visitor straight back here after.
   - Signed in      → skip if already saved (matched by URL), else
                       file it under a folder named after the shared
                       folder (created once, then reused).
   ------------------------------------------------------------ */
async function addToMyList(id){
  const sharedLink = sharedLinks.find(x => x.id === id);
  if(!sharedLink) return;
  if(redirectToSignInIfAnonymous()) return;
  if(!isSafeUrl(sharedLink.url)){ showToast(t('authGeneric')); return; }

  try{
    const uid = currentUser.uid;
    const existing = await getDocs(query(
      collection(db, 'users', uid, 'links'),
      where('url', '==', sharedLink.url)
    ));
    if(!existing.empty){
      showToast(t('alreadyInListToast'));
      return;
    }

    await ensureLinksCounter(uid);
    const folderId = await getOrCreateImportFolder(folderMeta.name, folderMeta.color);
    await createLinkWithCounter(uid, buildImportedLinkData(sharedLink, folderId));
    showToast(t('addedToListToast'));
  }catch(err){
    showImportError(err);
  }
}

/* ------------------------------------------------------------
   ADD ALL TO MY LIST (bulk import)
   Same rules as addToMyList, but for the whole shared folder in
   one action:
   - Not signed in → same redirect-back-after-sign-in flow.
   - Fetches the visitor's existing links ONCE (instead of one
     query per video) to skip anything already saved by URL.
   - Stops at the 200-link limit instead of failing half-way.
   - Files everything new under the same imported folder used by
     the single "Add to my videos" button.
   ------------------------------------------------------------ */
async function addAllToMyList(){
  if(isAddingAll || !sharedLinks.length) return;
  if(redirectToSignInIfAnonymous()) return;

  const btn = document.getElementById('addAllBtn');
  isAddingAll = true;
  if(btn) btn.disabled = true;
  showToast(t('addingAllToast'));

  try{
    const uid = currentUser.uid;
    await ensureLinksCounter(uid);
    const existingSnap = await getDocs(collection(db, 'users', uid, 'links'));
    const existingUrls = new Set(existingSnap.docs.map(d => d.data().url));

    const newLinks = sharedLinks.filter(l => isSafeUrl(l.url) && !existingUrls.has(l.url));
    if(newLinks.length === 0){
      showToast(t('allAlreadyInListToast'));
      return;
    }

    const remainingSlots = Math.max(0, MAX_LINKS_PER_USER - existingSnap.size);
    const linksToImport = newLinks.slice(0, remainingSlots);
    if(linksToImport.length === 0){
      showToast(t('linkLimitReachedToast'));
      return;
    }

    const folderId = await getOrCreateImportFolder(folderMeta.name, folderMeta.color);
    const importedCount = await importLinksSequentially(uid, linksToImport, folderId);
    const wasTruncated = linksToImport.length < newLinks.length;
    showToast(wasTruncated ? t('linkLimitReachedToast') : t('allAddedToast')(importedCount));
  }catch(err){
    showImportError(err);
  }finally{
    isAddingAll = false;
    if(btn) btn.disabled = false;
  }
}

async function getOrCreateImportFolder(name, color){
  if(importFolderCache) return importFolderCache;
  const folderName = String(name || '');
  const snap = await getDocs(query(
    collection(db, 'users', currentUser.uid, 'folders'),
    where('name', '==', folderName)
  ));
  if(!snap.empty){
    importFolderCache = snap.docs[0].id;
    return importFolderCache;
  }
  const ref = await addDoc(collection(db, 'users', currentUser.uid, 'folders'), {
    name: folderName, color: toSafeFolderColor(color), createdAt: serverTimestamp()
  });
  importFolderCache = ref.id;
  return importFolderCache;
}

/* ------------------------------------------------------------
   REPORT CONTENT
   ------------------------------------------------------------
   Writes reports/{shareId} (doc ID = the shareId itself, not an
   auto ID). That's what lets firestore.rules block reads on
   sharedFolders/{shareId} the instant this doc exists — no
   server-side code needed. It also means a second report on the
   same shareId is a Firestore "update" rather than "create",
   which the rules reject — so this naturally caps it at one
   report per folder and we surface that as a friendly message
   instead of a raw permission error.
   ------------------------------------------------------------ */
function openReportModal(){
  if(!folderMeta) return;
  document.getElementById('reportError').classList.add('hidden');
  document.getElementById('reportModalBackdrop').classList.add('show');
}
function closeReportModal(){
  document.getElementById('reportModalBackdrop').classList.remove('show');
}

async function submitReport(){
  if(!shareId || !folderMeta) return;
  const btn = document.getElementById('confirmReportBtn');
  const errEl = document.getElementById('reportError');
  errEl.classList.add('hidden');
  btn.disabled = true;

  try{
    await setDoc(doc(db, REPORTS_COLLECTION, shareId), {
      shareId,
      folderId: folderMeta.folderId || null,
      ownerUid: folderMeta.ownerUid,
      folderName: folderMeta.name || '',
      status: 'pending',
      createdAt: serverTimestamp()
    });
    showToast(t('reportSubmittedToast'));
    closeReportModal();
  }catch(err){
    if(err.code === 'permission-denied'){
      // Most likely: this folder was already reported once before.
      errEl.textContent = t('reportAlreadySubmittedToast');
      errEl.classList.remove('hidden');
    } else {
      console.error(err);
    }
  }finally{
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------
   i18n — re-render the grid so dynamic button labels stay
   translated when the language toggle is used
   ------------------------------------------------------------ */
setDynamicTranslationHook(() => {
  if(sharedLinks.length) renderGrid();
});

// Only handlers referenced by inline onclick="..." in share.html.
// (openPlayerFor / addToMyList are now reached via handleGridClick.)
Object.assign(window, {
  closePlayerModal, toggleVideoZoom, addAllToMyList,
  openReportModal, closeReportModal, submitReport,
});

loadSharedFolder();
