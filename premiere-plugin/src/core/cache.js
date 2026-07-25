"use strict";

/**
 * On-disk caches, all under ~/.istv-reel-tool/ (os.homedir() resolves correctly on
 * both Windows and macOS, so no platform branching is needed here):
 *
 *   transcripts/<fingerprint>.json   Rev.ai output, keyed by SOURCE FILE identity.
 *                                    The slow, paid step — re-running the same clip
 *                                    reuses it and skips Rev.ai entirely.
 *   proxies/<fingerprint>.mp4        smooth-playback proxies.
 *   last-run.json                    the previous session's reels, so reopening the
 *                                    panel can rebuild without re-transcribing.
 *
 * The fingerprint is sha1(path + size + mtime), so re-exporting or re-editing the
 * source changes the key and the transcript is regenerated.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const ROOT = path.join(os.homedir(), ".istv-reel-tool");
const TRANSCRIPT_DIR = path.join(ROOT, "transcripts");
const PROXY_DIR = path.join(ROOT, "proxies");
const LAST_RUN_FILE = path.join(ROOT, "last-run.json");

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Identity of a source file: path + size + mtime, hashed. Pure given `stat`, so the
 * tests can assert that a changed size or mtime produces a different key.
 */
function sourceFingerprint(srcPath, stat) {
  const statFn = stat || ((p) => fs.statSync(p));
  try {
    const st = statFn(srcPath);
    return crypto
      .createHash("sha1")
      .update(String(srcPath) + "|" + st.size + "|" + Math.round(st.mtimeMs))
      .digest("hex")
      .slice(0, 16);
  } catch (e) {
    return crypto.createHash("sha1").update(String(srcPath || "unknown")).digest("hex").slice(0, 16);
  }
}

function transcriptPath(fingerprint) {
  return path.join(TRANSCRIPT_DIR, fingerprint + ".json");
}

function proxyPath(fingerprint) {
  return path.join(PROXY_DIR, fingerprint + ".mp4");
}

/** A saved transcript, or null. Only accepted when it actually carries words. */
function loadTranscript(fingerprint) {
  try {
    const t = JSON.parse(fs.readFileSync(transcriptPath(fingerprint), "utf8"));
    return t && Array.isArray(t.words) && t.words.length ? t : null;
  } catch (e) {
    return null;
  }
}

function saveTranscript(fingerprint, transcript) {
  try {
    ensureDir(TRANSCRIPT_DIR);
    fs.writeFileSync(transcriptPath(fingerprint), JSON.stringify(transcript), "utf8");
    return true;
  } catch (e) {
    return false;
  }
}

function saveLastRun(payload) {
  try {
    ensureDir(ROOT);
    fs.writeFileSync(LAST_RUN_FILE, JSON.stringify(payload), "utf8");
    return true;
  } catch (e) {
    return false;
  }
}

function loadLastRun() {
  try {
    return JSON.parse(fs.readFileSync(LAST_RUN_FILE, "utf8"));
  } catch (e) {
    return null;
  }
}

module.exports = {
  ROOT,
  TRANSCRIPT_DIR,
  PROXY_DIR,
  LAST_RUN_FILE,
  ensureDir,
  sourceFingerprint,
  transcriptPath,
  proxyPath,
  loadTranscript,
  saveTranscript,
  saveLastRun,
  loadLastRun,
};
