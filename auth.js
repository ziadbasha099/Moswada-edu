/* ============================================================
   AUTH.JS — loaded only by index.html (landing + sign-in/sign-up)
   ------------------------------------------------------------
   The dashboard itself lives entirely in app.html/dashboard.js.
   This file's only job is to get someone signed in, then hand
   off to app.html. It never touches folders/links.
   ============================================================ */
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, updateProfile, signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth, googleProvider, t, setDynamicTranslationHook } from "./shared.js";

/* ------------------------------------------------------------
   ROUTE GUARD — if Firebase already has a signed-in session
   (returning visitor, or just finished signing in), send them
   straight to the dashboard instead of showing the landing page.
   ------------------------------------------------------------ */
onAuthStateChanged(auth, (user) => {
  if(user){
    window.location.href = 'app.html';
  }
});

function mapAuthError(code){
  switch(code){
    case 'auth/email-already-in-use': return t('authEmailInUse');
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found': return t('authBadCreds');
    case 'auth/too-many-requests': return t('authTooMany');
    case 'auth/weak-password': return t('authWeakPassword');
    case 'auth/account-exists-with-different-credential':
      return t('authAccountExists');
    case 'auth/popup-blocked': return t('authPopupBlocked');
    default: return t('authGeneric');
  }
}

/* ============================================================
   LANDING <-> AUTH VIEW TRANSITIONS
   ============================================================ */
let authMode = 'signin';

function showAuth(mode){
  document.getElementById('landing').classList.add('hidden');
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

/* ============================================================
   EMAIL / PASSWORD SIGN-IN & SIGN-UP
   ============================================================ */
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
    // The onAuthStateChanged() route guard above redirects to app.html automatically.
  } catch(err){
    console.error(err);
    showAuthError(mapAuthError(err.code));
  } finally {
    submitBtn.disabled = false;
  }
}

/* ------------------------------------------------------------
   GOOGLE SIGN-IN via popup. Works for both sign-in and sign-up —
   Firebase creates the user automatically on first sign-in.
   ------------------------------------------------------------ */
async function handleGoogleSignIn(){
  hideAuthError();
  try{
    await signInWithPopup(auth, googleProvider);
    // Redirect handled by the route guard above once Firebase confirms the session.
  } catch(err){
    // The user closing the popup themselves isn't a real error.
    if(err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request'){
      return;
    }
    console.error(err);
    showAuthError(mapAuthError(err.code));
  }
}

/* ============================================================
   i18n — re-render whatever this page generates dynamically
   (auth form copy) whenever the language is switched
   ============================================================ */
setDynamicTranslationHook(() => {
  if(!document.getElementById('auth').classList.contains('hidden')){
    switchAuthMode(authMode);
  }
});

/* ============================================================
   Expose functions used as inline HTML event handlers (onclick=...)
   Required because this file is loaded as an ES module — module
   scope is not global scope, so inline handlers can't see these
   otherwise.
   ============================================================ */
Object.assign(window, {
  showAuth, backToLanding, switchAuthMode, handleAuthSubmit, handleGoogleSignIn,
});
