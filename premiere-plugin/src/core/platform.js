"use strict";

/**
 * Everything OS-specific in one place.
 *
 * The panel ships to editors on Windows (x64) and macOS (Apple Silicon + Intel),
 * so no other module is allowed to branch on `process.platform` directly — it all
 * funnels through here. Every function takes an optional dependency bag
 * (`platform`, `arch`, `env`, `homedir`, `exists`, `readdir`) so the test suite can
 * exercise the macOS paths from a Windows machine and vice versa.
 *
 * Supported targets: win32-x64, darwin-arm64, darwin-x64.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

/** The three platforms we vendor binaries for and ship installers for. */
const SUPPORTED_TARGETS = ["win32-x64", "darwin-arm64", "darwin-x64"];

function defaults(deps) {
  const d = deps || {};
  return {
    platform: d.platform || process.platform,
    arch: d.arch || process.arch,
    env: d.env || process.env,
    homedir: d.homedir || os.homedir(),
    exists: d.exists || ((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }),
    readdir: d.readdir || ((p) => { try { return fs.readdirSync(p); } catch (e) { return []; } }),
  };
}

/**
 * "<platform>-<arch>" — the key used for vendor/ffmpeg/<key>/ and for naming
 * release bundles. Apple Silicon reports arm64; Rosetta-launched Premiere reports
 * x64, and that is correct: a Rosetta host runs the x64 binaries.
 */
function platformKey(deps) {
  const { platform, arch } = defaults(deps);
  return platform + "-" + arch;
}

function isWindows(deps) {
  return defaults(deps).platform === "win32";
}

function isMac(deps) {
  return defaults(deps).platform === "darwin";
}

/** Executable file name for this platform ("ffmpeg" -> "ffmpeg.exe" on Windows). */
function exeName(base, deps) {
  return isWindows(deps) ? base + ".exe" : base;
}

/**
 * path.join for the TARGET platform rather than the host's.
 *
 * In production these are the same thing, so plain path.join would work. It is
 * wrong for the tests, which is the point: asserting macOS path construction from a
 * Windows machine (and vice versa) is the only way these branches get exercised
 * before an editor runs them, and bare path.join silently produces
 * "\Applications\...\Contents" under test.
 */
function joiner(deps) {
  return isWindows(deps) ? path.win32.join : path.posix.join;
}

/**
 * Where Premiere looks for CEP extensions, most-specific first. The per-user
 * directory is what both installers write to — it needs no admin rights on either
 * OS. The system-wide one is listed so the dev tools can detect a stale install.
 */
function cepExtensionDirs(deps) {
  const { env, homedir } = defaults(deps);
  if (isMac(deps)) {
    return [
      path.posix.join(homedir, "Library/Application Support/Adobe/CEP/extensions"),
      "/Library/Application Support/Adobe/CEP/extensions",
    ];
  }
  const appData = env.APPDATA || path.win32.join(homedir, "AppData", "Roaming");
  const common = env.CommonProgramFiles || "C:\\Program Files\\Common Files";
  return [
    path.win32.join(appData, "Adobe", "CEP", "extensions"),
    path.win32.join(common, "Adobe", "CEP", "extensions"),
  ];
}

/** The per-user CEP extensions directory — the one we install into. */
function userCepExtensionDir(deps) {
  return cepExtensionDirs(deps)[0];
}

/**
 * Installed Premiere Pro application roots, normalised so that
 * `<root>/Settings/...` and `<root>/Essential Graphics/...` are valid on both OSes.
 *
 * macOS is the subtle one. `/Applications/Adobe Premiere Pro 2025` is a *folder*
 * that contains `Adobe Premiere Pro 2025.app`, and the resources live inside the
 * bundle — so the root is `<folder>/<name>.app/Contents`, not `<folder>/Contents`.
 * (The previous version of this code used the latter, which cannot exist, so every
 * macOS editor silently got 16:9 reels and no karaoke captions.) We accept the
 * `.app` sitting directly in /Applications too, and probe each candidate for real.
 */
function adobeAppRoots(deps) {
  const d = defaults(deps);
  const out = [];
  const push = (p) => {
    if (p && out.indexOf(p) === -1 && d.exists(p)) out.push(p);
  };

  if (isMac(deps)) {
    for (const base of ["/Applications", path.posix.join(d.homedir, "Applications")]) {
      if (!d.exists(base)) continue;
      for (const entry of d.readdir(base)) {
        if (!/Premiere Pro/i.test(entry)) continue;
        const full = path.posix.join(base, entry);
        if (/\.app$/i.test(entry)) {
          // The bundle itself is in /Applications.
          push(path.posix.join(full, "Contents"));
          continue;
        }
        // A version folder containing the bundle: prefer the same-named .app,
        // then any Premiere .app inside it.
        push(path.posix.join(full, entry + ".app", "Contents"));
        for (const inner of d.readdir(full)) {
          if (/Premiere Pro.*\.app$/i.test(inner)) push(path.posix.join(full, inner, "Contents"));
        }
        // Last resort for a layout where resources sit beside the bundle.
        push(path.posix.join(full, "Contents"));
      }
    }
    return out;
  }

  const bases = [
    d.env.ProgramFiles || "C:\\Program Files",
    d.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
  ].map((b) => path.win32.join(b, "Adobe"));
  for (const base of bases) {
    if (!d.exists(base)) continue;
    for (const entry of d.readdir(base)) {
      if (/Premiere Pro/i.test(entry)) push(path.win32.join(base, entry));
    }
  }
  return out;
}

/**
 * Directories that hold Premiere's built-in 9:16 sequence presets, in priority
 * order. Both OSes share the layout once adobeAppRoots() has normalised the root.
 */
function sequencePresetDirs(deps) {
  const join = joiner(deps);
  const dirs = [];
  for (const root of adobeAppRoots(deps)) {
    dirs.push(join(root, "Settings", "SequencePresets", "Social"));
    dirs.push(join(root, "Settings", "SequencePresets"));
  }
  return dirs;
}

/** Directories that hold Premiere's built-in caption MOGRTs, in priority order. */
function captionMogrtDirs(deps) {
  const d = defaults(deps);
  const join = joiner(deps);
  const dirs = [];
  for (const root of adobeAppRoots(deps)) {
    dirs.push(join(root, "Essential Graphics", "Captions and Subtitles"));
    dirs.push(join(root, "Essential Graphics"));
  }
  // Shared Essential Graphics store (populated by Creative Cloud, not the installer).
  if (isMac(deps)) {
    dirs.push("/Library/Application Support/Adobe/Common/Essential Graphics");
    dirs.push(path.posix.join(d.homedir, "Library/Application Support/Adobe/Common/Essential Graphics"));
  } else {
    const common = d.env.CommonProgramFiles || "C:\\Program Files\\Common Files";
    dirs.push(path.win32.join(common, "Adobe", "Essential Graphics"));
  }
  return dirs;
}

/**
 * The command that reveals a folder in the OS file manager.
 * Windows uses explorer.exe; macOS uses `open`. Spawning "explorer" on macOS was
 * previously an uncaught async 'error' event (see openFolder).
 */
function openFolderCommand(dir, deps) {
  return isWindows(deps)
    ? { cmd: "explorer", args: [String(dir)] }
    : { cmd: "open", args: [String(dir)] };
}

/**
 * Reveal a folder, never throwing. `spawn` reports a missing executable through an
 * asynchronous 'error' event, not a synchronous throw — without the listener below
 * Node re-throws it as an uncaught exception, so the old try/catch around
 * spawn("explorer") did nothing on macOS. Returns true if the spawn was attempted.
 */
function openFolder(dir, deps) {
  const { cmd, args } = openFolderCommand(dir, deps);
  try {
    const child = require("child_process").spawn(cmd, args, { detached: true, windowsHide: true });
    child.on("error", () => {}); // missing/blocked opener: the files are already written
    if (typeof child.unref === "function") child.unref();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * The CSXS versions whose PlayerDebugMode flag must be set for an unsigned
 * extension to load. 9 = CEP 9 (Premiere 2019) through 12 = CEP 12 (2024/2025);
 * setting a superset is harmless and covers future builds.
 */
const CSXS_VERSIONS = [9, 10, 11, 12];

module.exports = {
  SUPPORTED_TARGETS,
  CSXS_VERSIONS,
  platformKey,
  isWindows,
  isMac,
  exeName,
  joiner,
  cepExtensionDirs,
  userCepExtensionDir,
  adobeAppRoots,
  sequencePresetDirs,
  captionMogrtDirs,
  openFolderCommand,
  openFolder,
};
