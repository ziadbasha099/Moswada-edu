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
