/* ============================================================
   scripts/migrate-downloads.mjs — المرحلة 1
   ------------------------------------------------------------
   ينقل بيانات التنزيلات إلى النموذج الجديد.
   الافتراضي: --dry-run (لا يكتب شيئاً). الكتابة الفعلية تحتاج --apply.

   التشغيل:
     npm install
     # معاينة بدون أي اتصال بـ Firestore (من ملف التصدير):
     node scripts/migrate-downloads.mjs --from-export downloads-export.json
     # معاينة من Firestore نفسها:
     export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
     node scripts/migrate-downloads.mjs
     # التنفيذ الفعلي (بعد مراجعة migration-plan.json):
     node scripts/migrate-downloads.mjs --apply

   الأمان:
   - يتوقف قبل أي كتابة إذا وُجد أي تعارض بين Firestore وملف الإثراء.
   - يكتب بـ merge فقط، فلا يحذف أي حقل قديم.
   - إعادة التشغيل آمنة (idempotent): معرّفات المجلدات = slug.
   ============================================================ */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';


/* ===== الدوال النقية (بدون Firebase أو ملفات) — مغطاة بالاختبارات ===== */
export const DOWNLOAD_KINDS = Object.freeze(['summary', 'mindmap', 'book', 'files', 'website']);
export const FOLDER_COLOR_KEYS = Object.freeze([
  'teal', 'terracotta', 'clay', 'blue', 'purple', 'green', 'rose', 'gold',
]);

const SAFE_URL_PATTERN = /^https?:\/\/[^\s]+$/i;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TAGS_PER_ITEM = 8;
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 400;

/**
 * Validates one enriched item. Returns a list of human-readable problems.
 * @param {string} id Firestore document id.
 * @param {Record<string, any>} item Enrichment entry.
 * @returns {string[]}
 */
export function validateEnrichedItem(id, item) {
  const problems = [];
  const fail = (message) => problems.push(`${id}: ${message}`);

  if (!item || typeof item !== 'object') return [`${id}: entry is missing or not an object`];
  if (typeof item.title !== 'string' || !item.title.trim()) fail('title is empty');
  else if (item.title.length > MAX_TITLE_LENGTH) fail(`title longer than ${MAX_TITLE_LENGTH}`);
  if (!SLUG_PATTERN.test(String(item.slug || ''))) fail(`invalid slug "${item.slug}"`);
  if (!DOWNLOAD_KINDS.includes(item.kind)) fail(`unknown kind "${item.kind}"`);
  if (typeof item.description !== 'string' || !item.description.trim()) fail('description is empty');
  else if (item.description.length > MAX_DESCRIPTION_LENGTH) fail(`description longer than ${MAX_DESCRIPTION_LENGTH}`);
  if (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) {
    fail('tags must be an array of non-empty strings');
  } else if (item.tags.length > MAX_TAGS_PER_ITEM) fail(`more than ${MAX_TAGS_PER_ITEM} tags`);
  if (item.urlFix !== undefined && !SAFE_URL_PATTERN.test(item.urlFix)) fail('urlFix is not an http(s) URL');
  return problems;
}

/**
 * Validates one folder definition.
 * @param {Record<string, any>} folder
 * @returns {string[]}
 */
export function validateFolder(folder) {
  const label = `folder "${folder && folder.legacyName}"`;
  const problems = [];
  if (!folder || typeof folder.legacyName !== 'string' || !folder.legacyName) return [`${label}: legacyName missing`];
  if (typeof folder.name !== 'string' || !folder.name.trim()) problems.push(`${label}: name is empty`);
  if (!SLUG_PATTERN.test(String(folder.slug || ''))) problems.push(`${label}: invalid slug "${folder.slug}"`);
  if (!FOLDER_COLOR_KEYS.includes(folder.color)) problems.push(`${label}: unknown color "${folder.color}"`);
  if (!Number.isInteger(folder.order) || folder.order < 1) problems.push(`${label}: order must be a positive integer`);
  if (typeof folder.description !== 'string' || !folder.description.trim()) problems.push(`${label}: description is empty`);
  if (!Array.isArray(folder.keywords)) problems.push(`${label}: keywords must be an array`);
  return problems;
}

/**
 * Finds values that appear more than once.
 * @param {string[]} values
 * @returns {string[]}
 */
export function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) (seen.has(value) ? duplicates : seen).add(value);
  return [...duplicates];
}

/**
 * Cross-checks legacy documents against the enrichment file.
 * Returns every blocking problem; an empty list means it is safe to proceed.
 * @param {Array<{id: string, folder?: string, url?: string}>} legacyItems
 * @param {{folders: Array<Record<string, any>>, items: Record<string, Record<string, any>>}} enrichment
 * @returns {string[]}
 */
export function validateMigrationInput(legacyItems, enrichment) {
  const problems = [];
  const { folders = [], items = {} } = enrichment || {};
  const folderByLegacyName = new Map(folders.map((folder) => [folder.legacyName, folder]));

  folders.forEach((folder) => problems.push(...validateFolder(folder)));
  findDuplicates(folders.map((folder) => folder.slug)).forEach((slug) => problems.push(`duplicate folder slug "${slug}"`));
  findDuplicates(folders.map((folder) => folder.legacyName)).forEach((name) => problems.push(`duplicate folder legacyName "${name}"`));

  const legacyIds = new Set(legacyItems.map((item) => item.id));
  legacyItems.forEach((legacy) => {
    if (!items[legacy.id]) problems.push(`${legacy.id}: exists in Firestore but has no enrichment entry`);
    else problems.push(...validateEnrichedItem(legacy.id, items[legacy.id]));
    if (!folderByLegacyName.has(legacy.folder)) problems.push(`${legacy.id}: folder "${legacy.folder}" has no folder definition`);
    if (!SAFE_URL_PATTERN.test(String(legacy.url || '').trim())) problems.push(`${legacy.id}: legacy url is not http(s)`);
  });
  Object.keys(items).forEach((id) => {
    if (!legacyIds.has(id)) problems.push(`${id}: has an enrichment entry but no Firestore document`);
  });
  findDuplicates(Object.values(items).map((item) => item.slug)).forEach((slug) => problems.push(`duplicate item slug "${slug}"`));
  return problems;
}

/**
 * Builds the `downloadFolders/{slug}` document for one folder.
 * @param {Record<string, any>} folder
 * @param {unknown} updatedAt Timestamp value supplied by the caller.
 * @returns {{id: string, data: Record<string, unknown>}}
 */
export function buildFolderDoc(folder, updatedAt) {
  return {
    id: folder.slug,
    data: {
      name: folder.name,
      slug: folder.slug,
      color: folder.color,
      description: folder.description,
      keywords: folder.keywords,
      order: folder.order,
      updatedAt,
    },
  };
}

/**
 * Builds the fields merged into an existing `downloads/{id}` document.
 * Legacy fields are never deleted; originals that change are copied to
 * `legacyTitle` / `legacyUrl` so the migration can be reversed by hand.
 * @param {{id: string, title?: string, url?: string, folder?: string}} legacy
 * @param {Record<string, any>} enriched
 * @param {Record<string, any>} folder Matching folder definition.
 * @param {unknown} updatedAt Timestamp value supplied by the caller.
 * @returns {{id: string, data: Record<string, unknown>}}
 */
export function buildItemUpdate(legacy, enriched, folder, updatedAt) {
  const data = {
    title: enriched.title,
    slug: enriched.slug,
    folderId: folder.slug,
    kind: enriched.kind,
    description: enriched.description,
    tags: enriched.tags,
    updatedAt,
  };
  if (legacy.title !== enriched.title) data.legacyTitle = legacy.title ?? null;
  if (enriched.urlFix && enriched.urlFix !== legacy.url) {
    data.url = enriched.urlFix;
    data.legacyUrl = legacy.url;
  }
  return { id: legacy.id, data };
}

/**
 * Builds the complete migration plan (folders + items) from validated input.
 * @param {Array<Record<string, any>>} legacyItems
 * @param {Record<string, any>} enrichment
 * @param {unknown} updatedAt
 * @returns {{folders: Array<{id: string, data: Record<string, unknown>}>, items: Array<{id: string, data: Record<string, unknown>}>}}
 */
export function buildMigrationPlan(legacyItems, enrichment, updatedAt) {
  const folderByLegacyName = new Map(enrichment.folders.map((folder) => [folder.legacyName, folder]));
  return {
    folders: enrichment.folders.map((folder) => buildFolderDoc(folder, updatedAt)),
    items: legacyItems.map((legacy) =>
      buildItemUpdate(legacy, enrichment.items[legacy.id], folderByLegacyName.get(legacy.folder), updatedAt)),
  };
}

/**
 * Splits a list into chunks (Firestore batches hold at most 500 writes).
 * @template T
 * @param {T[]} list
 * @param {number} size
 * @returns {T[][]}
 */
export function chunk(list, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('chunk size must be a positive integer');
  const chunks = [];
  for (let start = 0; start < list.length; start += size) chunks.push(list.slice(start, start + size));
  return chunks;
}

/* ===== الجزء التنفيذي ===== */
const ENRICHMENT_FILE = new URL('./data/downloads-enrichment.json', import.meta.url);
const PLAN_FILE = 'migration-plan.json';
const DOWNLOADS_COLLECTION = 'downloads';
const FOLDERS_COLLECTION = 'downloadFolders';
const MAX_WRITES_PER_BATCH = 400;
const JSON_INDENT_SPACES = 2;
const DRY_RUN_TIMESTAMP_PLACEHOLDER = '<serverTimestamp>';

/** Reads a JSON file and gives a clear error when it is missing or malformed. */
async function readJson(fileLocation) {
  try {
    return JSON.parse(await readFile(fileLocation, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read JSON file "${String(fileLocation)}": ${error.message}`);
  }
}

/** Parses CLI flags: --apply, --from-export <file>. */
function parseArguments(argv) {
  const exportIndex = argv.indexOf('--from-export');
  const exportFile = exportIndex === -1 ? null : argv[exportIndex + 1];
  if (exportIndex !== -1 && !exportFile) throw new Error('--from-export needs a file path');
  const shouldApply = argv.includes('--apply');
  if (shouldApply && exportFile) throw new Error('--apply reads from Firestore; do not combine it with --from-export');
  return { shouldApply, exportFile };
}

/** Loads the legacy documents from Firestore (default) or from an export file. */
async function loadLegacyItems(exportFile) {
  if (exportFile) return readJson(exportFile);
  const snapshot = await getFirestore().collection(DOWNLOADS_COLLECTION).get();
  return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

/** Writes the plan in chunked batches using merge so legacy fields survive. */
async function applyPlan(plan) {
  const db = getFirestore();
  const writes = [
    ...plan.folders.map(({ id, data }) => ({ ref: db.collection(FOLDERS_COLLECTION).doc(id), data })),
    ...plan.items.map(({ id, data }) => ({ ref: db.collection(DOWNLOADS_COLLECTION).doc(id), data })),
  ];
  for (const group of chunk(writes, MAX_WRITES_PER_BATCH)) {
    const batch = db.batch();
    group.forEach(({ ref, data }) => batch.set(ref, data, { merge: true }));
    await batch.commit();
  }
  return writes.length;
}

/** Prints a short human summary of what the plan does. */
function printSummary(plan, shouldApply) {
  const kindCounts = plan.items.reduce((counts, { data }) => ({ ...counts, [data.kind]: (counts[data.kind] || 0) + 1 }), {});
  const changedUrls = plan.items.filter(({ data }) => data.legacyUrl).length;
  console.log(`${shouldApply ? 'APPLIED' : 'DRY RUN'}: ${plan.folders.length} folders, ${plan.items.length} items`);
  console.log('kinds:', JSON.stringify(kindCounts));
  console.log(`urls changed: ${changedUrls}`);
}

/** Entry point: validate, build plan, then either preview or apply. */
async function main() {
  const { shouldApply, exportFile } = parseArguments(process.argv.slice(2));
  const enrichment = await readJson(ENRICHMENT_FILE);
  if (shouldApply || !exportFile) initializeApp({ credential: applicationDefault() });

  const legacyItems = await loadLegacyItems(exportFile);
  const problems = validateMigrationInput(legacyItems, enrichment);
  if (problems.length) {
    console.error(`${problems.length} problem(s) — nothing was written:`);
    problems.forEach((problem) => console.error(` - ${problem}`));
    process.exitCode = 1;
    return;
  }

  const plan = buildMigrationPlan(legacyItems, enrichment, shouldApply ? FieldValue.serverTimestamp() : DRY_RUN_TIMESTAMP_PLACEHOLDER);
  if (shouldApply) {
    await applyPlan(plan);
  } else {
    await writeFile(PLAN_FILE, JSON.stringify(plan, null, JSON_INDENT_SPACES));
    console.log(`plan written to ${PLAN_FILE} (review it, then re-run with --apply)`);
  }
  printSummary(plan, shouldApply);
}

/* يعمل main فقط عند تشغيل الملف مباشرة، فيمكن للاختبارات استيراد الدوال النقية. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('migration failed:', error.message);
    process.exitCode = 1;
  });
}
