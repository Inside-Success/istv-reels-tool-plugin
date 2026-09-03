"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const backend = require("../js/backend");

test("hasTranscriptWords rejects missing and empty transcripts", () => {
  assert.equal(backend.hasTranscriptWords(null), false);
  assert.equal(backend.hasTranscriptWords({}), false);
  assert.equal(backend.hasTranscriptWords({ words: [] }), false);
  assert.equal(backend.hasTranscriptWords({ words: "not-an-array" }), false);
});

test("hasTranscriptWords accepts a populated Rev.ai transcript", () => {
  assert.equal(backend.hasTranscriptWords({ words: [{ word: "hello", start: 0, end: 0.4 }] }), true);
});

test("selectReels rejects an empty transcript before making a request", async () => {
  await assert.rejects(
    backend.selectReels({ words: [] }, "", 10),
    /Transcription returned no spoken words/
  );
});
