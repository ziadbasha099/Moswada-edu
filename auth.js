/* ============================================================
   AUTH.JS — loaded only by index.html (landing + sign-in/sign-up)
   ------------------------------------------------------------
   The dashboard itself lives entirely in app.html/dashboard.js.
   This file's only job is to get someone signed in, then hand
   off to app.html. It never touches folders/links.
   ============================================================ */
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, updateProfile, signInWithPopup,
  sendPasswordResetEmail, sendEmailVerification
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth, googleProvider, t, setDynamicTranslationHook } from "./shared.js";

/* ------------------------------------------------------------
   ROUTE GUARD — if Firebase already has a signed-in session
   (returning visitor, or just finished signing in), send them
   straight to the dashboard instead of showing the landing page.
   ------------------------------------------------------------ */
onAuthStateChanged(auth, (user) => {
  if(user){
    const redirect = localStorage.getItem('post-login-redirect');
    if(redirect){
      localStorage.removeItem('post-login-redirect');
      window.location.href = redirect;
    } else {
      window.location.href = 'app.html';
    }
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
  document.getElementById('forgotPasswordRow').classList.toggle('hidden', isSignUp);
   
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

  const errEl = document.getElementById('authError');
  errEl.textContent = msg;
  // اجعل كلاس النجاح يظهر فقط إذا كانت الرسالة هي رسالة نجاح إعادة تعيين كلمة المرور:
  errEl.classList.toggle('is-success', msg === t('resetEmailSent'));
  errEl.classList.remove('hidden');
 
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
      try{
        await sendEmailVerification(cred.user);
      }catch(verifyErr){
        // Account creation still succeeds even if the verification email
        // fails to send — the user can request it again from the
        // verification-gate screen inside app.html.
        console.error('sendEmailVerification failed:', verifyErr);
      }
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
   FORGOT PASSWORD — sends a Firebase password-reset email to
   whatever address is currently typed in the sign-in form.
   Deliberately shows the same success message whether or not an
   account exists for that email (prevents account enumeration —
   a real security concern, not just UX polish).
   ------------------------------------------------------------ */
async function handleForgotPassword(){
  hideAuthError();
  const email = document.getElementById('authEmail').value.trim();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if(!emailPattern.test(email)){
    showAuthError(t('resetEmailPrompt'));
    return;
  }

  const link = document.querySelector('#forgotPasswordRow .forgot-password-link');
  const originalText = link.textContent;
  link.disabled = true;
  link.textContent = t('resetEmailSending');

  try{
    await sendPasswordResetEmail(auth, email);
  } catch(err){
    // auth/user-not-found is intentionally treated the same as success
    // so the response never reveals whether the email is registered.
    if(err.code !== 'auth/user-not-found'){
      console.error(err);
      showAuthError(mapAuthError(err.code));
      link.disabled = false;
      link.textContent = originalText;
      return;
    }
  }

  link.disabled = false;
  link.textContent = originalText;
  showAuthError(t('resetEmailSent')); 
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
  showAuth, backToLanding, switchAuthMode, handleAuthSubmit, handleGoogleSignIn, handleForgotPassword,
});
