// ==UserScript==
// @name         Suno Create: WID-aware autosave (GM) + Lyrics/Style/Title/SongDesc
// @namespace    https://github.com/soichirow/suno-create-autosave-userscript
// @version      0.90
// @description  Autosave & restore Lyrics/Style/Title/Song Description per workspace (wid) on suno.com/create.
// @author       soichirow
// @match        https://suno.com/create*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @license      MIT
// @homepageURL  https://github.com/soichirow/suno-create-autosave-userscript
// @supportURL   https://github.com/soichirow/suno-create-autosave-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/soichirow/suno-create-autosave-userscript/main/Suno-Create-Autosave.user.js
// @updateURL    https://raw.githubusercontent.com/soichirow/suno-create-autosave-userscript/main/Suno-Create-Autosave.user.js
// ==/UserScript==

(function () {
  "use strict";

  const LOG_PREFIX = "[SunoAutosave]";
  const AUTOSAVE_MS = 5 * 60 * 1000;

  // ====== Keys (widごとに prefix されます) ======
  const KEY_LYRICS = "lyrics";
  const KEY_LYRICS_CLEARED = "lyrics_cleared"; // Clear ボタンを押した時だけ true
  const KEY_STYLE = "style_text";
  const KEY_TITLE = "song_title";
  const KEY_SONG_DESC = "song_desc";

  // ====== Defaults ======
  const LYRICS_DEFAULT = "[Instrumental]";
  const SONG_DESC_LABEL_TEXT = "Song Description";

  // ====== Selectors ======
  const LYRICS_SELECTOR =
    'textarea[placeholder*="Write some lyrics"], textarea[placeholder*="leave blank for instrumental"]';

  const STYLE_SELECTOR = 'textarea[maxlength="1000"]';

  const TITLE_SELECTOR =
    'input[placeholder="Song Title (Optional)"], input[placeholder*="Song Title"]';

  const CLEAR_LYRICS_BTN_SELECTOR = 'button[aria-label="Clear lyrics"]';

  // ====== Logging ======
  const now = () => new Date().toLocaleTimeString();
  const log = (...a) => console.log(LOG_PREFIX, now(), ...a);
  const warn = (...a) => console.warn(LOG_PREFIX, now(), ...a);
  const err = (...a) => console.error(LOG_PREFIX, now(), ...a);

  const short = (s, n = 120) =>
    (s ?? "").toString().replace(/\s+/g, " ").trim().slice(0, n);

  // ====== Utils ======
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isVisible(el) {
    return !!(el && (el.offsetParent || el.getClientRects().length));
  }

  function getWidNow() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get("wid") || "default";
    } catch {
      return "default";
    }
  }

  function widKeyFor(wid, key) {
    return `suno_${wid}_${key}`;
  }

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

  // React対策込みの値セット
  function setControlValue(el, value) {
    try {
      const isTA = el instanceof HTMLTextAreaElement;
      const proto = isTA
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;

      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (!setter) {
        el.value = value;
      } else {
        const lastValue = el.value;
        setter.call(el, value);

        const tracker = el._valueTracker;
        if (tracker) tracker.setValue(lastValue);
      }

      try {
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
      } catch {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      err("setControlValue FAILED:", e);
      return false;
    }
  }

  async function stickySetByGetter(getter, value, label, tries = 10, intervalMs = 120) {
    for (let t = 1; t <= tries; t++) {
      const el = getter();
      if (!el) {
        warn(label, "element missing, retry", t);
        await sleep(intervalMs);
        continue;
      }

      el.dataset.tmSetting = "1";
      try {
        if ((el.value ?? "") === value) {
          log(label, "already set", { v: short(el.value) });
          return true;
        }

        setControlValue(el, value);
        await sleep(intervalMs);

        const el2 = getter();
        if (el2 && (el2.value ?? "") === value) {
          log(label, "stuck OK", { v: short(value) });
          return true;
        }
        warn(label, "did not stick, retry", t, { current: short(el.value) });
      } finally {
        delete el.dataset.tmSetting;
      }
    }

    warn(label, "gave up (not sticking)");
    return false;
  }

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
      return true;
    } catch (e) {
      err("GM_setValue FAILED:", key, e);
      return false;
    }
  }

  // ====== Element getters ======
  function getLyricsEl() {
    const list = [...document.querySelectorAll(LYRICS_SELECTOR)].filter(isVisible);
    return list[0] || null;
  }

  function getStyleEl() {
    const candidates = [...document.querySelectorAll(STYLE_SELECTOR)].filter(isVisible);
    const lyrics = getLyricsEl();
    // Lyrics textarea と同一を避ける
    const style = candidates.find((t) => t !== lyrics) || candidates[0] || null;
    return style;
  }

  function getTitleEl() {
    const list = [...document.querySelectorAll(TITLE_SELECTOR)].filter(isVisible);
    return list[0] || null;
  }

  function getSongDescEl() {
    // 「Song Description」ラベル近傍の textarea を探す
    const labels = [...document.querySelectorAll("*")].filter((n) => {
      if (!isVisible(n)) return false;
      const txt = (n.textContent || "").trim();
      return txt === SONG_DESC_LABEL_TEXT;
    });

    for (const label of labels) {
      let a = label;
      for (let i = 0; i < 8 && a; i++) {
        const cands = [...a.querySelectorAll("textarea")]
          .filter(isVisible)
          .filter((t) => !t.matches(LYRICS_SELECTOR))
          .filter((t) => !t.matches(STYLE_SELECTOR));

        if (cands.length) return cands[0];
        a = a.parentElement;
      }
    }
    return null;
  }

  // ====== Per-wid restore tracking ======
  const restoredLyrics = new Set();
  const restoredStyle = new Set();
  const restoredTitle = new Set();
  const restoredSongDesc = new Set();

  // ====== Last-saved caches ======
  const lastLyricsSaved = new Map();   // wid -> string
  const lastStyleSaved = new Map();    // wid -> string
  const lastTitleSaved = new Map();    // wid -> string (normalized)
  const lastSongDescSaved = new Map(); // wid -> string

  // ====== Debounce timers ======
  let tLyrics = null;
  let tStyle = null;
  let tTitle = null;
  let tSongDesc = null;

  function schedule(fn, which, ms = 220) {
    if (which === "lyrics") {
      if (tLyrics) clearTimeout(tLyrics);
      tLyrics = setTimeout(() => { tLyrics = null; fn(); }, ms);
      return;
    }
    if (which === "style") {
      if (tStyle) clearTimeout(tStyle);
      tStyle = setTimeout(() => { tStyle = null; fn(); }, ms);
      return;
    }
    if (which === "title") {
      if (tTitle) clearTimeout(tTitle);
      tTitle = setTimeout(() => { tTitle = null; fn(); }, ms);
      return;
    }
    if (which === "songdesc") {
      if (tSongDesc) clearTimeout(tSongDesc);
      tSongDesc = setTimeout(() => { tSongDesc = null; fn(); }, ms);
    }
  }

  // ====== Save functions ======
  async function saveLyricsNow(reason) {
    const wid = getWidNow();
    const el = getLyricsEl();
    if (!el) return;
    if (el.dataset.tmSetting === "1") return;

    const raw = (el.value ?? "").toString();
    const last = lastLyricsSaved.get(wid);
    if (raw === last) return;

    lastLyricsSaved.set(wid, raw);
    await gmSet(widKeyFor(wid, KEY_LYRICS), raw);
    log("Lyrics saved", { wid, reason, len: raw.length, head: short(raw) });
  }

  async function saveStyleNow(reason) {
    const wid = getWidNow();
    const el = getStyleEl();
    if (!el) return;
    if (el.dataset.tmSetting === "1") return;

    const raw = (el.value ?? "").toString();
    const last = lastStyleSaved.get(wid);
    if (raw === last) return;

    lastStyleSaved.set(wid, raw);
    await gmSet(widKeyFor(wid, KEY_STYLE), raw);
    log("Style saved", { wid, reason, len: raw.length, head: short(raw) });
  }

  async function saveTitleNow(reason) {
    const wid = getWidNow();
    const el = getTitleEl();
    if (!el) return;
    if (el.dataset.tmSetting === "1") return;

    const raw = (el.value ?? "").toString().trim();
    if (!raw) {
      lastTitleSaved.set(wid, "");
      await gmSet(widKeyFor(wid, KEY_TITLE), "");
      log("Title saved empty", { wid, reason });
      return;
    }

    const normalized = withDateSuffix(raw);
    const last = lastTitleSaved.get(wid);
    if (normalized === last) return;

    lastTitleSaved.set(wid, normalized);
    await gmSet(widKeyFor(wid, KEY_TITLE), normalized);
    log("Title saved", { wid, reason, head: short(normalized) });
  }

  async function saveSongDescNow(reason) {
    const wid = getWidNow();
    const el = getSongDescEl();
    if (!el) return;
    if (el.dataset.tmSetting === "1") return;

    const raw = (el.value ?? "").toString();
    const last = lastSongDescSaved.get(wid);
    if (raw === last) return;

    lastSongDescSaved.set(wid, raw);
    await gmSet(widKeyFor(wid, KEY_SONG_DESC), raw);
    log("SongDesc saved", { wid, reason, len: raw.length, head: short(raw) });
  }

  // ====== Restore functions ======
  async function restoreLyricsIfNeeded() {
    const wid = getWidNow();
    const el = getLyricsEl();
    if (!el) return;

    if (restoredLyrics.has(wid)) return;

    // すでに値があるなら触らない（ただし cache は持っておく）
    if ((el.value ?? "").toString().trim() !== "") {
      restoredLyrics.add(wid);
      lastLyricsSaved.set(wid, (el.value ?? "").toString());
      log("Lyrics restore skipped (field not empty)", { wid });
      return;
    }

    restoredLyrics.add(wid);

    const saved = (await gmGet(widKeyFor(wid, KEY_LYRICS), "")).toString();
    const cleared = !!(await gmGet(widKeyFor(wid, KEY_LYRICS_CLEARED), false));

    if (saved.trim() !== "") {
      log("Lyrics restore from saved", { wid, head: short(saved) });
      await stickySetByGetter(getLyricsEl, saved, "LyricsRestore");
      lastLyricsSaved.set(wid, saved);
      return;
    }

    if (cleared) {
      log("Lyrics restore: cleared=true so keep empty", { wid });
      lastLyricsSaved.set(wid, "");
      return;
    }

    // saved が空で cleared でもないなら default を入れる
    log("Lyrics empty -> insert default", { wid, v: LYRICS_DEFAULT });
    await stickySetByGetter(getLyricsEl, LYRICS_DEFAULT, "LyricsDefault");
    lastLyricsSaved.set(wid, LYRICS_DEFAULT);
    await gmSet(widKeyFor(wid, KEY_LYRICS), LYRICS_DEFAULT);
    await gmSet(widKeyFor(wid, KEY_LYRICS_CLEARED), false);
  }

  async function restoreStyleIfNeeded() {
    const wid = getWidNow();
    const el = getStyleEl();
    if (!el) return;

    if (restoredStyle.has(wid)) return;

    if ((el.value ?? "").toString().trim() !== "") {
      restoredStyle.add(wid);
      lastStyleSaved.set(wid, (el.value ?? "").toString());
      log("Style restore skipped (field not empty)", { wid });
      return;
    }

    restoredStyle.add(wid);

    const saved = (await gmGet(widKeyFor(wid, KEY_STYLE), "")).toString();
    if (saved.trim() === "") {
      log("Style restore skipped (no saved)", { wid });
      lastStyleSaved.set(wid, "");
      return;
    }

    log("Style restore", { wid, head: short(saved) });
    await stickySetByGetter(getStyleEl, saved, "StyleRestore");
    lastStyleSaved.set(wid, saved);
  }

  async function restoreTitleIfNeeded() {
    const wid = getWidNow();
    const el = getTitleEl();
    if (!el) return;

    if (restoredTitle.has(wid)) return;

    if ((el.value ?? "").toString().trim() !== "") {
      restoredTitle.add(wid);
      lastTitleSaved.set(wid, withDateSuffix((el.value ?? "").toString().trim()));
      log("Title restore skipped (field not empty)", { wid });
      return;
    }

    restoredTitle.add(wid);

    const saved = (await gmGet(widKeyFor(wid, KEY_TITLE), "")).toString().trim();
    if (!saved) {
      log("Title restore skipped (no saved)", { wid });
      lastTitleSaved.set(wid, "");
      return;
    }

    const normalized = withDateSuffix(saved);
    log("Title restore", { wid, head: short(normalized) });

    await stickySetByGetter(getTitleEl, normalized, "TitleRestore");
    lastTitleSaved.set(wid, normalized);
    await gmSet(widKeyFor(wid, KEY_TITLE), normalized);
  }

  async function restoreSongDescIfNeeded() {
    const wid = getWidNow();
    const el = getSongDescEl();
    if (!el) return;

    if (restoredSongDesc.has(wid)) return;

    if ((el.value ?? "").toString().trim() !== "") {
      restoredSongDesc.add(wid);
      lastSongDescSaved.set(wid, (el.value ?? "").toString());
      log("SongDesc restore skipped (field not empty)", { wid });
      return;
    }

    restoredSongDesc.add(wid);

    const saved = (await gmGet(widKeyFor(wid, KEY_SONG_DESC), "")).toString();
    if (saved.trim() === "") {
      log("SongDesc restore skipped (no saved)", { wid });
      lastSongDescSaved.set(wid, "");
      return;
    }

    log("SongDesc restore", { wid, head: short(saved) });
    await stickySetByGetter(getSongDescEl, saved, "SongDescRestore");
    lastSongDescSaved.set(wid, saved);
  }

  // ====== Event handlers (global) ======
  let handlersInstalled = false;

  function installHandlersOnce() {
    if (handlersInstalled) return;
    handlersInstalled = true;

    document.addEventListener(
      "input",
      (e) => {
        const t = e.target;

        // Lyrics
        const lyrics = getLyricsEl();
        if (lyrics && t === lyrics && lyrics.dataset.tmSetting !== "1") {
          schedule(() => saveLyricsNow("input"), "lyrics");
        }

        // Style
        const style = getStyleEl();
        if (style && t === style && style.dataset.tmSetting !== "1") {
          schedule(() => saveStyleNow("input"), "style");
        }

        // Title
        const title = getTitleEl();
        if (title && t === title && title.dataset.tmSetting !== "1") {
          schedule(() => saveTitleNow("input"), "title", 600);
        }

        // Song Description
        const desc = getSongDescEl();
        if (desc && t === desc && desc.dataset.tmSetting !== "1") {
          schedule(() => saveSongDescNow("input"), "songdesc");
        }
      },
      true
    );

    // Title: blur で末尾日付を1個に正規化してフィールドにも反映
    document.addEventListener(
      "blur",
      async (e) => {
        const t = e.target;
        const el = getTitleEl();
        if (!el || t !== el) return;
        if (el.dataset.tmSetting === "1") return;

        const raw = (el.value ?? "").toString().trim();
        if (!raw) return;

        const normalized = withDateSuffix(raw);
        if (normalized !== raw) {
          log("Title blur normalize", { from: short(raw), to: short(normalized) });
          await stickySetByGetter(getTitleEl, normalized, "TitleNormalize");
        }
        await saveTitleNow("blur");
      },
      true
    );

    // Lyrics: Clear ボタンでクリア + 保存もクリア扱い
    document.addEventListener(
      "click",
      async (e) => {
        const btn = e.target && e.target.closest ? e.target.closest(CLEAR_LYRICS_BTN_SELECTOR) : null;
        if (!btn) return;

        const wid = getWidNow();
        const el = getLyricsEl();
        if (!el) return;

        log("Clear lyrics button clicked", { wid });

        // フィールドをクリア
        await stickySetByGetter(getLyricsEl, "", "LyricsClearClick");

        // 保存もクリア
        lastLyricsSaved.set(wid, "");
        await gmSet(widKeyFor(wid, KEY_LYRICS), "");
        await gmSet(widKeyFor(wid, KEY_LYRICS_CLEARED), true);
        log("Lyrics cleared & saved as cleared=true", { wid });
      },
      true
    );

    // ページ離脱直前に念のため保存
    window.addEventListener("beforeunload", () => {
      try {
        const wid = getWidNow();

        const lyrics = getLyricsEl();
        if (lyrics && lyrics.dataset.tmSetting !== "1") {
          GM_setValue(widKeyFor(wid, KEY_LYRICS), (lyrics.value ?? "").toString());
        }

        const style = getStyleEl();
        if (style && style.dataset.tmSetting !== "1") {
          GM_setValue(widKeyFor(wid, KEY_STYLE), (style.value ?? "").toString());
        }

        const title = getTitleEl();
        if (title && title.dataset.tmSetting !== "1") {
          const raw = (title.value ?? "").toString().trim();
          GM_setValue(widKeyFor(wid, KEY_TITLE), raw ? withDateSuffix(raw) : "");
        }

        const desc = getSongDescEl();
        if (desc && desc.dataset.tmSetting !== "1") {
          GM_setValue(widKeyFor(wid, KEY_SONG_DESC), (desc.value ?? "").toString());
        }
      } catch {}
    });

    log("Global handlers installed");
  }

  // ====== Autosave intervals (once) ======
  let intervalsStarted = false;
  function startIntervalsOnce() {
    if (intervalsStarted) return;
    intervalsStarted = true;

    setInterval(() => saveLyricsNow("interval").catch(() => {}), AUTOSAVE_MS);
    setInterval(() => saveStyleNow("interval").catch(() => {}), AUTOSAVE_MS);
    setInterval(() => saveTitleNow("interval").catch(() => {}), AUTOSAVE_MS);
    setInterval(() => saveSongDescNow("interval").catch(() => {}), AUTOSAVE_MS);

    log("Autosave intervals started", AUTOSAVE_MS);
  }

  // ====== Scan / rescan ======
  let rescanTimer = null;
  function scheduleScan(reason) {
    if (rescanTimer) return;
    rescanTimer = setTimeout(async () => {
      rescanTimer = null;
      log("Rescan:", reason, { wid: getWidNow() });

      // restore (widごとに1回)
      try {
        await restoreLyricsIfNeeded();
        await restoreStyleIfNeeded();
        await restoreTitleIfNeeded();
        await restoreSongDescIfNeeded();
      } catch (e) {
        err("Restore failed", e);
      }

      // title: フォーカス外なら normalize を軽く寄せる（カーソル位置の事故回避）
      const title = getTitleEl();
      if (title && document.activeElement !== title && title.dataset.tmSetting !== "1") {
        const raw = (title.value ?? "").toString().trim();
        if (raw) {
          const normalized = withDateSuffix(raw);
          if (normalized !== raw) {
            log("Title normalize (not focused)", { from: short(raw), to: short(normalized) });
            stickySetByGetter(getTitleEl, normalized, "TitleNormalizeNotFocused").catch(() => {});
          }
        }
      }
    }, 220);
  }

  // DOM変化
  const obs = new MutationObserver(() => scheduleScan("dom-mutation"));

  // pushState/replaceState で URL が変わる SPA 対策
  function hookHistory() {
    const _push = history.pushState;
    const _replace = history.replaceState;

    history.pushState = function () {
      const r = _push.apply(this, arguments);
      scheduleScan("pushState");
      return r;
    };
    history.replaceState = function () {
      const r = _replace.apply(this, arguments);
      scheduleScan("replaceState");
      return r;
    };
    window.addEventListener("popstate", () => scheduleScan("popstate"));
  }

  // 位置変化の保険（wid変更が history hook で拾えない場合）
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      scheduleScan("href-poll");
    }
  }, 800);

  // ====== Start ======
  log("Script loaded", location.href, { wid: getWidNow() });
  installHandlersOnce();
  startIntervalsOnce();

  obs.observe(document.documentElement, { childList: true, subtree: true });
  hookHistory();

  // 初回スキャン
  scheduleScan("initial");
})();
