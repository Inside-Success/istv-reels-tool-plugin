"use strict";

/**
 * Cross-platform path and command resolution.
 *
 * Every test here injects a fake platform/arch/filesystem, so the macOS behaviour is
 * verified from a Windows machine and vice versa. That matters: the macOS bugs this
 * module fixes were all in code that could not run on the developer's machine, and
 * so were never exercised until an editor hit them.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const platformInfo = require(path.join(__dirname, "..", "src", "core", "platform.js"));

/** A fake filesystem: a set of paths that "exist" and a dir -> entries map. */
function fakeFs(existing, dirs = {}) {
  const set = new Set(existing);
  return {
    exists: (p) => set.has(p),
    readdir: (p) => dirs[p] || [],
  };
}

const MAC = { platform: "darwin", arch: "arm64", homedir: "/Users/editor", env: {} };
const MAC_INTEL = { platform: "darwin", arch: "x64", homedir: "/Users/editor", env: {} };
const WIN = {
  platform: "win32",
  arch: "x64",
  homedir: "C:\\Users\\editor",
  env: {
    APPDATA: "C:\\Users\\editor\\AppData\\Roaming",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    CommonProgramFiles: "C:\\Program Files\\Common Files",
  },
};

test("platformKey names each shipping target", () => {
  assert.equal(platformInfo.platformKey(WIN), "win32-x64");
  assert.equal(platformInfo.platformKey(MAC), "darwin-arm64");
  assert.equal(platformInfo.platformKey(MAC_INTEL), "darwin-x64");
  // Every key we produce must be one we actually vendor binaries for.
  for (const deps of [WIN, MAC, MAC_INTEL]) {
    assert.ok(platformInfo.SUPPORTED_TARGETS.includes(platformInfo.platformKey(deps)));
  }
});

test("the running platform is one we support", () => {
  assert.ok(
    platformInfo.SUPPORTED_TARGETS.includes(platformInfo.platformKey()),
    `${platformInfo.platformKey()} is not in SUPPORTED_TARGETS`
  );
});

test("exeName appends .exe only on Windows", () => {
  assert.equal(platformInfo.exeName("ffmpeg", WIN), "ffmpeg.exe");
  assert.equal(platformInfo.exeName("ffmpeg", MAC), "ffmpeg");
  assert.equal(platformInfo.exeName("ffprobe", MAC_INTEL), "ffprobe");
});

test("CEP extension directories are the real per-OS locations", () => {
  assert.equal(
    platformInfo.userCepExtensionDir(MAC),
    "/Users/editor/Library/Application Support/Adobe/CEP/extensions"
  );
  assert.equal(
    platformInfo.userCepExtensionDir(WIN),
    "C:\\Users\\editor\\AppData\\Roaming\\Adobe\\CEP\\extensions"
  );
  // The per-user dir must come first — it's the one that needs no admin rights.
  assert.equal(platformInfo.cepExtensionDirs(MAC)[1], "/Library/Application Support/Adobe/CEP/extensions");
  assert.ok(platformInfo.cepExtensionDirs(WIN)[1].includes("Common Files"));
});

test("cepExtensionDirs works when APPDATA is not set", () => {
  const dir = platformInfo.userCepExtensionDir({ ...WIN, env: {} });
  assert.ok(dir.includes("AppData"), dir);
  assert.ok(dir.endsWith(path.win32.join("Adobe", "CEP", "extensions")));
});

test("macOS Premiere discovery reaches INSIDE the .app bundle", () => {
  // The bug this replaces: /Applications/Adobe Premiere Pro 2025 is a FOLDER that
  // contains the .app, and the resources live inside the bundle. The old code built
  // "<folder>/Contents", which cannot exist, so preset and MOGRT lookup returned ""
  // on every Mac and editors silently got 16:9 reels with hand-dragged SRTs.
  const real = "/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app/Contents";
  const fs = fakeFs(["/Applications", real], {
    "/Applications": ["Adobe Premiere Pro 2025", "Safari.app"],
    "/Applications/Adobe Premiere Pro 2025": ["Adobe Premiere Pro 2025.app"],
  });

  const roots = platformInfo.adobeAppRoots({ ...MAC, ...fs });
  assert.deepEqual(roots, [real]);
  assert.ok(!roots.includes("/Applications/Adobe Premiere Pro 2025/Contents"), "the old broken path is gone");
});

test("macOS discovery also handles a bare .app directly in /Applications", () => {
  const real = "/Applications/Adobe Premiere Pro 2024.app/Contents";
  const fs = fakeFs(["/Applications", real], {
    "/Applications": ["Adobe Premiere Pro 2024.app"],
  });
  assert.deepEqual(platformInfo.adobeAppRoots({ ...MAC, ...fs }), [real]);
});

test("macOS discovery finds a differently-named .app inside the version folder", () => {
  const real = "/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro.app/Contents";
  const fs = fakeFs(["/Applications", real], {
    "/Applications": ["Adobe Premiere Pro 2025"],
    "/Applications/Adobe Premiere Pro 2025": ["Adobe Premiere Pro.app", "Presets"],
  });
  assert.deepEqual(platformInfo.adobeAppRoots({ ...MAC, ...fs }), [real]);
});

test("macOS discovery finds multiple installed versions and skips non-Premiere apps", () => {
  const a = "/Applications/Adobe Premiere Pro 2024/Adobe Premiere Pro 2024.app/Contents";
  const b = "/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app/Contents";
  const fs = fakeFs(["/Applications", a, b], {
    "/Applications": ["Adobe Premiere Pro 2024", "Adobe Premiere Pro 2025", "Adobe After Effects 2025"],
    "/Applications/Adobe Premiere Pro 2024": ["Adobe Premiere Pro 2024.app"],
    "/Applications/Adobe Premiere Pro 2025": ["Adobe Premiere Pro 2025.app"],
  });
  const roots = platformInfo.adobeAppRoots({ ...MAC, ...fs });
  assert.equal(roots.length, 2);
  assert.ok(!roots.some((r) => /After Effects/.test(r)));
});

test("Windows Premiere discovery scans both Program Files trees", () => {
  const a = "C:\\Program Files\\Adobe\\Adobe Premiere Pro 2025";
  const b = "C:\\Program Files (x86)\\Adobe\\Adobe Premiere Pro 2019";
  const fs = fakeFs(["C:\\Program Files\\Adobe", "C:\\Program Files (x86)\\Adobe", a, b], {
    "C:\\Program Files\\Adobe": ["Adobe Premiere Pro 2025", "Adobe Photoshop 2025"],
    "C:\\Program Files (x86)\\Adobe": ["Adobe Premiere Pro 2019"],
  });
  const roots = platformInfo.adobeAppRoots({ ...WIN, ...fs });
  assert.deepEqual(roots, [a, b]);
});

test("Premiere discovery returns empty rather than throwing when nothing is installed", () => {
  assert.deepEqual(platformInfo.adobeAppRoots({ ...MAC, ...fakeFs([]) }), []);
  assert.deepEqual(platformInfo.adobeAppRoots({ ...WIN, ...fakeFs([]) }), []);
});

test("preset and MOGRT directories hang off the resolved app root on both OSes", () => {
  const macRoot = "/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app/Contents";
  const macFs = fakeFs(["/Applications", macRoot], {
    "/Applications": ["Adobe Premiere Pro 2025"],
    "/Applications/Adobe Premiere Pro 2025": ["Adobe Premiere Pro 2025.app"],
  });
  const macPresets = platformInfo.sequencePresetDirs({ ...MAC, ...macFs });
  // Forward slashes even when this test runs on Windows — the paths must be built
  // for the TARGET platform, not the host's.
  assert.equal(macPresets[0], macRoot + "/Settings/SequencePresets/Social");
  assert.ok(!macPresets[0].includes("\\"), "no Windows separators in a macOS path");

  const macMogrts = platformInfo.captionMogrtDirs({ ...MAC, ...macFs });
  assert.ok(macMogrts.some((d) => d.includes("Captions and Subtitles")));
  assert.ok(
    macMogrts.some((d) => d === "/Library/Application Support/Adobe/Common/Essential Graphics"),
    "the shared Creative Cloud Essential Graphics store is also searched"
  );

  const winRoot = "C:\\Program Files\\Adobe\\Adobe Premiere Pro 2025";
  const winFs = fakeFs(["C:\\Program Files\\Adobe", winRoot], {
    "C:\\Program Files\\Adobe": ["Adobe Premiere Pro 2025"],
  });
  assert.ok(platformInfo.sequencePresetDirs({ ...WIN, ...winFs })[0].startsWith(winRoot));
});

test("the folder opener is explorer on Windows and open on macOS", () => {
  assert.deepEqual(platformInfo.openFolderCommand("C:\\out", WIN), { cmd: "explorer", args: ["C:\\out"] });
  assert.deepEqual(platformInfo.openFolderCommand("/out", MAC), { cmd: "open", args: ["/out"] });
});

test("openFolder never throws, even for a command that does not exist", async () => {
  // spawn reports a missing executable via an async 'error' event, not a throw, so
  // the old try/catch around spawn("explorer") could not catch it — on macOS Node
  // re-threw it as an uncaught exception AFTER the SRT files were already written.
  // openFolder attaches a no-op listener; this test fails on an unhandled rejection.
  let sawUncaught = null;
  const onUncaught = (e) => (sawUncaught = e);
  process.once("uncaughtException", onUncaught);

  assert.doesNotThrow(() => platformInfo.openFolder(__dirname, { platform: "definitely-not-an-os" }));
  await new Promise((r) => setTimeout(r, 250)); // let any async error surface

  process.removeListener("uncaughtException", onUncaught);
  assert.equal(sawUncaught, null, `openFolder leaked an uncaught error: ${sawUncaught && sawUncaught.message}`);
});

test("CSXS versions cover Premiere 2019 through 2025", () => {
  assert.deepEqual(platformInfo.CSXS_VERSIONS, [9, 10, 11, 12]);
});
