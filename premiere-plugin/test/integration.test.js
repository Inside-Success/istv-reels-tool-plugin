"use strict";

/**
 * End-to-end checks that run the REAL bundled binaries and the real pipeline shape.
 *
 * Everything else in the suite is pure logic with injected dependencies. These tests
 * cover the part that only fails on contact with reality: whether the vendored
 * FFmpeg for this machine actually executes, has the codecs the panel asks for, and
 * produces the exact artifact the backend expects.
 *
 * They skip (rather than fail) when no FFmpeg is available, so the suite still runs
 * on a fresh clone before `npm run vendor`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const ffmpeg = require(path.join(__dirname, "..", "src", "core", "ffmpeg.js"));
const platformInfo = require(path.join(__dirname, "..", "src", "core", "platform.js"));
const reels = require(path.join(__dirname, "..", "src", "core", "reels.js"));
const { analysis } = require("./fixtures/analysis.js");

const diag = ffmpeg.diagnostics();
const haveFfmpeg = diag.ffmpeg.source !== "path" || process.env.ISTV_ASSUME_PATH_FFMPEG === "1";
const skip = haveFfmpeg ? false : "no bundled FFmpeg — run `npm run vendor` first";

let work;
let sample;

test("the vendored FFmpeg for this platform runs and reports a version", { skip }, async () => {
  const { stdout } = await ffmpeg.run(ffmpeg.ffmpegPath(), ["-hide_banner", "-version"], { name: "ffmpeg" });
  assert.match(stdout, /^ffmpeg version/, stdout.slice(0, 200));
  console.log(`      ffmpeg: ${diag.ffmpeg.source} (${platformInfo.platformKey()})`);
});

test("the vendored ffprobe runs", { skip }, async () => {
  const { stdout } = await ffmpeg.run(ffmpeg.ffprobePath(), ["-hide_banner", "-version"], { name: "ffprobe" });
  assert.match(stdout, /^ffprobe version/, stdout.slice(0, 200));
});

test("the bundled FFmpeg has every encoder and filter the panel uses", { skip }, async () => {
  const { stdout: encoders } = await ffmpeg.run(ffmpeg.ffmpegPath(), ["-hide_banner", "-encoders"], { name: "ffmpeg" });
  // libmp3lame: the transcription upload. libx264 + aac: the smooth-playback proxy.
  for (const codec of ["libmp3lame", "libx264", "aac"]) {
    assert.match(encoders, new RegExp(`\\b${codec}\\b`), `bundled ffmpeg lacks the ${codec} encoder`);
  }
  const { stdout: filters } = await ffmpeg.run(ffmpeg.ffmpegPath(), ["-hide_banner", "-filters"], { name: "ffmpeg" });
  assert.match(filters, /\bscale\b/, "bundled ffmpeg lacks the scale filter (needed for proxies)");
});

test("a synthetic test clip can be generated", { skip }, async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "istv-int-"));
  sample = path.join(work, "sample.mp4");
  // 3s of 1920x1080 @ 25fps colour bars with a 440 Hz tone — a stand-in interview.
  await ffmpeg.run(
    ffmpeg.ffmpegPath(),
    [
      "-y",
      "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=25:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      sample,
    ],
    { name: "ffmpeg" }
  );
  assert.ok(fs.statSync(sample).size > 1024);
});

test("probe reads the clip's real duration, raster, fps, and audio presence", { skip }, async () => {
  const meta = await ffmpeg.probe(sample);
  assert.ok(Math.abs(meta.durationSec - 3) < 0.3, `duration ${meta.durationSec} should be ~3s`);
  assert.equal(meta.width, 1920);
  assert.equal(meta.height, 1080);
  assert.equal(meta.fps, 25);
  assert.equal(meta.codec, "h264");
  assert.equal(meta.hasAudio, true);
});

test("audio extraction produces the mono 16 kHz MP3 the backend expects", { skip }, async () => {
  const seen = [];
  const audio = await ffmpeg.extractCompressedAudio(sample, { onProgress: (p) => seen.push(p) });
  try {
    assert.ok(fs.existsSync(audio.path), "the upload artifact exists");
    assert.ok(audio.bytes > 256);
    assert.match(audio.path, /\.mp3$/);

    // Verify the OUTPUT, not just the arguments: this is the one file that leaves
    // the machine, and Rev.ai's accuracy depends on it being what we claim.
    const probed = await ffmpeg.probe(audio.path);
    assert.equal(probed.hasAudio, true);
    assert.equal(probed.width, 0, "no video track — the interview footage never leaves the machine");

    const { stdout } = await ffmpeg.run(
      ffmpeg.ffprobePath(),
      ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels,sample_rate,codec_name",
       "-print_format", "json", audio.path],
      { name: "ffprobe" }
    );
    const stream = JSON.parse(stdout).streams[0];
    assert.equal(stream.channels, 1, "mono");
    assert.equal(stream.sample_rate, "16000", "16 kHz");
    assert.equal(stream.codec_name, "mp3");

    assert.ok(seen.length > 0, "progress was reported");
    assert.ok(seen.every((p) => p >= 0 && p <= 1), "progress stays within 0..1");
  } finally {
    fs.rmSync(audio.path, { force: true });
  }
});

test("audio extraction fails with a clear message on a video with no audio", { skip }, async () => {
  const silent = path.join(work, "silent.mp4");
  await ffmpeg.run(
    ffmpeg.ffmpegPath(),
    ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", silent],
    { name: "ffmpeg" }
  );
  await assert.rejects(() => ffmpeg.extractCompressedAudio(silent), /no audio track/i);
});

test("a proxy renders at the requested height, keeping duration and aspect ratio", { skip }, async () => {
  const proxy = path.join(work, "proxy.mp4");
  await ffmpeg.renderProxy(sample, proxy, { height: 180 });
  const meta = await ffmpeg.probe(proxy);
  assert.equal(meta.height, 180);
  assert.equal(meta.width, 320, "16:9 preserved by scale=-2:h");
  assert.equal(meta.width % 2, 0, "an odd width would be rejected by yuv420p");
  // Premiere requires a proxy to match the source's duration and frame rate.
  assert.ok(Math.abs(meta.durationSec - 3) < 0.4, `proxy duration ${meta.durationSec} must match the source`);
  assert.equal(meta.fps, 25);
});

test("running a missing binary reports FFmpeg by name instead of a bare ENOENT", { skip }, async () => {
  await assert.rejects(
    () => ffmpeg.run(path.join(os.tmpdir(), "definitely-not-ffmpeg-" + process.pid), ["-version"], { name: "ffmpeg" }),
    (e) => {
      assert.match(e.message, /Could not run ffmpeg/);
      assert.match(e.message, new RegExp(platformInfo.platformKey()), "names the platform");
      return true;
    }
  );
});

test("a non-media file is rejected rather than producing a bogus probe", { skip }, async () => {
  const junk = path.join(work, "notavideo.mp4");
  fs.writeFileSync(junk, "this is not a video file");
  await assert.rejects(() => ffmpeg.probe(junk));
});

test("the full analysis-to-host-payload path yields a buildable payload", { skip }, async () => {
  // The panel's real sequence: probe the source, normalize the analysis, build the
  // payload the ExtendScript host consumes — with genuine probe output, not a stub.
  const meta = await ffmpeg.probe(sample);
  const model = reels.normalizeReels(analysis);
  const payload = reels.buildPayload(model, {
    source: { path: sample, meta },
    canvas: { width: 1080, height: 1920 },
    presetPath: "",
    mogrtPath: "",
  });

  assert.equal(payload.fps, 25, "the reel sequence follows the real source frame rate");
  assert.equal(payload.reels[0].reframe.srcW, 1920);
  assert.equal(payload.reels[0].reframe.srcH, 1080);
  assert.equal(payload.captionMode, "native");

  // The payload crosses into ExtendScript as a JSON string literal, so it must
  // survive a round-trip intact.
  const roundTripped = JSON.parse(JSON.stringify(payload));
  assert.deepEqual(roundTripped.reels[0].segments, payload.reels[0].segments);
  assert.ok(roundTripped.reels[0].captionBlocks.length > 0);

  // Size guard: the whole payload is embedded in an evalScript expression, and CEP's
  // practical limit is undocumented. Ten reels of a long interview should stay well
  // under a megabyte; flag it here if the shape ever balloons.
  const bytes = Buffer.byteLength(JSON.stringify(JSON.stringify(payload)), "utf8");
  assert.ok(bytes < 1_000_000, `host payload is ${bytes} bytes — consider passing it via a temp file`);
});

test.after(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true });
});
