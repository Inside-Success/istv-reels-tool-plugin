"use strict";

/**
 * Caption timing. These are the numbers that decide whether karaoke text lands on
 * the words being spoken, so the invariants are asserted directly rather than
 * through a golden file: monotonic, non-overlapping, inside the reel, and mapped
 * from SOURCE time onto REEL time across concatenated spans.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const captions = require(path.join(__dirname, "..", "src", "core", "captions.js"));
const { analysis, reel1ExpectedWords } = require("./fixtures/analysis.js");

const reel1 = analysis.reels[0];

test("maps source-timed words onto the reel timeline across two spans", () => {
  const segments = reel1.editor_cut_sheet
    .map((r) => ({ startSec: r.start_time_seconds, endSec: r.end_time_seconds }))
    .filter((s) => s.endSec > s.startSec)
    .sort((a, b) => a.startSec - b.startSec);

  const words = captions.buildPlaybackWords(reel1, segments);

  // The 14..20 words fall in no span and must be gone.
  assert.equal(words.length, reel1ExpectedWords.length, "only in-span words survive");
  assert.deepEqual(
    words.map((w) => w.word),
    reel1ExpectedWords.map((w) => w.word)
  );
  words.forEach((w, i) => {
    assert.ok(
      Math.abs(w.localTime - reel1ExpectedWords[i].localTime) < 0.001,
      `${w.word}: expected reel-time ${reel1ExpectedWords[i].localTime}, got ${w.localTime}`
    );
    assert.ok(w.end > w.localTime, `${w.word}: end must follow start`);
  });

  // Span B starts at reel-time 4 even though its source time is 20 — the whole
  // point of the mapping. A regression here silently pushes captions off the reel.
  const then = words.find((w) => w.word === "then");
  assert.equal(then.localTime, 4);
});

test("caption blocks are ordered, non-overlapping, and inside the reel", () => {
  const blocks = captions.buildCaptionsForReel(reel1, { chunkSize: 3 });
  assert.ok(blocks.length > 0, "produced blocks");

  const reelDuration = 4 + 3; // span A + span B
  let prevEnd = -Infinity;
  for (const b of blocks) {
    assert.ok(b.start_time_seconds >= 0, "no negative start");
    assert.ok(b.end_time_seconds > b.start_time_seconds, `block "${b.text}" has positive duration`);
    assert.ok(b.start_time_seconds >= prevEnd, `block "${b.text}" starts after the previous ends`);
    assert.ok(
      b.end_time_seconds <= reelDuration + 0.5,
      `block "${b.text}" ends at ${b.end_time_seconds}, past the ${reelDuration}s reel`
    );
    assert.equal(typeof b.text, "string");
    assert.ok(b.text.trim().length > 0, "no empty caption text");
    prevEnd = b.end_time_seconds;
  }
});

test("chunkSize caps words per block, and a speaker change breaks the block early", () => {
  const blocks = captions.buildCaptionsForReel(reel1, { chunkSize: 3 });
  for (const b of blocks) {
    assert.ok(b.words.length <= 3, `"${b.text}" has ${b.words.length} words, expected <= 3`);
  }
  // Speaker 0 ("...twice") must not share a block with speaker 1 ("then...").
  for (const b of blocks) {
    const speakers = new Set(b.words.map((w) => w.speaker || 0));
    assert.equal(speakers.size, 1, `block "${b.text}" mixes speakers`);
  }
  const mixed = blocks.find((b) => /twice/.test(b.text) && /then/.test(b.text));
  assert.equal(mixed, undefined, "a speaker change ends the block");
});

test("chunkSize of 1 yields word-by-word karaoke", () => {
  const blocks = captions.buildCaptionsForReel(reel1, { chunkSize: 1 });
  assert.equal(blocks.length, reel1ExpectedWords.length);
  for (const b of blocks) assert.equal(b.words.length, 1);
  assert.equal(blocks[0].text, "I");
});

test("block text is rebuilt from its words, so text and timing cannot drift apart", () => {
  const blocks = captions.buildCaptionsForReel(reel1, { chunkSize: 2 });
  for (const b of blocks) {
    assert.equal(b.text, b.words.map((w) => w.word).join(" "));
  }
});

test("blocks carry stable unique ids", () => {
  const blocks = captions.buildCaptionsForReel(reel1, { chunkSize: 2 });
  const ids = blocks.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  // Same input -> same ids, so a rebuild doesn't churn the caption identities.
  const again = captions.buildCaptionsForReel(reel1, { chunkSize: 2 });
  assert.deepEqual(again.map((b) => b.id), ids);
});

test("falls back to editor_cut_sheet when the reel has an empty segments array", () => {
  // The raw analysis reel carries `segments: []`, which is TRUTHY in JS. Checking
  // truthiness instead of length would time captions on the SOURCE timeline and
  // place them tens of seconds outside the reel.
  const withEmpty = { ...reel1, segments: [] };
  const blocks = captions.buildCaptionsForReel(withEmpty, { chunkSize: 3 });
  assert.ok(blocks.length > 0);
  assert.ok(
    blocks[0].start_time_seconds < 1,
    `first caption should start near reel-time 0, got ${blocks[0].start_time_seconds}`
  );
});

test("an out-of-order cut sheet still produces captions in reel order", () => {
  // Regression: the reel model sorted the cut sheet but the caption builder read it
  // raw, so an AI cut sheet returned out of order (it is a JSON array from an LLM,
  // so this is routine) placed clips in one order and captions in another. Every
  // caption on a multi-span reel was then offset by a span length. The fixture's
  // sheet is deliberately [20-23, 5-5, 10-14].
  const blocks = captions.buildCaptionsForReel(reel1, { chunkSize: 1 });
  assert.deepEqual(
    blocks.map((b) => b.text),
    ["I", "lost", "everything", "twice", "then", "I", "rebuilt"],
    "captions must follow the sorted span order, not the cut sheet's array order"
  );
  // Span A's words occupy reel-time 0..4; span B's begin at 4.
  assert.ok(blocks[0].start_time_seconds < 1, "span A first");
  assert.ok(blocks[4].start_time_seconds >= 4, "span B starts after span A's 4 seconds");
});

test("normalizeSegments filters zero-length spans and sorts by start", () => {
  const out = captions.normalizeSegments([
    { start_time_seconds: 20, end_time_seconds: 23, role: "body" },
    { start_time_seconds: 5, end_time_seconds: 5 }, // zero length -> dropped
    { start_time_seconds: 9, end_time_seconds: 4 }, // negative -> dropped
    { start_time_seconds: 10, end_time_seconds: 14, role: "hook" },
  ]);
  assert.deepEqual(out, [
    { startSec: 10, endSec: 14, role: "HOOK" },
    { startSec: 20, endSec: 23, role: "BODY" },
  ]);
  assert.deepEqual(captions.normalizeSegments(undefined), []);
  assert.deepEqual(captions.normalizeSegments("nonsense"), []);
});

test("a word touching a span boundary with zero overlap is excluded", () => {
  // The fixture's "um" starts at exactly 14.0, the end of span A. It shares no time
  // with the span, so including it produced a 40 ms sliver caption at the cut seam,
  // competing with span B's first real word for the same instant.
  const words = captions.buildPlaybackWords(reel1, [
    { startSec: 10, endSec: 14 },
    { startSec: 20, endSec: 23 },
  ]);
  assert.equal(words.filter((w) => w.word === "um").length, 0);

  // A word that genuinely straddles the cut is still kept, clamped to the span.
  const straddling = captions.buildPlaybackWords(
    { timestamped_words: [{ word: "spanning", time: 13.5, end: 14.8 }] },
    [{ startSec: 10, endSec: 14 }]
  );
  assert.equal(straddling.length, 1);
  assert.ok(straddling[0].end <= 4.0001, "clamped to the span end, not the word end");
});

test("a reel with no words produces no blocks instead of throwing", () => {
  assert.deepEqual(captions.buildCaptionsForReel({ id: 1, timestamped_words: [] }), []);
  assert.deepEqual(captions.buildCaptionsForReel({ id: 1 }), []);
});

test("blank and whitespace-only words are dropped", () => {
  const reel = {
    id: 2,
    editor_cut_sheet: [{ start_time_seconds: 0, end_time_seconds: 5 }],
    timestamped_words: [
      { word: "real", time: 0, end: 0.5 },
      { word: "   ", time: 1, end: 1.5 },
      { word: "", time: 2, end: 2.5 },
      { word: "words", time: 3, end: 3.5 },
    ],
  };
  const blocks = captions.buildCaptionsForReel(reel, { chunkSize: 5 });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "real words");
});

test("a zero-length word still gets a visible minimum duration", () => {
  const reel = {
    id: 3,
    editor_cut_sheet: [{ start_time_seconds: 0, end_time_seconds: 5 }],
    timestamped_words: [{ word: "blip", time: 1, end: 1 }],
  };
  const blocks = captions.buildCaptionsForReel(reel, { chunkSize: 1 });
  assert.equal(blocks.length, 1);
  assert.ok(
    blocks[0].end_time_seconds - blocks[0].start_time_seconds >= 0.25,
    "a zero-length word must still be readable"
  );
});
