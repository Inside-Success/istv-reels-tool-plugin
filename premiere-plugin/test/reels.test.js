"use strict";

/**
 * The reel model: analysis -> segments/duration/metadata, the host payload, and the
 * SRT + transcript text output. These assertions are about the values that decide
 * where a reel cuts and what an editor reads, so they are checked exactly.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const reels = require(path.join(__dirname, "..", "src", "core", "reels.js"));
const { analysis } = require("./fixtures/analysis.js");

test("normalizeReels sorts, filters, and sums the cut sheet", () => {
  const [r1] = reels.normalizeReels(analysis);

  // Sheet was [20-23, 5-5 (zero length), 10-14].
  assert.deepEqual(r1.segments, [
    { startSec: 10, endSec: 14, role: "HOOK" },
    { startSec: 20, endSec: 23, role: "BODY" },
  ]);
  assert.equal(r1.durationSec, 7, "duration is the sum of span lengths, not end-minus-start");
  assert.equal(r1.id, 7);
  assert.equal(r1.index, 1);
  assert.equal(r1.rank, 1);
  assert.equal(r1.title, 'She Lost Everything Twice: "Then I Rebuilt"');
  assert.equal(r1.caption, "A story about starting over.");
  assert.deepEqual(r1.hashtags, ["#resilience", "#story"]);
  assert.equal(r1.whyItWorks, "Concrete stakes stated in the first line.");
  assert.equal(r1.spokenHook, "I lost everything twice");
  assert.equal(r1.built, false);
  assert.equal(r1.sequenceName, "");
  assert.ok(r1.captionBlocks.length > 0, "captions built during normalization");
});

test("normalizeReels falls back to start/end when there is no cut sheet", () => {
  const [, r2] = reels.normalizeReels(analysis);
  assert.deepEqual(r2.segments, [{ startSec: 100, endSec: 145, role: "HOOK" }]);
  assert.equal(r2.durationSec, 45);
  assert.equal(r2.index, 2);
  assert.equal(r2.rank, 2, "rank defaults to position when absent");
  assert.equal(r2.title, "Reel 2", "title defaults to its position");
  assert.deepEqual(r2.hashtags, []);
});

test("a reel with neither a cut sheet nor an end time gets a 30s default span", () => {
  const [r] = reels.normalizeReels({ reels: [{ id: 1, start_time_seconds: 60 }] });
  assert.deepEqual(r.segments, [{ startSec: 60, endSec: 90, role: "HOOK" }]);
  assert.equal(r.durationSec, 30);
});

test("normalizeReels tolerates junk instead of throwing", () => {
  assert.deepEqual(reels.normalizeReels(null), []);
  assert.deepEqual(reels.normalizeReels({}), []);
  assert.deepEqual(reels.normalizeReels({ reels: "nope" }), []);
  const [r] = reels.normalizeReels({ reels: [{}] });
  assert.equal(r.title, "Reel 1");
  assert.equal(r.segments.length, 1);
});

test("buildPayload carries everything the host needs", () => {
  const model = reels.normalizeReels(analysis);
  const source = { path: "/media/interview.mp4", meta: { fps: 23.976, width: 3840, height: 2160 } };
  const payload = reels.buildPayload(model, {
    source,
    canvas: { width: 1080, height: 1920 },
    presetPath: "/p/vertical.sqpreset",
    mogrtPath: "/p/captions.mogrt",
  });

  assert.equal(payload.sourcePath, "/media/interview.mp4");
  assert.deepEqual(payload.canvas, { width: 1080, height: 1920 });
  assert.equal(payload.fps, 23.976, "source fps passes through so the reel doesn't conform-judder");
  assert.equal(payload.captionMode, "karaoke", "a MOGRT means karaoke graphics");
  assert.equal(payload.binName, "ISTV Reels");
  assert.equal(payload.reels.length, 2);

  const first = payload.reels[0];
  assert.deepEqual(first.segments, model[0].segments);
  assert.equal(first.reframe.srcW, 3840, "real source raster drives the reframe maths");
  assert.equal(first.reframe.srcH, 2160);
  assert.equal(first.metadata.caption, "A story about starting over.");
  assert.ok(first.captionBlocks.length > 0);
});

test("buildPayload falls back to native captions with no MOGRT, and to 16:9 defaults with no probe", () => {
  const model = reels.normalizeReels(analysis);
  const payload = reels.buildPayload(model, {
    source: { path: "/x.mp4" }, // no meta at all
    canvas: { width: 1080, height: 1920 },
    presetPath: "",
    mogrtPath: "",
  });
  assert.equal(payload.captionMode, "native");
  assert.equal(payload.fps, 0, "0 tells the host to read the rate from the master clip");
  assert.equal(payload.reels[0].reframe.srcW, 1920);
  assert.equal(payload.reels[0].reframe.srcH, 1080);
});

test("srtStamp formats SubRip timestamps and clamps negatives", () => {
  assert.equal(reels.srtStamp(0), "00:00:00,000");
  assert.equal(reels.srtStamp(1.5), "00:00:01,500");
  assert.equal(reels.srtStamp(61.25), "00:01:01,250");
  assert.equal(reels.srtStamp(3661.007), "01:01:01,007");
  assert.equal(reels.srtStamp(-5), "00:00:00,000");
  assert.equal(reels.srtStamp("nonsense"), "00:00:00,000");
});

test("reelToSrt emits well-formed, sequentially numbered SubRip", () => {
  const [r1] = reels.normalizeReels(analysis);
  const srt = reels.reelToSrt(r1);
  const lines = srt.split("\n");

  assert.equal(lines[0], "1");
  assert.match(lines[1], /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/);
  assert.ok(lines[2].length > 0, "cue text present");
  assert.equal(lines[3], "", "blank line separates cues");

  // Indices must run 1..n with no gaps, or players silently drop cues.
  const indices = srt
    .split("\n\n")
    .map((b) => b.trim().split("\n")[0])
    .filter(Boolean);
  indices.forEach((v, i) => assert.equal(v, String(i + 1)));
  assert.equal(indices.length, r1.captionBlocks.length);

  // Every cue must advance, which is what a player needs to render them at all.
  const times = [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/g)];
  assert.equal(times.length, r1.captionBlocks.length);
  const toSec = (h, m, s, ms) => +h * 3600 + +m * 60 + +s + +ms / 1000;
  let prev = -1;
  for (const t of times) {
    const start = toSec(t[1], t[2], t[3], t[4]);
    const end = toSec(t[5], t[6], t[7], t[8]);
    assert.ok(end > start, "cue has positive duration");
    assert.ok(start >= prev, "cues do not overlap");
    prev = end;
  }
});

test("reelToSrt returns empty text for a reel with no captions", () => {
  assert.equal(reels.reelToSrt({ captionBlocks: [] }), "");
  assert.equal(reels.reelToSrt({}), "");
});

test("srtFileName strips characters illegal on either OS", () => {
  const name = reels.srtFileName({ index: 3, title: 'She Said: "No" / Never <again>' });
  assert.equal(name, "Reel_03_She Said No  Never again.srt");
  for (const ch of ['"', "*", "/", ":", "<", ">", "?", "\\", "|"]) {
    assert.ok(!name.includes(ch), `must not contain ${ch}`);
  }
  // A title that sanitizes away entirely still yields a usable name.
  assert.equal(reels.srtFileName({ index: 1, title: "///" }), "Reel_01_reel.srt");
  assert.equal(reels.srtFileName({}), "Reel_01_reel.srt");
});

test("transcriptToText groups words into speaker turns with timecodes", () => {
  const text = reels.transcriptToText({
    words: [
      { word: "Hello", start: 0, speaker: 0 },
      { word: "there", start: 0.5, speaker: 0 },
      { word: "Hi", start: 65, speaker: 1 },
      { word: "back", start: 65.5, speaker: 1 },
      { word: "again", start: 120, speaker: 0 },
    ],
  });
  const turns = text.split("\n\n");
  assert.equal(turns.length, 3, "one turn per speaker change");
  assert.equal(turns[0], "[0:00 · Speaker 0]  Hello there");
  assert.equal(turns[1], "[1:05 · Speaker 1]  Hi back");
  assert.equal(turns[2], "[2:00 · Speaker 0]  again");
});

test("transcriptToText handles a missing or empty transcript", () => {
  assert.equal(reels.transcriptToText(null), "(no transcript words available)");
  assert.equal(reels.transcriptToText({ words: [] }), "(no transcript words available)");
});

test("baseName splits on both separators regardless of host OS", () => {
  assert.equal(reels.baseName("C:\\Users\\me\\interview.mp4"), "interview.mp4");
  assert.equal(reels.baseName("/Users/me/interview.mp4"), "interview.mp4");
  assert.equal(reels.baseName("interview.mp4"), "interview.mp4");
  assert.equal(reels.baseName(""), "");
  assert.equal(reels.baseName(null), "");
});

test("fmtDur and fmtClock render m:ss", () => {
  assert.equal(reels.fmtDur(0), "0:00");
  assert.equal(reels.fmtDur(59.6), "1:00");
  assert.equal(reels.fmtDur(605), "10:05");
  assert.equal(reels.fmtClock(605.9), "10:05", "clock truncates rather than rounds");
});
