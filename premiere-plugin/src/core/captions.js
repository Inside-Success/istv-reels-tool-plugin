"use strict";

/**
 * Karaoke caption timing — a faithful JS port of src/caption_builder.py.
 *
 * Given a reel (its cut-sheet segments + the source-timed words that fall inside
 * them), this produces caption *blocks* whose word timings are on the REEL's own
 * timeline (segments concatenated, starting at 0). That's exactly what the host
 * needs to place caption graphics on the freshly built 9:16 reel sequence.
 *
 * The FFmpeg engine used to consume these same blocks to burn karaoke text; here
 * the host (src/host/captions.jsx) consumes them to lay down Premiere graphics / a
 * caption track instead. The timing math is identical so the reel reads the same.
 */

const MIN_WORD_DISPLAY_SEC = 0.04;
const MIN_BLOCK_GAP_SEC = 0.03;
const MIN_BLOCK_DURATION_SEC = 0.25;
const DEFAULT_KARAOKE_CHUNK_SIZE = 2;

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
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
      // Require REAL overlap, not just a touching boundary. A word starting exactly
      // at segEnd (or ending exactly at segStart) shares no time with the span, and
      // including it produced a 40 ms sliver caption at every cut seam — competing
      // with the first real word of the next span for the same instant. Words that
      // genuinely straddle the cut are still kept, clamped to the span below.
      if (we <= segStart || ws >= segEnd) continue;
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
    const start = Math.max(0, num(raw.localTime != null ? raw.localTime : raw.time));
    let end = num(raw.end, start);
    if (end <= start) end = start + MIN_WORD_DISPLAY_SEC;
    cleaned.push({ ...raw, word: text, localTime: round(start, 4), end: round(end, 4) });
  }
  return cleaned;
}

function finalizeCaptionTiming(blocks) {
  const sorted = blocks.slice().sort((a, b) => num(a.start_time_seconds) - num(b.start_time_seconds));
  let prevEnd = 0;
  sorted.forEach((block, index) => {
    const words = block.words || [];
    if (words.length) {
      const start = Math.max(prevEnd + MIN_BLOCK_GAP_SEC, num(words[0].localTime));
      let end = Math.max(start + MIN_BLOCK_DURATION_SEC, num(words[words.length - 1].end, start));
      if (index + 1 < sorted.length) {
        const nextWords = sorted[index + 1].words || [];
        const nextStart = nextWords.length
          ? num(nextWords[0].localTime)
          : num(sorted[index + 1].start_time_seconds);
        end = Math.min(end, Math.max(start + MIN_BLOCK_DURATION_SEC, nextStart - MIN_BLOCK_GAP_SEC));
      } else {
        end = Math.max(end, num(words[words.length - 1].end, start) + 0.28);
      }
      block.start_time_seconds = round(start, 3);
      block.end_time_seconds = round(end, 3);
    }
    block.text =
      words.map((w) => String(w.word || "").trim()).filter(Boolean).join(" ") ||
      String(block.text || "").trim();
    prevEnd = num(block.end_time_seconds, prevEnd);
  });
  return sorted;
}

function makeCaptionBlocks(words, { chunkSize = DEFAULT_KARAOKE_CHUNK_SIZE } = {}) {
  words = normalizeWordTimeline(words);
  const blocks = [];
  let chunk = [];

  const flush = () => {
    if (!chunk.length) return;
    const start = num(chunk[0].localTime);
    let end = num(chunk[chunk.length - 1].end, start + MIN_BLOCK_DURATION_SEC);
    end = Math.max(start + MIN_BLOCK_DURATION_SEC, end);
    blocks.push({
      start_time_seconds: round(start, 3),
      end_time_seconds: round(end, 3),
      text: chunk.map((w) => String(w.word || "").trim()).filter(Boolean).join(" "),
      words: chunk.map((w) => ({ ...w })),
      speaker: chunk[0].speaker || 0,
    });
    chunk = [];
  };

  for (const word of words.slice(0, 360)) {
    const speaker = word.speaker || 0;
    if (chunk.length && (chunk[0].speaker || 0) !== speaker) flush();
    chunk.push(word);
    if (chunk.length >= chunkSize) flush();
  }
  flush();
  return finalizeCaptionTiming(blocks);
}

/**
 * Canonical span list for a reel: positive-length only, sorted by start time.
 *
 * THIS MUST BE THE ONLY PLACE THE ORDER IS DECIDED. The host concatenates spans in
 * this order when it places clips, and captions are timed against the same
 * concatenation, so if the two disagree every caption on a multi-span reel is
 * offset by a span length. That is exactly what used to happen: the reel model
 * sorted the cut sheet while the caption builder consumed it raw, so an AI cut
 * sheet returned out of order (common — it is a JSON array from an LLM) produced
 * clips in one order and captions in another.
 *
 * Accepts either shape: the reel model's {startSec,endSec} or the raw analysis
 * cut-sheet rows' {start_time_seconds,end_time_seconds}.
 */
function normalizeSegments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => ({
      startSec: num(row.startSec != null ? row.startSec : row.start_time_seconds),
      endSec: num(row.endSec != null ? row.endSec : row.end_time_seconds),
      role: String(row.role || "BODY").toUpperCase(),
    }))
    .filter((s) => s.endSec > s.startSec)
    .sort((a, b) => a.startSec - b.startSec);
}

/**
 * Public entry: given a reel with `.segments` (reel-model spans) or a raw
 * analysis reel with `.editor_cut_sheet`, return karaoke caption blocks on the
 * reel timeline. Each block: { start_time_seconds, end_time_seconds, text,
 * words:[{word, localTime, end}], speaker }.
 */
function buildCaptionsForReel(reel, { chunkSize = DEFAULT_KARAOKE_CHUNK_SIZE } = {}) {
  // The raw analysis reel carries `segments: []` (an EMPTY array, truthy in JS),
  // so we must check length — otherwise we'd skip the editor_cut_sheet and time
  // captions on the raw SOURCE timeline instead of the reel timeline, placing
  // them far outside the reel (blank captions).
  const segments = normalizeSegments(
    Array.isArray(reel.segments) && reel.segments.length ? reel.segments : reel.editor_cut_sheet
  );
  const words = buildPlaybackWords(reel, segments);
  const blocks = makeCaptionBlocks(words, { chunkSize });
  const reelId = reel.id != null ? reel.id : "reel";
  return blocks.map((b, i) => ({
    ...b,
    id: `cap-${reelId}-${i}-${Math.round(num(b.start_time_seconds) * 1000)}`,
  }));
}

function round(n, digits) {
  const f = Math.pow(10, digits);
  return Math.round(num(n) * f) / f;
}

module.exports = {
  buildCaptionsForReel,
  buildPlaybackWords,
  makeCaptionBlocks,
  normalizeSegments,
  DEFAULT_KARAOKE_CHUNK_SIZE,
};
