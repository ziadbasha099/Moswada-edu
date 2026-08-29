/* ============================================================
   SHARE.JS — loaded only by share.html
   ------------------------------------------------------------
   Public read-only view of a folder someone shared. Anyone can
   watch the videos in-app without an account. A signed-in
   visitor can also copy any of them into their own account —
   filed automatically under a folder named after the shared
   folder (reused if they already have one with that name).
   ============================================================ */
import {
  collection, doc, getDoc, getDocs, addDoc, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth, db, t, showToast, escapeHtml, setDynamicTranslationHook } from "./shared.js";
import { SHARED_FOLDERS_COLLECTION } from "./firebase-config.js";

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
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}
function youTubeThumbUrl(url){
  const id = extractYouTubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
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

function renderGrid(){
  const grid = document.getElementById('shareGrid');
  grid.innerHTML = sharedLinks.map(l => `
    <div class="link-card">
      <div class="thumb" onclick="openPlayerFor('${l.id}')">
        <img src="${l.thumb || youTubeThumbUrl(l.url) || ''}" alt="">
        <div class="play-badge"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg></div>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(l.title)}</div>
        <div class="card-domain"><span class="favicon-dot"></span>${escapeHtml(l.domain)}</div>
        <button class="btn btn-outline btn-sm" style="margin-top:auto;" onclick="addToMyList('${l.id}')">${t('addToMyList')}</button>
      </div>
    </div>`).join('');
}

/* ------------------------------------------------------------
   "ADD ALL" BUTTON — only worth showing once there's more than
   one video to bulk-import; toggled after every load/render.
   ------------------------------------------------------------ */
function updateAddAllVisibility(){
  const row = document.getElementById('addAllRow');
  if(!row) return;
  row.classList.toggle('hidden', sharedLinks.length < 2);
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
   ADD TO MY LIST (single video)
   - Not signed in  → remember this page, send to sign-in, auth.js
                       brings the visitor straight back here after.
   - Signed in      → skip if already saved (matched by URL), else
                       file it under a folder named after the shared
                       folder (created once, then reused).
   ------------------------------------------------------------ */
async function addToMyList(id){
  const l = sharedLinks.find(x => x.id === id);
  if(!l) return;

  if(!currentUser){
    localStorage.setItem('post-login-redirect', location.href);
    location.href = 'index.html';
    return;
  }

  try{
    const existing = await getDocs(query(
      collection(db, 'users', currentUser.uid, 'links'),
      where('url', '==', l.url)
    ));
    if(!existing.empty){
      showToast(t('alreadyInListToast'));
      return;
    }

    const folderId = await getOrCreateImportFolder(folderMeta.name, folderMeta.color);

    await addDoc(collection(db, 'users', currentUser.uid, 'links'), {
      url: l.url, title: l.title, folder: folderId, notes: '', tags: [],
      type: l.type, domain: l.domain, thumb: l.thumb || null,
      timeNotes: [], progress: 0, createdAt: serverTimestamp()
    });
    showToast(t('addedToListToast'));
  }catch(err){
    console.error(err);
  }
}

/* ------------------------------------------------------------
   ADD ALL TO MY LIST (bulk import)
   Same rules as addToMyList, but for the whole shared folder in
   one action:
   - Not signed in → same redirect-back-after-sign-in flow.
   - Fetches the visitor's existing links ONCE (instead of one
     query per video) to skip anything already saved by URL.
   - Files everything new under the same imported folder used by
     the single "Add to my videos" button.
   ------------------------------------------------------------ */
async function addAllToMyList(){
  if(isAddingAll || !sharedLinks.length) return;

  if(!currentUser){
    localStorage.setItem('post-login-redirect', location.href);
    location.href = 'index.html';
    return;
  }

  const btn = document.getElementById('addAllBtn');
  isAddingAll = true;
  if(btn) btn.disabled = true;
  showToast(t('addingAllToast'));

  try{
    const existingSnap = await getDocs(collection(db, 'users', currentUser.uid, 'links'));
    const existingUrls = new Set(existingSnap.docs.map(d => d.data().url));

    const toAdd = sharedLinks.filter(l => !existingUrls.has(l.url));

    if(toAdd.length === 0){
      showToast(t('allAlreadyInListToast'));
      return;
    }

    const folderId = await getOrCreateImportFolder(folderMeta.name, folderMeta.color);

    await Promise.all(toAdd.map(l => addDoc(collection(db, 'users', currentUser.uid, 'links'), {
      url: l.url, title: l.title, folder: folderId, notes: '', tags: [],
      type: l.type, domain: l.domain, thumb: l.thumb || null,
      timeNotes: [], progress: 0, createdAt: serverTimestamp()
    })));

    showToast(t('allAddedToast')(toAdd.length));
  }catch(err){
    console.error(err);
  }finally{
    isAddingAll = false;
    if(btn) btn.disabled = false;
  }
}

async function getOrCreateImportFolder(name, color){
  if(importFolderCache) return importFolderCache;
  const snap = await getDocs(query(
    collection(db, 'users', currentUser.uid, 'folders'),
    where('name', '==', name)
  ));
  if(!snap.empty){
    importFolderCache = snap.docs[0].id;
    return importFolderCache;
  }
  const ref = await addDoc(collection(db, 'users', currentUser.uid, 'folders'), {
    name, color: color || '#226864', createdAt: serverTimestamp()
  });
  importFolderCache = ref.id;
  return importFolderCache;
}

/* ------------------------------------------------------------
   i18n — re-render the grid so dynamic button labels stay
   translated when the language toggle is used
   ------------------------------------------------------------ */
setDynamicTranslationHook(() => {
  if(sharedLinks.length) renderGrid();
});

Object.assign(window, { openPlayerFor, closePlayerModal, toggleVideoZoom, addToMyList, addAllToMyList });

loadSharedFolder();
