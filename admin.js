/* ============================================================
   MOSWADA — Admin page
   Real password protection via Firebase Authentication (not a
   client-side password check). Only a signed-in admin user can
   write to Firestore — enforce that with these security rules
   in the Firebase console (Firestore → Rules):

   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /downloads/{docId} {
         allow read: if true;
         allow write: if request.auth != null;
       }
     }
   }

   Create the admin's login (email + password) once, manually,
   in Firebase console → Authentication → Users → Add user.
   See README-Firebase-Setup.md for the full walkthrough.
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot,
  query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js";
import { firebaseConfig, DOWNLOADS_COLLECTION, RECAPTCHA_V3_SITE_KEY, ADMIN_EMAIL } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);

/* App Check (reCAPTCHA v3) — نفس الحماية المستخدمة في shared.js.
   لوحة الأدمن أهم صفحة على الإطلاق لتفعيل الحماية دي عليها، لأنها
   البوابة الوحيدة اللي بتكتب على مجموعة downloads العامة. راجع
   التعليق في firebase-config.js لخطوات التفعيل من الـ Console. */
if (RECAPTCHA_V3_SITE_KEY && !RECAPTCHA_V3_SITE_KEY.startsWith("PASTE_")) {
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(RECAPTCHA_V3_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (err) {
    console.error("App Check init failed:", err);
  }
}

const auth = getAuth(app);
const db = getFirestore(app);

const lang = localStorage.getItem("preferred-language") || "en";
const I18N = {
  en: {
    loginTitle: "Admin sign in", loginSub: "Sign in with the admin account to manage download links.",
    email: "Email", password: "Password", signIn: "Sign in",
    invalidLogin: "Incorrect email or password.",
    dashTitle: "Manage downloads", signOut: "Sign out",
    addTitle: "Add a download", addSub: "Give it a title and paste the MediaFire link — it appears on the downloads page instantly.",
    fileTitle: "File title", folder: "Folder", newFolder: "+ New folder", url: "MediaFire link",
    urlHint: "Only MediaFire links are accepted.", addBtn: "Add download",
    onlyMediafire: "Please paste a valid MediaFire link (mediafire.com).",
    missingTitle: "Give the file a title.", missingFolder: "Name the new folder, or pick an existing one.",
    added: "Download added", removed: "Download removed", removeTitle: "Remove",
    icon: "Icon", color: "Color",
    editTitle: "Edit", saveChanges: "Save changes", cancel: "Cancel",
    updated: "Download updated", editHeading: "Edit a download",
  },
  ar: {
    loginTitle: "تسجيل دخول المدير", loginSub: "سجّل الدخول بحساب المدير لإدارة روابط التحميل.",
    email: "البريد الإلكتروني", password: "كلمة المرور", signIn: "تسجيل الدخول",
    invalidLogin: "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
    dashTitle: "إدارة التنزيلات", signOut: "تسجيل الخروج",
    addTitle: "إضافة تنزيل", addSub: "أدخل عنواناً والصق رابط MediaFire — سيظهر في صفحة التنزيلات فوراً.",
    fileTitle: "عنوان الملف", folder: "المجلد", newFolder: "+ مجلد جديد", url: "رابط MediaFire",
    urlHint: "تُقبل روابط MediaFire فقط.", addBtn: "إضافة التنزيل",
    onlyMediafire: "الرجاء لصق رابط MediaFire صحيح (mediafire.com).",
    missingTitle: "أعطِ الملف عنواناً.", missingFolder: "سمِّ المجلد الجديد، أو اختر مجلداً موجوداً.",
    added: "تمت إضافة التنزيل", removed: "تمت إزالة التنزيل", removeTitle: "إزالة",
    icon: "الأيقونة", color: "اللون",
    editTitle: "تعديل", saveChanges: "حفظ التعديلات", cancel: "إلغاء",
    updated: "تم تحديث التنزيل", editHeading: "تعديل تنزيل",
  }
};
function t(k){ return I18N[lang][k]; }

function applyStaticText(){
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.getElementById("loginTitle").textContent = t("loginTitle");
  document.getElementById("loginSub").textContent = t("loginSub");
  document.getElementById("emailLabel").textContent = t("email");
  document.getElementById("passLabel").textContent = t("password");
  document.getElementById("loginBtn").textContent = t("signIn");
  document.getElementById("dashTitle").textContent = t("dashTitle");
  document.getElementById("logoutBtn").textContent = t("signOut");
  document.getElementById("addTitle").textContent = t("addTitle");
  document.getElementById("addSub").textContent = t("addSub");
  document.getElementById("fileTitleLabel").textContent = t("fileTitle");
  document.getElementById("folderLabel").textContent = t("folder");
  document.getElementById("newFolderOption").textContent = t("newFolder");
  document.getElementById("urlLabel").textContent = t("url");
  document.getElementById("urlHint").textContent = t("urlHint");
  document.getElementById("addBtn").textContent = t("addBtn");
  document.getElementById("iconLabel").textContent = t("icon");
  document.getElementById("colorLabel").textContent = t("color");
  document.getElementById("cancelEditBtn").textContent = t("cancel");
}
applyStaticText();

/* ---------------- Icon / color catalogue ---------------- */
const ICON_SVGS = {
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.07 0l2.83-2.83a5 5 0 10-7.07-7.07L11.5 4.5"/><path d="M14 11a5 5 0 00-7.07 0L4.1 13.83a5 5 0 107.07 7.07l1.4-1.4"/></svg>`,
  mindmap: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M8.2 7l7.6 3.8M8.2 17l7.6-3.8"/></svg>`,
};
const VALID_ICONS = ["file", "link", "mindmap"];
const VALID_COLORS = ["green", "blue", "yellow"];
function iconMarkup(type){ return ICON_SVGS[VALID_ICONS.includes(type) ? type : "file"]; }
function colorClass(color){ return `icon-color-${VALID_COLORS.includes(color) ? color : "green"}`; }

let selectedIcon = "file";
let selectedColor = "green";
let editingId = null;

function setActiveIcon(val){
  selectedIcon = VALID_ICONS.includes(val) ? val : "file";
  document.querySelectorAll("#iconPicker .icon-opt").forEach(b => b.classList.toggle("active", b.dataset.icon === selectedIcon));
}
function setActiveColor(val){
  selectedColor = VALID_COLORS.includes(val) ? val : "green";
  document.querySelectorAll("#colorPicker .color-opt").forEach(b => b.classList.toggle("active", b.dataset.color === selectedColor));
}
document.querySelectorAll("#iconPicker .icon-opt").forEach(btn => {
  btn.addEventListener("click", () => setActiveIcon(btn.dataset.icon));
});
document.querySelectorAll("#colorPicker .color-opt").forEach(btn => {
  btn.addEventListener("click", () => setActiveColor(btn.dataset.color));
});
setActiveIcon(selectedIcon);
setActiveColor(selectedColor);

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

let toastTimer;
function showToast(msg){
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

/* ---------------- Auth ---------------- */
const loginView = document.getElementById("loginView");
const dashView = document.getElementById("dashView");
const loginError = document.getElementById("loginError");

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.classList.add("hidden");
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    /* التحقق الحقيقي من عدم تسريب البيانات لغير الأدمن بيتم في
       Firestore rules (write مرفوض لغير هذا البريد). لكن من غير
       هذا الفحص هنا، أي حساب عادي في الموقع كان هيقدر "يسجّل
       دخول" هنا ويشوف واجهة لوحة الأدمن (القائمة، الأزرار...)
       حتى لو مش هيقدر يحفظ حاجة فعلياً. الفحص ده بيمنع الدخول
       من الأساس. */
    if (cred.user.email !== ADMIN_EMAIL) {
      await signOut(auth);
      loginError.textContent = t("invalidLogin");
      loginError.classList.remove("hidden");
    }
  } catch (err) {
    console.error(err);
    loginError.textContent = t("invalidLogin");
    loginError.classList.remove("hidden");
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (user && user.email === ADMIN_EMAIL) {
    loginView.classList.add("hidden");
    dashView.classList.remove("hidden");
    listenDownloads();
  } else {
    dashView.classList.add("hidden");
    loginView.classList.remove("hidden");
    // حساب مسجّل دخول لكنه مش الأدمن (مثلاً لو دخل عبر تبويب تاني
    // بحساب عادي، أو الجلسة قديمة) — نسجّل خروجه تلقائياً بدل ما
    // نسيبه معلّق على شاشة تسجيل الدخول وهو فعلياً "مسجّل دخول".
    if (user && user.email !== ADMIN_EMAIL) {
      signOut(auth);
    }
  }
});

/* ---------------- Data ---------------- */
let items = [];

function listenDownloads(){
  const q = query(collection(db, DOWNLOADS_COLLECTION), orderBy("createdAt", "desc"));
  onSnapshot(q, (snap) => {
    items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFolderOptions();
    renderList();
  });
}

function renderFolderOptions(){
  const select = document.getElementById("folderSelect");
  const current = select.value;
  const folders = [...new Set(items.map(i => i.folder).filter(Boolean))].sort();
  select.innerHTML = `<option value="__new__">${t("newFolder")}</option>` +
    folders.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");
  if ([...select.options].some(o => o.value === current)) select.value = current;
  toggleNewFolderInput();
}
document.getElementById("folderSelect").addEventListener("change", toggleNewFolderInput);
function toggleNewFolderInput(){
  const select = document.getElementById("folderSelect");
  const input = document.getElementById("newFolderInput");
  input.style.display = select.value === "__new__" ? "block" : "none";
}

function renderList(){
  const list = document.getElementById("list");
  list.innerHTML = items.map(i => `
    <div class="admin-row">
      <div class="icon-preview ${colorClass(i.color)}">${iconMarkup(i.icon)}</div>
      <div class="meta">
        <div class="t">${escapeHtml(i.title)}</div>
        <div class="f">${escapeHtml(i.folder || "")}</div>
      </div>
      <button class="edit-btn" data-id="${i.id}" title="${t("editTitle")}" aria-label="${t("editTitle")}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
      </button>
      <button data-id="${i.id}" title="${t("removeTitle")}" aria-label="${t("removeTitle")}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>`).join("");
  list.querySelectorAll("button.edit-btn").forEach(btn => {
    btn.addEventListener("click", () => enterEditMode(btn.getAttribute("data-id")));
  });
  list.querySelectorAll("button[data-id]:not(.edit-btn)").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      if(id === editingId) exitEditMode();
      await deleteDoc(doc(db, DOWNLOADS_COLLECTION, id));
      showToast(t("removed"));
    });
  });
}

/* ---------------- Edit an existing download ---------------- */
function enterEditMode(id){
  const item = items.find(i => i.id === id);
  if(!item) return;
  editingId = id;

  document.getElementById("fileTitle").value = item.title || "";
  document.getElementById("fileUrl").value = item.url || "";

  const select = document.getElementById("folderSelect");
  if([...select.options].some(o => o.value === item.folder)){
    select.value = item.folder;
  } else {
    select.value = "__new__";
    document.getElementById("newFolderInput").value = item.folder || "";
  }
  toggleNewFolderInput();

  setActiveIcon(item.icon);
  setActiveColor(item.color);

  document.getElementById("addTitle").textContent = t("editHeading");
  document.getElementById("addBtn").textContent = t("saveChanges");
  document.getElementById("cancelEditBtn").classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function exitEditMode(){
  editingId = null;
  document.getElementById("addTitle").textContent = t("addTitle");
  document.getElementById("addBtn").textContent = t("addBtn");
  document.getElementById("cancelEditBtn").classList.add("hidden");
  document.getElementById("addForm").reset();
  toggleNewFolderInput();
  setActiveIcon("file");
  setActiveColor("green");
}
document.getElementById("cancelEditBtn").addEventListener("click", exitEditMode);

/* ---------------- Add download ---------------- */
const addError = document.getElementById("addError");
document.getElementById("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  addError.classList.add("hidden");

  const title = document.getElementById("fileTitle").value.trim();
  const url = document.getElementById("fileUrl").value.trim();
  const select = document.getElementById("folderSelect");
  let folder = select.value === "__new__"
    ? document.getElementById("newFolderInput").value.trim()
    : select.value;

  if (!title) return showAddError(t("missingTitle"));
  if (!folder) return showAddError(t("missingFolder"));
 /* if (!/^https?:\/\/(www\.)?mediafire\.com\//i.test(url)) return showAddError(t("onlyMediafire")); */
  if (!/^https?:\/\/.+/i.test(url)) return showAddError(t("onlyMediafire"));

  const data = { title, url, folder, icon: selectedIcon, color: selectedColor };

  if (editingId) {
    await updateDoc(doc(db, DOWNLOADS_COLLECTION, editingId), data);
    showToast(t("updated"));
    exitEditMode();
  } else {
    await addDoc(collection(db, DOWNLOADS_COLLECTION), { ...data, createdAt: serverTimestamp() });
    document.getElementById("addForm").reset();
    toggleNewFolderInput();
    setActiveIcon("file");
    setActiveColor("green");
    showToast(t("added"));
  }
});

function showAddError(msg){
  addError.textContent = msg;
  addError.classList.remove("hidden");
}
