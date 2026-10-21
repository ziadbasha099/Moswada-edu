/* ============================================================
   MOSWADA — Admin page (downloads + download folders)
   ------------------------------------------------------------
   Real password protection via Firebase Authentication. The check
   in this file only decides which UI to show; the actual protection
   is the Firestore rules (isAdmin() on downloads/downloadFolders).
   All validation/sanitising lives in download-kinds.js (tested).

   Create the admin's login (email + password) once, manually, in
   Firebase console → Authentication → Users → Add user.
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, addDoc, updateDoc, setDoc, deleteDoc, doc, onSnapshot,
  query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js";
import { firebaseConfig, DOWNLOADS_COLLECTION, RECAPTCHA_V3_SITE_KEY, ADMIN_EMAIL } from "./firebase-config.js";
import {
  DOWNLOAD_KINDS, KIND_KEYS, FOLDER_COLORS, FOLDER_COLOR_KEYS,
  slugify, validateDownloadForm, buildDownloadFields, validateFolderForm
} from "./download-kinds.js";

const DOWNLOAD_FOLDERS_COLLECTION = "downloadFolders";
const TOAST_DURATION_MS = 2200;
const DEFAULT_FOLDER_COLOR = FOLDER_COLOR_KEYS[0];
const FALLBACK_KIND_KEY = KIND_KEYS[0];

const app = initializeApp(firebaseConfig);

/* App Check (reCAPTCHA v3) — same protection used in shared.js. See the
   comment in firebase-config.js for the Console steps. */
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

/* ---------------- Language ---------------- */
const lang = localStorage.getItem("preferred-language") === "ar" ? "ar" : "en";
const I18N = {
  en: {
    loginTitle: "Admin sign in", loginSub: "Sign in with the admin account to manage download links.",
    email: "Email", password: "Password", signIn: "Sign in",
    invalidLogin: "Incorrect email or password.",
    manageReports: "Manage reports", dashTitle: "Manage downloads", signOut: "Sign out",
    tabItems: "Downloads", tabFolders: "Folders",
    addTitle: "Add a download", editHeading: "Edit a download",
    addSub: "Fill in the details — it appears on the downloads page.",
    fileTitle: "File title", folder: "Folder", kind: "Type", chooseFolder: "Choose a folder…",
    kindHint: "Website shows a \"Visit site\" button; every other type shows \"Download\".",
    slug: "Page address (slug)", slugHint: "English letters, numbers and dashes only. Changing it later changes the page URL.",
    description: "Description", descHint: "One or two sentences: what it is, what it covers, who it helps.",
    tags: "Tags", tagsHint: "Separate with commas. Up to 8 tags.",
    url: "Link", urlHint: "Any http(s) link (Mega, Google Drive, a website...).",
    addBtn: "Add download", saveChanges: "Save changes", cancel: "Cancel", saving: "Saving…",
    added: "Download added", updated: "Download updated", removed: "Download removed",
    editTitle: "Edit", removeTitle: "Remove", confirmRemove: "Remove this download permanently?",
    folderSub: "Each folder has its own color and appears as a card on the downloads page.",
    addFolderTitle: "Add a folder", editFolderTitle: "Edit a folder",
    folderName: "Folder name", folderSlugHint: "Cannot be changed after the folder is created.",
    color: "Color", order: "Order", keywords: "Search keywords",
    keywordsHint: "Phrases students search for, separated by commas. Up to 10.",
    addFolderBtn: "Add folder", folderAdded: "Folder added", folderUpdated: "Folder updated",
    folderRemoved: "Folder removed", confirmRemoveFolder: "Remove this folder?",
    folderNotEmpty: "This folder still has downloads. Move or remove them first.",
    itemsCount: "downloads", noFolder: "(no folder)",
    saveFailed: "Could not save. Check your connection and try again.",
    removeFailed: "Could not remove. Try again.",
    errors: {
      title: "Give the file a title.", titleTooLong: "The title is too long (120 characters max).",
      folder: "Choose a folder.", kind: "Choose a type.",
      slug: "The slug must use English letters, numbers and single dashes (e.g. physics-summary).",
      slugTaken: "This slug is already used. Choose another one.",
      description: "Write a short description.", descriptionTooLong: "The description is too long (400 characters max).",
      tagsTooMany: "Use 8 tags at most.", tagTooLong: "A tag is too long (30 characters max).",
      url: "Paste a valid http(s) link.",
      folderName: "Give the folder a name.", folderNameTooLong: "The folder name is too long (60 characters max).",
      color: "Choose a color.", order: "Order must be a whole number from 1 to 999.",
      keywordsTooMany: "Use 10 keywords at most.", keywordTooLong: "A keyword is too long (60 characters max).",
    },
  },
  ar: {
    loginTitle: "تسجيل دخول المدير", loginSub: "سجّل الدخول بحساب المدير لإدارة روابط التحميل.",
    email: "البريد الإلكتروني", password: "كلمة المرور", signIn: "تسجيل الدخول",
    invalidLogin: "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
    manageReports: "إدارة البلاغات", dashTitle: "إدارة التنزيلات", signOut: "تسجيل الخروج",
    tabItems: "التنزيلات", tabFolders: "المجلدات",
    addTitle: "إضافة تنزيل", editHeading: "تعديل تنزيل",
    addSub: "املأ البيانات وسيظهر التنزيل في صفحة التنزيلات.",
    fileTitle: "عنوان الملف", folder: "المجلد", kind: "النوع", chooseFolder: "اختر مجلداً…",
    kindHint: "نوع «موقع» يعرض زر «عرض الموقع»، وبقية الأنواع تعرض زر «تحميل».",
    slug: "عنوان الصفحة (slug)", slugHint: "حروف إنجليزية وأرقام وشرطات فقط. تغييره لاحقاً يغيّر رابط الصفحة.",
    description: "الوصف", descHint: "جملة أو جملتان: ما هو، ماذا يغطي، ولمن يفيد.",
    tags: "الوسوم", tagsHint: "افصل بينها بفواصل. حتى 8 وسوم.",
    url: "الرابط", urlHint: "أي رابط http(s) (Mega أو Google Drive أو موقع...).",
    addBtn: "إضافة التنزيل", saveChanges: "حفظ التعديلات", cancel: "إلغاء", saving: "جارٍ الحفظ…",
    added: "تمت إضافة التنزيل", updated: "تم تحديث التنزيل", removed: "تمت إزالة التنزيل",
    editTitle: "تعديل", removeTitle: "إزالة", confirmRemove: "هل تريد إزالة هذا التنزيل نهائياً؟",
    folderSub: "لكل مجلد لونه الخاص، ويظهر كبطاقة في صفحة التنزيلات.",
    addFolderTitle: "إضافة مجلد", editFolderTitle: "تعديل مجلد",
    folderName: "اسم المجلد", folderSlugHint: "لا يمكن تغييره بعد إنشاء المجلد.",
    color: "اللون", order: "الترتيب", keywords: "كلمات البحث",
    keywordsHint: "عبارات يبحث بها الطلاب، تفصل بينها فواصل. حتى 10 كلمات.",
    addFolderBtn: "إضافة المجلد", folderAdded: "تمت إضافة المجلد", folderUpdated: "تم تحديث المجلد",
    folderRemoved: "تمت إزالة المجلد", confirmRemoveFolder: "هل تريد إزالة هذا المجلد؟",
    folderNotEmpty: "ما زال في هذا المجلد تنزيلات. انقلها أو أزلها أولاً.",
    itemsCount: "تنزيل", noFolder: "(بدون مجلد)",
    saveFailed: "تعذّر الحفظ. تحقق من الاتصال وحاول مرة أخرى.",
    removeFailed: "تعذّرت الإزالة. حاول مرة أخرى.",
    errors: {
      title: "أعطِ الملف عنواناً.", titleTooLong: "العنوان طويل (120 حرفاً كحد أقصى).",
      folder: "اختر مجلداً.", kind: "اختر النوع.",
      slug: "يجب أن يتكون الـ slug من حروف إنجليزية وأرقام وشرطات مفردة (مثل physics-summary).",
      slugTaken: "هذا الـ slug مستخدم. اختر غيره.",
      description: "اكتب وصفاً قصيراً.", descriptionTooLong: "الوصف طويل (400 حرف كحد أقصى).",
      tagsTooMany: "الحد الأقصى 8 وسوم.", tagTooLong: "أحد الوسوم طويل (30 حرفاً كحد أقصى).",
      url: "الصق رابطاً صحيحاً يبدأ بـ http أو https.",
      folderName: "أعطِ المجلد اسماً.", folderNameTooLong: "اسم المجلد طويل (60 حرفاً كحد أقصى).",
      color: "اختر لوناً.", order: "الترتيب رقم صحيح من 1 إلى 999.",
      keywordsTooMany: "الحد الأقصى 10 كلمات.", keywordTooLong: "إحدى الكلمات طويلة (60 حرفاً كحد أقصى).",
    },
  },
};

/** @param {string} key @returns {string} */
function t(key) { return I18N[lang][key] ?? key; }
/** @param {string[]} codes @returns {string} Messages joined, one per line. */
function errorText(codes) { return codes.map((code) => I18N[lang].errors[code] ?? code).join("\n"); }

/* ---------------- Small DOM helpers ---------------- */
/** @param {string} id @returns {HTMLElement} */
function byId(id) { return document.getElementById(id); }

/** @param {unknown} str @returns {string} HTML-escaped text. */
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

let toastTimer;
/** @param {string} message */
function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), TOAST_DURATION_MS);
}

/** Shows (or clears, when message is empty) an error box. */
function setError(element, message) {
  element.textContent = message || "";
  element.style.whiteSpace = "pre-line";
  element.classList.toggle("hidden", !message);
}

/** Applies all translations to elements marked with data-i18n. */
function applyStaticText() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
}
applyStaticText();

/* ---------------- State ---------------- */
let items = [];
let folders = [];
let editingItemId = null;
let editingFolderSlug = null;
let selectedFolderColor = DEFAULT_FOLDER_COLOR;
let isSlugEditedByHand = false;
let listenersStarted = false;

/* ---------------- Auth ---------------- */
const loginView = byId("loginView");
const dashView = byId("dashView");
const loginError = byId("loginError");

byId("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError(loginError, "");
  const email = byId("email").value.trim();
  const password = byId("password").value;
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    /* The real protection is the Firestore rules. This check only stops a
       regular account from seeing the admin UI. */
    if (credential.user.email !== ADMIN_EMAIL) {
      await signOut(auth);
      setError(loginError, t("invalidLogin"));
    }
  } catch (err) {
    console.error("Admin sign-in failed:", err.code || err.message);
    setError(loginError, t("invalidLogin"));
  }
});

byId("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (user && user.email === ADMIN_EMAIL) {
    loginView.classList.add("hidden");
    dashView.classList.remove("hidden");
    startListeners();
  } else {
    dashView.classList.add("hidden");
    loginView.classList.remove("hidden");
    // Signed in but not the admin (stale session, another tab): sign out.
    if (user) signOut(auth);
  }
});

/* ---------------- Tabs ---------------- */
/** @param {"items" | "folders"} name */
function showTab(name) {
  const isItems = name === "items";
  byId("panelItems").classList.toggle("hidden", !isItems);
  byId("panelFolders").classList.toggle("hidden", isItems);
  byId("tabItemsBtn").classList.toggle("active", isItems);
  byId("tabFoldersBtn").classList.toggle("active", !isItems);
}
byId("tabItemsBtn").addEventListener("click", () => showTab("items"));
byId("tabFoldersBtn").addEventListener("click", () => showTab("folders"));

/* ---------------- Live data ---------------- */
/** Subscribes once to both collections (auth changes must not duplicate listeners). */
function startListeners() {
  if (listenersStarted) return;
  listenersStarted = true;
  const onListenError = (err) => {
    listenersStarted = false;
    console.error("Firestore listener failed:", err.code || err.message);
    showToast(t("saveFailed"));
  };

  onSnapshot(query(collection(db, DOWNLOAD_FOLDERS_COLLECTION), orderBy("order", "asc")), (snapshot) => {
    folders = snapshot.docs.map((d) => ({ slug: d.id, ...d.data() }));
    renderFolderSelect();
    renderFolderList();
    renderItemList();
    if (!editingFolderSlug) byId("folderOrder").value ||= String(nextFolderOrder());
  }, onListenError);

  onSnapshot(query(collection(db, DOWNLOADS_COLLECTION), orderBy("createdAt", "desc")), (snapshot) => {
    items = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderFolderList();
    renderItemList();
  }, onListenError);
}

/** @returns {number} The next free folder order (max + 1). */
function nextFolderOrder() {
  return folders.reduce((max, folder) => Math.max(max, Number(folder.order) || 0), 0) + 1;
}

/** @param {string} folderId @returns {string} */
function folderName(folderId) {
  return folders.find((folder) => folder.slug === folderId)?.name ?? t("noFolder");
}

/* ---------------- Downloads: form ---------------- */
const addError = byId("addError");

/** Fills the kind <select> once (labels follow the page language). */
function renderKindSelect() {
  byId("kindSelect").innerHTML = KIND_KEYS
    .map((key) => `<option value="${key}">${escapeHtml(DOWNLOAD_KINDS[key][lang])}</option>`).join("");
}
renderKindSelect();

/** Rebuilds the folder <select>, keeping the current choice when possible. */
function renderFolderSelect() {
  const select = byId("folderSelect");
  const current = select.value;
  select.innerHTML = `<option value="">${escapeHtml(t("chooseFolder"))}</option>` +
    folders.map((folder) => `<option value="${escapeHtml(folder.slug)}">${escapeHtml(folder.name)}</option>`).join("");
  if (folders.some((folder) => folder.slug === current)) select.value = current;
}

byId("fileTitle").addEventListener("input", () => {
  if (!isSlugEditedByHand && !editingItemId) byId("slugInput").value = slugify(byId("fileTitle").value);
});
byId("slugInput").addEventListener("input", () => { isSlugEditedByHand = true; });

/** Puts the form back to "add" mode. */
function resetItemForm() {
  editingItemId = null;
  isSlugEditedByHand = false;
  byId("addForm").reset();
  byId("addTitle").textContent = t("addTitle");
  byId("addBtn").textContent = t("addBtn");
  byId("cancelEditBtn").classList.add("hidden");
  setError(addError, "");
}
byId("cancelEditBtn").addEventListener("click", resetItemForm);

/** Loads an existing download into the form. @param {string} id */
function enterItemEditMode(id) {
  const item = items.find((entry) => entry.id === id);
  if (!item) return;
  editingItemId = id;
  isSlugEditedByHand = true;
  byId("fileTitle").value = item.title || "";
  byId("folderSelect").value = item.folderId || "";
  byId("kindSelect").value = KIND_KEYS.includes(item.kind) ? item.kind : FALLBACK_KIND_KEY;
  byId("slugInput").value = item.slug || "";
  byId("descInput").value = item.description || "";
  byId("tagsInput").value = Array.isArray(item.tags) ? item.tags.join(", ") : "";
  byId("fileUrl").value = item.url || "";
  byId("addTitle").textContent = t("editHeading");
  byId("addBtn").textContent = t("saveChanges");
  byId("cancelEditBtn").classList.remove("hidden");
  setError(addError, "");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/** @returns {Parameters<typeof validateDownloadForm>[0]} Raw values from the form. */
function readItemForm() {
  return {
    title: byId("fileTitle").value,
    url: byId("fileUrl").value,
    folderId: byId("folderSelect").value,
    kind: byId("kindSelect").value,
    slug: byId("slugInput").value,
    description: byId("descInput").value,
    tagsText: byId("tagsInput").value,
  };
}

/** Writes (create or update) one download. @param {ReturnType<typeof validateDownloadForm>['data']} data */
async function saveDownload(data) {
  const existing = items.find((entry) => entry.id === editingItemId);
  const fields = buildDownloadFields(data, {
    folderName: folderName(data.folderId),
    legacyFolderName: items.find((entry) => entry.folderId === data.folderId && entry.folder)?.folder,
    existingColor: existing?.color,
  });
  if (existing) {
    await updateDoc(doc(db, DOWNLOADS_COLLECTION, existing.id), { ...fields, updatedAt: serverTimestamp() });
  } else {
    await addDoc(collection(db, DOWNLOADS_COLLECTION), { ...fields, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  }
}

byId("addForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const { errors, data } = validateDownloadForm(readItemForm(), {
    folderIds: new Set(folders.map((folder) => folder.slug)),
    takenSlugs: new Set(items.filter((entry) => entry.id !== editingItemId).map((entry) => entry.slug).filter(Boolean)),
  });
  if (errors.length) return setError(addError, errorText(errors));

  const button = byId("addBtn");
  const wasEditing = Boolean(editingItemId);
  button.disabled = true;
  try {
    await saveDownload(data);
    resetItemForm();
    showToast(t(wasEditing ? "updated" : "added"));
  } catch (err) {
    console.error("Saving download failed:", err.code || err.message);
    setError(addError, t("saveFailed"));
  } finally {
    button.disabled = false;
  }
});

/* ---------------- Downloads: list ---------------- */
function renderItemList() {
  const list = byId("list");
  list.innerHTML = items.map((item) => {
    const color = FOLDER_COLORS[folders.find((folder) => folder.slug === item.folderId)?.color] ?? "var(--line)";
    const kindLabel = DOWNLOAD_KINDS[item.kind]?.[lang] ?? "—";
    return `
    <div class="admin-row">
      <span class="dot-preview" style="background:${color}"></span>
      <div class="meta">
        <div class="t">${escapeHtml(item.title)}</div>
        <div class="f">${escapeHtml(item.folderId ? folderName(item.folderId) : item.folder || t("noFolder"))}</div>
      </div>
      <span class="kind-chip">${escapeHtml(kindLabel)}</span>
      <button class="edit-btn" data-action="edit" data-id="${escapeHtml(item.id)}" title="${t("editTitle")}" aria-label="${t("editTitle")}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
      </button>
      <button data-action="remove" data-id="${escapeHtml(item.id)}" title="${t("removeTitle")}" aria-label="${t("removeTitle")}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
  }).join("");
}

byId("list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "edit") return enterItemEditMode(id);
  if (!window.confirm(t("confirmRemove"))) return;
  try {
    if (id === editingItemId) resetItemForm();
    await deleteDoc(doc(db, DOWNLOADS_COLLECTION, id));
    showToast(t("removed"));
  } catch (err) {
    console.error("Removing download failed:", err.code || err.message);
    showToast(t("removeFailed"));
  }
});

/* ---------------- Folders: form ---------------- */
const folderError = byId("folderError");

/** Draws the 8 color swatches. */
function renderColorPicker() {
  const picker = byId("folderColorPicker");
  picker.innerHTML = "";
  FOLDER_COLOR_KEYS.forEach((key) => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "color-opt" + (key === selectedFolderColor ? " active" : "");
    swatch.style.background = FOLDER_COLORS[key];
    swatch.title = key;
    swatch.setAttribute("aria-label", key);
    swatch.addEventListener("click", () => { selectedFolderColor = key; renderColorPicker(); });
    picker.appendChild(swatch);
  });
}
renderColorPicker();

/** Puts the folder form back to "add" mode. */
function resetFolderForm() {
  editingFolderSlug = null;
  selectedFolderColor = DEFAULT_FOLDER_COLOR;
  byId("folderForm").reset();
  byId("folderSlug").disabled = false;
  byId("folderOrder").value = String(nextFolderOrder());
  byId("folderFormTitle").textContent = t("addFolderTitle");
  byId("folderSaveBtn").textContent = t("addFolderBtn");
  byId("folderCancelBtn").classList.add("hidden");
  setError(folderError, "");
  renderColorPicker();
}
byId("folderCancelBtn").addEventListener("click", resetFolderForm);

/** Loads an existing folder into the form. @param {string} slug */
function enterFolderEditMode(slug) {
  const folder = folders.find((entry) => entry.slug === slug);
  if (!folder) return;
  editingFolderSlug = slug;
  selectedFolderColor = FOLDER_COLOR_KEYS.includes(folder.color) ? folder.color : DEFAULT_FOLDER_COLOR;
  byId("folderName").value = folder.name || "";
  byId("folderSlug").value = folder.slug;
  byId("folderSlug").disabled = true;
  byId("folderOrder").value = String(folder.order ?? nextFolderOrder());
  byId("folderDesc").value = folder.description || "";
  byId("folderKeywords").value = Array.isArray(folder.keywords) ? folder.keywords.join(", ") : "";
  byId("folderFormTitle").textContent = t("editFolderTitle");
  byId("folderSaveBtn").textContent = t("saveChanges");
  byId("folderCancelBtn").classList.remove("hidden");
  setError(folderError, "");
  renderColorPicker();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

byId("folderForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const isEdit = Boolean(editingFolderSlug);
  const { errors, data } = validateFolderForm({
    name: byId("folderName").value,
    slug: isEdit ? editingFolderSlug : byId("folderSlug").value,
    color: selectedFolderColor,
    order: byId("folderOrder").value,
    description: byId("folderDesc").value,
    keywordsText: byId("folderKeywords").value,
  }, { takenSlugs: new Set(folders.map((folder) => folder.slug)), isEdit });
  if (errors.length) return setError(folderError, errorText(errors));

  const button = byId("folderSaveBtn");
  button.disabled = true;
  try {
    await setDoc(doc(db, DOWNLOAD_FOLDERS_COLLECTION, data.slug), { ...data, updatedAt: serverTimestamp() }, { merge: true });
    resetFolderForm();
    showToast(t(isEdit ? "folderUpdated" : "folderAdded"));
  } catch (err) {
    console.error("Saving folder failed:", err.code || err.message);
    setError(folderError, t("saveFailed"));
  } finally {
    button.disabled = false;
  }
});

/* ---------------- Folders: list ---------------- */
function renderFolderList() {
  byId("folderList").innerHTML = folders.map((folder) => {
    const count = items.filter((item) => item.folderId === folder.slug).length;
    return `
    <div class="admin-row">
      <span class="dot-preview" style="background:${FOLDER_COLORS[folder.color] ?? "var(--line)"}"></span>
      <div class="meta">
        <div class="t">${escapeHtml(folder.name)}</div>
        <div class="f">${count} ${t("itemsCount")} · ${escapeHtml(folder.slug)}</div>
      </div>
      <button class="edit-btn" data-action="edit" data-slug="${escapeHtml(folder.slug)}" title="${t("editTitle")}" aria-label="${t("editTitle")}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
      </button>
      <button data-action="remove" data-slug="${escapeHtml(folder.slug)}" title="${t("removeTitle")}" aria-label="${t("removeTitle")}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
  }).join("");
}

byId("folderList").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, slug } = button.dataset;
  if (action === "edit") return enterFolderEditMode(slug);
  if (items.some((item) => item.folderId === slug)) return showToast(t("folderNotEmpty"));
  if (!window.confirm(t("confirmRemoveFolder"))) return;
  try {
    if (slug === editingFolderSlug) resetFolderForm();
    await deleteDoc(doc(db, DOWNLOAD_FOLDERS_COLLECTION, slug));
    showToast(t("folderRemoved"));
  } catch (err) {
    console.error("Removing folder failed:", err.code || err.message);
    showToast(t("removeFailed"));
  }
});

/* Initial button labels that depend on the add/edit mode. */
byId("addTitle").textContent = t("addTitle");
byId("addBtn").textContent = t("addBtn");
byId("folderFormTitle").textContent = t("addFolderTitle");
byId("folderSaveBtn").textContent = t("addFolderBtn");
