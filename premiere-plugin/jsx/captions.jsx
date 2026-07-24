/*
 * ISTV Reel Tool — caption placement inside Premiere.
 *
 * Consumes the caption blocks computed by js/captions.js (the JS port of the
 * repo's caption_builder) and lays them onto the reel sequence. Two modes:
 *
 *   "karaoke"  One Motion Graphics (MOGRT) instance per caption block, placed at
 *              the block's start time on a dedicated graphics track and trimmed
 *              to the block's end. Feed it 1-word blocks and you get the signature
 *              word-by-word "pop" karaoke; 2-word blocks give chunked captions.
 *              Requires a bundled text MOGRT (see README → captions.mogrt). The
 *              MOGRT's editable text field is set per instance to the block text.
 *
 *   "native"   Writes a standard .srt next to the project and imports it as a
 *              Premiere caption item (fully native/editable, no word highlight).
 *
 * Why per-instance MOGRT rather than recoloring one word inside a shared line:
 * a single MOGRT text field can't recolor a sub-range of its own text from
 * script, so true in-line multi-word highlight isn't achievable purely via
 * ExtendScript. Per-block instances are the robust, version-stable path.
 */

// Implicit global (no `var`) so it persists to the global scope no matter what
// scope $.evalFile runs in — the same pattern json2.js uses for JSON. With `var`
// it stayed local to the loader and host.jsx saw "ISTV_Captions is undefined".
ISTV_Captions = (function () {

  function apply(seq, blocks, opts) {
    opts = opts || {};
    var mode = opts.mode || "karaoke";
    if (mode === "native") return applyNative(seq, blocks, opts);
    return applyKaraoke(seq, blocks, opts);
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
      var srt = buildSrt(blocks);
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

  return { apply: apply };
})();
