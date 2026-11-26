/* ============================================================
   ANALYTICS.JS — everything for the analytics feature in one file
   1) pure helpers   2) Firestore writes (used by dashboard.js and
   flashcards.js)   3) the analytics page itself.
   Data lives in users/{uid}: streakCount, lastVisitDate,
   flashcardSessionsCount; per link: watched (true after a video ends).
   ============================================================ */
import { getAuth, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, getDocs, collection, runTransaction, setDoc, updateDoc, increment }
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
  const fromUtc = parseDateKeyToUtc(fromKey);
  const toUtc = parseDateKeyToUtc(toKey);
  if (fromUtc === null || toUtc === null) return null;
  return Math.round((toUtc - fromUtc) / MS_PER_DAY);
}

/**
 * Converts a "YYYY-MM-DD" key to the UTC timestamp of that calendar day.
 * @param {unknown} dateKey
 * @returns {number | null} null when the key is malformed.
 */
function parseDateKeyToUtc(dateKey) {
  const parts = DATE_KEY_PATTERN.exec(String(dateKey ?? ''));
  if (!parts) return null;
  return Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
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

/* ---- Week strip (Saturday → Friday) ---- */
const DAYS_IN_WEEK = 7;
const WEEK_START_DAY = 6; // Saturday, as numbered by Date#getUTCDay()
const WEEK_DAY_STATE = Object.freeze({ VISITED: 'visited', TODAY: 'today', PENDING: 'pending' });

/**
 * Builds the 7 days of the current week (Saturday first) and marks which ones
 * were visited. Visited days are the last `streak` days ending at the last
 * visit, so no extra data needs to be stored.
 * @param {{streakCount?: unknown, lastVisitDate?: unknown}} stored
 * @param {string} todayKey
 * @returns {Array<{dayUtc: number, index: number, state: string, isVisited: boolean}>}
 */
function buildWeekStatus(stored, todayKey) {
  const todayUtc = parseDateKeyToUtc(todayKey);
  if (todayUtc === null) return [];

  const todayIndex = (new Date(todayUtc).getUTCDay() - WEEK_START_DAY + DAYS_IN_WEEK) % DAYS_IN_WEEK;
  const weekStartUtc = todayUtc - todayIndex * MS_PER_DAY;
  const streak = getEffectiveStreak(stored, todayKey);
  const lastVisitUtc = parseDateKeyToUtc(stored?.lastVisitDate);

  return Array.from({ length: DAYS_IN_WEEK }, (_, index) => {
    const dayUtc = weekStartUtc + index * MS_PER_DAY;
    const daysBeforeLastVisit = lastVisitUtc === null ? -1 : Math.round((lastVisitUtc - dayUtc) / MS_PER_DAY);
    const isVisited = streak > 0 && daysBeforeLastVisit >= 0 && daysBeforeLastVisit < streak;

    let state = WEEK_DAY_STATE.PENDING;
    if (index === todayIndex) state = WEEK_DAY_STATE.TODAY;
    else if (isVisited) state = WEEK_DAY_STATE.VISITED;
    return { dayUtc, index, state, isVisited };
  });
}

/* ---- Videos per folder ---- */
const LEVEL_MIN_PERCENT = Object.freeze({ COMPLETE: 100, ADVANCED: 67, INTERMEDIATE: 34 });

/**
 * Watched/total video counts for every folder that holds at least one video.
 * @param {Array<{id?: unknown, name?: unknown}>} folders
 * @param {Array<{folder?: unknown, type?: string, watched?: unknown}>} links
 * @returns {Array<{id: string, name: string, watched: number, total: number, percent: number}>}
 */
function summarizeVideosByFolder(folders, links) {
  const safeLinks = Array.isArray(links) ? links : [];
  return (Array.isArray(folders) ? folders : [])
    .filter((folder) => folder && typeof folder.id === 'string' && typeof folder.name === 'string')
    .map((folder) => {
      const { watched, total } = summarizeVideos(safeLinks.filter((link) => link && link.folder === folder.id));
      return { id: folder.id, name: folder.name, watched, total, percent: percentage(watched, total) };
    })
    .filter((entry) => entry.total > 0);
}

/**
 * Maps a progress percentage to the i18n key of its level label.
 * @param {number} percent
 * @returns {string}
 */
function getLevelKey(percent) {
  if (percent >= LEVEL_MIN_PERCENT.COMPLETE) return 'levelComplete';
  if (percent >= LEVEL_MIN_PERCENT.ADVANCED) return 'levelAdvanced';
  if (percent >= LEVEL_MIN_PERCENT.INTERMEDIATE) return 'levelIntermediate';
  return 'levelBeginner';
}

/* ---- Flashcard subjects ---- */

/**
 * True when there is at least one card and every card was reviewed.
 * @param {Array<{reviewed?: unknown}>} cards
 * @returns {boolean}
 */
function areAllCardsReviewed(cards) {
  return Array.isArray(cards) && cards.length > 0 && cards.every((card) => card && card.reviewed === true);
}

/**
 * Subjects that were finished at least once (completedOnce), each flagged with
 * whether ALL their cards are still reviewed. Adding a new card makes
 * isComplete false again, which turns the check mark gray.
 * @param {Array<{id?: string, name?: unknown, completedOnce?: unknown}>} subjects
 * @param {Array<{subjectId?: unknown, reviewed?: unknown}>} cards
 * @returns {Array<{name: string, isComplete: boolean}>}
 */
function summarizeCompletedSubjects(subjects, cards) {
  const safeCards = Array.isArray(cards) ? cards : [];
  return (Array.isArray(subjects) ? subjects : [])
    .filter((subject) => subject && subject.completedOnce === true && typeof subject.name === 'string')
    .map((subject) => ({
      name: subject.name,
      isComplete: areAllCardsReviewed(safeCards.filter((card) => card && card.subjectId === subject.id))
    }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

/* ---------- 2) Firestore writes ---------- */

const USERS_COLLECTION = 'users';
const FLASHCARD_SESSIONS_FIELD = 'flashcardSessionsCount';
const FLASHCARDS_COLLECTION = 'flashcards';
const FLASHCARD_SUBJECTS_COLLECTION = 'flashcardSubjects';

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

/**
 * Marks a flashcard as reviewed and, when that finishes every card of its
 * subject, flags the subject as completed (completedOnce) so the analytics
 * page lists it. Errors are logged, never thrown (fire-and-forget safe).
 * @param {string} uid
 * @param {{id?: string, reviewed?: unknown}} card The card that was just graded.
 * @param {Array<{id?: string, reviewed?: unknown}>} subjectCards All cards of the card's subject.
 * @param {{id?: string, completedOnce?: unknown} | undefined} subject
 * @returns {Promise<void>}
 */
export async function recordFlashcardReview(uid, card, subjectCards, subject) {
  if (!uid || !card || !card.id) return;
  try {
    if (card.reviewed !== true) {
      await updateDoc(doc(db, USERS_COLLECTION, uid, FLASHCARDS_COLLECTION, card.id), { reviewed: true });
      card.reviewed = true;
    }

    const knownCards = subjectCards.some((item) => item.id === card.id) ? subjectCards : [...subjectCards, card];
    const cardsAfterReview = knownCards.map((item) => (item.id === card.id ? { ...item, reviewed: true } : item));
    if (subject && subject.id && subject.completedOnce !== true && areAllCardsReviewed(cardsAfterReview)) {
      await updateDoc(doc(db, USERS_COLLECTION, uid, FLASHCARD_SUBJECTS_COLLECTION, subject.id), { completedOnce: true });
      subject.completedOnce = true;
    }
  } catch (error) {
    console.error('Failed to record flashcard review:', error);
  }
}

/* ---------- 3) Analytics page ---------- */

const LOGIN_PAGE = 'index.html';
const APP_PAGE = 'app.html';
const LOCALE_AR = 'ar-EG';
const LOCALE_EN = 'en-US';
const PLACEHOLDER = '—';

/** Texts generated in JS (static page texts use data-en/data-ar in the HTML). */
const ANALYTICS_I18N = {
  ar: {
    weekKeepGoing: 'حافظ على استمراريتك اليوم لكسب شارة الأسبوع!',
    weekBadgeEarned: 'أحسنت! حصلت على شارة هذا الأسبوع.',
    videosWatchedOf: (watched, total, format) => `${format.format(watched)} من ${format.format(total)} فيديو تمت مشاهدته`,
    levelBeginner: 'في البداية',
    levelIntermediate: 'مستوى متوسط',
    levelAdvanced: 'مستوى متقدم',
    levelComplete: 'اكتملت المشاهدة',
    subjectAllReviewed: 'تمت مراجعة كل الكلمات',
    subjectHasUnreviewed: 'توجد كلمات غير مراجعة'
  },
  en: {
    weekKeepGoing: 'Keep your streak going today to earn the weekly badge!',
    weekBadgeEarned: 'Well done! You earned this week\'s badge.',
    videosWatchedOf: (watched, total, format) => `${format.format(watched)} of ${format.format(total)} videos watched`,
    levelBeginner: 'Just started',
    levelIntermediate: 'Intermediate',
    levelAdvanced: 'Advanced',
    levelComplete: 'Fully watched',
    subjectAllReviewed: 'All words reviewed',
    subjectHasUnreviewed: 'Some words are not reviewed yet'
  }
};

/**
 * @param {string} key
 * @returns {string | Function} Text (or text builder) for the active language.
 */
function analyticsText(key) {
  return ANALYTICS_I18N[currentLang][key];
}

/* Static icons (never built from user data). */
const CHECK_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';
const FLAME_ICON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c1 3.5 5 5.5 5 10a5 5 0 01-10 0c0-2 1-3.5 2-4.5.3 1.5 1 2.2 2 2.5C11 7.5 10.5 4.5 12 2z"/></svg>';

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
  const [userSnap, linksSnap, foldersSnap, subjectsSnap, cardsSnap] = await Promise.all([
    getDoc(userRef),
    getDocs(collection(db, 'users', uid, 'links')),
    getDocs(collection(db, 'users', uid, 'folders')),
    getDocs(collection(db, 'users', uid, FLASHCARD_SUBJECTS_COLLECTION)),
    getDocs(collection(db, 'users', uid, FLASHCARDS_COLLECTION))
  ]);
  const userData = userSnap.exists() ? userSnap.data() : {};
  const links = linksSnap.docs.map((d) => d.data());
  const folders = foldersSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((first, second) => (first.createdAt?.toMillis?.() ?? 0) - (second.createdAt?.toMillis?.() ?? 0));
  const flashcardSessions = Number.isInteger(userData.flashcardSessionsCount)
    ? Math.max(0, userData.flashcardSessionsCount) : 0;
  const todayKey = localDateKey();
  return {
    videos: summarizeVideos(links),
    folderProgress: summarizeVideosByFolder(folders, links),
    sharedFolders: countSharedFolders(folders),
    streak: getEffectiveStreak(userData, todayKey),
    weekDays: buildWeekStatus(userData, todayKey),
    flashcardSessions,
    completedSubjects: summarizeCompletedSubjects(
      subjectsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      cardsSnap.docs.map((d) => d.data())
    )
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

/**
 * Creates a small <span> with a class and optional text.
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLSpanElement}
 */
function createSpan(className, text = '') {
  const span = document.createElement('span');
  span.className = className;
  if (text) span.textContent = text;
  return span;
}

/** Builds one day of the week strip (label above, status circle below). */
function createWeekDayElement(day, weekdayFormat, format) {
  const item = document.createElement('div');
  item.className = `week-day${day.state === WEEK_DAY_STATE.TODAY ? ' is-today' : ''}`;
  item.setAttribute('role', 'listitem');

  const dot = createSpan(`week-day-dot is-${day.state}`);
  if (day.state === WEEK_DAY_STATE.VISITED) dot.innerHTML = CHECK_ICON_SVG;
  else if (day.state === WEEK_DAY_STATE.TODAY) dot.innerHTML = FLAME_ICON_SVG;
  else dot.textContent = format.format(day.index + 1);

  item.append(createSpan('week-day-label', weekdayFormat.format(new Date(day.dayUtc))), dot);
  return item;
}

/** Renders the weekday strip and its encouragement message. */
function renderWeekStrip(weekDays, format) {
  const strip = document.getElementById('weekStrip');
  if (!strip) return;
  const weekdayFormat = new Intl.DateTimeFormat(currentLang === 'ar' ? LOCALE_AR : LOCALE_EN, { weekday: 'long', timeZone: 'UTC' });
  strip.replaceChildren(...weekDays.map((day) => createWeekDayElement(day, weekdayFormat, format)));

  const isWeekComplete = weekDays.length > 0 && weekDays.every((day) => day.isVisited);
  setText('weekMessage', analyticsText(isWeekComplete ? 'weekBadgeEarned' : 'weekKeepGoing'));
}

/** Builds one folder row: name + percent, progress bar, counts + level. */
function createFolderProgressItem(entry, format) {
  const item = document.createElement('li');
  item.className = 'folder-progress-item';

  const head = document.createElement('div');
  head.className = 'folder-progress-head';
  head.append(createSpan('folder-progress-name', entry.name), createSpan('folder-progress-percent', `${format.format(entry.percent)}%`));

  const track = document.createElement('div');
  track.className = 'progress-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', String(PERCENT_FACTOR));
  track.setAttribute('aria-valuenow', String(entry.percent));
  track.setAttribute('aria-label', entry.name);
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = `${entry.percent}%`;
  track.appendChild(fill);

  const foot = document.createElement('div');
  foot.className = 'folder-progress-foot';
  foot.append(
    createSpan('', analyticsText('videosWatchedOf')(entry.watched, entry.total, format)),
    createSpan('', analyticsText(getLevelKey(entry.percent)))
  );

  item.append(head, track, foot);
  return item;
}

/** Renders the per-folder watched-videos card. */
function renderFolderProgress(folderProgress, format) {
  const list = document.getElementById('folderProgressList');
  if (!list) return;
  list.replaceChildren(...folderProgress.map((entry) => createFolderProgressItem(entry, format)));
  document.getElementById('folderProgressEmpty')?.classList.toggle('hidden', folderProgress.length > 0);
}

/** Builds one finished-subject row: name + green (or gray) check mark. */
function createCompletedSubjectItem(subject) {
  const item = document.createElement('li');
  item.className = 'completed-subject';

  const check = createSpan(`subject-check${subject.isComplete ? ' is-complete' : ''}`);
  check.innerHTML = CHECK_ICON_SVG;
  check.title = analyticsText(subject.isComplete ? 'subjectAllReviewed' : 'subjectHasUnreviewed');

  item.append(createSpan('completed-subject-name', subject.name), check);
  return item;
}

/** Lists finished subjects under the flashcard counter. */
function renderCompletedSubjects(subjects) {
  const list = document.getElementById('completedSubjects');
  if (!list) return;
  list.replaceChildren(...subjects.map(createCompletedSubjectItem));
  list.classList.toggle('hidden', subjects.length === 0);
}

/** Renders all stats using the current language's number format. */
function renderStats() {
  if (!currentStats) return;
  const format = getNumberFormatter();
  renderVideos(currentStats.videos, format);
  renderFolderProgress(currentStats.folderProgress, format);
  setText('sharedFoldersCount', format.format(currentStats.sharedFolders));
  setText('streakCount', format.format(currentStats.streak));
  renderWeekStrip(currentStats.weekDays, format);
  setText('flashcardSessionsCount', format.format(currentStats.flashcardSessions));
  renderCompletedSubjects(currentStats.completedSubjects);
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
  setDynamicTranslationHook(() => { renderStats(); renderPomodoroCard(); });
  onAuthStateChanged(getAuth(), (user) => {
    if (!user) { window.location.replace(LOGIN_PAGE); return; }
    if (!user.emailVerified) { window.location.replace(APP_PAGE); return; }
    page?.classList.remove('hidden');
    initPomodoroCard();
    startPomodoroNotifier();
    initAnalytics(user);
  });
}

/* ==================================================================
   POMODORO — timer that keeps running across pages
   The session is stored as an absolute end timestamp in localStorage
   and the remaining time is always derived from Date.now(), so it
   survives navigation and reloads. Pausing stores the remaining ms.
   ================================================================== */

// <pomodoro-core>
const POMODORO_DURATIONS_MINUTES = Object.freeze([10, 15, 20, 25, 60]);
const DEFAULT_DURATION_MINUTES = 25;
const POMODORO_STORAGE_KEY = 'moswada.pomodoro.v2';
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
const POMODORO_TICK_MS = 500;
const POMODORO_WATCH_MS = 1000;
const POMODORO_PHASE = Object.freeze({ IDLE: 'idle', RUNNING: 'running', PAUSED: 'paused', FINISHED: 'finished' });

/**
 * @typedef {Object} PomodoroState
 * @property {number} durationMinutes     Selected focus length.
 * @property {number | null} endTimestamp Epoch ms when the running session ends.
 * @property {number | null} remainingMs  Time left while paused.
 * @property {boolean} finished           A session ended and was not reset yet.
 * @property {boolean} notified           The completion toast was already shown.
 */

/** @param {number} [durationMinutes] @returns {PomodoroState} Fresh idle state. */
function createPomodoroState(durationMinutes = DEFAULT_DURATION_MINUTES) {
  return { durationMinutes, endTimestamp: null, remainingMs: null, finished: false, notified: false };
}

/** @param {unknown} value @returns {boolean} */
function isValidDuration(value) {
  return POMODORO_DURATIONS_MINUTES.includes(value);
}

/** @param {unknown} value @returns {number | null} Positive finite number or null. */
function positiveNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Coerces untrusted stored data into a valid state (never throws).
 * @param {unknown} raw
 * @returns {PomodoroState}
 */
function sanitizePomodoroState(raw) {
  if (!raw || typeof raw !== 'object') return createPomodoroState();
  const candidate = /** @type {Record<string, unknown>} */ (raw);
  const state = createPomodoroState(isValidDuration(candidate.durationMinutes) ? candidate.durationMinutes : DEFAULT_DURATION_MINUTES);
  state.endTimestamp = positiveNumberOrNull(candidate.endTimestamp);
  state.remainingMs = state.endTimestamp === null ? positiveNumberOrNull(candidate.remainingMs) : null;
  state.finished = candidate.finished === true;
  state.notified = candidate.notified === true;
  return state;
}

/** @param {PomodoroState} state @param {number} [now] @returns {string} One of POMODORO_PHASE. */
function getPomodoroPhase(state, now = Date.now()) {
  if (state.endTimestamp !== null) return now >= state.endTimestamp ? POMODORO_PHASE.FINISHED : POMODORO_PHASE.RUNNING;
  if (state.remainingMs !== null) return POMODORO_PHASE.PAUSED;
  return state.finished ? POMODORO_PHASE.FINISHED : POMODORO_PHASE.IDLE;
}

/** @param {PomodoroState} state @param {number} [now] @returns {number} Whole seconds to display. */
function getRemainingSeconds(state, now = Date.now()) {
  switch (getPomodoroPhase(state, now)) {
    case POMODORO_PHASE.RUNNING: return Math.ceil((state.endTimestamp - now) / MS_PER_SECOND);
    case POMODORO_PHASE.PAUSED: return Math.ceil(state.remainingMs / MS_PER_SECOND);
    case POMODORO_PHASE.FINISHED: return 0;
    default: return state.durationMinutes * SECONDS_PER_MINUTE;
  }
}

/** @param {number} totalSeconds @returns {string} "MM:SS". */
function formatClock(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / SECONDS_PER_MINUTE);
  return `${String(minutes).padStart(2, '0')}:${String(safeSeconds % SECONDS_PER_MINUTE).padStart(2, '0')}`;
}

/** Picks a duration; ignored while running/paused or for invalid values. @returns {PomodoroState} */
function selectDuration(state, minutes, now = Date.now()) {
  const phase = getPomodoroPhase(state, now);
  if (!isValidDuration(minutes) || phase === POMODORO_PHASE.RUNNING || phase === POMODORO_PHASE.PAUSED) return state;
  return createPomodoroState(minutes);
}

/** Starts a new session, or resumes a paused one. @returns {PomodoroState} */
function startSession(state, now = Date.now()) {
  const phase = getPomodoroPhase(state, now);
  if (phase === POMODORO_PHASE.RUNNING) return state;
  const durationMs = phase === POMODORO_PHASE.PAUSED ? state.remainingMs : state.durationMinutes * MS_PER_MINUTE;
  return { ...createPomodoroState(state.durationMinutes), endTimestamp: now + durationMs };
}

/** Freezes the remaining time; only affects a running session. @returns {PomodoroState} */
function pauseSession(state, now = Date.now()) {
  if (getPomodoroPhase(state, now) !== POMODORO_PHASE.RUNNING) return state;
  return { ...createPomodoroState(state.durationMinutes), remainingMs: state.endTimestamp - now };
}

/** Back to idle, keeping the chosen duration. @returns {PomodoroState} */
function resetSession(state) {
  return createPomodoroState(state.durationMinutes);
}

/** Moves an expired running session to the finished state. @returns {PomodoroState} */
function settleExpired(state, now = Date.now()) {
  if (state.endTimestamp === null || now < state.endTimestamp) return state;
  return { ...state, endTimestamp: null, finished: true };
}

/** @returns {PomodoroState} Stored state, or defaults if missing/corrupt/unavailable. */
function loadPomodoroState() {
  try {
    const stored = window.localStorage.getItem(POMODORO_STORAGE_KEY);
    return stored ? sanitizePomodoroState(JSON.parse(stored)) : createPomodoroState();
  } catch (error) {
    console.error('Pomodoro: could not read saved state:', error);
    return createPomodoroState();
  }
}

/** @param {PomodoroState} state */
function savePomodoroState(state) {
  try {
    window.localStorage.setItem(POMODORO_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error('Pomodoro: could not save state:', error);
  }
}
// </pomodoro-core>

/* ---------- Completion notifier (runs on dashboard + analytics) ---------- */

const POMODORO_FINISHED_TOAST = Object.freeze({
  ar: 'انتهت جلسة التركيز — أحسنت! خذ استراحة قصيرة.',
  en: 'Focus session complete — well done! Take a short break.'
});
let pomodoroNotifierId = null;

/** Shows the completion toast once per finished session. */
function checkPomodoroFinished() {
  const settled = settleExpired(loadPomodoroState());
  if (!settled.finished || settled.notified) return;
  savePomodoroState({ ...settled, notified: true });
  showToast(POMODORO_FINISHED_TOAST[currentLang] ?? POMODORO_FINISHED_TOAST.en);
}

/** Starts the completion watcher once per page; safe to call repeatedly. */
export function startPomodoroNotifier() {
  if (pomodoroNotifierId !== null) return;
  checkPomodoroFinished();
  pomodoroNotifierId = window.setInterval(checkPomodoroFinished, POMODORO_WATCH_MS);
}

/* ---------- Pomodoro card UI (analytics page) ---------- */

const POMODORO_I18N = {
  ar: {
    minuteShort: 'د',
    statusIdle: 'جاهز لجلسة تركيز هادئة',
    statusRunning: 'جلسة التركيز جارية… ابقَ هادئًا',
    statusPaused: 'الجلسة متوقفة مؤقتًا',
    statusFinished: 'أحسنت! انتهت جلسة التركيز',
    hint: (minutes) => `${minutes} دقيقة تركيز متواصل`,
    start: 'ابدأ التركيز',
    pause: 'إيقاف مؤقت',
    resume: 'متابعة'
  },
  en: {
    minuteShort: 'm',
    statusIdle: 'Ready for a calm focus session',
    statusRunning: 'Focus session in progress… stay calm',
    statusPaused: 'Session paused',
    statusFinished: 'Well done! Focus session complete',
    hint: (minutes) => `${minutes} minutes of uninterrupted focus`,
    start: 'Start focus',
    pause: 'Pause',
    resume: 'Resume'
  }
};

const POMODORO_ICON_PLAY = 'M8 5v14l11-7z';
const POMODORO_ICON_PAUSE = 'M7 5h3v14H7zM14 5h3v14h-3z';

/** @param {string} key @returns {any} */
const pomodoroText = (key) => POMODORO_I18N[currentLang][key];
const pomodoroEl = (id) => document.getElementById(id);

let pomodoroState = null;
let pomodoroTickId = null;

/** Persists a new state and redraws. @param {PomodoroState} next */
function commitPomodoro(next) {
  pomodoroState = next;
  savePomodoroState(next);
  renderPomodoroCard();
}

/** Primary button action depends on the phase: start / pause / resume. */
function handlePomodoroPrimary() {
  const latest = loadPomodoroState();
  const isRunning = getPomodoroPhase(latest) === POMODORO_PHASE.RUNNING;
  commitPomodoro(isRunning ? pauseSession(latest) : startSession(latest));
}

/** Builds the duration chips once (static data only). */
function buildPomodoroChips() {
  const chips = POMODORO_DURATIONS_MINUTES.map((minutes) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pomodoro-chip';
    chip.dataset.minutes = String(minutes);
    chip.addEventListener('click', () => commitPomodoro(selectDuration(loadPomodoroState(), minutes)));
    return chip;
  });
  pomodoroEl('pomodoroChips').replaceChildren(...chips);
}

/** Updates chip labels, selection and disabled state. */
function renderPomodoroChips(isLocked) {
  pomodoroEl('pomodoroChips').querySelectorAll('.pomodoro-chip').forEach((chip) => {
    const selected = Number(chip.dataset.minutes) === pomodoroState.durationMinutes;
    chip.textContent = `${chip.dataset.minutes} ${pomodoroText('minuteShort')}`;
    chip.classList.toggle('is-selected', selected);
    chip.setAttribute('aria-pressed', String(selected));
    chip.disabled = isLocked;
  });
}

/** @param {string} phase @returns {{label: string, icon: string}} Primary button label + icon. */
function getPrimaryButtonView(phase) {
  if (phase === POMODORO_PHASE.RUNNING) return { label: pomodoroText('pause'), icon: POMODORO_ICON_PAUSE };
  if (phase === POMODORO_PHASE.PAUSED) return { label: pomodoroText('resume'), icon: POMODORO_ICON_PLAY };
  return { label: pomodoroText('start'), icon: POMODORO_ICON_PLAY };
}

/** Redraws the whole card from the current state. */
export function renderPomodoroCard() {
  if (!pomodoroState || !pomodoroEl('pomodoroClock')) return;
  const phase = getPomodoroPhase(pomodoroState);
  const isLocked = phase === POMODORO_PHASE.RUNNING || phase === POMODORO_PHASE.PAUSED;
  const statusKey = `status${phase[0].toUpperCase()}${phase.slice(1)}`;
  const primary = getPrimaryButtonView(phase);
  renderPomodoroChips(isLocked);
  pomodoroEl('pomodoroClock').textContent = formatClock(getRemainingSeconds(pomodoroState));
  pomodoroEl('pomodoroStatus').textContent = pomodoroText(statusKey);
  pomodoroEl('pomodoroHint').textContent = pomodoroText('hint')(pomodoroState.durationMinutes);
  pomodoroEl('pomodoroStartLabel').textContent = primary.label;
  pomodoroEl('pomodoroStartIcon').setAttribute('d', primary.icon);
  pomodoroEl('pomodoroClock').closest('.pomodoro-panel').classList.toggle('is-running', phase === POMODORO_PHASE.RUNNING);
}

/** Once per tick: pick up changes from other tabs and settle expiry. */
function tickPomodoro() {
  pomodoroState = settleExpired(loadPomodoroState());
  renderPomodoroCard();
}

/** Wires the card; safe to call when the card is absent or already wired. */
function initPomodoroCard() {
  if (!pomodoroEl('pomodoroClock') || pomodoroTickId !== null) return;
  pomodoroState = loadPomodoroState();
  buildPomodoroChips();
  pomodoroEl('pomodoroStart').addEventListener('click', handlePomodoroPrimary);
  pomodoroEl('pomodoroReset').addEventListener('click', () => commitPomodoro(resetSession(loadPomodoroState())));
  renderPomodoroCard();
  pomodoroTickId = window.setInterval(tickPomodoro, POMODORO_TICK_MS);
}

// Only run on the analytics page (dashboard/flashcards import the helpers above)
if (document.getElementById('analyticsPage')) startPage();
