#!/usr/bin/env node
/**
 * DEV install — for whoever is working on the repo, on Windows or macOS.
 *
 *   node tools/dev-install.mjs            # symlink (edits appear on panel reload)
 *   node tools/dev-install.mjs --copy     # copy instead of symlink
 *   node tools/dev-install.mjs --status    # what's installed right now
 *   node tools/dev-install.mjs --uninstall
 *
 * Symlinking the live folder into Premiere's CEP extensions directory means an edit
 * to src/ shows up on the next panel reload — no repackaging while developing. On
 * macOS a symlink needs no special rights; on Windows it needs Admin or Developer
 * Mode, so we fall back to a copy and say so.
 *
 * Enabling unsigned extensions is genuinely OS-specific: Windows stores
 * PlayerDebugMode in HKCU, macOS in a CSXS plist via `defaults`.
 */

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, cpSync, readFileSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");
const EXT_ID = "com.istv.reeltool";

const platformInfo = require(join(EXT_ROOT, "src", "core", "platform.js"));
const { vendorStatus } = await import("./vendor-ffmpeg.mjs");

const DEST_ROOT = platformInfo.userCepExtensionDir();
const DEST = join(DEST_ROOT, EXT_ID);

/** Turn on unsigned-extension loading for CSXS 9-12 on the current OS. */
function enableCepDebugMode() {
  const versions = platformInfo.CSXS_VERSIONS;
  if (platformInfo.isMac()) {
    for (const v of versions) {
      spawnSync("defaults", ["write", `com.adobe.CSXS.${v}`, "PlayerDebugMode", "-string", "1"], { stdio: "ignore" });
    }
    spawnSync("killall", ["cfprefsd"], { stdio: "ignore" }); // flush the prefs cache
    return `defaults com.adobe.CSXS.{${versions.join(",")}}`;
  }
  for (const v of versions) {
    const ps = `New-Item -Path 'HKCU:\\Software\\Adobe\\CSXS.${v}' -Force | Out-Null; ` +
      `New-ItemProperty -Path 'HKCU:\\Software\\Adobe\\CSXS.${v}' -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null`;
    spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { stdio: "ignore" });
  }
  return `HKCU\\Software\\Adobe\\CSXS.{${versions.join(",")}}`;
}

/** Copy the live folder, minus build/dev cruft (used when a symlink isn't allowed). */
function copyLive() {
  const skip = new Set(["node_modules", "dist", "test", ".git", "package-lock.json"]);
  cpSync(EXT_ROOT, DEST, {
    recursive: true,
    filter: (from) => {
      const rel = relative(EXT_ROOT, from);
      if (!rel) return true;
      return !rel.split(sep).some((p) => skip.has(p));
    },
  });
}

function describeInstall() {
  if (!existsSync(DEST)) return { installed: false, kind: "none", path: DEST };
  const st = lstatSync(DEST);
  return { installed: true, kind: st.isSymbolicLink() ? "symlink" : "copy", path: DEST };
}

function uninstall() {
  const before = describeInstall();
  rmSync(DEST, { recursive: true, force: true });
  console.log(before.installed ? `Removed ${before.kind}: ${DEST}` : `Nothing installed at ${DEST}`);
}

function status() {
  const info = describeInstall();
  console.log(`platform:   ${platformInfo.platformKey()}`);
  console.log(`CEP dir:    ${DEST_ROOT}`);
  console.log(`installed:  ${info.installed ? info.kind : "no"}`);
  const manifest = join(EXT_ROOT, "CSXS", "manifest.xml");
  const main = /<MainPath>\s*(.+?)\s*<\/MainPath>/.exec(readFileSync(manifest, "utf8"));
  console.log(`MainPath:   ${main ? main[1] : "?"} ${main && existsSync(join(EXT_ROOT, main[1])) ? "(exists)" : "(MISSING)"}`);
  console.log(`presets:    ${platformInfo.adobeAppRoots().length} Premiere install(s) detected`);
  for (const s of vendorStatus()) {
    console.log(`vendor:     ${s.target.padEnd(14)} ${s.complete ? "complete" : "missing — run tools/vendor-ffmpeg.mjs"}`);
  }
}

function install({ copy }) {
  const flagLocation = enableCepDebugMode();
  console.log(`CEP debug mode set (${flagLocation}).`);

  // The panel needs a runnable FFmpeg for this machine — vendored or on PATH.
  const mine = vendorStatus([platformInfo.platformKey()])[0];
  if (!mine || !mine.complete) {
    console.log(`No vendored FFmpeg for ${platformInfo.platformKey()} — run:`);
    console.log(`  node tools/vendor-ffmpeg.mjs --targets ${platformInfo.platformKey()}`);
    console.log(`(the panel will fall back to node_modules or PATH meanwhile)`);
  }

  mkdirSync(DEST_ROOT, { recursive: true });
  rmSync(DEST, { recursive: true, force: true });

  if (copy) {
    copyLive();
    console.log(`Copied live folder -> ${DEST}   (re-run after each edit)`);
  } else {
    try {
      // "junction" avoids the Windows Admin/Developer-Mode requirement for dirs.
      symlinkSync(EXT_ROOT, DEST, platformInfo.isWindows() ? "junction" : "dir");
      console.log(`Symlinked live folder -> ${DEST}`);
    } catch (e) {
      console.log(`Symlink not permitted (${e.code || e.message}); copying instead.`);
      copyLive();
      console.log(`Copied live folder -> ${DEST}   (re-run after each edit)`);
    }
  }
  console.log(`\nRestart Premiere, then Window > Extensions > ISTV Reel Tool.`);
}

const argv = process.argv.slice(2);
if (argv.includes("--status")) status();
else if (argv.includes("--uninstall")) uninstall();
else install({ copy: argv.includes("--copy") });
