"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const updater = require("../js/updater");

test("selects the package for each supported editor platform", () => {
  assert.equal(updater.platformLabel("win32", "x64"), "win-x64");
  assert.equal(updater.platformLabel("darwin", "arm64"), "mac-arm64");
  assert.equal(updater.platformLabel("darwin", "x64"), "mac-x64");
  assert.throws(() => updater.platformLabel("linux", "x64"));
});

test("updates require a higher stable version", () => {
  assert.equal(updater.isNewer("v1.2.4", "1.2.3"), true);
  assert.equal(updater.isNewer("v1.2.3", "1.2.3"), false);
  assert.equal(updater.isNewer("v1.2.2", "1.2.3"), false);
  assert.equal(updater.isNewer("v1.3.0", "1.2.9"), true);
  assert.equal(updater.isNewer("v1.2.4-beta", "1.2.3"), false);
  assert.equal(updater.isNewer("v1.2.5-build.2", "1.2.5-build.1"), true);
  assert.equal(updater.isNewer("v1.2.5-build.1", "1.2.5"), true);
  assert.equal(updater.isNewer("v1.2.6", "1.2.5-build.99"), true);
});

test("accepts only the exact release asset with a SHA-256 digest", () => {
  const name = "ISTV-Reel-Tool-mac-arm64.zip";
  const good = {
    name,
    browser_download_url: `https://github.com/Inside-Success/istv-reels-tool-plugin/releases/download/v1.2.4/${name}`,
    digest: "sha256:" + "a".repeat(64),
    size: 40_000_000,
  };
  assert.equal(updater.selectAsset({ tag_name: "v1.2.4", assets: [good] }, "mac-arm64").expectedHash, "a".repeat(64));
  assert.throws(() => updater.selectAsset({ tag_name: "v1.2.4", assets: [{ ...good, digest: null }] }, "mac-arm64"));
  assert.throws(() => updater.selectAsset({ tag_name: "v1.2.4", assets: [{ ...good, browser_download_url: "https://example.com/update.zip" }] }, "mac-arm64"));
});
