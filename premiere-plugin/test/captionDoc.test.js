"use strict";

/** Headless tests for the caption JSON master (no Premiere/DOM needed). */

const assert = require("assert");
const D = require("../js/captionDoc");

let pass = 0;
function test(name, fn) {
  fn();
  pass++;
  console.log("  ok -", name);
}

function words(...specs) {
  // specs: [text, start, end]
  return specs.map(([text, start, end]) => ({ text, start, end }));
}

console.log("captionDoc: docFromWords");
test("groups words into a single cue under the size/duration caps", () => {
  const w = words(["we", 0, 0.2], ["almost", 0.2, 0.6], ["lost", 0.6, 0.9], ["everything.", 0.9, 1.4]);
  const cues = D.docFromWords(w);
  assert.strictEqual(cues.length, 1);
  assert.strictEqual(cues[0].text, "we almost lost everything.");
  assert.strictEqual(cues[0].start, 0);
  assert.strictEqual(cues[0].end, 1.4);
  assert.strictEqual(cues[0].words.length, 4);
});

test("flushes on sentence-ending punctuation", () => {
  const w = words(["Hi.", 0, 0.3], ["Bye.", 0.3, 0.6]);
  const cues = D.docFromWords(w);
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].text, "Hi.");
  assert.strictEqual(cues[1].text, "Bye.");
});

test("flushes on a long pause gap", () => {
  const w = words(["hello", 0, 0.3], ["world", 5, 5.3]);
  const cues = D.docFromWords(w, { pauseGapSec: 0.6 });
  assert.strictEqual(cues.length, 2);
});

test("flushes when exceeding maxChars*maxLines", () => {
  const w = words(["aaaaaaaaaa", 0, 0.3], ["bbbbbbbbbb", 0.3, 0.6], ["cccccccccc", 0.6, 0.9]);
  const cues = D.docFromWords(w, { maxChars: 10, maxLines: 1 });
  assert.ok(cues.length >= 2, "expected the long run to split across cues");
});

console.log("captionDoc: validateDoc");
test("accepts a well-formed doc", () => {
  const doc = D.newDoc();
  doc.cues = D.docFromWords(words(["hi", 0, 0.3], ["there.", 0.3, 0.7]));
  const r = D.validateDoc(doc);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.ok, true);
});

test("rejects start >= end", () => {
  const doc = D.newDoc();
  doc.cues = [{ id: "c1", start: 1, end: 1, text: "x" }];
  const r = D.validateDoc(doc);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /must be < end/.test(e)));
});

test("rejects overlapping cues", () => {
  const doc = D.newDoc();
  doc.cues = [
    { id: "c1", start: 0, end: 2, text: "a" },
    { id: "c2", start: 1, end: 3, text: "b" },
  ];
  const r = D.validateDoc(doc);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /overlaps previous cue/.test(e)));
});

test("rejects a word outside its cue's bounds", () => {
  const doc = D.newDoc();
  doc.cues = [{ id: "c1", start: 0, end: 1, text: "hi", words: [{ text: "hi", start: 0, end: 1.5 }] }];
  const r = D.validateDoc(doc);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /outside cue bounds/.test(e)));
});

test("rejects text/words mismatch", () => {
  const doc = D.newDoc();
  doc.cues = [{ id: "c1", start: 0, end: 1, text: "hi there", words: [{ text: "hi", start: 0, end: 1 }] }];
  const r = D.validateDoc(doc);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /does not match joined words/.test(e)));
});

console.log("captionDoc: syncCueWords");
test("preserves unchanged word times and flags only the edited span", () => {
  const cue = { id: "c1", start: 0, end: 1, text: "we lost everything", words: [
    { text: "we", start: 0, end: 0.2 },
    { text: "lost", start: 0.2, end: 0.5 },
    { text: "everything", start: 0.5, end: 1 },
  ] };
  D.syncCueWords(cue, "we lost nothing");
  assert.strictEqual(cue.text, "we lost nothing");
  assert.strictEqual(cue.words[0].text, "we");
  assert.strictEqual(cue.words[0].start, 0); // unchanged, preserved exactly
  assert.strictEqual(cue.words[1].text, "lost");
  assert.strictEqual(cue.words[1].start, 0.2); // unchanged, preserved exactly
  assert.strictEqual(cue.words[2].text, "nothing");
  assert.strictEqual(cue.words[2].needsTiming, true); // changed token, flagged
});

test("leaves a word-less (SRT-imported) cue word-less after a text edit", () => {
  const cue = { id: "c1", start: 0, end: 1, text: "hello world" };
  D.syncCueWords(cue, "hello there");
  assert.strictEqual(cue.text, "hello there");
  assert.strictEqual(cue.words, undefined);
});

console.log("captionDoc: split / merge / shift");
test("splitCue divides a word-level cue at the given word index", () => {
  const doc = D.newDoc();
  doc.cues = [{ id: "c1", start: 0, end: 1, text: "we lost everything", words: [
    { text: "we", start: 0, end: 0.2 },
    { text: "lost", start: 0.2, end: 0.5 },
    { text: "everything", start: 0.5, end: 1 },
  ] }];
  D.splitCue(doc, "c1", 2);
  assert.strictEqual(doc.cues.length, 2);
  assert.strictEqual(doc.cues[0].text, "we lost");
  assert.strictEqual(doc.cues[1].text, "everything");
  assert.strictEqual(doc.cues[0].end, 0.5);
  assert.strictEqual(doc.cues[1].start, 0.5);
});

test("mergeCues joins two adjacent cues and keeps combined word timing", () => {
  const doc = D.newDoc();
  doc.cues = [
    { id: "c1", start: 0, end: 0.5, text: "we lost", words: [{ text: "we", start: 0, end: 0.2 }, { text: "lost", start: 0.2, end: 0.5 }] },
    { id: "c2", start: 0.5, end: 1, text: "everything", words: [{ text: "everything", start: 0.5, end: 1 }] },
  ];
  D.mergeCues(doc, "c1", "c2");
  assert.strictEqual(doc.cues.length, 1);
  assert.strictEqual(doc.cues[0].text, "we lost everything");
  assert.strictEqual(doc.cues[0].words.length, 3);
  assert.strictEqual(doc.cues[0].start, 0);
  assert.strictEqual(doc.cues[0].end, 1);
});

test("mergeCues drops word timing when only one side has it (never fabricates)", () => {
  const doc = D.newDoc();
  doc.cues = [
    { id: "c1", start: 0, end: 0.5, text: "we lost", words: [{ text: "we", start: 0, end: 0.2 }, { text: "lost", start: 0.2, end: 0.5 }] },
    { id: "c2", start: 0.5, end: 1, text: "everything" },
  ];
  D.mergeCues(doc, "c1", "c2");
  assert.strictEqual(doc.cues[0].words, undefined);
});

test("shiftAll moves every cue and word by the offset, clamped at 0", () => {
  const doc = D.newDoc();
  doc.cues = [{ id: "c1", start: 1, end: 2, text: "hi", words: [{ text: "hi", start: 1, end: 2 }] }];
  D.shiftAll(doc, -5);
  assert.strictEqual(doc.cues[0].start, 0);
  assert.strictEqual(doc.cues[0].words[0].start, 0);
});

console.log("captionDoc: docToCaptionBlocks");
test("chunks each cue's words into karaoke MOGRT blocks of the given size", () => {
  const doc = D.newDoc();
  doc.cues = D.docFromWords(words(["we", 0, 0.2], ["almost", 0.2, 0.5], ["lost", 0.5, 0.8], ["everything.", 0.8, 1.3]));
  const blocks = D.docToCaptionBlocks(doc, { chunkSize: 2 });
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].text, "we almost");
  assert.strictEqual(blocks[1].text, "lost everything.");
  assert.strictEqual(blocks[0].start_time_seconds, 0);
  assert.strictEqual(blocks[0].end_time_seconds, 0.5);
});

test("produces no blocks for word-less (SRT-imported) cues — karaoke stays unavailable", () => {
  const doc = D.newDoc();
  doc.cues = [{ id: "c1", start: 0, end: 1, text: "hello world" }];
  const blocks = D.docToCaptionBlocks(doc, { chunkSize: 2 });
  assert.deepStrictEqual(blocks, []);
});

console.log("captionDoc: SRT round-trip");
test("docToSrt / srtToDoc round-trips cue text and timing (ms-accurate)", () => {
  const doc = D.newDoc();
  doc.cues = [
    { id: "c1", start: 1.234, end: 3.5, text: "hello there" },
    { id: "c2", start: 4, end: 5.001, text: "goodbye" },
  ];
  const srt = D.docToSrt(doc, { maxChars: 42, maxLines: 2 });
  assert.ok(/00:00:01,234 --> 00:00:03,500/.test(srt));
  const back = D.srtToDoc(srt);
  assert.strictEqual(back.cues.length, 2);
  assert.strictEqual(back.cues[0].text, "hello there");
  assert.strictEqual(back.cues[0].start, 1.234);
  assert.strictEqual(back.cues[0].end, 3.5);
  assert.strictEqual(back.cues[1].text, "goodbye");
  assert.strictEqual(back.cues[0].words, undefined); // SRT has no word timing
});

test("docToSrt wraps long lines by the template's maxChars/maxLines", () => {
  const doc = D.newDoc();
  doc.cues = [{ id: "c1", start: 0, end: 2, text: "one two three four five six seven eight" }];
  const srt = D.docToSrt(doc, { maxChars: 12, maxLines: 2 });
  const textBlock = srt.split("\n").slice(2, 4);
  assert.strictEqual(textBlock.length, 2);
  textBlock.forEach((line) => assert.ok(line.length <= 40, `line too long: "${line}"`));
});

console.log(`\n${pass} passed`);
