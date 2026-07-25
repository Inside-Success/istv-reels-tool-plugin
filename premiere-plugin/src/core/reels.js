"use strict";

/**
 * Reel model + text formatting. Pure functions only — no DOM, no filesystem, no
 * Premiere. This is the layer the test suite exercises hardest, because it is
 * where a wrong number becomes a reel that cuts in the wrong place or captions
 * that sit outside the clip.
 *
 * Responsibilities:
 *   normalizeReels()     backend /select analysis  -> the panel's reel model
 *   reelToSrt()          a reel's caption blocks   -> SubRip text
 *   transcriptToText()   Rev.ai word list          -> readable speaker turns
 */

const captions = require("./captions");

/** Words per on-screen caption block. */
const CAPTION_CHUNK_SIZE = 3;

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Turn the backend's analysis into the reel model the UI renders and the host
 * builds from. Each reel's `segments` are SOURCE-timeline spans taken from the
 * AI's editor cut sheet: filtered to positive-length, sorted by start, and summed
 * for the reel duration. A reel with no usable cut sheet falls back to its own
 * start/end (30s default) so it is still buildable rather than silently dropped.
 */
function normalizeReels(analysis, { chunkSize = CAPTION_CHUNK_SIZE } = {}) {
  const reels = Array.isArray(analysis && analysis.reels) ? analysis.reels : [];
  return reels.map((r, i) => {
    // One shared normalizer for clip order and caption order — see
    // captions.normalizeSegments for why they must never be computed separately.
    let segments = captions.normalizeSegments(r.editor_cut_sheet);
    if (!segments.length) {
      const a = num(r.start_time_seconds);
      segments = [{ startSec: a, endSec: num(r.end_time_seconds, a + 30), role: "HOOK" }];
    }
    const durationSec = segments.reduce((t, s) => t + (s.endSec - s.startSec), 0);

    return {
      id: num(r.id, i + 1),
      index: i + 1,
      rank: num(r.rank, i + 1),
      title: String(r.title || `Reel ${i + 1}`),
      caption: String(r.caption || ""),
      hashtags: Array.isArray(r.hashtags) ? r.hashtags : [],
      whyItWorks: String(r.why_it_works || r.theme || ""),
      spokenHook: String(r.spoken_hook || ""),
      segments,
      durationSec: Math.round(durationSec * 10) / 10,
      // Pass the already-normalized segments, not the raw reel, so captions are
      // timed against precisely the spans the host will place.
      captionBlocks: captions.buildCaptionsForReel({ ...r, segments }, { chunkSize }),
      _raw: r, // keep the analysis reel so captions can be rebuilt per template
      sequenceName: "", // set once built in Premiere
      built: false,
    };
  });
}

/**
 * The payload handed to the ExtendScript host. Split out from the panel so its
 * shape is asserted by tests rather than only by Premiere at runtime.
 */
function buildPayload(reels, { source, canvas, presetPath, mogrtPath, binName = "ISTV Reels" }) {
  const meta = (source && source.meta) || {};
  return {
    sourcePath: source && source.path,
    canvas,
    fps: meta.fps && meta.fps > 0 ? meta.fps : 0, // match the reel sequence to the source fps
    presetPath: presetPath || "",
    mogrtPath: mogrtPath || "",
    // Captions are placed as part of the build — karaoke MOGRT graphics when a
    // caption template exists, otherwise an imported, editable native .srt.
    captionMode: mogrtPath ? "karaoke" : "native",
    binName,
    reels: reels.map((r) => ({
      id: r.id,
      index: r.index,
      title: r.title,
      segments: r.segments,
      reframe: { cropX: 0.5, cropY: 0.5, zoom: 1, srcW: meta.width || 1920, srcH: meta.height || 1080 },
      captionBlocks: r.captionBlocks,
      metadata: {
        title: r.title,
        caption: r.caption,
        hashtags: r.hashtags,
        whyItWorks: r.whyItWorks,
        spokenHook: r.spokenHook,
      },
    })),
  };
}

// ── SRT ───────────────────────────────────────────────────────────────────────

function pad(n, w) {
  return String(n).padStart(w, "0");
}

/** Seconds -> SubRip timestamp (HH:MM:SS,mmm). Negatives clamp to zero. */
function srtStamp(sec) {
  sec = Math.max(0, num(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/** A reel's caption blocks as SubRip text. Empty when the reel has no captions. */
function reelToSrt(reel) {
  const blocks = (reel && reel.captionBlocks) || [];
  const out = [];
  blocks.forEach((b, i) => {
    out.push(String(i + 1));
    out.push(`${srtStamp(b.start_time_seconds)} --> ${srtStamp(b.end_time_seconds)}`);
    out.push(String(b.text || ""));
    out.push("");
  });
  return out.join("\n");
}

/** Filename-safe .srt name for a reel, stable across platforms. */
function srtFileName(reel) {
  const safe =
    String((reel && reel.title) || "reel")
      .replace(/[\\/:*?"<>|]/g, "")
      .slice(0, 40)
      .trim() || "reel";
  return `Reel_${pad(num(reel && reel.index, 1), 2)}_${safe}.srt`;
}

// ── transcript formatting ─────────────────────────────────────────────────────

function fmtClock(sec) {
  sec = Math.max(0, Math.floor(num(sec)));
  return Math.floor(sec / 60) + ":" + pad(sec % 60, 2);
}

function fmtDur(sec) {
  sec = Math.round(num(sec));
  return Math.floor(sec / 60) + ":" + pad(sec % 60, 2);
}

/** Rev.ai word list -> readable text, grouped into speaker turns. */
function transcriptToText(t) {
  const words = t && Array.isArray(t.words) ? t.words : [];
  if (!words.length) return "(no transcript words available)";
  const lines = [];
  let curSpk = null;
  let startSec = 0;
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const who = curSpk != null ? " · Speaker " + curSpk : "";
    lines.push("[" + fmtClock(startSec) + who + "]  " + buf.join(" "));
    buf = [];
  };
  words.forEach((w) => {
    const spk = w.speaker != null ? w.speaker : 0;
    const ws = num(w.start != null ? w.start : w.time);
    if (curSpk === null) {
      curSpk = spk;
      startSec = ws;
    } else if (spk !== curSpk) {
      flush();
      curSpk = spk;
      startSec = ws;
    }
    const word = String(w.word || "").trim();
    if (word) buf.push(word);
  });
  flush();
  return lines.join("\n\n");
}

/** Basename that works for both separators regardless of host OS. */
function baseName(p) {
  const s = String(p || "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

module.exports = {
  CAPTION_CHUNK_SIZE,
  normalizeReels,
  buildPayload,
  srtStamp,
  reelToSrt,
  srtFileName,
  transcriptToText,
  fmtClock,
  fmtDur,
  baseName,
};
