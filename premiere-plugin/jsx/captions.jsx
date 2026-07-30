/*
 * ISTV Reel Tool — caption placement inside Premiere.
 *
 * PRIMARY path (opts.xmlText set — this is what js/main.js now always sends):
 * applyGraphicsXml — import a plain Final Cut Pro 7 XML sequence (built in
 * js/premiereXml.js) whose clips use Premiere's own built-in "GraphicAndType"
 * filter with the caption text baked into the "Source Text" parameter, then
 * nest that imported sequence as one clip on the reel. Pattern taken from the
 * open-source JorianWoltjer/AutoCaptions tool. No MOGRT file, no
 * sequence.importMGT() (missing on some builds), no runtime property
 * reflection to guess which component holds "the text field" — the XML
 * already has everything baked in, so the only Premiere calls left at
 * runtime are importFiles() and insertClip(), both already proven elsewhere
 * in this codebase (applyNative below; buildOneReel's footage placement).
 *
 * LEGACY paths (used only if the caller doesn't supply xmlText):
 *
 *   "karaoke"  One Motion Graphics (MOGRT) instance per caption block. Feed it
 *              1-word blocks for word-by-word "pop", 2-word for chunked.
 *              Requires a bundled text MOGRT (see README → captions.mogrt).
 *              Kept for editors who already built one; no longer the default
 *              because it depends on importMGT + guessing the MOGRT's text
 *              property by name, both of which vary across Premiere builds.
 *
 *   "native"   Writes a standard .srt next to the project and imports it as a
 *              bin item (editor drags it onto the caption track manually).
 *
 * Why not recolor one word inside a shared line for true karaoke: neither
 * path can — a MOGRT text field can't recolor a sub-range of its own text
 * from script, and the GraphicAndType "Source Text" param is one opaque blob
 * per clip, not per-character. Both paths are phrase-by-phrase pop captions,
 * not an in-line highlight sweep (see the panel's own note about this).
 */

// Implicit global (no `var`) so it persists to the global scope no matter what
// scope $.evalFile runs in — the same pattern json2.js uses for JSON. With `var`
// it stayed local to the loader and host.jsx saw "ISTV_Captions is undefined".
ISTV_Captions = (function () {

  function apply(seq, blocks, opts) {
    opts = opts || {};
    if (opts.xmlText) return applyGraphicsXml(seq, opts.xmlText, opts);
    var mode = opts.mode || "karaoke";
    if (mode === "native") return applyNative(seq, blocks, opts);
    return applyKaraoke(seq, blocks, opts);
  }

  // ── graphics via FCP XML import (primary path) ──────────────────────────────

  /**
   * Write the pre-rendered XML (js/premiereXml.js) to a temp file, import it
   * (Premiere reads it as a new sequence project item), then nest that
   * sequence as one clip on a fresh top video track of the reel — it reads as
   * a transparent overlay wherever it has no clip, since an empty span on a
   * Premiere video track shows whatever is on the tracks below.
   */
  function applyGraphicsXml(seq, xmlText, opts) {
    opts = opts || {};
    var diag = { mode: "graphics", count: 0 };
    try {
      // Reserve the track BEFORE importing the XML: a freshly built reel
      // sequence commonly has only one video track (already full of
      // footage), so there's nowhere to nest captions — the prior symptom of
      // "imported but never attached". Adding a track needs QE, which
      // operates on "the active sequence" rather than a specific reference,
      // so this has to happen while `seq` is still definitely active —
      // importFiles() below may switch the active sequence to the newly
      // imported caption sequence, so this can't be done after that.
      var vIndex = ensureSpareVideoTrack(seq);

      var folder = Folder.temp.fsName;
      var fname = "istv-" + sanitize(opts.reelName || seq.name || "captions") + "-captions.xml";
      var file = new File(folder + "/" + fname);
      file.encoding = "UTF-8";
      file.open("w");
      file.write(xmlText);
      file.close();

      var root = opts.bin || app.project.rootItem;
      var before = countProjectItems(root);
      app.project.importFiles([file.fsName], true, root, false);

      // importFiles() can trigger Premiere's own blocking "Resolve Fonts"
      // dialog (if the XML references a font this build can't resolve) or
      // otherwise finish registering the new project item a beat after the
      // call returns — either way, checking immediately can find nothing yet
      // and bail out, leaving the caption sequence imported but never nested
      // (exactly the "captions not attached to the reel" symptom). Poll
      // briefly instead of assuming synchronous completion.
      var item = waitFor(function () {
        return countProjectItems(root) > before ? lastProjectItem(root) : null;
      });
      if (!item) {
        diag.warning = "Importing the caption XML added no project item after waiting — this Premiere build may not accept this XML, or a dialog (e.g. Resolve Fonts) is still open. Check Premiere; you may need to click OK there and re-run Build.";
        return diag;
      }

      // Insert the SEQUENCE'S OWN PROJECT ITEM directly — Track.insertClip()
      // takes a ProjectItem, and a sequence's ProjectItem works the same way
      // footage's does (nesting a sequence onto another sequence's track has
      // never needed anything more than that). Every previous round routed
      // through app.project.sequences first, to resolve `item` into a
      // Sequence object — and that resolution step was ITSELF the failure
      // every time (confirmed live: app.project.sequences.numItems came back
      // `undefined` for a sequence that had never been manually opened as a
      // tab), which means this direct-insert call was never actually reached
      // or tested before now. Dropping that resolution step entirely.
      // overwriteClip, not insertClip: insertClip performs a ripple/insert
      // edit, which shifts later content to make room for the new clip's
      // duration — placing a ~reel-length caption clip this way risks
      // pushing the reel's own footage/audio later, which would show up as
      // exactly the kind of caption/speech desync ("lag") reported after
      // testing this build. overwriteClip places a clip at an exact time
      // without shifting anything else — the correct edit type for laying
      // an independent graphic onto its own track. insertClip is kept only
      // as a defensive fallback.
      var track = seq.videoTracks[vIndex];
      var before2 = track.clips.numItems;
      try {
        track.overwriteClip(item, timeAt(0));
      } catch (e1) {
        try {
          track.insertClip(item, timeAt(0));
        } catch (e2) {
          diag.warning = "Could not place the caption sequence on the reel's timeline: " + e2.toString() + " [build:direct-insert-v3]";
          return diag;
        }
      }
      var placed = waitFor(function () {
        return track.clips.numItems > before2 ? track.clips[track.clips.numItems - 1] : null;
      });
      if (placed) {
        if (opts.durationSec) trimItemEnd(placed, opts.durationSec);
        diag.count = 1;
      } else {
        diag.warning =
          'Imported "' + fname + '" but it never appeared on the reel\'s track (had ' + before2 + " clip(s) before, " +
          track.clips.numItems + " after) [build:direct-insert-v3]. Drag it onto the reel's timeline manually.";
      }
      return diag;
    } catch (e) {
      diag.warning = "applyGraphicsXml failed: " + e.toString() + " [build:direct-insert-v3]";
      return diag;
    }
  }

  /**
   * Find an empty video track to nest captions onto, ADDING one via QE if
   * every existing track already has footage on it (the common case for a
   * freshly built reel with just V1). QE's addTracks is undocumented and
   * version-dependent (confirmed against Adobe community reports — worked on
   * PPRO 2019, unconfirmed on newer builds) and only operates on "the active
   * sequence", so this only attempts it while `seq` really is the active one;
   * otherwise (or on any failure) it falls back to reusing the top existing
   * track, same as before this fix.
   */
  function ensureSpareVideoTrack(seq) {
    var n = seq.videoTracks.numTracks;
    for (var t = n - 1; t >= 0; t--) {
      if (seq.videoTracks[t].clips.numItems === 0) return t;
    }
    try {
      if (app.project.activeSequence !== seq) return n - 1;
      app.enableQE();
      if (typeof qe === "undefined" || !qe.project) return n - 1;
      var qeSeq = qe.project.getActiveSequence();
      if (!qeSeq || typeof qeSeq.addTracks !== "function") return n - 1;
      qeSeq.addTracks(1, n - 1, 0); // 1 video track, after the last index, no audio track
      return seq.videoTracks.numTracks > n ? seq.videoTracks.numTracks - 1 : n - 1;
    } catch (e) {
      return n - 1;
    }
  }

  function countProjectItems(bin) {
    var n = 0;
    for (var i = 0; i < bin.children.numItems; i++) {
      var it = bin.children[i];
      n += it.type === ProjectItemType.BIN ? countProjectItems(it) : 1;
    }
    return n;
  }

  function lastProjectItem(bin) {
    var last = null;
    for (var i = 0; i < bin.children.numItems; i++) {
      var it = bin.children[i];
      if (it.type === ProjectItemType.BIN) {
        var deep = lastProjectItem(it);
        if (deep) last = deep;
      } else {
        last = it;
      }
    }
    return last;
  }

  /** Poll `check()` (returns a truthy result or null) every 150ms for up to
   *  ~5s — covers importFiles()/track edits that finish a beat after the
   *  call returns, or while a Premiere dialog (e.g. Resolve Fonts) is up. */
  function waitFor(check, timeoutMs) {
    timeoutMs = timeoutMs || 5000;
    var stepMs = 150;
    var elapsed = 0;
    while (elapsed <= timeoutMs) {
      var result = check();
      if (result) return result;
      $.sleep(stepMs);
      elapsed += stepMs;
    }
    return null;
  }

  function timeAt(seconds) {
    var t = new Time();
    t.seconds = seconds;
    return t;
  }

  // ── karaoke via MOGRT ────────────────────────────────────────────────────────

  function applyKaraoke(seq, blocks, opts) {
    if (!opts.mogrtPath) {
      // No template shipped/selected → fall back to native captions so the reel
      // still ships with text, and tell the panel why.
      var nat = applyNative(seq, blocks, opts);
      nat.warning =
        "No caption MOGRT found — wrote native captions instead. Add premiere-plugin/presets/captions.mogrt for karaoke text (see README).";
      return nat;
    }

    // Rich diagnostics so failures are visible in the panel instead of silent.
    var diag = {
      mode: "karaoke",
      count: 0,
      textSet: 0,
      hasImportMGT: typeof seq.importMGT === "function",
      mogrtExists: mgtFileExists(opts.mogrtPath),
      mogrt: baseName(opts.mogrtPath),
    };
    if (!diag.hasImportMGT) {
      diag.warning = "This Premiere build has no sequence.importMGT() — cannot place caption graphics from script.";
      return diag;
    }
    if (!diag.mogrtExists) {
      diag.warning = "Caption MOGRT not found on disk: " + opts.mogrtPath;
      return diag;
    }

    // Forward-slash path is safest for importMGT.
    var mogrt = String(opts.mogrtPath).replace(/\\/g, "/");
    var vIndex = topVideoTrackIndex(seq);
    var track = seq.videoTracks[vIndex];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var start = num(b.start_time_seconds);
      var end = Math.max(start + 0.3, num(b.end_time_seconds));
      var before = track.clips.numItems;
      var item = null;
      try {
        // importMGT(path, insertTimeTicks, videoTrackIndex, audioTrackIndex)
        item = seq.importMGT(mogrt, ticks(start), vIndex, 0);
      } catch (e) {
        if (!diag.warning) diag.warning = "importMGT threw: " + e.toString();
      }
      // Some builds return null even on success — grab the newly-added clip.
      if (!item && track.clips.numItems > before) {
        item = track.clips[track.clips.numItems - 1];
      }
      if (item) {
        diag.count++;
        // Capture the component/property structure of the FIRST caption clip so
        // we can map the text field exactly (written to the host log).
        if (!diag.structure) diag.structure = describeItem(item);
        if (setMgtText(item, b.text, diag)) diag.textSet++;
        trimItemEnd(item, end);
      }
    }
    if (diag.count === 0 && !diag.warning) {
      diag.warning = "importMGT added no graphics (returned null and no new clips appeared).";
    } else if (diag.count > 0 && diag.textSet === 0) {
      diag.warning =
        "Placed " + diag.count + " caption graphics but couldn't auto-set text. Fields seen: [" +
        (diag.fields || "?") + "].";
    }
    return diag;
  }

  /** All candidate components of a track item: the MGT component + every component. */
  function componentsOf(trackItem) {
    var comps = [];
    try {
      if (typeof trackItem.getMGTComponent === "function") {
        var mc = trackItem.getMGTComponent();
        if (mc) comps.push(mc);
      }
    } catch (e) {}
    try {
      for (var i = 0; i < trackItem.components.numItems; i++) comps.push(trackItem.components[i]);
    } catch (e2) {}
    return comps;
  }

  /** Human-readable dump of a clip's components + property names (for the log). */
  function describeItem(trackItem) {
    var out = [];
    out.push("getMGTComponent=" + (typeof trackItem.getMGTComponent));
    var comps = componentsOf(trackItem);
    for (var c = 0; c < comps.length; c++) {
      var cname = "";
      try {
        cname = String(comps[c].displayName || "?");
      } catch (e) {
        cname = "?";
      }
      var props = [];
      try {
        for (var p = 0; p < comps[c].properties.numItems; p++) {
          try {
            props.push(String(comps[c].properties[p].displayName || "?"));
          } catch (e2) {
            props.push("?");
          }
        }
      } catch (e3) {}
      out.push("[" + cname + "] " + props.join(", "));
    }
    return out.join(" || ");
  }

  function setMgtText(trackItem, text, diag) {
    var comps = componentsOf(trackItem);
    var allNames = [];
    // Pass 1: set a property whose name looks like text.
    for (var c = 0; c < comps.length; c++) {
      var props = null;
      try {
        props = comps[c].properties;
      } catch (e) {}
      if (!props) continue;
      for (var p = 0; p < props.numItems; p++) {
        var prop = props[p];
        var nm = "";
        try {
          nm = String(prop.displayName || "");
        } catch (e2) {}
        allNames.push(nm);
        if (/text|caption|subtitle|title|transcript|source|layer/i.test(nm)) {
          if (trySetText(prop, text)) {
            if (diag && !diag.fields) diag.fields = allNames.join(" | ");
            return true;
          }
        }
      }
    }
    // Pass 2: brute force — try every property (non-text props just fail quietly).
    for (var c2 = 0; c2 < comps.length; c2++) {
      var props2 = null;
      try {
        props2 = comps[c2].properties;
      } catch (e3) {}
      if (!props2) continue;
      for (var p2 = 0; p2 < props2.numItems; p2++) {
        if (trySetText(props2[p2], text)) {
          if (diag && !diag.fields) diag.fields = allNames.join(" | ");
          return true;
        }
      }
    }
    if (diag && !diag.fields) diag.fields = allNames.length ? allNames.join(" | ") : "(no props found)";
    return false;
  }

  function trySetText(p, text) {
    // Try the common ways a MOGRT text property accepts a value across PP builds.
    try {
      p.setValue(text, true);
      return verifyText(p, text);
    } catch (e) {}
    try {
      p.setValue(text);
      return verifyText(p, text);
    } catch (e2) {}
    try {
      p.setValue(JSON.stringify({ textEditValue: text }), true);
      return true;
    } catch (e3) {}
    return false;
  }

  // Confirm a set actually stuck (guards against setValue silently no-op'ing on
  // a non-text property that happens not to throw).
  function verifyText(p, text) {
    try {
      var v = p.getValue();
      if (typeof v === "string") return v.indexOf(text) !== -1 || v === text;
    } catch (e) {}
    return true; // can't read back → assume it took
  }

  function trimItemEnd(trackItem, endSec) {
    try {
      var t = new Time();
      t.seconds = endSec;
      trackItem.end = t; // Time object (not a ticks string)
    } catch (e) {
      /* MOGRT keeps default duration if the build won't let us trim it */
    }
  }

  function topVideoTrackIndex(seq) {
    var n = seq.videoTracks.numTracks;
    // Prefer an empty upper track; otherwise use the highest existing one.
    for (var t = n - 1; t >= 0; t--) {
      if (seq.videoTracks[t].clips.numItems === 0) return t;
    }
    return n - 1;
  }

  // ── native captions via SRT import ───────────────────────────────────────────

  function applyNative(seq, blocks, opts) {
    try {
      // Prefer the JS caption master's own SRT text (docToSrt — §2/§6, ms-accurate
      // and template-line-wrapped) when the panel supplies it; buildSrt(blocks)
      // is a fallback for callers that only have block-level data.
      var srt = opts && typeof opts.srtText === "string" && opts.srtText.length ? opts.srtText : buildSrt(blocks);
      var folder = Folder.temp.fsName;
      var name = "istv-" + sanitize(opts.reelName || seq.name || "reel") + ".srt";
      var file = new File(folder + "/" + name);
      file.encoding = "UTF-8";
      file.open("w");
      file.write(srt);
      file.close();

      app.project.importFiles([file.fsName], true, app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem, false);
      return {
        mode: "native",
        count: blocks.length,
        warning:
          "Captions written to " +
          file.fsName +
          " and imported. Drag the caption item onto the reel's caption track (Premiere can't auto-attach an SRT to a specific sequence from script).",
      };
    } catch (e) {
      return { mode: "native", count: 0, warning: "SRT caption build failed: " + e.toString() };
    }
  }

  function buildSrt(blocks) {
    var out = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      out.push(String(i + 1));
      out.push(srtTime(num(b.start_time_seconds)) + " --> " + srtTime(num(b.end_time_seconds)));
      out.push(String(b.text || ""));
      out.push("");
    }
    return out.join("\n");
  }

  function srtTime(sec) {
    if (sec < 0) sec = 0;
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    var ms = Math.round((sec - Math.floor(sec)) * 1000);
    return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + "," + pad(ms, 3);
  }

  // ── helpers ───────────────────────────────────────────────────────────────────

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }
  function mgtFileExists(p) {
    try {
      return !!p && new File(p).exists;
    } catch (e) {
      return false;
    }
  }
  function baseName(p) {
    var s = String(p || "");
    var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.substring(i + 1) : s;
  }
  function ticks(sec) {
    var t = new Time();
    t.seconds = sec;
    return t.ticks;
  }
  function pad(n, width) {
    n = String(n);
    while (n.length < width) n = "0" + n;
    return n;
  }
  function sanitize(s) {
    return String(s || "").replace(/[^a-z0-9_\-]+/gi, "_").substring(0, 48);
  }

  // ── pull-back from Premiere (§7c) — best-effort only ────────────────────────
  //
  // ExtendScript has no scriptable caption-track API (confirmed against Adobe's
  // own docs/community threads — sequence.getCaptionTrack() exists only in the
  // newer UXP DOM, itself reported unreliable as of mid-2025). This checks
  // defensively for anything exposed on the running build and returns a clear,
  // honest failure rather than silently no-op'ing. The practical round-trip is
  // re-importing the last exported .srt (Captions panel → Import SRT).
  function pullCaptionTrack(seq) {
    try {
      if (!seq) return { ok: false, warning: "No active sequence." };
      if (typeof seq.getCaptionTrack !== "function") {
        return {
          ok: false,
          warning:
            "This Premiere/CEP build has no scriptable caption-track API — ExtendScript can't read an existing " +
            "caption track. Re-import the last exported .srt instead (Captions panel → Import SRT).",
        };
      }
      var track = null;
      try {
        track = seq.getCaptionTrack();
      } catch (e) {
        return { ok: false, warning: "getCaptionTrack() threw: " + e.toString() + " — re-import the last exported .srt instead." };
      }
      if (!track) {
        return { ok: false, warning: "No caption track found on this sequence — re-import the last exported .srt instead." };
      }
      // Even where getCaptionTrack() exists, reading its cues' text/timing back
      // is not a documented/stable ExtendScript surface as of this writing —
      // report what was found rather than guessing at an unstable API shape.
      return {
        ok: false,
        warning:
          "Found a caption track, but this Premiere build has no confirmed way to read its cues from ExtendScript " +
          "— re-import the last exported .srt instead.",
      };
    } catch (e) {
      return { ok: false, warning: "pullCaptionTrack failed: " + e.toString() };
    }
  }

  return { apply: apply, applyGraphicsXml: applyGraphicsXml, pullCaptionTrack: pullCaptionTrack };
})();
