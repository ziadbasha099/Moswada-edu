/* ============================================================
   ADMIN-REPORTS.JS — loaded only by admin-reports.html
   ------------------------------------------------------------
   Lets the admin review reported shared folders and permanently
   ban the accounts behind them. Two independent lists:
     - reports/{shareId}      → pending reports awaiting review
     - bannedUsers/{uid}      → accounts currently banned

   Real access control for both collections lives in
   firestore.rules (only ADMIN_EMAIL may read/write reports and
   write bannedUsers) — the ADMIN_EMAIL check below is a friendly
   client-side gate, not the security boundary itself. See the
   note in firestore.rules about keeping that check in sync with
   ADMIN_EMAIL in firebase-config.js.

   Banning writes bannedUsers/{uid}. The owner's UID is stored in every
   report (share.js), whereas the email cannot be looked up from a UID
   with the browser SDK. Enforcement lives in auth.js (isUserBanned() on
   sign-in) and in firestore.rules (isBanned() on every users/{uid} write);
   this page only creates/removes that one document.
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, deleteDoc, onSnapshot, writeBatch,
  query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js";
import { firebaseConfig, RECAPTCHA_V3_SITE_KEY, ADMIN_EMAIL } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);

/* App Check (reCAPTCHA v3) — same protection used on admin.html. */
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

const REPORTS_COLLECTION = "reports";
const BANNED_COLLECTION = "bannedUsers";
const REPORT_STATUS_PENDING = "pending";
const REPORT_STATUS_BANNED = "banned";
const OWNER_UID_PREVIEW_LENGTH = 8;

/* ---------------- i18n ---------------- */
const lang = localStorage.getItem("preferred-language") || "en";
const I18N = {
  en: {
    loginTitle: "Admin sign in", loginSub: "Sign in with the admin account to review reports.",
    email: "Email", password: "Password", signIn: "Sign in",
    invalidLogin: "Incorrect email or password.",
    dashTitle: "Reports & bans", signOut: "Sign out", backToDownloads: "Manage downloads",
    pendingTitle: "Pending reports",
    pendingSub: "Folders flagged by visitors. Banning an owner blocks their whole account immediately; dismissing restores the folder without banning anyone.",
    noPending: "No pending reports right now.",
    bannedTitle: "Banned accounts",
    bannedSub: "These accounts can no longer sign in or use the app.",
    noBanned: "No banned accounts yet.",
    banBtn: "Ban owner", dismissBtn: "Dismiss report", unbanBtn: "Unban",
    unknownOwner: "Unknown owner (report has no owner ID — can't be banned from here)",
    confirmBanBody: owner => `This blocks ${owner} from signing in or using Moswada, effective immediately. You can undo it with "Unban".`,
    bannedToast: "Account banned",
    unbannedToast: "Account unbanned",
    dismissedToast: "Report dismissed",
    genericError: "Something went wrong. Please try again.",
    reportedOn: "Reported", bannedOn: "Banned", folderLabel: "Folder", ownerLabel: "Owner",
  },
  ar: {
    loginTitle: "تسجيل دخول المدير", loginSub: "سجّل الدخول بحساب المدير لمراجعة البلاغات.",
    email: "البريد الإلكتروني", password: "كلمة المرور", signIn: "تسجيل الدخول",
    invalidLogin: "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
    dashTitle: "البلاغات والحظر", signOut: "تسجيل الخروج", backToDownloads: "إدارة التنزيلات",
    pendingTitle: "البلاغات قيد المراجعة",
    pendingSub: "مجلدات أبلغ عنها الزوار. حظر المالك يوقف حسابه بالكامل فوراً، بينما تجاهل البلاغ يعيد إظهار المجلد دون حظر أحد.",
    noPending: "لا توجد بلاغات قيد المراجعة حالياً.",
    bannedTitle: "الحسابات المحظورة",
    bannedSub: "لم يعد بإمكان هذه الحسابات تسجيل الدخول أو استخدام التطبيق.",
    noBanned: "لا توجد حسابات محظورة بعد.",
    banBtn: "حظر المالك", dismissBtn: "تجاهل البلاغ", unbanBtn: "إلغاء الحظر",
    unknownOwner: "مالك غير معروف (البلاغ بلا معرّف مالك — لا يمكن حظره من هنا)",
    confirmBanBody: owner => `سيؤدي هذا إلى منع ${owner} من تسجيل الدخول أو استخدام مسودة فوراً. يمكنك التراجع لاحقاً بـ"إلغاء الحظر".`,
    bannedToast: "تم حظر الحساب",
    unbannedToast: "تم إلغاء حظر الحساب",
    dismissedToast: "تم تجاهل البلاغ",
    genericError: "حدث خطأ ما. حاول مرة أخرى.",
    reportedOn: "تاريخ البلاغ", bannedOn: "تاريخ الحظر", folderLabel: "المجلد", ownerLabel: "المالك",
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
  document.getElementById("backToDownloadsLink").textContent = t("backToDownloads");
  document.getElementById("pendingTitle").textContent = t("pendingTitle");
  document.getElementById("pendingSub").textContent = t("pendingSub");
  document.getElementById("noReports").textContent = t("noPending");
  document.getElementById("bannedTitle").textContent = t("bannedTitle");
  document.getElementById("bannedSub").textContent = t("bannedSub");
  document.getElementById("noBanned").textContent = t("noBanned");
}
applyStaticText();

/* ---------------- Utilities ---------------- */
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

function formatDate(ts){
  if(!ts || typeof ts.toDate !== "function") return "—";
  try{
    return ts.toDate().toLocaleDateString(lang === "ar" ? "ar-EG" : "en-US", { year: "numeric", month: "short", day: "numeric" });
  }catch(err){ return "—"; }
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
    // Same backstop as admin.js: firestore.rules is the real enforcement,
    // this just avoids showing the dashboard UI to a non-admin account.
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

let unsubReports = null;
let unsubBanned = null;

onAuthStateChanged(auth, (user) => {
  if (user && user.email === ADMIN_EMAIL) {
    loginView.classList.add("hidden");
    dashView.classList.remove("hidden");
    listenReports();
    listenBanned();
  } else {
    dashView.classList.add("hidden");
    loginView.classList.remove("hidden");
    if (unsubReports) { unsubReports(); unsubReports = null; }
    if (unsubBanned) { unsubBanned(); unsubBanned = null; }
    if (user && user.email !== ADMIN_EMAIL) {
      signOut(auth);
    }
  }
});

/* ---------------- Pending reports ---------------- */
let reports = [];

function listenReports(){
  const q = query(collection(db, REPORTS_COLLECTION), orderBy("createdAt", "desc"));
  unsubReports = onSnapshot(q, (snap) => {
    reports = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderReports();
  }, err => console.error("reports listener:", err));
}

/**
 * Returns a readable owner label for a report: the email when present
 * (older reports), otherwise a shortened UID.
 * @param {{ownerEmail?: string, ownerUid?: string}} report
 * @returns {string}
 */
function describeOwner(report){
  if(report.ownerEmail) return report.ownerEmail;
  if(report.ownerUid) return `UID ${report.ownerUid.slice(0, OWNER_UID_PREVIEW_LENGTH)}…`;
  return t("unknownOwner");
}

/** Renders only reports still awaiting a decision (banned ones are hidden). */
function renderReports(){
  const list = document.getElementById("reportsList");
  const empty = document.getElementById("noReports");
  const pendingReports = reports.filter(r => (r.status || REPORT_STATUS_PENDING) === REPORT_STATUS_PENDING);

  if(!pendingReports.length){
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  list.innerHTML = pendingReports.map(r => `
    <div class="admin-row report-row">
      <div class="meta">
        <div class="t">${escapeHtml(r.folderName || r.id)}</div>
        <div class="f">${t("ownerLabel")}: ${escapeHtml(describeOwner(r))} · ${t("reportedOn")}: ${formatDate(r.createdAt)}</div>
      </div>
      <button type="button" class="admin-btn secondary small" data-action="dismiss" data-share-id="${escapeHtml(r.id)}">${t("dismissBtn")}</button>
      <button type="button" class="admin-btn danger small" data-action="ban"
        data-share-id="${escapeHtml(r.id)}"
        data-owner-uid="${escapeHtml(r.ownerUid || '')}"
        data-owner-label="${escapeHtml(describeOwner(r))}"
        data-folder-name="${escapeHtml(r.folderName || '')}"
        ${r.ownerUid ? '' : 'disabled'}>${t("banBtn")}</button>
    </div>`).join("");

  list.querySelectorAll('[data-action="dismiss"]').forEach(btn => {
    btn.addEventListener("click", () => openDismissModal(btn.getAttribute("data-share-id")));
  });
  list.querySelectorAll('[data-action="ban"]').forEach(btn => {
    btn.addEventListener("click", () => openBanModal(
      btn.getAttribute("data-share-id"),
      btn.getAttribute("data-owner-uid"),
      btn.getAttribute("data-owner-label"),
      btn.getAttribute("data-folder-name")
    ));
  });
}

/* ---------------- Banned accounts ---------------- */
let bannedAccounts = [];

function listenBanned(){
  const q = query(collection(db, BANNED_COLLECTION), orderBy("bannedAt", "desc"));
  unsubBanned = onSnapshot(q, (snap) => {
    bannedAccounts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderBanned();
  }, err => console.error("banned listener:", err));
}

/** Renders banned accounts; each document ID is the banned user's UID. */
function renderBanned(){
  const list = document.getElementById("bannedList");
  const empty = document.getElementById("noBanned");
  if(!bannedAccounts.length){
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  list.innerHTML = bannedAccounts.map(b => `
    <div class="admin-row report-row">
      <div class="meta">
        <div class="t">${escapeHtml(b.id)}</div>
        <div class="f">${b.folderName ? `${t("folderLabel")}: ${escapeHtml(b.folderName)} · ` : ''}${t("bannedOn")}: ${formatDate(b.bannedAt)}</div>
      </div>
      <button type="button" class="admin-btn secondary small" data-uid="${escapeHtml(b.id)}" data-action="unban">${t("unbanBtn")}</button>
    </div>`).join("");

  list.querySelectorAll('[data-action="unban"]').forEach(btn => {
    btn.addEventListener("click", () => unbanAccount(btn.getAttribute("data-uid")));
  });
}

/**
 * Removes the ban record so the account can sign in again.
 * @param {string} uid
 */
async function unbanAccount(uid){
  try{
    await deleteDoc(doc(db, BANNED_COLLECTION, uid));
    showToast(t("unbannedToast"));
  }catch(err){
    console.error("Unban failed:", err);
    showToast(t("genericError"));
  }
}

/* ---------------- Ban confirmation modal ---------------- */
let pendingBan = null;

/**
 * Opens the confirmation dialog for banning a report's owner.
 * @param {string} shareId
 * @param {string} ownerUid
 * @param {string} ownerLabel  Human-readable owner description for the dialog.
 * @param {string} folderName
 */
function openBanModal(shareId, ownerUid, ownerLabel, folderName){
  if(!ownerUid) return; // defense-in-depth; the button is already disabled in this case
  pendingBan = { shareId, ownerUid, ownerLabel, folderName };
  document.getElementById("banModalBody").textContent = t("confirmBanBody")(ownerLabel);
  document.getElementById("banModalBackdrop").classList.add("show");
}
function closeBanModal(){
  document.getElementById("banModalBackdrop").classList.remove("show");
  pendingBan = null;
}

/**
 * Bans the owner and marks the report as handled in one atomic batch,
 * so a report can never end up banned-but-still-pending (or vice versa).
 */
async function confirmBan(){
  if(!pendingBan) return;
  const btn = document.getElementById("confirmBanBtn");
  btn.disabled = true;
  try{
    const batch = writeBatch(db);
    batch.set(doc(db, BANNED_COLLECTION, pendingBan.ownerUid), {
      ownerUid: pendingBan.ownerUid,
      folderName: pendingBan.folderName || null,
      shareId: pendingBan.shareId,
      bannedAt: serverTimestamp()
    });
    batch.update(doc(db, REPORTS_COLLECTION, pendingBan.shareId), { status: REPORT_STATUS_BANNED });
    await batch.commit();
    showToast(t("bannedToast"));
    closeBanModal();
  }catch(err){
    console.error("Ban failed:", err);
    showToast(t("genericError"));
  }finally{
    btn.disabled = false;
  }
}

/* ---------------- Dismiss confirmation modal ---------------- */
let pendingDismissId = null;

function openDismissModal(shareId){
  pendingDismissId = shareId;
  document.getElementById("dismissModalBackdrop").classList.add("show");
}
function closeDismissModal(){
  document.getElementById("dismissModalBackdrop").classList.remove("show");
  pendingDismissId = null;
}
async function confirmDismiss(){
  if(!pendingDismissId) return;
  const btn = document.getElementById("confirmDismissBtn");
  btn.disabled = true;
  try{
    await deleteDoc(doc(db, REPORTS_COLLECTION, pendingDismissId));
    showToast(t("dismissedToast"));
    closeDismissModal();
  }catch(err){
    console.error(err);
    showToast(t("genericError"));
  }finally{
    btn.disabled = false;
  }
}

/* ---------------- Expose functions for inline onclick handlers ---------------- */
Object.assign(window, { closeBanModal, confirmBan, closeDismissModal, confirmDismiss });
