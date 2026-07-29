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
  getFirestore, collection, addDoc, deleteDoc, doc, onSnapshot,
  query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, DOWNLOADS_COLLECTION } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
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
}
applyStaticText();

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
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    console.error(err);
    loginError.textContent = t("invalidLogin");
    loginError.classList.remove("hidden");
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (user) {
    loginView.classList.add("hidden");
    dashView.classList.remove("hidden");
    listenDownloads();
  } else {
    dashView.classList.add("hidden");
    loginView.classList.remove("hidden");
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
      <div class="meta">
        <div class="t">${escapeHtml(i.title)}</div>
        <div class="f">${escapeHtml(i.folder || "")}</div>
      </div>
      <button data-id="${i.id}" title="${t("removeTitle")}" aria-label="${t("removeTitle")}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>`).join("");
  list.querySelectorAll("button[data-id]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await deleteDoc(doc(db, DOWNLOADS_COLLECTION, btn.getAttribute("data-id")));
      showToast(t("removed"));
    });
  });
}

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
  if (!/^https?:\/\/(www\.)?mediafire\.com\//i.test(url)) return showAddError(t("onlyMediafire"));

  await addDoc(collection(db, DOWNLOADS_COLLECTION), {
    title, url, folder, createdAt: serverTimestamp()
  });

  document.getElementById("addForm").reset();
  toggleNewFolderInput();
  showToast(t("added"));
});

function showAddError(msg){
  addError.textContent = msg;
  addError.classList.remove("hidden");
}
