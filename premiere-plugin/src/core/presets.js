"use strict";

/**
 * Finds the two optional Premiere template files the build quality depends on:
 *
 *   • a 9:16 sequence preset (.sqpreset)  — without it reels inherit the project's
 *     raster, i.e. they come out 16:9 instead of 1080×1920
 *   • a caption MOGRT (.mogrt)            — without it captions ship as an .srt the
 *     editor has to drag onto each reel by hand
 *
 * Bundled files under presets/ always win. Otherwise we look inside the installed
 * Premiere application for its built-in "9x16" preset and caption templates, using
 * platform.js for the per-OS application roots.
 *
 * This is where the worst macOS bug lived: the old code built
 * `/Applications/Adobe Premiere Pro 2025/Contents`, a path that cannot exist,
 * because on macOS the resources are *inside* the `.app` bundle. Both lookups
 * therefore returned "" on every Mac, and macOS editors silently got 16:9 reels
 * with hand-dragged SRTs. platform.adobeAppRoots() now resolves the bundle
 * properly, and the tests cover both layouts.
 */

const path = require("path");
const fs = require("fs");
const platformInfo = require("./platform");

const EXT_ROOT = path.resolve(__dirname, "..", "..");

function defaults(deps) {
  const d = deps || {};
  return {
    extRoot: d.extRoot || EXT_ROOT,
    exists: d.exists || ((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }),
    readdir: d.readdir || ((p) => { try { return fs.readdirSync(p); } catch (e) { return []; } }),
    // Join with the TARGET platform's separator so the tests can drive the macOS
    // branch from Windows; identical to path.join in production.
    join: platformInfo.joiner(d),
    deps: d,
  };
}

/** First file in `dir` matching `test`, or "" — never throws on a missing dir. */
function firstMatch(dir, test, d) {
  if (!d.exists(dir)) return "";
  const hit = d.readdir(dir).find(test);
  return hit ? d.join(dir, hit) : "";
}

/**
 * A 9:16 sequence preset: bundled first, then Premiere's built-in portrait preset
 * (shipped as "…9x16….sqpreset" under Settings/SequencePresets/Social).
 */
function findVerticalPreset(deps) {
  const d = defaults(deps);
  const bundled = d.join(d.extRoot, "presets", "ISTV_Vertical_1080x1920.sqpreset");
  if (d.exists(bundled)) return bundled;

  const isVertical = (n) => /9x16|vertical|portrait/i.test(n) && /\.sqpreset$/i.test(n);
  for (const dir of platformInfo.sequencePresetDirs(d.deps)) {
    const hit = firstMatch(dir, isVertical, d);
    if (hit) return hit;
  }
  return "";
}

/**
 * A caption MOGRT: bundled first, then a built-in captions template, preferring
 * the plain "Simple Web" style that most closely matches the reel look.
 */
function findCaptionMogrt(deps) {
  const d = defaults(deps);
  const bundled = d.join(d.extRoot, "presets", "captions.mogrt");
  if (d.exists(bundled)) return bundled;

  for (const dir of platformInfo.captionMogrtDirs(d.deps)) {
    if (!d.exists(dir)) continue;
    const files = d.readdir(dir).filter((n) => /\.mogrt$/i.test(n));
    if (!files.length) continue;
    const pick =
      files.find((n) => /simple web/i.test(n)) ||
      files.find((n) => /web caption/i.test(n)) ||
      files.find((n) => /caption/i.test(n)) ||
      files[0];
    if (pick) return d.join(dir, pick);
  }
  return "";
}

/** Both lookups plus a note describing what the editor will get. */
function discover(deps) {
  const verticalPreset = findVerticalPreset(deps);
  const captionMogrt = findCaptionMogrt(deps);
  return {
    verticalPreset,
    captionMogrt,
    captionMode: captionMogrt ? "karaoke" : "native",
    warnings: [
      verticalPreset ? "" : "No 9:16 sequence preset found — reels will use the project's raster. Add presets/ISTV_Vertical_1080x1920.sqpreset for an exact 1080×1920 frame.",
      captionMogrt ? "" : "No caption template installed — Build reels will import an .srt instead (drag it onto the reel once).",
    ].filter(Boolean),
  };
}

module.exports = { EXT_ROOT, findVerticalPreset, findCaptionMogrt, discover };
