"use strict";

/** Headless tests for the FCP XML caption-graphics builder (no Premiere needed). */

const assert = require("assert");
const P = require("../js/premiereXml");
const D = require("../js/captionDoc");

let pass = 0;
function test(name, fn) {
  fn();
  pass++;
  console.log("  ok -", name);
}

const TEMPLATE = {
  font: { family: "Segoe UI Black", size: 135, weight: "black" },
  fill: { color: "#FFFFFF" },
  stroke: { width: 4, color: "#000000" },
  shadow: { enabled: true },
  position: { xPct: 50, yPct: 86 },
};

console.log("premiereXml: color/font encoding");
test("hexToColorFloat matches Premiere's packed-int scheme (white = 16777215)", () => {
  assert.strictEqual(P.hexToColorFloat("#FFFFFF"), 16777215);
  assert.strictEqual(P.hexToColorFloat("#000000"), 0);
  assert.strictEqual(P.hexToColorFloat("#E6B450"), 0xe6 * 65536 + 0xb4 * 256 + 0x50);
});

console.log("premiereXml: Source Text base64 round-trip");
test("buildSourceTextValue encodes text that decodeSourceTextValue can recover exactly", () => {
  const value = P.buildSourceTextValue("we almost lost everything", { fillColorFloat: 16777215 });
  assert.strictEqual(P.decodeSourceTextValue(value), "we almost lost everything");
});

test("round-trips text with unicode/punctuation", () => {
  const text = "she said \"I can't believe it\" — café";
  const value = P.buildSourceTextValue(text, {});
  assert.strictEqual(P.decodeSourceTextValue(value), text);
});

console.log("premiereXml: fitFontSizeToWidth");
test("keeps the requested size for a short chunk that comfortably fits", () => {
  assert.strictEqual(P.fitFontSizeToWidth("hi", 90, 1080), 90);
});

test("shrinks a long chunk that would overflow the frame width", () => {
  const longText = "patience just received everything all at once somehow";
  const size = P.fitFontSizeToWidth(longText, 135, 1080);
  assert.ok(size < 135, `expected shrink from 135, got ${size}`);
  // The whole point: at the returned size, estimated width must fit the frame.
  const estimatedWidth = longText.length * size * 0.65;
  assert.ok(estimatedWidth <= 1080 * 0.82 + 1, `estimated width ${estimatedWidth} still overflows`);
});

test("never shrinks below a legible floor", () => {
  const veryLongText = "a".repeat(200);
  assert.ok(P.fitFontSizeToWidth(veryLongText, 90, 1080) >= 24);
});

test("never grows text beyond the template's requested size", () => {
  assert.strictEqual(P.fitFontSizeToWidth("a", 90, 4000), 90);
});

function decodedFontSize(sourceTextValue) {
  const buf = Buffer.from(sourceTextValue, "base64");
  const data = JSON.parse(buf.slice(8).toString("utf16le"));
  return data.mTextParam.mStyleSheet.mFontSize.mParamValues[0][1];
}

test("clipsFromCaptionDoc passes canvas width through so long chunks actually shrink", () => {
  const doc = D.newDoc();
  doc.cues = D.docFromWords([
    { text: "patience", start: 0, end: 0.3 },
    { text: "just", start: 0.3, end: 0.5 },
    { text: "received", start: 0.5, end: 0.9 },
  ]);
  const clips = P.clipsFromCaptionDoc(doc, TEMPLATE, { mode: "karaoke", chunkSize: 3, fps: 30, width: 1080 });
  assert.strictEqual(clips.length, 1);
  const size = decodedFontSize(clips[0].sourceTextValue);
  assert.ok(size < TEMPLATE.font.size, `expected the 3-word chunk to shrink below ${TEMPLATE.font.size}, got ${size}`);
});

console.log("premiereXml: clipsFromCaptionDoc");
function sampleDoc() {
  const doc = D.newDoc();
  doc.cues = D.docFromWords([
    { text: "we", start: 0, end: 0.2 },
    { text: "almost", start: 0.2, end: 0.5 },
    { text: "lost", start: 0.5, end: 0.8 },
    { text: "everything.", start: 0.8, end: 1.3 },
  ]);
  return doc;
}

test("native mode produces one clip per cue with full cue text", () => {
  const doc = sampleDoc();
  const clips = P.clipsFromCaptionDoc(doc, TEMPLATE, { mode: "native", fps: 30 });
  assert.strictEqual(clips.length, doc.cues.length);
  assert.strictEqual(P.decodeSourceTextValue(clips[0].sourceTextValue), doc.cues[0].text);
});

test("karaoke mode produces chunked clips from docToCaptionBlocks", () => {
  const doc = sampleDoc();
  const clips = P.clipsFromCaptionDoc(doc, TEMPLATE, { mode: "karaoke", chunkSize: 2, fps: 30 });
  const expectedBlocks = D.docToCaptionBlocks(doc, { chunkSize: 2 });
  assert.strictEqual(clips.length, expectedBlocks.length);
  assert.strictEqual(P.decodeSourceTextValue(clips[0].sourceTextValue), expectedBlocks[0].text);
});

test("frame numbers follow start/end seconds * fps, end always after start", () => {
  const doc = sampleDoc();
  const clips = P.clipsFromCaptionDoc(doc, TEMPLATE, { mode: "native", fps: 30 });
  assert.strictEqual(clips[0].startFrame, Math.round(doc.cues[0].start * 30));
  clips.forEach((c) => assert.ok(c.endFrame > c.startFrame));
});

test("empty-text cues are skipped", () => {
  const doc = D.newDoc();
  doc.cues = [{ id: "c1", start: 0, end: 1, text: "" }];
  const clips = P.clipsFromCaptionDoc(doc, TEMPLATE, { mode: "native", fps: 30 });
  assert.strictEqual(clips.length, 0);
});

console.log("premiereXml: buildCaptionSequenceXml");
test("wraps every clip in a <clipitem> using the native GraphicAndType effect", () => {
  const doc = sampleDoc();
  const clips = P.clipsFromCaptionDoc(doc, TEMPLATE, { mode: "karaoke", chunkSize: 2, fps: 30 });
  const xml = P.buildCaptionSequenceXml(clips, { fps: 30, width: 1080, height: 1920, sequenceName: "Captions (Test Reel)" });
  assert.ok(xml.indexOf("<!DOCTYPE xmeml>") !== -1);
  assert.ok(xml.indexOf("<name>Captions (Test Reel)</name>") !== -1);
  const clipItemCount = (xml.match(/<clipitem /g) || []).length;
  assert.strictEqual(clipItemCount, clips.length);
  const effectIdCount = (xml.match(/<effectid>GraphicAndType<\/effectid>/g) || []).length;
  assert.strictEqual(effectIdCount, clips.length);
});

test("sequence duration matches the last clip's end frame", () => {
  const doc = sampleDoc();
  const clips = P.clipsFromCaptionDoc(doc, TEMPLATE, { mode: "native", fps: 30 });
  const xml = P.buildCaptionSequenceXml(clips, { fps: 30 });
  const m = /<duration>(\d+)<\/duration>/.exec(xml);
  assert.ok(m);
  assert.strictEqual(Number(m[1]), Math.max(...clips.map((c) => c.endFrame)));
});

test("escapes special characters in the sequence name", () => {
  const xml = P.buildCaptionSequenceXml([], { sequenceName: 'Reel <1> & "Two"' });
  assert.ok(xml.indexOf("Reel &lt;1&gt; &amp; &quot;Two&quot;") !== -1);
});

console.log(`\n${pass} passed`);
