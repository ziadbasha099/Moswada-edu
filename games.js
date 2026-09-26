/* ============================================================
   GAMES.JS — loaded only by games.html
   ------------------------------------------------------------
   Currently this page only lists the available games (a single
   "Flashcards" card, marked "Coming soon" until that game is
   actually built). There is no game logic here yet — this file
   only handles the route guard, so no signed-out visitor ever
   sees the page flash before being redirected.

   When the Flashcards game is built, its logic should live in
   its own module (e.g. flashcards.js) and be wired up from the
   game-card's button here, instead of growing this file.
   ============================================================ */
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth } from "./shared.js";

/* ------------------------------------------------------------
   ROUTE GUARD — games are only for signed-in users, same as
   settings.html. Anyone without a session is sent back to the
   landing/auth page.
   ------------------------------------------------------------ */
onAuthStateChanged(auth, (user) => {
  if (user) {
    document.getElementById('gamesPage').classList.remove('hidden');
  } else {
    window.location.href = 'index.html';
  }
});
