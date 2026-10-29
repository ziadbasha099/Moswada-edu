/* ============================================================
   ANALYTICS.JS — everything for the analytics feature in one file
   1) pure helpers   2) Firestore writes (used by dashboard.js and
   flashcards.js)   3) the analytics page itself.
   Data lives in users/{uid}: streakCount, lastVisitDate,
   flashcardSessionsCount; per link: watched (true after a video ends).
   ============================================================ */
import { getAuth, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, getDocs, collection, runTransaction, setDoc, increment }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, t, showToast, currentLang, setDynamicTranslationHook } from "./shared.js";

/* ---------- 1) Pure helpers ---------- */
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERCENT_FACTOR = 100;
const VIDEO_TYPE = 'video';

/**
 * Returns the device's local calendar date as "YYYY-MM-DD".
 * @param {Date} [date] Defaults to now (injectable for tests).
 * @returns {string}
 */
function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Whole calendar days from one "YYYY-MM-DD" key to another.
 * @param {unknown} fromKey
 * @param {unknown} toKey
 * @returns {number | null} null when either key is malformed.
 */
function daysBetween(fromKey, toKey) {
  const from = DATE_KEY_PATTERN.exec(String(fromKey ?? ''));
  const to = DATE_KEY_PATTERN.exec(String(toKey ?? ''));
  if (!from || !to) return null;
  const fromUtc = Date.UTC(Number(from[1]), Number(from[2]) - 1, Number(from[3]));
  const toUtc = Date.UTC(Number(to[1]), Number(to[2]) - 1, Number(to[3]));
  return Math.round((toUtc - fromUtc) / MS_PER_DAY);
}

/**
 * Reads a streak counter defensively (Firestore data is untrusted input).
 * @param {unknown} value
 * @returns {number} A non-negative integer.
 */
function toSafeCount(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * Works out the fields to store when the user visits today.
 * - Same day as last visit      → nothing to write (returns null).
 * - Exactly one day after       → streak + 1.
 * - A full day (or more) missed → streak restarts at 1.
 * - Device clock moved backwards → nothing to write (returns null).
 * @param {{streakCount?: unknown, lastVisitDate?: unknown}} previous
 * @param {string} todayKey
 * @returns {{streakCount: number, lastVisitDate: string} | null}
 */
function computeNextStreak(previous, todayKey) {
  const { streakCount, lastVisitDate } = previous || {};
  if (lastVisitDate === todayKey) return null;

  const gapInDays = daysBetween(lastVisitDate, todayKey);
  if (gapInDays !== null && gapInDays < 0) return null;

  const nextCount = gapInDays === 1 ? toSafeCount(streakCount) + 1 : 1;
  return { streakCount: nextCount, lastVisitDate: todayKey };
}

/**
 * Streak to DISPLAY: drops to 0 when more than one day passed since the
 * last visit (the stored value only changes on the next visit).
 * @param {{streakCount?: unknown, lastVisitDate?: unknown}} stored
 * @param {string} todayKey
 * @returns {number}
 */
function getEffectiveStreak(stored, todayKey) {
  const { streakCount, lastVisitDate } = stored || {};
  const gapInDays = daysBetween(lastVisitDate, todayKey);
  if (gapInDays === null) return 0;
  return gapInDays > 1 ? 0 : toSafeCount(streakCount);
}

/**
 * Counts watched vs unwatched among the saved video links.
 * A video counts as watched once it has played to the end (watched === true).
 * @param {Array<{type?: string, watched?: unknown}>} links
 * @returns {{watched: number, unwatched: number, total: number}}
 */
function summarizeVideos(links) {
  let watched = 0;
  let total = 0;
  for (const link of Array.isArray(links) ? links : []) {
    if (!link || link.type !== VIDEO_TYPE) continue;
    total += 1;
    if (link.watched === true) watched += 1;
  }
  return { watched, unwatched: total - watched, total };
}

/**
 * Number of folders the user currently shares publicly.
 * @param {Array<{shared?: unknown}>} folders
 * @returns {number}
 */
function countSharedFolders(folders) {
  return (Array.isArray(folders) ? folders : []).filter((folder) => folder && folder.shared === true).length;
}

/**
 * Whole-number percentage of part/total (0 when total is 0).
 * @param {number} part
 * @param {number} total
 * @returns {number}
 */
function percentage(part, total) {
  if (!total || total <= 0) return 0;
  return Math.min(PERCENT_FACTOR, Math.round((part / total) * PERCENT_FACTOR));
}

/* ---------- 2) Firestore writes ---------- */

const USERS_COLLECTION = 'users';
const FLASHCARD_SESSIONS_FIELD = 'flashcardSessionsCount';

/** UIDs whose visit was already recorded during this page load. */
const recordedVisitUids = new Set();

/**
 * Records today's visit and updates the day streak (one write per day).
 * Safe to call repeatedly: same-day calls change nothing.
 * @param {string} uid
 * @returns {Promise<void>}
 */
export async function recordDailyVisit(uid) {
  if (!uid || recordedVisitUids.has(uid)) return;
  recordedVisitUids.add(uid);

  const userRef = doc(db, USERS_COLLECTION, uid);
  const todayKey = localDateKey();
  try {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(userRef);
      const previous = snapshot.exists() ? snapshot.data() : {};
      const nextFields = computeNextStreak(previous, todayKey);
      if (nextFields) transaction.set(userRef, nextFields, { merge: true });
    });
  } catch (error) {
    recordedVisitUids.delete(uid); // allow a retry on the next call
    console.error('Failed to record daily visit:', error);
  }
}

/**
 * Adds one to the flashcard review counter (called when "Start playing"
 * successfully begins a study session).
 * @param {string} uid
 * @returns {Promise<void>}
 */
export async function incrementFlashcardSessions(uid) {
  if (!uid) return;
  try {
    await setDoc(
      doc(db, USERS_COLLECTION, uid),
      { [FLASHCARD_SESSIONS_FIELD]: increment(1) },
      { merge: true }
    );
  } catch (error) {
    console.error('Failed to count flashcard session:', error);
  }
}

/* ---------- 3) Analytics page ---------- */

const LOGIN_PAGE = 'index.html';
const APP_PAGE = 'app.html';
const LOCALE_AR = 'ar-EG';
const LOCALE_EN = 'en-US';
const PLACEHOLDER = '—';

/** Last computed stats, kept so a language switch can re-render. */
let currentStats = null;

/** @returns {Intl.NumberFormat} Number formatter for the active language. */
function getNumberFormatter() {
  return new Intl.NumberFormat(currentLang === 'ar' ? LOCALE_AR : LOCALE_EN);
}

/**
 * Sets an element's text if it exists.
 * @param {string} id
 * @param {string} text
 */
function setText(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

/**
 * Fetches everything needed in parallel and turns it into display stats.
 * @param {string} uid
 * @returns {Promise<object>}
 */
async function loadStats(uid) {
  const userRef = doc(db, 'users', uid);
  const [userSnap, linksSnap, foldersSnap] = await Promise.all([
    getDoc(userRef),
    getDocs(collection(db, 'users', uid, 'links')),
    getDocs(collection(db, 'users', uid, 'folders'))
  ]);
  const userData = userSnap.exists() ? userSnap.data() : {};
  const videos = summarizeVideos(linksSnap.docs.map((d) => d.data()));
  const flashcardSessions = Number.isInteger(userData.flashcardSessionsCount)
    ? Math.max(0, userData.flashcardSessionsCount) : 0;
  return {
    videos,
    sharedFolders: countSharedFolders(foldersSnap.docs.map((d) => d.data())),
    streak: getEffectiveStreak(userData, localDateKey()),
    flashcardSessions
  };
}

/** Renders the videos card, including the accessible progress bar. */
function renderVideos({ watched, unwatched, total }, format) {
  const share = percentage(watched, total);
  setText('watchedCount', format.format(watched));
  setText('unwatchedCount', format.format(unwatched));
  setText('watchedPercent', `${format.format(share)}%`);
  const fill = document.getElementById('watchedFill');
  if (fill) fill.style.width = `${share}%`;
  const bar = document.getElementById('watchedBar');
  if (bar) {
    bar.setAttribute('aria-valuenow', String(share));
    bar.setAttribute('aria-label', currentLang === 'ar'
      ? bar.dataset.arLabel : bar.dataset.enLabel);
  }
}

/** Renders all stats using the current language's number format. */
function renderStats() {
  if (!currentStats) return;
  const format = getNumberFormatter();
  renderVideos(currentStats.videos, format);
  setText('sharedFoldersCount', format.format(currentStats.sharedFolders));
  setText('streakCount', format.format(currentStats.streak));
  setText('flashcardSessionsCount', format.format(currentStats.flashcardSessions));
}

/** Loads and shows the stats; reports failures without crashing. */
async function initAnalytics(user) {
  try {
    await user.getIdToken(true); // refresh the email_verified claim
    await recordDailyVisit(user.uid); // opening this page counts as a visit
    currentStats = await loadStats(user.uid);
    renderStats();
  } catch (error) {
    console.error('Failed to load analytics:', error);
    showToast(t('authGeneric'));
  }
}

/** Route guard: only verified, signed-in users may view the page. */
function startPage() {
  const page = document.getElementById('analyticsPage');
  setDynamicTranslationHook(renderStats);
  onAuthStateChanged(getAuth(), (user) => {
    if (!user) { window.location.replace(LOGIN_PAGE); return; }
    if (!user.emailVerified) { window.location.replace(APP_PAGE); return; }
    page?.classList.remove('hidden');
    initAnalytics(user);
  });
}

// Only run on the analytics page (dashboard/flashcards import the helpers above)
if (document.getElementById('analyticsPage')) startPage();
