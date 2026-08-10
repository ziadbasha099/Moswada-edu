/* ============================================================
   MOSWADA — Downloads page
   Reads the "downloads" collection from Firestore in realtime.
   Every item the admin adds from /admin appears here instantly
   for all visitors — no code changes needed.
   ============================================================ */
const I18N = {
  en: {
    title: "Downloads",
    sub: "Browse ready-made files, organized into folders. Search by name or pick a folder to narrow things down.",
    search: "Search files...",
    back: "Back to home",
    lang: "العربية",
    loading: "Loading files…",
    emptyTitle: "Nothing here yet",
    emptyMsg: "No files match your search right now.",
    all: "All",
    download: "Download",
    setupNeeded: "Downloads aren't set up yet — connect Firebase in firebase-config.js.",
  },
  ar: {
    title: "التنزيلات",
    sub: "تصفّح ملفات جاهزة، منظّمة في مجلدات. ابحث بالاسم أو اختر مجلداً لتضييق النتائج.",
    search: "ابحث عن ملف...",
    back: "العودة للرئيسية",
    lang: "English",
    loading: "جارٍ تحميل الملفات…",
    emptyTitle: "لا يوجد شيء هنا بعد",
    emptyMsg: "لا توجد ملفات مطابقة لبحثك حالياً.",
    all: "الكل",
    download: "تحميل",
    setupNeeded: "لم يتم إعداد التنزيلات بعد — اربط Firebase في firebase-config.js.",
  }
};

let lang = localStorage.getItem("preferred-language") || "en";
let allItems = [];
let activeFolder = "all";
let searchQuery = "";

const FOLDER_PALETTE = ["#e07a5f","#226864","#9c6644","#3e6563","#7a6ff0","#c65d7b","#5b8c5a"];
function folderColor(name){
  let h = 0; for(let i=0;i<name.length;i++) h = name.charCodeAt(i) + ((h<<5)-h);
  return FOLDER_PALETTE[Math.abs(h) % FOLDER_PALETTE.length];
}

function t(key){ return I18N[lang][key]; }

function applyLanguage(){
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.getElementById("pageTitle").textContent = t("title");
  document.getElementById("pageSub").textContent = t("sub");
  document.getElementById("searchInput").placeholder = t("search");
  document.getElementById("backLink").textContent = t("back");
  document.getElementById("langBtn").textContent = t("lang");
  document.getElementById("loadingTitle").textContent = t("loading");
  document.getElementById("emptyTitle").textContent = t("emptyTitle");
  document.getElementById("emptyMsg").textContent = t("emptyMsg");
  renderChips();
  renderGrid();
}

document.getElementById("langBtn").addEventListener("click", () => {
  lang = lang === "en" ? "ar" : "en";
  localStorage.setItem("preferred-language", lang);
  applyLanguage();
});

document.getElementById("searchInput").addEventListener("input", (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  renderGrid();
});

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function renderChips(){
  const folders = [...new Set(allItems.map(i => i.folder).filter(Boolean))].sort();
  const chipsEl = document.getElementById("folderChips");
  const chips = [{ id: "all", name: t("all"), color: null }, ...folders.map(f => ({ id: f, name: f, color: folderColor(f) }))];
  chipsEl.innerHTML = chips.map(c => `
    <button class="dl-chip ${activeFolder === c.id ? "active" : ""}" data-folder="${escapeHtml(c.id)}">
      ${c.color ? `<span class="dot" style="background:${c.color}"></span>` : ""}${escapeHtml(c.name)}
    </button>`).join("");
  chipsEl.querySelectorAll(".dl-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      activeFolder = btn.getAttribute("data-folder");
      renderChips();
      renderGrid();
    });
  });
}

function renderGrid(){
  const grid = document.getElementById("grid");
  const loadingState = document.getElementById("loadingState");
  const emptyState = document.getElementById("emptyState");

  let items = allItems;
  if(activeFolder !== "all") items = items.filter(i => i.folder === activeFolder);
  if(searchQuery) items = items.filter(i => (i.title || "").toLowerCase().includes(searchQuery));

  loadingState.classList.add("hidden");

  if(!items.length){
    grid.innerHTML = "";
    emptyState.classList.remove("hidden");
    return;
  }
  emptyState.classList.add("hidden");

  grid.innerHTML = items.map(i => `
    <div class="dl-card">
      <div class="dl-card-top">
        <div class="dl-card-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>
        </div>
        <div>
          <p class="dl-card-title">${escapeHtml(i.title)}</p>
          ${i.folder ? `<span class="dl-card-folder"><span class="dot" style="background:${folderColor(i.folder)}"></span>${escapeHtml(i.folder)}</span>` : ""}
        </div>
      </div>
      <a class="dl-card-btn" href="${escapeHtml(i.url)}" target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
        ${t("download")}
      </a>
    </div>`).join("");
}

applyLanguage();

document.getElementById("loadingState").classList.remove("hidden");

async function loadDownloads(){
  try {
    const [{ initializeApp }, { getFirestore, collection, onSnapshot, query, orderBy }, { firebaseConfig, DOWNLOADS_COLLECTION }] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"),
      import("./firebase-config.js"),
    ]);

    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app);

    const q = query(collection(db, DOWNLOADS_COLLECTION), orderBy("createdAt", "desc"));
    onSnapshot(q, (snap) => {
      allItems = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderChips();
      renderGrid();
    }, (err) => {
      console.error(err);
      document.getElementById("loadingState").classList.add("hidden");
      document.getElementById("emptyState").classList.remove("hidden");
      document.getElementById("emptyMsg").textContent = t("setupNeeded");
    });
  } catch(err){
    console.error(err);
    document.getElementById("loadingState").classList.add("hidden");
    document.getElementById("emptyState").classList.remove("hidden");
    document.getElementById("emptyMsg").textContent = t("setupNeeded");
  }
}

loadDownloads();
