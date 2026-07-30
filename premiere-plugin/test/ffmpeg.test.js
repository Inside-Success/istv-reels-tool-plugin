"use strict";

/**
 * FFmpeg binary resolution and output parsing.
 *
 * The resolution tests are the important ones. The bug they lock down shipped for
 * real: `require("ffmpeg-static")` returns a path computed from process.platform
 * WITHOUT checking the disk, so a Windows-built bundle installed on a Mac resolved
 * to a binary that wasn't there — and because require() didn't throw, the PATH
 * fallback never engaged. Editors saw a bare ENOENT on "Extract audio".
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ffmpeg = require(path.join(__dirname, "..", "js", "ffmpeg.js"));

const MAC = { platform: "darwin", arch: "arm64", extRoot: "/ext" };
const MAC_INTEL = { platform: "darwin", arch: "x64", extRoot: "/ext" };
const WIN = { platform: "win32", arch: "x64", extRoot: "C:\\ext" };

/** No vendored binaries, and node_modules resolves to nothing. */
const nothingInstalled = { exists: () => false, fromNodeModules: () => "" };

test("vendored binaries are found per platform and arch", () => {
  assert.equal(ffmpeg.vendorBinaryPath("ffmpeg", MAC), "/ext/vendor/ffmpeg/darwin-arm64/ffmpeg");
  assert.equal(ffmpeg.vendorBinaryPath("ffprobe", MAC_INTEL), "/ext/vendor/ffmpeg/darwin-x64/ffprobe");
  assert.equal(
    ffmpeg.vendorBinaryPath("ffmpeg", WIN),
    path.win32.join("C:\\ext", "vendor", "ffmpeg", "win32-x64", "ffmpeg.exe")
  );
});

test("a vendored binary that exists is preferred over everything else", () => {
  const vendored = "/ext/vendor/ffmpeg/darwin-arm64/ffmpeg";
  const r = ffmpeg.resolveBinary("ffmpeg", {
    ...MAC,
    exists: (p) => p === vendored,
    fromNodeModules: () => "/somewhere/node_modules/ffmpeg-static/ffmpeg",
  });
  assert.deepEqual(r, { path: vendored, source: "vendor" });
});

test("Apple Silicon and Intel resolve to different vendored binaries", () => {
  const exists = (p) => p.startsWith("/ext/vendor/ffmpeg/");
  assert.equal(ffmpeg.resolveBinary("ffmpeg", { ...MAC, exists }).path, "/ext/vendor/ffmpeg/darwin-arm64/ffmpeg");
  assert.equal(ffmpeg.resolveBinary("ffmpeg", { ...MAC_INTEL, exists }).path, "/ext/vendor/ffmpeg/darwin-x64/ffmpeg");
});

test("a node_modules path is only accepted after it is verified on disk", () => {
  // THE REGRESSION. ffmpeg-static hands back a plausible path for the current
  // platform whether or not the file was ever downloaded. Without the existence
  // check we would return it and spawn would fail with an opaque ENOENT.
  const ghost = "/ext/node_modules/ffmpeg-static/ffmpeg";
  const r = ffmpeg.resolveBinary("ffmpeg", {
    ...MAC,
    exists: () => false, // nothing is actually on disk
    fromNodeModules: () => ghost,
  });
  assert.notEqual(r.path, ghost, "an unverified node_modules path must not be returned");
  assert.equal(r.source, "path", "resolution must fall through to PATH");
  assert.equal(r.path, "ffmpeg");
});

test("a node_modules binary that does exist is used (the dev-machine path)", () => {
  const real = "/ext/node_modules/ffmpeg-static/ffmpeg";
  const r = ffmpeg.resolveBinary("ffmpeg", {
    ...MAC,
    exists: (p) => p === real,
    fromNodeModules: () => real,
  });
  assert.deepEqual(r, { path: real, source: "node_modules" });
});

test("with nothing installed, resolution falls back to a bare PATH lookup", () => {
  assert.deepEqual(ffmpeg.resolveBinary("ffmpeg", { ...MAC, ...nothingInstalled }), {
    path: "ffmpeg",
    source: "path",
  });
  assert.deepEqual(ffmpeg.resolveBinary("ffprobe", { ...WIN, ...nothingInstalled }), {
    path: "ffprobe.exe",
    source: "path",
  });
});

test("the missing-binary message names the platform and says how to fix it", () => {
  const msg = ffmpeg.describeMissing("ffmpeg", MAC);
  assert.match(msg, /darwin-arm64/, "must name the platform so a wrong-platform bundle is obvious");
  assert.match(msg, /Reinstall/i);
  assert.match(msg, /PATH/);
});

test("diagnostics reports both binaries and whether the bundle is self-contained", () => {
  const bundled = ffmpeg.diagnostics({ ...MAC, exists: () => true });
  assert.equal(bundled.platform, "darwin-arm64");
  assert.equal(bundled.bundled, true);
  assert.equal(bundled.ffmpeg.source, "vendor");

  const bare = ffmpeg.diagnostics({ ...MAC, ...nothingInstalled });
  assert.equal(bare.bundled, false);
  assert.equal(bare.ffprobe.source, "path");
});

test("this machine can actually resolve ffmpeg and ffprobe", () => {
  // An end-to-end check of the real resolution chain on the machine running the
  // suite: whatever the source, both binaries must resolve to something.
  const d = ffmpeg.diagnostics();
  assert.ok(["vendor", "node_modules", "path"].includes(d.ffmpeg.source));
  assert.ok(["vendor", "node_modules", "path"].includes(d.ffprobe.source));
  assert.ok(d.ffmpeg.path.length > 0);
});

// ── output parsing ────────────────────────────────────────────────────────────

test("parseProbe reads a constant-frame-rate camera file", () => {
  const meta = ffmpeg.parseProbe(
    JSON.stringify({
      format: { duration: "1834.523000" },
      streams: [
        { codec_type: "video", codec_name: "h264", width: 3840, height: 2160, avg_frame_rate: "30000/1001" },
        { codec_type: "audio", codec_name: "aac" },
      ],
    })
  );
  assert.equal(meta.durationSec, 1834.523);
  assert.equal(meta.width, 3840);
  assert.equal(meta.height, 2160);
  assert.equal(meta.fps, 29.97, "NTSC rates must survive as 29.97, not round to 30");
  assert.equal(meta.codec, "h264");
  assert.equal(meta.hasAudio, true);
});

test("parseProbe handles 23.976 and 25 fps", () => {
  const fpsOf = (rate) =>
    ffmpeg.parseProbe(JSON.stringify({ format: {}, streams: [{ codec_type: "video", avg_frame_rate: rate }] })).fps;
  assert.equal(fpsOf("24000/1001"), 23.976);
  assert.equal(fpsOf("25/1"), 25);
  assert.equal(fpsOf("60000/1001"), 59.94);
});

test("parseProbe detects a video with no audio track", () => {
  const meta = ffmpeg.parseProbe(
    JSON.stringify({ format: { duration: "10" }, streams: [{ codec_type: "video", avg_frame_rate: "30/1" }] })
  );
  assert.equal(meta.hasAudio, false, "extractCompressedAudio relies on this to fail early with a clear message");
});

test("parseProbe survives a missing or degenerate frame rate", () => {
  const meta = ffmpeg.parseProbe(
    JSON.stringify({ format: {}, streams: [{ codec_type: "video", avg_frame_rate: "0/0" }] })
  );
  assert.equal(meta.fps, 30, "falls back to 30 rather than NaN");
  assert.equal(meta.durationSec, 0);

  const audioOnly = ffmpeg.parseProbe(
    JSON.stringify({ format: { duration: "42" }, streams: [{ codec_type: "audio" }] })
  );
  assert.equal(audioOnly.width, 0);
  assert.equal(audioOnly.hasAudio, true);
  assert.equal(audioOnly.durationSec, 42);
});

test("timeProgress converts ffmpeg's stderr timestamps into a 0..1 fraction", () => {
  const seen = [];
  const onStderr = ffmpeg.timeProgress(100, (p) => seen.push(p));
  onStderr("frame= 100 fps=25 time=00:00:25.00 bitrate=1000k");
  onStderr("frame= 400 fps=25 time=00:01:40.00 bitrate=1000k"); // 100s = the end
  onStderr("frame= 500 fps=25 time=00:02:00.00 bitrate=1000k"); // past the end
  onStderr("garbage with no timestamp");
  assert.deepEqual(seen, [0.25, 1, 1], "clamped to 1, and non-matching lines ignored");
});

test("timeProgress is inert without a callback or a known duration", () => {
  assert.doesNotThrow(() => ffmpeg.timeProgress(100, null)("time=00:00:01.00"));
  assert.doesNotThrow(() => ffmpeg.timeProgress(0, () => assert.fail("must not fire"))("time=00:00:01.00"));
});

// ── argument vectors ──────────────────────────────────────────────────────────

test("the audio extract command produces the mono 16 kHz MP3 the backend expects", () => {
  const args = ffmpeg.audioExtractArgs("/in/interview.mov", "/tmp/out.mp3");
  const flag = (f) => args[args.indexOf(f) + 1];
  assert.equal(flag("-i"), "/in/interview.mov");
  assert.equal(flag("-ac"), "1", "mono");
  assert.equal(flag("-ar"), "16000", "16 kHz — what Rev.ai wants");
  assert.equal(flag("-b:a"), "64k");
  assert.equal(flag("-codec:a"), "libmp3lame");
  assert.ok(args.includes("-vn"), "video must be dropped — it never leaves the machine");
  assert.equal(args[args.length - 1], "/tmp/out.mp3");
});

test("the proxy command is H.264 yuv420p at the requested height", () => {
  const args = ffmpeg.proxyArgs("/in/4k.mov", "/out/proxy.mp4", 540);
  const flag = (f) => args[args.indexOf(f) + 1];
  assert.equal(flag("-vf"), "scale=-2:540", "-2 keeps the aspect ratio on an even width");
  assert.equal(flag("-c:v"), "libx264");
  assert.equal(flag("-pix_fmt"), "yuv420p", "Premiere needs 4:2:0 for smooth proxy playback");
  assert.equal(flag("-c:a"), "aac");
  assert.equal(args[args.length - 1], "/out/proxy.mp4");
});

test("paths with spaces are passed as single argv entries, never shell-quoted", () => {
  // Everything spawns with an argv array, so a path with spaces needs no quoting —
  // and must not be given any, or ffmpeg would look for a literally-quoted name.
  const p = "/Users/me/My Footage/take 1.mov";
  const args = ffmpeg.audioExtractArgs(p, "/tmp/a b.mp3");
  assert.ok(args.includes(p), "the path appears verbatim as one argument");
  assert.ok(!args.some((a) => a.includes('"')), "no quoting");
});
