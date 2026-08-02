/* ============================================================
   SHARED MODULE
   ------------------------------------------------------------
   Loaded by BOTH index.html (landing + auth) and app.html
   (dashboard). Holds everything both pages need so it lives in
   exactly one place:
     - Firebase app / auth / Firestore instances
     - The i18n dictionary + language switcher
     - The toast helper
     - Small string-escaping utilities
   Page-specific logic (auth forms, folders/links/videos) lives
   in auth.js and dashboard.js instead.
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const fbApp = initializeApp(firebaseConfig);
export const auth = getAuth(fbApp);
export const db = getFirestore(fbApp);
export const googleProvider = new GoogleAuthProvider();

/* ============================================================
   i18n — DYNAMIC TEXT DICTIONARY
   (Static markup text lives in the HTML via data-en/data-ar
   attributes; anything generated in JS is translated from here.)
   ============================================================ */
export let currentLang = 'en';

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
    authAccountExists: 'An account already exists with this email using a different sign-in method.',
    authPopupBlocked: 'Your browser blocked the sign-in popup. Please allow popups and try again.',
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
    authAccountExists: 'يوجد حساب بهذا البريد الإلكتروني بالفعل عبر طريقة تسجيل دخول مختلفة.',
    authPopupBlocked: 'قام المتصفح بحظر نافذة تسجيل الدخول. يرجى السماح بالنوافذ المنبثقة والمحاولة مرة أخرى.',
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
export function t(key){ return I18N[currentLang][key]; }

/* ============================================================
   LANGUAGE SWITCHING
   Each page registers its own "dynamic refresh" callback (things
   that need to be redrawn in JS, like the topbar title or link
   grid on the dashboard, or the auth form copy on the auth page)
   via setDynamicTranslationHook(), since the two pages don't
   share the same dynamic content.
   ============================================================ */
let dynamicTranslationHook = null;
export function setDynamicTranslationHook(fn){ dynamicTranslationHook = fn; }

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

export function setLanguage(lang){
  currentLang = lang;

  const langBtn = document.getElementById('lang-btn');
  const langLabel = langBtn ? langBtn.querySelector('.lang-btn-label') : null;
  if(lang === 'ar'){
    document.documentElement.dir = 'rtl';
    document.documentElement.lang = 'ar';
    if(langLabel) langLabel.textContent = 'English';
  } else {
    document.documentElement.dir = 'ltr';
    document.documentElement.lang = 'en';
    if(langLabel) langLabel.textContent = 'العربية';
  }

  applyStaticTranslations(lang);
  if(dynamicTranslationHook) dynamicTranslationHook();

  localStorage.setItem('preferred-language', lang);
}

// Wires up the language button (present on both pages) and applies
// whichever language the person last chose as soon as the DOM is ready.
document.addEventListener('DOMContentLoaded', () => {
  const langBtn = document.getElementById('lang-btn');
  if(langBtn){
    langBtn.addEventListener('click', () => {
      setLanguage(currentLang === 'en' ? 'ar' : 'en');
    });
  }
  setLanguage(localStorage.getItem('preferred-language') || 'en');
});

/* ============================================================
   TOAST — small bottom-of-screen confirmation message
   ============================================================ */
let toastTimer;
export function showToast(msg){
  const tt = document.getElementById('toast');
  if(!tt) return;
  tt.textContent = msg;
  tt.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => tt.classList.remove('show'), 2400);
}

/* ============================================================
   STRING ESCAPING — every place we build HTML from user-entered
   text (link titles, tags, notes...) runs it through these first
   to prevent markup/script injection.
   ============================================================ */
export function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
export function escapeAttr(str){ return escapeHtml(str).replace(/`/g,'&#96;'); }
