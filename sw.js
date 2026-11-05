import './membership/observer.js';
"use strict";
(() => {
  // src/shared/constants.ts
  var UNPAYWALL_EMAIL = "team@zovo.one";
  var FETCH_TIMEOUT_MS = 6e3;
  function UNPAYWALL_URL(doi) {
    return `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${UNPAYWALL_EMAIL}`;
  }
  function OPENALEX_URL(doi) {
    return `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`;
  }
  function CROSSREF_URL(doi) {
    return `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  }
  function ARXIV_API_URL(doi) {
    return `https://export.arxiv.org/api/query?search_query=doi:${encodeURIComponent(doi)}`;
  }
  function ARXIV_PDF_URL(arxivId) {
    return `https://arxiv.org/pdf/${arxivId}`;
  }
  var FREE_DAILY_CAP = 10;
  var FREE_LIBRARY_CAP = 25;
  var BADGE_FOUND_TEXT = "PDF";
  var BADGE_FOUND_COLOR = "#1a7f37";
  var BADGE_NOT_FOUND_TEXT = "\u2014";
  var BADGE_NOT_FOUND_COLOR = "#6b7280";

  // src/shared/db.ts
  var DB_NAME = "paperfetch";
  var DB_VERSION = 1;
  var STORE_NAME = "resolutions";
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "doi" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
      req.onblocked = () => reject(new Error("indexedDB open blocked"));
    });
  }
  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
    });
  }
  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("indexedDB tx failed"));
      tx.onabort = () => reject(tx.error ?? new Error("indexedDB tx aborted"));
    });
  }
  function mergeRows(existing, incoming) {
    if (!existing) return incoming;
    return {
      doi: existing.doi,
      title: existing.title ?? incoming.title,
      authors: existing.authors.length > 0 ? existing.authors : incoming.authors,
      journal: existing.journal ?? incoming.journal,
      year: existing.year ?? incoming.year,
      foundFreeCopy: existing.foundFreeCopy || incoming.foundFreeCopy,
      host: existing.host ?? incoming.host,
      dateSeen: incoming.dateSeen
    };
  }
  async function upsertResolution(row) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const existing = await reqToPromise(store.get(row.doi));
      const merged = mergeRows(existing, row);
      store.put(merged);
      await txDone(tx);
      return merged;
    } finally {
      db.close();
    }
  }
  async function count() {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const n = await reqToPromise(tx.objectStore(STORE_NAME).count());
      await txDone(tx);
      return n;
    } finally {
      db.close();
    }
  }

  // src/shared/storage.ts
  var STORAGE_KEYS = {
    licenseKey: "licenseKey",
    pro: "pro",
    lastUpsell: "lastUpsell",
    grants: "grants",
    onboarded: "onboarded"
  };
  var ADCACHE_PREFIX = "adcache:";
  var ADCACHE_TTL_DAYS = 7;
  function adCacheKey(doi) {
    return `${ADCACHE_PREFIX}${doi}`;
  }
  async function getAdCache(doi) {
    try {
      const got = await chrome.storage.local.get(adCacheKey(doi));
      const v = got[adCacheKey(doi)];
      if (v && (v.status === "found" || v.status === "not-found") && typeof v.date === "string") {
        return v;
      }
      return null;
    } catch {
      return null;
    }
  }
  async function setAdCache(doi, entry) {
    try {
      await chrome.storage.local.set({ [adCacheKey(doi)]: entry });
    } catch {
    }
  }
  async function pruneAdCache() {
    try {
      const all = await chrome.storage.local.get(null);
      const cutoff = new Date(Date.now() - ADCACHE_TTL_DAYS * 24 * 60 * 60 * 1e3).toISOString().slice(0, 10);
      const stale = Object.keys(all).filter((k) => {
        if (!k.startsWith(ADCACHE_PREFIX)) return false;
        const entry = all[k];
        return !entry || typeof entry.date !== "string" || entry.date < cutoff;
      });
      if (stale.length > 0) await chrome.storage.local.remove(stale);
    } catch {
    }
  }
  async function getGrants() {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEYS.grants);
      const v = got[STORAGE_KEYS.grants];
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  async function getGrantsRaw() {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEYS.grants);
      const v = got[STORAGE_KEYS.grants];
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  async function setGrants(entries) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.grants]: entries });
    } catch {
    }
  }
  async function setOnboarded(v) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.onboarded]: v });
    } catch {
    }
  }

  // src/shared/urls.ts
  var SUPPORT_EMAIL = "support@zovo.one";
  var SUPPORT_MAILTO_URL = `mailto:${SUPPORT_EMAIL}`;
  var LICENSE_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1e3;

  // src/shared/feature-gate.ts
  var cachedTier = "free" /* Free */;
  function isPro() {
    return cachedTier === "pro" /* Pro */;
  }

  // src/shared/caps.ts
  function todayKey() {
    return `cap:${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`;
  }
  async function readToday() {
    try {
      const got = await chrome.storage.local.get(todayKey());
      const n = got[todayKey()];
      return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch {
      return 0;
    }
  }
  async function dailyCapCheck() {
    const used = await readToday();
    if (isPro()) return { allowed: true, used, remaining: Number.POSITIVE_INFINITY };
    const remaining = Math.max(0, FREE_DAILY_CAP - used);
    return { allowed: remaining > 0, used, remaining };
  }
  async function dailyCapIncrement() {
    const used = await readToday();
    const next = used + 1;
    try {
      const all = await chrome.storage.local.get(null);
      const stale = Object.keys(all).filter((k) => k.startsWith("cap:") && k !== todayKey());
      if (stale.length > 0) await chrome.storage.local.remove(stale);
      await chrome.storage.local.set({ [todayKey()]: next });
    } catch {
    }
    if (isPro()) return { allowed: true, used: next, remaining: Number.POSITIVE_INFINITY };
    const remaining = Math.max(0, FREE_DAILY_CAP - next);
    return { allowed: remaining > 0, used: next, remaining };
  }
  async function libraryCapCheck() {
    if (isPro()) {
      try {
        return { allowed: true, count: await count() };
      } catch {
        return { allowed: true, count: 0 };
      }
    }
    try {
      const n = await count();
      return { allowed: n < FREE_LIBRARY_CAP, count: n };
    } catch {
      return { allowed: true, count: 0 };
    }
  }

  // src/shared/doi.ts
  var DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;
  var DOI_ORG_PREFIX = /^https?:\/\/(?:dx\.)?doi\.org\//i;
  var DOI_SCHEME_PREFIX = /^doi:\s*/i;
  var TRAILING_PUNCT = /[.,;)"'\]}>]+$/;
  function normalizeDoi(raw) {
    if (typeof raw !== "string") return "";
    let s = raw.trim();
    s = s.replace(/&amp;/gi, "&");
    s = s.replace(DOI_ORG_PREFIX, "");
    s = s.replace(DOI_SCHEME_PREFIX, "");
    s = s.trim().toLowerCase();
    s = s.replace(TRAILING_PUNCT, "");
    return s;
  }
  function isValidDoi(s) {
    return typeof s === "string" && DOI_PATTERN.test(s);
  }

  // src/shared/headparse.ts
  var MAX_SCAN_CHARS = 4 * 1024 * 1024;
  var META_TAG = /<\s*meta\b[^>]*>/gi;
  var NAME_ATTR = /\b(?:name|property)\s*=\s*("([^"]*)"|'([^']*)')/i;
  var CONTENT_ATTR = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i;
  var DOI_META_RANK = /* @__PURE__ */ new Map([
    ["citation_doi", 0],
    ["dc.identifier", 1],
    ["prism.doi", 2]
  ]);
  var DOI_HREF = /https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/[^\s"'<>]+)/gi;
  function attrValue(m) {
    if (!m) return null;
    const v = m[2] !== void 0 ? m[2] : m[3];
    return typeof v === "string" ? v : null;
  }
  function extractDoi(html) {
    if (typeof html !== "string" || html.length === 0) return null;
    const doc = html.length > MAX_SCAN_CHARS ? html.slice(0, MAX_SCAN_CHARS) : html;
    META_TAG.lastIndex = 0;
    let best = null;
    let tag;
    while ((tag = META_TAG.exec(doc)) !== null) {
      const name = attrValue(NAME_ATTR.exec(tag[0]));
      if (!name) continue;
      const rank = DOI_META_RANK.get(name.trim().toLowerCase());
      if (rank === void 0 || best !== null && rank >= best.rank) continue;
      const content = attrValue(CONTENT_ATTR.exec(tag[0]));
      if (!content) continue;
      const doi = normalizeDoi(content);
      if (!isValidDoi(doi)) continue;
      if (rank === 0) return doi;
      best = { rank, doi };
    }
    if (best !== null) return best.doi;
    DOI_HREF.lastIndex = 0;
    let href;
    while ((href = DOI_HREF.exec(doc)) !== null) {
      const rawDoi = href[1];
      if (!rawDoi) continue;
      const doi = normalizeDoi(rawDoi);
      if (isValidDoi(doi)) return doi;
    }
    return null;
  }

  // src/shared/funnel.ts
  var FUNNEL_EVENTS_KEY = "pape4a9d_funnel_events";
  var MAX_EVENTS = 100;
  var NAME_TO_TYPE = {
    "resolve-success": "resolve_success",
    "cap-hit": "cap_hit",
    "library-full": "library_full",
    "paywall_shown": "upsell_shown",
    "upsell-dismissed": "upsell_dismissed",
    "cta_click": "upgrade_click"
  };
  function logFunnelEvent(event) {
    void (async () => {
      try {
        const got = await chrome.storage.local.get(FUNNEL_EVENTS_KEY);
        const raw = got[FUNNEL_EVENTS_KEY];
        const events = Array.isArray(raw) ? raw : [];
        events.push(event);
        while (events.length > MAX_EVENTS) events.shift();
        await chrome.storage.local.set({ [FUNNEL_EVENTS_KEY]: events });
      } catch {
      }
    })();
  }
  function emit(name, surface) {
    const event = { type: NAME_TO_TYPE[name], at: (/* @__PURE__ */ new Date()).toISOString() };
    if (surface) event.surface = surface;
    logFunnelEvent(event);
  }

  // src/shared/metadata.ts
  var MAX_FIELD = 500;
  var MAX_AUTHORS = 50;
  function asObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  }
  function asStr(v) {
    if (typeof v !== "string") return null;
    const s = v.trim();
    return s.length > 0 ? s.slice(0, MAX_FIELD) : null;
  }
  function asYear(v) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 1500 && v <= 2100) return v;
    if (typeof v === "string") {
      const n = parseInt(v.slice(0, 4), 10);
      if (Number.isInteger(n) && n >= 1500 && n <= 2100) return n;
    }
    return null;
  }
  function joinAuthor(given, family) {
    const g = asStr(given);
    const f = asStr(family);
    if (g && f) return `${g} ${f}`;
    return f ?? g;
  }
  function cleanAuthors(list) {
    const out = [];
    for (const a of list) {
      if (a && out.length < MAX_AUTHORS) out.push(a);
    }
    return out;
  }
  function metadataFromUnpaywall(json) {
    const o = asObj(json);
    if (!o) return {};
    const za = Array.isArray(o.z_authors) ? o.z_authors : [];
    return {
      title: asStr(o.title),
      authors: cleanAuthors(za.map((a) => joinAuthor(asObj(a)?.given, asObj(a)?.family))),
      journal: asStr(o.journal_name),
      year: asYear(o.year)
    };
  }
  function metadataFromOpenAlex(json) {
    const o = asObj(json);
    if (!o) return {};
    const authorships = Array.isArray(o.authorships) ? o.authorships : [];
    const authors = authorships.map((a) => {
      const author = asObj(asObj(a)?.author);
      return asStr(author?.display_name);
    });
    const source = asObj(asObj(o.primary_location)?.source);
    return {
      title: asStr(o.title),
      authors: cleanAuthors(authors),
      journal: asStr(source?.display_name),
      year: asYear(o.publication_year)
    };
  }
  function metadataFromCrossref(json) {
    const msg = asObj(asObj(json)?.message);
    if (!msg) return {};
    const titles = Array.isArray(msg.title) ? msg.title : [];
    const containers = Array.isArray(msg["container-title"]) ? msg["container-title"] : [];
    const authors = Array.isArray(msg.author) ? msg.author : [];
    const dateParts = asObj(msg.issued)?.["date-parts"];
    const firstParts = Array.isArray(dateParts) && Array.isArray(dateParts[0]) ? dateParts[0] : [];
    return {
      title: asStr(titles[0]),
      authors: cleanAuthors(authors.map((a) => joinAuthor(asObj(a)?.given, asObj(a)?.family))),
      journal: asStr(containers[0]),
      year: asYear(firstParts[0])
    };
  }
  function xmlTag(fragment, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
    const m = re.exec(fragment);
    if (!m) return null;
    const s = (m[1] ?? "").replace(/\s+/g, " ").trim();
    return s.length > 0 ? s.slice(0, MAX_FIELD) : null;
  }
  function metadataFromArxiv(atomXml) {
    if (typeof atomXml !== "string" || atomXml.length === 0) return {};
    const entryMatch = /<entry>([\s\S]*?)<\/entry>/i.exec(atomXml);
    if (!entryMatch) return {};
    const entry = entryMatch[1];
    if (!entry) return {};
    const authorNames = [];
    const authorRe = /<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/gi;
    let a;
    while ((a = authorRe.exec(entry)) !== null && authorNames.length < MAX_AUTHORS) {
      const name = (a[1] ?? "").replace(/\s+/g, " ").trim();
      if (name) authorNames.push(name.slice(0, MAX_FIELD));
    }
    return {
      title: xmlTag(entry, "title"),
      authors: authorNames,
      // arXiv <name> is already display form
      journal: null,
      year: asYear(xmlTag(entry, "published"))
    };
  }

  // src/shared/resolvers.ts
  var NO_HIT = { knewDoi: false, meta: {} };
  function safeHttpsUrl(raw) {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
    try {
      const u = new URL(raw);
      return u.protocol === "https:" ? u.toString() : null;
    } catch {
      return null;
    }
  }
  async function fetchText(url, accept) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept },
        redirect: "follow",
        credentials: "omit"
      });
      const body = await res.text();
      return { status: res.status, body };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  async function fetchJson(url) {
    const r = await fetchText(url, "application/json");
    if (r === null) return null;
    try {
      return { status: r.status, json: JSON.parse(r.body) };
    } catch {
      return { status: r.status, json: null };
    }
  }
  function hasMeta(meta) {
    return Object.values(meta).some(
      (v) => Array.isArray(v) ? v.length > 0 : v !== null && v !== void 0
    );
  }
  async function stepUnpaywall(doi) {
    const r = await fetchJson(UNPAYWALL_URL(doi));
    if (!r || r.status !== 200 || r.json === null) return { ...NO_HIT };
    const o = r.json;
    const meta = metadataFromUnpaywall(o);
    if (o.is_oa !== true) return { knewDoi: true, meta };
    const loc = o.best_oa_location ?? null;
    const url = safeHttpsUrl(loc?.url_for_pdf) ?? safeHttpsUrl(loc?.url);
    return url ? { hit: { url, source: "unpaywall" }, knewDoi: true, meta } : { knewDoi: true, meta };
  }
  async function stepOpenAlex(doi) {
    const r = await fetchJson(OPENALEX_URL(doi));
    if (!r || r.status !== 200 || r.json === null) return { ...NO_HIT };
    const o = r.json;
    const meta = metadataFromOpenAlex(o);
    const oa = o.open_access ?? null;
    const url = safeHttpsUrl(oa?.oa_url);
    return url ? { hit: { url, source: "openalex" }, knewDoi: true, meta } : { knewDoi: true, meta };
  }
  async function stepCrossref(doi) {
    const r = await fetchJson(CROSSREF_URL(doi));
    if (!r || r.status !== 200 || r.json === null) return { ...NO_HIT };
    const o = r.json;
    const meta = metadataFromCrossref(o);
    const msg = o.message ?? null;
    const links = msg && Array.isArray(msg.link) ? msg.link : [];
    for (const l of links) {
      const link = l ?? null;
      const ct = typeof link?.["content-type"] === "string" ? link["content-type"] : "";
      if (!ct.toLowerCase().includes("application/pdf")) continue;
      const url = safeHttpsUrl(link?.URL);
      if (url) return { hit: { url, source: "crossref" }, knewDoi: true, meta };
    }
    return { knewDoi: true, meta };
  }
  var ARXIV_ID_PATTERN = /^(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z-]+)?\/\d{7}(?:v\d+)?)$/;
  async function stepArxiv(doi) {
    const r = await fetchText(ARXIV_API_URL(doi), "application/atom+xml");
    if (!r || r.status !== 200) return { ...NO_HIT };
    const entry = /<entry>([\s\S]*?)<\/entry>/i.exec(r.body);
    if (!entry) return { ...NO_HIT };
    const meta = metadataFromArxiv(r.body);
    const idMatch = /<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+)\s*<\/id>/i.exec(entry[1] ?? "");
    const candidate = idMatch?.[1] ?? "";
    const arxivId = ARXIV_ID_PATTERN.test(candidate) ? candidate : null;
    return arxivId ? { hit: { url: ARXIV_PDF_URL(arxivId), source: "arxiv" }, knewDoi: true, meta } : { knewDoi: true, meta };
  }
  var CHAIN = [
    { source: "unpaywall", run: stepUnpaywall },
    { source: "openalex", run: stepOpenAlex },
    { source: "crossref", run: stepCrossref },
    { source: "arxiv", run: stepArxiv }
  ];
  async function resolveChain(doi, onStep) {
    let sawIndex = false;
    let bestMeta = {};
    for (const step of CHAIN) {
      try {
        onStep?.(step.source);
      } catch {
      }
      let outcome;
      try {
        outcome = await step.run(doi);
      } catch {
        continue;
      }
      if (outcome.knewDoi) sawIndex = true;
      if (hasMeta(outcome.meta)) bestMeta = outcome.meta;
      if (outcome.hit) {
        return { hit: outcome.hit, meta: outcome.meta, sawIndex: true };
      }
    }
    return { meta: bestMeta, sawIndex };
  }

  // src/sw/index.ts
  var ONBOARDING_PATH = "pages/onboarding/onboarding.html";
  var API_HOSTS = /* @__PURE__ */ new Set([
    "api.unpaywall.org",
    "api.openalex.org",
    "api.crossref.org",
    "export.arxiv.org"
  ]);
  function today() {
    return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  }
  function hostnameOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }
  async function refreshGrants() {
    try {
      const perms = await chrome.permissions.getAll();
      const origins = (perms.origins ?? []).map((p) => p.replace(/\/\*$/, "")).filter((o) => o.startsWith("https://") || o.startsWith("http://")).filter((o) => {
        const h = hostnameOf(o);
        return h !== null && !API_HOSTS.has(h);
      });
      const foreign = (await getGrantsRaw()).filter((x) => typeof x !== "string");
      await setGrants([...foreign, ...origins]);
      return origins;
    } catch {
      return getGrants();
    }
  }
  async function fetchPageHtml(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        credentials: "omit",
        redirect: "follow",
        headers: { accept: "text/html" }
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  async function runPipeline(tabUrl, force) {
    const host = hostnameOf(tabUrl);
    if (navigator.onLine === false) {
      return { response: { status: "offline", proActive: isPro() } };
    }
    const html = await fetchPageHtml(tabUrl);
    if (html === null) {
      return { response: { status: "page-unreadable", proActive: isPro() } };
    }
    const doi = extractDoi(html);
    if (doi === null) {
      return { response: { status: "no-doi", proActive: isPro() } };
    }
    if (!force) {
      const cached = await getAdCache(doi);
      if (cached && cached.date === today()) {
        if (cached.status === "found" && cached.url) {
          return {
            response: {
              status: "found",
              doi,
              openedUrl: cached.url,
              cached: true,
              proActive: isPro()
            }
          };
        }
        if (cached.status === "not-found") {
          return { response: { status: "not-found", doi, cached: true, proActive: isPro() } };
        }
      }
    }
    const cap = await dailyCapCheck();
    if (!cap.allowed) {
      emit("cap-hit", "popup_cap");
      return {
        response: { status: "cap-hit", doi, proActive: false, remainingToday: 0 }
      };
    }
    const after = await dailyCapIncrement();
    const chain = await resolveChain(doi);
    const base = {
      doi,
      title: typeof chain.meta.title === "string" ? chain.meta.title : null,
      authors: Array.isArray(chain.meta.authors) ? chain.meta.authors.filter((a) => typeof a === "string") : [],
      journal: typeof chain.meta.journal === "string" ? chain.meta.journal : null,
      year: typeof chain.meta.year === "number" ? chain.meta.year : null,
      host,
      dateSeen: (/* @__PURE__ */ new Date()).toISOString()
    };
    const remainingToday = isPro() ? void 0 : Math.max(0, FREE_DAILY_CAP - (after.used || cap.used + 1));
    if (chain.hit) {
      emit("resolve-success");
      const row2 = { ...base, foundFreeCopy: true };
      await setAdCache(doi, { status: "found", url: chain.hit.url, date: today() });
      const lib = await libraryCapCheck();
      if (!lib.allowed) {
        emit("library-full", "popup_library_full");
        return {
          response: {
            status: "library-full-found",
            doi,
            openedUrl: chain.hit.url,
            proActive: isPro(),
            remainingToday
          }
        };
      }
      return {
        row: row2,
        response: {
          status: "found",
          doi,
          openedUrl: chain.hit.url,
          proActive: isPro(),
          remainingToday
        }
      };
    }
    const row = { ...base, foundFreeCopy: false };
    if (chain.sawIndex) {
      logFunnelEvent({ type: "resolve_not_found", at: (/* @__PURE__ */ new Date()).toISOString() });
      await setAdCache(doi, { status: "not-found", date: today() });
      return {
        row,
        response: { status: "not-found", doi, proActive: isPro(), remainingToday }
      };
    }
    logFunnelEvent({ type: "resolve_doi_unknown", at: (/* @__PURE__ */ new Date()).toISOString() });
    return {
      row,
      response: { status: "doi-unknown", doi, proActive: isPro(), remainingToday }
    };
  }
  chrome.runtime.onInstalled.addListener((details) => {
    try {
      if (details.reason === "install") {
        void setOnboarded(false);
        void chrome.tabs.create({ url: chrome.runtime.getURL(ONBOARDING_PATH) });
      }
    } catch {
    }
  });
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "PF_RESOLVE") return false;
    void (async () => {
      const fail = (status) => ({
        status,
        proActive: isPro()
      });
      try {
        const tab = await chrome.tabs.get(msg.tabId);
        const url = tab?.url ?? "";
        if (!/^https?:\/\//.test(url)) {
          sendResponse(fail("unsupported-page"));
          return;
        }
        const { response, row } = await runPipeline(url, msg.force === true);
        if (row) {
          try {
            const stored = await upsertResolution(row);
            response.row = stored;
          } catch {
          }
        }
        if (response.status === "found" && response.openedUrl) {
          try {
            await chrome.tabs.create({ url: response.openedUrl });
          } catch {
          }
        }
        sendResponse(response);
      } catch {
        try {
          sendResponse(fail("error"));
        } catch {
        }
      }
    })();
    return true;
  });
  var autoChecked = /* @__PURE__ */ new Map();
  async function setBadge(tabId, found) {
    try {
      await chrome.action.setBadgeBackgroundColor({
        tabId,
        color: found ? BADGE_FOUND_COLOR : BADGE_NOT_FOUND_COLOR
      });
      await chrome.action.setBadgeText({ tabId, text: found ? BADGE_FOUND_TEXT : BADGE_NOT_FOUND_TEXT });
    } catch {
    }
  }
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void (async () => {
      try {
        if (changeInfo.status !== "complete") return;
        const url = tab.url ?? "";
        if (!/^https?:\/\//.test(url)) return;
        if (autoChecked.get(tabId) === url) return;
        if (!isPro()) return;
        const origin = new URL(url).origin;
        const grants = await getGrants();
        if (!grants.includes(origin)) return;
        autoChecked.set(tabId, url);
        const { response } = await runPipeline(url, false);
        if (response.status === "found" || response.status === "library-full-found") {
          await setBadge(tabId, true);
        } else if (response.status === "not-found") {
          await setBadge(tabId, false);
        } else {
          await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => void 0);
        }
      } catch {
      }
    })();
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    autoChecked.delete(tabId);
  });
  chrome.permissions.onAdded.addListener(() => {
    void refreshGrants();
  });
  chrome.permissions.onRemoved.addListener(() => {
    void (async () => {
      await refreshGrants();
      autoChecked.clear();
    })();
  });
  chrome.runtime.onStartup.addListener(() => {
    void refreshGrants();
    void pruneAdCache();
  });
  void refreshGrants();
  void pruneAdCache();
})();
