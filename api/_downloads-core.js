/* ============================================================
   api/_downloads-core.js — pure rendering logic for the downloads pages
   ------------------------------------------------------------
   No Firebase and no network here: it turns an in-memory "catalog"
   (folders + items) into HTML, JSON-LD and sitemap XML. That keeps it
   fast to test. The `_` prefix tells Vercel this is a helper, not an
   endpoint. api/downloads.js loads the data and calls these functions.

   Security rules followed everywhere:
   - every dynamic value goes through esc() before it is put in HTML;
   - URLs are only emitted after isSafeUrl();
   - colors/kinds are looked up in whitelists and only emitted as CSS
     class names (no inline styles, so the CSP can forbid them);
   - JSON-LD is serialised with "<" escaped so it cannot close the tag.
   ============================================================ */
'use strict';

const crypto = require('node:crypto');

/* ---------------- Constants ---------------- */
const SITE_URL = (process.env.SITE_URL || 'https://moswada-edu.vercel.app').replace(/\/+$/, '');
const SITE_NAME = 'مسودة التعليمي';
const SITE_NAME_EN = 'Moswada-edu';
const OG_IMAGE_PATH = '/info-photo.png';
const OG_IMAGE_WIDTH = 2560;
const OG_IMAGE_HEIGHT = 1426;
const LOGO_PATH = '/moswada-logo.png';
const FACEBOOK_URL = 'https://www.facebook.com/share/186chKu8po/';
const PRIVACY_PATH = '/privacy%20and%20policy%20of%20moswada-edu.html';
const DEVELOPER_NAME = 'Ziad Basha';
const DEVELOPER_URL = 'https://ziad-basha-website.vercel.app/';
const GA_MEASUREMENT_ID = 'G-6DK191VFN4';
const ASSET_VERSION = '1';

const MAX_TITLE_LENGTH = 60;
const MAX_META_DESCRIPTION_LENGTH = 155;
const MAX_LIST_ITEMS_IN_JSON_LD = 100;
const MAX_HOME_FILE_ROWS = 120;
const MAX_TAG_CHIPS = 14;
const MAX_RELATED_ITEMS = 6;
const HTML_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400';
const ERROR_CACHE_CONTROL = 'no-store';
const NOT_FOUND_CACHE_CONTROL = 'public, max-age=0, s-maxage=60';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Kinds (must match download-kinds.js; tests/downloads-pages.test.mjs checks it). */
const KINDS = Object.freeze({
  summary: { label: 'ملخص', forms: ['ملخص واحد', 'ملخصان', 'ملخصات', 'ملخصاً'], action: 'download' },
  mindmap: { label: 'خريطة ذهنية', forms: ['خريطة ذهنية واحدة', 'خريطتان ذهنيتان', 'خرائط ذهنية', 'خريطة ذهنية'], action: 'download' },
  book: { label: 'كتاب', forms: ['كتاب واحد', 'كتابان', 'كتب', 'كتاباً'], action: 'download' },
  files: { label: 'ملفات ومواد', forms: ['حزمة ملفات', 'حزمتا ملفات', 'حزم ملفات', 'حزمة ملفات'], action: 'download' },
  website: { label: 'موقع', forms: ['موقع واحد', 'موقعان', 'مواقع', 'موقعاً'], action: 'visit' },
});
const FOLDER_COLOR_KEYS = Object.freeze(['teal', 'terracotta', 'clay', 'blue', 'purple', 'green', 'rose', 'gold']);
const FILE_FORMS = ['ملف واحد', 'ملفان', 'ملفات', 'ملفاً'];
const FOLDER_FORMS = ['مجلد واحد', 'مجلدان', 'مجلدات', 'مجلداً'];

/** Stroke icons for each kind (static strings, never built from data). */
const KIND_ICONS = Object.freeze({
  summary: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  mindmap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M8.2 7l7.6 3.8M8.2 17l7.6-3.8"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M4 21V5M9 7h6"/></svg>',
  files: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
  website: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>',
});
const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>';
const ICON_EXTERNAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4"/></svg>';
const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';
const ICON_THEME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>';
const ICON_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5m0 0l6-6m-6 6l6 6"/></svg>';

/** Visible FAQ (the FAQPage JSON-LD is built from this same list, so they always match). */
const HOME_FAQ = Object.freeze([
  {
    question: 'هل الملفات والمواقع في هذه المكتبة مجانية؟',
    answer: 'نعم، لا تحتاج إلى حساب ولا تسجيل دخول لفتح أي رابط في المكتبة. بعض المواقع الخارجية المذكورة قد تطلب اشتراكاً من جهتها لبعض محتواها، وننبّه إلى ذلك في وصف الصفحة المعنية.',
  },
  {
    question: 'أين تُحفظ الملفات وماذا يحدث عند الضغط على «تحميل»؟',
    answer: 'مسودة التعليمي لا تستضيف الملفات بنفسها. زر «تحميل» يفتح رابط الملف على موقع التخزين الذي رُفع عليه (غالباً Mega أو Google Drive) في نافذة جديدة، ويظهر اسم هذا الموقع في صفحة كل ملف قبل أن تضغط.',
  },
  {
    question: 'ما الفرق بين الملخص والخريطة الذهنية والكتاب؟',
    answer: 'الملخص ورقة مكتوبة تجمع أهم النقاط للمراجعة السريعة. الخريطة الذهنية رسم مترابط يوضح علاقات الأفكار ببعضها ويسهّل الحفظ. الكتاب مرجع كامل للمادة. أما «ملفات ومواد» فمجلد يضم عدة ملفات معاً، و«موقع» رابط لموقع تعليمي تستعمله مباشرة.',
  },
  {
    question: 'كيف أبلّغ عن رابط لا يعمل أو أقترح ملفاً؟',
    answer: 'راسلنا عبر صفحة مسودة التعليمي على فيسبوك، وأخبرنا باسم الملف أو الرابط. نراجع البلاغات ونحدّث الصفحة.',
  },
]);

/* ---------------- Small helpers ---------------- */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for HTML (text nodes and double/single-quoted attributes). */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** Serialises JSON for a <script type="application/ld+json"> block. */
function jsonLd(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Accepts only absolute http(s) URLs with a dotted host and no credentials. */
function isSafeUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.hostname.includes('.') && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** @returns {string} Host without "www." (for display), or '' when unparsable. */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Normalises Arabic text for forgiving search: removes diacritics/tatweel,
 * unifies alef/yaa/taa-marbuta forms, maps Arabic-Indic digits to Latin and
 * lower-cases Latin letters. downloads-client.js has the same function
 * (tests keep both identical).
 */
function normalizeArabic(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06F0))
    .replace(/\s+/g, ' ')
    .trim();
}

const numberFormat = new Intl.NumberFormat('ar-EG');
/** Formats a number with Arabic-Indic digits. */
function num(value) {
  return numberFormat.format(value);
}

/** Arabic count phrase: 1 → forms[0], 2 → forms[1], 3–10 → "٥ forms[2]", else "١١ forms[3]". */
function countPhrase(count, forms) {
  if (count === 1) return forms[0];
  if (count === 2) return forms[1];
  return `${num(count)} ${count >= 3 && count <= 10 ? forms[2] : forms[3]}`;
}

const dateFormat = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'long', timeZone: 'Africa/Cairo' });
/** @param {Date | null} date @returns {string} Long Arabic date, or ''. */
function formatDate(date) {
  return date ? dateFormat.format(date) : '';
}
/** @param {Date | null} date @returns {string} YYYY-MM-DD (UTC), or ''. */
function isoDay(date) {
  return date ? date.toISOString().slice(0, 10) : '';
}

/** Shortens text to maxLength characters at a word boundary, adding "…". */
function truncate(text, maxLength) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  const cut = clean.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s،,.:؛-]+$/, '')}…`;
}

/** "main | site" when it fits in 60 characters, otherwise the shortened main part. */
function buildTitle(main) {
  const full = `${main} | ${SITE_NAME}`;
  return full.length <= MAX_TITLE_LENGTH ? full : truncate(main, MAX_TITLE_LENGTH);
}

/* ---------------- Catalog ---------------- */
/** Converts a Firestore Timestamp, Date, ISO string or millis to Date (or null). */
function toDate(value) {
  if (!value) return null;
  const date = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const compareText = (a, b) => String(a).localeCompare(String(b), 'ar');
const compareNewest = (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0) || compareText(a.title, b.title);

/**
 * Builds the catalog used by every page from raw Firestore documents.
 * Invalid documents (missing slug, unknown folder, unsafe URL...) are dropped
 * and counted in `dropped`, so one bad record can never break a page.
 * @param {Array<{id: string, data: Record<string, any>}>} folderDocs
 * @param {Array<{id: string, data: Record<string, any>}>} itemDocs
 */
function buildCatalog(folderDocs, itemDocs) {
  let dropped = 0;
  const folders = [];
  const seenFolderSlugs = new Set();
  for (const { id, data } of folderDocs) {
    const slug = String(data.slug || id);
    const valid = SLUG_PATTERN.test(slug) && typeof data.name === 'string' && data.name.trim()
      && FOLDER_COLOR_KEYS.includes(data.color) && !seenFolderSlugs.has(slug);
    if (!valid) { dropped += 1; continue; }
    seenFolderSlugs.add(slug);
    folders.push({
      slug,
      name: data.name.trim(),
      color: data.color,
      order: Number.isFinite(Number(data.order)) ? Number(data.order) : 999,
      description: String(data.description || '').trim(),
      keywords: Array.isArray(data.keywords) ? data.keywords.filter((k) => typeof k === 'string' && k.trim()) : [],
      items: [],
    });
  }
  folders.sort((a, b) => a.order - b.order || compareText(a.name, b.name));
  const folderBySlug = new Map(folders.map((folder) => [folder.slug, folder]));

  const items = [];
  const seenItemKeys = new Set();
  for (const { id, data } of itemDocs) {
    const folder = folderBySlug.get(data.folderId);
    const key = `${data.folderId}/${data.slug}`;
    const valid = folder && SLUG_PATTERN.test(String(data.slug || '')) && KINDS[data.kind]
      && typeof data.title === 'string' && data.title.trim() && isSafeUrl(data.url) && !seenItemKeys.has(key);
    if (!valid) { dropped += 1; continue; }
    seenItemKeys.add(key);
    const item = {
      id,
      slug: data.slug,
      title: data.title.trim(),
      url: data.url,
      host: hostOf(data.url),
      kind: data.kind,
      description: String(data.description || '').trim(),
      tags: Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === 'string' && t.trim()) : [],
      folder,
      createdAt: toDate(data.createdAt),
      updatedAt: toDate(data.updatedAt) || toDate(data.createdAt),
    };
    items.push(item);
    folder.items.push(item);
  }
  items.sort(compareNewest);
  folders.forEach((folder) => folder.items.sort(compareNewest));

  const tagCounts = new Map();
  items.forEach((item) => item.tags.forEach((tag) => tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)));
  const tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .map(([tag, count]) => ({ tag, count }));

  const stamps = items.map((item) => item.updatedAt?.getTime()).filter(Boolean);
  return { folders, items, tags, dropped, updatedAt: stamps.length ? new Date(Math.max(...stamps)) : null };
}

/** Counts items per kind, e.g. {summary: 17, mindmap: 15}. */
function kindCounts(items) {
  return items.reduce((counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] || 0) + 1 }), {});
}

/** "١٧ ملخصاً، ١٥ خريطة ذهنية" in the order of KINDS. */
function kindSummary(items) {
  const counts = kindCounts(items);
  return Object.keys(KINDS).filter((kind) => counts[kind]).map((kind) => countPhrase(counts[kind], KINDS[kind].forms));
}

/* ---------------- URLs ---------------- */
const urls = {
  home: () => `${SITE_URL}/downloads`,
  folder: (folder) => `${SITE_URL}/downloads/${folder.slug}`,
  item: (item) => `${SITE_URL}/downloads/${item.folder.slug}/${item.slug}`,
};
const path = {
  home: () => '/downloads',
  folder: (folder) => `/downloads/${folder.slug}`,
  item: (item) => `/downloads/${item.folder.slug}/${item.slug}`,
};

/* ---------------- Inline scripts + CSP ---------------- */
const THEME_INIT_SCRIPT = "(function(){var d=document.documentElement;d.classList.add('js');try{var p=localStorage.getItem('theme-preference')||'system';var t=p==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):p;d.setAttribute('data-theme',t==='dark'?'dark':'light');}catch(e){d.setAttribute('data-theme','light');}})();";
const GA_INIT_SCRIPT = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_MEASUREMENT_ID}');`;

/** sha256 source for a CSP script-src entry. */
function cspHash(script) {
  return `'sha256-${crypto.createHash('sha256').update(script, 'utf8').digest('base64')}'`;
}

/** Content-Security-Policy for these pages (scripts: own file, two hashed inline blocks, Google Analytics). */
function buildCsp() {
  return [
    "default-src 'self'",
    `script-src 'self' ${cspHash(THEME_INIT_SCRIPT)} ${cspHash(GA_INIT_SCRIPT)} https://www.googletagmanager.com`,
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://www.google-analytics.com https://www.googletagmanager.com",
    "connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Security headers shared by every response of these pages. */
function securityHeaders() {
  return {
    'Content-Security-Policy': buildCsp(),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
}

/* ---------------- Layout ---------------- */
const ORGANIZATION_ID = `${SITE_URL}/#organization`;
const WEBSITE_ID = `${SITE_URL}/#website`;

/** Organization + WebSite entities that every page links to. */
function siteEntities() {
  return [
    {
      '@type': 'Organization',
      '@id': ORGANIZATION_ID,
      name: SITE_NAME,
      alternateName: SITE_NAME_EN,
      url: `${SITE_URL}/`,
      logo: { '@type': 'ImageObject', url: `${SITE_URL}${LOGO_PATH}` },
      sameAs: [FACEBOOK_URL],
    },
    {
      '@type': 'WebSite',
      '@id': WEBSITE_ID,
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      inLanguage: 'ar',
      publisher: { '@id': ORGANIZATION_ID },
    },
  ];
}

/** BreadcrumbList from [{name, url}]. */
function breadcrumbLd(crumbs) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({ '@type': 'ListItem', position: index + 1, name: crumb.name, item: crumb.url })),
  };
}

/** Visible breadcrumb navigation. The last crumb is the current page. */
function breadcrumbHtml(crumbs) {
  const parts = crumbs.map((crumb, index) => (index === crumbs.length - 1
    ? `<li aria-current="page"><span>${esc(crumb.name)}</span></li>`
    : `<li><a href="${esc(crumb.path)}">${esc(crumb.name)}</a></li>`));
  return `<nav class="breadcrumb" aria-label="مسار التنقل"><ol>${parts.join('')}</ol></nav>`;
}

/**
 * Wraps page content in the full HTML document.
 * @param {{title: string, description: string, canonical: string, robots?: string, ld: object[], body: string, ogType?: string}} page
 * @param {{folders: Array<{slug: string, name: string}>}} catalog
 */
function layout(page, catalog) {
  const robots = page.robots || 'index, follow, max-image-preview:large';
  const ogImage = `${SITE_URL}${OG_IMAGE_PATH}`;
  const folderLinks = catalog.folders.map((folder) => `<a href="${esc(path.folder(folder))}">${esc(folder.name)}</a>`).join('');
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)}</title>
<meta name="description" content="${esc(page.description)}">
<meta name="robots" content="${esc(robots)}">
<link rel="canonical" href="${esc(page.canonical)}">
<meta name="theme-color" content="#226864">
<meta property="og:type" content="${esc(page.ogType || 'website')}">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:locale" content="ar_AR">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${esc(page.canonical)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:image:width" content="${OG_IMAGE_WIDTH}">
<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(page.title)}">
<meta name="twitter:description" content="${esc(page.description)}">
<meta name="twitter:image" content="${esc(ogImage)}">
<link rel="icon" type="image/png" href="${LOGO_PATH}">
<link rel="apple-touch-icon" href="${LOGO_PATH}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cairo:wght@500;600;700;800&family=Manrope:wght@500;700;800&display=swap">
<link rel="stylesheet" href="/downloads-blog.css?v=${ASSET_VERSION}">
<script>${THEME_INIT_SCRIPT}</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}"></script>
<script>${GA_INIT_SCRIPT}</script>
<script type="application/ld+json">${jsonLd({ '@context': 'https://schema.org', '@graph': [...siteEntities(), ...page.ld] })}</script>
</head>
<body>
<a class="skip-link" href="#main">انتقل إلى المحتوى</a>
<header class="site-header">
  <div class="wrap site-header-inner">
    <a class="brand" href="/" aria-label="${esc(SITE_NAME)} — الصفحة الرئيسية"><img src="${LOGO_PATH}" alt="" width="105" height="39"></a>
    <nav class="site-nav" aria-label="القائمة الرئيسية">
      <a href="/">الرئيسية</a>
      <a href="/downloads" aria-current="${page.isDownloadsHome ? 'page' : 'false'}">التنزيلات</a>
    </nav>
    <button type="button" class="icon-btn js-only" id="themeToggle" aria-label="تبديل الوضع الداكن">${ICON_THEME}</button>
  </div>
</header>
<main id="main">
${page.body}
</main>
<footer class="site-footer">
  <div class="wrap footer-grid">
    <div class="footer-brand">
      <a class="brand" href="/" aria-label="${esc(SITE_NAME)}"><img src="${LOGO_PATH}" alt="" width="105" height="39"></a>
      <p>${esc(SITE_NAME)} — منصة عربية تعليمية مجانية: ادرس بلا تشتت، مع كتب وملخصات وخرائط ذهنية ومكتبة روابط للجامعة والشرح.</p>
      <a class="social" href="${esc(FACEBOOK_URL)}" target="_blank" rel="noopener noreferrer">صفحتنا على فيسبوك</a>
    </div>
    <nav class="footer-col" aria-label="المجلدات">
      <h2>مجلدات التنزيلات</h2>
      <a href="/downloads">كل التنزيلات</a>
      ${folderLinks}
    </nav>
    <nav class="footer-col" aria-label="روابط قانونية">
      <h2>قانوني</h2>
      <a href="${PRIVACY_PATH}" target="_blank" rel="noopener noreferrer">سياسة الخصوصية</a>
    </nav>
  </div>
  <div class="footer-bottom wrap">
    <p>© 2026 ${esc(SITE_NAME)}. جميع الحقوق محفوظة.</p>
    <a href="${esc(DEVELOPER_URL)}" rel="noopener">تطوير <strong>${esc(DEVELOPER_NAME)}</strong></a>
  </div>
</footer>
<script src="/downloads-client.js?v=${ASSET_VERSION}" defer></script>
</body>
</html>
`;
}

/* ---------------- Shared fragments ---------------- */
/** Kind chip: icon + label. */
function kindChip(kind) {
  return `<span class="kind-chip">${KIND_ICONS[kind]}<span>${esc(KINDS[kind].label)}</span></span>`;
}

/** Search box + tag chips (only shown when JavaScript runs). */
function searchBlock(tags, placeholder) {
  const chips = tags.slice(0, MAX_TAG_CHIPS).map(({ tag }) =>
    `<button type="button" class="tag-chip" data-tag="${esc(normalizeArabic(tag))}" aria-pressed="false">${esc(tag)}</button>`).join('');
  return `<div class="finder js-only">
    <div class="search-box">${ICON_SEARCH}
      <label class="visually-hidden" for="searchInput">${esc(placeholder)}</label>
      <input type="search" id="searchInput" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="search">
    </div>
    <div class="tag-row" role="group" aria-label="تصفية بالوسوم">${chips}</div>
    <p class="results-status" id="resultsStatus" role="status" aria-live="polite"></p>
  </div>`;
}

/** Text used by client-side search for one item. */
function itemSearchText(item) {
  return normalizeArabic([item.title, item.description, item.tags.join(' '), item.folder.name, KINDS[item.kind].label].join(' '));
}

/** One file row/card (links to the file's own page). */
function itemCard(item, { showFolder }) {
  const tags = item.tags.slice(0, 3).map((tag) => `<li>${esc(tag)}</li>`).join('');
  return `<article class="item-card fc-${item.folder.color}" data-filter-item data-search="${esc(itemSearchText(item))}" data-tags="${esc(item.tags.map(normalizeArabic).join('|'))}">
    <div class="item-card-top">${kindChip(item.kind)}${showFolder ? `<span class="folder-dot-label"><i class="dot" aria-hidden="true"></i>${esc(item.folder.name)}</span>` : ''}</div>
    <h3><a href="${esc(path.item(item))}">${esc(item.title)}</a></h3>
    <p>${esc(truncate(item.description, 140))}</p>
    ${tags ? `<ul class="mini-tags" aria-label="الوسوم">${tags}</ul>` : ''}
  </article>`;
}

/** Empty-state paragraph shown by the client when a search matches nothing. */
function emptyState() {
  return '<p class="empty-state js-only" data-empty hidden>لا توجد نتائج مطابقة. جرّب كلمة أقصر أو أزل الوسم المحدد.</p>';
}

/* ---------------- Pages ---------------- */
/** Home page: /downloads */
function renderHome(catalog) {
  const { folders, items } = catalog;
  const total = items.length;
  const summary = kindSummary(items);
  const folderNames = folders.map((folder) => folder.name);
  const quickAnswer = `تضم مكتبة ${SITE_NAME} ${countPhrase(total, FILE_FORMS)}، وكلها مجانية، موزعة على ${countPhrase(folders.length, FOLDER_FORMS)}: ${folderNames.join('، ')}. تجد فيها ${summary.join('، ')}. لكل ملف صفحة بوصف واضح ووسوم، وزر «تحميل» يفتح رابط الملف مباشرة دون تسجيل دخول${catalog.updatedAt ? `، وآخر تحديث للمكتبة بتاريخ ${formatDate(catalog.updatedAt)}` : ''}.`;
  const title = buildTitle('تحميل ملخصات وخرائط ذهنية وكتب مجاناً PDF');
  const description = truncate(`مكتبة مجانية فيها ${countPhrase(total, FILE_FORMS)}: ${summary.join('، ')}. ابحث بالاسم أو الوسم وحمّل مباشرة بدون تسجيل دخول.`, MAX_META_DESCRIPTION_LENGTH);

  const folderCards = folders.map((folder) => {
    const kinds = kindSummary(folder.items).slice(0, 3).map((phrase) => `<li>${esc(phrase)}</li>`).join('');
    const search = normalizeArabic([folder.name, folder.description, folder.keywords.join(' '), ...folder.items.map((i) => `${i.title} ${i.tags.join(' ')}`)].join(' '));
    const tags = [...new Set(folder.items.flatMap((i) => i.tags.map(normalizeArabic)))].join('|');
    return `<a class="folder-card fc-${folder.color}" href="${esc(path.folder(folder))}" data-filter-item data-search="${esc(search)}" data-tags="${esc(tags)}">
      <span class="folder-tab" aria-hidden="true"></span>
      <h3>${esc(folder.name)}</h3>
      <p class="folder-desc">${esc(truncate(folder.description, 170))}</p>
      <div class="folder-meta"><strong>${esc(countPhrase(folder.items.length, FILE_FORMS))}</strong><ul>${kinds}</ul></div>
      <span class="folder-go">${ICON_ARROW}<span class="visually-hidden">افتح المجلد</span></span>
    </a>`;
  }).join('');

  const rows = items.slice(0, MAX_HOME_FILE_ROWS).map((item) => itemCard(item, { showFolder: true })).join('');
  const faq = HOME_FAQ.map((entry) => `<div class="faq-item"><h3>${esc(entry.question)}</h3><p>${esc(entry.answer)}</p></div>`).join('');

  const body = `<section class="hero wrap">
  <h1>تحميل ملخصات وخرائط ذهنية وكتب مجانية</h1>
  <div class="quick-answer"><p>${esc(quickAnswer)}</p></div>
  ${searchBlock(catalog.tags, 'ابحث عن ملخص أو مادة أو موقع…')}
</section>
<section class="wrap section" aria-labelledby="folders-heading">
  <h2 id="folders-heading">اختر مجلداً</h2>
  <div class="folder-grid">${folderCards}</div>
</section>
<section class="wrap section" aria-labelledby="files-heading">
  <h2 id="files-heading">كل الملفات</h2>
  <div class="item-grid">${rows}</div>
  ${emptyState()}
</section>
<section class="wrap section faq" aria-labelledby="faq-heading">
  <h2 id="faq-heading">أسئلة شائعة عن التحميل</h2>
  ${faq}
</section>`;

  const crumbs = [{ name: 'الرئيسية', url: `${SITE_URL}/` }, { name: 'التنزيلات', url: urls.home() }];
  const ld = [
    {
      '@type': 'CollectionPage',
      '@id': `${urls.home()}#page`,
      url: urls.home(),
      name: 'تحميل ملخصات وخرائط ذهنية وكتب مجانية',
      description,
      inLanguage: 'ar',
      isPartOf: { '@id': WEBSITE_ID },
      about: folderNames,
      ...(catalog.updatedAt ? { dateModified: catalog.updatedAt.toISOString() } : {}),
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: folders.length,
        itemListElement: folders.map((folder, index) => ({ '@type': 'ListItem', position: index + 1, name: folder.name, url: urls.folder(folder) })),
      },
    },
    breadcrumbLd(crumbs),
    { '@type': 'FAQPage', mainEntity: HOME_FAQ.map((entry) => ({ '@type': 'Question', name: entry.question, acceptedAnswer: { '@type': 'Answer', text: entry.answer } })) },
  ];
  return layout({ title, description, canonical: urls.home(), ld, body, isDownloadsHome: true }, catalog);
}

/** Folder page: /downloads/:folder */
function renderFolder(catalog, folder) {
  const summary = kindSummary(folder.items);
  const updated = folder.items.map((i) => i.updatedAt?.getTime()).filter(Boolean);
  const updatedAt = updated.length ? new Date(Math.max(...updated)) : null;
  const facts = `يضم هذا المجلد ${countPhrase(folder.items.length, FILE_FORMS)}${summary.length ? `: ${summary.join('، ')}` : ''}${updatedAt ? `. آخر تحديث بتاريخ ${formatDate(updatedAt)}` : ''}.`;
  const title = buildTitle(`${folder.name}: تحميل ملخصات وخرائط ذهنية`);
  const description = truncate(`${folder.description} ${facts}`, MAX_META_DESCRIPTION_LENGTH);
  const crumbs = [
    { name: 'الرئيسية', url: `${SITE_URL}/`, path: '/' },
    { name: 'التنزيلات', url: urls.home(), path: path.home() },
    { name: folder.name, url: urls.folder(folder), path: path.folder(folder) },
  ];
  const keywords = folder.keywords.length
    ? `<div class="keyword-row"><h2>عبارات يبحث بها الطلاب</h2><ul>${folder.keywords.map((k) => `<li>${esc(k)}</li>`).join('')}</ul></div>` : '';
  const tags = catalog.tags.filter(({ tag }) => folder.items.some((item) => item.tags.includes(tag)));

  const body = `<section class="folder-hero fc-${folder.color}">
  <div class="wrap">
    ${breadcrumbHtml(crumbs)}
    <h1>${esc(folder.name)}</h1>
    <div class="quick-answer on-color"><p>${esc(folder.description)} ${esc(facts)}</p></div>
  </div>
</section>
<section class="wrap section">
  ${keywords}
  ${searchBlock(tags, `ابحث داخل «${folder.name}»…`)}
  <h2 class="visually-hidden">ملفات المجلد</h2>
  <div class="item-grid">${folder.items.map((item) => itemCard(item, { showFolder: false })).join('')}</div>
  ${emptyState()}
  <p class="back-link"><a href="/downloads">${ICON_ARROW}<span>كل مجلدات التنزيلات</span></a></p>
</section>`;

  const ld = [
    {
      '@type': 'CollectionPage',
      '@id': `${urls.folder(folder)}#page`,
      url: urls.folder(folder),
      name: `${folder.name}: تحميل ملخصات وخرائط ذهنية`,
      description,
      inLanguage: 'ar',
      isPartOf: { '@id': WEBSITE_ID },
      ...(updatedAt ? { dateModified: updatedAt.toISOString() } : {}),
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: folder.items.length,
        itemListElement: folder.items.slice(0, MAX_LIST_ITEMS_IN_JSON_LD).map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: item.title, url: urls.item(item) })),
      },
    },
    breadcrumbLd(crumbs),
  ];
  return layout({ title, description, canonical: urls.folder(folder), ld, body }, catalog);
}

/** Picks up to MAX_RELATED_ITEMS items from the same folder, sharing tags first. */
function relatedItems(item) {
  const score = (other) => other.tags.filter((tag) => item.tags.includes(tag)).length;
  return item.folder.items.filter((other) => other !== item)
    .sort((a, b) => score(b) - score(a))
    .slice(0, MAX_RELATED_ITEMS);
}

/** Item page: /downloads/:folder/:slug */
function renderItem(catalog, item) {
  const { folder } = item;
  const kind = KINDS[item.kind];
  const isVisit = kind.action === 'visit';
  const actionLabel = isVisit ? 'عرض الموقع' : 'تحميل';
  const title = buildTitle(item.title);
  const description = truncate(item.description || `${kind.label}: ${item.title}`, MAX_META_DESCRIPTION_LENGTH);
  const crumbs = [
    { name: 'الرئيسية', url: `${SITE_URL}/`, path: '/' },
    { name: 'التنزيلات', url: urls.home(), path: path.home() },
    { name: folder.name, url: urls.folder(folder), path: path.folder(folder) },
    { name: item.title, url: urls.item(item), path: path.item(item) },
  ];
  const tagList = item.tags.length ? `<ul class="tag-list" aria-label="الوسوم">${item.tags.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '';
  const details = [
    ['النوع', esc(kind.label)],
    ['المجلد', `<a href="${esc(path.folder(folder))}">${esc(folder.name)}</a>`],
    ...(item.host ? [[isVisit ? 'الموقع' : 'مكان الملف', `<bdi dir="ltr">${esc(item.host)}</bdi>`]] : []),
    ...(item.updatedAt ? [['آخر تحديث', `<time datetime="${esc(item.updatedAt.toISOString())}">${esc(formatDate(item.updatedAt))}</time>`]] : []),
    ['الوصول', 'مجاني بدون تسجيل دخول'],
  ].map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join('');
  const related = relatedItems(item);

  const body = `<article class="item-page">
  <header class="item-hero fc-${folder.color}">
    <div class="wrap">
      ${breadcrumbHtml(crumbs)}
      <div class="item-meta-row">${kindChip(item.kind)}<a class="folder-pill" href="${esc(path.folder(folder))}">${esc(folder.name)}</a></div>
      <h1>${esc(item.title)}</h1>
    </div>
  </header>
  <div class="wrap item-layout">
    <div class="item-main">
      <section aria-labelledby="what-heading">
        <h2 id="what-heading">ما هذا ${esc(kind.label)}؟</h2>
        <div class="quick-answer"><p>${esc(item.description)}</p></div>
        ${tagList}
      </section>
      <section class="action-box" aria-labelledby="action-heading">
        <h2 id="action-heading">${isVisit ? 'افتح الموقع' : 'حمّل الملف'}</h2>
        <a class="btn-primary" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer nofollow">${isVisit ? ICON_EXTERNAL : ICON_DOWNLOAD}<span>${actionLabel}</span></a>
        <p class="action-note">يفتح الرابط في نافذة جديدة${item.host ? ` على موقع <bdi dir="ltr">${esc(item.host)}</bdi>` : ''}. ${isVisit ? 'الموقع خارجي ولا تتحكم فيه مسودة التعليمي.' : 'الملف مخزّن خارج مسودة التعليمي.'}</p>
      </section>
    </div>
    <aside class="item-side" aria-labelledby="details-heading">
      <h2 id="details-heading">تفاصيل</h2>
      <dl class="details">${details}</dl>
    </aside>
  </div>
  ${related.length ? `<section class="wrap section" aria-labelledby="related-heading">
    <h2 id="related-heading">ملفات أخرى في ${esc(folder.name)}</h2>
    <div class="item-grid">${related.map((other) => itemCard(other, { showFolder: false })).join('')}</div>
  </section>` : ''}
</article>`;

  const ld = [
    {
      '@type': 'WebPage',
      '@id': `${urls.item(item)}#page`,
      url: urls.item(item),
      name: item.title,
      description,
      inLanguage: 'ar',
      isPartOf: { '@id': WEBSITE_ID },
      breadcrumb: { '@id': `${urls.item(item)}#breadcrumb` },
      mainEntity: { '@id': `${urls.item(item)}#resource` },
      ...(item.updatedAt ? { dateModified: item.updatedAt.toISOString() } : {}),
    },
    {
      '@type': 'CreativeWork',
      '@id': `${urls.item(item)}#resource`,
      name: item.title,
      description: item.description || description,
      inLanguage: 'ar',
      keywords: item.tags.join('، '),
      genre: kind.label,
      isAccessibleForFree: true,
      isPartOf: { '@id': `${urls.folder(folder)}#page` },
      publisher: { '@id': ORGANIZATION_ID },
      about: folder.name,
      ...(item.createdAt ? { datePublished: item.createdAt.toISOString() } : {}),
      ...(item.updatedAt ? { dateModified: item.updatedAt.toISOString() } : {}),
    },
    { ...breadcrumbLd(crumbs), '@id': `${urls.item(item)}#breadcrumb` },
  ];
  return layout({ title, description, canonical: urls.item(item), ld, body, ogType: 'article' }, catalog);
}

/** 404 page (not indexed). */
function renderNotFound(catalog) {
  const body = `<section class="wrap hero not-found">
  <h1>لم نجد هذه الصفحة</h1>
  <p class="quick-answer">ربما تغيّر رابط الملف أو حُذف. ابدأ من قائمة المجلدات وستجده غالباً.</p>
  <p><a class="btn-primary" href="/downloads"><span>كل التنزيلات</span></a></p>
</section>`;
  return layout({ title: buildTitle('الصفحة غير موجودة'), description: 'الصفحة المطلوبة غير موجودة.', canonical: urls.home(), robots: 'noindex, follow', ld: [], body }, catalog);
}

/** Minimal 5xx page (no data needed, no details leaked). */
function renderUnavailable() {
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(buildTitle('الصفحة غير متاحة مؤقتاً'))}</title></head><body><main style="font-family:sans-serif;text-align:center;padding:64px 16px"><h1>الصفحة غير متاحة مؤقتاً</h1><p>حاول مرة أخرى بعد قليل.</p><p><a href="/">العودة للرئيسية</a></p></main></body></html>`;
}

/* ---------------- Sitemap ---------------- */
/** Escapes text for XML. */
function xmlEscape(value) {
  return String(value).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));
}

/** sitemap.xml with the home page, downloads, folders and every file page. */
function renderSitemap(catalog) {
  const entry = (loc, lastmod) => `  <url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
  const lines = [
    entry(`${SITE_URL}/`),
    entry(urls.home(), isoDay(catalog.updatedAt)),
    ...catalog.folders.map((folder) => entry(urls.folder(folder), isoDay(folder.items.map((i) => i.updatedAt).filter(Boolean).sort((a, b) => b - a)[0] || null))),
    ...catalog.items.map((item) => entry(urls.item(item), isoDay(item.updatedAt))),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${lines.join('\n')}\n</urlset>\n`;
}

/* ---------------- Routing ---------------- */
/**
 * Resolves a request to a page. Slugs are validated before any lookup.
 * @param {{view?: string, folder?: string, slug?: string}} query
 * @param {ReturnType<typeof buildCatalog>} catalog
 * @returns {{status: number, type: 'html' | 'xml', body: string, cache: string}}
 */
function route(query, catalog) {
  const html = (status, body, cache = HTML_CACHE_CONTROL) => ({ status, type: 'html', body, cache });
  const notFound = () => html(404, renderNotFound(catalog), NOT_FOUND_CACHE_CONTROL);
  const one = (value) => (Array.isArray(value) ? value[0] : value);
  const view = one(query.view);
  const folderSlug = one(query.folder);
  const itemSlug = one(query.slug);

  if (view === 'sitemap') return { status: 200, type: 'xml', body: renderSitemap(catalog), cache: HTML_CACHE_CONTROL };
  if (view === 'home') return html(200, renderHome(catalog));
  if (view === 'folder' || view === 'item') {
    if (!SLUG_PATTERN.test(String(folderSlug || ''))) return notFound();
    const folder = catalog.folders.find((entry) => entry.slug === folderSlug);
    if (!folder) return notFound();
    if (view === 'folder') return html(200, renderFolder(catalog, folder));
    if (!SLUG_PATTERN.test(String(itemSlug || ''))) return notFound();
    const item = folder.items.find((entry) => entry.slug === itemSlug);
    return item ? html(200, renderItem(catalog, item)) : notFound();
  }
  return notFound();
}

module.exports = {
  KINDS, FOLDER_COLOR_KEYS, SITE_URL, HTML_CACHE_CONTROL, ERROR_CACHE_CONTROL,
  esc, jsonLd, isSafeUrl, normalizeArabic, countPhrase, truncate, buildTitle,
  buildCatalog, kindSummary, buildCsp, securityHeaders,
  renderHome, renderFolder, renderItem, renderNotFound, renderUnavailable, renderSitemap, route,
};
