/**
 * SAMSEL Web v2 — feature parity with SAMSEL V3 PRO (browser limits apply).
 */
(function () {
  "use strict";

  const LOOP_ROLL_BEATS = [1, 2, 4, 8, 16, 32, 64];
  const EQ_BAND_HZ = [];
  (function () {
    var lo = Math.log10(30),
      hi = Math.log10(18000);
    for (var i = 0; i < 10; i++) {
      var t = i / 9;
      EQ_BAND_HZ.push(Math.round(Math.pow(10, lo + t * (hi - lo)) * 100) / 100);
    }
  })();
  var EQ_MIN = -12,
    EQ_MAX = 20;

  var playlist = [];
  var currentIndex = -1;
  var repeatMode = 0;
  /** Same cycle as SAMSEL V3 PRO: Off → All → One */
  var repeatLabels = ["Repeat: Off", "Repeat: All", "Repeat: One"];

  var audioMain = new Audio();
  var audioNext = new Audio();
  var audioJingle = new Audio();
  audioMain.preload = audioNext.preload = audioJingle.preload = "auto";
  audioMain.crossOrigin = audioNext.crossOrigin = audioJingle.crossOrigin = "anonymous";

  var ctx = null;
  var gainMain,
    gainNext,
    gainJingle,
    eqFilters = [];
  var graphOk = false;
  var masterLinear = 1;

  var tagBpm = null;

  var hotcue = [null, null, null, null, null, null, null, null];

  var loopIn = null,
    loopOut = null,
    loopManual = false;

  var rollActive = false,
    rollVirtual = 0,
    rollIn = 0,
    rollOut = 0,
    rollRaf = 0;

  var xfRunning = false,
    xfCooldown = false;

  var jingleUrl = null;
  var jingleLocked = false;
  /** True while a transition jingle uses “replace” (main deck ducked until jingle ends). */
  var jingleReplaceHardCut = false;

  var lyricsParsed = [],
    lyricsOffsetMs = 0;

  /** Last successful “Load lyrics folder” index (for tag-time Foobar-style pairing). */
  var cachedLyricsFolderIndex = null;

  /** Silence trim tab: queue + optional File System Access output folder. */
  var trimFileQueue = [];
  var trimOutputDirHandle = null;
  var trimSelectedIndex = -1;

  var seekSeeking = false;

  /** ESM bundle — fuller ID3v2 / MP4 / Vorbis tags than jsmediatags alone. */
  var MUSIC_METADATA_IMPORT = "https://esm.sh/music-metadata@10.6.0";

  function $(id) {
    return document.getElementById(id);
  }

  /** Same as automix.js: UI on Pages + API on tunnel — set data-samsel-api-base on <html> (no trailing slash). */
  function getApiBase() {
    try {
      var html = document.documentElement;
      var b =
        (html && html.getAttribute && html.getAttribute("data-samsel-api-base")) || "";
      b = (b || "").trim();
      if (!b) {
        var m = document.querySelector('meta[name="samsel-api-base"]');
        if (m) b = (m.getAttribute("content") || "").trim();
      }
      return b.replace(/\/$/, "");
    } catch (e) {
      return "";
    }
  }

  function resolveApiUrl(pathOrUrl) {
    if (!pathOrUrl) return pathOrUrl;
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    var base = getApiBase();
    if (!base) return pathOrUrl;
    var p = pathOrUrl.charAt(0) === "/" ? pathOrUrl : "/" + pathOrUrl;
    return base + p;
  }

  function getWebBuild() {
    try {
      var m = document.querySelector('meta[name="samsel-web-build"]');
      return ((m && m.getAttribute("content")) || "").trim() || "0";
    } catch (e) {
      return "0";
    }
  }

  /** Same-origin jingle stream: drop crossOrigin so Cloudflare/proxies behave like 127.0.0.1. */
  function setJingleStreamSrc(absUrl) {
    try {
      var pageOrigin = window.location.origin;
      var u = new URL(absUrl, pageOrigin);
      if (u.origin === pageOrigin) {
        audioJingle.removeAttribute("crossOrigin");
      } else {
        audioJingle.crossOrigin = "anonymous";
      }
      audioJingle.src = absUrl;
    } catch (e) {
      audioJingle.crossOrigin = "anonymous";
      audioJingle.src = absUrl;
    }
  }

  /** Host for default jingle stream: explicit API base (split hosting) or current page (Option A / tunnel same host). */
  function defaultJingleStreamBaseOrigin() {
    var base = getApiBase();
    if (!base) return window.location.origin;
    try {
      return new URL(base, window.location.href).origin;
    } catch (e) {
      return window.location.origin;
    }
  }

  /** Config URL candidates: page origin first (fixes stale data-samsel-api-base hitting an old tunnel that still 200s), then API base / primary. */
  function jingleConfigUrlsToTry() {
    var list = [];
    var seen = {};
    function addCandidate(u) {
      if (!u) return;
      try {
        var abs = new URL(u, window.location.href).href;
        if (seen[abs]) return;
        seen[abs] = true;
        list.push(abs);
      } catch (e) {}
    }
    addCandidate(window.location.origin + "/api/jingle/config");
    var primary = resolveApiUrl("/api/jingle/config");
    addCandidate(primary);
    try {
      var pOrigin = new URL(primary, window.location.href).origin;
      var pageOrigin = window.location.origin;
      if (pOrigin !== pageOrigin) {
        addCandidate(pageOrigin + "/api/jingle/config");
      }
    } catch (e) {}
    return list;
  }

  function jingleConfigUrlWithBuster(absUrl) {
    var sep = absUrl.indexOf("?") >= 0 ? "&" : "?";
    return absUrl + sep + "_cfg=" + String(Date.now());
  }

  function revokeJingleUrlIfBlob() {
    if (jingleUrl && String(jingleUrl).indexOf("blob:") === 0) {
      try {
        URL.revokeObjectURL(jingleUrl);
      } catch (e) {}
    }
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return "00:00";
    var m = Math.floor(sec / 60),
      s = Math.floor(sec % 60);
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  function hzLabel(hz) {
    return hz >= 1000 ? (hz / 1000).toFixed(hz >= 10000 ? 0 : 1) + " kHz" : Math.round(hz) + " Hz";
  }

  function setStatus(t) {
    var el = $("status");
    if (el) {
      el.textContent = t;
      el.classList.toggle("ok", /play|ready|ok/i.test(t));
    }
  }

  function effBpm() {
    var v = tagBpm;
    if (v != null && isFinite(v) && v > 0) return v;
    var inp = $("bpm-fallback");
    var x = inp ? parseFloat(inp.value) : 120;
    return isFinite(x) && x > 0 ? x : 120;
  }

  function quantize(t) {
    var bpm = effBpm();
    var beat = 60 / bpm;
    return Math.max(0, Math.round(t / beat) * beat);
  }

  function ensureGraph() {
    if (graphOk) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      setStatus("Web Audio unavailable");
      return;
    }
    ctx = new AC();
    var msM = ctx.createMediaElementSource(audioMain);
    var msN = ctx.createMediaElementSource(audioNext);
    var msJ = ctx.createMediaElementSource(audioJingle);
    gainMain = ctx.createGain();
    gainNext = ctx.createGain();
    gainJingle = ctx.createGain();
    gainNext.gain.value = 0;
    gainJingle.gain.value = 0;
    var node = msM;
    eqFilters = [];
    for (var i = 0; i < 10; i++) {
      var f = ctx.createBiquadFilter();
      f.type = "peaking";
      f.frequency.value = EQ_BAND_HZ[i];
      f.Q.value = 1.2;
      f.gain.value = 0;
      node.connect(f);
      node = f;
      eqFilters.push(f);
    }
    node.connect(gainMain);
    gainMain.connect(ctx.destination);
    msN.connect(gainNext);
    gainNext.connect(ctx.destination);
    msJ.connect(gainJingle);
    gainJingle.connect(ctx.destination);
    gainMain.gain.value = masterLinear;
    graphOk = true;
  }

  async function resume() {
    if (ctx && ctx.state === "suspended") await ctx.resume();
  }

  function applyEq() {
    if (!eqFilters.length) return;
    for (var i = 0; i < 10; i++) {
      var sl = $("eq-" + i);
      if (sl && eqFilters[i]) eqFilters[i].gain.value = parseFloat(sl.value);
    }
  }

  function updateEqLabels() {
    for (var i = 0; i < 10; i++) {
      var sl = $("eq-" + i),
        db = $("eq-db-" + i);
      if (sl && db) {
        var v = parseInt(sl.value, 10);
        db.textContent = (v >= 0 ? "+" : "") + v + " dB";
      }
    }
  }

  function buildEqUI() {
    var host = $("eq-sliders");
    if (!host) return;
    host.setAttribute("data-tip", "eq_open");
    host.innerHTML = "";
    for (var i = 0; i < 10; i++) {
      var w = document.createElement("div");
      w.className = "eq-band";
      var lab = document.createElement("label");
      lab.htmlFor = "eq-" + i;
      lab.textContent = hzLabel(EQ_BAND_HZ[i]);
      var rng = document.createElement("input");
      rng.type = "range";
      rng.id = "eq-" + i;
      rng.min = String(EQ_MIN);
      rng.max = String(EQ_MAX);
      rng.value = "0";
      rng.step = "1";
      var db = document.createElement("span");
      db.className = "db";
      db.id = "eq-db-" + i;
      db.textContent = "0 dB";
      rng.addEventListener("input", function () {
        ensureGraph();
        applyEq();
        updateEqLabels();
      });
      w.appendChild(lab);
      w.appendChild(rng);
      w.appendChild(db);
      host.appendChild(w);
    }
  }

  function buildHotcues() {
    var g = $("hotcue-grid");
    if (!g) return;
    g.innerHTML = "";
    for (var row = 0; row < 2; row++) {
      var r = document.createElement("div");
      r.className = "hotcue-row";
      for (var c = 0; c < 4; c++) {
        var n = row * 4 + c + 1;
        var setb = document.createElement("button");
        setb.type = "button";
        setb.className = "btn small btn-lbl-gold";
        setb.setAttribute("data-tip", "hotcue_set");
        setb.textContent = "Set " + n;
        setb.onclick = (function (num) {
          return function () {
            hotcueSet(num);
          };
        })(n);
        var gob = document.createElement("button");
        gob.type = "button";
        gob.className = "btn small btn-lbl-cyan";
        gob.setAttribute("data-tip", "hotcue_go");
        gob.textContent = "Go " + n;
        gob.onclick = (function (num) {
          return function () {
            hotcueGo(num);
          };
        })(n);
        r.appendChild(setb);
        r.appendChild(gob);
      }
      g.appendChild(r);
    }
  }

  function fillBeatSelects() {
    ["dj-loop-beats", "dj-roll-beats"].forEach(function (id) {
      var sel = $(id);
      if (!sel) return;
      sel.innerHTML = "";
      LOOP_ROLL_BEATS.forEach(function (nb) {
        var o = document.createElement("option");
        o.value = String(nb);
        o.textContent = String(nb);
        sel.appendChild(o);
      });
    });
    var lb = $("dj-loop-beats");
    if (lb) lb.selectedIndex = 3;
    var rb = $("dj-roll-beats");
    if (rb) rb.selectedIndex = 2;
  }

  function hotcueSet(n) {
    if (currentIndex < 0) {
      setStatus("Load a track first");
      return;
    }
    var t = quantize(audioMain.currentTime);
    hotcue[n - 1] = t;
    setStatus("Hotcue " + n + " @ " + fmtTime(t));
  }

  function hotcueGo(n) {
    var t = hotcue[n - 1];
    if (t == null) {
      setStatus("No cue " + n);
      return;
    }
    audioMain.currentTime = t;
    rollStopInternal();
  }

  function loopInBtn() {
    loopManual = true;
    rollStopInternal();
    loopIn = audioMain.currentTime;
    loopOut = null;
    $("lp-status").textContent = "Loop In: " + fmtTime(loopIn) + " (set Out)";
  }

  function loopOutBtn() {
    if (loopIn == null) {
      setStatus("Set In first");
      return;
    }
    var t = audioMain.currentTime;
    if (t <= loopIn) {
      setStatus("Out must be after In");
      return;
    }
    loopOut = t;
    loopManual = true;
    $("lp-status").textContent = "Loop: " + fmtTime(loopIn) + " → " + fmtTime(loopOut);
  }

  function loopClear() {
    loopIn = loopOut = null;
    loopManual = false;
    $("lp-status").textContent = "No loop set";
    rollStopInternal();
  }

  function beatLoopOn() {
    var sel = $("dj-loop-beats");
    var nb = sel ? parseInt(sel.value, 10) : 8;
    if (currentIndex < 0) return;
    rollStopInternal();
    var bpm = effBpm();
    var beat = 60 / bpm;
    var t = audioMain.currentTime;
    var idx = Math.round(t / beat);
    var li = Math.max(0, idx * beat);
    var lo = li + nb * beat;
    var dur = audioMain.duration;
    if (isFinite(dur) && lo > dur) {
      lo = dur;
      if (lo <= li + 0.01) {
        setStatus("Not enough time for loop");
        return;
      }
    }
    loopIn = li;
    loopOut = lo;
    loopManual = true;
    audioMain.currentTime = li;
    $("lp-status").textContent = "🔁 Loop " + nb + " beats @ " + bpm.toFixed(0) + " BPM";
    setStatus("Beat loop on");
  }

  function beatLoopOff() {
    loopClear();
    setStatus("Loop off");
  }

  function rollOn() {
    if (currentIndex < 0) return;
    var sel = $("dj-roll-beats");
    var nb = sel ? parseInt(sel.value, 10) : 4;
    var bpm = effBpm();
    var beat = 60 / bpm;
    var t = audioMain.currentTime;
    var idx = Math.round(t / beat);
    var li = Math.max(0, idx * beat);
    var lo = li + nb * beat;
    var dur = audioMain.duration;
    if (isFinite(dur) && lo > dur) {
      lo = dur;
      if (lo <= li + 0.01) {
        setStatus("Roll: not enough time");
        return;
      }
    }
    loopIn = li;
    loopOut = lo;
    loopManual = true;
    rollActive = true;
    rollVirtual = t;
    rollIn = li;
    rollOut = lo;
    audioMain.currentTime = li;
    $("dj-roll-status").textContent =
      "Roll: " + nb + " beats — slip timeline active";
    cancelAnimationFrame(rollRaf);
    var last = performance.now();
    function tick() {
      if (!rollActive) return;
      var now = performance.now();
      var dt = (now - last) / 1000;
      last = now;
      rollVirtual += dt;
      if (audioMain.currentTime >= rollOut - 0.02) {
        audioMain.currentTime = rollIn;
      }
      rollRaf = requestAnimationFrame(tick);
    }
    rollRaf = requestAnimationFrame(tick);
    setStatus("Roll on");
  }

  function rollStopInternal() {
    rollActive = false;
    cancelAnimationFrame(rollRaf);
    $("dj-roll-status").textContent = "";
  }

  function rollOff() {
    if (!rollActive) {
      rollStopInternal();
      return;
    }
    var dur = audioMain.duration;
    var jump = Math.min(Math.max(0, rollVirtual), isFinite(dur) ? dur : rollVirtual);
    rollStopInternal();
    loopManual = false;
    loopIn = loopOut = null;
    audioMain.currentTime = jump;
    $("lp-status").textContent = "No loop set";
    setStatus("Roll off → " + fmtTime(jump));
  }

  function onTimeUpdate() {
    var t = audioMain.currentTime;
    var d = audioMain.duration;
    if (isFinite(d) && d > 0) {
      var sk = $("seek");
      if (sk && !seekSeeking) sk.value = String(Math.floor((t / d) * 1000));
      $("time-cur").textContent = fmtTime(t);
    }
    if (loopManual && loopOut != null && t >= loopOut - 0.01 && !rollActive) {
      audioMain.currentTime = loopIn;
    }
    updateLyricsHighlight(t);
    crossfadeTick();
  }

  /** Next row for crossfade — matches V3 _peek_next_row (no wrap when Repeat One). */
  function peekNextRowForCrossfade() {
    var n = playlist.length;
    if (n < 2 || currentIndex < 0) return null;
    if (repeatMode === 2) return null;
    if (repeatMode === 1) return (currentIndex + 1) % n;
    if (currentIndex + 1 >= n) return null;
    return currentIndex + 1;
  }

  function crossfadeTick() {
    if (xfRunning || xfCooldown || !graphOk) return;
    var en = $("xf-enable");
    if (!en || !en.checked) return;
    var nextI = peekNextRowForCrossfade();
    if (nextI == null || nextI === currentIndex) return;
    var xs = $("xf-sec");
    var xfSec = xs ? parseFloat(xs.value) || 8 : 8;
    var dur = audioMain.duration;
    if (!isFinite(dur) || dur <= xfSec + 0.5) return;
    var rem = dur - audioMain.currentTime;
    if (!isFinite(rem) || rem > xfSec || rem <= 0) return;
    xfCooldown = true;
    startCrossfade(xfSec, nextI);
  }

  function startCrossfade(xfSec, nextI) {
    if (xfRunning || currentIndex < 0 || nextI == null || nextI < 0 || nextI >= playlist.length) return;
    if (nextI === currentIndex) return;
    xfRunning = true;
    ensureGraph();
    audioNext.src = playlist[nextI].url;
    audioNext.volume = 1;
    var eqPow = $("xf-eqpow") && $("xf-eqpow").checked;
    function runRamp() {
      var t0 = performance.now();
      var rampMs = xfSec * 1000;
      function step() {
        if (!xfRunning) return;
        var p = (performance.now() - t0) / rampMs;
        if (p >= 1) {
          finishCrossfade(nextI);
          return;
        }
        var a = eqPow ? Math.cos((p * Math.PI) / 2) : 1 - p;
        var b = eqPow ? Math.sin((p * Math.PI) / 2) : p;
        gainMain.gain.value = masterLinear * a;
        gainNext.gain.value = masterLinear * b;
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }
    audioNext.addEventListener(
      "canplay",
      function () {
        audioNext
          .play()
          .then(function () {
            tryPlayJingleOnCrossfade();
            runRamp();
          })
          .catch(function () {
            xfRunning = false;
            xfCooldown = false;
            setStatus("Crossfade: next track failed");
          });
      },
      { once: true }
    );
    audioNext.load();
  }

  function finishCrossfade(nextIdx) {
    xfRunning = false;
    xfCooldown = false;
    gainNext.gain.value = 0;
    gainMain.gain.value = masterLinear;
    var tNext = audioNext.currentTime || 0;
    audioNext.pause();
    audioMain.pause();
    currentIndex = nextIdx;
    var item = playlist[currentIndex];
    audioMain.src = item.url;
    audioMain.onloadedmetadata = function () {
      audioMain.currentTime = Math.min(tNext, audioMain.duration || tNext);
      clearLyricsDisplay();
      loadMetaFor(item);
      renderPl();
      onAudioLoadedMetadataForUi(item);
      audioMain.play();
    };
    setStatus("Crossfaded → track " + (nextIdx + 1));
  }

  /** Strip BOM / nulls often seen in ID3 USLT UTF-16 round-trips */
  function normalizeEmbeddedLyricsText(text) {
    var s = String(text || "")
      .replace(/^\uFEFF/, "")
      .replace(/\u0000/g, "");
    return s;
  }

  /** Some taggers use fullwidth brackets / colons in embedded LRC */
  function normalizeLrcBrackets(text) {
    return String(text || "")
      .replace(/\uFF3B/g, "[")
      .replace(/\uFF3D/g, "]")
      .replace(/\uFF1A/g, ":");
  }

  function fracFromSubsecond(raw) {
    if (!raw) return 0;
    var n = parseInt(raw, 10);
    if (!isFinite(n)) return 0;
    return raw.length >= 3 ? n / 1000 : n / 100;
  }

  /**
   * Line-oriented LRC (same line shapes as SAMSEL V3 PRO, plus three-part wall times):
   * - [mm:ss.xx] or [m:ss.xx]
   * - [hh:mm:ss] or [hh:mm:ss.xx] — hours : minutes : seconds (first field may be 0)
   * Whitespace allowed inside brackets. Fullwidth ［］： normalized first.
   */
  function parseLRC(text) {
    var lines = [];
    var body = normalizeLrcBrackets(normalizeEmbeddedLyricsText(text));
    var rawLines = body.split(/\r?\n/);
    var reThree = /^\[\s*(\d+)\s*:\s*(\d+)\s*:\s*(\d+)\s*(?:\.\s*(\d+))?\s*\]\s*(.*)$/;
    var reTwo = /^\[\s*(\d+)\s*:\s*(\d+)\s*(?:\.\s*(\d+))?\s*\]\s*(.*)$/;

    rawLines.forEach(function (line) {
      line = line.trim();
      if (!line) return;

      var m3 = line.match(reThree);
      if (m3) {
        var h = parseInt(m3[1], 10),
          mm = parseInt(m3[2], 10),
          ss = parseInt(m3[3], 10),
          fr = m3[4],
          rest = (m3[5] || "").trim();
        var t = h * 3600 + mm * 60 + ss + fracFromSubsecond(fr);
        lines.push({ t: t, text: rest });
        return;
      }

      var m2 = line.match(reTwo);
      if (m2) {
        var min = parseInt(m2[1], 10),
          sec = parseInt(m2[2], 10),
          f2 = m2[3],
          rest2 = (m2[4] || "").trim();
        var t2 = min * 60 + sec + fracFromSubsecond(f2);
        lines.push({ t: t2, text: rest2 });
      }
    });

    lines.sort(function (a, b) {
      return a.t - b.t;
    });
    return lines;
  }

  function spreadPlainLyrics(text, durationSec) {
    var lines = text
      .split(/\r?\n/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
    if (!lines.length || !isFinite(durationSec) || durationSec <= 0) return [];
    var step = durationSec / lines.length;
    return lines.map(function (line, i) {
      return { t: i * step, text: line };
    });
  }

  function tagValueToString(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object") {
      if (typeof v.data === "string") return v.data;
      if (v.data != null && typeof v.data === "object") {
        if (typeof v.data.text === "string") return v.data.text;
        if (typeof v.data.lyrics === "string") return v.data.lyrics;
      }
      if (typeof v.text === "string") return v.text;
    }
    return "";
  }

  /** Normalize jsmediatags / raw ID3 shapes into flat strings where possible. */
  function normalizeJsMediaTagsForMerge(tags) {
    if (!tags) return {};
    var o = {};
    if (tags.title) o.title = tagValueToString(tags.title);
    if (tags.artist) o.artist = tagValueToString(tags.artist);
    if (tags.album) o.album = tagValueToString(tags.album);
    if (tags.TIT2 && !o.title) o.title = tagValueToString(tags.TIT2);
    if (tags.TPE1 && !o.artist) o.artist = tagValueToString(tags.TPE1);
    if (tags.TALB && !o.album) o.album = tagValueToString(tags.TALB);
    if (tags.TPE2) o.albumartist = tagValueToString(tags.TPE2);
    if (tags.TYER || tags.TDRC) o.year = tagValueToString(tags.TYER || tags.TDRC);
    if (tags.TRCK) o.track = tagValueToString(tags.TRCK);
    if (tags.TCON) o.genre = tagValueToString(tags.TCON);
    if (tags.TBPM) o.bpm = tagValueToString(tags.TBPM);
    return o;
  }

  function fillEmptyTagFields(target, filler) {
    if (!filler) return;
    for (var k in filler) {
      if (!Object.prototype.hasOwnProperty.call(filler, k)) continue;
      if (k.indexOf("_") === 0) continue;
      var v = filler[k];
      if (v == null || v === "") continue;
      if (target[k] == null || target[k] === "") target[k] = v;
    }
  }

  function mapMusicMetadataToFlat(meta) {
    var c = meta.common || {};
    var tags = {};
    if (c.title) tags.title = String(c.title);
    if (c.artist) {
      tags.artist = Array.isArray(c.artist) ? c.artist.join(", ") : String(c.artist);
    }
    if (c.album) tags.album = String(c.album);
    if (c.albumartist) {
      tags.albumartist = Array.isArray(c.albumartist) ? c.albumartist.join(", ") : String(c.albumartist);
    }
    if (c.year != null) tags.year = c.year;
    if (c.track != null) {
      tags.track = typeof c.track === "object" && c.track.no != null ? c.track.no : c.track;
    }
    if (c.genre && c.genre.length) tags.genre = c.genre.join(", ");
    if (c.bpm != null) {
      tags.bpm = c.bpm;
      tags.TBPM = { data: c.bpm };
    }
    if (c.lyrics && c.lyrics.length) {
      var lp = c.lyrics
        .map(function (L) {
          return L && L.text;
        })
        .filter(Boolean);
      if (lp.length) tags.lyrics = lp.join("\n");
    }
    if (c.comment && c.comment.length) {
      tags.comment = c.comment
        .map(function (x) {
          return x.text;
        })
        .filter(Boolean)
        .join("\n");
    }
    return tags;
  }

  function fromUsltFrame(fr) {
    if (!fr) return "";
    var u = fr.data != null ? fr.data : fr;
    if (typeof u === "string") return u;
    if (u && typeof u.lyrics === "string") return u.lyrics;
    if (u && typeof u.text === "string") return u.text;
    if (typeof fr.lyrics === "string") return fr.lyrics;
    if (typeof fr.text === "string") return fr.text;
    return "";
  }

  /** ID3 USLT / MP4 ©lyr / Vorbis LYRICS / music-metadata.common.lyrics */
  function extractEmbeddedLyricsFromObject(tags) {
    if (!tags) return "";
    var ly = tags.lyrics;
    if (ly) {
      if (typeof ly === "string") return ly;
      if (ly.lyrics) return ly.lyrics;
    }
    var cylr = tags["©lyr"] || tags["\xa9lyr"];
    if (cylr) {
      var cd = cylr.data != null ? cylr.data : cylr;
      if (typeof cd === "string") return cd;
    }
    if (tags.unsynchronisedlyrics) {
      var uu = tags.unsynchronisedlyrics;
      if (typeof uu === "string") return uu;
      if (uu && typeof uu.data === "string") return uu.data;
    }
    if (tags.USLT) {
      var us = tags.USLT;
      if (Array.isArray(us)) {
        var acc = [];
        for (var ui = 0; ui < us.length; ui++) {
          var s = fromUsltFrame(us[ui]);
          if (s) acc.push(s);
        }
        if (acc.length) return acc.join("\n");
      } else {
        var one = fromUsltFrame(us);
        if (one) return one;
      }
    }
    if (tags.ULT) {
      var v = tags.ULT.data != null ? tags.ULT.data : tags.ULT;
      if (typeof v === "string") return v;
      if (v && v.lyrics) return v.lyrics;
    }
    if (tags.uslt && tags.uslt.data && tags.uslt.data.lyrics) return tags.uslt.data.lyrics;
    for (var k in tags) {
      if (!Object.prototype.hasOwnProperty.call(tags, k)) continue;
      var v2 = tags[k];
      var cand = null;
      if (typeof v2 === "string") cand = v2;
      else if (v2 && typeof v2.data === "string") cand = v2.data;
      else if (v2 && v2.data && typeof v2.data.lyrics === "string") cand = v2.data.lyrics;
      else if (v2 && typeof v2.lyrics === "string") cand = v2.lyrics;
      else if (v2 && typeof v2.text === "string") cand = v2.text;
      if (cand && cand.length > 8) {
        if (/\[\s*\d+\s*:\s*\d+\s*:\s*\d+/.test(cand)) return cand;
        if (/\[\s*\d+\s*:\s*\d+(?:\.\d+)?\]/.test(cand)) return cand;
      }
    }
    return "";
  }

  function extractEmbeddedLyricsRaw(mergedTags, rawJsMediaTags) {
    var a = extractEmbeddedLyricsFromObject(mergedTags);
    if (a && String(a).trim()) return a;
    if (rawJsMediaTags) {
      var b = extractEmbeddedLyricsFromObject(rawJsMediaTags);
      if (b && String(b).trim()) return b;
    }
    return "";
  }

  /**
   * music-metadata (primary) + jsmediatags (fill gaps, raw USLT).
   * @returns {{ tags: Object, rawJm: Object|null, format: Object|null, note: string }}
   */
  async function readAudioTagsCombined(file) {
    var merged = {};
    var rawJm = null;
    var format = null;
    var note = "";

    try {
      var mmMod = await import(/* @vite-ignore */ MUSIC_METADATA_IMPORT);
      var parseBlob = mmMod.parseBlob;
      if (typeof parseBlob === "function") {
        var meta = await parseBlob(file, { duration: false, skipCovers: true });
        format = meta.format || null;
        Object.assign(merged, mapMusicMetadataToFlat(meta));
      }
    } catch (e) {
      note = (e && e.message) || String(e);
    }

    if (typeof jsmediatags !== "undefined") {
      await new Promise(function (resolve) {
        jsmediatags.read(file, {
          onSuccess: function (tag) {
            rawJm = tag.tags || {};
            fillEmptyTagFields(merged, normalizeJsMediaTagsForMerge(rawJm));
            resolve();
          },
          onError: function () {
            resolve();
          },
        });
      });
    }

    return { tags: merged, rawJm: rawJm, format: format, note: note };
  }

  /** Matches desktop sort: unknown / invalid BPM sorts last. */
  var UNKNOWN_BPM_SORT = 10000;

  function parseBpmScalar(v) {
    if (v == null) return null;
    if (typeof v === "number" && isFinite(v)) {
      if (v >= 40 && v <= 300) return v;
      return null;
    }
    var s = String(v).trim();
    var m = s.match(/(\d+(?:\.\d+)?)/);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n) || n < 40 || n > 300) return null;
    return n;
  }

  /**
   * BPM from merged tags (TBPM / bpm / common field names). Invalid or missing → null.
   */
  function extractBpmFromTags(tags) {
    if (!tags) return null;
    var tbpm = tags.TBPM;
    if (tbpm && typeof tbpm === "object" && tbpm.data != null) {
      var p0 = parseBpmScalar(tbpm.data);
      if (p0 != null) return p0;
    }
    var p1 = parseBpmScalar(tags.bpm);
    if (p1 != null) return p1;
    var p2 = parseBpmScalar(tags.BPM);
    if (p2 != null) return p2;
    return null;
  }

  function applyPlaylistReorder(newOrder) {
    var cur = currentIndex >= 0 ? playlist[currentIndex] : null;
    playlist = newOrder;
    if (cur) {
      var ni = playlist.indexOf(cur);
      currentIndex = ni >= 0 ? ni : -1;
    }
    renderPl();
  }

  /** Stable ascending by tag BPM; missing/invalid → last (same as SAMSEL V3 PRO tag-only path). */
  function sortPlaylistByTagBpmOnly() {
    if (playlist.length < 2) return;
    var wrapped = playlist.map(function (e, i) {
      var k = extractBpmFromTags(e._lastTags);
      if (k == null || !isFinite(k)) k = UNKNOWN_BPM_SORT;
      return { e: e, i: i, k: k };
    });
    wrapped.sort(function (a, b) {
      if (a.k !== b.k) return a.k - b.k;
      return a.i - b.i;
    });
    applyPlaylistReorder(
      wrapped.map(function (w) {
        return w.e;
      })
    );
  }

  async function ensureTagsForPlaylistEntries() {
    for (var i = 0; i < playlist.length; i++) {
      var e = playlist[i];
      if (e._lastTags) continue;
      try {
        var r = await readAudioTagsCombined(e.file);
        e._lastTags = r.tags;
        e._rawJmTags = r.rawJm;
      } catch (x) {}
    }
  }

  async function sortPlaylistAfterAddAutoBpm() {
    await ensureTagsForPlaylistEntries();
    sortPlaylistByTagBpmOnly();
  }

  /**
   * Rough BPM from first ~45s: onset-strength autocorr (browser; not librosa).
   * @returns {number|null} BPM in 40–300 or null
   */
  async function estimateBpmFromAudioFile(file) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !file) return null;
    var ab;
    try {
      ab = await file.arrayBuffer();
    } catch (e) {
      return null;
    }
    var ac = new AC();
    var buf;
    try {
      buf = await ac.decodeAudioData(ab.slice(0));
    } catch (e) {
      try {
        await ac.close();
      } catch (x) {}
      return null;
    }
    try {
      await ac.close();
    } catch (x) {}
    var sr = buf.sampleRate;
    var maxSamples = Math.min(buf.length, Math.floor(45 * sr));
    var ch = buf.numberOfChannels;
    var d0 = buf.getChannelData(0);
    var d1 = ch > 1 ? buf.getChannelData(1) : null;
    var hop = 512;
    var nFrames = Math.floor(maxSamples / hop);
    if (nFrames < 96) return null;
    var env = new Float32Array(nFrames);
    var fi = 0;
    for (var base = 0; base + hop <= maxSamples && fi < nFrames; base += hop, fi++) {
      var sum = 0;
      for (var s = 0; s < hop; s++) {
        var v = d0[base + s];
        if (d1) v = (v + d1[base + s]) * 0.5;
        sum += v * v;
      }
      env[fi] = Math.sqrt(sum / hop);
    }
    var onset = new Float32Array(nFrames);
    onset[0] = 0;
    for (var i = 1; i < nFrames; i++) {
      var df = env[i] - env[i - 1];
      onset[i] = df > 0 ? df : 0;
    }
    var mean = 0;
    for (var j = 0; j < nFrames; j++) mean += onset[j];
    mean /= nFrames;
    for (var j = 0; j < nFrames; j++) onset[j] -= mean;
    var minBpm = 40;
    var maxBpm = 300;
    var minLag = Math.max(2, Math.floor((60 / maxBpm) * (sr / hop)));
    var maxLag = Math.min(nFrames - 2, Math.ceil((60 / minBpm) * (sr / hop)));
    if (maxLag <= minLag) return null;
    var bestLag = minLag;
    var bestCorr = -Infinity;
    for (var lag = minLag; lag <= maxLag; lag++) {
      var c = 0;
      for (var k = 0; k < nFrames - lag; k++) c += onset[k] * onset[k + lag];
      if (c > bestCorr) {
        bestCorr = c;
        bestLag = lag;
      }
    }
    var bpm = (60 * (sr / hop)) / bestLag;
    if (!isFinite(bpm)) return null;
    while (bpm < 72 && bpm * 2 <= maxBpm) bpm *= 2;
    while (bpm > 185 && bpm / 2 >= minBpm) bpm /= 2;
    if (bpm < minBpm || bpm > maxBpm) return null;
    return Math.round(bpm * 10) / 10;
  }

  /** Full sort: tag BPM first, then short audio estimate; unknowns last (desktop parity). */
  async function sortPlaylistBpmAutoFull() {
    if (!playlist.length) return;
    var n = playlist.length;
    var keys = new Array(n);
    for (var i = 0; i < n; i++) {
      var entry = playlist[i];
      setStatus("BPM sort: " + (i + 1) + " / " + n + " — " + entry.name);
      var tagB = extractBpmFromTags(entry._lastTags);
      if (tagB == null && entry.file) {
        try {
          var r = await readAudioTagsCombined(entry.file);
          entry._lastTags = r.tags;
          entry._rawJmTags = r.rawJm;
          tagB = extractBpmFromTags(r.tags);
        } catch (x) {}
      }
      var k;
      if (tagB != null && isFinite(tagB)) {
        k = tagB;
      } else if (entry.file) {
        var est = await estimateBpmFromAudioFile(entry.file);
        k = est != null && isFinite(est) ? est : UNKNOWN_BPM_SORT;
      } else {
        k = UNKNOWN_BPM_SORT;
      }
      keys[i] = k;
    }
    var wrapped = playlist.map(function (e, idx) {
      return { e: e, i: idx, k: keys[idx] };
    });
    wrapped.sort(function (a, b) {
      if (a.k !== b.k) return a.k - b.k;
      return a.i - b.i;
    });
    applyPlaylistReorder(
      wrapped.map(function (w) {
        return w.e;
      })
    );
    setStatus("Playlist sorted by BPM (slow → fast)");
  }

  /** @param item If set, ignore result if playlist selection changed (async tag read). */
  function applyLyricsFromRaw(raw, durationSec, item) {
    if (!raw || !String(raw).trim()) {
      lyricsParsed = [];
      renderLyricsStatic();
      return;
    }
    var text = normalizeEmbeddedLyricsText(raw);
    var parsed = parseLRC(text);
    if (parsed.length > 0) {
      if (!item || playlist[currentIndex] === item) {
        lyricsParsed = parsed;
        renderLyricsStatic();
      }
      return;
    }
    if (!text.trim()) {
      lyricsParsed = [];
      renderLyricsStatic();
      return;
    }
    function spreadAt(dur) {
      if (item && playlist[currentIndex] !== item) return;
      lyricsParsed = spreadPlainLyrics(text, dur);
      renderLyricsStatic();
    }
    var dur = durationSec;
    if (isFinite(dur) && dur > 0) {
      spreadAt(dur);
      return;
    }
    if (isFinite(audioMain.duration) && audioMain.duration > 0) {
      spreadAt(audioMain.duration);
      return;
    }
    var spreadDone = false;
    function trySpreadFromAudio() {
      if (spreadDone) return;
      if (item && playlist[currentIndex] !== item) return;
      var d = audioMain.duration;
      if (!isFinite(d) || d <= 0) return;
      spreadDone = true;
      spreadAt(d);
    }
    function onceMeta() {
      audioMain.removeEventListener("loadedmetadata", onceMeta);
      trySpreadFromAudio();
    }
    audioMain.addEventListener("loadedmetadata", onceMeta, false);
    /* loadedmetadata may have already fired before this listener was added */
    if (audioMain.readyState >= 1) {
      setTimeout(trySpreadFromAudio, 0);
    }
  }

  /**
   * Same-folder / same-selection .lrc wins over embedded tags when both exist
   * (explicit pairing). Embedded is used only when there is no sidecar text yet.
   */
  function tryAutoloadLyricsForTrack(item, tags) {
    if (!$("ly-autoload") || !$("ly-autoload").checked) return;
    if (!item || playlist[currentIndex] !== item) return;
    if (item.lrcText && String(item.lrcText).trim()) {
      applyLyricsFromRaw(item.lrcText, audioMain.duration, item);
      return;
    }
    if (item._lrcLoading) return;
    if (tags || item._lastTags) {
      var emb = extractEmbeddedLyricsRaw(tags || item._lastTags, item._rawJmTags);
      if (emb && emb.trim()) {
        applyLyricsFromRaw(emb, audioMain.duration, item);
      }
    }
  }

  /** Called when a paired .lrc file has finished reading — always apply if this track is current. */
  function applySidecarLrcWhenReady(entry) {
    if (playlist[currentIndex] !== entry) return;
    if (!$("ly-autoload") || !$("ly-autoload").checked) return;
    if (!entry.lrcText || !String(entry.lrcText).trim()) return;
    applyLyricsFromRaw(entry.lrcText, audioMain.duration, entry);
  }

  function clearLyricsDisplay() {
    lyricsParsed = [];
    renderLyricsStatic();
  }

  function setLyricsFromText(text) {
    applyLyricsFromRaw(text, audioMain.duration, null);
  }

  function renderLyricsStatic() {
    document.querySelectorAll("[data-lyrics-out]").forEach(function (d) {
      d.innerHTML = "";
      lyricsParsed.forEach(function (ln, i) {
        var p = document.createElement("p");
        p.className = "ly-line";
        p.dataset.idx = String(i);
        p.textContent = ln.text;
        d.appendChild(p);
      });
    });
  }

  function updateLyricsHighlight(t) {
    var off = (lyricsOffsetMs || 0) / 1000;
    var tt = t + off;
    var idx = -1;
    for (var i = 0; i < lyricsParsed.length; i++) {
      if (lyricsParsed[i].t <= tt) idx = i;
    }
    document.querySelectorAll("[data-lyrics-out]").forEach(function (root) {
      root.querySelectorAll(".ly-line").forEach(function (el, j) {
        el.classList.toggle("ly-cur", j === idx);
      });
      if (idx >= 0) {
        var cur = root.querySelector('.ly-line[data-idx="' + idx + '"]');
        if (cur) {
          cur.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      }
    });
  }

  function encodeWavInterleaved(float32Interleaved, numChannels, sampleRate) {
    var n = float32Interleaved.length;
    var buf = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buf);
    function wStr(off, s) {
      for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    }
    wStr(0, "RIFF");
    v.setUint32(4, 36 + n * 2, true);
    wStr(8, "WAVE");
    wStr(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, numChannels, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * numChannels * 2, true);
    v.setUint16(32, numChannels * 2, true);
    v.setUint16(34, 16, true);
    wStr(36, "data");
    v.setUint32(40, n * 2, true);
    var o = 44;
    for (var i = 0; i < n; i++) {
      var s = Math.max(-1, Math.min(1, float32Interleaved[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
    return buf;
  }

  function interleave(buf) {
    var ch = buf.numberOfChannels;
    var L = buf.length;
    var out = new Float32Array(L * ch);
    for (var c = 0; c < ch; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < L; i++) out[i * ch + c] = d[i];
    }
    return out;
  }

  function floatToInt16Channel(f32) {
    var n = f32.length;
    var b = new Int16Array(n);
    for (var i = 0; i < n; i++) {
      var s = Math.max(-1, Math.min(1, f32[i]));
      b[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return b;
  }

  function concatInt8Mp3Chunks(chunks) {
    var t = 0;
    var i, j, c;
    for (i = 0; i < chunks.length; i++) {
      c = chunks[i];
      if (c && c.length) t += c.length;
    }
    var u = new Uint8Array(t);
    var o = 0;
    for (j = 0; j < chunks.length; j++) {
      c = chunks[j];
      if (!c || !c.length) continue;
      u.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), o);
      o += c.length;
    }
    return u.buffer;
  }

  /** lamejs (global): MPEG-1 Layer III, constant bitrate. */
  function encodeAudioBufferToMp3(audioBuf, kbps) {
    if (typeof lamejs === "undefined" || !lamejs.Mp3Encoder) return null;
    var ch = audioBuf.numberOfChannels;
    var sr = audioBuf.sampleRate | 0;
    var n = audioBuf.length;
    if (n === 0) return new ArrayBuffer(0);
    var bitrate = kbps || 192;
    var enc = new lamejs.Mp3Encoder(ch, sr, bitrate);
    var left = floatToInt16Channel(audioBuf.getChannelData(0));
    var right = ch > 1 ? floatToInt16Channel(audioBuf.getChannelData(1)) : left;
    var block = 1152;
    var chunks = [];
    var i, lb, rb, mp3buf;
    for (i = 0; i < n; i += block) {
      lb = left.subarray(i, Math.min(i + block, n));
      rb = right.subarray(i, Math.min(i + block, n));
      mp3buf = enc.encodeBuffer(lb, rb);
      if (mp3buf && mp3buf.length > 0) chunks.push(mp3buf);
    }
    mp3buf = enc.flush();
    if (mp3buf && mp3buf.length > 0) chunks.push(mp3buf);
    return concatInt8Mp3Chunks(chunks);
  }

  function trimMp3Kbps() {
    var el = $("trim-mp3-kbps");
    var v = el ? parseInt(el.value, 10) : 192;
    if (!isFinite(v) || v < 64) v = 192;
    return v;
  }

  /** Prefer MP3; fall back to 16-bit WAV if lamejs missing or encode fails. */
  function exportTrimmedAudio(audioBuf) {
    var kbps = trimMp3Kbps();
    try {
      var mp3 = encodeAudioBufferToMp3(audioBuf, kbps);
      if (mp3 && mp3.byteLength > 0) {
        return { data: mp3, ext: "mp3", mime: "audio/mpeg", fallback: false };
      }
    } catch (err) {
      console.warn("MP3 encode failed:", err);
    }
    var inter = interleave(audioBuf);
    var wav = encodeWavInterleaved(inter, audioBuf.numberOfChannels, audioBuf.sampleRate);
    return { data: wav, ext: "wav", mime: "audio/wav", fallback: true };
  }

  function monoMean(audioBuf) {
    var ch = audioBuf.numberOfChannels;
    var n = audioBuf.length;
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var s = 0;
      for (var c = 0; c < ch; c++) s += audioBuf.getChannelData(c)[i];
      out[i] = s / ch;
    }
    return out;
  }

  function makeHann(L) {
    var w = new Float32Array(L);
    if (L <= 1) {
      w[0] = 1;
      return w;
    }
    for (var i = 0; i < L; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (L - 1)));
    }
    return w;
  }

  /** In-place radix-2 FFT; re/im length power of 2 (forward transform). */
  function cfft(re, im) {
    var n = re.length;
    var i = 0,
      j = 0,
      k = 0,
      len = 0,
      u1 = 0,
      u2 = 0,
      t1 = 0,
      t2 = 0,
      wr = 0,
      wi = 0,
      ang = 0,
      wlenr = 0,
      wleni = 0,
      twr = 0;
    j = 0;
    for (i = 0; i < n - 1; i++) {
      if (i < j) {
        t1 = re[i];
        re[i] = re[j];
        re[j] = t1;
        t1 = im[i];
        im[i] = im[j];
        im[j] = t1;
      }
      k = n >> 1;
      while (k <= j) {
        j -= k;
        k >>= 1;
      }
      j += k;
    }
    len = 2;
    while (len <= n) {
      ang = (-2 * Math.PI) / len;
      wlenr = Math.cos(ang);
      wleni = Math.sin(ang);
      for (i = 0; i < n; i += len) {
        wr = 1;
        wi = 0;
        for (k = 0; k < len / 2; k++) {
          u1 = i + k;
          u2 = i + k + len / 2;
          t1 = wr * re[u2] - wi * im[u2];
          t2 = wr * im[u2] + wi * re[u2];
          re[u2] = re[u1] - t1;
          im[u2] = im[u1] - t2;
          re[u1] += t1;
          im[u1] += t2;
          twr = wr * wlenr - wi * wleni;
          wi = wr * wleni + wi * wlenr;
          wr = twr;
        }
      }
      len <<= 1;
    }
  }

  /**
   * Matches SAMSEL V3 PRO SilenceTrimmer._find_silence_boundaries:
   * librosa.stft with center=True (zero pad n_fft/2 each side), Hann window,
   * energy = sqrt(sum |S|^2) per frame, normalize by peak, threshold 10^(dB/20).
   */
  function findSilenceBoundariesStftLibrosa(mono, thDb, nFft, hop) {
    var origN = mono.length;
    var th = Math.pow(10, thDb / 20);
    var frameLen = Math.max(256, nFft);
    var hopLen = Math.max(64, hop);
    if (hopLen >= frameLen) hopLen = Math.floor(frameLen / 4);

    if (origN === 0) {
      return { start: 0, endExclusive: 0 };
    }

    var pad = frameLen >> 1;
    var nPad = origN + 2 * pad;
    var yPad = new Float32Array(nPad);
    yPad.set(mono, pad);

    var hann = makeHann(frameLen);
    var numFrames = 1 + Math.floor((nPad - frameLen) / hopLen);
    if (numFrames < 1) numFrames = 1;

    var re = new Float32Array(frameLen);
    var im = new Float32Array(frameLen);
    var energies = new Float32Array(numFrames);
    var k, i, start, j, sum, maxE, half;

    for (k = 0; k < numFrames; k++) {
      start = k * hopLen;
      for (i = 0; i < frameLen; i++) {
        re[i] = yPad[start + i] * hann[i];
        im[i] = 0;
      }
      cfft(re, im);
      half = frameLen >> 1;
      sum = 0;
      for (j = 0; j <= half; j++) {
        sum += re[j] * re[j] + im[j] * im[j];
      }
      energies[k] = Math.sqrt(sum);
    }
    maxE = 0;
    for (k = 0; k < numFrames; k++) if (energies[k] > maxE) maxE = energies[k];
    var denom = maxE + 1e-10;
    for (k = 0; k < numFrames; k++) energies[k] /= denom;

    var loud = [];
    for (k = 0; k < numFrames; k++) if (energies[k] > th) loud.push(k);
    if (loud.length === 0) {
      return { start: 0, endExclusive: origN };
    }
    var first = loud[0];
    var last = loud[loud.length - 1];
    var startIdx = Math.max(0, first * hopLen - hopLen);
    var endExclusive = Math.min(origN, (last + 1) * hopLen + hopLen);
    return { start: startIdx, endExclusive: endExclusive };
  }

  /** Same as original samsel runTrim / desktop web-style: channel 0, |x| &gt; th, symmetric pad in ms. */
  function trimSampleLinearBounds(audioBuf, thLinear, padMs) {
    var data = audioBuf.getChannelData(0);
    var sr = audioBuf.sampleRate;
    var pad = (parseInt(padMs, 10) || 0) / 1000;
    var padSamples = Math.floor(pad * sr);
    var n = data.length;
    var i,
      st = 0,
      en = n - 1;
    for (i = 0; i < n; i++) {
      if (Math.abs(data[i]) > thLinear) {
        st = Math.max(0, i - padSamples);
        break;
      }
    }
    for (i = n - 1; i >= 0; i--) {
      if (Math.abs(data[i]) > thLinear) {
        en = Math.min(n - 1, i + padSamples);
        break;
      }
    }
    if (en <= st) return { error: "Nothing to trim." };
    return { startS: st, endExcl: en + 1 };
  }

  function trimProcessAudioBuffer(audioBuf, ac) {
    var mode = $("trim-method").value;
    var sr = audioBuf.sampleRate;
    var n = audioBuf.length;
    var startS = 0;
    var endExcl = n;
    if (mode === "fixed") {
      var fs = parseFloat($("trim-fixed-start").value) || 0;
      var fe = parseFloat($("trim-fixed-end").value) || 0;
      var si = Math.floor(fs * sr);
      var ei = n - Math.floor(fe * sr);
      if (si < 0) si = 0;
      if (ei > n) ei = n;
      startS = si;
      endExcl = ei;
    } else {
      var thDb = parseFloat($("trim-threshold-db").value);
      if (!isFinite(thDb)) thDb = -40;
      var frameLen = parseInt($("trim-frame").value, 10) || 2048;
      var hop = parseInt($("trim-hop").value, 10) || 512;
      var mono = monoMean(audioBuf);
      var bounds = findSilenceBoundariesStftLibrosa(mono, thDb, frameLen, hop);
      var ps = Math.floor((parseInt($("trim-pad-start").value, 10) || 0) * sr / 1000);
      var pe = Math.floor((parseInt($("trim-pad-end").value, 10) || 0) * sr / 1000);
      startS = Math.max(0, bounds.start - ps);
      endExcl = Math.min(n, bounds.endExclusive + pe);
    }
    if (startS >= endExcl) {
      return { error: "Invalid trim: no audio left (adjust settings or fixed seconds)." };
    }
    var len = endExcl - startS;
    var out = ac.createBuffer(audioBuf.numberOfChannels, len, sr);
    for (var c = 0; c < audioBuf.numberOfChannels; c++) {
      out.copyToChannel(audioBuf.getChannelData(c).subarray(startS, endExcl), c, 0);
    }
    var removedSec = startS / sr + (n - endExcl) / sr;
    return { audioBuf: out, removedSec: removedSec };
  }

  function trimLogAppend(line) {
    var el = $("trim-log");
    if (!el) return;
    if (el.textContent.length > 12000) el.textContent = "";
    el.textContent += line + "\n";
    el.scrollTop = el.scrollHeight;
  }

  function renderTrimFileList() {
    var ul = $("trim-file-list");
    if (!ul) return;
    ul.innerHTML = "";
    trimFileQueue.forEach(function (entry, idx) {
      var li = document.createElement("li");
      li.className = idx === trimSelectedIndex ? "active" : "";
      var main = document.createElement("div");
      main.className = "pl-main";
      var sp = document.createElement("span");
      sp.className = "pl-name";
      sp.textContent = entry.name;
      main.appendChild(sp);
      li.appendChild(main);
      li.onclick = function () {
        trimSelectedIndex = idx;
        renderTrimFileList();
      };
      ul.appendChild(li);
    });
  }

  function updateTrimMethodVisibility() {
    var autoB = $("trim-auto-block");
    var fixB = $("trim-fixed-block");
    var fixed = $("trim-method") && $("trim-method").value === "fixed";
    if (autoB) autoB.hidden = fixed;
    if (fixB) fixB.hidden = !fixed;
  }

  function updateTrimThresholdDbLabel() {
    var el = $("trim-threshold-db-lbl");
    var inp = $("trim-threshold-db");
    if (!el || !inp) return;
    var val = parseInt(inp.value, 10);
    if (!isFinite(val)) val = -40;
    var label;
    if (val === -40) label = "\u221240dB (Normal)";
    else if (val < -40) label = val + "dB (Aggressive)";
    else if (val <= -10) label = val + "dB (Conservative)";
    else if (val <= 0) label = val + "dB (Very conservative)";
    else label = "+" + val + "dB (minimal trim)";
    el.textContent = label;
  }

  async function trimWebExportPlaylist() {
    var msg = $("trim-web-msg");
    if (currentIndex < 0 || !playlist.length) {
      if (msg) msg.textContent = "Select a track in the playlist.";
      return;
    }
    var item = playlist[currentIndex];
    if (!item || !item.file) {
      if (msg) msg.textContent = "No file on this playlist row.";
      return;
    }
    var thL = parseFloat($("trim-th-linear").value);
    if (!isFinite(thL) || thL <= 0) thL = 0.01;
    var padM = parseInt($("trim-pad-ms").value, 10);
    if (!isFinite(padM) || padM < 0) padM = 0;

    if (msg) msg.textContent = "Decoding…";

    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      if (msg) msg.textContent = "Web Audio unavailable.";
      return;
    }
    var ac = new AC();
    try {
      var ab = await item.file.arrayBuffer();
      var audioBuf = await ac.decodeAudioData(ab.slice(0));
      var lin = trimSampleLinearBounds(audioBuf, thL, padM);
      if (lin.error) {
        if (msg) msg.textContent = lin.error;
        return;
      }
      var n = audioBuf.length;
      var sr = audioBuf.sampleRate;
      var startS = lin.startS;
      var endExcl = lin.endExcl;
      var len = endExcl - startS;
      var out = ac.createBuffer(audioBuf.numberOfChannels, len, sr);
      for (var c = 0; c < audioBuf.numberOfChannels; c++) {
        out.copyToChannel(audioBuf.getChannelData(c).subarray(startS, endExcl), c, 0);
      }
      if (msg) msg.textContent = "Encoding MP3…";
      var pack = exportTrimmedAudio(out);
      var outName = item.name.replace(/\.[^.]+$/, "") + "_trimmed." + pack.ext;
      await saveTrimOutput(outName, pack.data, trimOutputDirHandle, pack.mime);
      var removed = startS / sr + (n - endExcl) / sr;
      if (msg) {
        msg.textContent =
          "Saved " +
          pack.ext.toUpperCase() +
          " (trimmed " +
          removed.toFixed(2) +
          "s from edges)" +
          (pack.fallback ? " — WAV fallback." : ".");
      }
      setStatus("Trim: " + outName);
    } catch (e) {
      if (msg) msg.textContent = String(e && e.message ? e.message : e);
    } finally {
      try {
        await ac.close();
      } catch (x) {
        /* ignore */
      }
    }
  }

  async function saveTrimOutput(filename, audioBuffer, dirHandle, mimeType) {
    var mime = mimeType || "audio/mpeg";
    if (dirHandle && dirHandle.getFileHandle) {
      try {
        var fh = await dirHandle.getFileHandle(filename, { create: true });
        var w = await fh.createWritable();
        await w.write(audioBuffer);
        await w.close();
        return;
      } catch (err) {
        trimLogAppend("⚠ Folder write failed, downloading: " + String(err && err.message ? err.message : err));
      }
    }
    var blob = new Blob([audioBuffer], { type: mime });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
    }, 2500);
  }

  async function runTrimBatch() {
    var msg = $("trim-msg");
    var prog = $("trim-progress");
    if (!trimFileQueue.length) {
      if (msg) msg.textContent = "Add files to trim first.";
      trimLogAppend("Add files to the trim queue (or use + Add files).");
      return;
    }
    var modeRun = $("trim-method").value;
    if (modeRun === "fixed") {
      var zs = parseFloat($("trim-fixed-start").value) || 0;
      var ze = parseFloat($("trim-fixed-end").value) || 0;
      if (zs <= 0 && ze <= 0) {
        if (msg) msg.textContent = "Fixed trim: set seconds to remove from start and/or end.";
        return;
      }
    }
    if (msg) msg.textContent = "Working…";
    if (prog) {
      prog.hidden = false;
      prog.value = 0;
    }
    var dirHandle = trimOutputDirHandle;
    var ac = new (window.AudioContext || window.webkitAudioContext)();
    try {
      var total = trimFileQueue.length;
      trimLogAppend("📁 Processing " + total + " file(s)…");
      if (modeRun === "fixed") {
        var zsa = parseFloat($("trim-fixed-start").value) || 0;
        var zea = parseFloat($("trim-fixed-end").value) || 0;
        trimLogAppend(
          "\u21bb Fixed trim: \u2212" + zsa.toFixed(3) + "s start, \u2212" + zea.toFixed(3) + "s end"
        );
      } else {
        var thD = parseFloat($("trim-threshold-db").value);
        if (!isFinite(thD)) thD = -40;
        var ps0 = parseInt($("trim-pad-start").value, 10) || 0;
        var pe0 = parseInt($("trim-pad-end").value, 10) || 0;
        var fr0 = parseInt($("trim-frame").value, 10) || 2048;
        var hp0 = parseInt($("trim-hop").value, 10) || 512;
        trimLogAppend(
          "\u21bb Auto: " +
            thD +
            "dB, pad " +
            ps0 +
            "/" +
            pe0 +
            " ms, frame " +
            fr0 +
            " hop " +
            hp0
        );
      }
      if (dirHandle) trimLogAppend("\ud83d\udcc2 Output: folder (File System Access)");
      else trimLogAppend("\ud83d\udcc2 Output: download per file");
      trimLogAppend("MP3 export: " + trimMp3Kbps() + " kbps (WAV if encoder unavailable)");

      for (var fi = 0; fi < total; fi++) {
        var entry = trimFileQueue[fi];
        var pct0 = Math.round((fi / total) * 100);
        trimLogAppend("\u23f3 " + entry.name + ": " + pct0 + "%");
        var ab = await entry.file.arrayBuffer();
        var audioBuf = await ac.decodeAudioData(ab.slice(0));
        var result = trimProcessAudioBuffer(audioBuf, ac);
        if (result.error) {
          trimLogAppend("\u274c " + entry.name + ": " + result.error);
        } else {
          var pack = exportTrimmedAudio(result.audioBuf);
          var outName = entry.name.replace(/\.[^.]+$/, "") + "_trimmed." + pack.ext;
          await saveTrimOutput(outName, pack.data, dirHandle, pack.mime);
          var rs = result.removedSec != null && isFinite(result.removedSec) ? result.removedSec.toFixed(2) : "?";
          var fmtNote = pack.fallback ? "WAV fallback" : "MP3";
          trimLogAppend("\u2713 Trimmed " + rs + "s | Saved: " + outName + " (" + fmtNote + ")");
        }
        if (prog) prog.value = Math.round(((fi + 1) / total) * 100);
        await new Promise(function (r) {
          setTimeout(r, 0);
        });
      }
      trimLogAppend("✅ All files processed.");
      if (msg) msg.textContent = "Done.";
    } catch (e) {
      trimLogAppend("❌ " + String(e && e.message ? e.message : e));
      if (msg) msg.textContent = "Error.";
    } finally {
      try {
        await ac.close();
      } catch (x) {
        /* ignore */
      }
      if (prog) prog.hidden = true;
    }
  }

  function renderPl() {
    var ul = $("playlist");
    if (!ul) return;
    ul.innerHTML = "";
    playlist.forEach(function (item, idx) {
      var li = document.createElement("li");
      li.className = idx === currentIndex ? "active" : "";
      var main = document.createElement("div");
      main.className = "pl-main";
      var sp = document.createElement("span");
      sp.className = "pl-name";
      sp.textContent = item.name;
      main.appendChild(sp);
      if (item._lrcLoading) {
        var t1 = document.createElement("span");
        t1.className = "lrc-tag";
        t1.textContent = "· LRC loading…";
        main.appendChild(t1);
      } else if (item.lrcText && String(item.lrcText).trim()) {
        var t2 = document.createElement("span");
        t2.className = "lrc-tag";
        t2.textContent = "· LRC";
        main.appendChild(t2);
      }
      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "btn small rm btn-lbl-rose";
      rm.textContent = "✕";
      rm.onclick = function (e) {
        e.stopPropagation();
        removePl(idx);
      };
      li.appendChild(main);
      li.appendChild(rm);
      li.onclick = function () {
        loadTrack(idx, true);
      };
      ul.appendChild(li);
    });
  }

  function removePl(idx) {
    var item = playlist[idx];
    if (!item) return;
    URL.revokeObjectURL(item.url);
    playlist.splice(idx, 1);
    if (currentIndex === idx) {
      audioMain.pause();
      audioMain.removeAttribute("src");
      currentIndex = -1;
    } else if (currentIndex > idx) currentIndex--;
    renderPl();
  }

  /** Same folder as webkitRelativePath (folder picker / folder drop); flat picks share one bucket. */
  function fileDirKey(f) {
    var p = String(f.webkitRelativePath || "").replace(/\\/g, "/");
    if (!p) return "\0";
    var i = p.lastIndexOf("/");
    return i < 0 ? "\0" : p.slice(0, i);
  }

  function fileStem(f) {
    return String(f.name || "")
      .replace(/\.[^.\\/]+$/, "")
      .trim()
      .toLowerCase();
  }

  /**
   * Foobar2000-style export: %_folderpath%\$trim($replace($replace(%artist%,'\',''),'/','')) - %title%.lrc
   */
  function tagFieldToSingleString(v) {
    if (v == null) return "";
    if (Array.isArray(v)) {
      var parts = [];
      for (var ti = 0; ti < v.length; ti++) {
        var s = tagFieldToSingleString(v[ti]);
        if (s) parts.push(s);
      }
      return parts.join(", ");
    }
    if (typeof v === "object" && v.data != null) return tagFieldToSingleString(v.data);
    return String(v).trim();
  }

  function sanitizeArtistForFoobarLrcPath(artist) {
    return String(artist || "")
      .replace(/\\/g, "")
      .replace(/\//g, "")
      .trim();
  }

  function foobarStyleLrcExpectedBasename(tags) {
    if (!tags) return "";
    var artist = sanitizeArtistForFoobarLrcPath(tagFieldToSingleString(tags.artist));
    var title = tagFieldToSingleString(tags.title);
    if (!artist || !title) return "";
    return artist + " - " + title + ".lrc";
  }

  function foobarStyleLrcExpectedStem(tags) {
    var base = foobarStyleLrcExpectedBasename(tags);
    if (!base) return "";
    return fileStem({ name: base });
  }

  function foobarStyleLrcMatchingEnabled() {
    var el = $("ly-foobar");
    return !!(el && el.checked);
  }

  function findFoobarStyleLrcInList(audioFile, lrcFiles, tags) {
    if (!foobarStyleLrcMatchingEnabled() || !lrcFiles || !lrcFiles.length || !tags) return null;
    var wantStem = foobarStyleLrcExpectedStem(tags);
    if (!wantStem) return null;
    var dk = fileDirKey(audioFile);
    for (var fi = 0; fi < lrcFiles.length; fi++) {
      var lf = lrcFiles[fi];
      if (fileDirKey(lf) !== dk) continue;
      if (fileStem(lf) === wantStem) return lf;
    }
    return null;
  }

  /** If a lyrics folder was loaded earlier without tags, pair when metadata arrives. */
  function tryPairLyricsFromCachedFolder(entry) {
    if (!cachedLyricsFolderIndex || !entry || entry.lrcPaired) return;
    var lrc = findLrcFileForTrack(entry, cachedLyricsFolderIndex);
    if (!lrc) return;
    entry.lrcPaired = true;
    readSidecarLrcFile(entry, lrc);
    renderPl();
  }

  /** Strip leading track #, normalize unicode/spaces — for cross-naming (audio vs .lrc). */
  function normalizeLyricsStem(stem) {
    if (!stem) return "";
    var s = String(stem).trim().toLowerCase();
    try {
      if (s.normalize) s = s.normalize("NFKC");
    } catch (e1) {}
    s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
    s = s.replace(/^\d{1,4}\s*[-–—._]+\s*/, "");
    s = s.replace(/^\d{1,4}\s*\)\s*/, "");
    s = s.replace(/^\d{1,4}\s+/, "");
    s = s.replace(/_/g, " ");
    return s.replace(/\s+/g, " ").trim();
  }

  function tailTitleKeyFromNorm(norm) {
    if (!norm) return "";
    var idx = norm.lastIndexOf(" - ");
    if (idx >= 0) {
      var t = norm.slice(idx + 3).trim();
      if (t.length >= 2) return t;
    }
    return "";
  }

  function headArtistKeyFromNorm(norm) {
    if (!norm) return "";
    var idx = norm.indexOf(" - ");
    if (idx >= 0) {
      var h = norm.slice(0, idx).trim();
      if (h.length >= 2) return h;
    }
    return "";
  }

  /** Remove trailing (…) / […] junk; keep core title for looser matching. */
  function scrubFilenameForLyricsMatch(stem) {
    var s = normalizeLyricsStem(stem);
    if (!s) return "";
    var prev;
    do {
      prev = s;
      s = s.replace(/\s*[\(\[][^(^\[]*[\)\]]\s*$/, "").trim();
    } while (s !== prev);
    return s.replace(/\s+/g, " ").trim();
  }

  function lcsLength(a, b) {
    if (!a || !b) return 0;
    var m = a.length,
      n = b.length,
      best = 0,
      i,
      j,
      row = [],
      prev;
    for (j = 0; j <= n; j++) row[j] = 0;
    for (i = 1; i <= m; i++) {
      prev = 0;
      for (j = 1; j <= n; j++) {
        var cur = row[j];
        if (a.charAt(i - 1) === b.charAt(j - 1)) {
          row[j] = prev + 1;
          if (row[j] > best) best = row[j];
        } else {
          row[j] = 0;
        }
        prev = cur;
      }
    }
    return best;
  }

  function pushLrcBucket(map, key, file) {
    if (!key) return;
    if (!map[key]) map[key] = [];
    if (map[key].indexOf(file) >= 0) return;
    map[key].push(file);
  }

  function pickBestLrcByScore(audioScrub, fileList) {
    if (!fileList || !fileList.length) return null;
    if (fileList.length === 1) return fileList[0];
    var bestF = null,
      bestS = -1,
      i,
      lf,
      ls,
      len,
      sc;
    for (i = 0; i < fileList.length; i++) {
      lf = fileList[i];
      ls = scrubFilenameForLyricsMatch(fileStem(lf));
      len = lcsLength(audioScrub, ls);
      sc = len * 3;
      if (audioScrub === ls) sc += 500;
      else if (audioScrub.indexOf(ls) >= 0 || ls.indexOf(audioScrub) >= 0) sc += Math.min(audioScrub.length, ls.length);
      if (sc > bestS) {
        bestS = sc;
        bestF = lf;
      }
    }
    if (bestS >= 12) return bestF;
    return null;
  }

  function resolveLrcBucket(map, key, audioScrub) {
    if (!key || !map[key]) return null;
    var arr = map[key];
    if (arr.length === 1) return arr[0];
    return pickBestLrcByScore(audioScrub, arr);
  }

  function buildLrcFolderIndex(files) {
    var byExact = {};
    var byNorm = {};
    var byScrub = {};
    var byTail = {};
    var byHead = {};
    var all = [];
    files.forEach(function (f) {
      if (!f.name.toLowerCase().endsWith(".lrc")) return;
      var raw = fileStem(f);
      if (!raw) return;
      var norm = normalizeLyricsStem(raw);
      var scrub = scrubFilenameForLyricsMatch(raw);
      if (!byExact[raw]) byExact[raw] = f;
      pushLrcBucket(byNorm, norm, f);
      pushLrcBucket(byScrub, scrub, f);
      var tail = tailTitleKeyFromNorm(scrub) || tailTitleKeyFromNorm(norm);
      if (tail) pushLrcBucket(byTail, tail, f);
      var head = headArtistKeyFromNorm(scrub) || headArtistKeyFromNorm(norm);
      if (head) pushLrcBucket(byHead, head, f);
      all.push({ raw: raw, norm: norm, scrub: scrub, file: f });
    });
    return { byExact: byExact, byNorm: byNorm, byScrub: byScrub, byTail: byTail, byHead: byHead, all: all };
  }

  function uniqueLrcFile(candidates) {
    var seen = [],
      out = [];
    for (var i = 0; i < candidates.length; i++) {
      var f = candidates[i];
      if (seen.indexOf(f) >= 0) continue;
      seen.push(f);
      out.push(f);
    }
    return out.length === 1 ? out[0] : null;
  }

  function pickUniqueGlobalLcs(audioScrub, allRows) {
    if (!audioScrub || audioScrub.length < 4) return null;
    var scores = [],
      i,
      ls,
      len;
    for (i = 0; i < allRows.length; i++) {
      ls = allRows[i].scrub;
      len = lcsLength(audioScrub, ls);
      if (len >= 7) scores.push({ file: allRows[i].file, len: len });
    }
    if (!scores.length) return null;
    scores.sort(function (a, b) {
      return b.len - a.len;
    });
    if (scores.length === 1) return scores[0].file;
    if (scores[0].len > scores[1].len) return scores[0].file;
    return null;
  }

  function findLrcFileForTrack(entry, index) {
    var st = fileStem(entry.file);
    if (!st) return null;
    if (index.byExact[st]) return index.byExact[st];
    if (foobarStyleLrcMatchingEnabled() && entry._lastTags) {
      var fsStem = foobarStyleLrcExpectedStem(entry._lastTags);
      if (fsStem && index.byExact[fsStem]) return index.byExact[fsStem];
    }
    var n = normalizeLyricsStem(st);
    var scrub = scrubFilenameForLyricsMatch(st);

    var r = resolveLrcBucket(index.byNorm, n, scrub);
    if (r) return r;

    r = resolveLrcBucket(index.byScrub, scrub, scrub);
    if (r) return r;

    var tail = tailTitleKeyFromNorm(scrub) || tailTitleKeyFromNorm(n);
    r = resolveLrcBucket(index.byTail, tail, scrub);
    if (r) return r;

    var head = headArtistKeyFromNorm(scrub) || headArtistKeyFromNorm(n);
    r = resolveLrcBucket(index.byHead, head, scrub);
    if (r) return r;

    var minLen = 4;
    var cand = [];
    var i,
      row,
      ln;
    for (i = 0; i < index.all.length; i++) {
      row = index.all[i];
      ln = row.scrub;
      if (ln.length < minLen || scrub.length < minLen) continue;
      if (scrub === ln) continue;
      if (scrub.endsWith(ln) && ln.length >= minLen) cand.push(row.file);
      else if (ln.endsWith(scrub) && scrub.length >= minLen) cand.push(row.file);
    }
    r = uniqueLrcFile(cand);
    if (r) return r;
    if (cand.length) {
      r = pickBestLrcByScore(scrub, cand);
      if (r) return r;
    }

    return pickUniqueGlobalLcs(scrub, index.all);
  }

  function readSidecarLrcFile(entry, lrcFile) {
    entry._lrcLoading = true;
    function done(text) {
      entry._lrcLoading = false;
      var s = text != null ? String(text) : "";
      if (s.trim()) {
        entry.lrcText = s;
        applySidecarLrcWhenReady(entry);
      } else {
        entry.lrcText = null;
        if (playlist[currentIndex] === entry) {
          tryAutoloadLyricsForTrack(entry, entry._lastTags || null);
        }
      }
      renderPl();
    }
    function fail() {
      entry._lrcLoading = false;
      entry.lrcText = null;
      if (playlist[currentIndex] === entry) {
        tryAutoloadLyricsForTrack(entry, entry._lastTags || null);
      }
      renderPl();
    }
    if (typeof lrcFile.text === "function") {
      lrcFile
        .text()
        .then(done)
        .catch(function () {
          var r = new FileReader();
          r.onload = function () {
            done(r.result);
          };
          r.onerror = fail;
          try {
            r.readAsText(lrcFile, "UTF-8");
          } catch (e) {
            r.readAsText(lrcFile);
          }
        });
      return;
    }
    var r = new FileReader();
    r.onload = function () {
      done(r.result);
    };
    r.onerror = fail;
    try {
      r.readAsText(lrcFile, "UTF-8");
    } catch (e2) {
      r.readAsText(lrcFile);
    }
  }

  /**
   * Pick a folder of .lrc files (any depth) and pair to playlist tracks.
   * Matching: exact stem, Foobar-style tag name (Artist - Title.lrc), normalized stem,
   * title tail, then fuzzy buckets / LCS when only one .lrc qualifies.
   */
  function applyLyricsFolderFromFileList(fileList) {
    var files = Array.from(fileList || []);
    if (!files.length) return;
    if (!playlist.length) {
      setStatus("Add audio to the playlist first, then load a lyrics folder.");
      return;
    }
    var index = buildLrcFolderIndex(files);
    var nLrc = index.all.length;
    if (!nLrc) {
      setStatus("No .lrc files in that folder.");
      cachedLyricsFolderIndex = null;
      return;
    }
    cachedLyricsFolderIndex = index;
    var matched = 0;
    playlist.forEach(function (entry) {
      var lrc = findLrcFileForTrack(entry, index);
      if (!lrc) return;
      matched++;
      entry.lrcPaired = true;
      readSidecarLrcFile(entry, lrc);
    });
    renderPl();
    if (matched) {
      setStatus("Lyrics folder: matched " + matched + " of " + playlist.length + " track(s) (" + nLrc + " .lrc)");
    } else {
      var exA = playlist[0] ? fileStem(playlist[0].file) : "?";
      var exN = index.all
        .slice(0, 3)
        .map(function (r) {
          return r.raw;
        })
        .join(", ");
      setStatus(
        "No pairing — rename closer or check spelling. Audio example stem: \"" +
          exA +
          "\" · .lrc examples: " +
          (exN || "—") +
          " · (" +
          nLrc +
          " files scanned, flexible match tried)"
      );
    }
  }

  function addFiles(fileList) {
    var files = Array.from(fileList || []);
    var audio = [],
      lrcFiles = [];
    files.forEach(function (f) {
      if (f.name.toLowerCase().endsWith(".lrc")) lrcFiles.push(f);
      else if (
        (f.type && f.type.indexOf("audio") === 0) ||
        /\.(mp3|m4a|aac|flac|ogg|opus|wav|webm)(\?|$)/i.test(f.name)
      ) {
        audio.push(f);
      }
    });
    audio.forEach(function (file) {
      var url = URL.createObjectURL(file);
      var dk = fileDirKey(file),
        stem = fileStem(file);
      var candidates = lrcFiles.filter(function (l) {
        return fileStem(l) === stem && fileDirKey(l) === dk;
      });
      candidates.sort(function (a, b) {
        return a.name.localeCompare(b.name);
      });
      var match = candidates[0];
      var entry = {
        name: file.name,
        url: url,
        file: file,
        lrcText: null,
        _lrcLoading: false,
        lrcPaired: false,
        _siblingLrcFiles: lrcFiles.slice(),
      };
      playlist.push(entry);
      if (match) {
        entry.lrcPaired = true;
        readSidecarLrcFile(entry, match);
      }
    });
    renderPl();
    var nSidecar = 0;
    for (var si = 0; si < playlist.length; si++) {
      if (playlist[si].lrcPaired) nSidecar++;
    }
    function finishAdd() {
      if (currentIndex < 0 && playlist.length) loadTrack(0, false);
      setStatus(
        playlist.length +
          " track(s)" +
          (nSidecar ? " · " + nSidecar + " paired with .lrc" : "")
      );
    }
    var autoBpm = $("pl-auto-bpm");
    if (autoBpm && autoBpm.checked && playlist.length >= 2) {
      setStatus("Tag BPM: ordering queue…");
      sortPlaylistAfterAddAutoBpm()
        .then(function () {
          renderPl();
          finishAdd();
        })
        .catch(function () {
          renderPl();
          finishAdd();
        });
    } else {
      finishAdd();
    }
  }

  /** When tag read finishes before audio duration exists, retry after metadata loads. */
  function onAudioLoadedMetadataForUi(item) {
    var td = $("time-dur");
    if (td) td.textContent = fmtTime(audioMain.duration);
    if (
      $("ly-autoload") &&
      $("ly-autoload").checked &&
      lyricsParsed.length === 0 &&
      item &&
      playlist[currentIndex] === item
    ) {
      tryAutoloadLyricsForTrack(item, item._lastTags || null);
    }
  }

  function loadMetaFor(item) {
    var metaEl = $("meta");
    var tagEl = $("bpm-tagged");
    tagBpm = null;
    if (tagEl) tagEl.textContent = "";
    if (!metaEl || !item || !item.file) return;
    metaEl.textContent = "…";
    item._metaLoadId = (item._metaLoadId || 0) + 1;
    var loadId = item._metaLoadId;
    (async function () {
      var result;
      try {
        result = await readAudioTagsCombined(item.file);
      } catch (e) {
        result = { tags: {}, rawJm: null, format: null, note: (e && e.message) || String(e) };
      }
      if (item._metaLoadId !== loadId || !item.file) return;
      var tags = result.tags || {};
      item._lastTags = tags;
      item._rawJmTags = result.rawJm;
      item._formatMeta = result.format || null;

      if (
        !item.lrcPaired &&
        item._siblingLrcFiles &&
        item._siblingLrcFiles.length &&
        foobarStyleLrcMatchingEnabled()
      ) {
        var fb = findFoobarStyleLrcInList(item.file, item._siblingLrcFiles, tags);
        if (fb) {
          item.lrcPaired = true;
          delete item._siblingLrcFiles;
          readSidecarLrcFile(item, fb);
          renderPl();
        }
      }
      tryPairLyricsFromCachedFolder(item);

      var lines = [];
      if (tags.title) lines.push("Title: " + tags.title);
      if (tags.artist) lines.push("Artist: " + tags.artist);
      if (tags.album) lines.push("Album: " + tags.album);
      if (tags.albumartist) lines.push("Album artist: " + tags.albumartist);
      if (tags.year != null && tags.year !== "") lines.push("Year: " + tags.year);
      if (tags.track != null && tags.track !== "") lines.push("Track: " + tags.track);
      if (tags.genre) lines.push("Genre: " + tags.genre);
      if (tags.comment) lines.push("Comment: " + tags.comment);

      var fmt = result.format;
      if (fmt) {
        if (fmt.duration != null && isFinite(fmt.duration) && fmt.duration > 0) {
          lines.push("Duration (file): " + fmtTime(fmt.duration));
        }
        if (fmt.bitrate != null && isFinite(fmt.bitrate) && fmt.bitrate > 0) {
          lines.push("Bitrate: ~" + Math.round(fmt.bitrate / 1000) + " kbps");
        }
        if (fmt.container) lines.push("Container: " + fmt.container);
        if (fmt.codec) lines.push("Codec: " + fmt.codec);
      }

      var emb = extractEmbeddedLyricsRaw(tags, item._rawJmTags);
      if (emb && emb.trim()) lines.push("Embedded lyrics: yes (" + emb.trim().split(/\r?\n/).length + " lines)");

      var tbpm = tags.TBPM && tags.TBPM.data;
      if (tbpm == null && tags.bpm != null) tbpm = tags.bpm;
      if (tbpm != null) {
        tagBpm = parseFloat(tbpm);
        if (tagEl && isFinite(tagBpm)) tagEl.textContent = "Tagged BPM: " + tagBpm;
      }

      if (!lines.length && result.note && !tags.title && !tags.artist) {
        lines.push("(Tag read: " + result.note + " — try reloading or another browser)");
      }
      metaEl.textContent = lines.length ? lines.join("\n") : item.name;
      tryAutoloadLyricsForTrack(item, tags);
    })();
  }

  function stopJingleLayer() {
    audioJingle.pause();
    audioJingle.currentTime = 0;
    jingleReplaceHardCut = false;
    if (gainJingle) gainJingle.gain.value = 0;
    if (gainMain) gainMain.gain.value = masterLinear;
  }

  function jingleTransitionsConfigured() {
    var en = $("jg-enable");
    return !!(en && en.checked && jingleUrl);
  }

  function tryPlayJingleOnCrossfade() {
    if (!jingleTransitionsConfigured()) return;
    var xf = $("jg-at-xf");
    if (!xf || !xf.checked) return;
    ensureGraph();
    resume().then(function () {
      var jv = parseInt($("jg-vol").value, 10) / 100;
      if (gainJingle) gainJingle.gain.value = jv;
      audioJingle.currentTime = 0;
      audioJingle.play().catch(function () {});
    });
  }

  function tryPlayJingleOnHardCut() {
    if (!jingleTransitionsConfigured()) return;
    var hc = $("jg-at-hard");
    if (!hc || !hc.checked) return;
    var mode = $("jg-mode") ? $("jg-mode").value : "overlay";
    jingleReplaceHardCut = mode === "replace";
    ensureGraph();
    resume().then(function () {
      var jv = parseInt($("jg-vol").value, 10) / 100;
      if (gainJingle) gainJingle.gain.value = jv;
      if (jingleReplaceHardCut && gainMain) gainMain.gain.value = 0;
      audioJingle.currentTime = 0;
      audioJingle.play().catch(function () {});
    });
  }

  function loadTrack(index, autoplay, options) {
    options = options || {};
    if (!options.keepJingle) stopJingleLayer();
    if (index < 0 || index >= playlist.length) return;
    currentIndex = index;
    xfCooldown = false;
    xfRunning = false;
    rollStopInternal();
    loopClear();
    var item = playlist[index];
    clearLyricsDisplay();
    audioMain.src = item.url;
    loadMetaFor(item);
    renderPl();
    audioMain.onloadedmetadata = function () {
      onAudioLoadedMetadataForUi(item);
    };
    autoplay ? playMain() : ($("time-dur").textContent = "00:00");
  }

  async function playMain() {
    if (!playlist.length) {
      setStatus("Add files");
      return;
    }
    if (currentIndex < 0) loadTrack(0, false);
    ensureGraph();
    await resume();
    applyEq();
    gainMain.gain.value = jingleReplaceHardCut ? 0 : masterLinear;
    try {
      await audioMain.play();
      setStatus("Playing");
    } catch (e) {
      setStatus("Play blocked");
    }
  }

  function pauseMain() {
    audioMain.pause();
    setStatus("Paused");
  }

  function stopMain() {
    audioMain.pause();
    audioMain.currentTime = 0;
    setStatus("Stopped");
  }

  function onEnded() {
    if (xfRunning) return;
    if (repeatMode === 2) {
      audioMain.currentTime = 0;
      audioMain.play();
      var item = playlist[currentIndex];
      if (item) setStatus("🔁 Repeat: " + item.name);
      return;
    }
    var keepJ =
      jingleTransitionsConfigured() && $("jg-at-hard") && $("jg-at-hard").checked;
    if (repeatMode === 1 && playlist.length) {
      if (keepJ) tryPlayJingleOnHardCut();
      loadTrack((currentIndex + 1) % playlist.length, true, { keepJingle: keepJ });
      return;
    }
    if (currentIndex < playlist.length - 1) {
      if (keepJ) tryPlayJingleOnHardCut();
      loadTrack(currentIndex + 1, true, { keepJingle: keepJ });
    } else {
      setStatus("End of playlist");
    }
  }

  function playNext() {
    if (!playlist.length) return;
    var n = playlist.length;
    if (repeatMode === 1) {
      loadTrack((currentIndex + 1) % n, true);
      return;
    }
    if (currentIndex + 1 >= n) {
      setStatus("End of playlist");
      return;
    }
    loadTrack(currentIndex + 1, true);
  }

  function playPrev() {
    if (!playlist.length) return;
    var n = playlist.length;
    if (repeatMode === 1) {
      loadTrack((currentIndex - 1 + n) % n, true);
      return;
    }
    if (currentIndex <= 0) {
      setStatus("Start of playlist");
      return;
    }
    loadTrack(currentIndex - 1, true);
  }

  function updatePhoneBanner(healthJson) {
    var b = $("phone-lan-banner");
    if (!b) return;
    var host = window.location.hostname || "";
    var isLocal =
      host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
    var mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || "");
    var j = healthJson || {};
    if (isLocal) {
      b.hidden = false;
      if (j.phone_url) {
        b.textContent =
          "On your phone (same Wi‑Fi) open: " +
          j.phone_url +
          " — not 127.0.0.1. If it will not load, run open_samsel_port.bat as Administrator on this PC.";
      } else {
        b.textContent =
          "On your phone open http://<this-PC-IPv4>:8765/ (run ipconfig here to see IPv4). Same Wi‑Fi only. Firewall: open_samsel_port.bat as Admin.";
      }
      return;
    }
    if (mobile) {
      b.hidden = false;
      b.textContent =
        "Tap Play once to start audio. Use http:// to your PC (not https unless you added TLS). Guest Wi‑Fi may block phone-to-PC access.";
      return;
    }
    b.hidden = true;
  }

  function wire() {
    $("btn-play").onclick = playMain;
    $("btn-pause").onclick = pauseMain;
    $("btn-stop").onclick = stopMain;
    $("btn-next").onclick = playNext;
    $("btn-prev").onclick = playPrev;
    $("btn-repeat").onclick = function () {
      repeatMode = (repeatMode + 1) % 3;
      $("btn-repeat").textContent = repeatLabels[repeatMode];
    };
    $("vol").oninput = function (e) {
      masterLinear = parseInt(e.target.value, 10) / 100;
      $("vol-lbl").textContent = e.target.value + "%";
      if (gainMain && !jingleReplaceHardCut) gainMain.gain.value = masterLinear;
    };
    var sk = $("seek");
    sk.onmousedown = function () {
      seekSeeking = true;
    };
    sk.onmouseup = sk.onchange = function () {
      seekSeeking = false;
    };
    sk.oninput = function (e) {
      var d = audioMain.duration;
      if (!isFinite(d)) return;
      audioMain.currentTime = (parseInt(e.target.value, 10) / 1000) * d;
    };
    audioMain.ontimeupdate = onTimeUpdate;
    audioMain.onended = onEnded;

    $("file-input").onchange = function (e) {
      addFiles(e.target.files);
      e.target.value = "";
    };
    var folderIn = $("folder-input");
    if (folderIn) {
      folderIn.onchange = function (e) {
        addFiles(e.target.files);
        e.target.value = "";
      };
    }
    var btnSortBpm = $("btn-pl-sort-bpm");
    if (btnSortBpm) {
      btnSortBpm.onclick = function () {
        if (!playlist.length) {
          setStatus("Add tracks first");
          return;
        }
        var chk = $("pl-auto-bpm");
        btnSortBpm.disabled = true;
        if (chk) chk.disabled = true;
        sortPlaylistBpmAutoFull()
          .catch(function () {
            setStatus("BPM sort failed");
          })
          .finally(function () {
            btnSortBpm.disabled = false;
            if (chk) chk.disabled = false;
          });
      };
    }
    $("btn-clear").onclick = function () {
      playlist.forEach(function (i) {
        URL.revokeObjectURL(i.url);
      });
      playlist = [];
      cachedLyricsFolderIndex = null;
      currentIndex = -1;
      audioMain.pause();
      audioMain.removeAttribute("src");
      clearLyricsDisplay();
      renderPl();
      $("meta").textContent = "—";
    };
    $("btn-eq-flat").onclick = function () {
      for (var i = 0; i < 10; i++) {
        var sl = $("eq-" + i);
        if (sl) sl.value = "0";
      }
      ensureGraph();
      applyEq();
      updateEqLabels();
    };

    $("lp-in").onclick = loopInBtn;
    $("lp-out").onclick = loopOutBtn;
    $("lp-clear").onclick = loopClear;
    $("dj-loop-on").onclick = beatLoopOn;
    $("dj-loop-off").onclick = beatLoopOff;
    $("dj-roll-on").onclick = rollOn;
    $("dj-roll-off").onclick = rollOff;

    $("ly-file").onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        setLyricsFromText(String(r.result || ""));
      };
      r.readAsText(f);
      e.target.value = "";
    };
    var lyFolderIn = $("ly-folder-input");
    if (lyFolderIn) {
      lyFolderIn.onchange = function (e) {
        applyLyricsFolderFromFileList(e.target.files);
        e.target.value = "";
      };
    }
    $("ly-paste").onclick = async function () {
      try {
        var t = await navigator.clipboard.readText();
        setLyricsFromText(t);
      } catch (x) {
        setStatus("Clipboard denied");
      }
    };
    $("ly-offset").oninput = function () {
      lyricsOffsetMs = parseInt($("ly-offset").value, 10) || 0;
    };

    if ($("trim-web-playlist")) {
      $("trim-web-playlist").onclick = function () {
        trimWebExportPlaylist();
      };
    }
    if ($("trim-threshold-db")) {
      $("trim-threshold-db").oninput = updateTrimThresholdDbLabel;
      updateTrimThresholdDbLabel();
    }
    if ($("trim-method")) {
      $("trim-method").onchange = function () {
        updateTrimMethodVisibility();
      };
      updateTrimMethodVisibility();

      $("trim-add-files").onclick = function () {
        var inp = $("trim-file-input");
        if (inp) inp.click();
      };
      $("trim-file-input").onchange = function (e) {
        var files = e.target.files;
        if (!files || !files.length) return;
        for (var i = 0; i < files.length; i++) {
          var f = files[i];
          if (!f || !f.name) continue;
          trimFileQueue.push({ file: f, name: f.name });
        }
        e.target.value = "";
        renderTrimFileList();
        trimLogAppend("➕ Added " + files.length + " file(s).");
      };
      $("trim-remove-file").onclick = function () {
        if (trimSelectedIndex < 0 || trimSelectedIndex >= trimFileQueue.length) {
          trimLogAppend("Select a row in “Files to trim”, then Remove.");
          return;
        }
        var removed = trimFileQueue.splice(trimSelectedIndex, 1)[0];
        trimSelectedIndex = Math.min(trimSelectedIndex, trimFileQueue.length - 1);
        renderTrimFileList();
        trimLogAppend("− Removed: " + (removed && removed.name ? removed.name : "?"));
      };
      $("trim-clear-files").onclick = function () {
        trimFileQueue = [];
        trimSelectedIndex = -1;
        renderTrimFileList();
        trimLogAppend("Cleared trim queue.");
      };
      $("trim-browse-dir").onclick = async function () {
        var lbl = $("trim-output-label");
        if (!window.showDirectoryPicker) {
          if (lbl) lbl.textContent = "No folder API — trimmed files download to your browser folder.";
          trimLogAppend("Folder picker unsupported; using download per file.");
          return;
        }
        try {
          trimOutputDirHandle = await window.showDirectoryPicker({
            id: "samsel-trim-out",
            mode: "readwrite",
          });
          if (lbl) lbl.textContent = "Folder linked — trimmed MP3s save there (permission granted).";
          trimLogAppend("📂 Output folder selected.");
        } catch (err) {
          if (err && err.name === "AbortError") return;
          if (lbl) lbl.textContent = "Could not use folder.";
          trimLogAppend("❌ Folder: " + String(err && err.message ? err.message : err));
        }
      };

      $("trim-run").onclick = function () {
        runTrimBatch();
      };
    }

    $("jg-file").onchange = function (e) {
      if (jingleLocked) { e.target.value = ""; return; }
      var f = e.target.files && e.target.files[0];
      revokeJingleUrlIfBlob();
      jingleUrl = f ? URL.createObjectURL(f) : null;
      audioJingle.src = jingleUrl || "";
      $("jg-name").textContent = f ? f.name : "—";
      e.target.value = "";
    };
    $("jg-vol").oninput = function (e) {
      var v = parseInt(e.target.value, 10) / 100;
      $("jg-vol-lbl").textContent = e.target.value + "%";
      if (gainJingle) gainJingle.gain.value = v;
    };
    $("jg-play").onclick = async function () {
      if (!jingleUrl) {
        setStatus("Pick a jingle file");
        return;
      }
      ensureGraph();
      await resume();
      var mode = $("jg-mode").value;
      var jv = parseInt($("jg-vol").value, 10) / 100;
      if (gainJingle) gainJingle.gain.value = jv;
      if (mode === "replace" && gainMain) gainMain.gain.value = 0;
      audioJingle.currentTime = 0;
      audioJingle.play();
    };
    $("jg-stop").onclick = function () {
      stopJingleLayer();
    };
    audioJingle.onended = function () {
      if (gainJingle) gainJingle.gain.value = 0;
      jingleReplaceHardCut = false;
      if (gainMain) gainMain.gain.value = masterLinear;
    };

    var _lastJingleEtag = "";

    function applyJingleConfig(cfg, etag) {
      if (etag) _lastJingleEtag = etag;
      if (!cfg.uploads_enabled) {
        jingleLocked = true;
        var fileBtn = $("jg-file");
        if (fileBtn) fileBtn.closest(".row-inline").style.display = "none";
        var en = $("jg-enable");
        if (en) {
          en.checked = true;
          en.disabled = true;
        }
        var atXf = $("jg-at-xf");
        if (atXf) {
          atXf.checked = true;
          atXf.disabled = true;
        }
        var atHard = $("jg-at-hard");
        if (atHard) {
          atHard.checked = true;
          atHard.disabled = true;
        }
      }
      if (cfg.has_default_jingle) {
        revokeJingleUrlIfBlob();
        jingleUrl =
          defaultJingleStreamBaseOrigin() +
          "/api/jingle/default?wb=" +
          encodeURIComponent(getWebBuild()) +
          "&t=" +
          String(Date.now());
        setJingleStreamSrc(jingleUrl);
        var jnm = $("jg-name");
        if (jnm) jnm.textContent = cfg.default_jingle_name || "Default jingle";
        if (cfg.uploads_enabled) {
          var jgEn = $("jg-enable");
          if (jgEn && !jgEn.disabled) jgEn.checked = true;
        }
      }
    }

    var _jingleConfigSuccessUrl = "";

    function fetchJingleConfigAttempt(urls, index) {
      if (index >= urls.length) {
        console.warn("SAMSEL: jingle /api/jingle/config failed for all URLs (check tunnel + data-samsel-api-base).", urls);
        return;
      }
      var url = urls[index];
      fetch(jingleConfigUrlWithBuster(url), { credentials: "omit", cache: "no-store" })
        .then(function (r) {
          if (!r.ok) return Promise.reject(new Error("jingle config " + r.status));
          var etag = r.headers.get("ETag") || "";
          return r.json().then(function (cfg) { return { cfg: cfg, etag: etag }; });
        })
        .then(function (result) {
          _jingleConfigSuccessUrl = url;
          applyJingleConfig(result.cfg, result.etag);
        })
        .catch(function (err) {
          console.warn("SAMSEL: jingle config try failed:", url, err);
          fetchJingleConfigAttempt(urls, index + 1);
        });
    }

    (function fetchJingleConfig() {
      fetchJingleConfigAttempt(jingleConfigUrlsToTry(), 0);
    })();

    setInterval(function () {
      var url = _jingleConfigSuccessUrl;
      if (!url) return;
      fetch(jingleConfigUrlWithBuster(url), { credentials: "omit", cache: "no-store" })
        .then(function (r) {
          if (!r.ok) return;
          var etag = r.headers.get("ETag") || "";
          if (etag && etag === _lastJingleEtag) return;
          return r.json().then(function (cfg) { applyJingleConfig(cfg, etag); });
        })
        .catch(function () {});
    }, 60000);

    document.querySelectorAll(".tab").forEach(function (tab) {
      tab.onclick = function () {
        var id = tab.getAttribute("data-tab");
        document.querySelectorAll(".tab").forEach(function (t) {
          t.classList.toggle("active", t === tab);
        });
        document.querySelectorAll(".panel").forEach(function (p) {
          var on = p.id === "panel-" + id;
          p.classList.toggle("active", on);
          p.hidden = !on;
        });
      };
    });

    var dz = $("drop-zone");
    if (dz) {
      ["dragenter", "dragover"].forEach(function (ev) {
        dz.addEventListener(ev, function (e) {
          e.preventDefault();
          dz.classList.add("dragover");
        });
      });
      ["dragleave", "drop"].forEach(function (ev) {
        dz.addEventListener(ev, function (e) {
          e.preventDefault();
          dz.classList.remove("dragover");
        });
      });
      dz.addEventListener("drop", function (e) {
        addFiles(e.dataTransfer.files);
      });
    }

    var SKIN_STORAGE = "samsel-web-skin";
    var SKIN_IDS = ["midnight", "camo", "carbon", "sunset"];
    function applySkin(skinId) {
      if (SKIN_IDS.indexOf(skinId) < 0) skinId = "midnight";
      document.documentElement.setAttribute("data-skin", skinId);
      try {
        localStorage.setItem(SKIN_STORAGE, skinId);
      } catch (eSkin) {}
      var ssel = $("skin-select");
      if (ssel) ssel.value = skinId;
      var tc = document.querySelector('meta[name="theme-color"]');
      if (tc) {
        var bg = { midnight: "#12122a", camo: "#1e3e40", carbon: "#26313e", sunset: "#422712" };
        tc.setAttribute("content", bg[skinId] || "#12122a");
      }
    }
    var skinSel = $("skin-select");
    if (skinSel) {
      var savedSkin = "midnight";
      try {
        savedSkin = localStorage.getItem(SKIN_STORAGE) || "midnight";
      } catch (eLoadSkin) {}
      applySkin(SKIN_IDS.indexOf(savedSkin) >= 0 ? savedSkin : "midnight");
      skinSel.onchange = function () {
        applySkin(skinSel.value);
      };
    }

    if (audioMain.setSinkId) {
      navigator.mediaDevices.enumerateDevices().then(function (devs) {
        var sel = $("out-device");
        if (!sel) return;
        devs
          .filter(function (d) {
            return d.kind === "audiooutput";
          })
          .forEach(function (d) {
            var o = document.createElement("option");
            o.value = d.deviceId;
            o.textContent = d.label || "Output";
            sel.appendChild(o);
          });
        sel.onchange = function () {
          var id = sel.value;
          if (id && audioMain.setSinkId) {
            audioMain.setSinkId(id).catch(function () {});
            audioNext.setSinkId(id).catch(function () {});
            audioJingle.setSinkId(id).catch(function () {});
          }
        };
      });
    }

    fetch("/api/health")
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        var pill = $("conn-pill");
        if (pill && j && j.ok) pill.textContent = "Server v" + (j.version || "");
        updatePhoneBanner(j && j.ok ? j : null);
      })
      .catch(function () {
        var pill = $("conn-pill");
        if (pill) pill.textContent = "Static";
        updatePhoneBanner(null);
      });
  }

  buildEqUI();
  buildHotcues();
  fillBeatSelects();
  wire();
  if (typeof window.initSamselTooltips === "function") {
    window.initSamselTooltips(document);
  }
  setStatus("Ready");
})();
