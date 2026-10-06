/* ============================================================
   /api/playlist?id=PLAYLIST_ID — Vercel serverless function
   ------------------------------------------------------------
   Returns the playable videos of a public/unlisted YouTube
   playlist so the dashboard can import them as link cards.

   Environment variables (Vercel → Settings → Environment Variables):
     YOUTUBE_API_KEY       YouTube Data API v3 key (secret, server only)
     FIREBASE_WEB_API_KEY  the public "apiKey" from firebase-config.js,
                           used only to verify the caller's ID token

   Security:
   - Only signed-in users (valid Firebase ID token) may call it, so
     strangers cannot drain the free YouTube quota.
   - The playlist ID is validated before it is used.
   - Upstream error bodies are never forwarded to the client.
   ============================================================ */
const { isValidPlaylistId, toPlayableVideos, MAX_VIDEOS_PER_IMPORT } = require('./_playlist-utils');

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const TOKEN_LOOKUP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup';
const PAGE_SIZE = 50;
const CACHE_SECONDS = 300;
const HTTP = { OK: 200, BAD_REQUEST: 400, UNAUTHORIZED: 401, NOT_FOUND: 404, METHOD: 405, QUOTA: 429, SERVER: 500, BAD_GATEWAY: 502 };

/** Error carrying an HTTP status and a stable machine-readable code. */
class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/**
 * Verifies the Firebase ID token in the Authorization header.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<void>} Resolves if the token is valid, throws ApiError otherwise.
 */
async function requireSignedInUser(req) {
  const header = req.headers.authorization || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7) : '';
  const firebaseKey = process.env.FIREBASE_WEB_API_KEY;
  if (!firebaseKey) throw new ApiError(HTTP.SERVER, 'server_not_configured');
  if (!idToken) throw new ApiError(HTTP.UNAUTHORIZED, 'unauthorized');

  const response = await fetch(`${TOKEN_LOOKUP_URL}?key=${encodeURIComponent(firebaseKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!response.ok) throw new ApiError(HTTP.UNAUTHORIZED, 'unauthorized');
}

/**
 * Calls one YouTube Data API endpoint, translating failures into ApiError.
 * @param {string} path   e.g. "/playlistItems"
 * @param {Record<string,string>} params
 * @returns {Promise<object>}
 */
async function callYouTube(path, params) {
  const url = `${YOUTUBE_API_BASE}${path}?${new URLSearchParams(params)}`;
  const response = await fetch(url, { headers: { 'x-goog-api-key': process.env.YOUTUBE_API_KEY } });
  if (response.ok) return response.json();

  const body = await response.json().catch(() => ({}));
  const reason = body?.error?.errors?.[0]?.reason;
  console.error('YouTube API error:', response.status, reason);
  if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded') throw new ApiError(HTTP.QUOTA, 'quota_exceeded');
  if (response.status === 404 || reason === 'playlistNotFound' || reason === 'playlistItemsNotAccessible') {
    throw new ApiError(HTTP.NOT_FOUND, 'playlist_not_found');
  }
  throw new ApiError(HTTP.BAD_GATEWAY, 'upstream_error');
}

/**
 * Fetches the playlist title (1 quota unit).
 * @param {string} playlistId
 * @returns {Promise<string>}
 */
async function fetchPlaylistTitle(playlistId) {
  const data = await callYouTube('/playlists', { part: 'snippet', id: playlistId });
  const title = data?.items?.[0]?.snippet?.title;
  if (!title) throw new ApiError(HTTP.NOT_FOUND, 'playlist_not_found');
  return String(title).slice(0, 100);
}

/**
 * Pages through playlistItems until the playlist ends or the cap is reached.
 * @param {string} playlistId
 * @returns {Promise<{videos: object[], truncated: boolean}>}
 */
async function fetchPlaylistVideos(playlistId) {
  const videos = [];
  let pageToken = '';
  do {
    const params = { part: 'snippet,status', maxResults: String(PAGE_SIZE), playlistId };
    if (pageToken) params.pageToken = pageToken;
    const page = await callYouTube('/playlistItems', params);
    videos.push(...toPlayableVideos(page.items));
    pageToken = page.nextPageToken || '';
  } while (pageToken && videos.length < MAX_VIDEOS_PER_IMPORT);

  return { videos: videos.slice(0, MAX_VIDEOS_PER_IMPORT), truncated: Boolean(pageToken) || videos.length > MAX_VIDEOS_PER_IMPORT };
}

/** Vercel entry point. */
module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') throw new ApiError(HTTP.METHOD, 'method_not_allowed');
    if (!process.env.YOUTUBE_API_KEY) throw new ApiError(HTTP.SERVER, 'server_not_configured');

    const playlistId = req.query.id;
    if (!isValidPlaylistId(playlistId)) throw new ApiError(HTTP.BAD_REQUEST, 'invalid_playlist_id');

    await requireSignedInUser(req);

    const [title, { videos, truncated }] = await Promise.all([
      fetchPlaylistTitle(playlistId),
      fetchPlaylistVideos(playlistId),
    ]);

    res.setHeader('Cache-Control', `private, max-age=${CACHE_SECONDS}`);
    res.status(HTTP.OK).json({ title, videos, truncated });
  } catch (err) {
    if (!(err instanceof ApiError)) console.error('playlist handler failed:', err);
    const status = err instanceof ApiError ? err.status : HTTP.SERVER;
    const code = err instanceof ApiError ? err.code : 'internal_error';
    res.status(status).json({ error: code });
  }
};
