/* =========================================================
   Artists Roommate — app logic
   - Works (text, tags, takes) live in localStorage.
   - Audio and cover files (plus the original uncropped image) live in IndexedDB, which has room for
     full-length songs. localStorage caps out near 5 MB, which is
     why the old import silently failed on real tracks.
   ========================================================= */
(function(){
  "use strict";

  /* ---------------- Constants ---------------- */
  const STORAGE_KEY = "greenroom_works_v1";
  const MAX_AUDIO_BYTES = 250 * 1024 * 1024;
  const AUDIO_MIME_BY_EXT = {
    mp3:"audio/mpeg", wav:"audio/wav", wave:"audio/wav", m4a:"audio/mp4",
    aac:"audio/aac", ogg:"audio/ogg", oga:"audio/ogg", opus:"audio/ogg",
    flac:"audio/flac", webm:"audio/webm", aif:"audio/aiff", aiff:"audio/aiff", mp4:"audio/mp4"
  };
  const TYPE_META = {
    song:    { label:"Song / Lyrics",       title:"Song / Lyrics",        icon:"icon-lyrics", color:"#E8A33D", blurb:"Write lyrics, hooks and verses, then add audio and release info.", placeholder:"Write it before it goes. Verse, hook, a stray line. None of it has to be finished here." },
    beat:    { label:"Beat / Instrumental", title:"Beat / Instrumental",  icon:"icon-beat",   color:"#7FC4C0", blurb:"A beat or loop with BPM, key and license notes.", placeholder:"Notes for this beat: BPM, key, references, what it needs next." },
    cover:   { label:"Cover art",           title:"Cover art",            icon:"icon-image",  color:"#D79BD7", blurb:"Artwork for a single, EP or album, cropped to a square.", placeholder:"Notes on the artwork: palette, references, fonts, who is making it." },
    idea:    { label:"Idea / Fragment",     title:"Idea / Fragment",      icon:"icon-idea",   color:"#9DB4E6", blurb:"A line, a title or a feeling you don't want to lose.", placeholder:"Catch the idea before it goes. A line, a title, a feeling." },
    project: { label:"Project",             title:"Project (EP / Album)", icon:"icon-stack",  color:"#A8CC7A", blurb:"Plan a body of work: tracklist, concept and release info.", placeholder:"Plan the project: concept, tracklist order, features, and how you want to roll it out." }
  };
  const STATUS_META = {
    sketch:   { label:"Sketch",       color:"#A3A6AE" },
    progress: { label:"In progress",  color:"#E8A33D" },
    refining: { label:"Refining",     color:"#7FC4C0" },
    final:    { label:"Final take",   color:"#6FBF8E" }
  };
  const FILTER_TITLES = {
    all:"All works", song:"Lyrics", beat:"Beats", cover:"Cover art", idea:"Ideas", project:"Projects", trash:"Trash"
  };

  const $ = (id) => document.getElementById(id);

  /* ---------------- Elements ---------------- */
  const appEl = $("app");
  const railEl = $("rail");
  const menuBtn = $("menuBtn");
  const contentEl = $("content");
  const chipsEl = $("chips");
  const listViewEl = $("listView");
  const workspaceEl = $("workspace");
  const workspaceBody = $("workspaceBody");
  const workListEl = $("workList");
  const emptyStateEl = $("emptyState");
  const listHeadEl = $("listHead");
  const viewTitleEl = $("viewTitle");
  const viewSubEl = $("viewSub");
  const titleInput = $("titleInput");
  const lyricsArea = $("lyricsArea");
  const sheetWrap = $("sheetWrap");
  const typeSelect = $("typeSelect");
  const statusSelect = $("statusSelect");
  const tagInput = $("tagInput");
  const tagListEl = $("tagList");
  const saveDot = $("saveDot");
  const saveText = $("saveText");
  const sheetType = $("sheetType");
  const sheetWords = $("sheetWords");
  const takesListEl = $("takesList");
  const audioSlot = $("audioSlot");
  const audioEl = $("audioEl");
  const audioFileInput = $("audioFileInput");
  const coverFileInput = $("coverFileInput");
  const coverDrop = $("coverDrop");
  const confirmOverlay = $("confirmOverlay");
  const ideaOverlay = $("ideaOverlay");
  const ideaText = $("ideaText");
  const newOverlay = $("newOverlay");
  const pickList = $("pickList");
  const metaRail = $("metaRail");
  const metaForm = $("metaForm");
  const railTabsEl = $("railTabs");

  /* ---------------- State ---------------- */
  let works = loadWorks();
  let currentFilter = "all";
  let searchQuery = "";
  let activeWorkId = null;
  let saveTimer = null;
  let confirmHandler = null;
  let wsHistoryPushed = false;

  // media state for the open workspace
  let audioUrl = null;
  let coverUrl = null;
  let audioToken = 0;
  let coverToken = 0;
  let audioBusy = false;
  let audioMissing = false;
  let scrubbing = false;
  const volatileKeys = new Set(); // files that could only be kept in memory

  /* =========================================================
     Helpers
     ========================================================= */
  function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }
  function relativeTime(ts){
    const min = Math.floor((Date.now() - ts) / 60000);
    if(min < 1) return "just now";
    if(min < 60) return min + "m ago";
    const hr = Math.floor(min / 60);
    if(hr < 24) return hr + "h ago";
    const day = Math.floor(hr / 24);
    if(day < 7) return day + "d ago";
    return new Date(ts).toLocaleDateString(undefined, { month:"short", day:"numeric" });
  }
  function fullDate(ts){
    return new Date(ts).toLocaleString(undefined, { month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit" });
  }
  function wordCount(text){
    const t = text.trim();
    return t ? t.split(/\s+/).length : 0;
  }
  function formatBytes(n){
    if(!n) return "";
    if(n < 1024) return n + " B";
    if(n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }
  function formatTime(sec){
    if(!isFinite(sec) || sec < 0) sec = 0;
    return Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");
  }
  function extOf(name){
    const m = /\.([a-z0-9]+)$/i.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  }
  function isAudioFile(file){
    return (file.type && file.type.indexOf("audio/") === 0) || !!AUDIO_MIME_BY_EXT[extOf(file.name)];
  }
  function guessMime(file){
    return AUDIO_MIME_BY_EXT[extOf(file.name)] || file.type || "audio/mpeg";
  }
  function readFileBuffer(file){
    if(file.arrayBuffer) return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(file);
    });
  }
  function dataUrlToBuffer(dataUrl){
    const comma = dataUrl.indexOf(",");
    const meta = dataUrl.slice(5, comma);
    const type = meta.split(";")[0] || "application/octet-stream";
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { buf: bytes.buffer, type: type };
  }

  /* =========================================================
     Media store (IndexedDB with in-memory fallback)
     ========================================================= */
  const media = (function(){
    const DB_NAME = "greenroom_media_v1";
    const STORE = "media";
    let dbPromise = null;
    const memory = new Map();

    function open(){
      if(dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        if(!("indexedDB" in window)) { reject(new Error("IndexedDB unavailable")); return; }
        let req;
        try{ req = indexedDB.open(DB_NAME, 1); }catch(e){ reject(e); return; }
        req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { db.close(); dbPromise = null; };
          resolve(db);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("IndexedDB blocked"));
      });
      dbPromise.catch(() => { dbPromise = null; });
      return dbPromise;
    }

    async function put(key, buf, type, name){
      try{
        const db = await open();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put({ buf: buf, type: type, name: name }, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
        });
        memory.delete(key);
        volatileKeys.delete(key);
        return "idb";
      }catch(err){
        console.warn("Artists Roommate: could not write to IndexedDB, keeping in memory", err);
        memory.set(key, { buf: buf, type: type, name: name });
        volatileKeys.add(key);
        return "memory";
      }
    }

    async function get(key){
      if(memory.has(key)) return memory.get(key);
      try{
        const db = await open();
        return await new Promise((resolve, reject) => {
          const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
      }catch(e){
        return null;
      }
    }

    async function remove(key){
      memory.delete(key);
      volatileKeys.delete(key);
      try{
        const db = await open();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }catch(e){ /* nothing to remove */ }
    }

    return { put: put, get: get, remove: remove };
  })();

  /* =========================================================
     Works storage
     ========================================================= */
  // Release info a distributor or Spotify asks for. A function (not a constant) so it
  // can be used while the saved works are loaded at start-up.
  function metaDefaults(){
    return {
      trackTitle:"", trackVersion:"", primaryArtist:"", featuredArtists:"",
      trackNo:"", bpm:"", key:"", isrc:"", genre:"", subgenre:"", language:"",
      explicit:"", instrumental:false, previewStart:"",
      releaseTitle:"", releaseType:"single", label:"", releaseDate:"", originalReleaseDate:"",
      upc:"", distributor:"", territories:"Worldwide", pLine:"", cLine:"", tracklist:"",
      iswc:"", publisher:"", pro:"", ipi:"", isCover:"", originalWriter:"",
      hasSamples:"", sampleNotes:"", beatLicense:"",
      spotifyArtist:"", appleArtist:"", moods:[], instruments:[], pitch:"",
      credits:[]
    };
  }

  function normalize(w){
    const out = Object.assign({
      id: uid(), title:"", type:"song", status:"sketch", lyrics:"", tags:[],
      trashed:false, takes:[], created:Date.now(), updated:Date.now(),
      hasCover:false, hasCoverOrig:false, coverCrop:null, coverSize:0,
      hasAudio:false, audioName:null, audioSize:0, audioType:"", audioLoop:false, audioDuration:0
    }, w);
    out.meta = Object.assign(metaDefaults(), (w && w.meta) || {});
    if(!Array.isArray(out.meta.credits)) out.meta.credits = [];
    ["moods", "instruments"].forEach(k => { if(!Array.isArray(out.meta[k])) out.meta[k] = []; });
    if(out.status === "mixing") out.status = "refining";   // older saves used "Mixing / Refining"
    if(!TYPE_META[out.type]) out.type = "song";
    return out;
  }

  function loadWorks(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(raw){
        const parsed = JSON.parse(raw);
        if(Array.isArray(parsed)) return parsed.map(normalize);
      }
    }catch(e){ /* fall through to seed */ }
    return seedData();
  }

  function seedData(){
    const now = Date.now();
    return [
      normalize({
        id: uid(), title:"Late Nights (working title)", type:"song", status:"progress",
        lyrics:"Verse 1\nStreetlights hold the block together\nWhile I'm chasing something better\n\nHook\nLate nights, we don't sleep on it\nLate nights, gotta keep on it",
        tags:["afro-pop","hook idea"], created: now - 86400000*6, updated: now - 3600000*5
      }),
      normalize({
        id: uid(), title:"Untitled 808 loop", type:"beat", status:"sketch",
        lyrics:"Amapiano log drum, 112 BPM.\nNeeds a vocal chop on the break.\nReference: warm bass, sparse hats.",
        tags:["amapiano","112bpm"], created: now - 86400000*2, updated: now - 86400000
      }),
      normalize({
        id: uid(), title:"a title comes here maybe", type:"idea", status:"sketch",
        lyrics:"\"I built a home out of unfinished songs\" could open the next project.",
        tags:[], created: now - 3600000*20, updated: now - 3600000*20
      })
    ];
  }

  function persist(){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(works));
      if(activeWorkId && !workspaceEl.hidden) renderReadiness();
      return true;
    }catch(e){
      showToast("Couldn't save. Browser storage is full or blocked.");
      return false;
    }
  }

  function getWork(id){ return works.find(w => w.id === id); }

  // Older versions kept files as base64 text inside localStorage. Move them to IndexedDB.
  async function migrateLegacyMedia(){
    let changed = false;
    for(const w of works){
      try{
        if(typeof w.cover === "string" && w.cover.indexOf("data:") === 0){
          const d = dataUrlToBuffer(w.cover);
          const where = await media.put("cover:" + w.id, d.buf, d.type, "cover");
          w.hasCover = true;
          if(where === "idb"){ w.cover = null; }
          changed = true;
        }
        if(typeof w.audio === "string" && w.audio.indexOf("data:") === 0){
          const d = dataUrlToBuffer(w.audio);
          const where = await media.put("audio:" + w.id, d.buf, d.type, w.audioName || "Audio sketch");
          w.hasAudio = true;
          w.audioName = w.audioName || "Audio sketch";
          w.audioType = d.type;
          w.audioSize = d.buf.byteLength;
          if(where === "idb"){ w.audio = null; }
          changed = true;
        }
      }catch(e){ /* leave legacy data in place and retry next load */ }
    }
    if(changed){ persist(); renderList(); }
  }

  /* =========================================================
     List rendering
     ========================================================= */
  function currentList(){
    let list = works.filter(w => currentFilter === "trash" ? w.trashed : !w.trashed);
    if(currentFilter !== "all" && currentFilter !== "trash"){
      list = list.filter(w => w.type === currentFilter);
    }
    if(searchQuery){
      const q = searchQuery.toLowerCase();
      list = list.filter(w =>
        w.title.toLowerCase().includes(q) ||
        w.lyrics.toLowerCase().includes(q) ||
        w.tags.some(t => t.toLowerCase().includes(q)) ||
        [w.meta.trackTitle, w.meta.primaryArtist, w.meta.genre].join(" ").toLowerCase().includes(q)
      );
    }
    return list.sort((a, b) => b.updated - a.updated);
  }

  function renderCounts(){
    const active = works.filter(w => !w.trashed);
    const counts = {
      all: active.length,
      song: active.filter(w => w.type === "song").length,
      beat: active.filter(w => w.type === "beat").length,
      cover: active.filter(w => w.type === "cover").length,
      idea: active.filter(w => w.type === "idea").length,
      project: active.filter(w => w.type === "project").length,
      trash: works.filter(w => w.trashed).length
    };
    document.querySelectorAll("[data-count]").forEach(el => { el.textContent = counts[el.dataset.count]; });
  }

  function renderList(){
    const list = currentList();
    const noun = list.length === 1 ? "piece" : "pieces";
    viewTitleEl.textContent = FILTER_TITLES[currentFilter];
    viewSubEl.textContent = list.length + " " + noun + (currentFilter === "trash" ? " in the trash" : " in the room");

    if(list.length === 0){
      workListEl.innerHTML = "";
      listHeadEl.hidden = true;
      emptyStateEl.hidden = false;
      const emptyBtn = $("emptyNewBtn");
      if(currentFilter === "trash"){
        $("emptyTitle").textContent = "Nothing's been thrown out";
        $("emptyText").textContent = "Anything you delete lands here first, so nothing disappears by accident.";
        emptyBtn.hidden = true;
      } else if(searchQuery){
        $("emptyTitle").textContent = "No matches";
        $("emptyText").textContent = "Nothing in this view matches “" + searchQuery + "”.";
        emptyBtn.hidden = true;
      } else {
        $("emptyTitle").textContent = "The room is quiet";
        $("emptyText").textContent = "Nothing here yet. Start a lyric sheet, drop in a beat idea, or stash some cover art before it slips your mind.";
        emptyBtn.hidden = false;
      }
      return;
    }

    emptyStateEl.hidden = true;
    listHeadEl.hidden = false;

    workListEl.innerHTML = list.map(w => {
      const t = TYPE_META[w.type] || TYPE_META.song;
      const s = STATUS_META[w.status] || STATUS_META.sketch;
      const snippet = w.lyrics.replace(/\n/g, " ").trim().slice(0, 90) || "No content yet";
      const audioIcon = w.hasAudio
        ? '<svg class="row-audio" width="15" height="15" viewBox="0 0 24 24" aria-label="Has audio"><use href="#icon-audio"/></svg>'
        : "";
      const actions = w.trashed
        ? `<button class="row-icon-btn" type="button" data-action="restore" data-id="${w.id}" title="Restore" aria-label="Restore">
             <svg width="16" height="16" viewBox="0 0 24 24"><use href="#icon-history"/></svg></button>
           <button class="row-icon-btn" type="button" data-action="wipe" data-id="${w.id}" title="Delete forever" aria-label="Delete forever">
             <svg width="16" height="16" viewBox="0 0 24 24"><use href="#icon-close"/></svg></button>`
        : `<button class="row-icon-btn" type="button" data-action="delete" data-id="${w.id}" title="Move to trash" aria-label="Move to trash">
             <svg width="16" height="16" viewBox="0 0 24 24"><use href="#icon-trash"/></svg></button>`;
      return `
        <div class="work-row" data-id="${w.id}" role="button" tabindex="0">
          <div class="work-main">
            <div class="type-glyph" style="color:${t.color}">
              <svg width="18" height="18" viewBox="0 0 24 24"><use href="#${t.icon}"/></svg>
            </div>
            <div class="work-title-block">
              <div class="work-title-line">
                <span class="work-title">${escapeHtml(w.title || "Untitled")}</span>${audioIcon}
              </div>
              <div class="work-snippet">${escapeHtml(snippet)}</div>
            </div>
          </div>
          <div class="work-meta">
            <span class="col-type">${t.label}</span>
            <span class="col-status"><span class="status-pill"><span class="status-dot" style="background:${s.color}"></span>${s.label}</span></span>
            <span class="col-updated">${relativeTime(w.updated)}</span>
          </div>
          <div class="col-actions">${actions}</div>
        </div>`;
    }).join("");
  }

  /* =========================================================
     Navigation, drawer, filters
     ========================================================= */
  function openDrawer(){
    appEl.classList.add("rail-open");
    menuBtn.setAttribute("aria-expanded", "true");
  }
  function closeDrawer(){
    appEl.classList.remove("rail-open");
    menuBtn.setAttribute("aria-expanded", "false");
  }
  menuBtn.addEventListener("click", openDrawer);
  $("railClose").addEventListener("click", closeDrawer);
  $("scrim").addEventListener("click", closeDrawer);

  function setFilter(filter){
    currentFilter = filter;
    document.querySelectorAll("[data-filter]").forEach(b => {
      b.classList.toggle("active", b.dataset.filter === filter);
    });
    const activeChip = chipsEl.querySelector(".active");
    if(activeChip){ chipsEl.scrollTo({ left: Math.max(0, activeChip.offsetLeft - 16), behavior:"smooth" }); }
    closeDrawer();
    renderList();
    contentEl.scrollTop = 0;
  }
  [$("navGroup"), chipsEl].forEach(group => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-filter]");
      if(btn) setFilter(btn.dataset.filter);
    });
  });

  $("searchInput").addEventListener("input", (e) => {
    searchQuery = e.target.value.trim();
    renderList();
  });

  workListEl.addEventListener("click", (e) => {
    const actionBtn = e.target.closest("[data-action]");
    if(actionBtn){
      e.stopPropagation();
      const id = actionBtn.dataset.id;
      const action = actionBtn.dataset.action;
      if(action === "delete") trashWork(id);
      if(action === "restore") restoreWork(id);
      if(action === "wipe") wipeWork(id);
      return;
    }
    const row = e.target.closest(".work-row");
    if(row) openWorkspace(row.dataset.id);
  });
  workListEl.addEventListener("keydown", (e) => {
    if((e.key === "Enter" || e.key === " ") && e.target.classList.contains("work-row")){
      e.preventDefault();
      openWorkspace(e.target.dataset.id);
    }
  });

  // Artist, label and other details that rarely change are carried over from the latest piece
  function rememberedMeta(){
    const src = works.filter(x => !x.trashed && x.meta.primaryArtist.trim()).sort((a, b) => b.updated - a.updated)[0];
    const out = {};
    if(!src) return out;
    ["primaryArtist", "label", "distributor", "territories", "language", "pro", "publisher", "ipi", "spotifyArtist", "appleArtist"].forEach(k => {
      if(src.meta[k]) out[k] = src.meta[k];
    });
    return out;
  }

  function newWork(type){
    const w = normalize({ id: uid(), type: TYPE_META[type] ? type : "song" });
    Object.assign(w.meta, rememberedMeta());
    if(w.type === "beat") w.meta.instrumental = true;
    works.unshift(w);
    persist();
    renderCounts();
    openWorkspace(w.id);
    setTimeout(() => titleInput.focus(), 60);
  }
  $("newWorkBtn").addEventListener("click", openPicker);
  $("emptyNewBtn").addEventListener("click", openPicker);

  /* =========================================================
     Workspace
     ========================================================= */
  let railPane = "details";   // which pane the side panel shows: "details" or "release"
  function hasRelease(type){ return type === "song" || type === "beat" || type === "project"; }

  // tab is "write", "details" or "release". On phones these are the three tabs;
  // on wider screens the sheet is always visible and only the side panel switches.
  function setTab(tab){
    const w = getWork(activeWorkId);
    if(tab === "release" && w && !hasRelease(w.type)) tab = "details";
    if(tab !== "write") railPane = tab;
    workspaceBody.dataset.tab = tab === "write" ? "write" : "details";
    metaRail.dataset.pane = railPane;
    const current = tab === "write" ? "write" : railPane;
    document.querySelectorAll(".ws-tab").forEach(b => {
      const on = b.dataset.tab === current;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".rail-tab").forEach(b => {
      const on = b.dataset.tab === railPane;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    if(tab === "write") autoGrow();
  }
  function onTabClick(e){
    const b = e.target.closest("[data-tab]");
    if(b) setTab(b.dataset.tab);
  }
  $("wsTabs").addEventListener("click", onTabClick);
  railTabsEl.addEventListener("click", onTabClick);

  // Pieces that are not releasable (ideas, cover art) have no Release info tab
  function syncReleaseUI(w){
    const on = hasRelease(w.type);
    railTabsEl.hidden = !on;
    const phoneTab = document.querySelector('.ws-tab[data-tab="release"]');
    if(phoneTab) phoneTab.hidden = !on;
    if(!on && railPane === "release"){
      setTab(workspaceBody.dataset.tab === "write" ? "write" : "details");
    }
  }

  function autoGrow(){
    if(workspaceEl.hidden) return;
    const keep = sheetWrap.scrollTop;
    lyricsArea.style.height = "auto";
    lyricsArea.style.height = (lyricsArea.scrollHeight + 2) + "px";
    sheetWrap.scrollTop = keep;
  }

  function openWorkspace(id){
    const w = getWork(id);
    if(!w) return;
    activeWorkId = id;

    titleInput.value = w.title;
    lyricsArea.value = w.lyrics;
    typeSelect.value = w.type;
    statusSelect.value = w.status;
    renderTags(w);
    renderTakes(w);
    updateSheetHeader(w);
    updateStats(w);
    markSaved();

    $("deleteWorkBtn").hidden = w.trashed;
    $("restoreWorkBtn").hidden = !w.trashed;

    listViewEl.hidden = true;
    workspaceEl.hidden = false;
    railPane = "details";
    setTab("write");
    syncReleaseUI(w);
    renderMetaForm();
    autoGrow();
    loadMedia(w);

    try{ history.pushState({ greenroom:"workspace" }, ""); wsHistoryPushed = true; }
    catch(e){ wsHistoryPushed = false; }
  }

  function closeWorkspace(){
    if(workspaceEl.hidden) return;
    flushSave();
    stopAudio();
    closeCropper();
    closePreview();
    revokeCover();
    audioToken++; coverToken++;
    audioBusy = false; audioMissing = false;
    workspaceEl.hidden = true;
    listViewEl.hidden = false;
    activeWorkId = null;
    if(wsHistoryPushed){
      wsHistoryPushed = false;
      try{ history.back(); }catch(e){ /* ignore */ }
    }
    renderList();
    renderCounts();
  }
  $("backBtn").addEventListener("click", closeWorkspace);
  window.addEventListener("popstate", () => {
    if(!workspaceEl.hidden){ wsHistoryPushed = false; closeWorkspace(); }
  });

  function updateSheetHeader(w){
    const t = TYPE_META[w.type] || TYPE_META.song;
    sheetType.textContent = t.label.toUpperCase();
    lyricsArea.placeholder = t.placeholder;
  }
  function updateStats(w){
    const wc = wordCount(w.lyrics);
    sheetWords.textContent = wc + (wc === 1 ? " word" : " words");
    $("statWords").textContent = wc;
    $("statCreated").textContent = fullDate(w.created);
    $("statUpdated").textContent = fullDate(w.updated);
  }
  function markUnsaved(){
    saveDot.classList.remove("saved");
    saveText.textContent = "Saving...";
  }
  function markSaved(){
    saveDot.classList.add("saved");
    saveText.textContent = "All changes saved";
  }

  function commitChanges(){
    saveTimer = null;
    const w = getWork(activeWorkId);
    if(!w) return;
    w.title = titleInput.value;
    w.lyrics = lyricsArea.value;
    w.type = typeSelect.value;
    w.status = statusSelect.value;
    w.updated = Date.now();
    if(persist()){ markSaved(); }
    updateSheetHeader(w);
    updateStats(w);
  }
  function scheduleSave(){
    markUnsaved();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(commitChanges, 500);
  }
  function flushSave(){
    if(saveTimer){ clearTimeout(saveTimer); commitChanges(); }
  }

  titleInput.addEventListener("input", scheduleSave);
  lyricsArea.addEventListener("input", () => {
    const wc = wordCount(lyricsArea.value);
    sheetWords.textContent = wc + (wc === 1 ? " word" : " words");
    scheduleSave();
    autoGrow();
  });
  statusSelect.addEventListener("change", commitChanges);
  typeSelect.addEventListener("change", () => {
    commitChanges();
    const w = getWork(activeWorkId);
    if(!w) return;
    syncReleaseUI(w);
    renderMetaForm();
  });

  // Never lose the last few keystrokes
  document.addEventListener("visibilitychange", () => { if(document.visibilityState === "hidden") flushSave(); });
  window.addEventListener("pagehide", flushSave);

  /* ----- Tags ----- */
  function renderTags(w){
    tagListEl.innerHTML = w.tags.map((t, i) => `
      <span class="tag">${escapeHtml(t)}
        <button type="button" data-i="${i}" aria-label="Remove tag ${escapeHtml(t)}">
          <svg width="11" height="11" viewBox="0 0 24 24"><use href="#icon-close"/></svg>
        </button>
      </span>`).join("");
  }
  function addTagFromInput(){
    const v = tagInput.value.replace(/,/g, "").trim();
    if(!v) return;
    const w = getWork(activeWorkId);
    if(!w) return;
    if(!w.tags.includes(v)) w.tags.push(v);
    tagInput.value = "";
    w.updated = Date.now();
    persist();
    renderTags(w);
    updateStats(w);
  }
  tagInput.addEventListener("keydown", (e) => {
    if(e.key === "Enter" || e.key === ","){ e.preventDefault(); addTagFromInput(); }
  });
  tagInput.addEventListener("blur", addTagFromInput);
  tagListEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-i]");
    if(!btn) return;
    const w = getWork(activeWorkId);
    w.tags.splice(Number(btn.dataset.i), 1);
    w.updated = Date.now();
    persist();
    renderTags(w);
  });

  /* =========================================================
     Audio sketch
     ========================================================= */
  function revokeAudioUrl(){
    if(audioUrl){ URL.revokeObjectURL(audioUrl); audioUrl = null; }
  }
  function stopAudio(){
    audioEl.pause();
    audioEl.removeAttribute("src");
    audioEl.load();
    revokeAudioUrl();
  }
  function setAudioSource(buf, type, loop){
    stopAudio();
    audioUrl = URL.createObjectURL(new Blob([buf], { type: type || "audio/mpeg" }));
    audioEl.src = audioUrl;
    audioEl.loop = !!loop;
    audioEl.load();
  }

  async function attachAudio(w){
    const token = ++audioToken;
    stopAudio();
    audioMissing = false;
    if(!w.hasAudio) return;
    const rec = await media.get("audio:" + w.id);
    if(token !== audioToken || activeWorkId !== w.id) return;
    if(!rec){ audioMissing = true; return; }
    setAudioSource(rec.buf, rec.type || w.audioType, w.audioLoop);
  }

  function renderAudio(){
    const w = getWork(activeWorkId);
    if(!w){ audioSlot.innerHTML = ""; return; }

    if(audioBusy){
      audioSlot.innerHTML = `
        <div class="audio-drop busy" aria-busy="true">
          <svg width="26" height="26" viewBox="0 0 24 24"><use href="#icon-audio"/></svg>
          <strong>Importing...</strong>
          <small>Saving to this device</small>
        </div>`;
      return;
    }

    if(!w.hasAudio){
      audioSlot.innerHTML = `
        <button class="audio-drop" id="audioDrop" type="button" data-audio="browse">
          <svg width="28" height="28" viewBox="0 0 24 24"><use href="#icon-upload"/></svg>
          <strong>Import a song or loop</strong>
          <small>Tap to choose a file, or drop one here</small>
          <small>MP3, WAV, M4A, OGG, FLAC</small>
        </button>`;
      wireDropStyle($("audioDrop"));
      return;
    }

    if(audioMissing){
      audioSlot.innerHTML = `
        <div class="audio-missing">
          <strong>The audio file isn't on this device</strong>
          <small>${escapeHtml(w.audioName || "Audio sketch")} was saved here before, but the browser no longer has it.</small>
          <button class="ap-btn" type="button" data-audio="browse">
            <svg width="16" height="16" viewBox="0 0 24 24"><use href="#icon-upload"/></svg> Import it again
          </button>
        </div>`;
      return;
    }

    const kind = (extOf(w.audioName) || "audio").toUpperCase();
    const volatile = volatileKeys.has("audio:" + w.id);
    const meta = [formatBytes(w.audioSize), kind].filter(Boolean).join(" · ");
    audioSlot.innerHTML = `
      <div class="audio-player">
        <div class="ap-top">
          <button class="play-btn" id="audioPlayBtn" type="button" data-audio="play" aria-label="Play">
            <svg width="18" height="18" viewBox="0 0 24 24"><use id="audioPlayIcon" href="#icon-play"/></svg>
          </button>
          <div class="ap-info">
            <div class="audio-track-name" title="${escapeHtml(w.audioName || "")}">${escapeHtml(w.audioName || "Audio sketch")}</div>
            <div class="audio-meta">${escapeHtml(meta)}${volatile ? ' <span class="warn">· this session only</span>' : ""}</div>
          </div>
        </div>
        <input class="seek" id="audioSeek" type="range" min="0" max="1000" step="1" value="0" aria-label="Seek">
        <div class="audio-times"><span id="audioCurrentTime">0:00</span><span id="audioDuration">--:--</span></div>
        <div class="ap-actions">
          <button class="ap-btn" id="audioLoopBtn" type="button" data-audio="loop" aria-pressed="${w.audioLoop ? "true" : "false"}">
            <svg width="16" height="16" viewBox="0 0 24 24"><use href="#icon-loop"/></svg> Loop
          </button>
          <button class="ap-btn" type="button" data-audio="browse">
            <svg width="16" height="16" viewBox="0 0 24 24"><use href="#icon-upload"/></svg> Replace
          </button>
          <button class="ap-btn danger" type="button" data-audio="remove">
            <svg width="16" height="16" viewBox="0 0 24 24"><use href="#icon-trash"/></svg> Remove
          </button>
        </div>
      </div>`;
    updatePlayerUI();
  }

  function updatePlayerUI(){
    const playBtn = $("audioPlayBtn");
    if(!playBtn) return;
    $("audioPlayIcon").setAttribute("href", audioEl.paused ? "#icon-play" : "#icon-pause");
    playBtn.setAttribute("aria-label", audioEl.paused ? "Play" : "Pause");
    const dur = audioEl.duration;
    const cur = audioEl.currentTime || 0;
    const hasDur = isFinite(dur) && dur > 0;
    const seek = $("audioSeek");
    seek.disabled = !hasDur;
    if(!scrubbing){
      const v = hasDur ? Math.round(cur / dur * 1000) : 0;
      seek.value = v;
      seek.style.setProperty("--pct", (v / 10) + "%");
    }
    $("audioCurrentTime").textContent = formatTime(cur);
    $("audioDuration").textContent = hasDur ? formatTime(dur) : "--:--";
  }

  ["play","pause","ended","timeupdate","loadedmetadata","durationchange","seeked"].forEach(ev => {
    audioEl.addEventListener(ev, updatePlayerUI);
  });
  audioEl.addEventListener("loadedmetadata", () => {
    const w = getWork(activeWorkId);
    if(!w || !isFinite(audioEl.duration) || audioEl.duration <= 0) return;
    const secs = Math.round(audioEl.duration);
    if(w.audioDuration !== secs){ w.audioDuration = secs; persist(); }
    updateDurationField();
  });
  audioEl.addEventListener("error", () => {
    if(!audioEl.getAttribute("src")) return;
    showToast("This browser can't play that file. MP3, WAV and M4A are safest.");
  });

  audioSlot.addEventListener("click", (e) => {
    const t = e.target.closest("[data-audio]");
    if(!t) return;
    const w = getWork(activeWorkId);
    if(!w) return;
    const action = t.dataset.audio;
    if(action === "browse"){ audioFileInput.click(); }
    if(action === "play"){
      if(audioEl.paused){
        const p = audioEl.play();
        if(p && p.catch) p.catch(() => showToast("Couldn't start playback"));
      } else { audioEl.pause(); }
    }
    if(action === "loop"){
      w.audioLoop = !w.audioLoop;
      audioEl.loop = w.audioLoop;
      persist();
      t.setAttribute("aria-pressed", w.audioLoop ? "true" : "false");
    }
    if(action === "remove"){
      askConfirm({
        title:"Remove this audio?",
        text:"The file is deleted from this device. Your lyrics, notes and takes stay as they are.",
        okLabel:"Remove audio",
        onOk: async () => {
          stopAudio();
          await media.remove("audio:" + w.id);
          w.hasAudio = false; w.audioName = null; w.audioSize = 0; w.audioType = ""; w.audioDuration = 0;
          w.updated = Date.now();
          persist();
          audioMissing = false;
          renderAudio();
          showToast("Audio removed");
        }
      });
    }
  });

  // Scrubbing the progress bar
  audioSlot.addEventListener("pointerdown", (e) => { if(e.target.id === "audioSeek") scrubbing = true; });
  window.addEventListener("pointerup", () => { if(scrubbing){ scrubbing = false; updatePlayerUI(); } });
  window.addEventListener("pointercancel", () => { scrubbing = false; });
  audioSlot.addEventListener("input", (e) => {
    if(e.target.id !== "audioSeek") return;
    const dur = audioEl.duration;
    if(isFinite(dur) && dur > 0){ audioEl.currentTime = (e.target.value / 1000) * dur; }
    e.target.style.setProperty("--pct", (e.target.value / 10) + "%");
    $("audioCurrentTime").textContent = formatTime(audioEl.currentTime);
  });

  audioFileInput.addEventListener("change", () => {
    const file = audioFileInput.files && audioFileInput.files[0];
    audioFileInput.value = "";
    if(file) importAudio(file);
  });

  async function importAudio(file){
    const w = getWork(activeWorkId);
    if(!w){ showToast("Open a piece first, then import the file"); return; }
    if(!isAudioFile(file)){ showToast("That doesn't look like an audio file"); return; }
    if(file.size > MAX_AUDIO_BYTES){ showToast("That file is over 250 MB. Try a shorter bounce."); return; }

    audioBusy = true;
    renderAudio();
    try{
      const buf = await readFileBuffer(file);
      const type = guessMime(file);
      const where = await media.put("audio:" + w.id, buf, type, file.name);
      w.hasAudio = true;
      w.audioName = file.name;
      w.audioSize = file.size;
      w.audioType = type;
      w.updated = Date.now();
      persist();
      audioMissing = false;
      audioBusy = false;
      if(activeWorkId === w.id){
        audioToken++;
        setAudioSource(buf, type, w.audioLoop);
        renderAudio();
        updateStats(w);
      }
      showToast(where === "idb" ? "Imported " + file.name : "Imported for this session only. Browser storage is blocked.");
    }catch(err){
      console.error(err);
      audioBusy = false;
      renderAudio();
      showToast("Couldn't import that file");
    }
  }

  /* =========================================================
     Cover art: square preview, crop editor, full-size view
     ========================================================= */
  const COVER_STANDARD = 3000;   // usual release size, in px
  const COVER_STORE_MIN = 1400;  // many stores want at least this
  const coverActions = $("coverActions");
  const previewOverlay = $("previewOverlay");
  const previewImg = $("previewImg");
  const previewDims = $("previewDims");
  const previewDownload = $("previewDownload");
  const cropOverlay = $("cropOverlay");
  const cropStage = $("cropStage");
  const cropImg = $("cropImg");
  const cropBox = $("cropBox");
  const cropHole = $("cropHole");
  const cropSize = $("cropSize");
  const cropDims = $("cropDims");
  const cropHint = $("cropHint");
  const cropSave = $("cropSave");
  const crop = { opts:null, url:null, w:0, h:0, minS:0, maxS:0, sel:{ x:0, y:0, s:0 }, drag:null, busy:false };
  let coverMime = "image/jpeg";

  function revokeCover(){
    if(coverUrl){ URL.revokeObjectURL(coverUrl); coverUrl = null; }
  }

  // The frame is always a full square and shows the entire picture, never a trimmed version of it.
  function renderCover(){
    const has = !!coverUrl;
    coverDrop.classList.toggle("has-image", has);
    coverActions.hidden = !has;
    if(has){
      coverDrop.setAttribute("aria-label", "View cover art full size");
      coverDrop.innerHTML = `<img src="${coverUrl}" alt="Cover art">`;
    } else {
      coverDrop.setAttribute("aria-label", "Add cover art");
      coverDrop.innerHTML = `
        <svg width="28" height="28" viewBox="0 0 24 24"><use href="#icon-image"/></svg>
        <strong>Add cover art</strong>
        <small>Tap to choose, or drop an image</small>`;
    }
  }

  async function loadCover(w){
    const token = ++coverToken;
    revokeCover();
    renderCover();
    if(!w.hasCover) return;
    const rec = await media.get("cover:" + w.id);
    if(token !== coverToken || activeWorkId !== w.id || !rec) return;
    coverMime = rec.type || "image/jpeg";
    coverUrl = URL.createObjectURL(new Blob([rec.buf], { type: coverMime }));
    renderCover();
  }

  coverDrop.addEventListener("click", () => {
    if(coverUrl) openPreview(); else coverFileInput.click();
  });
  coverFileInput.addEventListener("change", () => {
    const file = coverFileInput.files && coverFileInput.files[0];
    coverFileInput.value = "";
    if(file) importCover(file);
  });

  coverActions.addEventListener("click", (e) => {
    const b = e.target.closest("[data-cover]");
    if(!b) return;
    const a = b.dataset.cover;
    if(a === "preview") openPreview();
    if(a === "crop") adjustCover();
    if(a === "replace") coverFileInput.click();
    if(a === "remove") removeCover();
  });

  function removeCover(){
    const w = getWork(activeWorkId);
    if(!w) return;
    askConfirm({
      title:"Remove cover art?",
      text:"The image, and the original it was cropped from, are deleted from this device.",
      okLabel:"Remove image",
      onOk: async () => {
        await media.remove("cover:" + w.id);
        await media.remove("coverorig:" + w.id);
        w.hasCover = false; w.hasCoverOrig = false; w.coverCrop = null; w.coverSize = 0;
        w.updated = Date.now();
        persist();
        coverToken++;
        revokeCover();
        renderCover();
        showToast("Cover art removed");
      }
    });
  }

  /* ----- Full-size preview ----- */
  function extFor(mime){
    if(mime === "image/png") return "png";
    if(mime === "image/webp") return "webp";
    return "jpg";
  }
  function openPreview(){
    if(!coverUrl) return;
    const w = getWork(activeWorkId);
    previewDims.textContent = "";
    previewImg.onload = () => {
      previewDims.textContent = previewImg.naturalWidth + " x " + previewImg.naturalHeight + " px";
    };
    previewImg.src = coverUrl;
    previewDownload.href = coverUrl;
    previewDownload.download = ((w && w.title) || "cover").replace(/[^\w\- ]/g, "").trim() + "-cover." + extFor(coverMime);
    previewOverlay.classList.add("active");
    $("previewClose").focus();
  }
  function closePreview(){
    previewOverlay.classList.remove("active");
    previewImg.removeAttribute("src");
  }
  $("previewClose").addEventListener("click", closePreview);
  previewOverlay.addEventListener("click", (e) => { if(e.target === previewOverlay) closePreview(); });

  /* ----- Crop editor ----- */
  function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

  async function importCover(file){
    const w = getWork(activeWorkId);
    if(!w){ showToast("Open a piece first, then add the image"); return; }
    if(!file.type || file.type.indexOf("image/") !== 0){ showToast("That doesn't look like an image"); return; }
    openCropper({ blob: file, name: file.name, saveOrig: true, startSel: null });
  }

  async function adjustCover(){
    const w = getWork(activeWorkId);
    if(!w) return;
    const orig = await media.get("coverorig:" + w.id);
    if(orig){
      openCropper({ blob: new Blob([orig.buf], { type: orig.type }), name: orig.name || "cover", saveOrig: false, startSel: w.coverCrop });
      return;
    }
    // Covers saved by an earlier version have no separate original: crop from the saved image
    const cur = await media.get("cover:" + w.id);
    if(!cur){ showToast("The image isn't on this device. Replace it to crop again."); return; }
    openCropper({ blob: new Blob([cur.buf], { type: cur.type }), name: cur.name || "cover", saveOrig: true, startSel: null });
  }

  function openCropper(opts){
    closeCropper();
    crop.opts = opts;
    crop.url = URL.createObjectURL(opts.blob);
    cropImg.onload = () => {
      crop.w = cropImg.naturalWidth;
      crop.h = cropImg.naturalHeight;
      const short = Math.min(crop.w, crop.h);
      crop.maxS = short;
      crop.minS = Math.min(short, Math.max(100, Math.round(short * 0.08)));
      const st = opts.startSel;
      if(st && st.s >= crop.minS && st.x >= 0 && st.y >= 0 && st.x + st.s <= crop.w + 0.5 && st.y + st.s <= crop.h + 0.5){
        crop.sel = { x: st.x, y: st.y, s: st.s };
      } else {
        resetSelection();
      }
      cropOverlay.classList.add("active");
      cropBox.focus({ preventScroll:true });
      renderSel();
    };
    cropImg.onerror = () => {
      closeCropper();
      showToast("Couldn't open that image. Try a JPG or PNG.");
    };
    cropImg.src = crop.url;
  }

  function closeCropper(){
    cropOverlay.classList.remove("active");
    crop.drag = null;
    crop.busy = false;
    cropSave.disabled = false;
    cropImg.onload = null;
    cropImg.onerror = null;
    if(crop.url){ URL.revokeObjectURL(crop.url); crop.url = null; }
    cropImg.removeAttribute("src");
  }

  function resetSelection(){
    const s = crop.maxS;
    crop.sel = { x: (crop.w - s) / 2, y: (crop.h - s) / 2, s: s };
  }

  function renderSel(){
    if(!crop.w || !cropImg.clientWidth) return;
    const k = cropImg.clientWidth / crop.w;
    const s = crop.sel;
    [cropBox, cropHole].forEach(el => {
      el.style.left = (s.x * k) + "px";
      el.style.top = (s.y * k) + "px";
      el.style.width = (s.s * k) + "px";
      el.style.height = (s.s * k) + "px";
    });
    const px = Math.round(s.s);
    cropDims.textContent = px + " x " + px + " px selected";
    if(px < COVER_STORE_MIN){
      cropHint.textContent = "Small for a release. Many stores want at least " + COVER_STORE_MIN + " x " + COVER_STORE_MIN + " px.";
      cropHint.classList.add("warn");
    } else if(px < COVER_STANDARD){
      cropHint.textContent = "Good for most stores. " + COVER_STANDARD + " x " + COVER_STANDARD + " px is the usual standard.";
      cropHint.classList.remove("warn");
    } else {
      cropHint.textContent = "Saved at " + COVER_STANDARD + " x " + COVER_STANDARD + " px, the usual standard.";
      cropHint.classList.remove("warn");
    }
    const span = crop.maxS - crop.minS;
    const pct = span > 0 ? ((s.s - crop.minS) / span) * 100 : 100;
    cropSize.disabled = span <= 0;
    cropSize.value = Math.round(pct * 10);
    cropSize.style.setProperty("--pct", pct + "%");
  }

  function pointInImage(e){
    const r = cropImg.getBoundingClientRect();
    const k = r.width / crop.w;
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k, k: k };
  }

  cropStage.addEventListener("pointerdown", (e) => {
    if(crop.busy || (e.pointerType === "mouse" && e.button !== 0)) return;
    const pt = pointInImage(e);
    if(!pt.k) return;
    const handle = e.target.closest("[data-h]");
    const sel = crop.sel;
    if(handle){
      const h = handle.dataset.h;
      const east = h === "ne" || h === "se";
      const south = h === "sw" || h === "se";
      // the corner opposite the one being dragged stays fixed
      crop.drag = {
        mode:"resize",
        ax: east ? sel.x : sel.x + sel.s,
        ay: south ? sel.y : sel.y + sel.s,
        sx: east ? 1 : -1,
        sy: south ? 1 : -1
      };
    } else {
      if(!e.target.closest("#cropBox")){
        // tapping outside the frame moves it there
        sel.x = clamp(pt.x - sel.s / 2, 0, crop.w - sel.s);
        sel.y = clamp(pt.y - sel.s / 2, 0, crop.h - sel.s);
        renderSel();
      }
      crop.drag = { mode:"move", px: e.clientX, py: e.clientY, x: sel.x, y: sel.y, k: pt.k };
    }
    try{ cropStage.setPointerCapture(e.pointerId); }catch(err){ /* optional */ }
    e.preventDefault();
  });

  cropStage.addEventListener("pointermove", (e) => {
    const d = crop.drag;
    if(!d) return;
    const sel = crop.sel;
    if(d.mode === "move"){
      sel.x = clamp(d.x + (e.clientX - d.px) / d.k, 0, crop.w - sel.s);
      sel.y = clamp(d.y + (e.clientY - d.py) / d.k, 0, crop.h - sel.s);
    } else {
      const pt = pointInImage(e);
      let size = Math.max((pt.x - d.ax) * d.sx, (pt.y - d.ay) * d.sy);
      const room = Math.min(d.sx > 0 ? crop.w - d.ax : d.ax, d.sy > 0 ? crop.h - d.ay : d.ay);
      size = clamp(size, crop.minS, Math.min(room, crop.maxS));
      sel.s = size;
      sel.x = d.sx > 0 ? d.ax : d.ax - size;
      sel.y = d.sy > 0 ? d.ay : d.ay - size;
    }
    renderSel();
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(ev => {
    cropStage.addEventListener(ev, () => { crop.drag = null; });
  });

  // Frame size slider keeps the frame centred where it is
  cropSize.addEventListener("input", () => {
    const sel = crop.sel;
    const ns = crop.minS + (cropSize.value / 1000) * (crop.maxS - crop.minS);
    const cx = sel.x + sel.s / 2;
    const cy = sel.y + sel.s / 2;
    sel.s = ns;
    sel.x = clamp(cx - ns / 2, 0, crop.w - ns);
    sel.y = clamp(cy - ns / 2, 0, crop.h - ns);
    renderSel();
  });

  // Keyboard: arrows nudge the frame, Shift moves it further
  cropBox.addEventListener("keydown", (e) => {
    const step = Math.max(1, crop.sel.s * (e.shiftKey ? 0.05 : 0.01));
    const sel = crop.sel;
    let used = true;
    if(e.key === "ArrowLeft") sel.x = clamp(sel.x - step, 0, crop.w - sel.s);
    else if(e.key === "ArrowRight") sel.x = clamp(sel.x + step, 0, crop.w - sel.s);
    else if(e.key === "ArrowUp") sel.y = clamp(sel.y - step, 0, crop.h - sel.s);
    else if(e.key === "ArrowDown") sel.y = clamp(sel.y + step, 0, crop.h - sel.s);
    else used = false;
    if(used){ e.preventDefault(); renderSel(); }
  });

  window.addEventListener("resize", () => { if(cropOverlay.classList.contains("active")) renderSel(); });

  $("cropCancel").addEventListener("click", closeCropper);
  $("cropReset").addEventListener("click", () => { resetSelection(); renderSel(); });
  cropSave.addEventListener("click", applyCrop);

  async function applyCrop(){
    const w = getWork(activeWorkId);
    if(!w || !crop.opts || crop.busy){ closeCropper(); return; }
    crop.busy = true;
    cropSave.disabled = true;
    try{
      const s = crop.sel;
      const out = Math.max(1, Math.min(COVER_STANDARD, Math.round(s.s)));
      const canvas = document.createElement("canvas");
      canvas.width = out;
      canvas.height = out;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out, out);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(cropImg, s.x, s.y, s.s, s.s, 0, 0, out, out);
      const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.92));
      if(!blob) throw new Error("Could not encode the image");
      const buf = await blob.arrayBuffer();

      const o = crop.opts;
      let where = await media.put("cover:" + w.id, buf, "image/jpeg", o.name);
      if(o.saveOrig){
        const ob = await readFileBuffer(o.blob);
        const where2 = await media.put("coverorig:" + w.id, ob, o.blob.type || "image/jpeg", o.name);
        if(where2 !== "idb") where = where2;
        w.hasCoverOrig = true;
      }
      w.hasCover = true;
      w.coverCrop = { x: s.x, y: s.y, s: s.s };
      w.coverSize = out;
      w.updated = Date.now();
      persist();

      coverToken++;
      revokeCover();
      coverMime = "image/jpeg";
      coverUrl = URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
      closeCropper();
      renderCover();
      showToast(where === "idb" ? "Cover art saved at " + out + " x " + out + " px" : "Cover art kept for this session only");
    }catch(err){
      console.error(err);
      crop.busy = false;
      cropSave.disabled = false;
      showToast("Couldn't save the cover art");
    }
  }

  function loadMedia(w){
    audioBusy = false;
    audioMissing = false;
    renderAudio();
    attachAudio(w).then(() => { if(activeWorkId === w.id) renderAudio(); });
    loadCover(w);
  }

  /* ----- Drag and drop (anywhere in the workspace) ----- */
  function wireDropStyle(el){
    if(!el) return;
    ["dragenter","dragover"].forEach(ev => el.addEventListener(ev, () => el.classList.add("dragover")));
    el.addEventListener("dragleave", (e) => { if(!el.contains(e.relatedTarget)) el.classList.remove("dragover"); });
    el.addEventListener("drop", () => el.classList.remove("dragover"));
  }
  wireDropStyle(coverDrop);

  function hasFiles(e){
    return !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1);
  }
  // Without this, a missed drop makes the browser open the file and leave the app.
  window.addEventListener("dragover", (e) => {
    if(hasFiles(e)){ e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
  });
  window.addEventListener("drop", (e) => {
    if(!hasFiles(e)) return;
    e.preventDefault();
    document.querySelectorAll(".dragover").forEach(el => el.classList.remove("dragover"));
    const files = Array.prototype.slice.call(e.dataTransfer.files || []);
    if(!files.length) return;
    if(workspaceEl.hidden){ showToast("Open a piece first, then drop the file in"); return; }
    if(cropOverlay.classList.contains("active") || previewOverlay.classList.contains("active")) return;
    const audio = files.find(isAudioFile);
    const img = files.find(f => f.type && f.type.indexOf("image/") === 0);
    if(audio) importAudio(audio);
    if(img) importCover(img);
    if(!audio && !img) showToast("Drop an audio file or an image");
  });

  /* =========================================================
     Takes (saved versions)
     ========================================================= */
  function pushTake(w, auto){
    const nextNum = w.takes.reduce((m, t) => Math.max(m, t.num), 0) + 1;
    w.takes.push({ num: nextNum, lyrics: w.lyrics, title: w.title, savedAt: Date.now(), auto: !!auto });
    return nextNum;
  }
  function renderTakes(w){
    if(!w.takes.length){
      takesListEl.innerHTML = '<div class="take-empty">No takes saved yet. Save one before a big rewrite.</div>';
      return;
    }
    takesListEl.innerHTML = w.takes.slice().reverse().map(t => `
      <div class="take-item">
        <div class="take-num">#${String(t.num).padStart(2, "0")}</div>
        <div class="take-info">
          <div class="take-time">${relativeTime(t.savedAt)}</div>
          <div class="take-words">${wordCount(t.lyrics)} words${t.auto ? " · auto, before a restore" : ""}</div>
        </div>
        <button class="take-restore" type="button" data-num="${t.num}">Restore</button>
      </div>`).join("");
  }
  $("saveTakeBtn").addEventListener("click", () => {
    const w = getWork(activeWorkId);
    if(!w) return;
    flushSave();
    commitChanges();
    const n = pushTake(w, false);
    persist();
    renderTakes(w);
    showToast("Take #" + String(n).padStart(2, "0") + " saved");
  });
  takesListEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-num]");
    if(!btn) return;
    const w = getWork(activeWorkId);
    const take = w && w.takes.find(t => t.num === Number(btn.dataset.num));
    if(!take) return;
    flushSave();
    commitChanges();
    // Keep what's on the sheet now so a restore can never lose work
    if(w.lyrics !== take.lyrics || w.title !== take.title){ pushTake(w, true); }
    lyricsArea.value = take.lyrics;
    titleInput.value = take.title;
    commitChanges();
    autoGrow();
    renderTakes(w);
    showToast("Restored take #" + String(take.num).padStart(2, "0"));
  });

  /* ----- Export ----- */
  $("exportBtn").addEventListener("click", () => {
    const w = getWork(activeWorkId);
    if(!w) return;
    flushSave();
    const blob = new Blob([(w.title || "Untitled") + "\n\n" + w.lyrics], { type:"text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (w.title || "untitled").replace(/[^\w\- ]/g, "").trim() + ".txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Exported as text file");
  });

  /* =========================================================
     Confirm dialog, trash, restore
     ========================================================= */
  function askConfirm(opts){
    $("confirmTitle").textContent = opts.title;
    $("confirmText").textContent = opts.text;
    $("confirmOk").textContent = opts.okLabel;
    confirmHandler = opts.onOk;
    confirmOverlay.classList.add("active");
    $("confirmCancel").focus();
  }
  function closeConfirm(){
    confirmOverlay.classList.remove("active");
    confirmHandler = null;
  }
  $("confirmCancel").addEventListener("click", closeConfirm);
  $("confirmOk").addEventListener("click", () => {
    const fn = confirmHandler;
    closeConfirm();
    if(fn) fn();
  });
  [confirmOverlay, ideaOverlay, newOverlay].forEach(o => {
    o.addEventListener("click", (e) => { if(e.target === o){ o.classList.remove("active"); confirmHandler = null; } });
  });

  function trashWork(id){
    askConfirm({
      title:"Move to trash?",
      text:"This piece moves to Trash. You can restore it any time.",
      okLabel:"Move to trash",
      onOk: () => {
        const w = getWork(id);
        if(!w) return;
        w.trashed = true;
        w.updated = Date.now();
        persist();
        if(activeWorkId === id){ closeWorkspace(); } else { renderList(); renderCounts(); }
        showToast("Moved to trash");
      }
    });
  }
  function wipeWork(id){
    askConfirm({
      title:"Delete forever?",
      text:"This permanently deletes the piece: lyrics, takes, audio and cover art. It can't be undone.",
      okLabel:"Delete forever",
      onOk: async () => {
        works = works.filter(w => w.id !== id);
        persist();
        renderList();
        renderCounts();
        await media.remove("audio:" + id);
        await media.remove("cover:" + id);
        await media.remove("coverorig:" + id);
        showToast("Deleted permanently");
      }
    });
  }
  function restoreWork(id){
    const w = getWork(id);
    if(!w) return;
    w.trashed = false;
    w.updated = Date.now();
    persist();
    if(activeWorkId === id){ closeWorkspace(); } else { renderList(); renderCounts(); }
    showToast("Restored to All works");
  }
  $("deleteWorkBtn").addEventListener("click", () => { if(activeWorkId) trashWork(activeWorkId); });
  $("restoreWorkBtn").addEventListener("click", () => { if(activeWorkId) restoreWork(activeWorkId); });

  /* =========================================================
     Quick idea capture
     ========================================================= */
  $("quickIdeaBtn").addEventListener("click", () => {
    closeDrawer();
    ideaText.value = "";
    ideaOverlay.classList.add("active");
    setTimeout(() => ideaText.focus(), 60);
  });
  $("cancelIdeaBtn").addEventListener("click", () => ideaOverlay.classList.remove("active"));
  $("saveIdeaBtn").addEventListener("click", () => {
    const text = ideaText.value.trim();
    if(!text) return;
    works.unshift(normalize({
      id: uid(), title: text.split("\n")[0].slice(0, 50), type:"idea", lyrics: text
    }));
    persist();
    ideaOverlay.classList.remove("active");
    renderCounts();
    if(workspaceEl.hidden) renderList();
    showToast("Idea saved to Ideas");
  });

  /* =========================================================
     Toast, keyboard, resize
     ========================================================= */
  let toastTimer = null;
  function showToast(msg){
    const toast = $("toast");
    $("toastText").textContent = msg;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  document.addEventListener("keydown", (e) => {
    if(e.key !== "Escape") return;
    if(cropOverlay.classList.contains("active")){ closeCropper(); return; }
    if(previewOverlay.classList.contains("active")){ closePreview(); return; }
    if(newOverlay.classList.contains("active")){ closePicker(); return; }
    if(confirmOverlay.classList.contains("active")){ closeConfirm(); return; }
    if(ideaOverlay.classList.contains("active")){ ideaOverlay.classList.remove("active"); return; }
    if(appEl.classList.contains("rail-open")){ closeDrawer(); return; }
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if(!workspaceEl.hidden && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag)){ closeWorkspace(); }
  });

  window.addEventListener("resize", () => {
    if(window.innerWidth >= 900) closeDrawer();
    autoGrow();
  });

  /* =========================================================
     New work: choose a category
     ========================================================= */
  const TYPE_ORDER = ["song", "beat", "cover", "idea", "project"];

  function renderPicker(){
    pickList.innerHTML = TYPE_ORDER.map(k => {
      const t = TYPE_META[k];
      return `
        <button class="pick-row" type="button" data-type="${k}">
          <span class="pick-glyph" style="color:${t.color}"><svg width="22" height="22" viewBox="0 0 24 24"><use href="#${t.icon}"/></svg></span>
          <span class="pick-text"><strong>${escapeHtml(t.title)}</strong><span>${escapeHtml(t.blurb)}</span></span>
          <svg class="pick-chev" width="18" height="18" viewBox="0 0 24 24"><use href="#icon-chevron"/></svg>
        </button>`;
    }).join("");
  }
  function openPicker(){
    closeDrawer();
    renderPicker();
    newOverlay.classList.add("active");
    const first = pickList.querySelector('[data-type="' + currentFilter + '"]') || pickList.firstElementChild;
    if(first) first.focus();
  }
  function closePicker(){ newOverlay.classList.remove("active"); }

  pickList.addEventListener("click", (e) => {
    const b = e.target.closest("[data-type]");
    if(!b) return;
    closePicker();
    newWork(b.dataset.type);
  });
  pickList.addEventListener("keydown", (e) => {
    if(e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.prototype.slice.call(pickList.querySelectorAll(".pick-row"));
    const i = rows.indexOf(document.activeElement);
    const next = e.key === "ArrowDown" ? (i + 1) % rows.length : (i - 1 + rows.length) % rows.length;
    rows[next].focus();
    e.preventDefault();
  });
  $("newClose").addEventListener("click", closePicker);

  /* =========================================================
     Release info: what distributors and Spotify ask for
     ========================================================= */
  const GENRES = ["Afrobeats", "Afro Pop", "Amapiano", "Afro Fusion", "Afro Soul", "Highlife", "Hiplife", "Azonto", "Hip-Hop / Rap", "Drill", "Trap", "R&B / Soul", "Pop", "Dancehall", "Reggae", "Gospel", "Afro Gospel", "Electronic", "House", "Afro House", "Jazz", "Rock", "Alternative", "Latin", "Country", "Classical", "Singer / Songwriter", "Instrumental"];
  const LANGUAGES = ["English", "Twi (Akan)", "Fante", "Ga", "Ewe", "Hausa", "Pidgin English", "Yoruba", "Igbo", "French", "Swahili", "Zulu", "Xhosa", "Portuguese", "Spanish", "Arabic", "Hindi", "Korean", "Japanese", "No lyrics"];
  const DISTRIBUTORS = ["DistroKid", "TuneCore", "CD Baby", "Ditto Music", "AWAL", "UnitedMasters", "Amuse", "Believe", "Africori", "Soundrop", "Stem", "Self-release"];
  const SOCIETIES = ["GHAMRO", "ASCAP", "BMI", "SESAC", "PRS", "SOCAN", "SAMRO", "COSON", "MCSN", "SACEM", "GEMA", "None yet"];
  const ROLES = ["Songwriter", "Composer", "Lyricist", "Producer", "Co-producer", "Executive producer", "Lead vocalist", "Backing vocalist", "Featured artist", "Musician", "Arranger", "Recording engineer", "Mixing engineer", "Mastering engineer", "Other"];
  const WRITING_ROLES = ["Songwriter", "Composer", "Lyricist"];
  const NEXT_ROLES = ["Songwriter", "Producer", "Lyricist", "Mixing engineer", "Mastering engineer", "Other"];
  const KEYS = (function(){
    const notes = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
    const out = [["", "Not set"]];
    notes.forEach(n => out.push([n + " major", n + " major"]));
    notes.forEach(n => out.push([n + " minor", n + " minor"]));
    return out;
  })();
  const DATALISTS = { genre: GENRES, language: LANGUAGES, distributor: DISTRIBUTORS, pro: SOCIETIES };

  // Gentle format checks. They warn, they never block.
  const CHECKS = {
    isrc: v => {
      const s = v.replace(/[^A-Za-z0-9]/g, "");
      return !s || /^[A-Za-z]{2}[A-Za-z0-9]{3}\d{7}$/.test(s) ? "" : "An ISRC has 12 characters: 2 letters, then 3 letters or digits, then 7 digits.";
    },
    upc: v => {
      const n = v.replace(/\D/g, "").length;
      return !v.trim() || n === 12 || n === 13 ? "" : "A barcode has 12 or 13 digits.";
    },
    iswc: v => !v.trim() || /^T-?\d{3}\.?\d{3}\.?\d{3}-?\d$/i.test(v.trim()) ? "" : "An ISWC looks like T-123.456.789-0.",
    spotify: v => !v.trim() || /spotify\.com\/|^spotify:/i.test(v) ? "" : "Paste the link from your Spotify artist profile.",
    apple: v => !v.trim() || /apple\.com\//i.test(v) ? "" : "Paste the link from your Apple Music artist page."
  };

  /* ----- field builders ----- */
  function fText(k, label, o){ return Object.assign({ k: k, label: label, t: "text" }, o || {}); }
  function fNum(k, label, o){ return Object.assign({ k: k, label: label, t: "number" }, o || {}); }
  function fDate(k, label, o){ return Object.assign({ k: k, label: label, t: "date" }, o || {}); }
  function fSel(k, label, options, o){ return Object.assign({ k: k, label: label, t: "select", options: options }, o || {}); }
  function fYes(k, label, o){ return fSel(k, label, [["", "Choose one"], ["no", "No"], ["yes", "Yes"]], o); }
  function fArea(k, label, o){ return Object.assign({ k: k, label: label, t: "area" }, o || {}); }
  function fCheck(k, label, o){ return Object.assign({ k: k, label: label, t: "check" }, o || {}); }
  function fTags(k, label, o){ return Object.assign({ k: k, label: label, t: "tags" }, o || {}); }

  const ALL_TYPES = ["song", "beat", "project"];
  const META_SECTIONS = [
    { id:"track", title:"Track", types:["song", "beat"], fields:[
      fText("trackTitle", "Track title", { ph:"Uses the title above if left blank" }),
      fText("trackVersion", "Version", { ph:"Remix, Acoustic, Live, Radio edit", hint:"Leave blank for the original version." }),
      fText("primaryArtist", "Primary artist(s)", { hint:"The name listeners will see. Separate several artists with commas." }),
      fText("featuredArtists", "Featured artist(s)"),
      [ fNum("trackNo", "Track number", { min:1, step:1 }), fNum("bpm", "BPM", { min:20, max:300, step:1 }) ],
      [ fSel("key", "Key", KEYS), { k:"duration", label:"Duration", t:"duration" } ],
      fText("isrc", "ISRC", { ph:"GH-A12-26-00001", check:"isrc", hint:"12 characters. Your distributor can assign one if you leave it blank." }),
      fText("genre", "Primary genre", { list:"genre" }),
      fText("subgenre", "Secondary genre", { list:"genre" }),
      fText("language", "Language of lyrics", { list:"language", ph:"English, Twi, Pidgin" }),
      fSel("explicit", "Explicit content", [["", "Choose one"], ["no", "Not explicit"], ["explicit", "Explicit"], ["clean", "Clean edit of an explicit track"]]),
      fCheck("instrumental", "This track is instrumental, with no lyrics"),
      fNum("previewStart", "Preview start (seconds)", { min:0, step:1, hint:"Where the short preview on streaming apps should begin." })
    ]},
    { id:"release", title:"Release", types:ALL_TYPES, fields:[
      fText("releaseTitle", "Release title", { ph:"Uses the track title if left blank", hint:"For a single this is usually the same as the track." }),
      fSel("releaseType", "Release type", [["single", "Single"], ["ep", "EP"], ["album", "Album"], ["mixtape", "Mixtape"]]),
      fText("label", "Label", { ph:"Independent" }),
      [ fDate("releaseDate", "Release date"), fDate("originalReleaseDate", "Original release date") ],
      { note:"Submit at least 7 days before the release date so you can pitch to Spotify editors. Only fill in the original release date if it came out before." },
      fText("upc", "UPC or EAN barcode", { check:"upc", hint:"12 or 13 digits. Your distributor can assign one if you leave it blank." }),
      fText("distributor", "Distributor", { list:"distributor" }),
      fText("territories", "Territories", { ph:"Worldwide", hint:"List countries only if you want to limit where it is sold." }),
      fText("pLine", "P line (sound recording)", { ph:"2026 Your name or label" }),
      fText("cLine", "C line (composition and artwork)", { ph:"2026 Your name or label" }),
      fArea("tracklist", "Tracklist", { rows:6, ph:"One track per line, in order", types:["project"] })
    ]},
    { id:"credits", title:"Credits and splits", types:ALL_TYPES, special:"credits" },
    { id:"rights", title:"Rights and publishing", types:["song", "beat"], fields:[
      fText("iswc", "ISWC", { ph:"T-123.456.789-0", check:"iswc", hint:"Given by your rights society once the song is registered." }),
      fText("publisher", "Publisher", { ph:"Self-published, or the company name" }),
      fText("pro", "Rights society", { list:"pro", ph:"GHAMRO, ASCAP, PRS" }),
      fText("ipi", "IPI number", { ph:"9 to 11 digits", hint:"Your songwriter number from your rights society." }),
      fYes("isCover", "Is this a cover of someone else's song?"),
      fText("originalWriter", "Original songwriter and song", { showIf: m => m.isCover === "yes" }),
      fYes("hasSamples", "Does it contain samples or interpolations?"),
      fArea("sampleNotes", "Sample details", { rows:3, ph:"What was used, who owns it, and whether it is cleared", showIf: m => m.hasSamples === "yes" }),
      fSel("beatLicense", "Beat license", [["", "Not set"], ["none", "Not for sale"], ["lease", "Non-exclusive lease"], ["exclusive", "Exclusive rights"], ["sold", "Sold or transferred"]], { types:["beat"] })
    ]},
    { id:"pitch", title:"Pitch and links", types:ALL_TYPES, fields:[
      fText("spotifyArtist", "Spotify artist link", { ph:"https://open.spotify.com/artist/", check:"spotify", url:true }),
      fText("appleArtist", "Apple Music artist link", { ph:"https://music.apple.com/", check:"apple", url:true }),
      fTags("moods", "Moods", { ph:"Chill, energetic, romantic, then Enter" }),
      fTags("instruments", "Instruments", { ph:"Log drum, 808, guitar, then Enter" }),
      fArea("pitch", "About this release", { rows:5, max:500, ph:"What it is about, how it was made, and why listeners will care.", hint:"Editors read this when you pitch. 500 characters at most." })
    ]}
  ];
  const RERENDER_KEYS = ["isCover", "hasSamples", "instrumental"];
  const metaOpen = {};   // which sections are expanded, kept while the form redraws

  function fieldVisible(f, w){
    if(f.types && f.types.indexOf(w.type) === -1) return false;
    if(f.showIf && !f.showIf(w.meta)) return false;
    return true;
  }
  function fieldsOf(sec){
    const out = [];
    (sec.fields || []).forEach(item => (Array.isArray(item) ? item : [item]).forEach(f => { if(f.k) out.push(f); }));
    return out;
  }
  function sectionFor(key){
    for(let i = 0; i < META_SECTIONS.length; i++){
      if(fieldsOf(META_SECTIONS[i]).some(f => f.k === key)) return META_SECTIONS[i].id;
    }
    return null;
  }

  function hintHtml(f, v){
    if(!f.hint && !f.check) return "";
    const msg = f.check ? CHECKS[f.check](String(v || "")) : "";
    return '<div class="field-hint' + (msg ? " warn" : "") + '" id="h-' + f.k + '" data-hint="' + escapeHtml(f.hint || "") + '">' + escapeHtml(msg || f.hint || "") + "</div>";
  }
  function tagsHtml(k, list){
    return list.map((t, i) => `
      <span class="tag">${escapeHtml(t)}
        <button type="button" data-tagdel="${k}" data-i="${i}" aria-label="Remove ${escapeHtml(t)}">
          <svg width="11" height="11" viewBox="0 0 24 24"><use href="#icon-close"/></svg>
        </button>
      </span>`).join("");
  }
  function durationHtml(w){
    return w.audioDuration
      ? '<div class="readonly" id="m-duration">' + formatTime(w.audioDuration) + "</div>"
      : '<div class="readonly empty" id="m-duration">Read from your audio</div>';
  }

  function fieldHtml(f, w){
    if(!fieldVisible(f, w)) return "";
    const k = f.k, id = "m-" + k, v = w.meta[k] == null ? "" : w.meta[k];
    const label = '<label for="' + id + '">' + escapeHtml(f.label) + "</label>";
    if(f.t === "text" || f.t === "number" || f.t === "date"){
      const a = ['id="' + id + '"', 'class="text-field"', 'data-meta="' + k + '"', 'type="' + f.t + '"', 'value="' + escapeHtml(v) + '"'];
      if(f.ph) a.push('placeholder="' + escapeHtml(f.ph) + '"');
      if(f.list) a.push('list="dl-' + f.list + '"');
      if(f.t === "number"){
        a.push('inputmode="decimal"');
        ["min", "max", "step"].forEach(n => { if(f[n] != null) a.push(n + '="' + f[n] + '"'); });
      }
      if(f.t === "text"){ a.push('autocomplete="off"'); if(f.url) a.push('inputmode="url"'); }
      return '<div class="field-row">' + label + "<input " + a.join(" ") + ">" + hintHtml(f, v) + "</div>";
    }
    if(f.t === "select"){
      const opts = f.options.map(o => '<option value="' + escapeHtml(o[0]) + '"' + (o[0] === v ? " selected" : "") + ">" + escapeHtml(o[1]) + "</option>").join("");
      return '<div class="field-row">' + label + '<select id="' + id + '" data-meta="' + k + '">' + opts + "</select>" + hintHtml(f, v) + "</div>";
    }
    if(f.t === "area"){
      const max = f.max ? ' maxlength="' + f.max + '"' : "";
      const count = f.max ? '<div class="field-count" id="c-' + k + '">' + String(v).length + " / " + f.max + "</div>" : "";
      return '<div class="field-row">' + label + '<textarea class="text-field" id="' + id + '" data-meta="' + k + '" rows="' + (f.rows || 3) + '"' + max +
             (f.ph ? ' placeholder="' + escapeHtml(f.ph) + '"' : "") + ">" + escapeHtml(v) + "</textarea>" + count + hintHtml(f, v) + "</div>";
    }
    if(f.t === "check"){
      return '<label class="check-row"><input type="checkbox" id="' + id + '" data-meta="' + k + '"' + (v ? " checked" : "") + "><span>" + escapeHtml(f.label) + "</span></label>";
    }
    if(f.t === "tags"){
      return '<div class="field-row">' + label + '<input class="text-field" id="' + id + '" type="text" data-tags="' + k + '" autocomplete="off" enterkeyhint="done"' +
             (f.ph ? ' placeholder="' + escapeHtml(f.ph) + '"' : "") + '><div class="tag-list" id="tags-' + k + '">' + tagsHtml(k, v) + "</div></div>";
    }
    if(f.t === "duration"){
      return '<div class="field-row"><label>' + escapeHtml(f.label) + "</label>" + durationHtml(w) + "</div>";
    }
    return "";
  }

  function creditsHtml(w){
    const rows = w.meta.credits.map(c => `
      <div class="credit-row" data-cid="${c.id}">
        <input class="text-field credit-name" type="text" data-credit="name" value="${escapeHtml(c.name)}" placeholder="Full legal name" aria-label="Name" autocomplete="off">
        <select data-credit="role" aria-label="Role">${ROLES.map(r => '<option value="' + r + '"' + (r === c.role ? " selected" : "") + ">" + r + "</option>").join("")}</select>
        <input class="text-field" type="number" data-credit="split" min="0" max="100" step="0.01" inputmode="decimal" value="${escapeHtml(c.split)}" placeholder="%" aria-label="Split percent">
        <button class="row-icon-btn" type="button" data-credit-remove aria-label="Remove credit">
          <svg width="16" height="16" viewBox="0 0 24 24"><use href="#icon-close"/></svg>
        </button>
      </div>`).join("");
    return `
      <p class="field-note">Credit everyone who wrote, produced, performed or engineered this. A split is each person's share of the songwriting, and the splits should add up to 100%.</p>
      <div id="creditsList">${rows}</div>
      <div class="credit-total" id="creditTotal"></div>
      <button class="ap-btn" type="button" id="addCreditBtn">
        <svg width="16" height="16" viewBox="0 0 24 24"><use href="#icon-plus"/></svg> Add credit
      </button>`;
  }
  function renderCreditTotal(w){
    const el = $("creditTotal");
    if(!el) return;
    const given = w.meta.credits.filter(c => String(c.split).trim() !== "");
    const sum = given.reduce((n, c) => n + (parseFloat(c.split) || 0), 0);
    const rounded = Math.round(sum * 100) / 100;
    el.classList.remove("warn", "good");
    if(!given.length){
      el.textContent = w.meta.credits.length ? "Add splits if the songwriting is shared." : "";
    } else if(Math.abs(sum - 100) < 0.005){
      el.textContent = "Splits total 100%.";
      el.classList.add("good");
    } else {
      el.textContent = "Splits total " + rounded + "%. They should add up to 100%.";
      el.classList.add("warn");
    }
  }

  function sectionHtml(sec, w){
    if(sec.types.indexOf(w.type) === -1) return "";
    const first = w.type === "project" ? "release" : "track";
    const open = (sec.id in metaOpen) ? metaOpen[sec.id] : sec.id === first;
    let body;
    if(sec.special === "credits"){
      body = creditsHtml(w);
    } else {
      body = sec.fields.map(item => {
        if(Array.isArray(item)){
          const cells = item.map(f => fieldHtml(f, w)).join("");
          return cells ? '<div class="field-grid">' + cells + "</div>" : "";
        }
        if(item.note) return '<p class="field-note">' + escapeHtml(item.note) + "</p>";
        return fieldHtml(item, w);
      }).join("");
    }
    return '<details class="msec" data-sec="' + sec.id + '"' + (open ? " open" : "") + "><summary><span>" + escapeHtml(sec.title) +
           '</span><svg class="chev" width="18" height="18" viewBox="0 0 24 24"><use href="#icon-chevron"/></svg></summary><div class="msec-body">' + body + "</div></details>";
  }

  function datalistsHtml(){
    return Object.keys(DATALISTS).map(name =>
      '<datalist id="dl-' + name + '">' + DATALISTS[name].map(x => '<option value="' + escapeHtml(x) + '"></option>').join("") + "</datalist>").join("");
  }

  function renderMetaForm(refocusId){
    const w = getWork(activeWorkId);
    if(!w || !hasRelease(w.type)){ metaForm.innerHTML = ""; return; }
    const top = metaRail.scrollTop;
    metaForm.innerHTML =
      '<div class="ready" id="readyBox"></div>' +
      META_SECTIONS.map(sec => sectionHtml(sec, w)).join("") +
      '<div class="meta-actions"><button class="btn btn-ghost" type="button" id="copyReleaseBtn">' +
      '<svg width="16" height="16" viewBox="0 0 24 24"><use href="#icon-copy"/></svg> Copy release info</button></div>' +
      datalistsHtml();
    renderCreditTotal(w);
    renderReadiness();
    metaRail.scrollTop = top;
    if(refocusId){
      const el = document.getElementById(refocusId);
      if(el) el.focus({ preventScroll:true });
    }
  }

  function updateDurationField(){
    const el = $("m-duration");
    const w = getWork(activeWorkId);
    if(el && w) el.outerHTML = durationHtml(w);
    renderReadiness();
  }

  /* ----- readiness checklist ----- */
  function readinessItems(w){
    const m = w.meta, items = [];
    const add = (id, label, done, o) => items.push(Object.assign({ id: id, label: label, done: !!done }, o || {}));
    const hasWriter = m.credits.some(c => c.name.trim() && WRITING_ROLES.indexOf(c.role) !== -1);
    const project = w.type === "project";

    if(project) add("title", "Release title", (m.releaseTitle || w.title).trim(), { jump:"releaseTitle", help:"Add a title above or in the Release section." });
    else add("title", "Track title", (m.trackTitle || w.title).trim(), { jump:"trackTitle", help:"Add a title above or in the Track section." });
    add("artist", "Primary artist", m.primaryArtist.trim(), { jump:"primaryArtist", help:"The name listeners will see." });
    add("date", "Release date", m.releaseDate, { jump:"releaseDate", help:"Submit at least 7 days ahead to pitch to Spotify editors." });
    add("genre", "Genre", m.genre.trim(), { jump:"genre", help:"Pick the closest genre." });
    if(!project){
      add("language", "Language of lyrics", m.instrumental || m.language.trim(), { jump: m.instrumental ? "instrumental" : "language", help:"Choose a language, or tick Instrumental." });
      add("explicit", "Explicit content setting", m.explicit, { jump:"explicit", help:"Tell stores whether there is explicit language." });
      add("writer", "A songwriter or composer credit", hasWriter, { jump:"credits", help:"Add yourself under Credits and splits." });
    }
    add("lines", "P line and C line", m.pLine.trim() && m.cLine.trim(), { jump: m.pLine.trim() ? "cLine" : "pLine", help:"Usually the year followed by your name or label." });

    const px = w.coverSize || 0;
    if(!w.hasCover){
      add("cover", "Cover art", false, { jump:"cover", help:"Add square art. 3000 x 3000 px is the usual standard." });
    } else if(px < 1400){
      add("cover", "Cover art", false, { jump:"cover", help: px ? "It is " + px + " x " + px + " px. Stores want at least 1400 x 1400." : "Open Adjust crop and save it to set the size." });
    } else {
      add("cover", "Cover art", true, { jump:"cover", detail: px + " x " + px + " px" + (px < 3000 ? ". 3000 is the usual standard." : ""), warn: px < 3000 });
    }

    if(project){
      add("tracklist", "Tracklist", m.tracklist.trim(), { jump:"tracklist", help:"List the tracks in order." });
    } else if(!w.hasAudio){
      add("audio", "Final audio file", false, { jump:"audio", help:"Import the audio under Audio and details." });
    } else {
      const ext = (extOf(w.audioName) || "").toUpperCase();
      add("audio", "Final audio file", true, { jump:"audio", detail: ext + (ext && ext !== "WAV" ? ". Most distributors want a WAV file." : ""), warn: !!ext && ext !== "WAV" });
    }
    return items;
  }

  function readyItemHtml(i){
    const detail = i.done ? i.detail : i.help;
    return '<li><button type="button" class="ready-item' + (i.done ? " done" : "") + '" data-jump="' + i.jump + '">' +
      '<svg class="ri-icon" width="18" height="18" viewBox="0 0 24 24"><use href="#icon-' + (i.done ? "check" : "circle") + '"/></svg>' +
      '<span><span class="ri-label">' + escapeHtml(i.label) + "</span>" +
      (detail ? '<span class="ri-detail' + (i.warn ? " warn" : "") + '">' + escapeHtml(detail) + "</span>" : "") +
      "</span></button></li>";
  }

  function renderReadiness(){
    const box = $("readyBox");
    const w = getWork(activeWorkId);
    if(!box || !w || workspaceEl.hidden) return;
    const items = readinessItems(w);
    const done = items.filter(i => i.done);
    const todo = items.filter(i => !i.done);
    const pct = Math.round(done.length / items.length * 100);
    box.classList.toggle("complete", todo.length === 0);
    box.innerHTML =
      '<div class="ready-head"><span class="ready-title">' + (todo.length ? "Ready to release?" : "Ready to release") + '</span><span class="ready-count">' + done.length + " of " + items.length + "</span></div>" +
      '<div class="ready-bar" role="progressbar" aria-label="Release readiness" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span style="width:' + pct + '%"></span></div>' +
      (todo.length
        ? '<ul class="ready-list">' + todo.map(readyItemHtml).join("") + "</ul>"
        : '<p class="ready-ok">Everything most distributors require is filled in. Check the details against your distributor\'s form before you submit.</p>') +
      (done.length
        ? '<details class="ready-done" data-sec="_done"' + (metaOpen._done ? " open" : "") + "><summary>" + done.length + " done</summary><ul class=\"ready-list\">" + done.map(readyItemHtml).join("") + "</ul></details>"
        : "");
  }

  function jumpTo(key){
    if(key === "audio" || key === "cover"){
      setTab("details");
      const target = key === "audio" ? audioSlot : coverDrop;
      setTimeout(() => target.scrollIntoView({ block:"center", behavior:"smooth" }), 40);
      return;
    }
    let el;
    if(key === "credits"){
      const d = metaForm.querySelector('[data-sec="credits"]');
      if(d) d.open = true;
      const empty = Array.prototype.slice.call(metaForm.querySelectorAll(".credit-name")).filter(x => !x.value.trim())[0];
      el = empty || $("addCreditBtn");
    } else {
      el = $("m-" + key);
    }
    if(!el) return;
    const d = el.closest("details");
    if(d && !d.open) d.open = true;
    el.scrollIntoView({ block:"center", behavior:"smooth" });
    el.focus({ preventScroll:true });
  }

  /* ----- saving edits ----- */
  function metaChanged(){
    scheduleSave();
    renderReadiness();
  }
  function validateField(k, v){
    const f = [].concat.apply([], META_SECTIONS.map(fieldsOf)).filter(x => x.k === k)[0];
    const hint = $("h-" + k);
    if(!f || !f.check || !hint) return;
    const msg = CHECKS[f.check](String(v || ""));
    hint.textContent = msg || hint.dataset.hint || "";
    hint.classList.toggle("warn", !!msg);
  }

  metaForm.addEventListener("input", (e) => {
    const el = e.target;
    const w = getWork(activeWorkId);
    if(!w) return;
    if(el.dataset.meta){
      const k = el.dataset.meta;
      w.meta[k] = el.type === "checkbox" ? el.checked : el.value;
      validateField(k, el.value);
      const counter = $("c-" + k);
      if(counter) counter.textContent = el.value.length + " / " + el.maxLength;
      metaChanged();
    } else if(el.dataset.credit){
      const row = el.closest(".credit-row");
      const c = w.meta.credits.filter(x => x.id === row.dataset.cid)[0];
      if(c){
        c[el.dataset.credit] = el.value;
        renderCreditTotal(w);
        metaChanged();
      }
    }
  });

  // Yes/No answers and the instrumental box reveal or hide other fields
  metaForm.addEventListener("change", (e) => {
    const el = e.target;
    if(el.dataset && el.dataset.meta && RERENDER_KEYS.indexOf(el.dataset.meta) !== -1) renderMetaForm(el.id);
  });

  // Tidy values when a field loses focus
  metaForm.addEventListener("focusout", (e) => {
    const el = e.target;
    const w = getWork(activeWorkId);
    if(!w || !el.dataset) return;
    if(el.dataset.tags){ addMetaTag(el); return; }
    const k = el.dataset.meta;
    if(!k) return;
    let v = el.value;
    if(k === "isrc"){
      const s = v.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      v = s.length === 12 ? s.slice(0, 2) + "-" + s.slice(2, 5) + "-" + s.slice(5, 7) + "-" + s.slice(7) : v.toUpperCase();
    }
    if(k === "upc") v = v.replace(/\D/g, "");
    if(v !== el.value) el.value = v;
    if(w.meta[k] !== v){
      w.meta[k] = v;
      validateField(k, v);
      metaChanged();
    }
  });

  /* ----- tag lists (moods, instruments) ----- */
  function addMetaTag(input){
    const k = input.dataset.tags;
    const v = input.value.replace(/,/g, "").trim();
    if(!v) return;
    const w = getWork(activeWorkId);
    if(!w) return;
    if(w.meta[k].indexOf(v) === -1) w.meta[k].push(v);
    input.value = "";
    $("tags-" + k).innerHTML = tagsHtml(k, w.meta[k]);
    metaChanged();
  }
  metaForm.addEventListener("keydown", (e) => {
    if(e.target.dataset && e.target.dataset.tags && (e.key === "Enter" || e.key === ",")){
      e.preventDefault();
      addMetaTag(e.target);
    }
  });

  /* ----- clicks: checklist jumps, tag and credit buttons, copy ----- */
  metaForm.addEventListener("click", (e) => {
    const w = getWork(activeWorkId);
    if(!w) return;

    const jump = e.target.closest("[data-jump]");
    if(jump){ jumpTo(jump.dataset.jump); return; }

    const del = e.target.closest("[data-tagdel]");
    if(del){
      const k = del.dataset.tagdel;
      w.meta[k].splice(Number(del.dataset.i), 1);
      $("tags-" + k).innerHTML = tagsHtml(k, w.meta[k]);
      metaChanged();
      return;
    }

    if(e.target.closest("[data-credit-remove]")){
      const row = e.target.closest(".credit-row");
      w.meta.credits = w.meta.credits.filter(c => c.id !== row.dataset.cid);
      scheduleSave();
      renderMetaForm();
      return;
    }

    if(e.target.closest("#addCreditBtn")){
      const n = w.meta.credits.length;
      w.meta.credits.push({ id: uid(), name:"", role: NEXT_ROLES[Math.min(n, NEXT_ROLES.length - 1)], split:"" });
      scheduleSave();
      renderMetaForm();
      const names = metaForm.querySelectorAll(".credit-name");
      if(names.length) names[names.length - 1].focus();
      return;
    }

    if(e.target.closest("#copyReleaseBtn")) copyReleaseInfo(w);
  });

  // remember which sections are open (toggle does not bubble, so listen while it travels down)
  metaForm.addEventListener("toggle", (e) => {
    const d = e.target;
    if(d && d.dataset && d.dataset.sec) metaOpen[d.dataset.sec] = d.open;
  }, true);

  /* ----- copy everything as plain text for a distributor's form ----- */
  function valueText(f, w){
    const v = w.meta[f.k];
    if(f.t === "tags") return v.join(", ");
    if(f.t === "check") return v ? "Yes" : "";
    if(f.t === "select"){
      if(!v) return "";
      const o = f.options.filter(x => x[0] === v)[0];
      return o ? o[1] : v;
    }
    if(f.t === "duration") return w.audioDuration ? formatTime(w.audioDuration) : "";
    return v == null ? "" : String(v).trim();
  }
  function releaseText(w){
    const out = [w.title || "Untitled"];
    META_SECTIONS.forEach(sec => {
      if(sec.types.indexOf(w.type) === -1) return;
      const lines = [];
      if(sec.special === "credits"){
        w.meta.credits.filter(c => c.name.trim()).forEach(c => {
          lines.push(c.name.trim() + " - " + c.role + (String(c.split).trim() !== "" ? " (" + c.split + "%)" : ""));
        });
      } else {
        fieldsOf(sec).forEach(f => {
          if(!fieldVisible(f, w)) return;
          const val = valueText(f, w);
          if(val) lines.push(f.label + ": " + val);
        });
      }
      if(lines.length){ out.push("", sec.title.toUpperCase()); lines.forEach(l => out.push(l)); }
    });
    return out.join("\n");
  }
  async function copyText(text){
    try{
      await navigator.clipboard.writeText(text);
      return true;
    }catch(err){
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try{ ok = document.execCommand("copy"); }catch(e2){ ok = false; }
      ta.remove();
      return ok;
    }
  }
  async function copyReleaseInfo(w){
    const text = releaseText(w);
    if(await copyText(text)){ showToast("Release info copied"); return; }
    // clipboard blocked: offer it as a file instead
    const url = URL.createObjectURL(new Blob([text], { type:"text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = ((w.title || "release").replace(/[^\w\- ]/g, "").trim() || "release") + "-release-info.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Couldn't copy, so it was saved as a file");
  }

  /* =========================================================
     Logo: the ring is exactly as tall as the name plus tagline beside it
     ========================================================= */
  (function fitLogo(){
    const text = document.querySelector(".brand-text");
    const mark = document.querySelector(".brand-mark");
    if(!text || !mark) return;
    function fit(){
      const h = text.getBoundingClientRect().height;
      if(h > 0) mark.style.setProperty("--mark", h + "px");
    }
    fit();
    if("ResizeObserver" in window) new ResizeObserver(fit).observe(text);
    if(document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
    window.addEventListener("resize", fit);
  })();

  /* =========================================================
     Init
     ========================================================= */
  // Save the starter pieces right away so their ids stay stable between visits
  try{ if(!localStorage.getItem(STORAGE_KEY)) localStorage.setItem(STORAGE_KEY, JSON.stringify(works)); }catch(e){ /* storage blocked */ }
  renderCounts();
  renderList();
  migrateLegacyMedia();
  // Ask the browser not to clear saved audio and art when storage runs low
  try{ if(navigator.storage && navigator.storage.persist) navigator.storage.persist(); }catch(e){ /* optional */ }

})();
