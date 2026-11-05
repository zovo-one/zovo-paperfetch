"use strict";
(() => {
  // src/shared/constants.ts
  var FREE_DAILY_CAP = 10;
  function CHECKOUT_URL(surface) {
    return `https://zovo.one/pricing?utm_source=paperfetch&utm_medium=extension&utm_campaign=upgrade&utm_content=${surface}`;
  }

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
  async function listRows(filter) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const all = await reqToPromise(tx.objectStore(STORE_NAME).getAll());
      await txDone(tx);
      const q = filter?.query?.trim().toLowerCase() ?? "";
      const found = filter?.found ?? "all";
      return all.filter((r) => {
        if (found === "found" && !r.foundFreeCopy) return false;
        if (found === "not-found" && r.foundFreeCopy) return false;
        if (!q) return true;
        const hay = [r.doi, r.title ?? "", r.journal ?? "", r.authors.join(" ")].join(" ").toLowerCase();
        return hay.includes(q);
      }).sort((a, b) => a.dateSeen < b.dateSeen ? 1 : a.dateSeen > b.dateSeen ? -1 : 0);
    } finally {
      db.close();
    }
  }

  // src/shared/export.ts
  function splitDisplayName(display) {
    const parts = display.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { given: "", family: "" };
    if (parts.length === 1) return { given: "", family: parts[0] ?? "" };
    return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1] ?? "" };
  }
  function formatCitation(r) {
    const authors = r.authors.map((a) => {
      const { given, family } = splitDisplayName(a);
      const initials = given.split(/\s+/).map((w) => w.length > 0 ? `${w.charAt(0).toUpperCase()}.` : "").filter(Boolean).join(" ");
      return initials ? `${family}, ${initials}` : family;
    }).filter((a) => a.length > 0).join(", ");
    const parts = [];
    if (authors) parts.push(`${authors} `);
    parts.push(r.year ? `(${r.year}).` : "(n.d.).");
    if (r.title) parts.push(`${r.title}.`);
    if (r.journal) parts.push(`${r.journal}.`);
    parts.push(`https://doi.org/${r.doi}`);
    return parts.join(" ");
  }

  // src/shared/storage.ts
  var STORAGE_KEYS = {
    licenseKey: "licenseKey",
    pro: "pro",
    lastUpsell: "lastUpsell",
    grants: "grants",
    onboarded: "onboarded"
  };
  var PRO_DEFAULT = { active: false, verifiedAt: null };
  async function getProCache() {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEYS.pro);
      const v = got[STORAGE_KEYS.pro];
      if (v && typeof v.active === "boolean") return { active: v.active, verifiedAt: v.verifiedAt ?? null };
      return { ...PRO_DEFAULT };
    } catch {
      return { ...PRO_DEFAULT };
    }
  }
  async function setProCache(pro) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.pro]: pro });
    } catch {
    }
  }
  async function getLastUpsell() {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEYS.lastUpsell);
      const v = got[STORAGE_KEYS.lastUpsell];
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }
  async function setLastUpsell(date) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.lastUpsell]: date });
    } catch {
    }
  }

  // src/shared/urls.ts
  var SUPPORT_EMAIL = "support@zovo.one";
  var SUPPORT_MAILTO_URL = `mailto:${SUPPORT_EMAIL}`;
  var LICENSE_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1e3;

  // src/shared/feature-gate.ts
  var OFFLINE_GRACE_MS = LICENSE_OFFLINE_GRACE_MS;
  var PRO_EXP_KEY = "proExp";
  async function readProStatus() {
    const pro = await getProCache();
    return pro.active ? "pro" : "free";
  }
  async function readProVerifiedAt() {
    const pro = await getProCache();
    if (pro.verifiedAt === null) return 0;
    const ms = Date.parse(pro.verifiedAt);
    return Number.isFinite(ms) ? ms : 0;
  }
  async function writeProKey(key) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.licenseKey]: key });
    } catch (err) {
      console.warn("[pape4a9d] license key write failed:", err);
    }
  }
  async function readProExp() {
    try {
      const bag = await chrome.storage.local.get(PRO_EXP_KEY);
      const v = bag[PRO_EXP_KEY];
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  }
  async function writeProExp(exp) {
    try {
      await chrome.storage.local.set({ [PRO_EXP_KEY]: exp });
    } catch (err) {
      console.warn("[pape4a9d] proExp write failed:", err);
    }
  }
  var cachedTier = "free" /* Free */;
  var cacheInitialized = false;
  async function ensureCacheInitialized() {
    if (cacheInitialized) return;
    try {
      const status = await readProStatus();
      cachedTier = status === "pro" ? "pro" /* Pro */ : "free" /* Free */;
      cacheInitialized = true;
    } catch {
      cachedTier = "free" /* Free */;
      cacheInitialized = true;
    }
  }
  async function setTier(tier, opts) {
    cachedTier = tier;
    let verifiedAtIso;
    if (opts && typeof opts.verifiedAt === "number") {
      verifiedAtIso = opts.verifiedAt > 0 ? new Date(opts.verifiedAt).toISOString() : null;
    } else {
      verifiedAtIso = (await getProCache()).verifiedAt;
    }
    await setProCache({ active: tier === "pro" /* Pro */, verifiedAt: verifiedAtIso });
    if (opts) {
      if (opts.key !== void 0) await writeProKey(opts.key);
      if (typeof opts.exp === "number") await writeProExp(opts.exp);
    }
    notifyTierChange(tier);
  }
  var listeners = /* @__PURE__ */ new Set();
  function notifyTierChange(tier) {
    for (const cb of listeners) {
      try {
        cb(tier);
      } catch (err) {
        console.warn("[pape4a9d] feature-gate listener threw:", err);
      }
    }
  }
  function isPro() {
    return cachedTier === "pro" /* Pro */;
  }
  async function refreshCachedTier() {
    await ensureCacheInitialized();
    if (cachedTier === "pro" /* Pro */) {
      const verifiedAt = await readProVerifiedAt();
      const exp = await readProExp();
      const now = Date.now();
      if (exp > 0 && now > exp) {
        await setTier("free" /* Free */);
        return "free" /* Free */;
      }
      if (verifiedAt <= 0 || now - verifiedAt > OFFLINE_GRACE_MS) {
        await setTier("free" /* Free */);
        return "free" /* Free */;
      }
    }
    return cachedTier;
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

  // src/shared/i18n-bootstrap.ts
  function msg(name, fallback = "") {
    try {
      const m = chrome.i18n.getMessage(name);
      if (m !== "") return m;
    } catch {
    }
    return fallback;
  }
  function msgf(name, substitutions, fallback = "") {
    const subs = Array.isArray(substitutions) ? substitutions.map((s) => String(s)) : String(substitutions);
    try {
      const m = chrome.i18n.getMessage(name, subs);
      if (m !== "") return m;
    } catch {
    }
    const single = Array.isArray(subs) ? subs[0] ?? "" : subs;
    return fallback.replace("$1", single);
  }
  function applyI18n(root = document) {
    try {
      for (const el of Array.from(root.querySelectorAll("[data-i18n]"))) {
        const key = el.dataset["i18n"];
        if (!key) continue;
        const m = chrome.i18n.getMessage(key);
        if (m) el.textContent = m;
      }
      for (const el of Array.from(root.querySelectorAll("[data-i18n-ph]"))) {
        const key = el.dataset["i18nPh"];
        if (!key) continue;
        const m = chrome.i18n.getMessage(key);
        if (m) el.placeholder = m;
      }
      for (const el of Array.from(root.querySelectorAll("[data-i18n-placeholder]"))) {
        const key = el.dataset["i18nPlaceholder"];
        if (!key) continue;
        const m = chrome.i18n.getMessage(key);
        if (m) el.placeholder = m;
      }
      for (const el of Array.from(root.querySelectorAll("[data-i18n-aria]"))) {
        const key = el.dataset["i18nAria"];
        if (!key) continue;
        const m = chrome.i18n.getMessage(key);
        if (m) el.setAttribute("aria-label", m);
      }
      for (const el of Array.from(root.querySelectorAll("[data-i18n-attr]"))) {
        const raw = el.dataset["i18nAttr"];
        if (!raw) continue;
        for (const pair of raw.split(";")) {
          const [attr, key] = pair.split(":").map((s) => s.trim());
          if (!attr || !key) continue;
          const m = chrome.i18n.getMessage(key);
          if (!m) continue;
          if (attr === "placeholder") {
            el.placeholder = m;
          } else if (attr === "aria-label") {
            el.setAttribute("aria-label", m);
          } else if (attr === "title") {
            el.title = m;
          } else if (attr === "href") {
            if (/^https?:\/\//i.test(m) || /^mailto:/i.test(m)) {
              el.href = m;
            }
          }
        }
      }
    } catch {
    }
  }
  function bootstrapI18n(root = document) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => applyI18n(root), { once: true });
    } else {
      applyI18n(root);
    }
  }

  // src/popup/popup.ts
  bootstrapI18n();
  function $(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`pape4a9d popup: missing #${id}`);
    return el;
  }
  var RESOLVER_ORDER = ["Unpaywall", "OpenAlex", "Crossref", "arXiv"];
  var STEP_MS = 1500;
  var currentTabId = null;
  var currentTabUrl = "";
  var currentRow = null;
  var currentOpenedUrl = null;
  var upsellSurface = "popup_cap";
  var stepTimer = null;
  function setState(state) {
    document.body.dataset["state"] = state;
  }
  function setText(id, text) {
    $(id).textContent = text;
  }
  function show(id, on = true) {
    $(id).hidden = !on;
  }
  function startStepCycle() {
    show("pf-steps");
    let i = 0;
    const tick = () => {
      const name = RESOLVER_ORDER[i] ?? "Unpaywall";
      setText("pf-detail", msgf("popupChecking", name, `Checking ${name}\u2026`));
      if (i < RESOLVER_ORDER.length - 1) {
        i += 1;
        stepTimer = window.setTimeout(tick, STEP_MS);
      }
    };
    stepTimer = window.setTimeout(tick, STEP_MS);
  }
  function stopStepCycle() {
    if (stepTimer !== null) {
      clearTimeout(stepTimer);
      stepTimer = null;
    }
  }
  function todayStr() {
    return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  }
  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }
  function showUpsell(surface, copy) {
    upsellSurface = surface;
    setText("pf-upsell-copy", copy);
    show("pf-upsell");
    emit("paywall_shown", surface);
  }
  function hideUpsell() {
    show("pf-upsell", false);
  }
  function renderCounter(res) {
    if (res.proActive) {
      show("pf-tier");
      show("pf-meter", false);
      setText("pf-counter", "");
      return;
    }
    if (res.remainingToday === void 0) {
      show("pf-meter", false);
      setText("pf-counter", "");
      return;
    }
    const remaining = res.remainingToday;
    const used = Math.max(0, FREE_DAILY_CAP - remaining);
    setText(
      "pf-counter",
      msgf("popupFreeCounter", [used, FREE_DAILY_CAP], `${used} of ${FREE_DAILY_CAP} free lookups used today`)
    );
    show("pf-meter");
    const fill = $("pf-meter-fill");
    fill.style.width = `${Math.min(100, used / FREE_DAILY_CAP * 100)}%`;
  }
  function renderPaper(row, doi) {
    const r = row ?? null;
    const doiText = r?.doi ?? doi ?? "";
    if (!doiText) return;
    show("pf-paper");
    setText("pf-paper-title", r?.title ?? doiText);
    const metaBits = [];
    if (r?.journal) metaBits.push(r.journal);
    if (r?.year) metaBits.push(String(r.year));
    setText("pf-paper-meta", metaBits.join(" \xB7 "));
    setText("pf-paper-doi", doiText);
  }
  async function maybePostSuccessUpsell() {
    if (isPro()) return;
    const last = await getLastUpsell();
    if (last === todayStr()) return;
    await setLastUpsell(todayStr());
    showUpsell("popup_success", msg("popupProTeaser", "Pro adds unlimited lookups, site auto-detect, and one-click copy."));
  }
  function renderResponse(res) {
    stopStepCycle();
    show("pf-steps", false);
    renderCounter(res);
    if (res.row) currentRow = res.row;
    currentOpenedUrl = res.openedUrl ?? null;
    switch (res.status) {
      case "found":
        setState("found");
        setText("pf-status", msg(res.cached ? "popupFoundCached" : "popupFound", "Free copy found."));
        setText(
          "pf-detail",
          `${msgf("popupFoundVia", currentOpenedUrl ? hostOf(currentOpenedUrl) : "", "")} ${msg("popupSavedToLibrary", "")}`.trim()
        );
        renderPaper(res.row, res.doi);
        show("pf-actions");
        show("pf-open-again", currentOpenedUrl !== null);
        show("pf-copy-doi");
        show("pf-copy-citation");
        show("pf-check-again");
        if (!res.cached) void maybePostSuccessUpsell();
        break;
      case "library-full-found":
        setState("library-full-found");
        setText("pf-status", msg("popupFound", "Free copy found. It opened in a new tab."));
        setText("pf-detail", msg("popupLibraryFull", "Library full. Upgrade or manage library."));
        renderPaper(res.row, res.doi);
        show("pf-actions");
        show("pf-open-again", currentOpenedUrl !== null);
        show("pf-check-again");
        showUpsell("popup_library_full", msg("popupLibraryFull", "Library full. Upgrade or manage library."));
        break;
      case "not-found":
        setState("not-found");
        setText("pf-status", msg("popupNotFound", "No free legal copy found for this paper."));
        setText("pf-detail", msg("popupCheckedAll", "Checked Unpaywall, OpenAlex, Crossref, and arXiv."));
        renderPaper(res.row, res.doi);
        show("pf-actions");
        show("pf-check-again");
        break;
      case "doi-unknown":
        setState("doi-unknown");
        setText("pf-status", msg("popupDoiUnknown", "We could not find this DOI in open indexes."));
        setText("pf-detail", msg("popupCheckedAll", ""));
        renderPaper(res.row, res.doi);
        show("pf-actions");
        show("pf-check-again");
        break;
      case "no-doi":
        setState("no-doi");
        setText("pf-status", msg("popupNoDoi", "No DOI found on this page."));
        setText("pf-detail", "");
        break;
      case "page-unreadable":
        setState("page-unreadable");
        setText("pf-status", msg("popupPageUnreadable", "Could not read this page. Try reloading it, then click again."));
        setText("pf-detail", "");
        break;
      case "offline":
        setState("offline");
        setText("pf-status", msg("popupOffline", "You appear to be offline."));
        setText("pf-detail", "");
        break;
      case "cap-hit":
        setState("cap-hit");
        setText("pf-status", msgf("popupCapHit", FREE_DAILY_CAP, `Free plan: ${FREE_DAILY_CAP} lookups a day.`));
        setText("pf-detail", "");
        showUpsell("popup_cap", msgf("popupCapHit", FREE_DAILY_CAP, ""));
        break;
      case "unsupported-page":
      default:
        setState("unsupported-page");
        setText("pf-status", msg("popupUnsupported", "PaperFetch works on paper and article pages."));
        setText("pf-detail", "");
        break;
    }
    if (!res.proActive && (res.status === "found" || res.status === "not-found" || res.status === "no-doi")) {
      show("pf-pro-teaser");
    }
  }
  async function runResolve(force) {
    if (currentTabId === null) return;
    setState("working");
    setText("pf-status", msg("popupReadingPage", "Reading page\u2026"));
    setText("pf-detail", "");
    hideUpsell();
    show("pf-paper", false);
    show("pf-actions", false);
    show("pf-pro-teaser", false);
    startStepCycle();
    const message = { type: "PF_RESOLVE", tabId: currentTabId, force };
    try {
      const res = await chrome.runtime.sendMessage(message);
      renderResponse(res ?? { status: "error", proActive: isPro() });
    } catch {
      stopStepCycle();
      renderResponse({ status: "error", proActive: isPro() });
    }
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
    }
  }
  function wireActions() {
    $("pf-open-again").addEventListener("click", () => {
      if (currentOpenedUrl) void chrome.tabs.create({ url: currentOpenedUrl });
    });
    $("pf-check-again").addEventListener("click", () => {
      void runResolve(true);
    });
    $("pf-copy-doi").addEventListener("click", () => {
      const doi = currentRow?.doi;
      if (!doi) return;
      if (!isPro()) {
        showUpsell("popup_feature", msg("popupProTeaser", ""));
        return;
      }
      void copyText(doi);
    });
    $("pf-copy-citation").addEventListener("click", () => {
      if (!currentRow) return;
      if (!isPro()) {
        showUpsell("popup_feature", msg("popupProTeaser", ""));
        return;
      }
      void copyText(formatCitation(currentRow));
    });
    $("pf-auto-detect").addEventListener("click", () => {
      if (!isPro()) {
        showUpsell("popup_feature", msg("popupProTeaser", ""));
        return;
      }
      let origin;
      try {
        origin = new URL(currentTabUrl).origin;
      } catch {
        return;
      }
      try {
        void chrome.permissions.request({ origins: [`${origin}/*`] }).then((granted) => {
          if (granted) {
            show("pf-auto-detect", false);
            logFunnelEvent({ type: "grant_added", at: (/* @__PURE__ */ new Date()).toISOString() });
          }
        }).catch(() => void 0);
      } catch {
      }
    });
    $("pf-upgrade").addEventListener("click", () => {
      emit("cta_click", upsellSurface);
      void chrome.tabs.create({ url: CHECKOUT_URL(upsellSurface) });
      window.close();
    });
    $("pf-maybe-later").addEventListener("click", () => {
      emit("upsell-dismissed", upsellSurface);
      hideUpsell();
    });
    $("pf-library-link").addEventListener("click", (e) => {
      e.preventDefault();
      void chrome.runtime.openOptionsPage();
      window.close();
    });
  }
  async function renderRecent() {
    try {
      const rows = (await listRows()).slice(0, 5);
      if (rows.length === 0) return;
      const tpl = document.getElementById("pf-tpl-recent");
      const list = $("pf-recent-list");
      list.textContent = "";
      for (const r of rows) {
        const node = tpl?.content.firstElementChild?.cloneNode(true);
        if (!node) continue;
        const dot = node.querySelector(".pf-recent-dot");
        if (dot) dot.classList.add(r.foundFreeCopy ? "is-found" : "is-missing");
        const name = node.querySelector(".pf-recent-name");
        if (name) name.textContent = r.title ?? r.doi;
        list.appendChild(node);
      }
      show("pf-recent");
    } catch {
    }
  }
  async function renderAutoDetect() {
    if (!/^https?:\/\//.test(currentTabUrl)) return;
    try {
      const origin = new URL(currentTabUrl).origin;
      const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
      show("pf-auto-detect", !granted);
    } catch {
    }
  }
  void (async () => {
    await refreshCachedTier();
    wireActions();
    void renderRecent();
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab || tab.id === void 0 || !/^https?:\/\//.test(tab.url ?? "")) {
        renderResponse({ status: "unsupported-page", proActive: isPro() });
        return;
      }
      currentTabId = tab.id;
      currentTabUrl = tab.url ?? "";
      void renderAutoDetect();
      await runResolve(false);
    } catch {
      renderResponse({ status: "error", proActive: isPro() });
    }
  })();
})();
