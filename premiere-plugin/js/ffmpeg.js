"use strict";

/**
 * FFmpeg access for the panel — audio only.
 *
 * In the Premiere plugin, FFmpeg is NOT the renderer anymore (Premiere owns
 * rendering). Its one remaining job is to turn the interview's source file into
 * the small mono 16 kHz MP3 that gets uploaded for transcription — the only
 * artifact that ever leaves the machine. The full video never leaves.
 *
 * BINARY RESOLUTION (the cross-platform crux). A shipped bundle carries
 * per-platform binaries under vendor/ffmpeg/<platform>-<arch>/, picked by
 * process.platform + process.arch:
 *
 *   1. vendor/ffmpeg/<platform>-<arch>/ffmpeg[.exe]   — what editors get
 *   2. ffmpeg-static / ffprobe-static in node_modules — dev machines only
 *   3. `ffmpeg` / `ffprobe` on PATH                   — last resort
 *
 * EVERY CANDIDATE IS STAT'D BEFORE IT IS ACCEPTED, and that check is the whole
 * point: `require("ffmpeg-static")` computes its path from process.platform and
 * returns a *string* without ever touching the disk. On macOS it therefore
 * happily returns a path to a binary that a Windows-built bundle never contained
 * — and because require() didn't throw, an unchecked fallback chain never
 * advances to PATH. spawn() then fails with a bare ENOENT that says nothing
 * about FFmpeg. Verifying on disk is what makes the fallback real.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

/** premiere-plugin/ — one level up from js/. */
const EXT_ROOT = path.resolve(__dirname, "..");

/** "<platform>-<arch>" — the vendor/ffmpeg subdirectory and bundle-naming key. */
function platformKey(deps) {
  const d = deps || {};
  return (d.platform || process.platform) + "-" + (d.arch || process.arch);
}

/** "ffmpeg" -> "ffmpeg.exe" on Windows. */
function exeName(base, deps) {
  const d = deps || {};
  return (d.platform || process.platform) === "win32" ? base + ".exe" : base;
}

function fileExists(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

/** vendor/ffmpeg/<platform>-<arch>/<name>[.exe] for the running platform. */
function vendorBinaryPath(name, deps) {
  const d = deps || {};
  // path.posix/win32 rather than path.join so a test can assert the macOS layout
  // from Windows; identical to path.join when the target is the running platform.
  const join = (d.platform || process.platform) === "win32" ? path.win32.join : path.posix.join;
  return join(d.extRoot || EXT_ROOT, "vendor", "ffmpeg", platformKey(d), exeName(name, d));
}

/**
 * node_modules fallback, for dev machines only — a shipped bundle never reaches
 * this branch. Returns a bare string; the caller verifies it on disk.
 *
 * Note that `ffprobe-static`'s darwin/arm64 binary is actually x86_64, so on an
 * Apple Silicon dev machine this yields a probe that needs Rosetta. Run
 * `npm run vendor` and the vendor/ branch above wins instead.
 */
function nodeModulesBinaryPath(name) {
  try {
    if (name === "ffmpeg") return String(require("ffmpeg-static") || "");
    const probe = require("ffprobe-static");
    return String((probe && probe.path) || "");
  } catch (e) {
    return "";
  }
}

/**
 * Resolve "ffmpeg" or "ffprobe" to something runnable.
 * Returns { path, source } where source is "vendor" | "node_modules" | "path".
 * Injectable deps (`exists`, `platform`, `arch`, `extRoot`, `fromNodeModules`)
 * let the tests assert each branch without the corresponding files present.
 */
function resolveBinary(name, deps) {
  const d = deps || {};
  const exists = d.exists || fileExists;

  const vendored = vendorBinaryPath(name, d);
  if (exists(vendored)) return { path: vendored, source: "vendor" };

  const fromModules = (d.fromNodeModules || nodeModulesBinaryPath)(name);
  if (fromModules && exists(fromModules)) return { path: fromModules, source: "node_modules" };

  // Bare name — let the OS resolve it from PATH. If it isn't there either, spawn
  // fails and describeMissing() explains what to do.
  return { path: exeName(name, d), source: "path" };
}

function ffmpegPath(deps) {
  return resolveBinary("ffmpeg", deps).path;
}

function ffprobePath(deps) {
  return resolveBinary("ffprobe", deps).path;
}

/** Human-readable diagnosis shown in the panel when a binary can't be run. */
function describeMissing(name, deps) {
  const key = platformKey(deps);
  return (
    `Could not run ${name}. This build of the panel has no bundled ${name} for ${key}, ` +
    `and none was found on your PATH. Reinstall the ISTV Reel Tool package for your ` +
    `platform (${key}), or install FFmpeg so that "${name}" is on PATH.`
  );
}

/** Both binaries' resolution state — surfaced in the panel for support. */
function diagnostics(deps) {
  const ff = resolveBinary("ffmpeg", deps);
  const fp = resolveBinary("ffprobe", deps);
  return {
    platform: platformKey(deps),
    ffmpeg: ff,
    ffprobe: fp,
    // True only when both came from vendor/ — i.e. this really is a self-contained
    // bundle for this platform, not one leaning on the editor's PATH.
    bundled: ff.source === "vendor" && fp.source === "vendor",
  };
}

function run(bin, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/**
 * Parse `ffprobe -print_format json` output into the metadata the panel needs.
 *
 * Split out from probe() so it is testable without running a binary. The frame
 * rate is the part that matters most: NTSC rates must survive as 29.97/23.976
 * rather than rounding to 30/24, because host.jsx builds the reel sequence at
 * this rate and premiereXml.js builds the caption sequence at it too — a
 * mismatch between the two drifts captions out of sync over the reel's length.
 */
function parseProbe(stdout) {
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");

  let fps = 30;
  if (v && v.avg_frame_rate && v.avg_frame_rate !== "0/0") {
    const [n, d] = v.avg_frame_rate.split("/").map(Number);
    if (d) fps = n / d;
  }

  return {
    durationSec: parseFloat((info.format && info.format.duration) || (v && v.duration) || 0) || 0,
    width: v ? Number(v.width) : 0,
    height: v ? Number(v.height) : 0,
    fps: Math.round(fps * 1000) / 1000,
    codec: v ? v.codec_name : "",
    hasAudio: Boolean(a),
  };
}

/** Probe a media file -> { durationSec, width, height, fps, hasAudio, codec }. */
async function probe(filePath) {
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath];
  const { stdout } = await run(ffprobePath(), args);
  return parseProbe(stdout);
}

function timeProgress(totalSec, onProgress) {
  return (s) => {
    if (!onProgress || !totalSec) return;
    const m = s.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
    if (m) {
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      onProgress(Math.max(0, Math.min(1, sec / totalSec)));
    }
  };
}

/**
 * Extract + compress a source file's audio directly to a mono 16 kHz 64k MP3 in
 * one pass (the single upload artifact). Returns { path, bytes, durationSec }.
 */
/**
 * The one upload artifact's encode settings: mono, 16 kHz, 64k MP3, no video.
 * Extracted so the contract with the backend (and therefore Rev.ai) is asserted
 * by the test suite rather than only by a live transcription.
 */
function audioExtractArgs(srcPath, outPath) {
  return [
    "-y",
    "-i", srcPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "64k",
    "-codec:a", "libmp3lame",
    outPath,
  ];
}

async function extractCompressedAudio(srcPath, { onProgress } = {}) {
  const meta = await probe(srcPath);
  if (!meta.hasAudio) throw new Error("Source has no audio track to transcribe");
  const outPath = path.join(os.tmpdir(), `istv-reel-audio-${Date.now()}.mp3`);
  const args = audioExtractArgs(srcPath, outPath);
  await run(ffmpegPath(), args, { onStderr: timeProgress(meta.durationSec, onProgress) });
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 256) {
    throw new Error("Audio extraction produced no output");
  }
  return { path: outPath, bytes: fs.statSync(outPath).size, durationSec: meta.durationSec };
}

/**
 * Render an ASS subtitle string onto a fully TRANSPARENT canvas and encode it as
 * a ProRes 4444 .mov WITH ALPHA. This is the "burned" caption template: the host
 * drops this overlay on an upper video track of the reel so it reads exactly like
 * the CLI tool's karaoke, without touching the reel's own video.
 *
 * ProRes 4444 (not QTRLE) is deliberate: QuickTime Animation is CPU-only and
 * makes Premiere playback stutter/flicker once it's composited over the footage.
 * ProRes 4444 is Premiere-native and plays back smoothly with its alpha channel —
 * bigger files, but smooth is the whole point of the overlay.
 *
 * The libass path escaping (backslashes -> forward slashes, `:` -> `\:`, wrapped
 * in single quotes) mirrors export/media.cjs — without it the native ffmpeg.exe
 * cannot open the .ass file.
 *
 * @returns { path, durationSec }
 */
async function renderCaptionOverlay(assText, { durationSec, width = 1080, height = 1920, fps = 30 } = {}) {
  const dur = Math.max(0.5, Number(durationSec) || 0);
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const assPath = path.join(os.tmpdir(), `istv-caps-${stamp}.ass`);
  const outPath = path.join(os.tmpdir(), `istv-caps-${stamp}.mov`);
  fs.writeFileSync(assPath, assText, "utf8");
  const assEscaped = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  const args = [
    "-y",
    "-f", "lavfi",
    "-i", `color=c=black@0.0:s=${width}x${height}:r=${Number(fps) > 0 ? Number(fps) : 30}:d=${dur.toFixed(3)},format=rgba`,
    "-vf", `subtitles='${assEscaped}':alpha=1`,
    "-c:v", "prores_ks",
    "-profile:v", "4444",
    "-pix_fmt", "yuva444p10le",
    outPath,
  ];
  try {
    await run(ffmpegPath(), args);
  } finally {
    try { fs.unlinkSync(assPath); } catch (e) { /* ignore */ }
  }
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 256) {
    throw new Error("Caption overlay render produced no output");
  }
  return { path: outPath, durationSec: dur };
}

/**
 * Build a lightweight preview PROXY of the source (half-ish res H.264) so Premiere
 * can play 4K footage smoothly. Same frame rate + full duration as the source
 * (required for a valid proxy); scaled to 540p. Exports still use the 4K original.
 * ~10x realtime to encode; ~50MB for a 20-min interview.
 * @returns { path }
 */
/** Proxy encode settings. `-2` keeps the aspect ratio on an even width. */
function proxyArgs(srcPath, outPath, height = 540) {
  return [
    "-y",
    "-i", srcPath,
    "-vf", `scale=-2:${height}`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "28",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    outPath,
  ];
}

async function renderProxy(srcPath, outPath, { onProgress, height = 540 } = {}) {
  const meta = await probe(srcPath);
  const args = proxyArgs(srcPath, outPath, height);
  await run(ffmpegPath(), args, { onStderr: timeProgress(meta.durationSec, onProgress) });
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
    throw new Error("Proxy render produced no output");
  }
  return { path: outPath };
}

module.exports = {
  ffmpegPath,
  ffprobePath,
  probe,
  extractCompressedAudio,
  renderCaptionOverlay,
  renderProxy,
  run,
  // Binary resolution, exposed for the tests and for panel support output.
  platformKey,
  exeName,
  vendorBinaryPath,
  resolveBinary,
  describeMissing,
  diagnostics,
  // Pure helpers, split out so the suite can assert them without a binary.
  parseProbe,
  timeProgress,
  audioExtractArgs,
  proxyArgs,
};
