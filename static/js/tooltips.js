/**
 * Tooltip text aligned with SAMSEL V3 PRO TooltipHelper (multi-line, emoji).
 * Elements use data-tip="key"; initSamselTooltips() wires hover/focus.
 */
(function () {
  window.SAMSEL_TIPS = {
    trim_silence:
      "✂️ TRIM SILENCE - Remove quiet parts from beginning/end\n1. Select audio files\n2. Choose output folder (or download)\n3. Set method / threshold / MP3 bitrate\n4. Click Trim\n5. Files save as name_trimmed.mp3 (WAV if MP3 encoder unavailable)\n\n⚠️ Originals are not modified",
    threshold_slider:
      "Silence threshold (dB, relative to peak in each file)\n• Low (e.g. -60): aggressive — trim more quiet audio\n• -40: typical default\n• Near 0 or positive: only treat very loud energy as \"sound\" — minimal trim\n\nLower = more trimmed; higher = less trimmed",
    add_trim_files:
      "➕ Select audio files to trim\n1. Click button\n2. Select multiple MP3/WAV/FLAC files\n3. Files appear in list",
    trim_button:
      "START TRIMMING\n1. Add files and output folder (or downloads)\n2. Auto-detect OR fixed seconds; pick MP3 bitrate\n3. Click Trim — files export as _trimmed.mp3 (WAV fallback if needed)",
    trim_output_folder:
      "📂 Output folder (File System Access API)\n• Chrome / Edge: Browse → pick a folder → trimmed MP3s save there\n• Safari / Firefox: not available — each file downloads\n• Originals are never modified",
    trim_method:
      "• Auto (detect): STFT energy vs dB threshold + optional start/end padding (SAMSEL V3 PRO batch trimmer).\n• Fixed: remove exact seconds from the beginning and/or end.",
    trim_web_export:
      "Uses the selected playlist row: decode, sample-wise trim (linear threshold + pad), export MP3 (bitrate from “MP3 bitrate”) to linked folder or download; WAV if the encoder is unavailable.",
    trim_mp3_bitrate:
      "Constant bitrate for trimmed MP3 files (LAME / lamejs in the browser). 192 kbps is a good default. Unsupported sample rates or missing library → automatic WAV fallback.",
    trim_linear_threshold:
      "Silence threshold (linear amplitude 0–1). A sample counts as sound if |sample| > threshold on the first channel. Default 0.01 matches SAMSEL Web.",
    trim_pad_symmetric:
      "Extra audio kept before the first loud sample and after the last loud one (milliseconds), same value at both ends — matches SAMSEL Web Pad (ms).",
    trim_pad:
      "Extra audio kept before the first loud part and after the last loud part (milliseconds). Prevents chopping transients.",
    trim_analysis_frame:
      "STFT window size. Larger = smoother detection, less time resolution.",
    trim_analysis_hop:
      "Hop between analysis frames. Smaller = finer boundary, slower.",
    trim_fixed_start:
      "Exact amount to remove from the beginning of the file (seconds).",
    trim_fixed_end:
      "Exact amount to remove from the end of the file (seconds).",
    playlist:
      "📋 Your track list. Click a track to select it, then press Play.",
    add_file:
      "➕ Add a single audio file to the playlist.\n1. Click button\n2. Select MP3/WAV/FLAC file\n3. Track appears in list",
    add_folder:
      "📁 Add all audio files from a folder.\n1. Click button\n2. Select folder\n3. All supported files load automatically",
    clear_playlist:
      "🗑️ Remove all tracks from playlist.\nWarning: This cannot be undone!",
    bpm_auto_sort:
      "🎵 Analyze BPM (tags first, then short audio scan) and reorder the playlist slow → fast.\nSmoother energy flow for crossfades. May take a while on long lists.",
    bpm_tag_reorder:
      "After adding files, instantly re-order using BPM from tags only.\nTracks without BPM stay at the bottom (original order).",
    play:
      "▶️ Start playing selected track.\n1. Select track from playlist\n2. Click Play\n3. Track plays through speakers",
    play_previous:
      "⏮️ Go to the previous playlist track and play from the start.\n• Repeat All: wraps from first track to last\n• Repeat Off / One: stops at the first track (message in status bar)",
    play_next:
      "⏭️ Go to the next playlist track and play from the start.\n• Repeat All: wraps to the first track after the last\n• Repeat Off / One: stops after the last track (message in status bar)\nManual skip does not use transition jingles.",
    pause:
      "⏸️ Pause or resume playback.\n- Click to pause current playback\n- Click again to resume from same spot",
    stop:
      "⏹️ Stop playback and reset to beginning.\n1. Click to stop\n2. Progress returns to 00:00\n3. Ready for next track",
    repeat:
      "🔁 Cycle repeat modes:\n  • Off - Play once then stop\n  • All - Loop entire playlist\n  • One - Repeat current track",
    crossfade_enable:
      "🎚️ Crossfade into the next playlist track before the current one ends.\nUses two decks (overlap + volume blend).",
    crossfade_mode:
      "• Beats: fade length = (beats × 60 ÷ BPM). BPM from file tags if present, else fallback BPM.\n• Seconds: fixed overlap time you set.",
    crossfade_beats:
      "How many beats the overlap lasts (at the effective BPM).",
    crossfade_seconds:
      "How long the incoming and outgoing tracks overlap (seconds).",
    crossfade_bpm_fallback:
      "Used for beat-based crossfade when the file has no BPM tag (typical DJ default ~120).",
    crossfade_equal_power:
      "Equal-power crossfade: outgoing uses cos, incoming uses sin (quarter-circle).\nKeeps summed energy steadier than a straight linear fade (less dip in the middle).",
    jingle_enable:
      "Play a short jingle over transitions: mixed on top during crossfade, or over the start of the next track when a song ends without crossfade.",
    jingle_source:
      "Audio file to play, or a folder of audio files (see \"Random from folder\"). MP3, WAV, FLAC, OGG, etc.",
    jingle_random_folder:
      "If checked, the path above must be a folder: each transition picks a random supported audio file from it.",
    jingle_volume:
      "At 100%, same output level as a full solo track (main volume × this %). Use 0–150% to trim or boost slightly; final output capped at full scale.",
    jingle_mode:
      "🎧 JINGLE MODE - How the jingle plays at transitions:\n• Overlay: Jingle plays ON TOP of transition at full volume (dramatic)\n• Insert: Jingle inserted BETWEEN tracks (creates silent gap)\n• Underlay: Jingle plays UNDER transition at -6dB (subtle, professional blend)\nCombine with 'Jingle Gain' for fine control.\n(Web build: Overlay / Replace main.)",
    jingle_gain:
      "🔊 JINGLE GAIN - Fine-tune jingle volume with dB offset:\n• 0 dB: Normal level (no change)\n• +3 dB: Louder (~40% increase)\n• +6 dB: Louder (2× amplitude)\n• -3 dB: Quieter (~30% decrease)\n• -6 dB: Quieter (half amplitude)\nWorks with Volume % slider. Underlay also applies -6dB.",
    hotcue:
      "🔗 HOTCUE - Save & Jump to position\n1. Play track to desired position\n2. Click C1-C8 to SAVE hotcue at current time\n3. Click same button AGAIN to JUMP to that saved position",
    hotcue_set:
      "Save hotcue at current playhead (quantized to beat when BPM is known).",
    hotcue_go:
      "Jump to saved hotcue position.",
    loop_in:
      "🎚️ SET LOOP START POINT\n1. Play track to where you want loop to start\n2. Click 'In' button\n3. Start point is saved",
    loop_out:
      "🎚️ SET LOOP END POINT\n1. Must have clicked 'In' first\n2. Play to where you want loop to end\n3. Click 'Out' button",
    clear_loop:
      "❌ CLEAR LOOP\nRemove current loop.",
    loop_beats_dj:
      "Matches SAMSEL DJ GUI Pro: Loop beats length, then Loop On / Loop Off.\nLoop On: from the current playhead, snap to the nearest beat and loop that many beats (BPM from tags or “BPM if untagged”).\nLoop Off: stop looping.",
    roll_beats_dj:
      "Matches SAMSEL DJ GUI Pro slip roll: same beat-length window as the engine’s enable_roll_beats.\nRoll On: loop that many beats while a hidden timeline keeps moving; Roll Off: jump to where the track would be.\nBPM from tags or “BPM if untagged”.",
    load_lyrics: "📖 Load a .lrc file with synced lyrics.",
    download_lyrics:
      "⬇️ Fetch lyrics from lrclib.net for each playlist track and save as SameName.lrc (only when you click this).",
    lyrics_display: "🎤 Real-time lyrics display.",
    lyrics_autoload:
      'When enabled, loads lyrics when a track starts: (1) embedded tag text if present, (2) else SameName.lrc beside the audio, (3) else Foobar-style "Artist - Title.lrc" in the same folder (from tags; artist: strip \\ and /). Foobar2000 only: if "Import text file" fails with a path containing folder\\\\file, your format adds an extra \\ after %_folderpath% — use e.g. %_folderpath%%title%.lrc when the folder token already ends with \\, or $replace() to normalize.',
    lyrics_sync_offset:
      "Adds to playback time for lyric matching (±10000 ms).\n• Lyrics change before you hear that line (e.g. intro / early highlight): use negative ms.\n• Lyrics lag behind: use positive ms.\nSaved on exit.",
    lyrics_foobar_chk:
      "Foobar2000: %_folderpath%\\$trim($replace($replace(%artist%,'\\',''),'/','')) - %title%.lrc",
    eq_open:
      "🎛️ 10-band EQ (−12 … +20 dB per band), bands log-spaced ~30 Hz … 18 kHz. Each row: frequency · horizontal slider · dB readout. When any band is non-zero, decoded audio is filtered and played via the EQ path. Bypassed during crossfade (two-deck mix). Desktop: Qt multimedia FFmpeg backend.\n(Web: Web Audio peaking filters.)",
    eq_flat: "Reset all EQ bands to 0 dB (flat response).",
    metadata_display: "📋 Shows complete track information.",
    output_device:
      "🔊 Output device for playback (and EQ).\n• Bluetooth / AirPods: pick the **Stereo** or **Headphones** entry for music—not **Headset** or **Hands-Free** (those use the phone-call profile: low quality, odd timing).\n• If sound stops after reconnecting, choose the device again or press Play.\n• Bluetooth adds latency; use Lyrics **Sync offset** if lines drift.",
    progress_slider: "⏱️ Seek to specific time in track.",
    time_display: "⏱️ Current playback time.",
    duration_display: "⏱️ Total track duration.",
    volume_slider: "🔊 Adjust playback volume.",
    bpm_if_untagged:
      "Fallback BPM for beat loops, roll, and crossfade math when the file has no BPM tag (same role as desktop “BPM if untagged”).",
    jingle_at_crossfade:
      "Mix the jingle on top while the outgoing and incoming tracks crossfade.",
    jingle_at_hard_cut:
      "When a track ends without crossfade, start the next song and mix the jingle on top from the start.",
    jingle_play_test: "Preview the loaded jingle file through the jingle layer.",
    jingle_stop_test: "Stop jingle preview.",
    lyrics_paste: "Paste lyrics or LRC text from the clipboard into the editor.",
    lyrics_folder:
      "Pick a folder of .lrc files to pair with playlist tracks (flexible name matching).",
    skin_combo: "Choose a visual theme (saved with window layout).",
    skin_label: "Application color theme",
    brand_logo: "SAMSEL MP3 PLAYER PRO",
    brand_title:
      "SAMSEL MP3 PLAYER PRO - Professional Audio Suite\nv4.2.0 + Enhanced Jingle Support",
    tab_play: "Playlist, transport, crossfade, jingle, embedded lyrics preview.",
    tab_cues: "Hot cues, manual loop, beat loop / slip roll.",
    tab_lyrics: "LRC load, folder pairing, sync offset, auto-load.",
    tab_eq: "10-band graphic EQ.",
    tab_trim:
      "Silence trim: V3 PRO layout — playlist quick MP3 export, batch Auto/Fixed trimmer, MP3 bitrate, file queue, folder or downloads, trim log.",
    tab_info: "Track metadata and parity notes.",
    conn_pill: "Static files or API health when served with uvicorn.",
    phone_lan_banner:
      "How to open SAMSEL on your phone: use your PC's LAN IP (shown here), not 127.0.0.1. Allow port 8765 in Windows Firewall if needed.",
    tab_automix:
      "Downloader runs on the PC. Home Wi‑Fi: SAMSEL_AUTOMIX_LAN=1. Cloudflare/internet: tunnel + SAMSEL_AUTOMIX_ALLOW_REMOTE=1 + SAMSEL_AUTOMIX_TOKEN (or SAMSEL_AUTOMIX_NO_TOKEN=1 — insecure). Phones use polling for the live log.",
    am_browse: "CSV: pick a file to upload. Folder scan: type a server path. Single/playlist: paste URL or query.",
    am_add_job: "Save settings and enqueue this source. The worker starts automatically when you open the Downloader (same as the desktop app); use Stop/Start if you need to pause the queue.",
    am_upload_csv: "Upload a CSV to the server temp folder and enqueue it as a batch job.",
    am_worker_start: "Start the background worker thread to process the queue.",
    am_worker_stop: "Request stop (current yt-dlp may terminate).",
    am_save: "Write options to ~/.automix_downloader_v2.json (shared with the desktop app).",
    am_open_out: "Open the output folder in Explorer / Finder (server PC only).",
    am_launch_tk: "Open the original Tkinter Downloader window (optional).",
    am_token:
      "If the server requires a token (SAMSEL_AUTOMIX_TOKEN without NO_TOKEN), type the same secret here and Save — stored only on this device.",
    am_outputs_refresh:
      "List audio and .lrc files under the server output folder so you can download them to this phone or PC browser.",
    am_outputs_zip:
      "Builds one downloader_outputs.zip on the server (same file list as below) — works in every mobile browser. After download, use Share or Save to Files to pick a folder; unzip there to get all tracks.",
    am_save_folder_pick:
      "Chrome / Edge only: pick a folder once; then singles and ZIP write there directly. Other browsers: use Download all as ZIP + Share / Save to Files.",
    am_save_folder_clear:
      "Forget the chosen folder and go back to normal download / Share behavior for the next saves.",
    am_log_copy: "Copy the visible log to the clipboard (works on most phones in HTTPS or localhost).",
    am_log_clear: "Clear the on-screen log on this session (does not cancel running jobs).",
  };

  var tipEl = null;
  var hideTimer = null;

  function ensureTipEl() {
    if (!tipEl) tipEl = document.getElementById("samsel-tip");
    return tipEl;
  }

  function positionTip(el, target) {
    var pad = 8;
    var r = target.getBoundingClientRect();
    el.style.left = "0px";
    el.style.top = "0px";
    var tw = el.offsetWidth;
    var th = el.offsetHeight;
    var x = r.left + pad;
    var y = r.bottom + 6;
    if (x + tw > window.innerWidth - 8) x = Math.max(8, window.innerWidth - tw - 8);
    if (y + th > window.innerHeight - 8) y = Math.max(8, r.top - th - 6);
    el.style.left = x + "px";
    el.style.top = y + "px";
  }

  function showTip(text, target) {
    var el = ensureTipEl();
    if (!el || !text) return;
    clearTimeout(hideTimer);
    el.textContent = text;
    el.removeAttribute("hidden");
    el.setAttribute("aria-hidden", "false");
    el.style.visibility = "hidden";
    el.style.display = "block";
    positionTip(el, target);
    el.style.visibility = "visible";
  }

  function hideTip() {
    var el = ensureTipEl();
    if (!el) return;
    el.style.display = "none";
    el.style.visibility = "hidden";
    el.setAttribute("hidden", "");
    el.setAttribute("aria-hidden", "true");
    el.textContent = "";
  }

  window.initSamselTooltips = function (root) {
    root = root || document;
    var nodes = root.querySelectorAll("[data-tip]");
    for (var i = 0; i < nodes.length; i++) {
      (function (node) {
        if (node.getAttribute("data-tip-wired") === "1") return;
        var key = node.getAttribute("data-tip");
        var text = window.SAMSEL_TIPS[key];
        if (!text) return;
        node.setAttribute("data-tip-wired", "1");
        if (node.hasAttribute("title")) node.removeAttribute("title");
        node.addEventListener("mouseenter", function () {
          showTip(text, node);
        });
        node.addEventListener("mouseleave", function () {
          hideTimer = setTimeout(hideTip, 100);
        });
        node.addEventListener("focus", function () {
          showTip(text, node);
        });
        node.addEventListener("blur", function () {
          hideTip();
        });
      })(nodes[i]);
    }
  };
})();
