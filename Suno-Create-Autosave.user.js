// ==UserScript==
// @name         Suno Create: WID-aware autosave (GM)
// @namespace    https://github.com/soichirow/suno-create-autosave-userscript
// @version      0.82
// @description  Autosave & restore Lyrics/Style/Title per workspace (wid) on suno.com/create.
// @match        https://suno.com/create*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @license      MIT
// @author       soichirow
// @description  Suno Create の Lyrics/Style/Title を wid ごとに自動保存・復元します。
// @homepageURL  https://github.com/soichirow/suno-create-autosave-userscript
// @supportURL   https://github.com/soichirow/suno-create-autosave-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/soichirow/suno-create-autosave-userscript/main/Suno-Create-Autosave.user.js
// @updateURL    https://raw.githubusercontent.com/soichirow/suno-create-autosave-userscript/main/Suno-Create-Autosave.user.js
// ==/UserScript==


(function () {
  "use strict";

  const TAG = "[suno-create-autosave]";
  const AUTOSAVE_MS = 5 * 60 * 1000;

  // ---- selectors ----
  const LYRICS_SELECTOR =
    'textarea[placeholder*="Write some lyrics"], textarea[placeholder*="leave blank for instrumental"]';
  const STYLE_SELECTOR = 'textarea[maxlength="1000"]';
  const TITLE_SELECTOR =
    'input[placeholder="Song Title (Optional)"], input[placeholder*="Song Title"]';

  // ---- keys ----
  const KEY_LYRICS = "suno_lyrics_text";
  const KEY_LYRICS_ALLOW_EMPTY = "suno_lyrics_allow_empty";
  const KEY_STYLE = "suno_style_text";
  const KEY_TITLE = "suno_song_title";

  // ---- defaults ----
  const LYRICS_DEFAULT = "[Instrumental]";

  // ---- logs ----
  const now = () => new Date().toLocaleTimeString();
  const log = (...a) => console.log(TAG, now(), ...a);
  const warn = (...a) => console.warn(TAG, now(), ...a);
  const err = (...a) => console.error(TAG, now(), ...a);

  const short = (s, n = 80) =>
    (s ?? "").toString().replace(/\s+/g, " ").trim().slice(0, n);

  function isVisible(el) {
    return !!(el && (el.offsetParent || el.getClientRects().length));
  }

  // ---- date suffix for title ----
  function getTodayYYMMDD() {
    const d = new Date();
    const yy = String(d.getFullYear() % 100).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yy}${mm}${dd}`;
  }

  function withDateSuffix(base) {
    const trimmed = (base ?? "").toString().trim();
    if (!trimmed) return "";
    const noSuffix = trimmed.replace(/_(\d{6}|\d{8})$/, "");
    return `${noSuffix}_${getTodayYYMMDD()}`;
  }

  // ---- GM helpers ----
  async function gmGet(key, def = "") {
    try {
      const v = GM_getValue(key, def);
      return v && typeof v.then === "function" ? await v : v;
    } catch (e) {
      err("GM_getValue FAILED:", key, e);
      return def;
    }
  }

  async function gmSet(key, value) {
    try {
      const r = GM_setValue(key, value);
      if (r && typeof r.then === "function") await r;
      log("GM_setValue:", key, "<=", short(value));
    } catch (e) {
      err("GM_setValue FAILED:", key, e);
    }
  }

  // ---- React-safe setter ----
  function setControlValueReact(el, value) {
    const isTA = el instanceof HTMLTextAreaElement;
    const proto = isTA ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;

    const lastValue = el.value;
    setter.call(el, value);

    const tracker = el._valueTracker;
    if (tracker) tracker.setValue(lastValue);

    try {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          data: value,
          inputType: "insertText",
        })
      );
    } catch {}

    try {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: value,
          inputType: "insertText",
        })
      );
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function stickySetByGetter(getEl, value, label, tries = 12, intervalMs = 150) {
    for (let t = 1; t <= tries; t++) {
      const el = getEl();
      if (!el) {
        warn(label, "no element yet, retrying...");
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }

      el.dataset.tmSetting = "1";
      try {
        setControlValueReact(el, value);
      } finally {
        delete el.dataset.tmSetting;
      }

      await new Promise((r) => setTimeout(r, intervalMs));

      const el2 = getEl();
      if (el2 && el2.value === value) {
        log(label, "stuck OK");
        return true;
      }
    }
    warn(label, "gave up");
    return false;
  }

  // ---- WID (workspace id) from URL ----
  function sanitizeWid(wid) {
    const s = (wid ?? "").toString().trim();
    if (!s) return "default";
    // uuid / default 想定だけど、念のためキーとして安全化
    return s.replace(/\s+/g, "_").replace(/[:/\\?&#]/g, "_").slice(0, 120);
  }

  function getWidNow() {
    try {
      const u = new URL(location.href);
      return sanitizeWid(u.searchParams.get("wid") || "default");
    } catch {
      return "default";
    }
  }

  let currentWid = getWidNow();

  function widKey(baseKey) {
    return `${baseKey}::wid=${currentWid}`;
  }

  // ---- URL change watcher (SPA対応) ----
  let lastHref = location.href;

  function checkUrlChange(reason) {
    const href = location.href;
    if (href === lastHref) return;
    lastHref = href;

    const newWid = getWidNow();
    if (newWid !== currentWid) {
      const old = currentWid;
      currentWid = newWid;
      log("WID changed:", old, "->", currentWid, "reason=", reason);
      schedule("wid-change");
    } else {
      schedule("url-change");
    }
  }

  function installUrlWatcher() {
    // pushState/replaceState hook
    const _push = history.pushState;
    history.pushState = function (...args) {
      _push.apply(this, args);
      setTimeout(() => checkUrlChange("pushState"), 0);
    };

    const _replace = history.replaceState;
    history.replaceState = function (...args) {
      _replace.apply(this, args);
      setTimeout(() => checkUrlChange("replaceState"), 0);
    };

    window.addEventListener("popstate", () => checkUrlChange("popstate"));

    // 保険
    setInterval(() => checkUrlChange("interval"), 500);

    log("URL watcher installed. current wid =", currentWid);
  }

  // ---- element getters ----
  function getLyricsEl() {
    return [...document.querySelectorAll(LYRICS_SELECTOR)].filter(isVisible)[0] || null;
  }
  function getStyleEl() {
    return [...document.querySelectorAll(STYLE_SELECTOR)].filter(isVisible)[0] || null;
  }
  function getTitleEl() {
    return [...document.querySelectorAll(TITLE_SELECTOR)].filter(isVisible)[0] || null;
  }

  // ---- per-wid restore tracking ----
  const restoredLyrics = new Set();
  const restoredStyle = new Set();
  const restoredTitle = new Set();

  // ---- Lyrics ----
  let lyricsHandlersInstalled = false;
  let lyricsDebounceTimer = null;
  const lastLyricsSaved = new Map(); // wid -> lastSaved

  async function saveLyricsNow(reason) {
    const el = getLyricsEl();
    if (!el) return;
    if (el.dataset.tmSetting === "1") return;

    const raw = (el.value ?? "").toString();
    const last = lastLyricsSaved.get(currentWid);
    if (raw === last) return;

    lastLyricsSaved.set(currentWid, raw);
    await gmSet(widKey(KEY_LYRICS), raw);
    log("Lyrics saved", { wid: currentWid, reason, len: raw.length, head: short(raw, 120) });
  }

  function scheduleSaveLyrics(reason) {
    if (lyricsDebounceTimer) clearTimeout(lyricsDebounceTimer);
    lyricsDebounceTimer = setTimeout(() => {
      lyricsDebounceTimer = null;
      saveLyricsNow(reason).catch((e) => err("saveLyricsNow FAILED", e));
    }, 200);
  }

  async function ensureLyricsDefaultIfNeeded(reason) {
    const el = getLyricsEl();
    if (!el) return;

    const allowEmpty = !!(await gmGet(widKey(KEY_LYRICS_ALLOW_EMPTY), false));
    const v = (el.value ?? "").toString();

    if (v.trim() !== "") {
      if (allowEmpty) await gmSet(widKey(KEY_LYRICS_ALLOW_EMPTY), false);
      return;
    }

    if (!allowEmpty) {
      log("Lyrics empty -> insert default", { wid: currentWid, reason });
      await stickySetByGetter(getLyricsEl, LYRICS_DEFAULT, "LyricsInsertDefault");
      await gmSet(widKey(KEY_LYRICS), LYRICS_DEFAULT);
      lastLyricsSaved.set(currentWid, LYRICS_DEFAULT);
    } else {
      log("Lyrics empty but allowEmpty=true -> keep empty", { wid: currentWid, reason });
      await gmSet(widKey(KEY_LYRICS), "");
      lastLyricsSaved.set(currentWid, "");
    }
  }

  function ensureLyricsClearButton() {
    const ta = getLyricsEl();
    if (!ta) return;

    if (ta.dataset.tmClearBtn === "1") return;
    ta.dataset.tmClearBtn = "1";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Lyrics をクリア";
    btn.title = "Lyrics を空にして保存（このワークスペースでは空を維持）";
    btn.style.cssText = [
      "margin-top:8px",
      "padding:6px 10px",
      "border-radius:999px",
      "border:1px solid rgba(255,255,255,0.15)",
      "background:rgba(255,255,255,0.06)",
      "color:inherit",
      "font-size:12px",
      "cursor:pointer",
    ].join(";");

    btn.addEventListener("click", async () => {
      await gmSet(widKey(KEY_LYRICS_ALLOW_EMPTY), true);
      await stickySetByGetter(getLyricsEl, "", "LyricsClear");
      await gmSet(widKey(KEY_LYRICS), "");
      lastLyricsSaved.set(currentWid, "");
      log("Lyrics cleared", { wid: currentWid });
    });

    ta.insertAdjacentElement("afterend", btn);
    log("Lyrics clear button added");
  }

  function installLyricsHandlersOnce() {
    if (lyricsHandlersInstalled) return;
    lyricsHandlersInstalled = true;

    document.addEventListener(
      "input",
      (e) => {
        const t = e.target;
        if (!(t instanceof HTMLTextAreaElement)) return;
        if (!t.matches(LYRICS_SELECTOR)) return;
        if (t.dataset.tmSetting === "1") return;
        scheduleSaveLyrics("input");
      },
      true
    );

    document.addEventListener(
      "focusout",
      (e) => {
        const t = e.target;
        if (!(t instanceof HTMLTextAreaElement)) return;
        if (!t.matches(LYRICS_SELECTOR)) return;
        if (t.dataset.tmSetting === "1") return;
        ensureLyricsDefaultIfNeeded("focusout").catch((e2) =>
          err("ensureLyricsDefaultIfNeeded FAILED", e2)
        );
      },
      true
    );

    window.addEventListener("beforeunload", () => {
      const el = getLyricsEl();
      if (!el) return;
      if (el.dataset.tmSetting === "1") return;
      try {
        GM_setValue(widKey(KEY_LYRICS), (el.value ?? "").toString());
      } catch {}
    });

    log("Lyrics handlers installed");
  }

  async function bindLyrics(ta) {
    if (!ta) return;
    installLyricsHandlersOnce();
    ensureLyricsClearButton();

    if (!restoredLyrics.has(currentWid) && (ta.value ?? "").toString().trim() === "") {
      restoredLyrics.add(currentWid);

      const saved = await gmGet(widKey(KEY_LYRICS), null); // null = まだ保存なし
      if (saved !== null) {
        const s = (saved ?? "").toString();
        log("Lyrics restore", { wid: currentWid, len: s.length, head: short(s, 120) });
        await stickySetByGetter(getLyricsEl, s, "LyricsRestore");
        lastLyricsSaved.set(currentWid, s);
      } else {
        await ensureLyricsDefaultIfNeeded("restore-initial");
      }
    }

    if (!ta.dataset.tmIntervalSet) {
      ta.dataset.tmIntervalSet = "1";
      setInterval(async () => {
        await saveLyricsNow("interval");
      }, AUTOSAVE_MS);
      log("Lyrics autosave interval START", AUTOSAVE_MS);
    }
  }

  // ---- Title ----
  let titleHandlersInstalled = false;
  let titleDebounceTimer = null;
  const lastTitleSaved = new Map(); // wid -> lastSaved

  async function saveTitleNow(reason) {
    const el = getTitleEl();
    if (!el) return;
    if (el.dataset.tmSetting === "1") return;

    const raw = (el.value ?? "").toString().trim();
    const normalized = raw ? withDateSuffix(raw) : "";

    const last = lastTitleSaved.get(currentWid);
    if (normalized === last) return;

    lastTitleSaved.set(currentWid, normalized);
    await gmSet(widKey(KEY_TITLE), normalized);
    log("Title saved", { wid: currentWid, reason, raw: short(raw), normalized: short(normalized) });
  }

  function scheduleSaveTitle(reason) {
    if (titleDebounceTimer) clearTimeout(titleDebounceTimer);
    titleDebounceTimer = setTimeout(() => {
      titleDebounceTimer = null;
      saveTitleNow(reason).catch((e) => err("saveTitleNow FAILED", e));
    }, 200);
  }

  function installTitleHandlersOnce() {
    if (titleHandlersInstalled) return;
    titleHandlersInstalled = true;

    document.addEventListener(
      "input",
      (e) => {
        const t = e.target;
        if (!(t instanceof HTMLInputElement)) return;
        if (!t.matches(TITLE_SELECTOR)) return;
        if (t.dataset.tmSetting === "1") return;
        scheduleSaveTitle("input");
      },
      true
    );

    document.addEventListener(
      "focusout",
      async (e) => {
        const t = e.target;
        if (!(t instanceof HTMLInputElement)) return;
        if (!t.matches(TITLE_SELECTOR)) return;
        if (t.dataset.tmSetting === "1") return;

        const raw = (t.value ?? "").toString().trim();
        if (!raw) {
          await saveTitleNow("focusout-empty");
          return;
        }

        const normalized = withDateSuffix(raw);
        if (normalized !== raw) {
          await stickySetByGetter(getTitleEl, normalized, "TitleNormalize");
        }
        await saveTitleNow("focusout");
      },
      true
    );

    window.addEventListener("beforeunload", () => {
      const el = getTitleEl();
      if (!el) return;
      if (el.dataset.tmSetting === "1") return;

      const raw = (el.value ?? "").toString().trim();
      const normalized = raw ? withDateSuffix(raw) : "";
      try {
        GM_setValue(widKey(KEY_TITLE), normalized);
      } catch {}
    });

    log("Title handlers installed");
  }

  async function bindTitle(inp) {
    if (!inp) return;
    installTitleHandlersOnce();

    if (!restoredTitle.has(currentWid) && (inp.value ?? "").toString().trim() === "") {
      restoredTitle.add(currentWid);

      const saved = (await gmGet(widKey(KEY_TITLE), "")).toString().trim();
      if (saved) {
        const normalized = withDateSuffix(saved);
        await stickySetByGetter(getTitleEl, normalized, "TitleRestore");
        lastTitleSaved.set(currentWid, normalized);
        await gmSet(widKey(KEY_TITLE), normalized);
      }
    }

    if (!inp.dataset.tmIntervalSet) {
      inp.dataset.tmIntervalSet = "1";
      setInterval(async () => {
        await saveTitleNow("interval");
      }, AUTOSAVE_MS);
      log("Title autosave interval START", AUTOSAVE_MS);
    }
  }

  // ---- Style ----
  let styleHandlersInstalled = false;
  let styleDebounceTimer = null;
  const lastStyleSaved = new Map(); // wid -> lastSaved

  async function saveStyleNow(reason) {
    const el = getStyleEl();
    if (!el) return;
    if (el.dataset.tmSetting === "1") return;

    const raw = (el.value ?? "").toString();
    const last = lastStyleSaved.get(currentWid);
    if (raw === last) return;

    lastStyleSaved.set(currentWid, raw);
    await gmSet(widKey(KEY_STYLE), raw);
    log("Style saved", { wid: currentWid, reason, len: raw.length, head: short(raw, 120) });
  }

  function scheduleSaveStyle(reason) {
    if (styleDebounceTimer) clearTimeout(styleDebounceTimer);
    styleDebounceTimer = setTimeout(() => {
      styleDebounceTimer = null;
      saveStyleNow(reason).catch((e) => err("saveStyleNow FAILED", e));
    }, 200);
  }

  function installStyleHandlersOnce() {
    if (styleHandlersInstalled) return;
    styleHandlersInstalled = true;

    document.addEventListener(
      "input",
      (e) => {
        const t = e.target;
        if (!(t instanceof HTMLTextAreaElement)) return;
        if (!t.matches(STYLE_SELECTOR)) return;
        if (t.dataset.tmSetting === "1") return;
        scheduleSaveStyle("input");
      },
      true
    );

    window.addEventListener("beforeunload", () => {
      const el = getStyleEl();
      if (!el) return;
      if (el.dataset.tmSetting === "1") return;
      try {
        GM_setValue(widKey(KEY_STYLE), (el.value ?? "").toString());
      } catch {}
    });

    log("Style handlers installed");
  }

  async function bindStyle(ta) {
    if (!ta) return;
    installStyleHandlersOnce();

    if (!restoredStyle.has(currentWid) && (ta.value ?? "").toString().trim() === "") {
      restoredStyle.add(currentWid);

      const saved = (await gmGet(widKey(KEY_STYLE), "")).toString();
      if (saved.trim() !== "") {
        await stickySetByGetter(getStyleEl, saved, "StyleRestore");
        lastStyleSaved.set(currentWid, saved);
      }
    }

    if (!ta.dataset.tmIntervalSet) {
      ta.dataset.tmIntervalSet = "1";
      setInterval(async () => {
        await saveStyleNow("interval");
      }, AUTOSAVE_MS);
      log("Style autosave interval START", AUTOSAVE_MS);
    }
  }

  // ---- scan/observe ----
  let timer = null;
  function schedule(reason) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      log("Rescan:", reason, "wid=", currentWid);
      scan();
    }, 200);
  }

  function scan() {
    // 念のため毎回更新
    currentWid = getWidNow();

    const lyrics = getLyricsEl();
    const style = getStyleEl();
    const title = getTitleEl();

    log("Scan", { wid: currentWid, lyricsFound: !!lyrics, styleFound: !!style, titleFound: !!title });

    if (lyrics) bindLyrics(lyrics);
    if (style) bindStyle(style);
    if (title) bindTitle(title);
  }

  log("Script loaded:", location.href, "wid=", currentWid);

  installUrlWatcher();
  scan();

  const obs = new MutationObserver(() => schedule("dom-mutation"));
  obs.observe(document.documentElement, { childList: true, subtree: true });
  log("MutationObserver started.");
})();



