"use strict";
(() => {
  // src/shared/constants.ts
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
  async function deleteRow(doi) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(doi);
      await txDone(tx);
    } finally {
      db.close();
    }
  }
  async function clearAll() {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      await txDone(tx);
    } finally {
      db.close();
    }
  }

  // src/shared/export.ts
  var BIBTEX_FILENAME = "paperfetch-library.bib";
  var CSL_JSON_FILENAME = "paperfetch-library.json";
  var BIBTEX_MIME = "application/x-bibtex";
  var CSL_JSON_MIME = "application/json";
  function bibSafe(s) {
    return s.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim().replace(/[&%_#$]/g, (ch) => `\\${ch}`);
  }
  function firstTitleWord(title) {
    if (!title) return "untitled";
    const w = title.split(/\s+/).find((t) => /[A-Za-z0-9]/.test(t)) ?? "untitled";
    return w.replace(/[^A-Za-z0-9]/g, "") || "untitled";
  }
  function firstAuthorFamily(authors) {
    const first = authors[0];
    if (!first) return "anon";
    const parts = first.trim().split(/\s+/);
    return (parts[parts.length - 1] || "anon").replace(/[^A-Za-z0-9]/g, "") || "anon";
  }
  function splitDisplayName(display) {
    const parts = display.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { given: "", family: "" };
    if (parts.length === 1) return { given: "", family: parts[0] ?? "" };
    return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1] ?? "" };
  }
  function toBibtex(rows) {
    const usedKeys = /* @__PURE__ */ new Set();
    const entries = rows.map((r) => {
      const base = `${firstAuthorFamily(r.authors)}${r.year ?? "nd"}${firstTitleWord(r.title)}`.replace(
        /[^A-Za-z0-9]/g,
        ""
      ) || "paperfetch";
      let key = base;
      for (let suffix = 1; usedKeys.has(key); suffix++) {
        key = base + String.fromCharCode(97 + suffix);
      }
      usedKeys.add(key);
      const lines = [`@article{${key},`];
      if (r.title) lines.push(`  title = {${bibSafe(r.title)}},`);
      if (r.authors.length > 0) {
        const names = r.authors.map((a) => bibSafe(a)).join(" and ");
        lines.push(`  author = {${names}},`);
      }
      if (r.journal) lines.push(`  journal = {${bibSafe(r.journal)}},`);
      if (r.year) lines.push(`  year = {${r.year}},`);
      lines.push(`  doi = {${bibSafe(r.doi)}},`);
      lines.push(`  url = {https://doi.org/${bibSafe(r.doi)}}`);
      lines.push("}");
      return lines.join("\n");
    });
    return `${entries.join("\n\n")}
`;
  }
  function toCslJson(rows) {
    const out = rows.map((r) => {
      const item = {
        id: r.doi,
        DOI: r.doi,
        type: "article-journal",
        URL: `https://doi.org/${r.doi}`
      };
      if (r.title) item.title = r.title;
      if (r.authors.length > 0) {
        item.author = r.authors.map((a) => {
          const { given, family } = splitDisplayName(a);
          return given ? { family, given } : { family };
        });
      }
      if (r.journal) item["container-title"] = r.journal;
      if (r.year) item.issued = { "date-parts": [[r.year]] };
      return item;
    });
    return JSON.stringify(out, null, 2);
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
  async function downloadText(filename, mime, body) {
    const url = `data:${mime};charset=utf-8,${encodeURIComponent(body)}`;
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: true });
    if (downloadId === void 0) throw new Error("download failed");
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

  // src/shared/urls.ts
  var SUPPORT_EMAIL = "support@zovo.one";
  var SUPPORT_MAILTO_URL = `mailto:${SUPPORT_EMAIL}`;
  var LICENSE_VERIFY_URL = "https://zgubxqomnbmxgbdhvwja.supabase.co/functions/v1/verify-extension-license";
  var LICENSE_VERIFY_TIMEOUT_MS = 5e3;
  var LICENSE_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1e3;

  // src/shared/feature-gate.ts
  var SUPABASE_ANON_KEY = "sb_publishable_RG4IVO9Qm23_xPzdQjdFPQ_QHBwbOLv";
  var PRO_KEY_PATTERN = /^sb_publishable_[a-z0-9_]{28,48}$/i;
  var EXTENSION_KEY = "paperfetch";
  var MAX_KEY_LENGTH = 128;
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
  async function readProKey() {
    try {
      const bag = await chrome.storage.local.get(STORAGE_KEYS.licenseKey);
      const v = bag[STORAGE_KEYS.licenseKey];
      return typeof v === "string" && v.length > 0 ? v : null;
    } catch {
      return null;
    }
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
  function isValidKeyFormat(key) {
    return typeof key === "string" && PRO_KEY_PATTERN.test(key.trim());
  }
  function isApiResponse(v) {
    if (typeof v !== "object" || v === null) return false;
    const r = v;
    if (typeof r["valid"] !== "boolean") return false;
    if (r["valid"] && (typeof r["tier"] !== "string" || r["tier"].length === 0)) {
      return false;
    }
    return true;
  }
  async function isCacheStillPro(key) {
    const cachedKey = await readProKey();
    if (cachedKey !== key) return false;
    const status = await readProStatus();
    if (status !== "pro") return false;
    const verifiedAt = await readProVerifiedAt();
    const exp = await readProExp();
    const now = Date.now();
    if (exp > 0 && now > exp) return false;
    if (verifiedAt <= 0) return false;
    return now - verifiedAt <= OFFLINE_GRACE_MS;
  }
  async function checkLicenseKey(rawKey) {
    if (typeof rawKey !== "string") {
      return { valid: false, tier: "free" /* Free */, error: "License key is required" };
    }
    const key = rawKey.trim();
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
      return { valid: false, tier: "free" /* Free */, error: "License key is required" };
    }
    if (!isValidKeyFormat(key)) {
      return { valid: false, tier: "free" /* Free */, error: "Invalid key format" };
    }
    if (!LICENSE_VERIFY_URL.startsWith("https://")) {
      return { valid: false, tier: "free" /* Free */, error: "Insecure endpoint" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LICENSE_VERIFY_TIMEOUT_MS);
    try {
      const res = await fetch(LICENSE_VERIFY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`
        },
        body: JSON.stringify({
          license_key: key,
          extension: EXTENSION_KEY
        }),
        signal: controller.signal
      });
      let data;
      try {
        data = await res.json();
      } catch {
        return await offlineFallback(key);
      }
      if (!isApiResponse(data)) {
        return { valid: false, tier: "free" /* Free */, error: "Unexpected server response" };
      }
      if (data.valid) {
        const tier = data.tier === "pro" ? "pro" /* Pro */ : "free" /* Free */;
        await setTier(tier, {
          key,
          verifiedAt: Date.now(),
          exp: typeof data.exp === "number" && Number.isFinite(data.exp) ? data.exp : 0
        });
        return { valid: tier === "pro" /* Pro */, tier };
      }
      await setTier("free" /* Free */, { key: null, verifiedAt: 0, exp: 0 });
      return {
        valid: false,
        tier: "free" /* Free */,
        error: data.error ?? data.reason ?? "Invalid license key"
      };
    } catch {
      return await offlineFallback(key);
    } finally {
      clearTimeout(timer);
    }
  }
  async function offlineFallback(key) {
    if (await isCacheStillPro(key)) {
      return { valid: true, tier: "pro" /* Pro */, cached: true };
    }
    return { valid: false, tier: "free" /* Free */, error: "Could not reach license server" };
  }

  // src/shared/funnel.ts
  var FUNNEL_EVENTS_KEY = "pape4a9d_funnel_events";
  var MAX_EVENTS = 100;
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

  // src/options/options.ts
  bootstrapI18n();
  function $(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`pape4a9d options: missing #${id}`);
    return el;
  }
  var API_HOSTS = /* @__PURE__ */ new Set([
    "api.unpaywall.org",
    "api.openalex.org",
    "api.crossref.org",
    "export.arxiv.org"
  ]);
  var currentFilter = "all";
  var currentQuery = "";
  function show(id, on = true) {
    $(id).hidden = !on;
  }
  async function currentRows() {
    try {
      return await listRows({ query: currentQuery, found: currentFilter });
    } catch {
      return [];
    }
  }
  function renderRow(r) {
    const tpl = document.getElementById("pf-tpl-row");
    const node = tpl?.content.firstElementChild?.cloneNode(true);
    if (!node) return null;
    const dot = node.querySelector(".pf-row-dot");
    if (dot) dot.classList.add(r.foundFreeCopy ? "is-found" : "is-missing");
    const set = (sel, text) => {
      const el = node.querySelector(sel);
      if (el) el.textContent = text;
    };
    set(".pf-row-title", r.title ?? r.doi);
    set(".pf-row-doi", r.doi);
    set(".pf-cell-journal", r.journal ?? "");
    set(".pf-cell-year", r.year !== null ? String(r.year) : "");
    set(".pf-cell-host", r.host ?? "");
    set(".pf-cell-date", r.dateSeen.slice(0, 10));
    node.querySelector(".pf-row-copy-doi")?.addEventListener("click", () => {
      if (!isPro()) {
        window.open(CHECKOUT_URL("options"), "_blank", "noopener");
        return;
      }
      void navigator.clipboard.writeText(r.doi).catch(() => void 0);
    });
    node.querySelector(".pf-row-copy-citation")?.addEventListener("click", () => {
      if (!isPro()) {
        window.open(CHECKOUT_URL("options"), "_blank", "noopener");
        return;
      }
      void navigator.clipboard.writeText(formatCitation(r)).catch(() => void 0);
    });
    node.querySelector(".pf-row-delete")?.addEventListener("click", () => {
      void deleteRow(r.doi).then(renderLibrary);
    });
    return node;
  }
  async function renderLibrary() {
    const rows = await currentRows();
    const tbody = $("pf-rows");
    tbody.textContent = "";
    for (const r of rows) {
      const node = renderRow(r);
      if (node) tbody.appendChild(node);
    }
    $("pf-lib-count").textContent = msgf("optionsLibCount", rows.length, `${rows.length} in library`);
    const emptyEl = $("pf-lib-empty");
    const isFiltering = currentQuery.trim() !== "" || currentFilter !== "all";
    if (rows.length === 0) {
      if (isFiltering) {
        const title = emptyEl.querySelector(".pf-empty-title");
        const text = emptyEl.querySelector(".pf-empty-text");
        if (title) title.textContent = msg("optionsNoResults", "No papers match your search.");
        if (text) text.textContent = "";
      }
      show("pf-lib-empty");
    } else {
      show("pf-lib-empty", false);
    }
  }
  async function exportRows(kind) {
    if ((kind === "csl" || kind === "both") && !isPro()) {
      window.open(CHECKOUT_URL("options"), "_blank", "noopener");
      return;
    }
    const rows = await currentRows();
    if (rows.length === 0) {
      const status = $("pf-export-status");
      status.textContent = msg("optionsExportEmpty");
      show("pf-export-status");
      return;
    }
    show("pf-export-status", false);
    try {
      if (kind === "bibtex" || kind === "both") {
        await downloadText(BIBTEX_FILENAME, BIBTEX_MIME, toBibtex(rows));
        logFunnelEvent({ type: "export_bibtex", at: (/* @__PURE__ */ new Date()).toISOString() });
      }
      if (kind === "csl" || kind === "both") {
        await downloadText(CSL_JSON_FILENAME, CSL_JSON_MIME, toCslJson(rows));
        logFunnelEvent({ type: "export_csl_json", at: (/* @__PURE__ */ new Date()).toISOString() });
      }
    } catch {
    }
  }
  function wireClearAll() {
    const input = $("pf-clear-input");
    const confirmBtn = $("pf-clear-confirm");
    $("pf-clear-all").addEventListener("click", () => {
      show("pf-clear-panel");
      input.value = "";
      confirmBtn.disabled = true;
      input.focus();
    });
    input.addEventListener("input", () => {
      confirmBtn.disabled = input.value !== "DELETE";
    });
    $("pf-clear-cancel").addEventListener("click", () => show("pf-clear-panel", false));
    confirmBtn.addEventListener("click", () => {
      void clearAll().then(() => {
        show("pf-clear-panel", false);
        void renderLibrary();
      });
    });
  }
  async function renderGrants() {
    const list = $("pf-grants-list");
    list.textContent = "";
    let origins = [];
    try {
      const perms = await chrome.permissions.getAll();
      origins = (perms.origins ?? []).map((p) => p.replace(/\/\*$/, "")).filter((o) => {
        try {
          return !API_HOSTS.has(new URL(o).hostname);
        } catch {
          return false;
        }
      });
    } catch {
    }
    const pro = isPro();
    show("pf-grants-lock", !pro);
    show("pf-grants-gate", !pro);
    show("pf-grants-empty", origins.length === 0);
    const tpl = document.getElementById("pf-tpl-grant");
    for (const origin of origins) {
      const node = tpl?.content.firstElementChild?.cloneNode(true);
      if (!node) continue;
      const hostEl = node.querySelector(".pf-grant-host");
      if (hostEl) hostEl.textContent = origin;
      node.querySelector(".pf-grant-revoke")?.addEventListener("click", () => {
        void chrome.permissions.remove({ origins: [`${origin}/*`] }).then(() => {
          logFunnelEvent({ type: "grant_removed", at: (/* @__PURE__ */ new Date()).toISOString() });
          void renderGrants();
        }).catch(() => void 0);
      });
      list.appendChild(node);
    }
  }
  function renderTier() {
    const pro = isPro();
    show("pf-tier", pro);
    show("pf-license-state", pro);
    show("pf-license-upgrade", !pro);
    const input = $("pf-license-key");
    const btn = $("pf-license-activate");
    input.disabled = pro;
    btn.disabled = pro;
  }
  function wireLicense() {
    const input = $("pf-license-key");
    const btn = $("pf-license-activate");
    btn.addEventListener("click", () => {
      void (async () => {
        const original = btn.textContent ?? "";
        btn.disabled = true;
        btn.textContent = msg("optionsLicenseChecking", "Verifying\u2026");
        try {
          const result = await checkLicenseKey(input.value);
          if (result.valid && result.tier === "pro") {
            await refreshCachedTier();
            renderTier();
            void renderGrants();
          } else {
            btn.textContent = msg("optionsLicenseInvalid", "That key could not be verified. Check it and try again.");
            window.setTimeout(() => {
              btn.textContent = original;
              btn.disabled = false;
            }, 2500);
            return;
          }
        } catch {
          btn.textContent = original;
          btn.disabled = false;
          return;
        }
        btn.textContent = original;
      })();
    });
  }
  function wireFilters() {
    const chips = Array.from(document.querySelectorAll(".pf-chip[data-filter]"));
    for (const chip of chips) {
      chip.addEventListener("click", () => {
        currentFilter = chip.dataset["filter"] ?? "all";
        for (const c of chips) c.setAttribute("aria-pressed", String(c === chip));
        void renderLibrary();
      });
    }
    const search = $("pf-search");
    let t = null;
    search.addEventListener("input", () => {
      if (t !== null) clearTimeout(t);
      t = window.setTimeout(() => {
        currentQuery = search.value;
        void renderLibrary();
      }, 150);
    });
  }
  async function mountSidebar() {
    try {
      const res = await fetch(chrome.runtime.getURL("zovo-sidebar.html"));
      if (!res.ok) return;
      const html = await res.text();
      const mount = $("pf-monetization");
      mount.innerHTML = html;
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("zovo-sidebar.js");
      mount.appendChild(script);
    } catch {
    }
  }
  void (async () => {
    await refreshCachedTier();
    wireFilters();
    wireClearAll();
    wireLicense();
    $("pf-export-bibtex").addEventListener("click", () => void exportRows("bibtex"));
    $("pf-export-csl").addEventListener("click", () => void exportRows("csl"));
    $("pf-export-both").addEventListener("click", () => void exportRows("both"));
    renderTier();
    await renderLibrary();
    await renderGrants();
    await mountSidebar();
  })();
})();
