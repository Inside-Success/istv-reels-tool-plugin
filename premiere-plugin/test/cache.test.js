"use strict";

/**
 * The on-disk caches. The fingerprint is the important part: it decides whether a
 * re-run skips Rev.ai (saving money and minutes) or re-transcribes. Too sticky and
 * an edited source silently reuses a stale transcript; too loose and every run pays
 * again.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const cache = require(path.join(__dirname, "..", "src", "core", "cache.js"));

const stat = (size, mtimeMs) => () => ({ size, mtimeMs });

test("the same path, size, and mtime give the same fingerprint", () => {
  const a = cache.sourceFingerprint("/media/interview.mp4", stat(12345, 1700000000000));
  const b = cache.sourceFingerprint("/media/interview.mp4", stat(12345, 1700000000000));
  assert.equal(a, b);
  assert.equal(a.length, 16);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("a changed size, mtime, or path changes the fingerprint", () => {
  const base = cache.sourceFingerprint("/media/interview.mp4", stat(12345, 1700000000000));
  assert.notEqual(cache.sourceFingerprint("/media/interview.mp4", stat(99999, 1700000000000)), base, "re-export changes size");
  assert.notEqual(cache.sourceFingerprint("/media/interview.mp4", stat(12345, 1800000000000)), base, "re-edit changes mtime");
  assert.notEqual(cache.sourceFingerprint("/media/other.mp4", stat(12345, 1700000000000)), base, "a different file is a different key");
});

test("sub-millisecond mtime jitter does not invalidate the cache", () => {
  // Filesystems report mtimeMs with varying precision; rounding keeps a re-detect
  // of an untouched file on the same key instead of paying Rev.ai again.
  const a = cache.sourceFingerprint("/m/x.mp4", stat(10, 1700000000000.4));
  const b = cache.sourceFingerprint("/m/x.mp4", stat(10, 1700000000000.2));
  assert.equal(a, b);
});

test("an unstattable file still yields a stable fingerprint instead of throwing", () => {
  const throwing = () => {
    throw new Error("ENOENT");
  };
  const a = cache.sourceFingerprint("/gone.mp4", throwing);
  assert.equal(a, cache.sourceFingerprint("/gone.mp4", throwing));
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("cache paths live under the user's home on either OS", () => {
  const home = os.homedir();
  assert.ok(cache.ROOT.startsWith(home), `${cache.ROOT} should be under ${home}`);
  assert.equal(cache.transcriptPath("abc123"), path.join(cache.TRANSCRIPT_DIR, "abc123.json"));
  assert.equal(cache.proxyPath("abc123"), path.join(cache.PROXY_DIR, "abc123.mp4"));
});

test("a transcript round-trips, and a word-less one is rejected", () => {
  const fp = "test" + process.pid;
  try {
    assert.equal(cache.loadTranscript(fp), null, "nothing cached yet");

    assert.equal(cache.saveTranscript(fp, { words: [{ word: "hello", time: 0 }], word_count: 1 }), true);
    const loaded = cache.loadTranscript(fp);
    assert.equal(loaded.words.length, 1);
    assert.equal(loaded.words[0].word, "hello");

    // A transcript with no words is worse than none: it would skip Rev.ai and then
    // produce a reel with no captions at all.
    cache.saveTranscript(fp, { words: [] });
    assert.equal(cache.loadTranscript(fp), null);
    cache.saveTranscript(fp, { nonsense: true });
    assert.equal(cache.loadTranscript(fp), null);
  } finally {
    fs.rmSync(cache.transcriptPath(fp), { force: true });
  }
});

test("a corrupt cache file reads as a miss rather than crashing the panel", () => {
  const fp = "corrupt" + process.pid;
  try {
    cache.ensureDir(cache.TRANSCRIPT_DIR);
    fs.writeFileSync(cache.transcriptPath(fp), "{ truncated", "utf8");
    assert.equal(cache.loadTranscript(fp), null);
  } finally {
    fs.rmSync(cache.transcriptPath(fp), { force: true });
  }
});

test("the last-run cache round-trips reels for a rebuild without re-transcribing", () => {
  const backup = cache.loadLastRun(); // don't clobber a real session
  try {
    assert.equal(cache.saveLastRun({ source: { path: "/x.mp4" }, reels: [{ title: "A", built: true }] }), true);
    const loaded = cache.loadLastRun();
    assert.equal(loaded.reels.length, 1);
    assert.equal(loaded.source.path, "/x.mp4");
  } finally {
    if (backup) cache.saveLastRun(backup);
    else fs.rmSync(cache.LAST_RUN_FILE, { force: true });
  }
});

test("ensureDir is idempotent and reports failure instead of throwing", () => {
  assert.equal(cache.ensureDir(cache.TRANSCRIPT_DIR), true);
  assert.equal(cache.ensureDir(cache.TRANSCRIPT_DIR), true, "already exists");
  // A path under an existing FILE cannot be a directory — must return false, not throw.
  const blocker = path.join(os.tmpdir(), `istv-blocker-${process.pid}`);
  fs.writeFileSync(blocker, "x");
  try {
    assert.equal(cache.ensureDir(path.join(blocker, "child")), false);
  } finally {
    fs.rmSync(blocker, { force: true });
  }
});
