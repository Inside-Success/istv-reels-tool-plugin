"use strict";

/**
 * Word-timeline builder — a faithful JS port of the playback-timing half of
 * src/caption_builder.py.
 *
 * Given a reel (its cut-sheet segments + the source-timed words that fall
 * inside them), maps the source-timed word list onto the REEL's own timeline
 * (segments concatenated, starting at 0). This is the shared input for the
 * JSON caption master (js/captionDoc.js docFromReel) — the doc is the source
 * of truth; nothing here builds caption blocks directly anymore (that's
 * captionDoc.js's docToCaptionBlocks, generated from the doc so panel edits
 * actually reach the built sequence).
 */

const MIN_WORD_DISPLAY_SEC = 0.04;

// Non-lexical filled pauses, dropped from caption text. The backend deliberately
// keeps these in `timestamped_words` with real timestamps — deleting them at
// transcription time removed real spoken time while the audio stayed untouched,
// which drifted every later word out of sync — so each consumer hides them at
// render time instead. The desktop/CLI engine does it via
// hideFillersInSubtitles (export/media.cjs); the panel has no such toggle, so it
// filters unconditionally, matching what editors saw before fillers began
// arriving in the word list.
//
// Dropping a word never shifts the timeline: every word carries its own absolute
// localTime/end, so the words around it keep their timings exactly.
//
// Non-lexical pauses ONLY — "like", "so", "well", and "ah" are real speech and
// silently corrupt a caption when dropped. Keep in sync with export/media.cjs
// FILLER_WORDS and desktop/src/renderer/model.js FILLERS.
const FILLER_WORDS = new Set([
  "um", "umm", "uh", "uhh", "uhm", "erm", "er", "err", "hmm", "hm", "mm", "mhm", "mmhm",
]);

function isFiller(word) {
  return FILLER_WORDS.has(
    String(word || "")
      .toLowerCase()
      .replace(/[^a-z]/g, "")
  );
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function round(n, digits) {
  const f = Math.pow(10, digits);
  return Math.round(num(n) * f) / f;
}

/** Map source-timed words onto the reel timeline (segments concatenated). */
function buildPlaybackWords(reel, segments) {
  const sourceWords = Array.isArray(reel.timestamped_words) ? reel.timestamped_words : [];
  const out = [];

  if (!segments || !segments.length) {
    let offset = 0;
    for (const w of sourceWords) {
      const ws = num(w.time != null ? w.time : w.start);
      const we = num(w.end, ws);
      out.push({
        word: String(w.word || "").trim(),
        time: ws,
        end: offset + we,
        speaker: w.speaker || 0,
        localTime: offset + ws,
      });
    }
    return normalizeWordTimeline(out);
  }

  let offset = 0;
  for (const seg of segments) {
    const segStart = num(seg.startSec != null ? seg.startSec : seg.start_time_seconds);
    const segEnd = num(seg.endSec != null ? seg.endSec : seg.end_time_seconds, segStart);
    for (const w of sourceWords) {
      const ws = num(w.time != null ? w.time : w.start);
      const we = num(w.end, ws);
      if (we < segStart || ws > segEnd) continue;
      const localStart = offset + Math.max(0, ws - segStart);
      let localEnd = offset + Math.max(0, Math.min(we, segEnd) - segStart);
      if (localEnd <= localStart) localEnd = localStart + MIN_WORD_DISPLAY_SEC;
      out.push({
        word: String(w.word || "").trim(),
        time: ws,
        end: localEnd,
        speaker: w.speaker || 0,
        localTime: localStart,
      });
    }
    offset += Math.max(0, segEnd - segStart);
  }
  return normalizeWordTimeline(out);
}

function normalizeWordTimeline(words) {
  const cleaned = [];
  const sorted = words.slice().sort((a, b) => num(a.localTime, a.time) - num(b.localTime, b.time));
  for (const raw of sorted) {
    const text = String(raw.word || "").trim();
    if (!text) continue;
    if (isFiller(text)) continue;
    const start = Math.max(0, num(raw.localTime != null ? raw.localTime : raw.time));
    let end = num(raw.end, start);
    if (end <= start) end = start + MIN_WORD_DISPLAY_SEC;
    cleaned.push({ ...raw, word: text, localTime: round(start, 4), end: round(end, 4) });
  }
  return cleaned;
}

module.exports = {
  buildPlaybackWords,
  normalizeWordTimeline,
  FILLER_WORDS,
  isFiller,
};
