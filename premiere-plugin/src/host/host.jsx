/*
 * ISTV Reel Tool — ExtendScript host layer for Premiere Pro.
 *
 * This is the half of the plugin that talks to Premiere's scripting DOM. The
 * HTML panel (src/panel/panel.js) does the AI work (audio export → backend transcribe →
 * Claude reel selection → caption timing) and then hands each reel here to be
 * BUILT INSIDE PREMIERE:
 *
 *   ISTV.getActiveSource()   → tells the panel which media file to transcribe
 *   ISTV.buildReels(json)    → for each reel, create a 9:16 sequence, place the
 *                              cut-sheet spans, apply the vertical reframe, and
 *                              lay down karaoke captions (see captions.jsx).
 *
 * Everything is non-destructive: reels are new sequences referencing the master
 * clip. Premiere (Media Encoder) renders them — there is no FFmpeg render step.
 *
 * NOTE ON PORTABILITY: Premiere's ExtendScript API has drifted across versions
 * (sequence creation, Motion property indices, MOGRT import). The code below is
 * written defensively with fallbacks and is documented where a given Premiere
 * build may need a tweak. See premiere-plugin/README.md → "Verify in Premiere".
 */

// NOTE: json2.js (JSON polyfill) and captions.jsx (ISTV_Captions) are loaded
// explicitly by the panel (src/panel/panel.js → loadHost) via $.evalFile with absolute
// paths BEFORE any ISTV function runs. We intentionally do NOT use //@include
// here because the ExtendScript preprocessor include directive is not reliably
// honored when CEP loads a ScriptPath, which previously left JSON undefined and
// made every ISTV call throw.

// Implicit global (no `var`) so it persists globally regardless of the scope
// $.evalFile runs in — matches json2.js's JSON and captions.jsx's ISTV_Captions.
ISTV = (function () {

  // ── low-level helpers ──────────────────────────────────────────────────────

  function log(msg) {
    $.writeln("[ISTV] " + msg);
  }

  function ok(data) {
    return JSON.stringify({ ok: true, data: data === undefined ? null : data });
  }
  function err(message, detail) {
    return JSON.stringify({ ok: false, error: String(message), detail: detail ? String(detail) : "" });
  }

  function timeAt(seconds) {
    var t = new Time();
    t.seconds = seconds;
    return t;
  }

  /** Find a QE-independent projectItem for a media path; import it if missing. */
  function findOrImportItem(mediaPath) {
    var existing = findItemByPath(app.project.rootItem, mediaPath);
    if (existing) return existing;
    var before = countItems(app.project.rootItem);
    app.project.importFiles([mediaPath], true, app.project.rootItem, false);
    // importFiles is synchronous for local files; re-scan for the new item.
    var found = findItemByPath(app.project.rootItem, mediaPath);
    if (!found && countItems(app.project.rootItem) > before) {
      found = lastImportedItem(app.project.rootItem);
    }
    return found;
  }

  function normPath(p) {
    return String(p || "").replace(/\\/g, "/").toLowerCase();
  }

  function findItemByPath(bin, mediaPath) {
    var target = normPath(mediaPath);
    for (var i = 0; i < bin.children.numItems; i++) {
      var item = bin.children[i];
      if (item.type === ProjectItemType.BIN) {
        var deep = findItemByPath(item, mediaPath);
        if (deep) return deep;
      } else {
        var mp = "";
        try {
          mp = item.getMediaPath();
        } catch (e) {
          mp = "";
        }
        if (mp && normPath(mp) === target) return item;
      }
    }
    return null;
  }

  function countItems(bin) {
    var n = 0;
    for (var i = 0; i < bin.children.numItems; i++) {
      var item = bin.children[i];
      n += item.type === ProjectItemType.BIN ? countItems(item) : 1;
    }
    return n;
  }

  function lastImportedItem(bin) {
    var last = null;
    for (var i = 0; i < bin.children.numItems; i++) {
      var item = bin.children[i];
      if (item.type === ProjectItemType.BIN) {
        var deep = lastImportedItem(item);
        if (deep) last = deep;
      } else {
        last = item;
      }
    }
    return last;
  }

  // ── public: describe the media to transcribe ────────────────────────────────

  /**
   * The interview to transcribe is the master footage the editor has on their
   * timeline. We read the first video clip of the active sequence and return its
   * source media path (the panel ffprobes it for fps/size/duration). If there is
   * no active sequence, ask the editor to open the interview in one.
   */
  function getActiveSource() {
    try {
      var seq = app.project.activeSequence;
      if (!seq) {
        return err("No active sequence. Open your interview in a sequence (or drag the clip to a new sequence), then try again.");
      }
      var clip = firstVideoClip(seq);
      if (!clip) {
        return err("The active sequence has no video clip on V1. Add your interview footage to the timeline first.");
      }
      var item = clip.projectItem;
      var mediaPath = "";
      try {
        mediaPath = item.getMediaPath();
      } catch (e) {
        mediaPath = "";
      }
      if (!mediaPath) return err("Could not resolve the source file path for the clip on V1.");
      return ok({
        name: item.name,
        path: mediaPath,
        sequenceName: seq.name,
      });
    } catch (e) {
      return err("getActiveSource failed", e.toString());
    }
  }

  function firstVideoClip(seq) {
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      var track = seq.videoTracks[t];
      if (track.clips.numItems > 0) return track.clips[0];
    }
    return null;
  }

  // ── public: build reels as 9:16 sequences ───────────────────────────────────

  /**
   * payload (JSON string):
   * {
   *   sourcePath: "C:/.../interview.mp4",
   *   canvas: { width:1080, height:1920 },
   *   presetPath: "" | "C:/.../ISTV_Vertical_1080x1920.sqpreset",
   *   captionMode: "karaoke" | "native" | "none",
   *   binName: "ISTV Reels",
   *   reels: [ {
   *     id, index, title,
   *     segments: [ { startSec, endSec, role } ],       // SOURCE seconds
   *     reframe:  { cropX, cropY, zoom },
   *     captionBlocks: [ { start_time_seconds, end_time_seconds, text,
   *                        words:[{word, localTime, end}] } ],   // REEL seconds
   *   } ]
   * }
   */
  function buildReels(payloadJson) {
    try {
      var payload = JSON.parse(payloadJson);
      if (!app.project) return err("No project is open.");
      var master = findOrImportItem(payload.sourcePath);
      if (!master) return err("Could not find or import the source file: " + payload.sourcePath);

      var bin = ensureBin(payload.binName || "ISTV Reels");
      var canvas = payload.canvas || { width: 1080, height: 1920 };
      var built = [];
      var warnings = [];

      for (var i = 0; i < payload.reels.length; i++) {
        var reel = payload.reels[i];
        // Isolate each reel: one reel's failure must not abort the whole batch.
        try {
          built.push(buildOneReel(master, reel, canvas, payload, bin, warnings));
        } catch (reelErr) {
          built.push({ title: reel.title, ok: false, error: reelErr.toString() });
        }
      }

      var out = { built: built, warnings: warnings };
      // Host-side diagnostic log (independent of the panel) so caption/build
      // results are always inspectable even if the panel didn't reload.
      try {
        var lf = new File(Folder.temp.fsName + "/istv-host-build.json");
        lf.encoding = "UTF-8";
        lf.open("w");
        lf.write(JSON.stringify(out));
        lf.close();
      } catch (logErr) {
        /* ignore */
      }
      return ok(out);
    } catch (e) {
      return err("buildReels failed", e.toString());
    }
  }

  function ensureBin(name) {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
      var it = root.children[i];
      if (it.type === ProjectItemType.BIN && it.name === name) return it;
    }
    return root.createBin(name);
  }

  function reelSequenceName(reel) {
    return "Reel " + padNum(reel.index || reel.id || 1) + " - " + sanitize(reel.title || "Reel");
  }

  // Premiere counts time in 254,016,000,000 ticks/second. Snap to the exact
  // NTSC/standard frame durations so a 23.976/29.97 source doesn't drift.
  function fpsToTicks(fps) {
    var PER_SEC = 254016000000;
    var std = [
      { fps: 23.976, ticks: 10594584000 }, // 24000/1001
      { fps: 24, ticks: 10584000000 },
      { fps: 25, ticks: 10160640000 },
      { fps: 29.97, ticks: 8475667200 },   // 30000/1001
      { fps: 30, ticks: 8467200000 },
      { fps: 50, ticks: 5080320000 },
      { fps: 59.94, ticks: 4237833600 },   // 60000/1001
      { fps: 60, ticks: 4233600000 },
    ];
    for (var i = 0; i < std.length; i++) {
      if (Math.abs(fps - std[i].fps) < 0.05) return std[i].ticks;
    }
    return Math.round(PER_SEC / fps);
  }

  /**
   * The true "main video" frame rate — read straight from the master clip the way
   * Premiere itself interprets it (getFootageInterpretation). This is authoritative
   * and varies per project/camera (23.976 / 25 / 29.97 / 30 / 50 / 60 …), so we
   * never assume a fixed rate. Falls back to the panel-probed fps, then to 0.
   */
  function sourceFrameRate(master, fallbackFps) {
    try {
      if (master && typeof master.getFootageInterpretation === "function") {
        var interp = master.getFootageInterpretation();
        if (interp && interp.frameRate && interp.frameRate > 0) return Number(interp.frameRate);
      }
    } catch (e) {}
    return fallbackFps && fallbackFps > 0 ? fallbackFps : 0;
  }

  /**
   * Force the reel sequence to exactly canvas (1080x1920) at the SOURCE frame
   * rate. The built-in "9x16 30 fps" preset would otherwise conform e.g. a
   * 23.976fps interview to 30fps and make playback judder ("frames to and fro").
   * Done on the empty sequence before any clips are placed. Fully defensive — a
   * build that can't read/write settings still works, just at the preset's rate.
   */
  function normalizeSequenceSettings(seq, canvas, fps, warnings) {
    try {
      var s = seq.getSettings();
      if (!s) return;
      if (canvas && canvas.width) s.videoFrameWidth = canvas.width;
      if (canvas && canvas.height) s.videoFrameHeight = canvas.height;
      if (fps && fps > 0) {
        var t = new Time();
        t.ticks = String(fpsToTicks(fps));
        s.videoFrameRate = t;
      }
      try { s.videoPixelAspectRatio = 1.0; } catch (ePar) {}
      seq.setSettings(s);
    } catch (e) {
      if (warnings) warnings.push("Could not match sequence to source frame rate: " + e.toString());
    }
  }

  function buildOneReel(master, reel, canvas, payload, bin, warnings) {
    var seqName = reelSequenceName(reel);
    var seq = createVerticalSequence(seqName, canvas, payload.presetPath, warnings);
    if (!seq) return { title: reel.title, ok: false, error: "sequence creation failed" };

    moveSequenceToBin(seq, bin);
    // Match raster + frame rate to the SOURCE clip before placing clips (no conform
    // judder). Prefer the rate Premiere reads from the master; fall back to the
    // panel-probed fps. Frame rate is never fixed — it follows the main video.
    var srcFps = sourceFrameRate(master, payload.fps);
    normalizeSequenceSettings(seq, canvas, srcFps, warnings);

    // Place each cut-sheet span end-to-end on V1/A1 (a "cut" = a new insertion).
    var playhead = 0; // reel-timeline seconds
    var vTrack = seq.videoTracks[0];
    var aTrack = seq.audioTracks[0];
    var placed = [];
    for (var s = 0; s < reel.segments.length; s++) {
      var span = reel.segments[s];
      var dur = Math.max(0, span.endSec - span.startSec);
      if (dur <= 0) continue;
      setItemInOut(master, span.startSec, span.endSec);
      // insertClip appends at the given reel time on the track.
      try {
        vTrack.insertClip(master, timeAt(playhead));
      } catch (e1) {
        // Some builds only expose overwriteClip; fall back to it.
        vTrack.overwriteClip(master, timeAt(playhead));
      }
      placed.push({ at: playhead, dur: dur, span: span });
      playhead += dur;
    }

    // Apply the 9:16 reframe to every placed video clip (uniform per reel).
    applyReframeToTrack(vTrack, reel.reframe || {}, master, canvas, warnings);

    // Captions.
    var captionResult = { mode: payload.captionMode || "karaoke", count: 0 };
    if (payload.captionMode !== "none" && reel.captionBlocks && reel.captionBlocks.length) {
      captionResult = ISTV_Captions.apply(seq, reel.captionBlocks, {
        mode: payload.captionMode || "karaoke",
        canvas: canvas,
        mogrtPath: payload.mogrtPath || "",
        reelName: seqName,
      });
      if (captionResult.warning) warnings.push(seqName + ": " + captionResult.warning);
    }

    // Stamp reel metadata onto the sequence via a description marker so the
    // editor can see the AI's caption/hashtags/why-it-works without leaving PP.
    if (reel.metadata) addMetadataMarker(seq, reel.metadata);

    return {
      title: reel.title,
      sequenceName: seqName,
      ok: true,
      durationSec: Math.round(playhead * 100) / 100,
      segments: placed.length,
      captions: captionResult,
    };
  }

  /**
   * Create a vertical sequence. Preferred path: a bundled .sqpreset via QE
   * (exact 9:16 raster). Fallback: createNewSequence (inherits project defaults)
   * + a warning telling the editor to confirm the frame size / run Auto Reframe.
   */
  function createVerticalSequence(name, canvas, presetPath, warnings) {
    // Preferred, no-dialog path: QE newSequence with a real .sqpreset file gives
    // an exact 9:16 raster silently. The panel auto-detects Premiere's built-in
    // "Social Media Portrait 9x16" preset, so presetPath is normally set.
    if (presetPath) {
      try {
        app.enableQE();
        var beforeId = app.project.activeSequence ? app.project.activeSequence.sequenceID : "";
        qe.project.newSequence(name, presetPath);
        var made = app.project.activeSequence;
        // QE makes the new sequence active; accept it by name or by changed id.
        if (made && (made.name === name || made.sequenceID !== beforeId)) return made;
      } catch (e) {
        warnings.push('"' + name + '": preset sequence creation failed (' + e.toString() + ").");
      }
    } else {
      warnings.push('"' + name + '": no 9:16 preset found; using project default raster.');
    }
    // Fallback WITHOUT the picker: createNewSequence's 2nd arg is a preset path;
    // passing one avoids the New Sequence dialog. With none, an empty string lets
    // older builds create silently (newer ones may prompt once).
    try {
      var seq = app.project.createNewSequence(name, presetPath || "");
      return app.project.activeSequence || seq;
    } catch (e2) {
      warnings.push("createNewSequence failed: " + e2.toString());
      return null;
    }
  }

  function moveSequenceToBin(seq, bin) {
    try {
      // The sequence has a backing projectItem; move it under our bin.
      var pi = seq.projectItem || sequenceProjectItem(seq);
      if (pi && bin) pi.moveBin(bin);
    } catch (e) {
      /* non-fatal — sequence just stays at the project root */
    }
  }

  function sequenceProjectItem(seq) {
    var root = app.project.rootItem;
    return findSequenceItem(root, seq.name);
  }
  function findSequenceItem(bin, name) {
    for (var i = 0; i < bin.children.numItems; i++) {
      var it = bin.children[i];
      if (it.type === ProjectItemType.BIN) {
        var d = findSequenceItem(it, name);
        if (d) return d;
      } else if (it.name === name) {
        return it;
      }
    }
    return null;
  }

  function setItemInOut(item, startSec, endSec) {
    try {
      item.setInPoint(timeAt(startSec), 4); // 4 = both video+audio media types
      item.setOutPoint(timeAt(endSec), 4);
    } catch (e) {
      // Older signature: separate media-type calls.
      try {
        item.setInPoint(timeAt(startSec), 1);
        item.setOutPoint(timeAt(endSec), 1);
        item.setInPoint(timeAt(startSec), 2);
        item.setOutPoint(timeAt(endSec), 2);
      } catch (e2) {
        /* leave full clip */
      }
    }
  }

  // ── reframe (Motion scale/position to fill 9:16) ─────────────────────────────

  /**
   * Scale/position the source so it fills the vertical frame. We fill by HEIGHT
   * (typical for a horizontal interview → vertical reel), then use cropX/cropY to
   * choose which slice of the wide frame is visible (0..1 → left..right / top..
   * bottom). zoom multiplies the fill scale. This mirrors the FFmpeg engine's
   * cover+crop semantics so reels frame the same as the old pipeline.
   */
  function applyReframeToTrack(vTrack, reframe, master, canvas, warnings) {
    var srcW = 0, srcH = 0;
    try {
      var vi = master.getFootageInterpretation ? null : null;
    } catch (e) {}
    // We can't always read source raster from ExtendScript reliably; assume a
    // 16:9 source unless the panel provided real dimensions in reframe.src*.
    srcW = reframe.srcW || 1920;
    srcH = reframe.srcH || 1080;

    // Fill by height: match the source height to the canvas height. Premiere's
    // Scale is a percentage of the clip's native size as fit to the frame.
    var scalePct = (canvas.height / srcH) * 100;
    // If filling height leaves width narrower than the canvas, fill width instead.
    var scaledW = srcW * (scalePct / 100);
    if (scaledW < canvas.width) scalePct = (canvas.width / srcW) * 100;
    scalePct = scalePct * (reframe.zoom || 1);

    for (var c = 0; c < vTrack.clips.numItems; c++) {
      var clip = vTrack.clips[c];
      var motion = findComponent(clip, "Motion");
      if (!motion) continue;
      setProp(motion, ["Scale"], scalePct);
      // Position is normalized in Premiere (0.5,0.5 = centered). Shift horizontally
      // by (cropX-0.5) worth of the overshoot so the chosen slice is centered.
      var overshootX = Math.max(0, (srcW * (scalePct / 100)) - canvas.width) / canvas.width;
      var overshootY = Math.max(0, (srcH * (scalePct / 100)) - canvas.height) / canvas.height;
      var posX = 0.5 + (0.5 - (reframe.cropX != null ? reframe.cropX : 0.5)) * overshootX;
      var posY = 0.5 + (0.5 - (reframe.cropY != null ? reframe.cropY : 0.5)) * overshootY;
      setPositionProp(motion, posX, posY, warnings);
    }
  }

  function findComponent(clip, displayName) {
    try {
      for (var i = 0; i < clip.components.numItems; i++) {
        if (clip.components[i].displayName === displayName) return clip.components[i];
      }
    } catch (e) {}
    return null;
  }

  function setProp(component, names, value) {
    try {
      for (var i = 0; i < component.properties.numItems; i++) {
        var p = component.properties[i];
        for (var n = 0; n < names.length; n++) {
          if (p.displayName === names[n]) {
            p.setValue(value, true);
            return true;
          }
        }
      }
    } catch (e) {}
    return false;
  }

  function setPositionProp(motion, x, y, warnings) {
    // Position is a 2-value property; setValue expects an array [x,y] on most
    // builds. Some builds want separate Horizontal/Vertical props.
    var done = false;
    try {
      for (var i = 0; i < motion.properties.numItems; i++) {
        if (motion.properties[i].displayName === "Position") {
          motion.properties[i].setValue([x, y], true);
          done = true;
          break;
        }
      }
    } catch (e) {}
    if (!done && warnings) warnings.push("Could not set Position; reframe applied scale only.");
  }

  // ── metadata marker ─────────────────────────────────────────────────────────

  function addMetadataMarker(seq, meta) {
    try {
      var markers = seq.markers;
      var m = markers.createMarker(0);
      m.name = "ISTV: " + (meta.title || "Reel");
      var lines = [];
      if (meta.spokenHook) lines.push("HOOK: " + meta.spokenHook);
      if (meta.caption) lines.push("CAPTION: " + meta.caption);
      if (meta.hashtags && meta.hashtags.length) lines.push("TAGS: " + meta.hashtags.join(" "));
      if (meta.whyItWorks) lines.push("WHY: " + meta.whyItWorks);
      m.comments = lines.join("\n");
    } catch (e) {
      /* markers are a nicety; ignore failures */
    }
  }

  // ── misc ─────────────────────────────────────────────────────────────────────

  function padNum(n) {
    n = parseInt(n, 10) || 0;
    return n < 10 ? "0" + n : String(n);
  }
  function sanitize(s) {
    return String(s || "").replace(/[\\\/:*?"<>|]/g, "").substring(0, 60);
  }
  function newGuid() {
    // Premiere accepts an empty string for an auto-generated ID on most builds,
    // but a stable pseudo-GUID avoids collisions on the ones that don't.
    var s = "";
    var hex = "0123456789abcdef";
    for (var i = 0; i < 32; i++) s += hex.charAt(Math.floor(Math.random() * 16));
    return s;
  }

  /** Attach a low-res proxy to the source master so 4K plays back smoothly.
   *  Exports still use the full-res original. payload: { sourcePath, proxyPath }. */
  function attachProxy(payloadJson) {
    try {
      var p = JSON.parse(payloadJson);
      var master = findOrImportItem(p.sourcePath);
      if (!master) return err("Source clip not found in project: " + p.sourcePath);
      if (typeof master.attachProxy !== "function") {
        return err("This Premiere build cannot attach proxies from script — set it via File ▸ ... instead.");
      }
      var attached = master.attachProxy(String(p.proxyPath), 0); // 0 = attach as PROXY (not hi-res)
      // Best-effort: turn proxy playback on so it's smooth without a manual toggle.
      var enabled = false;
      try { app.enableProxies = true; enabled = true; } catch (e1) {}
      try { if (!enabled && app.project && app.project.setEnableProxies) { app.project.setEnableProxies(1); enabled = true; } } catch (e2) {}
      return ok({ attached: !!attached, autoEnabled: enabled, proxyPath: p.proxyPath });
    } catch (e) {
      return err("attachProxy failed", e.toString());
    }
  }

  function ping() {
    return ok({ app: app.appName || "PPRO", version: app.version, hasProject: !!app.project });
  }

  return {
    ping: ping,
    getActiveSource: getActiveSource,
    buildReels: buildReels,
    attachProxy: attachProxy,
  };
})();
