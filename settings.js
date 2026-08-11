/* ============================================================
   SETTINGS.JS — loaded only by settings.html
   ------------------------------------------------------------
   Account-level actions live here: name, theme, sign out, and
   permanently deleting the account. Folder/link management
   stays on app.html / dashboard.js.
   ============================================================ */
import {
  onAuthStateChanged, signOut, updateProfile, deleteUser
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, getDocs, deleteDoc, doc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  auth, db, t, showToast, setDynamicTranslationHook, getStoredTheme, setTheme,
  setLanguage, currentLang
} from "./shared.js";

let currentUser = null;

/* ------------------------------------------------------------
   ROUTE GUARD — settings are only for signed-in users.
   ------------------------------------------------------------ */
onAuthStateChanged(auth, (user) => {
  if(user){
    currentUser = user;
    document.getElementById('stName').value = user.displayName || '';
    document.getElementById('stEmail').value = user.email || '';
    document.getElementById('settingsPage').classList.remove('hidden');
  } else {
    window.location.href = 'index.html';
  }
});

/* ============================================================
   PROFILE — update display name (email changes require
   re-authentication, so that field stays read-only here and
   points people to Contact us instead)
   ============================================================ */
document.getElementById('saveProfileBtn').addEventListener('click', async () => {
  if(!currentUser) return;
  const name = document.getElementById('stName').value.trim();
  if(!name){ showToast(t('nameRequiredToast')); return; }

  const btn = document.getElementById('saveProfileBtn');
  btn.disabled = true;
  try{
    await updateProfile(currentUser, { displayName: name });
    showToast(t('profileUpdatedToast'));
  }catch(err){
    console.error(err);
    showToast(t('authGeneric'));
  }finally{
    btn.disabled = false;
  }
});

/* ============================================================
   APPEARANCE — light / dark / system, persisted via shared.js
   so it stays in sync with the dashboard's own theme switch
   ============================================================ */
function renderThemeOptions(){
  const active = getStoredTheme();
  document.querySelectorAll('#themeOptions .theme-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeChoice === active);
  });
}
document.querySelectorAll('#themeOptions .theme-option').forEach(btn => {
  btn.addEventListener('click', () => {
    setTheme(btn.dataset.themeChoice);
    renderThemeOptions();
  });
});
renderThemeOptions();

/* ============================================================
   LANGUAGE — English / العربية, shared with the topbar toggle
   ============================================================ */
function renderLangOptions(){
  document.querySelectorAll('#langOptions .theme-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.langChoice === currentLang);
  });
}
document.querySelectorAll('#langOptions .theme-option').forEach(btn => {
  btn.addEventListener('click', () => setLanguage(btn.dataset.langChoice));
});
renderLangOptions();

/* ============================================================
   SIGN OUT — the route guard above redirects to index.html
   automatically once Firebase confirms the session ended.
   ============================================================ */
document.getElementById('signOutBtn').addEventListener('click', async () => {
  try{
    await signOut(auth);
  }catch(err){
    console.error(err);
  }
});

/* ============================================================
   DELETE ACCOUNT — removes every folder/link the user owns,
   then deletes the Firebase Auth user itself. Firestore has no
   automatic cascade delete, so the user's data is cleared first
   to avoid leaving orphaned documents behind.
   ============================================================ */
function openDeleteModal(){
  document.getElementById('deleteError').classList.add('hidden');
  document.getElementById('deleteModalBackdrop').classList.add('show');
}
function closeDeleteModal(){
  document.getElementById('deleteModalBackdrop').classList.remove('show');
}
document.getElementById('deleteAccountBtn').addEventListener('click', openDeleteModal);

async function deleteAllUserData(uid){
  const subcollections = ['links', 'folders'];
  for(const name of subcollections){
    const snap = await getDocs(collection(db, 'users', uid, name));
    await Promise.all(snap.docs.map(d => deleteDoc(doc(db, 'users', uid, name, d.id))));
  }
}

document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
  if(!currentUser) return;
  const btn = document.getElementById('confirmDeleteBtn');
  const errEl = document.getElementById('deleteError');
  errEl.classList.add('hidden');
  btn.disabled = true;

  try{
    await deleteAllUserData(currentUser.uid);
    await deleteUser(currentUser);
    // onAuthStateChanged() above redirects to index.html once Firebase
    // confirms the account is gone.
  }catch(err){
    console.error(err);
    btn.disabled = false;
    errEl.textContent = err.code === 'auth/requires-recent-login'
      ? t('requiresRecentLoginToast')
      : t('authGeneric');
    errEl.classList.remove('hidden');
  }
});

/* ============================================================
   i18n — re-render whatever this page generates dynamically
   whenever the language is switched
   ============================================================ */
setDynamicTranslationHook(() => {
  renderThemeOptions();
  renderLangOptions();
});

/* ============================================================
   Expose functions used as inline HTML event handlers (onclick=...)
   ============================================================ */
Object.assign(window, { closeDeleteModal });
