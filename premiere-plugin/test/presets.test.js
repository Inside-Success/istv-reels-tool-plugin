"use strict";

/**
 * Template discovery. Getting this wrong is not a crash — it is a silent quality
 * regression (16:9 reels, hand-dragged SRTs), which is why it is tested on both
 * platforms with a fake filesystem rather than left to be noticed in the field.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const presets = require(path.join(__dirname, "..", "src", "core", "presets.js"));

function fake(existing, dirs = {}) {
  const set = new Set(existing);
  return { exists: (p) => set.has(p), readdir: (p) => dirs[p] || [] };
}

const MAC = { platform: "darwin", arch: "arm64", homedir: "/Users/editor", env: {} };
const WIN = {
  platform: "win32",
  arch: "x64",
  homedir: "C:\\Users\\editor",
  env: { ProgramFiles: "C:\\Program Files", CommonProgramFiles: "C:\\Program Files\\Common Files" },
};

const MAC_ROOT = "/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app/Contents";
const MAC_PRESET_DIR = MAC_ROOT + "/Settings/SequencePresets/Social";
const MAC_MOGRT_DIR = MAC_ROOT + "/Essential Graphics/Captions and Subtitles";
const MAC_TREE = {
  "/Applications": ["Adobe Premiere Pro 2025"],
  "/Applications/Adobe Premiere Pro 2025": ["Adobe Premiere Pro 2025.app"],
};

test("a bundled preset always wins over Premiere's built-in", () => {
  const extRoot = "/ext";
  const bundled = "/ext/presets/ISTV_Vertical_1080x1920.sqpreset";
  const found = presets.findVerticalPreset({
    ...MAC,
    extRoot,
    ...fake([bundled, "/Applications", MAC_ROOT, MAC_PRESET_DIR], {
      ...MAC_TREE,
      [MAC_PRESET_DIR]: ["Vertical 9x16.sqpreset"],
    }),
  });
  assert.equal(found, bundled);
});

test("macOS falls back to Premiere's built-in 9x16 preset INSIDE the .app bundle", () => {
  // The whole point: this lookup returned "" on every Mac before adobeAppRoots()
  // learned to reach into the bundle.
  const found = presets.findVerticalPreset({
    ...MAC,
    extRoot: "/ext",
    ...fake(["/Applications", MAC_ROOT, MAC_PRESET_DIR], {
      ...MAC_TREE,
      [MAC_PRESET_DIR]: ["Some 16x9 preset.sqpreset", "Vertical 9x16 30fps.sqpreset"],
    }),
  });
  assert.equal(found, MAC_PRESET_DIR + "/Vertical 9x16 30fps.sqpreset");
});

test("Windows falls back to Premiere's built-in 9x16 preset", () => {
  const root = "C:\\Program Files\\Adobe\\Adobe Premiere Pro 2025";
  const dir = path.win32.join(root, "Settings", "SequencePresets", "Social");
  const found = presets.findVerticalPreset({
    ...WIN,
    extRoot: "C:\\ext",
    ...fake(["C:\\Program Files\\Adobe", root, dir], {
      "C:\\Program Files\\Adobe": ["Adobe Premiere Pro 2025"],
      [dir]: ["Vertical 9x16.sqpreset"],
    }),
  });
  assert.equal(found, path.win32.join(dir, "Vertical 9x16.sqpreset"));
});

test("a non-portrait preset is not mistaken for a vertical one", () => {
  const found = presets.findVerticalPreset({
    ...MAC,
    extRoot: "/ext",
    ...fake(["/Applications", MAC_ROOT, MAC_PRESET_DIR], {
      ...MAC_TREE,
      [MAC_PRESET_DIR]: ["Widescreen 1080p.sqpreset", "notes.txt"],
    }),
  });
  assert.equal(found, "", "better to warn and use the project raster than pick a 16:9 preset");
});

test("caption MOGRT lookup prefers Simple Web, then Web Caption, then any caption", () => {
  const pick = (files) =>
    presets.findCaptionMogrt({
      ...MAC,
      extRoot: "/ext",
      ...fake(["/Applications", MAC_ROOT, MAC_MOGRT_DIR], { ...MAC_TREE, [MAC_MOGRT_DIR]: files }),
    });

  assert.equal(
    pick(["Fancy Caption.mogrt", "Simple Web Caption.mogrt", "Web Caption Bold.mogrt"]),
    MAC_MOGRT_DIR + "/Simple Web Caption.mogrt"
  );
  assert.equal(pick(["Fancy Thing.mogrt", "Web Caption Bold.mogrt"]), MAC_MOGRT_DIR + "/Web Caption Bold.mogrt");
  assert.equal(pick(["Lower Third Caption.mogrt"]), MAC_MOGRT_DIR + "/Lower Third Caption.mogrt");
  assert.equal(pick(["Anything.mogrt"]), MAC_MOGRT_DIR + "/Anything.mogrt", "any MOGRT beats no captions");
  assert.equal(pick(["readme.txt"]), "", "non-MOGRT files are ignored");
});

test("discover() reports both templates and warns about what is missing", () => {
  const nothing = presets.discover({ ...MAC, extRoot: "/ext", ...fake([]) });
  assert.equal(nothing.verticalPreset, "");
  assert.equal(nothing.captionMogrt, "");
  assert.equal(nothing.captionMode, "native", "no MOGRT means the SRT path");
  assert.equal(nothing.warnings.length, 2);
  assert.match(nothing.warnings[0], /9:16/);
  assert.match(nothing.warnings[1], /caption/i);

  const both = presets.discover({
    ...MAC,
    extRoot: "/ext",
    ...fake(["/ext/presets/ISTV_Vertical_1080x1920.sqpreset", "/ext/presets/captions.mogrt"]),
  });
  assert.equal(both.captionMode, "karaoke");
  assert.deepEqual(both.warnings, [], "nothing to warn about when both templates exist");
});

test("discovery on a machine with no Premiere installed returns empty, not an error", () => {
  assert.doesNotThrow(() => presets.discover({ ...MAC, extRoot: "/ext", ...fake([]) }));
  assert.doesNotThrow(() => presets.discover({ ...WIN, extRoot: "C:\\ext", ...fake([]) }));
});

test("discovery against the real filesystem does not throw", () => {
  // No assertion on the result: whether Premiere is installed on the machine
  // running the suite is not the plugin's business. It must not blow up either way.
  const found = presets.discover();
  assert.equal(typeof found.verticalPreset, "string");
  assert.equal(typeof found.captionMogrt, "string");
  assert.ok(["karaoke", "native"].includes(found.captionMode));
});
