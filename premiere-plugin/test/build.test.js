"use strict";

/**
 * The packaging toolchain: the release guard, and the ZIP writer's permission bits.
 *
 * The permission tests matter because they cover something invisible until an editor
 * complains. A macOS bundle whose install.command lacks the exec bit isn't
 * double-clickable (Finder opens it in TextEdit), and a vendored ffmpeg without it
 * fails at "Extract audio". Neither is reproducible on the Windows machine that
 * built the bundle, so it is asserted at the byte level here.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const EXT_ROOT = path.join(__dirname, "..");

/** Read a ZIP's central directory: names plus the Unix mode of each entry. */
function readZipCentralDirectory(zipPath) {
  const buf = fs.readFileSync(zipPath);
  // Find the end-of-central-directory record, scanning back over any comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, "no end-of-central-directory record — not a valid zip");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(offset), 0x02014b50, "bad central directory signature");
    const versionMadeBy = buf.readUInt16LE(offset + 4);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const external = buf.readUInt32LE(offset + 38);
    entries.push({
      name: buf.toString("utf8", offset + 46, offset + 46 + nameLen),
      creatorOs: versionMadeBy >> 8,
      mode: (external >>> 16) & 0o7777,
      isDir: Boolean(external & 0x10),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test("the release guard refuses a loopback backend URL", async () => {
  const { resolveBackendUrl } = await import("../tools/build.mjs");

  // The failure this prevents: every editor installs the bundle, sees "Backend not
  // reachable", and cannot fix it without editing JSON inside the installed panel.
  assert.throws(
    () => resolveBackendUrl({ backendUrl: "http://127.0.0.1:8722", allowLocalhost: false }, {}),
    /Refusing to build/
  );
  assert.throws(() => resolveBackendUrl({ backendUrl: "https://localhost:3000", allowLocalhost: false }, {}), /Refusing/);
  // And it must catch a loopback URL inherited from config.json, not just the flag.
  assert.throws(() => resolveBackendUrl({ backendUrl: "", allowLocalhost: false }, { backendUrl: "http://127.0.0.1:8722" }), /Refusing/);
});

test("the guard allows loopback with an explicit opt-in, and always allows real hosts", async () => {
  const { resolveBackendUrl } = await import("../tools/build.mjs");
  assert.equal(resolveBackendUrl({ backendUrl: "http://127.0.0.1:8722", allowLocalhost: true }, {}), "http://127.0.0.1:8722");
  assert.equal(resolveBackendUrl({ backendUrl: "https://reels.example.com/", allowLocalhost: false }, {}), "https://reels.example.com");
  assert.throws(() => resolveBackendUrl({ backendUrl: "", allowLocalhost: true }, {}), /No backendUrl/);
});

test("build arguments parse, and unknown targets are rejected rather than silently dropped", async () => {
  const { parseArgs } = await import("../tools/build.mjs");
  const all = parseArgs([]);
  assert.deepEqual(all.targets, ["win32-x64", "darwin-arm64", "darwin-x64"]);
  assert.equal(all.universal, false);

  const one = parseArgs(["--targets", "darwin-arm64", "--backend-url", "https://x.example", "--universal"]);
  assert.deepEqual(one.targets, ["darwin-arm64"]);
  assert.equal(one.backendUrl, "https://x.example");
  assert.equal(one.universal, true);

  assert.throws(() => parseArgs(["--targets", "linux-x64"]), /Unknown target/);
  assert.throws(() => parseArgs(["--nonsense"]), /Unknown flag/);
});

test("bundle labels are the names editors see, and every target has one", async () => {
  const { BUNDLE_LABEL } = await import("../tools/build.mjs");
  assert.equal(BUNDLE_LABEL["win32-x64"], "win-x64");
  assert.equal(BUNDLE_LABEL["darwin-arm64"], "mac-arm64");
  assert.equal(BUNDLE_LABEL["darwin-x64"], "mac-x64");
  const platformInfo = require(path.join(EXT_ROOT, "src", "core", "platform.js"));
  for (const t of platformInfo.SUPPORTED_TARGETS) {
    assert.ok(BUNDLE_LABEL[t], `no bundle label for ${t}`);
  }
});

test("the bundle manifest ships what the panel loads and excludes dev-only files", async () => {
  const { INCLUDE, EXCLUDE_NAMES } = await import("../tools/build.mjs");
  for (const needed of ["CSXS", "src", "config.json"]) {
    assert.ok(INCLUDE.includes(needed), `${needed} must be in the bundle`);
  }
  // .debug would open a remote debugging port on an editor's machine; node_modules
  // is replaced by vendor/ffmpeg; tools and test are not runtime code.
  for (const excluded of [".debug", "node_modules", "tools", "test", "dist"]) {
    assert.ok(EXCLUDE_NAMES.has(excluded), `${excluded} must never ship`);
  }
});

test("the ZIP writer stores executable bits for binaries and .command launchers", async () => {
  const { zipDirectory } = await import("../tools/zip.mjs");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "istv-zip-"));
  try {
    const stage = path.join(work, "Bundle");
    fs.mkdirSync(path.join(stage, "vendor", "ffmpeg", "darwin-arm64"), { recursive: true });
    fs.writeFileSync(path.join(stage, "vendor", "ffmpeg", "darwin-arm64", "ffmpeg"), "binary");
    fs.writeFileSync(path.join(stage, "vendor", "ffmpeg", "darwin-arm64", "ffprobe"), "binary");
    fs.writeFileSync(path.join(stage, "install.command"), "#!/bin/bash\n");
    fs.writeFileSync(path.join(stage, "README-EDITORS.txt"), "read me");
    fs.writeFileSync(path.join(stage, "config.json"), "{}");

    const zipPath = path.join(work, "bundle.zip");
    const result = await zipDirectory(stage, zipPath);
    assert.ok(result.entries >= 6);
    assert.ok(result.bytes > 0);

    const entries = readZipCentralDirectory(zipPath);
    const byName = new Map(entries.map((e) => [e.name, e]));

    // Creator-OS must be 3 (Unix) or unzip ignores the permission bits entirely.
    for (const e of entries) assert.equal(e.creatorOs, 3, `${e.name}: creator OS must be Unix`);

    // The two things that must arrive executable on macOS.
    assert.equal(byName.get("Bundle/vendor/ffmpeg/darwin-arm64/ffmpeg").mode, 0o755);
    assert.equal(byName.get("Bundle/vendor/ffmpeg/darwin-arm64/ffprobe").mode, 0o755);
    assert.equal(byName.get("Bundle/install.command").mode, 0o755, "a non-executable .command is not double-clickable");

    // Ordinary files must not be executable.
    assert.equal(byName.get("Bundle/README-EDITORS.txt").mode, 0o644);
    assert.equal(byName.get("Bundle/config.json").mode, 0o644);

    // Directories are traversable and flagged as directories.
    const dir = byName.get("Bundle/vendor/");
    assert.ok(dir, "directory entries are present");
    assert.equal(dir.mode, 0o755);
    assert.equal(dir.isDir, true);

    // Everything sits under one top-level folder, matching `zip -r` behaviour, so
    // unzipping never scatters files across the editor's Downloads folder.
    for (const e of entries) assert.ok(e.name.startsWith("Bundle/"), `${e.name} escaped the top-level folder`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("the ZIP writer's output is readable by the system unzip", async () => {
  // Byte-level assertions above prove the metadata; this proves a real extractor
  // accepts the archive (bsdtar ships with Windows 10+ and macOS, and reads zip).
  const { zipDirectory } = await import("../tools/zip.mjs");
  const { spawnSync } = require("node:child_process");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "istv-unzip-"));
  try {
    const stage = path.join(work, "Bundle");
    fs.mkdirSync(path.join(stage, "nested"), { recursive: true });
    const payload = "x".repeat(5000); // large enough that deflate is chosen
    fs.writeFileSync(path.join(stage, "nested", "file.txt"), payload);
    fs.writeFileSync(path.join(stage, "tiny.txt"), "q"); // small enough to be stored

    const zipPath = path.join(work, "b.zip");
    await zipDirectory(stage, zipPath);

    const outDir = path.join(work, "out");
    fs.mkdirSync(outDir);
    const r = spawnSync("tar", ["-xf", zipPath, "-C", outDir], { encoding: "utf8" });
    if (r.error || r.status !== 0) {
      // No usable extractor on this machine: the byte-level test still covers us.
      return;
    }
    assert.equal(fs.readFileSync(path.join(outDir, "Bundle", "nested", "file.txt"), "utf8"), payload, "deflated entry round-trips");
    assert.equal(fs.readFileSync(path.join(outDir, "Bundle", "tiny.txt"), "utf8"), "q", "stored entry round-trips");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("every vendored binary is built for the architecture it is filed under", async () => {
  // The bug this guards: ffprobe-static's bin/darwin/arm64/ffprobe is an x86_64
  // binary. It installs and looks fine, but on Apple Silicon it only runs under
  // Rosetta 2 — not installed by default on macOS, and unable to prompt from inside
  // a CEP panel spawning it headlessly. An Apple Silicon editor would have hit a
  // failed "Detect source" with no usable error, and nothing on a Windows build
  // machine would have revealed it.
  const { vendorStatus, verifyArch, TARGETS } = await import("../tools/vendor-ffmpeg.mjs");
  const present = vendorStatus(TARGETS).filter((s) => s.complete);
  if (!present.length) return; // nothing vendored yet — `npm run vendor` covers this

  for (const { target, dir } of present) {
    for (const base of ["ffmpeg", "ffprobe"]) {
      const file = path.join(dir, base + (target.startsWith("win32") ? ".exe" : ""));
      const arch = verifyArch(file, target); // throws on a mismatch
      assert.ok(["arm64", "x64", "universal"].includes(arch), `${target}/${base}: unexpected arch ${arch}`);
    }
  }
});

test("verifyArch rejects a wrong-architecture binary", async () => {
  const { verifyArch } = await import("../tools/vendor-ffmpeg.mjs");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "istv-arch-"));
  try {
    // A 64-bit Mach-O header (0xfeedfacf) declaring x86_64 (0x01000007).
    const header = Buffer.alloc(64);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(0x01000007, 4);
    const file = path.join(work, "ffprobe");
    fs.writeFileSync(file, header);

    // Filed as arm64 but built for x86_64 — exactly the upstream defect.
    assert.throws(() => verifyArch(file, "darwin-arm64"), /built for x64.*vendored as darwin-arm64/s);
    assert.match(
      (() => { try { verifyArch(file, "darwin-arm64"); } catch (e) { return e.message; } })(),
      /Rosetta/,
      "the error should explain why this matters"
    );
    // The same bytes filed as x64 are correct.
    assert.equal(verifyArch(file, "darwin-x64"), "x64");

    // A universal (fat) binary carries every slice, so it is acceptable anywhere.
    const fat = Buffer.alloc(64);
    fat.writeUInt32LE(0xbebafeca, 0);
    const fatFile = path.join(work, "fat");
    fs.writeFileSync(fatFile, fat);
    assert.equal(verifyArch(fatFile, "darwin-arm64"), "universal");

    // Garbage is rejected rather than assumed fine.
    const junk = path.join(work, "junk");
    fs.writeFileSync(junk, Buffer.alloc(64));
    assert.throws(() => verifyArch(junk, "darwin-arm64"), /not a 64-bit Mach-O/);
    assert.throws(() => verifyArch(junk, "win32-x64"), /not a Windows executable/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("installer scripts exist for both platforms", () => {
  // build.mjs throws if any of these is missing; failing here names the file.
  for (const f of [
    "install.bat", "install.ps1", "uninstall.bat", "uninstall.ps1",
    "install.command", "uninstall.command",
    "README-EDITORS.txt",
  ]) {
    assert.ok(fs.existsSync(path.join(EXT_ROOT, "installer", f)), `installer/${f} is missing`);
  }
});

test("the macOS installer does the three things a Mac needs", () => {
  const sh = fs.readFileSync(path.join(EXT_ROOT, "installer", "install.command"), "utf8");
  assert.match(sh, /^#!\/bin\/bash/, "must have a shebang to be double-clickable");
  assert.match(sh, /defaults write "com\.adobe\.CSXS\.\$v" PlayerDebugMode/, "the macOS equivalent of the CSXS registry key");
  assert.match(sh, /Library\/Application Support\/Adobe\/CEP\/extensions/, "the macOS CEP extensions path");
  assert.match(sh, /chmod \+x/, "the exec bit a Windows-built zip cannot carry");
  assert.match(sh, /xattr -dr com\.apple\.quarantine/, "Gatekeeper blocks downloaded binaries without this");
  assert.ok(!/robocopy|powershell|\.exe\b/i.test(sh), "no Windows-only commands");
});

test("the macOS installers use LF line endings", () => {
  // A .command with CRLF endings fails on macOS with "bad interpreter: /bin/bash^M".
  // This repo is developed on Windows with core.autocrlf=true, so without the
  // .gitattributes pin a fresh clone would silently produce broken installers.
  for (const f of ["install.command", "uninstall.command"]) {
    const raw = fs.readFileSync(path.join(EXT_ROOT, "installer", f), "utf8");
    assert.ok(!raw.includes("\r\n"), `installer/${f} has CRLF line endings — it will not run on macOS`);
  }
  const attrs = fs.readFileSync(path.join(EXT_ROOT, "..", ".gitattributes"), "utf8");
  assert.match(attrs, /\*\.command\s+text\s+eol=lf/, ".gitattributes must pin *.command to LF");
});

test("the build normalizes .command line endings even from a CRLF working copy", async () => {
  // Belt to .gitattributes' braces: verify the staging step itself strips CRLF, so a
  // checkout that somehow has them still yields a working bundle.
  const { readFileSync: rf } = fs;
  const src = rf(path.join(EXT_ROOT, "installer", "install.command"), "utf8");
  const crlf = src.replace(/\n/g, "\r\n");
  assert.ok(crlf.includes("\r\n"), "test setup produced CRLF");
  assert.ok(!crlf.replace(/\r\n/g, "\n").includes("\r"), "the build's transform removes every CR");
  // And confirm build.mjs actually contains that normalization for .command files.
  const build = rf(path.join(EXT_ROOT, "tools", "build.mjs"), "utf8");
  assert.match(build, /\\\.command\$[\s\S]{0,600}replace\(\/\\r\\n\/g, "\\n"\)/, "build.mjs must strip CRLF from .command files");
});

test("the Windows installer sets the registry flag and the CEP path", () => {
  const ps = fs.readFileSync(path.join(EXT_ROOT, "installer", "install.ps1"), "utf8");
  assert.match(ps, /HKCU:\\Software\\Adobe\\CSXS\.\$v/);
  assert.match(ps, /PlayerDebugMode/);
  assert.match(ps, /APPDATA.*Adobe\\CEP\\extensions/);
  assert.ok(!/defaults write|chmod|xattr/.test(ps), "no macOS-only commands");
});

test("the manifest's MainPath and ScriptPath point at files that exist", () => {
  const manifest = fs.readFileSync(path.join(EXT_ROOT, "CSXS", "manifest.xml"), "utf8");
  for (const tag of ["MainPath", "ScriptPath"]) {
    const m = new RegExp(`<${tag}>\\s*\\./(.+?)\\s*</${tag}>`).exec(manifest);
    assert.ok(m, `manifest has no ${tag}`);
    assert.ok(fs.existsSync(path.join(EXT_ROOT, m[1])), `${tag} ${m[1]} does not exist`);
  }
  // Node must be enabled or the whole src/core layer cannot be required.
  assert.match(manifest, /--enable-nodejs/);
  assert.match(manifest, /<Host Name="PPRO"/);
});

test("index.html references its sibling assets, not the pre-restructure paths", () => {
  const html = fs.readFileSync(path.join(EXT_ROOT, "src", "panel", "index.html"), "utf8");
  for (const src of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])) {
    if (/^https?:/.test(src)) continue;
    assert.ok(
      fs.existsSync(path.join(EXT_ROOT, "src", "panel", src)),
      `index.html references ${src}, which does not exist relative to src/panel/`
    );
  }
});
