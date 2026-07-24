"use strict";

/**
 * FFmpeg access for the panel — audio only.
 *
 * In the Premiere plugin, FFmpeg is NOT the renderer anymore (Premiere owns
 * rendering). Its one remaining job is to turn the interview's source file into
 * the small mono 16 kHz MP3 that gets uploaded for transcription — the only
 * artifact that ever leaves the machine. The full video never leaves.
 *
 * Binaries come from ffmpeg-static / ffprobe-static (see package.json). If those
 * packages aren't installed we fall back to `ffmpeg`/`ffprobe` on PATH so the
 * panel still works against a system install.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

function tryResolve(mod, pick) {
  try {
    const v = require(mod);
    const p = pick ? pick(v) : v;
    // In a packaged CEP build there is no app.asar; this is a no-op there, and
    // matches the desktop app's unpacked-path rewrite when there is one.
    return p ? String(p).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : null;
  } catch (e) {
    return null;
  }
}

function ffmpegPath() {
  return tryResolve("ffmpeg-static") || "ffmpeg";
}

function ffprobePath() {
  return tryResolve("ffprobe-static", (m) => m.path) || "ffprobe";
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

/** Probe a media file -> { durationSec, width, height, fps, hasAudio, codec }. */
async function probe(filePath) {
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath];
  const { stdout } = await run(ffprobePath(), args);
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
async function extractCompressedAudio(srcPath, { onProgress } = {}) {
  const meta = await probe(srcPath);
  if (!meta.hasAudio) throw new Error("Source has no audio track to transcribe");
  const outPath = path.join(os.tmpdir(), `istv-reel-audio-${Date.now()}.mp3`);
  const args = [
    "-y",
    "-i", srcPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "64k",
    "-codec:a", "libmp3lame",
    outPath,
  ];
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
async function renderProxy(srcPath, outPath, { onProgress, height = 540 } = {}) {
  const meta = await probe(srcPath);
  const args = [
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
  await run(ffmpegPath(), args, { onStderr: timeProgress(meta.durationSec, onProgress) });
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
    throw new Error("Proxy render produced no output");
  }
  return { path: outPath };
}

module.exports = { ffmpegPath, ffprobePath, probe, extractCompressedAudio, renderCaptionOverlay, renderProxy, run };
