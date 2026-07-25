#!/usr/bin/env node
/**
 * Build the shareable ISTV Reel Tool package. Runs on Windows or macOS — the whole
 * point of replacing the old PowerShell packaging step, which could only run on
 * Windows and could only produce a Windows-only bundle.
 *
 *   node tools/build.mjs --backend-url https://reels.example.com
 *   node tools/build.mjs --backend-url https://… --targets win32-x64
 *   node tools/build.mjs --universal --backend-url https://…
 *   node tools/build.mjs --allow-localhost            # dev/test bundle
 *
 * By default it emits ONE ZIP PER PLATFORM, so an editor downloads ~70 MB instead
 * of ~200 MB:
 *
 *   dist/ISTV-Reel-Tool-win-x64.zip      → install.bat
 *   dist/ISTV-Reel-Tool-mac-arm64.zip    → install.command   (Apple Silicon)
 *   dist/ISTV-Reel-Tool-mac-x64.zip      → install.command   (Intel)
 *
 * `--universal` instead emits a single dist/ISTV-Reel-Tool-universal.zip carrying
 * every platform's binaries — one link to hand out, at ~3x the size.
 *
 * Zip note: archives are written by tools/zip.mjs, which stores POSIX permissions,
 * so the vendored binaries and install.command arrive executable even when the Mac
 * bundle was built on Windows. install.command re-chmods anyway, belt and braces.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { vendorStatus, TARGETS } from "./vendor-ffmpeg.mjs";
import { zipDirectory } from "./zip.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");
const DIST = join(EXT_ROOT, "dist");
const EXT_ID = "com.istv.reeltool";

/** Human-facing bundle names — editors shouldn't have to parse "darwin-arm64". */
const BUNDLE_LABEL = {
  "win32-x64": "win-x64",
  "darwin-arm64": "mac-arm64",
  "darwin-x64": "mac-x64",
};

/**
 * What goes into a bundle. Everything the panel loads at runtime, and nothing else
 * — no node_modules (the vendored binaries replace it), no tests, no build tools,
 * no .debug (which would open a remote debug port on an editor's machine).
 */
const INCLUDE = ["CSXS", "src", "presets", "config.json", "package.json", "README.md"];
const EXCLUDE_NAMES = new Set([
  "node_modules", "dist", "vendor", "tools", "test", ".git", ".gitignore", ".debug", "package-lock.json",
]);

function parseArgs(argv) {
  const args = { targets: null, backendUrl: "", allowLocalhost: false, universal: false, authToken: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--backend-url") args.backendUrl = String(argv[++i] || "").trim();
    else if (a === "--auth-token") args.authToken = String(argv[++i] || "").trim();
    else if (a === "--allow-localhost") args.allowLocalhost = true;
    else if (a === "--universal") args.universal = true;
    else if (a === "--targets") {
      args.targets = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
  }
  if (!args.targets) args.targets = TARGETS.slice();
  const unknown = args.targets.filter((t) => !TARGETS.includes(t));
  if (unknown.length) throw new Error(`Unknown target(s): ${unknown.join(", ")}. Supported: ${TARGETS.join(", ")}`);
  return args;
}

/** Reuse the panel's own loopback test so the guard and the runtime agree. */
const { isLoopbackUrl } = await import(`file://${join(EXT_ROOT, "src", "core", "config.js").replace(/\\/g, "/")}`)
  .then((m) => m.default || m)
  .catch(async () => {
    const req = (await import("node:module")).createRequire(import.meta.url);
    return req(join(EXT_ROOT, "src", "core", "config.js"));
  });

/**
 * The release-safety check. A bundle whose backendUrl is loopback works only on the
 * machine that built it: every editor who installs it sees "Backend not reachable"
 * and has no way to fix it short of editing JSON inside the installed extension.
 * Shipping that is always a mistake, so it takes an explicit flag.
 */
function resolveBackendUrl({ backendUrl, allowLocalhost }, currentConfig) {
  const url = (backendUrl || currentConfig.backendUrl || "").replace(/\/+$/, "");
  if (!url) throw new Error("No backendUrl: pass --backend-url <url> or set it in config.json.");
  if (isLoopbackUrl(url) && !allowLocalhost) {
    throw new Error(
      `Refusing to build a distributable bundle pointing at ${url}.\n` +
        `  That address only resolves on this machine, so every editor would get "Backend not reachable".\n` +
        `  Pass --backend-url <hosted url>, or --allow-localhost if this bundle is only for your own testing.`
    );
  }
  return url;
}

/** Recursive copy honouring EXCLUDE_NAMES at every level. */
function copyTree(src, dest) {
  cpSync(src, dest, {
    recursive: true,
    filter: (from) => {
      const rel = relative(src, from);
      if (!rel) return true;
      return !rel.split(sep).some((part) => EXCLUDE_NAMES.has(part));
    },
  });
}

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

/** Stage one bundle: extension payload + vendored binaries + installers + guide. */
function stageBundle({ label, targets, backendUrl, authToken, currentConfig }) {
  const stage = join(DIST, `ISTV-Reel-Tool-${label}`);
  const extDir = join(stage, EXT_ID);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(extDir, { recursive: true });

  // 1) Extension payload.
  for (const name of INCLUDE) {
    const src = join(EXT_ROOT, name);
    if (!existsSync(src)) continue;
    const dest = join(extDir, name);
    if (statSync(src).isDirectory()) copyTree(src, dest);
    else cpSync(src, dest);
  }

  // 2) config.json with the release backend baked in.
  const cfg = { ...currentConfig, backendUrl };
  if (authToken !== null) cfg.authToken = authToken;
  writeFileSync(join(extDir, "config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");

  // 3) Vendored binaries for this bundle's target(s) only.
  for (const target of targets) {
    const from = join(EXT_ROOT, "vendor", "ffmpeg", target);
    if (!existsSync(from)) throw new Error(`Missing vendor/ffmpeg/${target}. Run: node tools/vendor-ffmpeg.mjs --targets ${target}`);
    cpSync(from, join(extDir, "vendor", "ffmpeg", target), { recursive: true });
  }

  // 4) Installers the editor double-clicks, at the top level of the zip. Ship both
  //    OSes' scripts in a universal bundle; only the relevant one otherwise.
  const wantsWin = targets.some((t) => t.startsWith("win32"));
  const wantsMac = targets.some((t) => t.startsWith("darwin"));
  const installerFiles = [
    ...(wantsWin ? ["install.bat", "install.ps1", "uninstall.bat", "uninstall.ps1"] : []),
    ...(wantsMac ? ["install.command", "uninstall.command"] : []),
    "README-EDITORS.txt",
  ];
  for (const f of installerFiles) {
    const src = join(EXT_ROOT, "installer", f);
    if (!existsSync(src)) throw new Error(`Installer file missing: installer/${f}`);
    const dest = join(stage, f);
    if (/\.command$/.test(f)) {
      // Force LF. A .command with CRLF endings dies on macOS with
      // "bad interpreter: /bin/bash^M" — and a Windows checkout with
      // core.autocrlf=true produces exactly that. .gitattributes pins these to LF
      // too; this is the belt to that braces, since the failure is invisible until
      // an editor double-clicks the file.
      writeFileSync(dest, readFileSync(src, "utf8").replace(/\r\n/g, "\n"), "utf8");
    } else {
      cpSync(src, dest);
    }
  }
  // Best-effort exec bit; install.command re-chmods itself anyway (see header).
  if (wantsMac && process.platform !== "win32") {
    for (const f of ["install.command", "uninstall.command"]) {
      try {
        spawnSync("chmod", ["+x", join(stage, f)]);
      } catch {
        /* the zip step and the editor's Terminal both cope without it */
      }
    }
  }

  // 5) A build stamp, so a support question can be answered from the bundle alone.
  writeFileSync(
    join(stage, "BUILD-INFO.txt"),
    [
      `ISTV Reel Tool`,
      `bundle:      ${label}`,
      `targets:     ${targets.join(", ")}`,
      `backendUrl:  ${backendUrl}`,
      `built on:    ${process.platform}-${process.arch}, node ${process.version}`,
      ``,
      `Install: Windows -> double-click install.bat | macOS -> double-click install.command`,
      `Then in Premiere: Window > Extensions > ISTV Reel Tool`,
    ].join("\n") + "\n",
    "utf8"
  );

  return { stage, extDir };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = join(EXT_ROOT, "config.json");
  const currentConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const backendUrl = resolveBackendUrl(args, currentConfig);

  // Vendored binaries must exist for every requested target before we stage.
  const status = vendorStatus(args.targets);
  const missing = status.filter((s) => !s.complete);
  if (missing.length) {
    throw new Error(
      `Missing vendored FFmpeg for: ${missing.map((m) => m.target).join(", ")}\n` +
        `  Run: node tools/vendor-ffmpeg.mjs --targets ${missing.map((m) => m.target).join(",")}`
    );
  }

  mkdirSync(DIST, { recursive: true });
  console.log(`Building ISTV Reel Tool`);
  console.log(`  backend: ${backendUrl}${isLoopbackUrl(backendUrl) ? "   (LOCAL — testing bundle, do not distribute)" : ""}`);
  console.log(`  targets: ${args.targets.join(", ")}${args.universal ? " (universal bundle)" : ""}`);
  console.log("");

  const bundles = args.universal
    ? [{ label: "universal", targets: args.targets }]
    : args.targets.map((t) => ({ label: BUNDLE_LABEL[t], targets: [t] }));

  const built = [];
  for (const b of bundles) {
    const { stage } = stageBundle({ ...b, backendUrl, authToken: args.authToken, currentConfig });
    const zip = join(DIST, `ISTV-Reel-Tool-${b.label}.zip`);
    rmSync(zip, { force: true });
    const { entries } = await zipDirectory(stage, zip);
    const zipMb = (statSync(zip).size / 1e6).toFixed(1);
    const stageMb = (dirSize(stage) / 1e6).toFixed(1);
    built.push({ label: b.label, zip, zipMb, stageMb });
    console.log(`  ✓ ${b.label.padEnd(10)} ${zipMb} MB zipped, ${entries} files (${stageMb} MB installed)`);
  }

  console.log(`\nBundles in ${DIST}:`);
  for (const b of built) console.log(`  ${b.zip}`);
  console.log(`\nSend each editor the zip for their machine. They unzip and double-click`);
  console.log(`install.bat (Windows) or install.command (macOS). Nothing else to install.`);
}

export { parseArgs, resolveBackendUrl, BUNDLE_LABEL, INCLUDE, EXCLUDE_NAMES };

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error("\nBuild failed: " + e.message);
    process.exit(1);
  });
}
