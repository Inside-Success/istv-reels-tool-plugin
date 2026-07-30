#!/usr/bin/env node
/**
 * Vendor FFmpeg + ffprobe for every shipping target, from any machine.
 *
 *   node tools/vendor-ffmpeg.mjs                       # all supported targets
 *   node tools/vendor-ffmpeg.mjs --targets darwin-arm64
 *   node tools/vendor-ffmpeg.mjs --force               # re-download
 *
 * Result: vendor/ffmpeg/<platform>-<arch>/{ffmpeg,ffprobe}[.exe]
 *
 * WHY THIS EXISTS. `npm install ffmpeg-static` downloads exactly one binary — for
 * the machine doing the install. The old Windows-only packaging step therefore
 * produced a zip whose "bundled FFmpeg" was a Windows .exe, and a macOS editor
 * installing it got an unrunnable path (see js/ffmpeg.js for why the PATH
 * fallback didn't save them). Fetching per-target binaries here means one build
 * machine — Windows or Mac — can produce bundles for every editor.
 *
 * Both binaries come from ffmpeg-static's GitHub release assets (gzipped single
 * files), which are published per platform-arch and so can be fetched from any
 * machine. verifyArch() below then proves each downloaded file is actually built for
 * the directory it landed in.
 *
 * That verification is not paranoia. The obvious source for ffprobe is the
 * `ffprobe-static` npm package, whose tarball conveniently contains every platform
 * — but its bin/darwin/arm64/ffprobe is an x86_64 binary. On Apple Silicon that only
 * runs under Rosetta 2, which is not installed by default on macOS and cannot
 * reliably prompt for installation from inside a CEP panel spawning it headlessly.
 * Apple Silicon editors would have hit a failed "Detect source" with no useful
 * error. The release assets carry a real arm64 build, so we use those for both.
 *
 * Licensing: these are GPL-3.0-or-later FFmpeg builds. The upstream LICENSE is
 * copied next to each binary; keep it in the shipped bundle.
 */

import {
  createWriteStream, existsSync, mkdirSync, statSync, chmodSync, copyFileSync, rmSync,
  openSync, readSync, closeSync,
} from "node:fs";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");
const VENDOR_ROOT = join(EXT_ROOT, "vendor", "ffmpeg");

/** Targets we ship. Premiere is 64-bit only on both platforms. */
const TARGETS = ["win32-x64", "darwin-arm64", "darwin-x64"];

/** Release tag of the ffmpeg-static build set. Bump to update FFmpeg. */
const FFMPEG_RELEASE = "b6.1.1";
const FFMPEG_BASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE}`;

function parseArgs(argv) {
  const args = { targets: TARGETS, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--force") args.force = true;
    else if (argv[i] === "--targets") {
      args.targets = String(argv[++i] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  const unknown = args.targets.filter((t) => !TARGETS.includes(t));
  if (unknown.length) throw new Error(`Unknown target(s): ${unknown.join(", ")}. Supported: ${TARGETS.join(", ")}`);
  return args;
}

const exeName = (base, target) => base + (target.startsWith("win32") ? ".exe" : "");

function targetDir(target) {
  return join(VENDOR_ROOT, target);
}

/** Present and non-trivially-sized. A truncated download must not count as done. */
function looksInstalled(file) {
  try {
    return statSync(file).size > 1_000_000;
  } catch {
    return false;
  }
}

async function download(url, destPath, { gunzip = false } = {}) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  mkdirSync(dirname(destPath), { recursive: true });
  const tmp = destPath + ".part";
  const body = Readable.fromWeb(res.body);
  await pipeline(...(gunzip ? [body, createGunzip(), createWriteStream(tmp)] : [body, createWriteStream(tmp)]));
  // Atomic-ish swap so an interrupted run never leaves a half file in place.
  rmSync(destPath, { force: true });
  copyFileSync(tmp, destPath);
  rmSync(tmp, { force: true });
}

/** Mach-O / PE architecture constants, keyed by the target we expect. */
const MACHO_CPU = { arm64: 0x0100000c, x64: 0x01000007 };
const PE_MACHINE = { x64: 0x8664 };

/**
 * Prove a downloaded binary is built for the architecture of the directory it is in.
 * A wrong-arch binary installs silently and only fails on the editor's machine —
 * either outright, or by quietly depending on Rosetta. Throwing here instead means a
 * bad upstream asset can never reach a bundle.
 */
function verifyArch(file, target) {
  const [platform, arch] = target.split("-");
  const fd = openSync(file, "r");
  const head = Buffer.alloc(64);
  try {
    readSync(fd, head, 0, 64, 0);
  } finally {
    closeSync(fd);
  }

  if (platform === "darwin") {
    const magic = head.readUInt32LE(0);
    if (magic === 0xbebafeca || magic === 0xcafebabe) return "universal"; // fat binary: contains all slices
    if (magic !== 0xfeedfacf) throw new Error(`${file}: not a 64-bit Mach-O binary (magic 0x${magic.toString(16)})`);
    const cpu = head.readUInt32LE(4);
    if (cpu !== MACHO_CPU[arch]) {
      const found = Object.keys(MACHO_CPU).find((k) => MACHO_CPU[k] === cpu) || `0x${cpu.toString(16)}`;
      throw new Error(
        `${file}: built for ${found}, but it is vendored as ${target}.\n` +
          `  Shipping this would need Rosetta on Apple Silicon (not installed by default,\n` +
          `  and it cannot prompt from inside the CEP panel). Refusing to vendor it.`
      );
    }
    return arch;
  }

  // PE/COFF: "MZ", then the PE header offset at 0x3C, then machine type at +4.
  if (head.readUInt16LE(0) !== 0x5a4d) throw new Error(`${file}: not a Windows executable`);
  const fd2 = openSync(file, "r");
  const peOff = Buffer.alloc(4);
  const machine = Buffer.alloc(2);
  try {
    readSync(fd2, peOff, 0, 4, 0x3c);
    readSync(fd2, machine, 0, 2, peOff.readUInt32LE(0) + 4);
  } finally {
    closeSync(fd2);
  }
  const m = machine.readUInt16LE(0);
  if (m !== PE_MACHINE[arch]) throw new Error(`${file}: PE machine 0x${m.toString(16)}, expected ${target}`);
  return arch;
}

/**
 * Download one binary from the release. Both ffmpeg and ffprobe are published as
 * `<name>-<platform>-<arch>.gz`, so a single code path covers them and every target.
 */
async function vendorBinary(name, target, force) {
  const dest = join(targetDir(target), exeName(name, target));
  if (!force && looksInstalled(dest)) {
    // Still verify: a cached file may predate this check, or have come from a
    // previous version of this script that used a different source.
    const arch = verifyArch(dest, target);
    return { target, binary: name, status: "cached", path: dest, arch };
  }

  await download(`${FFMPEG_BASE_URL}/${name}-${target}.gz`, dest, { gunzip: true });
  const arch = verifyArch(dest, target); // throws before the file can reach a bundle
  if (!target.startsWith("win32")) chmodSync(dest, 0o755);
  return { target, binary: name, status: "downloaded", path: dest, bytes: statSync(dest).size, arch };
}

/** The GPL text must travel with the binaries. */
async function vendorLicense(target) {
  const dest = join(targetDir(target), "ffmpeg.LICENSE");
  if (existsSync(dest)) return;
  try {
    await download(`${FFMPEG_BASE_URL}/${target}.LICENSE`, dest);
  } catch {
    copyLocalLicense(target);
  }
}

/** Fall back to the local ffmpeg-static LICENSE if the release asset 404s. */
function copyLocalLicense(target) {
  const dest = join(targetDir(target), "ffmpeg.LICENSE");
  if (existsSync(dest)) return;
  try {
    const src = join(dirname(require.resolve("ffmpeg-static/package.json")), "LICENSE");
    if (existsSync(src)) copyFileSync(src, dest);
  } catch {
    /* not fatal for a dev build; the release-asset path normally succeeds */
  }
}

/** What's on disk right now, per target — used by build.mjs to gate a release. */
export function vendorStatus(targets = TARGETS) {
  return targets.map((target) => {
    const ffmpeg = join(targetDir(target), exeName("ffmpeg", target));
    const ffprobe = join(targetDir(target), exeName("ffprobe", target));
    return {
      target,
      dir: targetDir(target),
      ffmpeg: looksInstalled(ffmpeg),
      ffprobe: looksInstalled(ffprobe),
      complete: looksInstalled(ffmpeg) && looksInstalled(ffprobe),
    };
  });
}

export { TARGETS, FFMPEG_RELEASE, targetDir, exeName, parseArgs, verifyArch, vendorBinary };

async function main() {
  const { targets, force } = parseArgs(process.argv.slice(2));
  console.log(`Vendoring FFmpeg ${FFMPEG_RELEASE} for: ${targets.join(", ")}`);
  for (const target of targets) {
    for (const name of ["ffmpeg", "ffprobe"]) {
      const r = await vendorBinary(name, target, force);
      const size = r.bytes ? ` (${(r.bytes / 1e6).toFixed(1)} MB)` : "";
      console.log(`  ${r.target.padEnd(14)} ${r.binary.padEnd(8)} ${r.status}${size}  [verified ${r.arch}]`);
    }
    await vendorLicense(target);
  }
  console.log("\nDone. vendor/ffmpeg/ now holds:");
  for (const s of vendorStatus(targets)) {
    console.log(`  ${s.target.padEnd(14)} ${s.complete ? "complete" : "INCOMPLETE"}`);
  }
}

// Only run when invoked directly, so build.mjs can import vendorStatus().
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error("\nVendoring failed:", e.message);
    process.exit(1);
  });
}
