/* ============================================================
   LINKS-COUNTER.JS
   ------------------------------------------------------------
   Creates links together with the per-user counter that
   firestore.rules relies on to enforce the 200-link limit:

     users/{uid}.linksCount  — must go up by exactly 1 in the SAME
                               commit that creates a link, and may
                               never exceed MAX_LINKS_PER_USER.

   Every place that creates users/{uid}/links/{id} must go through
   createLinkWithCounter(), otherwise firestore.rules rejects the
   write with "permission-denied". (dashboard.js has an identical
   private copy; it can import from here instead.)
   ============================================================ */
import {
  collection, doc, getDoc, setDoc, getCountFromServer, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./shared.js";

/** Must match the "<= 200" check in firestore.rules. */
export const MAX_LINKS_PER_USER = 200;

const LINK_LIMIT_ERROR_CODE = "permission-denied";

/** UIDs whose counter was already verified during this page session. */
const verifiedCounterUids = new Set();

/**
 * True when an error means "the 200-link limit was hit" (thrown by
 * createLinkWithCounter, or returned by firestore.rules as permission-denied).
 * @param {unknown} error
 * @returns {boolean}
 */
export function isLinkLimitError(error) {
  return Boolean(error) && error.code === LINK_LIMIT_ERROR_CODE;
}

/**
 * Makes sure users/{uid}.linksCount exists, initialising it from a real
 * server-side count. Never overwrites an existing numeric counter.
 * Throws on failure so callers don't create links against a wrong counter.
 * @param {string} uid
 * @returns {Promise<void>}
 */
export async function ensureLinksCounter(uid) {
  if (verifiedCounterUids.has(uid)) return;

  const userRef = doc(db, "users", uid);
  const userSnap = await getDoc(userRef);
  if (!(userSnap.exists() && typeof userSnap.data().linksCount === "number")) {
    const countSnap = await getCountFromServer(collection(db, "users", uid, "links"));
    await setDoc(userRef, { linksCount: countSnap.data().count }, { merge: true });
  }
  verifiedCounterUids.add(uid);
}

/**
 * Creates a link and bumps users/{uid}.linksCount in one atomic transaction.
 * Only ONE link per call: the rules accept a +1 counter change per commit.
 * @param {string} uid
 * @param {object} linkData  Link fields (createdAt is added here).
 * @returns {Promise<string>} The new link's document ID.
 * @throws {Error} With code "permission-denied" when the limit is reached.
 */
export async function createLinkWithCounter(uid, linkData) {
  const userRef = doc(db, "users", uid);
  const newLinkRef = doc(collection(db, "users", uid, "links"));

  await runTransaction(db, async (transaction) => {
    const userSnap = await transaction.get(userRef);
    const currentCount = (userSnap.exists() && typeof userSnap.data().linksCount === "number")
      ? userSnap.data().linksCount
      : 0;

    if (currentCount >= MAX_LINKS_PER_USER) {
      throw Object.assign(new Error("Link limit reached"), { code: LINK_LIMIT_ERROR_CODE });
    }

    transaction.set(userRef, { linksCount: currentCount + 1 }, { merge: true });
    transaction.set(newLinkRef, { ...linkData, createdAt: serverTimestamp() });
  });

  return newLinkRef.id;
}
