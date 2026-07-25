"use strict";

/**
 * FFmpeg access for the panel — audio extraction and preview proxies only.
 *
 * Premiere owns rendering here, so FFmpeg has two jobs:
 *   1. turn the interview into the small mono 16 kHz MP3 that gets uploaded for
 *      transcription (the only artifact that ever leaves the machine), and
 *   2. build an optional low-res proxy so 4K footage scrubs smoothly.
 *
 * BINARY RESOLUTION (this is the cross-platform crux). A shipped bundle carries
 * per-platform binaries under vendor/ffmpeg/<platform>-<arch>/, and we pick by
 * process.platform + process.arch:
 *
 *   1. vendor/ffmpeg/<platform>-<arch>/ffmpeg[.exe]   — what editors get
 *   2. ffmpeg-static / ffprobe-static in node_modules — dev machines only
 *   3. `ffmpeg` / `ffprobe` on PATH                   — last resort
 *
 * Every candidate is verified with a real stat before it is accepted. That check
 * is the fix for a genuine cross-platform failure: `require("ffmpeg-static")`
 * computes its path from process.platform and returns a *string* without touching
 * the disk, so on macOS it happily returned a path to a binary that a
 * Windows-built bundle never contained — and because require() didn't throw, the
 * PATH fallback never engaged. spawn() then failed with a bare ENOENT that said
 * nothing about FFmpeg.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const platformInfo = require("./platform");

/** premiere-plugin/ — two levels up from src/core/. */
const EXT_ROOT = path.resolve(__dirname, "..", "..");

function fileExists(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

/** vendor/ffmpeg/<platform>-<arch>/<name>[.exe] for the running platform. */
function vendorBinaryPath(name, deps) {
  // joiner() rather than path.join so a test can assert the macOS layout from
  // Windows; identical to path.join when the target is the running platform.
  return platformInfo.joiner(deps)(
    (deps && deps.extRoot) || EXT_ROOT,
    "vendor",
    "ffmpeg",
    platformInfo.platformKey(deps),
    platformInfo.exeName(name, deps)
  );
}

/**
 * node_modules fallback for dev machines — resolved, then verified on disk.
 *
 * Dev convenience only; a shipped bundle never reaches this branch. Note that
 * `ffprobe-static`'s darwin/arm64 binary is actually x86_64, so on an Apple Silicon
 * dev machine this path yields a probe that needs Rosetta. Run `npm run vendor` and
 * the vendor/ branch above wins — its binaries are architecture-verified at fetch
 * time (see tools/vendor-ffmpeg.mjs verifyArch).
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
 * Injectable deps (`exists`, `platform`, `arch`, `extRoot`, `fromNodeModules`) let
 * the tests assert each branch without the corresponding files being present.
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
  return { path: platformInfo.exeName(name, d), source: "path" };
}

function ffmpegPath(deps) {
  return resolveBinary("ffmpeg", deps).path;
}

function ffprobePath(deps) {
  return resolveBinary("ffprobe", deps).path;
}

/** Human-readable diagnosis shown in the panel when a binary can't be run. */
function describeMissing(name, deps) {
  const key = platformInfo.platformKey(deps);
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
    platform: platformInfo.platformKey(deps),
    ffmpeg: ff,
    ffprobe: fp,
    bundled: ff.source === "vendor" && fp.source === "vendor",
  };
}

function run(bin, args, { onStderr, name } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      reject(new Error(describeMissing(name || path.basename(bin))));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });
    child.on("error", (e) => {
      // ENOENT/EACCES here means the resolved path isn't runnable on this OS —
      // the one case where a clear message matters most (see the header comment).
      if (e && (e.code === "ENOENT" || e.code === "EACCES")) {
        reject(new Error(describeMissing(name || path.basename(bin)) + ` (${e.code})`));
      } else {
        reject(e);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/**
 * Parse `ffprobe -print_format json` output into the shape the panel needs.
 * Pure, so the tests can drive it with fixture JSON.
 */
function parseProbe(stdout) {
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");

  let fps = 30;
  if (v && v.avg_frame_rate && v.avg_frame_rate !== "0/0") {
    const [n, den] = String(v.avg_frame_rate).split("/").map(Number);
    if (den) fps = n / den;
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
  const { stdout } = await run(ffprobePath(), args, { name: "ffprobe" });
  return parseProbe(stdout);
}

/** Turn ffmpeg's `time=HH:MM:SS.ms` stderr chatter into a 0..1 progress fraction. */
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

/** Argument vector for the single upload artifact — kept pure for the tests. */
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

/**
 * Extract + compress a source file's audio to a mono 16 kHz 64k MP3 in one pass.
 * Returns { path, bytes, durationSec }.
 */
async function extractCompressedAudio(srcPath, { onProgress } = {}) {
  const meta = await probe(srcPath);
  if (!meta.hasAudio) throw new Error("Source has no audio track to transcribe");
  const outPath = path.join(os.tmpdir(), `istv-reel-audio-${Date.now()}.mp3`);
  await run(ffmpegPath(), audioExtractArgs(srcPath, outPath), {
    name: "ffmpeg",
    onStderr: timeProgress(meta.durationSec, onProgress),
  });
  if (!fileExists(outPath) || fs.statSync(outPath).size < 256) {
    throw new Error("Audio extraction produced no output");
  }
  return { path: outPath, bytes: fs.statSync(outPath).size, durationSec: meta.durationSec };
}

/** Argument vector for the smooth-playback proxy — kept pure for the tests. */
function proxyArgs(srcPath, outPath, height) {
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

/**
 * Build a lightweight preview proxy (H.264, 540p, same fps + full duration as the
 * source, which Premiere requires of a proxy) so 4K plays back smoothly. Exports
 * still use the original. ~10x realtime; ~50 MB for a 20-minute interview.
 */
async function renderProxy(srcPath, outPath, { onProgress, height = 540 } = {}) {
  const meta = await probe(srcPath);
  await run(ffmpegPath(), proxyArgs(srcPath, outPath, height), {
    name: "ffmpeg",
    onStderr: timeProgress(meta.durationSec, onProgress),
  });
  if (!fileExists(outPath) || fs.statSync(outPath).size < 1024) {
    throw new Error("Proxy render produced no output");
  }
  return { path: outPath };
}

module.exports = {
  EXT_ROOT,
  resolveBinary,
  vendorBinaryPath,
  ffmpegPath,
  ffprobePath,
  describeMissing,
  diagnostics,
  parseProbe,
  probe,
  timeProgress,
  audioExtractArgs,
  proxyArgs,
  extractCompressedAudio,
  renderProxy,
  run,
};
