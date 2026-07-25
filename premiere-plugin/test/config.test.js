"use strict";

/**
 * Configuration precedence and the loopback check that gates a release.
 * Shipping a bundle pointing at 127.0.0.1 is the single easiest way to send every
 * editor a panel that cannot work, so the detection is tested exhaustively.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const config = require(path.join(__dirname, "..", "src", "core", "config.js"));

test("environment variables beat config.json, which beats the default", () => {
  assert.equal(
    config.resolve({ env: { ISTV_BACKEND_URL: "https://from-env.example" }, file: { backendUrl: "https://from-file.example" } })
      .backendUrl,
    "https://from-env.example"
  );
  assert.equal(config.resolve({ env: {}, file: { backendUrl: "https://from-file.example" } }).backendUrl, "https://from-file.example");
  assert.equal(config.resolve({ env: {}, file: {} }).backendUrl, config.DEFAULT_BACKEND_URL);
});

test("trailing slashes are stripped so URL joins don't double up", () => {
  assert.equal(config.resolve({ env: {}, file: { backendUrl: "https://x.example/" } }).backendUrl, "https://x.example");
  assert.equal(config.resolve({ env: {}, file: { backendUrl: "https://x.example///" } }).backendUrl, "https://x.example");
});

test("the auth token is optional and comes from env or file", () => {
  assert.equal(config.resolve({ env: {}, file: {} }).authToken, "", "absent by default, so no header is sent");
  assert.equal(config.resolve({ env: {}, file: { authToken: "from-file" } }).authToken, "from-file");
  assert.equal(config.resolve({ env: { ISTV_BACKEND_TOKEN: "from-env" }, file: { authToken: "from-file" } }).authToken, "from-env");
});

test("the canvas defaults to 1080x1920 and rejects a partial override", () => {
  assert.deepEqual(config.resolve({ env: {}, file: {} }).canvas, { width: 1080, height: 1920 });
  assert.deepEqual(config.resolve({ env: {}, file: { canvas: { width: 720, height: 1280 } } }).canvas, {
    width: 720,
    height: 1280,
  });
  assert.deepEqual(
    config.resolve({ env: {}, file: { canvas: { width: 720 } } }).canvas,
    { width: 1080, height: 1920 },
    "a half-specified canvas falls back rather than producing a 0-height sequence"
  );
});

test("loopback addresses are detected in every form", () => {
  for (const url of [
    "http://127.0.0.1:8722",
    "http://127.0.0.1",
    "http://127.1.2.3:8722",
    "https://localhost:3000",
    "http://localhost",
    "http://0.0.0.0:8722",
    "http://[::1]:8722",
    "http://my-macbook.local:8722",
    "http://user:pw@localhost:8722",
  ]) {
    assert.equal(config.isLoopbackUrl(url), true, `${url} should be loopback`);
  }
});

test("real hosts are not flagged as loopback", () => {
  for (const url of [
    "https://reels.insidesuccess.com",
    "http://10.0.0.5:8722",
    "https://192.168.1.20:8722",
    "https://api.example.com/reels",
    "https://localhost.example.com",
    "https://127.0.0.1.example.com",
  ]) {
    assert.equal(config.isLoopbackUrl(url), false, `${url} should NOT be loopback`);
  }
});

test("isLocalBackend flows through to the panel so it can explain the failure", () => {
  assert.equal(config.resolve({ env: {}, file: { backendUrl: "http://127.0.0.1:8722" } }).isLocalBackend, true);
  assert.equal(config.resolve({ env: {}, file: { backendUrl: "https://reels.example.com" } }).isLocalBackend, false);
});

test("a missing or malformed config.json degrades to defaults instead of throwing", () => {
  assert.deepEqual(config.readConfigFile("/definitely/not/here.json"), {});
  const bad = path.join(__dirname, "fixtures", "broken-config.json");
  fs.writeFileSync(bad, "{ this is not json", "utf8");
  try {
    assert.deepEqual(config.readConfigFile(bad), {});
  } finally {
    fs.rmSync(bad, { force: true });
  }
});

test("the committed config.json is valid and readable", () => {
  const cfg = JSON.parse(fs.readFileSync(config.CONFIG_PATH, "utf8"));
  assert.equal(typeof cfg.backendUrl, "string");
  assert.ok(cfg.backendUrl.length > 0);
  assert.equal(typeof cfg.canvas.width, "number");
  assert.equal(typeof cfg.canvas.height, "number");
});
