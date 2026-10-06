/* ============================================================
   _playlist-utils.js — pure helpers for api/playlist.js
   ------------------------------------------------------------
   The leading underscore keeps Vercel from exposing this file
   as its own endpoint. Everything here is side-effect free so
   it can be unit-tested without network access.
   ============================================================ */

/** YouTube playlist IDs are 13-64 chars of [A-Za-z0-9_-] (PL..., UU..., OLAK5uy_...). */
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{13,64}$/;

/** Privacy states whose videos can be played by an ordinary viewer. */
const PLAYABLE_PRIVACY_STATUSES = new Set(['public', 'unlisted']);

/** Hard cap on videos returned per import (4 API pages of 50). */
const MAX_VIDEOS_PER_IMPORT = 200;

/**
 * Checks that a value looks like a YouTube playlist ID.
 * @param {unknown} playlistId
 * @returns {boolean}
 */
function isValidPlaylistId(playlistId) {
  return typeof playlistId === 'string' && PLAYLIST_ID_PATTERN.test(playlistId);
}

/**
 * Converts one playlistItems.list item into the small shape the client needs.
 * Returns null for private/deleted/unavailable entries.
 * @param {object} item  Raw item from the YouTube Data API.
 * @returns {{videoId: string, title: string}|null}
 */
function toPlayableVideo(item) {
  const videoId = item?.snippet?.resourceId?.videoId;
  const privacyStatus = item?.status?.privacyStatus;
  if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return null;
  if (!PLAYABLE_PRIVACY_STATUSES.has(privacyStatus)) return null;
  return { videoId, title: String(item.snippet.title || '').slice(0, 200) };
}

/**
 * Maps a list of raw API items to playable videos, skipping unusable ones.
 * @param {object[]} items
 * @returns {{videoId: string, title: string}[]}
 */
function toPlayableVideos(items) {
  return (Array.isArray(items) ? items : []).map(toPlayableVideo).filter(Boolean);
}

module.exports = {
  isValidPlaylistId,
  toPlayableVideo,
  toPlayableVideos,
  MAX_VIDEOS_PER_IMPORT,
};
