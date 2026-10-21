/* ============================================================
   download-kinds.js — shared, pure helpers for the downloads data
   ------------------------------------------------------------
   No Firebase, no DOM: used by admin.js now and by the public
   downloads page later, and covered by tests/.

   Data model
     downloadFolders/{slug}  name, slug, color, order, description,
                             keywords[], updatedAt
     downloads/{id}          title, url, slug, folderId, kind,
                             description, tags[], updatedAt, createdAt
                             + legacy fields (folder, icon, color) kept
                             so the old page keeps working until it is
                             replaced.

   Validators return error CODES (never user-facing text) so the UI
   can translate them.
   ============================================================ */

/** Allowed item kinds. `action` decides the button: download or visit. */
export const DOWNLOAD_KINDS = Object.freeze({
  summary: { ar: 'ملخص', en: 'Summary', legacyIcon: 'file', action: 'download' },
  mindmap: { ar: 'خريطة ذهنية', en: 'Mind map', legacyIcon: 'mindmap', action: 'download' },
  book: { ar: 'كتاب', en: 'Book', legacyIcon: 'file', action: 'download' },
  files: { ar: 'ملفات ومواد', en: 'Files', legacyIcon: 'file', action: 'download' },
  website: { ar: 'موقع', en: 'Website', legacyIcon: 'link', action: 'visit' },
});
export const KIND_KEYS = Object.freeze(Object.keys(DOWNLOAD_KINDS));

/** Folder color keys → base hex (dark-mode variants are added with the design phase). */
export const FOLDER_COLORS = Object.freeze({
  teal: '#226864',
  terracotta: '#e07a5f',
  clay: '#9c6644',
  blue: '#3e6f8f',
  purple: '#6c5b9e',
  green: '#2f8a6a',
  rose: '#c65d7b',
  gold: '#b9860a',
});
export const FOLDER_COLOR_KEYS = Object.freeze(Object.keys(FOLDER_COLORS));

export const LIMITS = Object.freeze({
  TITLE: 120,
  DESCRIPTION: 400,
  TAGS: 8,
  TAG: 30,
  SLUG: 60,
  URL: 2000,
  FOLDER_NAME: 60,
  KEYWORDS: 10,
  KEYWORD: 60,
  MAX_ORDER: 999,
});
export const DEFAULT_LEGACY_COLOR = 'green';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIST_SEPARATORS = /[\n,،;؛]+/;
// Control characters and bidi override/isolate characters (used for text spoofing).
const UNSAFE_CHARACTERS = /[\u0000-\u001F\u007F‪-‮⁦-⁩]/g;

/**
 * Normalises free text: removes control/bidi-override characters, collapses
 * whitespace and trims. Output is plain text and must still be escaped when
 * it is put into HTML.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeText(value) {
  return String(value ?? '').replace(UNSAFE_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Builds a URL slug from Latin letters/digits only (Arabic text gives '').
 * @param {unknown} text
 * @returns {string}
 */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.SLUG)
    .replace(/-+$/, '');
}

/**
 * @param {unknown} slug
 * @returns {boolean}
 */
export function isValidSlug(slug) {
  return typeof slug === 'string' && slug.length <= LIMITS.SLUG && SLUG_PATTERN.test(slug);
}

/**
 * Accepts only absolute http(s) URLs with a dotted host and no credentials.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeUrl(value) {
  if (typeof value !== 'string' || value.length > LIMITS.URL) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.hostname.includes('.')
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

/**
 * Splits a comma/newline separated list into sanitised, de-duplicated values.
 * @param {unknown} text
 * @param {{maxItems: number, maxLength: number}} options
 * @returns {{values: string[], error: 'tooMany' | 'tooLong' | null}}
 */
export function parseList(text, { maxItems, maxLength }) {
  const values = [];
  const seen = new Set();
  for (const piece of String(text ?? '').split(LIST_SEPARATORS)) {
    const value = sanitizeText(piece);
    const key = value.toLowerCase();
    if (value && !seen.has(key)) {
      seen.add(key);
      values.push(value);
    }
  }
  if (values.some((value) => value.length > maxLength)) return { values, error: 'tooLong' };
  if (values.length > maxItems) return { values, error: 'tooMany' };
  return { values, error: null };
}

/**
 * Validates the download form and returns clean data.
 * @param {{title: string, url: string, folderId: string, kind: string, slug: string, description: string, tagsText: string}} input
 * @param {{folderIds: Set<string>, takenSlugs: Set<string>}} context
 * @returns {{errors: string[], data: {title: string, url: string, folderId: string, kind: string, slug: string, description: string, tags: string[]}}}
 */
export function validateDownloadForm(input, context) {
  const errors = [];
  const title = sanitizeText(input.title);
  const description = sanitizeText(input.description);
  const url = String(input.url ?? '').trim();
  const slug = String(input.slug ?? '').trim().toLowerCase();
  const tags = parseList(input.tagsText, { maxItems: LIMITS.TAGS, maxLength: LIMITS.TAG });

  if (!title) errors.push('title');
  else if (title.length > LIMITS.TITLE) errors.push('titleTooLong');
  if (!context.folderIds.has(input.folderId)) errors.push('folder');
  if (!KIND_KEYS.includes(input.kind)) errors.push('kind');
  if (!isValidSlug(slug)) errors.push('slug');
  else if (context.takenSlugs.has(slug)) errors.push('slugTaken');
  if (!description) errors.push('description');
  else if (description.length > LIMITS.DESCRIPTION) errors.push('descriptionTooLong');
  if (tags.error) errors.push(tags.error === 'tooMany' ? 'tagsTooMany' : 'tagTooLong');
  if (!isSafeUrl(url)) errors.push('url');

  return {
    errors,
    data: { title, url, folderId: input.folderId, kind: input.kind, slug, description, tags: tags.values },
  };
}

/**
 * Fields to write for a download. Legacy fields (folder/icon/color) are
 * derived so the old public page keeps showing new and edited items.
 * @param {ReturnType<typeof validateDownloadForm>['data']} data
 * @param {{legacyFolderName?: string, folderName: string, existingColor?: string}} legacy
 * @returns {Record<string, unknown>}
 */
export function buildDownloadFields(data, legacy) {
  return {
    ...data,
    folder: legacy.legacyFolderName || legacy.folderName,
    icon: DOWNLOAD_KINDS[data.kind].legacyIcon,
    color: legacy.existingColor || DEFAULT_LEGACY_COLOR,
  };
}

/**
 * Validates the folder form and returns clean data.
 * @param {{name: string, slug: string, color: string, order: unknown, description: string, keywordsText: string}} input
 * @param {{takenSlugs: Set<string>, isEdit: boolean}} context
 * @returns {{errors: string[], data: {name: string, slug: string, color: string, order: number, description: string, keywords: string[]}}}
 */
export function validateFolderForm(input, context) {
  const errors = [];
  const name = sanitizeText(input.name);
  const description = sanitizeText(input.description);
  const slug = String(input.slug ?? '').trim().toLowerCase();
  const order = Number(input.order);
  const keywords = parseList(input.keywordsText, { maxItems: LIMITS.KEYWORDS, maxLength: LIMITS.KEYWORD });

  if (!name) errors.push('folderName');
  else if (name.length > LIMITS.FOLDER_NAME) errors.push('folderNameTooLong');
  if (!isValidSlug(slug)) errors.push('slug');
  else if (!context.isEdit && context.takenSlugs.has(slug)) errors.push('slugTaken');
  if (!FOLDER_COLOR_KEYS.includes(input.color)) errors.push('color');
  if (!Number.isInteger(order) || order < 1 || order > LIMITS.MAX_ORDER) errors.push('order');
  if (!description) errors.push('description');
  else if (description.length > LIMITS.DESCRIPTION) errors.push('descriptionTooLong');
  if (keywords.error) errors.push(keywords.error === 'tooMany' ? 'keywordsTooMany' : 'keywordTooLong');

  return { errors, data: { name, slug, color: input.color, order, description, keywords: keywords.values } };
}
