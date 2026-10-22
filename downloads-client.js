/* ============================================================
   downloads-client.js — tiny progressive enhancement for /downloads
   ------------------------------------------------------------
   The pages are complete HTML without this file. It only adds:
   - search + tag filtering over elements marked [data-filter-item]
   - the light/dark toggle (shares localStorage key "theme-preference"
     with the rest of the site)
   No Firebase, no network requests, no frameworks.
   ============================================================ */
(function () {
  'use strict';

  var THEME_KEY = 'theme-preference';
  var QUERY_PARAM = 'q';
  var TAG_PARAM = 'tag';
  var DEBOUNCE_MS = 120;

  /** Same normalisation as normalizeArabic() in api/_downloads-core.js (a test keeps them equal). */
  function normalizeArabic(text) {
    return String(text == null ? '' : text)
      .toLowerCase()
      .replace(/[ً-ٰٟـ]/g, '')
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/[٠-٩]/g, function (digit) { return String(digit.charCodeAt(0) - 0x0660); })
      .replace(/[۰-۹]/g, function (digit) { return String(digit.charCodeAt(0) - 0x06F0); })
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Does an element's data-search contain every word of the query, and its data-tags the chosen tag? */
  function matches(element, words, tag) {
    var haystack = element.getAttribute('data-search') || '';
    for (var i = 0; i < words.length; i += 1) {
      if (haystack.indexOf(words[i]) === -1) return false;
    }
    if (!tag) return true;
    return (element.getAttribute('data-tags') || '').split('|').indexOf(tag) !== -1;
  }

  /** Formats a count in Arabic-Indic digits. */
  function arabicNumber(value) {
    return new Intl.NumberFormat('ar-EG').format(value);
  }

  function initTheme() {
    var button = document.getElementById('themeToggle');
    if (!button) return;
    button.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(THEME_KEY, next); } catch (error) { /* private mode: the choice just isn't remembered */ }
    });
  }

  function initFilter() {
    var input = document.getElementById('searchInput');
    if (!input) return;
    var status = document.getElementById('resultsStatus');
    var elements = Array.prototype.slice.call(document.querySelectorAll('[data-filter-item]'));
    var chips = Array.prototype.slice.call(document.querySelectorAll('.tag-chip'));
    var sections = Array.prototype.slice.call(document.querySelectorAll('.section'));
    var emptyMessages = Array.prototype.slice.call(document.querySelectorAll('[data-empty]'));
    var activeTag = '';
    var timer = null;

    function apply() {
      var words = normalizeArabic(input.value).split(' ').filter(Boolean);
      var isFiltering = words.length > 0 || activeTag !== '';
      var visible = 0;
      elements.forEach(function (element) {
        var show = matches(element, words, activeTag);
        element.hidden = !show;
        if (show && element.classList.contains('item-card')) visible += 1;
      });
      sections.forEach(function (section) {
        var cards = section.querySelectorAll('[data-filter-item]');
        if (!cards.length) return;
        var anyVisible = Array.prototype.some.call(cards, function (card) { return !card.hidden; });
        section.hidden = !anyVisible && isFiltering && !section.querySelector('[data-empty]');
        var empty = section.querySelector('[data-empty]');
        if (empty) empty.hidden = anyVisible || !isFiltering;
      });
      if (status) status.textContent = isFiltering ? (visible ? arabicNumber(visible) + ' نتيجة' : 'لا توجد نتائج') : '';
      syncUrl(input.value, activeTag);
    }

    function syncUrl(query, tag) {
      try {
        var params = new URLSearchParams();
        if (query.trim()) params.set(QUERY_PARAM, query.trim());
        if (tag) params.set(TAG_PARAM, tag);
        var search = params.toString();
        history.replaceState(null, '', location.pathname + (search ? '?' + search : ''));
      } catch (error) { /* history may be unavailable in sandboxed frames */ }
    }

    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(apply, DEBOUNCE_MS);
    });
    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        var tag = chip.getAttribute('data-tag');
        activeTag = activeTag === tag ? '' : tag;
        chips.forEach(function (other) { other.setAttribute('aria-pressed', String(other.getAttribute('data-tag') === activeTag)); });
        apply();
      });
    });

    var params = new URLSearchParams(location.search);
    input.value = params.get(QUERY_PARAM) || '';
    var initialTag = normalizeArabic(params.get(TAG_PARAM) || '');
    chips.forEach(function (chip) {
      if (initialTag && chip.getAttribute('data-tag') === initialTag) {
        activeTag = initialTag;
        chip.setAttribute('aria-pressed', 'true');
      }
    });
    if (input.value || activeTag) apply();
  }

  initTheme();
  initFilter();
})();
