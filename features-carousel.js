/* ============================================================
   FEATURES-CAROUSEL.JS — loaded only by index.html
   ------------------------------------------------------------
   Behavior for the horizontal screenshot carousel (#fcCarousel):
   arrows, dots, mouse drag, keyboard arrows, and a graceful
   placeholder when a screenshot file is missing.
   Scrolling/snapping itself is native CSS (scroll-snap); this
   file only adds navigation on top of it. RTL-safe: it relies on
   scrollLeft deltas, which are physical in every browser.
   ============================================================ */

const DRAG_THRESHOLD_PX = 5;
const ACTIVE_DOT_CLASS = 'is-active';
const DRAGGING_CLASS = 'is-dragging';
const SCROLL_END_TOLERANCE_PX = 4;

const track = document.getElementById('fcTrack');
const dotsContainer = document.getElementById('fcDots');
const prevButton = document.getElementById('fcPrev');
const nextButton = document.getElementById('fcNext');

/** @returns {HTMLElement[]} all slide cards in DOM order. */
function getCards() {
  return Array.from(track.querySelectorAll('.fc-card'));
}

/** @returns {boolean} true when the page is laid out right-to-left. */
function isRtl() {
  return document.documentElement.dir === 'rtl';
}

/**
 * Distance between the start of two neighbouring cards (card width + gap).
 * @returns {number}
 */
function getStepWidth() {
  const cards = getCards();
  if (cards.length < 2) return cards[0] ? cards[0].offsetWidth : 0;
  return Math.abs(cards[1].offsetLeft - cards[0].offsetLeft);
}

/**
 * Index of the card currently snapped at the start edge.
 * @returns {number}
 */
function getActiveIndex() {
  const step = getStepWidth();
  if (!step) return 0;
  const index = Math.round(Math.abs(track.scrollLeft) / step);
  return Math.min(Math.max(index, 0), getCards().length - 1);
}

/**
 * Smoothly scrolls so the card at `index` sits at the start edge.
 * @param {number} index
 */
function goToIndex(index) {
  const lastIndex = getCards().length - 1;
  const safeIndex = Math.min(Math.max(index, 0), lastIndex);
  const direction = isRtl() ? -1 : 1; // scrollLeft is negative in RTL
  track.scrollTo({ left: direction * safeIndex * getStepWidth(), behavior: 'smooth' });
}

/** Creates one dot button per card. */
function buildDots() {
  dotsContainer.replaceChildren(...getCards().map((_, index) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'fc-dot';
    dot.setAttribute('role', 'tab');
    dot.setAttribute('aria-label', String(index + 1));
    dot.addEventListener('click', () => goToIndex(index));
    return dot;
  }));
}

/** Syncs dots and arrow disabled-state with the current scroll position. */
function updateControls() {
  const activeIndex = getActiveIndex();
  const maxScroll = track.scrollWidth - track.clientWidth;
  const atStart = Math.abs(track.scrollLeft) <= SCROLL_END_TOLERANCE_PX;
  const atEnd = Math.abs(track.scrollLeft) >= maxScroll - SCROLL_END_TOLERANCE_PX;

  Array.from(dotsContainer.children).forEach((dot, index) => {
    const isActive = index === activeIndex;
    dot.classList.toggle(ACTIVE_DOT_CLASS, isActive);
    dot.setAttribute('aria-selected', String(isActive));
  });
  prevButton.disabled = atStart;
  nextButton.disabled = atEnd;
}

/* ---------------- Mouse drag (touch already scrolls natively) ---------------- */
let dragStartX = 0;
let dragStartScroll = 0;
let isPointerDown = false;
let hasDragged = false;

function handlePointerDown(event) {
  if (event.pointerType !== 'mouse') return;
  isPointerDown = true;
  hasDragged = false;
  dragStartX = event.clientX;
  dragStartScroll = track.scrollLeft;
}

function handlePointerMove(event) {
  if (!isPointerDown) return;
  const deltaX = event.clientX - dragStartX;
  if (!hasDragged && Math.abs(deltaX) > DRAG_THRESHOLD_PX) {
    hasDragged = true;
    track.classList.add(DRAGGING_CLASS);
  }
  if (hasDragged) track.scrollLeft = dragStartScroll - deltaX;
}

function handlePointerUp() {
  if (!isPointerDown) return;
  isPointerDown = false;
  track.classList.remove(DRAGGING_CLASS);
  if (hasDragged) goToIndex(getActiveIndex()); // re-snap to the nearest card
}

/* ---------------- Keyboard ---------------- */
function handleKeydown(event) {
  const forwardKey = isRtl() ? 'ArrowLeft' : 'ArrowRight';
  const backwardKey = isRtl() ? 'ArrowRight' : 'ArrowLeft';
  if (event.key === forwardKey) { event.preventDefault(); goToIndex(getActiveIndex() + 1); }
  else if (event.key === backwardKey) { event.preventDefault(); goToIndex(getActiveIndex() - 1); }
}

/* ---------------- Missing screenshot fallback ---------------- */
/** Hides a broken <img> so the card's soft gradient background shows instead. */
function handleImageError(event) {
  event.target.style.visibility = 'hidden';
}

/** Wires everything up; no-ops if the section isn't on the page. */
function initCarousel() {
  if (!track || !dotsContainer || !prevButton || !nextButton) return;

  buildDots();
  prevButton.addEventListener('click', () => goToIndex(getActiveIndex() - 1));
  nextButton.addEventListener('click', () => goToIndex(getActiveIndex() + 1));

  track.addEventListener('scroll', () => requestAnimationFrame(updateControls), { passive: true });
  track.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  track.addEventListener('keydown', handleKeydown);
  track.querySelectorAll('img').forEach((img) => img.addEventListener('error', handleImageError));
  window.addEventListener('resize', updateControls);

  // Block the click that ends a drag from activating anything inside a card.
  track.addEventListener('click', (event) => {
    if (hasDragged) { event.preventDefault(); event.stopPropagation(); hasDragged = false; }
  }, true);

  updateControls();
}

initCarousel();
