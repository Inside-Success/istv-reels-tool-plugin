"use strict";

/**
 * ISTV Reel Tool — caption JSON master document.
 *
 * The source of truth for captions is this word-level JSON document, never the
 * SRT (SRT is line-level only and is a lossy EXPORT target — see docToSrt).
 * Karaoke needs per-word start/end; when a cue has no `words`, karaoke is simply
 * unavailable for it (native/SRT captions still work) — times are never
 * fabricated for cues that lack real word timing.
 *
 * Schema:
 *   { version: 1,
 *     meta: { sequenceName, fps, source: "revai"|"srt"|"manual" },
 *     templateId: "clean-bold",
 *     cues: [ { id, start, end, text, words?: [{text,start,end}] } ] }
 *
 * All times are seconds (float); conversion to frames happens only at the
 * Premiere boundary (jsx/captions.jsx), using meta.fps.
 */

const captions = require("./captions");

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function round(n, digits) {
  const f = Math.pow(10, digits);
  return Math.round(num(n) * f) / f;
}

// ── document creation ─────────────────────────────────────────────────────────

function newDoc(meta) {
  return {
    version: 1,
    meta: { sequenceName: "", fps: 0, source: "manual", ...(meta || {}) },
    templateId: "clean-bold",
    cues: [],
  };
}

/**
 * Group a flat, chronological word list into cues at sentence/pause boundaries
 * under the given size/duration caps. Input words: [{text|word, start|localTime|
 * time, end}]. Never reorders — assumes the list is already chronological (as
 * buildPlaybackWords/normalizeWordTimeline in captions.js guarantee).
 */
function docFromWords(words, opts = {}) {
  const maxChars = num(opts.maxChars, 42);
  const maxLines = num(opts.maxLines, 2);
  const maxDurationSec = num(opts.maxDurationSec, 6);
  const pauseGapSec = num(opts.pauseGapSec, 0.6);
  const charBudget = maxChars * maxLines;

  const cleaned = (Array.isArray(words) ? words : [])
    .map((w) => ({
      text: String(w.text != null ? w.text : w.word || "").trim(),
      start: num(w.start != null ? w.start : w.localTime != null ? w.localTime : w.time),
      end: num(w.end, num(w.start != null ? w.start : w.localTime)),
    }))
    .filter((w) => w.text)
    .sort((a, b) => a.start - b.start);

  const cues = [];
  let cur = [];

  function flush() {
    if (!cur.length) return;
    const start = cur[0].start;
    const end = Math.max(cur[cur.length - 1].end, start + 0.01);
    cues.push({
      id: `c${String(cues.length + 1).padStart(3, "0")}`,
      start: round(start, 3),
      end: round(end, 3),
      text: cur.map((w) => w.text).join(" "),
      words: cur.map((w) => ({ text: w.text, start: round(w.start, 4), end: round(Math.max(w.end, w.start + 0.01), 4) })),
    });
    cur = [];
  }

  for (let i = 0; i < cleaned.length; i++) {
    const w = cleaned[i];
    const prev = cleaned[i - 1];
    const gap = prev ? w.start - prev.end : 0;
    const curText = cur.map((x) => x.text).join(" ");
    const wouldChars = curText ? curText.length + 1 + w.text.length : w.text.length;
    const wouldDur = cur.length ? w.end - cur[0].start : 0;

    if (cur.length && (gap > pauseGapSec || wouldChars > charBudget || wouldDur > maxDurationSec)) {
      flush();
    }
    cur.push(w);
    if (/[.!?]["')\]]?$/.test(w.text)) flush();
  }
  flush();
  return cues;
}

/**
 * Convenience: build a full doc straight from a reel + its cut-sheet segments,
 * reusing captions.js's proven word-timeline builder (shared with the MOGRT
 * chunker) rather than re-deriving playback timing here.
 */
function docFromReel(reel, segments, opts = {}) {
  const words = captions.buildPlaybackWords(reel || {}, segments || []);
  const cues = docFromWords(words, opts);
  return {
    version: 1,
    meta: { sequenceName: opts.sequenceName || "", fps: num(opts.fps, 0), source: "revai" },
    templateId: opts.templateId || "clean-bold",
    cues,
  };
}

// ── validation ─────────────────────────────────────────────────────────────────

/** Validate a doc: overlaps, start<end, word bounds, monotonic order, text sync.
 *  Never silently repairs — returns a report for the caller to surface. */
function validateDoc(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object") return { ok: false, errors: ["doc is not an object"] };
  const cues = Array.isArray(doc.cues) ? doc.cues : [];
  let prevEnd = -Infinity;

  cues.forEach((cue, i) => {
    const label = `cue[${i}] (${cue && cue.id != null ? cue.id : "?"})`;
    if (!cue || typeof cue.start !== "number" || typeof cue.end !== "number") {
      errors.push(`${label}: start/end must be numbers`);
      return;
    }
    if (!(cue.start < cue.end)) errors.push(`${label}: start (${cue.start}) must be < end (${cue.end})`);
    if (cue.start < prevEnd - 1e-6) errors.push(`${label}: overlaps previous cue (starts ${cue.start}, previous ends ${prevEnd})`);
    prevEnd = Math.max(prevEnd, cue.end);
    if (!cue.text || !String(cue.text).trim()) errors.push(`${label}: empty text`);

    if (Array.isArray(cue.words) && cue.words.length) {
      let prevWordEnd = -Infinity;
      cue.words.forEach((w, wi) => {
        const wl = `${label}.words[${wi}]`;
        if (!w || typeof w.start !== "number" || typeof w.end !== "number") {
          errors.push(`${wl}: start/end must be numbers`);
          return;
        }
        if (!(w.start < w.end)) errors.push(`${wl}: start must be < end`);
        if (w.start < cue.start - 1e-6 || w.end > cue.end + 1e-6) {
          errors.push(`${wl}: word time (${w.start}-${w.end}) outside cue bounds (${cue.start}-${cue.end})`);
        }
        if (w.start < prevWordEnd - 1e-6) errors.push(`${wl}: overlaps previous word`);
        prevWordEnd = Math.max(prevWordEnd, w.end);
      });
      const joined = cue.words.map((w) => (w && w.text) || "").join(" ");
      if (joined !== cue.text) {
        errors.push(`${label}: text ("${cue.text}") does not match joined words ("${joined}")`);
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

// ── editing ──────────────────────────────────────────────────────────────────

/** Re-tokenize a cue's text and diff against its existing words (common-prefix/
 *  common-suffix), preserving unchanged word times exactly and flagging the
 *  changed middle span `needsTiming: true` rather than guessing confidently. */
function syncCueWords(cue, newText) {
  const newTokens = String(newText || "").trim().split(/\s+/).filter(Boolean);
  cue.text = newTokens.join(" ");
  const oldWords = Array.isArray(cue.words) ? cue.words : null;
  if (!oldWords) return cue; // line-level cue stays line-level — no timing to sync

  let pre = 0;
  while (pre < oldWords.length && pre < newTokens.length && oldWords[pre].text === newTokens[pre]) pre++;
  let suf = 0;
  while (
    suf < oldWords.length - pre &&
    suf < newTokens.length - pre &&
    oldWords[oldWords.length - 1 - suf].text === newTokens[newTokens.length - 1 - suf]
  ) {
    suf++;
  }

  const kept = [];
  for (let i = 0; i < pre; i++) kept.push({ ...oldWords[i] });

  const midNewTokens = newTokens.slice(pre, newTokens.length - suf);
  if (midNewTokens.length) {
    const spanStart = pre > 0 ? oldWords[pre - 1].end : oldWords.length ? oldWords[0].start : cue.start;
    const spanEnd = suf > 0 ? oldWords[oldWords.length - suf].start : oldWords.length ? oldWords[oldWords.length - 1].end : cue.end;
    const n = midNewTokens.length;
    midNewTokens.forEach((t, idx) => {
      const s = spanStart + (spanEnd - spanStart) * (idx / n);
      const e = spanStart + (spanEnd - spanStart) * ((idx + 1) / n);
      kept.push({ text: t, start: round(s, 4), end: round(Math.max(e, s + 0.01), 4), needsTiming: true });
    });
  }
  for (let i = 0; i < suf; i++) kept.push({ ...oldWords[oldWords.length - suf + i] });

  cue.words = kept;
  return cue;
}

/** Split a cue into two at a word index (or, for word-less cues, at a token
 *  index using a proportional time split). Mutates doc.cues in place. */
function splitCue(doc, cueId, atIndex) {
  const idx = doc.cues.findIndex((c) => c.id === cueId);
  if (idx < 0) throw new Error(`splitCue: cue not found: ${cueId}`);
  const cue = doc.cues[idx];

  if (Array.isArray(cue.words) && cue.words.length > 1) {
    const i = Math.max(1, Math.min(cue.words.length - 1, atIndex | 0));
    const leftWords = cue.words.slice(0, i);
    const rightWords = cue.words.slice(i);
    const left = { id: cue.id, start: leftWords[0].start, end: leftWords[leftWords.length - 1].end, text: leftWords.map((w) => w.text).join(" "), words: leftWords };
    const right = { id: `${cue.id}b`, start: rightWords[0].start, end: rightWords[rightWords.length - 1].end, text: rightWords.map((w) => w.text).join(" "), words: rightWords };
    doc.cues.splice(idx, 1, left, right);
    return doc;
  }

  const tokens = String(cue.text || "").split(/\s+/).filter(Boolean);
  if (tokens.length < 2) throw new Error("splitCue: cue has too little text to split");
  const i = Math.max(1, Math.min(tokens.length - 1, atIndex | 0));
  const leftText = tokens.slice(0, i).join(" ");
  const rightText = tokens.slice(i).join(" ");
  const frac = leftText.length / Math.max(1, cue.text.length);
  const mid = cue.start + (cue.end - cue.start) * frac;
  const left = { id: cue.id, start: cue.start, end: round(mid, 3), text: leftText };
  const right = { id: `${cue.id}b`, start: round(mid, 3), end: cue.end, text: rightText };
  doc.cues.splice(idx, 1, left, right);
  return doc;
}

/** Merge two cues into one (order-independent by id). Word timing is kept only
 *  if BOTH sides have it — never fabricated for the side that lacks it. */
function mergeCues(doc, cueIdA, cueIdB) {
  const ia = doc.cues.findIndex((c) => c.id === cueIdA);
  const ib = doc.cues.findIndex((c) => c.id === cueIdB);
  if (ia < 0 || ib < 0) throw new Error("mergeCues: cue not found");
  const lo = Math.min(ia, ib);
  const hi = Math.max(ia, ib);
  const first = doc.cues[lo];
  const second = doc.cues[hi];
  const merged = { id: first.id, start: first.start, end: second.end, text: `${first.text} ${second.text}`.trim() };
  if (Array.isArray(first.words) && Array.isArray(second.words)) {
    merged.words = [...first.words, ...second.words];
  }
  doc.cues.splice(lo, hi - lo + 1, merged);
  return doc;
}

/** Shift every cue (and word, if present) by offsetSec — global sync fix. */
function shiftAll(doc, offsetSec) {
  const off = num(offsetSec);
  doc.cues.forEach((cue) => {
    cue.start = round(Math.max(0, cue.start + off), 3);
    cue.end = round(Math.max(cue.start + 0.01, cue.end + off), 3);
    if (Array.isArray(cue.words)) {
      cue.words.forEach((w) => {
        w.start = round(Math.max(0, w.start + off), 4);
        w.end = round(Math.max(w.start + 0.01, w.end + off), 4);
      });
    }
  });
  return doc;
}

// ── SRT import/export ───────────────────────────────────────────────────────

function srtStamp(sec) {
  sec = Math.max(0, num(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(ms, 3)}`;
}

function parseSrtTime(s) {
  const m = /(\d+):(\d{2}):(\d{2})[,.](\d{3})/.exec(String(s || ""));
  if (!m) return 0;
  return num(m[1]) * 3600 + num(m[2]) * 60 + num(m[3]) + num(m[4]) / 1000;
}

/** Parse a spec-clean (or reasonably lenient) .srt into a line-level doc.
 *  Word timing is intentionally absent — SRT has none (§1: never fabricate). */
function srtToDoc(srtText, meta = {}) {
  const text = String(srtText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    let i = 0;
    if (/^\d+$/.test(lines[0] || "")) i = 1;
    const timeLine = lines[i] || "";
    const tm = /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/.exec(timeLine);
    if (!tm) continue;
    const start = parseSrtTime(tm[1]);
    const end = parseSrtTime(tm[2]);
    const cueText = lines.slice(i + 1).join(" ").replace(/\s+/g, " ").trim();
    if (!cueText) continue;
    cues.push({ id: `c${String(cues.length + 1).padStart(3, "0")}`, start: round(start, 3), end: round(Math.max(end, start + 0.01), 3), text: cueText });
  }
  return {
    version: 1,
    meta: { sequenceName: meta.sequenceName || "", fps: num(meta.fps, 0), source: "srt" },
    templateId: meta.templateId || "clean-bold",
    cues,
  };
}

function wrapLines(text, maxChars, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    // Fold overflow into the last allowed line rather than dropping text —
    // callers can detect an over-budget cue by comparing line count to maxLines.
    const head = lines.slice(0, maxLines - 1);
    const tail = lines.slice(maxLines - 1).join(" ");
    return [...head, tail];
  }
  return lines;
}

/**
 * Convert the doc's cues into MOGRT-ready caption blocks for the karaoke "pop"
 * build path (§7b): word/phrase chunks per cue, each becoming one MOGRT
 * instance. This is the ONLY karaoke block source — deriving it from the doc
 * (rather than re-deriving from the raw transcript) is what makes panel edits
 * (text changes, split/merge, SRT import) actually show up in the built
 * sequence, per §1's "everything downstream is generated from this JSON
 * master" rule. Cues without word timing (e.g. imported SRT) contribute no
 * blocks — karaoke is simply unavailable for them, never faked.
 */
function docToCaptionBlocks(doc, opts = {}) {
  const chunkSize = Math.max(1, num(opts.chunkSize, 3));
  const blocks = [];
  (Array.isArray(doc && doc.cues) ? doc.cues : []).forEach((cue) => {
    if (!Array.isArray(cue.words) || !cue.words.length) return;
    for (let i = 0; i < cue.words.length; i += chunkSize) {
      const chunk = cue.words.slice(i, i + chunkSize);
      const start = chunk[0].start;
      const end = Math.max(chunk[chunk.length - 1].end, start + 0.01);
      blocks.push({
        id: `cap-${cue.id}-${i}`,
        start_time_seconds: round(start, 3),
        end_time_seconds: round(end, 3),
        text: chunk.map((w) => w.text).join(" "),
        words: chunk.map((w) => ({ word: w.text, localTime: w.start, end: w.end })),
      });
    }
  });
  return blocks;
}

/** Export a spec-clean .srt from the doc, line-wrapped by the template's
 *  maxChars/maxLines. Word data is stripped (SRT can't hold it — §6). */
function docToSrt(doc, template) {
  const maxChars = num(template && template.maxChars, 42);
  const maxLines = num(template && template.maxLines, 2);
  const cues = Array.isArray(doc && doc.cues) ? doc.cues : [];
  const out = [];
  cues.forEach((cue, i) => {
    out.push(String(i + 1));
    out.push(`${srtStamp(cue.start)} --> ${srtStamp(cue.end)}`);
    out.push(wrapLines(cue.text, maxChars, maxLines).join("\n"));
    out.push("");
  });
  return out.join("\n");
}

module.exports = {
  newDoc,
  docFromWords,
  docFromReel,
  validateDoc,
  syncCueWords,
  splitCue,
  mergeCues,
  shiftAll,
  srtToDoc,
  docToCaptionBlocks,
  docToSrt,
  srtStamp,
  parseSrtTime,
};
