/* ============================================================
   /api/downloads — Vercel serverless function
   ------------------------------------------------------------
   One function serves four public URLs (see vercel.json rewrites):
     /downloads                 → ?view=home
     /downloads/:folder         → ?view=folder&folder=…
     /downloads/:folder/:slug   → ?view=item&folder=…&slug=…
     /sitemap.xml               → ?view=sitemap

   It reads `downloadFolders` and `downloads` from Firestore with the
   Admin SDK (so the pages are real HTML for search engines and AI
   crawlers, and App Check enforcement on the web SDK does not apply),
   then renders them with api/_downloads-core.js.

   Environment variable (Vercel → Settings → Environment Variables):
     FIREBASE_SERVICE_ACCOUNT_JSON   the full service-account JSON (secret)

   Caching: the CDN keeps a page for 5 minutes and may serve a stale copy
   for a day while it refreshes in the background, so Firestore is read
   rarely and an admin edit shows up within about 5 minutes.
   ============================================================ */
'use strict';

const {
  ERROR_CACHE_CONTROL, buildCatalog, renderNotFound, renderUnavailable, route, securityHeaders,
} = require('./_downloads-core');

const FOLDERS_COLLECTION = 'downloadFolders';
const DOWNLOADS_COLLECTION = 'downloads';
const MEMORY_CACHE_MS = 60 * 1000;
const ALLOWED_METHODS = ['GET', 'HEAD'];
const HTTP = { OK: 200, METHOD_NOT_ALLOWED: 405, UNAVAILABLE: 503 };
const CONTENT_TYPES = { html: 'text/html; charset=utf-8', xml: 'application/xml; charset=utf-8' };

/** Raised when the deployment is missing its Firebase credentials. */
class ConfigError extends Error {}

let memory = { at: 0, catalog: null };

/**
 * Lazily creates the Firestore Admin client from the service-account env var.
 * @returns {import('firebase-admin/firestore').Firestore}
 */
function getDb() {
  const { initializeApp, getApps, cert } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new ConfigError('FIREBASE_SERVICE_ACCOUNT_JSON is not set');
    let credentials;
    try {
      credentials = JSON.parse(raw);
    } catch {
      throw new ConfigError('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
    initializeApp({ credential: cert(credentials) });
  }
  return getFirestore();
}

/**
 * Reads both collections and builds the catalog (with a short in-memory cache
 * so a burst of requests on one warm instance reads Firestore once).
 * @param {number} [now] Current time in ms (injectable for tests).
 */
async function loadCatalogFromFirestore(now = Date.now()) {
  if (memory.catalog && now - memory.at < MEMORY_CACHE_MS) return memory.catalog;
  const db = getDb();
  const [folderSnap, itemSnap] = await Promise.all([
    db.collection(FOLDERS_COLLECTION).get(),
    db.collection(DOWNLOADS_COLLECTION).get(),
  ]);
  const toDocs = (snap) => snap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
  const catalog = buildCatalog(toDocs(folderSnap), toDocs(itemSnap));
  if (catalog.dropped) console.warn(`downloads: ${catalog.dropped} invalid document(s) skipped`);
  memory = { at: now, catalog };
  return catalog;
}

/** Sends a finished response (HEAD gets headers only). */
function send(req, res, { status, type, body, cache }) {
  const headers = { ...securityHeaders(), 'Content-Type': CONTENT_TYPES[type], 'Cache-Control': cache };
  Object.entries(headers).forEach(([name, value]) => res.setHeader(name, value));
  res.statusCode = status;
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * Builds the request handler. `loadCatalog` is injectable so tests can run
 * the whole pipeline without Firebase.
 * @param {{loadCatalog?: () => Promise<ReturnType<typeof buildCatalog>>}} [options]
 */
function createHandler({ loadCatalog = loadCatalogFromFirestore } = {}) {
  return async function handler(req, res) {
    if (!ALLOWED_METHODS.includes(req.method)) {
      res.setHeader('Allow', ALLOWED_METHODS.join(', '));
      return send(req, res, { status: HTTP.METHOD_NOT_ALLOWED, type: 'html', body: renderUnavailable(), cache: ERROR_CACHE_CONTROL });
    }
    try {
      const catalog = await loadCatalog();
      return send(req, res, route(req.query || {}, catalog));
    } catch (error) {
      // Log the reason server-side only; visitors get a generic page.
      console.error('downloads render failed:', error instanceof ConfigError ? error.message : error);
      return send(req, res, { status: HTTP.UNAVAILABLE, type: 'html', body: renderUnavailable(), cache: ERROR_CACHE_CONTROL });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.renderNotFound = renderNotFound;
