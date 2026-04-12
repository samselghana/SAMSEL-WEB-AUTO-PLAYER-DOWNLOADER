/**
 * AutoMix Downloader v2 — browser UI; engine runs on the server (localhost or LAN with SAMSEL_AUTOMIX_LAN=1).
 * Phones use JSON polling (/api/automix/snapshot) because EventSource/SSE is flaky on many mobile browsers.
 * Optional: data-samsel-api-base on <html> when the UI is hosted on a different origin than the API (e.g. Pages + Tunnel).
 */
(function () {
  "use strict";

  var TOKEN_KEY = "samsel_automix_token";
  var SESSION_KEY = "samsel_automix_session";
  var es = null;
  var pollTimer = null;
  var activated = false;
  /** File System Access API: folder chosen via "Choose save folder" (session only). */
  var saveFolderHandle = null;
  /** Last successful /outputs items (for ZIP download). */
  var lastOutputItems = [];

  /** Unique session ID so the server can give this tab its own temp output dir. */
  var sessionId = (function () {
    try {
      var s = sessionStorage.getItem(SESSION_KEY);
      if (s) return s;
      s =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : "s-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9);
      sessionStorage.setItem(SESSION_KEY, s);
      return s;
    } catch (e) {
      return "s-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9);
    }
  })();

  /** Files the auto-delivery loop has already started downloading (avoid duplicates). */
  var deliveredSet = {};
  /** Whether an auto-delivery batch is in-flight (prevent concurrent fetches). */
  var delivering = false;
  var deliverWatchdog = null;
  /** Last server pending_files list (remote session); used for the tap-to-download button. */
  var lastPendingFiles = [];
  var pendingAutoTimer = null;

  /** iOS / Android / mobile browsers: prefer polling over SSE (Safari often breaks EventSource). */
  var isIpadDesktopUa =
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1 &&
    /Macintosh/i.test(navigator.userAgent || "");
  var usePolling =
    isIpadDesktopUa ||
    /iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini|Mobile|CriOS|FxiOS/i.test(
      navigator.userAgent || ""
    );

  function $(id) {
    return document.getElementById(id);
  }

  function getStoredToken() {
    try {
      return (localStorage.getItem(TOKEN_KEY) || "").trim();
    } catch (e) {
      return "";
    }
  }

  function authHeaderObj() {
    var t = getStoredToken();
    return t ? { "X-Samsel-Automix-Token": t } : {};
  }

  function mergeFetchOpts(opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    var ah = authHeaderObj();
    for (var k in ah) {
      if (Object.prototype.hasOwnProperty.call(ah, k)) opts.headers[k] = ah[k];
    }
    if (sessionId) opts.headers["X-Samsel-Session"] = sessionId;
    return opts;
  }

  /** When the static UI is on another host (e.g. Cloudflare Pages) and the API is on a tunnel, set data-samsel-api-base on <html> or meta name="samsel-api-base". */
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

  function withTokenQuery(path) {
    var t = getStoredToken();
    return t ? path + "?token=" + encodeURIComponent(t) : path;
  }

  function streamUrl() {
    return withSessionAndTokenQuery("/api/automix/stream");
  }

  function snapshotUrl() {
    return withSessionAndTokenQuery("/api/automix/snapshot");
  }

  function withSessionAndTokenQuery(path) {
    var parts = [];
    var t = getStoredToken();
    if (t) parts.push("token=" + encodeURIComponent(t));
    if (sessionId) parts.push("session=" + encodeURIComponent(sessionId));
    return parts.length ? path + "?" + parts.join("&") : path;
  }

  function outputsListUrl() {
    return withSessionAndTokenQuery("/api/automix/outputs");
  }

  function downloadFileUrl(relpath) {
    var parts = ["relpath=" + encodeURIComponent(relpath)];
    var t = getStoredToken();
    if (t) parts.push("token=" + encodeURIComponent(t));
    if (sessionId) parts.push("session=" + encodeURIComponent(sessionId));
    return "/api/automix/download?" + parts.join("&");
  }

  function formatBytes(n) {
    if (n == null || !isFinite(n)) return "?";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  function saveFolderStatusEl() {
    return $("am-save-folder-status");
  }

  function updateSaveFolderHint() {
    var el = saveFolderStatusEl();
    if (!el) return;
    var zipLine =
      "Every phone: tap Download all as ZIP, then Share (or Save to Files on iPhone) — you choose the folder there. Unzip in Files to get all tracks.";
    if (saveFolderHandle) {
      var fn = saveFolderHandle.name || "chosen folder";
      el.textContent =
        'Saving into "' +
        fn +
        "\" (Chrome/Edge). Singles, ZIP, and subfolders go here until you Clear folder. " +
        zipLine;
    } else if (typeof window.showDirectoryPicker === "function" && window.isSecureContext) {
      el.textContent =
        zipLine +
        " Optional: Choose save folder here for direct writes without picking again.";
    } else {
      el.textContent = zipLine;
    }
  }

  function pickSaveFolder() {
    if (typeof window.showDirectoryPicker !== "function") {
      alert(
        "This browser has no built-in folder picker. Use Download all as ZIP (works everywhere), then Share → Save to Files on iPhone, or your Files app — you pick the folder when saving. Or open this site in Chrome (Android) for Choose save folder."
      );
      return;
    }
    if (!window.isSecureContext) {
      alert("Choosing a folder needs a secure origin (https:// or http://localhost).");
      return;
    }
    var opts = { mode: "readwrite" };
    try {
      window
        .showDirectoryPicker(opts)
        .then(function (handle) {
          saveFolderHandle = handle;
          updateSaveFolderHint();
        })
        .catch(function (e) {
          if (e && e.name === "AbortError") return;
          alert("Could not use that folder: " + (e && e.message ? e.message : String(e)));
        });
    } catch (e) {
      alert("Folder picker failed: " + (e && e.message ? e.message : String(e)));
    }
  }

  function clearPickedSaveFolder() {
    saveFolderHandle = null;
    updateSaveFolderHint();
  }

  function getFileHandleForRelativePath(rootDirHandle, relativePosix) {
    var parts = relativePosix.split("/").filter(function (p) {
      return p && p !== "." && p !== "..";
    });
    if (!parts.length) return Promise.reject(new Error("Empty path"));
    var fileName = parts.pop();
    var chain = Promise.resolve(rootDirHandle);
    parts.forEach(function (segment) {
      chain = chain.then(function (dir) {
        return dir.getDirectoryHandle(segment, { create: true });
      });
    });
    return chain.then(function (dir) {
      return dir.getFileHandle(fileName, { create: true });
    });
  }

  function writeBlobToPickedFolder(rootDirHandle, relpath, fallbackFilename, blob) {
    var rel = (relpath || "").replace(/\\/g, "/").trim();
    if (!rel) rel = fallbackFilename || "download";
    return getFileHandleForRelativePath(rootDirHandle, rel).then(function (fileHandle) {
      return fileHandle.createWritable().then(function (writable) {
        return writable.write(blob).then(function () {
          return writable.close();
        });
      });
    });
  }

  function effectiveMimeFromName(filename, headerCt) {
    var m = (headerCt && headerCt.split(";")[0].trim()) || "";
    if (m && m !== "application/octet-stream") return m;
    var fn = filename || "";
    if (/\.mp3$/i.test(fn)) return "audio/mpeg";
    if (/\.m4a$/i.test(fn)) return "audio/mp4";
    if (/\.lrc$/i.test(fn)) return "text/plain";
    if (/\.zip$/i.test(fn)) return "application/zip";
    return m || "application/octet-stream";
  }

  function anchorSaveBlob(blob, filename) {
    var name = filename || "download";
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    }, 3000);
  }

  function tryShareOrAnchorBlob(blob, mime, filename, maxShareBytes) {
    var name = filename || "download";
    var cap = maxShareBytes == null ? 200 * 1024 * 1024 : maxShareBytes;
    var mobileOrPoll =
      usePolling ||
      /iPhone|iPad|iPod|Android|CriOS|FxiOS/i.test(navigator.userAgent || "");
    if (
      mobileOrPoll &&
      typeof navigator !== "undefined" &&
      navigator.share &&
      navigator.canShare &&
      blob &&
      blob.size > 0 &&
      blob.size < cap
    ) {
      try {
        var mt = effectiveMimeFromName(name, mime) || blob.type || "application/octet-stream";
        var file = new File([blob], name, { type: mt });
        var payload = { files: [file] };
        if (navigator.canShare(payload)) {
          return navigator.share(payload).catch(function () {
            anchorSaveBlob(blob, name);
            return Promise.resolve();
          });
        }
      } catch (eSh) {}
    }
    anchorSaveBlob(blob, name);
    return Promise.resolve();
  }

  function deliverBlobToDevice(blob, mime, filename, pathInChosenFolder, maxShareBytes) {
    var name = filename || "download";
    var rel = pathInChosenFolder != null && pathInChosenFolder !== "" ? pathInChosenFolder : name;
    if (saveFolderHandle) {
      return writeBlobToPickedFolder(saveFolderHandle, rel, name, blob).catch(function (fe) {
        var why = fe && fe.message ? fe.message : String(fe);
        alert(
          "Could not write to the chosen folder (" +
            why +
            "). Trying download or Share instead — pick the folder again if access expired."
        );
        return Promise.resolve(tryShareOrAnchorBlob(blob, mime, name, maxShareBytes));
      });
    }
    return Promise.resolve(tryShareOrAnchorBlob(blob, mime, name, maxShareBytes));
  }

  /**
   * Download a file from the server and save to the device.
   * Uses a plain fetch WITHOUT custom headers (token + session are in the URL query)
   * to avoid triggering a CORS preflight that the server can't answer through tunnels.
   */
  function fetchBlobAndSaveToDevice(url, filename, pathInChosenFolder) {
    var name = filename || "download";
    return fetch(url, { method: "GET", cache: "no-store", credentials: "same-origin" }).then(
      function (r) {
        if (!r.ok) {
          return r.text().then(function (t) {
            var msg = "HTTP " + r.status;
            try {
              var j = JSON.parse(t);
              msg = errDetail(j) || msg;
            } catch (x) {}
            throw new Error(msg);
          });
        }
        var ct = r.headers.get("content-type");
        return r.blob().then(function (blob) {
          if (!blob || blob.size < 1) throw new Error("Empty file from server");
          var mime = effectiveMimeFromName(name, ct);
          return Promise.resolve(deliverBlobToDevice(blob, mime, name, pathInChosenFolder, null));
        });
      }
    );
  }

  function clearDeliverWatchdog() {
    if (deliverWatchdog) {
      clearTimeout(deliverWatchdog);
      deliverWatchdog = null;
    }
  }

  function setDeliveringState(on) {
    delivering = on;
    clearDeliverWatchdog();
    if (on) {
      deliverWatchdog = setTimeout(function () {
        deliverWatchdog = null;
        delivering = false;
      }, 240000);
    }
  }

  function syncPendingDownloadUi(files) {
    var box = $("am-pending-delivery");
    var btn = $("am-download-pending-btn");
    if (!box) return;
    if (files && files.length) {
      lastPendingFiles = files.slice();
      box.hidden = false;
      var msg = box.querySelector(".am-pending-delivery-msg");
      if (msg) {
        msg.textContent =
          files.length +
          " file(s) ready. If nothing saved automatically, tap the button (phones often require this).";
      }
      if (btn) btn.disabled = false;
    } else {
      box.hidden = true;
      lastPendingFiles = [];
      if (btn) btn.disabled = false;
    }
  }

  function schedulePendingAutoDeliver(files) {
    if (!files || !files.length) return;
    if (pendingAutoTimer || delivering) return;
    var delay = usePolling ? 800 : 250;
    pendingAutoTimer = setTimeout(function () {
      pendingAutoTimer = null;
      if (lastPendingFiles.length) deliverPendingFilesFromServer(lastPendingFiles.slice());
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Remote session delivery via hidden iframes.
  // navigator.share / programmatic <a>.click() require a user-gesture on mobile
  // and silently fail from timers.  Hidden iframes pointing at the download URL
  // trigger the browser's native Save dialog via Content-Disposition: attachment
  // and work in ALL contexts (timer, visibility-change, button tap).
  // ---------------------------------------------------------------------------

  function triggerIframeDownload(url) {
    var ifr = document.createElement("iframe");
    ifr.style.display = "none";
    ifr.src = url;
    document.body.appendChild(ifr);
    setTimeout(function () {
      if (ifr.parentNode) ifr.parentNode.removeChild(ifr);
    }, 120000);
  }

  function deliverPendingFilesFromServer(files) {
    if (!files || !files.length || delivering) return;
    var newFiles = [];
    for (var i = 0; i < files.length; i++) {
      if (!deliveredSet[files[i].relpath]) newFiles.push(files[i]);
    }
    if (!newFiles.length) return;
    setDeliveringState(true);
    var btn = $("am-download-pending-btn");
    if (btn) btn.disabled = true;
    var acked = [];
    var idx = 0;

    function next() {
      if (idx >= newFiles.length) {
        setDeliveringState(false);
        if (btn) btn.disabled = false;
        if (acked.length) {
          apiJson("/api/automix/session/ack", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ relpaths: acked }),
          }).catch(function () {});
        }
        return;
      }
      var f = newFiles[idx++];
      var url = resolveApiUrl(downloadFileUrl(f.relpath));
      triggerIframeDownload(url);
      deliveredSet[f.relpath] = true;
      acked.push(f.relpath);
      setTimeout(next, 600);
    }
    next();
  }

  function refreshOutputs() {
    var ul = $("am-outputs-list");
    if (!ul) return;
    ul.innerHTML = "";
    var loading = document.createElement("li");
    loading.className = "hint am-output-row";
    loading.textContent = "Loading…";
    ul.appendChild(loading);
    fetch(resolveApiUrl(outputsListUrl()), mergeFetchOpts({ method: "GET", cache: "no-store" }))
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (x) {
        ul.innerHTML = "";
        if (!x.ok) {
          lastOutputItems = [];
          var err = document.createElement("li");
          err.className = "hint am-output-row";
          err.textContent = errDetail(x.j) || "Could not list files (403 / network).";
          ul.appendChild(err);
          return;
        }
        var j = x.j || {};
        var items = j.items || [];
        if (!items.length) {
          lastOutputItems = [];
          var empty = document.createElement("li");
          empty.className = "hint am-output-row";
          empty.textContent = "No audio or .lrc files in the output folder yet — run a download, then refresh.";
          ul.appendChild(empty);
          return;
        }
        lastOutputItems = items.slice();
        for (var i = 0; i < items.length; i++) {
          (function (it) {
            var li = document.createElement("li");
            li.className = "am-output-row";
            var name = document.createElement("span");
            name.className = "am-output-name";
            name.textContent = it.relpath + " · " + formatBytes(it.size);
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "btn small btn-lbl-mint";
            btn.textContent = "Save to device";
            btn.onclick = function () {
              downloadOutputToDevice(it.relpath, it.name);
            };
            li.appendChild(name);
            li.appendChild(btn);
            ul.appendChild(li);
          })(items[i]);
        }
      })
      .catch(function () {
        lastOutputItems = [];
        ul.innerHTML = "";
        var err = document.createElement("li");
        err.className = "hint am-output-row";
        err.textContent = "Network error loading file list.";
        ul.appendChild(err);
      });
  }

  function downloadAllOutputsZip() {
    if (!lastOutputItems.length) {
      alert("Tap Refresh list first, then Download all as ZIP.");
      return;
    }
    var relpaths = lastOutputItems.map(function (it) {
      return it.relpath;
    });
    var zipMaxShare = 800 * 1024 * 1024;
    var zipUrl = withSessionAndTokenQuery("/api/automix/download-zip");
    fetch(
      resolveApiUrl(zipUrl),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relpaths: relpaths }),
        cache: "no-store",
        credentials: "same-origin",
      }
    )
      .then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) {
            var msg = "HTTP " + r.status;
            try {
              var j = JSON.parse(t);
              msg = errDetail(j) || msg;
            } catch (x) {}
            throw new Error(msg);
          });
        }
        var ct = r.headers.get("content-type");
        return r.blob().then(function (blob) {
          return { blob: blob, ct: ct };
        });
      })
      .then(function (o) {
        return deliverBlobToDevice(
          o.blob,
          o.ct || "application/zip",
          "downloader_outputs.zip",
          "downloader_outputs.zip",
          zipMaxShare
        );
      })
      .catch(function (e) {
        var msg = e && e.message ? e.message : String(e);
        if (/Failed to fetch|NetworkError|Load failed|blocked by CORS/i.test(msg) && !getApiBase()) {
          msg +=
            " If this page is not served from the same host as the API, set data-samsel-api-base on <html> to your tunnel URL.";
        }
        alert("ZIP download failed: " + msg);
      });
  }

  function downloadOutputToDevice(relpath, filename) {
    var url = resolveApiUrl(downloadFileUrl(relpath));
    var name = filename || (relpath && relpath.split("/").pop()) || "download";
    if (saveFolderHandle) {
      fetchBlobAndSaveToDevice(url, name, relpath).catch(function (e) {
        var msg = e && e.message ? e.message : String(e);
        alert("Save failed: " + msg);
      });
      return;
    }
    triggerIframeDownload(url);
  }

  function selectedSourceType() {
    var r = document.querySelector('input[name="am-st"]:checked');
    return r ? r.value : "single";
  }

  function collectConfig() {
    return {
      output_dir: $("am-output-dir").value.trim(),
      audio_format: $("am-format").value,
      audio_quality: $("am-quality").value,
      embed_thumbnail: $("am-embed-thumb").checked,
      add_metadata: $("am-add-meta").checked,
      fetch_lyrics: $("am-fetch-lrc").checked,
      embed_lyrics_in_mp3: $("am-embed-lrc").checked,
      uslt_embed_full_lrc: $("am-uslt-full").checked,
      detect_bpm: $("am-detect-bpm").checked,
      detect_genre: $("am-detect-genre").checked,
      auto_import_library: $("am-auto-lib").checked,
      playlist_subfolders: $("am-pl-sub").checked,
      overwrite_files: $("am-overwrite").checked,
      ffmpeg_path: $("am-ffmpeg").value.trim(),
    };
  }

  function applyConfig(cfg) {
    if (!cfg) return;
    if ($("am-output-dir")) $("am-output-dir").value = cfg.output_dir || "";
    if ($("am-format")) $("am-format").value = cfg.audio_format || "mp3";
    if ($("am-quality")) $("am-quality").value = String(cfg.audio_quality != null ? cfg.audio_quality : "0");
    if ($("am-embed-thumb")) $("am-embed-thumb").checked = !!cfg.embed_thumbnail;
    if ($("am-add-meta")) $("am-add-meta").checked = !!cfg.add_metadata;
    if ($("am-fetch-lrc")) $("am-fetch-lrc").checked = !!cfg.fetch_lyrics;
    if ($("am-embed-lrc")) $("am-embed-lrc").checked = !!cfg.embed_lyrics_in_mp3;
    if ($("am-uslt-full")) $("am-uslt-full").checked = !!cfg.uslt_embed_full_lrc;
    if ($("am-detect-bpm")) $("am-detect-bpm").checked = !!cfg.detect_bpm;
    if ($("am-detect-genre")) $("am-detect-genre").checked = !!cfg.detect_genre;
    if ($("am-auto-lib")) $("am-auto-lib").checked = !!cfg.auto_import_library;
    if ($("am-pl-sub")) $("am-pl-sub").checked = !!cfg.playlist_subfolders;
    if ($("am-overwrite")) $("am-overwrite").checked = !!cfg.overwrite_files;
    if ($("am-ffmpeg")) $("am-ffmpeg").value = cfg.ffmpeg_path || "";
  }

  function escCell(s) {
    if (s == null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  }

  function renderJobs(rows) {
    var tb = $("am-jobs-body");
    if (!tb || !rows) return;
    var html = "";
    for (var i = 0; i < rows.length; i++) {
      var j = rows[i];
      html +=
        "<tr><td>" +
        escCell(j.job_id) +
        "</td><td>" +
        escCell(j.source_type) +
        "</td><td>" +
        escCell(j.source) +
        "</td><td>" +
        escCell(j.status) +
        "</td><td>" +
        escCell(typeof j.progress === "number" ? j.progress.toFixed(1) : j.progress) +
        "</td><td>" +
        escCell(j.current_item) +
        "</td><td>" +
        escCell(j.error) +
        "</td></tr>";
    }
    tb.innerHTML = html;
  }

  function renderSnap(d) {
    if (!d) return;
    var logEl = $("am-log");
    if (logEl && d.logs && d.logs.length) logEl.textContent = d.logs.join("\n");
    var bar = $("am-progress");
    if (bar && typeof d.progress === "number") {
      bar.value = d.progress;
    }
    if ($("am-status")) $("am-status").textContent = d.status || "—";
    if ($("am-eta")) $("am-eta").textContent = d.eta ? "ETA: " + d.eta : "";
    var pill = $("am-worker-pill");
    if (pill) {
      var processing =
        d.worker_processing === true ||
        (d.jobs && d.jobs.some(function (j) { return j.status === "Running"; }));
      var alive = d.worker_alive !== false;
      if (processing) pill.textContent = "Worker: processing job";
      else if (alive) pill.textContent = "Worker: idle (ready)";
      else pill.textContent = "Worker: stopped";
    }
    renderJobs(d.jobs);
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
    if (Object.prototype.hasOwnProperty.call(d, "pending_files")) {
      if (d.pending_files && d.pending_files.length) {
        syncPendingDownloadUi(d.pending_files);
        schedulePendingAutoDeliver(d.pending_files);
      } else {
        syncPendingDownloadUi([]);
      }
    }
  }

  function stopLiveUpdates() {
    if (pendingAutoTimer) {
      clearTimeout(pendingAutoTimer);
      pendingAutoTimer = null;
    }
    if (es) {
      es.close();
      es = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startEventSource() {
    if (es) return;
    if (typeof EventSource === "undefined") {
      startPolling();
      return;
    }
    try {
      es = new EventSource(resolveApiUrl(streamUrl()));
    } catch (err) {
      startPolling();
      return;
    }
    es.onmessage = function (ev) {
      try {
        renderSnap(JSON.parse(ev.data));
      } catch (x) {}
    };
    es.onerror = function () {
      if (es) es.close();
      es = null;
      if (!activated) return;
      setTimeout(function () {
        if (!activated) return;
        if (usePolling) {
          startPolling();
          return;
        }
        startEventSource();
      }, 2500);
    };
  }

  function pollOnce() {
    return fetch(resolveApiUrl(snapshotUrl()), mergeFetchOpts({ method: "GET", cache: "no-store" }))
      .then(function (r) {
        if (!r.ok) return null;
        return r.json();
      })
      .then(function (j) {
        if (j) renderSnap(j);
      })
      .catch(function () {});
  }

  function startPolling() {
    if (pollTimer) return;
    pollOnce();
    pollTimer = setInterval(pollOnce, 700);
  }

  function startLiveUpdates() {
    stopLiveUpdates();
    if (usePolling) {
      startPolling();
      return;
    }
    startEventSource();
  }

  function apiJson(url, opts) {
    var u = resolveApiUrl(url);
    var o = mergeFetchOpts(opts || {});
    if (o.mode == null) o.mode = "cors";
    return fetch(u, o).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, status: r.status, j: j };
      });
    });
  }

  function errDetail(j) {
    if (!j || j.detail == null) return "";
    if (typeof j.detail === "string") return j.detail;
    try {
      return JSON.stringify(j.detail);
    } catch (e) {
      return String(j.detail);
    }
  }

  function refreshInfo() {
    return fetch(resolveApiUrl("/api/automix/info"), mergeFetchOpts({ method: "GET", cache: "no-store" }))
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        var hint = $("am-lan-hint");
        var row = $("am-token-row");
        if (hint && j) {
          if (j.remote_misconfigured) {
            hint.textContent =
              "Server: SAMSEL_AUTOMIX_ALLOW_REMOTE is on but SAMSEL_AUTOMIX_TOKEN is missing. Set a token, restart uvicorn (or set SAMSEL_AUTOMIX_NO_TOKEN=1 if you accept open access).";
          } else if (j.allow_remote && j.no_token_mode) {
            hint.textContent =
              "Server: no-token mode — anyone who has your tunnel URL can use the Downloader and download files from the output folder. Prefer SAMSEL_AUTOMIX_TOKEN for real deployments.";
            if (usePolling) hint.textContent += " Live log uses polling on phones.";
          } else if (j.allow_remote && j.token_required) {
            hint.textContent =
              "Cloudflare / internet: enter the Downloader token below, tap Save (must match SAMSEL_AUTOMIX_TOKEN on the PC running uvicorn). Jobs still run on that PC.";
            if (usePolling) hint.textContent += " Live log uses polling on phones.";
          } else if (j.lan_enabled) {
            var base = j.token_required
              ? "LAN Downloader is on — enter the token below (same as SAMSEL_AUTOMIX_TOKEN on the server), tap Save, then use this tab."
              : j.no_token_mode
                ? "LAN Downloader is on — no token required (anyone on your Wi‑Fi can use this tab)."
                : "LAN Downloader is on — you can queue jobs from this device. Completed files will auto-save to this device.";
            if (usePolling) base += " Live log uses fast refresh on phones (not streaming).";
            hint.textContent = base;
          } else {
            hint.textContent =
              "Home Wi‑Fi: set SAMSEL_AUTOMIX_LAN=1 on the server. Cloudflare / internet: SAMSEL_AUTOMIX_ALLOW_REMOTE=1 plus SAMSEL_AUTOMIX_TOKEN (or NO_TOKEN=1 — insecure), use cloudflared to your PC.";
          }
        }
        if (row && j) {
          row.style.display = j.token_required ? "flex" : "none";
        }
      })
      .catch(function () {
        var hint = $("am-lan-hint");
        if (hint) hint.textContent = "Could not read Downloader LAN settings (is the server running?).";
      });
  }

  function loadConfig() {
    return apiJson("/api/automix/config").then(function (x) {
      if (x.ok && x.j && x.j.config) applyConfig(x.j.config);
      else if (x.status === 403 && $("am-probe")) {
        $("am-probe").textContent = errDetail(x.j) || "Downloader API refused this device.";
      }
    });
  }

  function saveSettings() {
    return apiJson("/api/automix/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectConfig()),
    }).then(function (x) {
      if (x.ok && x.j && x.j.config) applyConfig(x.j.config);
    });
  }

  function probeOnce() {
    return apiJson("/api/automix/probe").then(function (x) {
      var el = $("am-probe");
      if (!el) return;
      if (!x.ok) {
        if (x.status === 403) {
          el.textContent = errDetail(x.j) || "Downloader probe refused — check LAN/token settings.";
        }
        return;
      }
      var j = x.j || {};
      var y = j.yt_dlp ? j.yt_dlp.join(" ") : "not found";
      var s = j.syncedlyrics ? j.syncedlyrics.join(" ") : "not found";
      var m = j.mutagen ? "yes" : "no";
      var l = j.librosa ? "yes" : "no";
      var ff = j.ffmpeg_dir ? j.ffmpeg_dir : "PATH / auto";
      el.textContent =
        "Tools: yt-dlp → " +
        y +
        " · syncedlyrics → " +
        s +
        " · mutagen → " +
        m +
        " · librosa → " +
        l +
        " · FFmpeg → " +
        ff;
    });
  }

  function fallbackCopyText(t) {
    var ta = document.createElement("textarea");
    ta.value = t;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {}
    document.body.removeChild(ta);
  }

  function copyAutomixLog() {
    var logEl = $("am-log");
    if (!logEl) return;
    var t = logEl.textContent || "";
    if (!t.trim()) {
      alert("Log is empty.");
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(function () {
        fallbackCopyText(t);
      });
    } else {
      fallbackCopyText(t);
    }
  }

  function clearAutomixLog() {
    apiJson("/api/automix/log/clear", { method: "POST" }).then(function (x) {
      if (x.ok && $("am-log")) $("am-log").textContent = "";
    });
  }

  function activateAutomix() {
    activated = true;
    refreshInfo()
      .then(function () {
        return loadConfig();
      })
      .then(function () {
        probeOnce();
        stopLiveUpdates();
        startLiveUpdates();
      });
  }

  function onBrowse() {
    var st = selectedSourceType();
    if (st === "csv") {
      var inp = $("am-csv-file");
      if (inp) inp.click();
      return;
    }
    if (st === "folder_scan") {
      alert(
        "Enter the full folder path on the server PC (where uvicorn runs), e.g. C:\\Users\\You\\Music\\MyLibrary"
      );
      if ($("am-source")) $("am-source").focus();
      return;
    }
    alert("Paste a track name / search query or a playlist URL into the source field (same as the desktop app).");
  }

  function wire() {
    var ti = $("am-token-input");
    if (ti) ti.value = getStoredToken();

    refreshInfo();

    document.querySelectorAll(".tab[data-tab]").forEach(function (tab) {
      tab.addEventListener("click", function () {
        if (tab.getAttribute("data-tab") === "automix") activateAutomix();
      });
    });

    if (document.documentElement.getAttribute("data-automix-standalone") === "1") {
      activateAutomix();
    }

    var tsBtn = $("am-token-save");
    if (tsBtn) {
      tsBtn.onclick = function () {
        var v = (ti && ti.value) || "";
        try {
          localStorage.setItem(TOKEN_KEY, v.trim());
        } catch (e) {}
        stopLiveUpdates();
        refreshInfo().then(function () {
          if (activated) {
            loadConfig();
            probeOnce();
            startLiveUpdates();
          }
        });
      };
    }

    var btnBrowse = $("am-browse");
    if (btnBrowse) btnBrowse.onclick = onBrowse;

    var addJob = $("am-add-job");
    if (addJob) {
      addJob.onclick = function () {
        var src = $("am-source") ? $("am-source").value.trim() : "";
        var st = selectedSourceType();
        if (!src) {
          alert("Enter a source first.");
          return;
        }
        saveSettings().then(function () {
          return apiJson("/api/automix/job", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: src, source_type: st }),
          });
        });
      };
    }

    var csvIn = $("am-csv-file");
    if (csvIn) {
      csvIn.onchange = function () {
        var f = csvIn.files && csvIn.files[0];
        if (!f) return;
        var fd = new FormData();
        fd.append("file", f, f.name);
        saveSettings().then(function () {
          return fetch(
            resolveApiUrl("/api/automix/job/csv"),
            mergeFetchOpts({ method: "POST", body: fd })
          ).then(function (r) {
            return r.json();
          });
        });
        csvIn.value = "";
      };
    }

    var ws = $("am-worker-start");
    if (ws) ws.onclick = function () {
      apiJson("/api/automix/worker/start", { method: "POST" });
    };
    var wstop = $("am-worker-stop");
    if (wstop) wstop.onclick = function () {
      apiJson("/api/automix/worker/stop", { method: "POST" });
    };
    var save = $("am-save-settings");
    if (save) save.onclick = function () {
      saveSettings();
    };
    var openo = $("am-open-out");
    if (openo) openo.onclick = function () {
      saveSettings().then(function () {
        apiJson("/api/automix/open-output", { method: "POST" });
      });
    };
    var launch = $("am-launch-tk");
    if (launch) launch.onclick = function () {
      apiJson("/api/automix/launch", { method: "POST" }).then(function (x) {
        if (!x.ok && $("am-status")) $("am-status").textContent = errDetail(x.j) || "Launch failed";
      });
    };

    var logCopy = $("am-log-copy");
    if (logCopy) logCopy.onclick = copyAutomixLog;
    var logClr = $("am-log-clear");
    if (logClr) logClr.onclick = clearAutomixLog;

    var outRef = $("am-outputs-refresh");
    if (outRef) outRef.onclick = refreshOutputs;

    var outZip = $("am-outputs-zip");
    if (outZip) outZip.onclick = downloadAllOutputsZip;

    var pickFolder = $("am-save-folder-pick");
    if (pickFolder) pickFolder.onclick = pickSaveFolder;
    var clearFolder = $("am-save-folder-clear");
    if (clearFolder) clearFolder.onclick = clearPickedSaveFolder;
    updateSaveFolderHint();

    var pendingDl = $("am-download-pending-btn");
    if (pendingDl) {
      pendingDl.onclick = function () {
        deliverPendingFilesFromServer(lastPendingFiles.slice());
      };
    }

    document.addEventListener("visibilitychange", function () {
      if (
        document.visibilityState === "visible" &&
        activated &&
        usePolling &&
        lastPendingFiles.length &&
        !delivering
      ) {
        schedulePendingAutoDeliver(lastPendingFiles.slice());
      }
    });

    window.addEventListener("beforeunload", stopLiveUpdates);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && activated && usePolling) {
        pollOnce();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
