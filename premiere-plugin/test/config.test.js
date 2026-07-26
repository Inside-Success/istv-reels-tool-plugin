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

test("the user's own token beats the bundled one, and env beats both", () => {
  // This precedence is the whole point of the public-download design: the shipped
  // bundle carries NO token (publishing it would publish the token), so the editor's
  // ~/.istv-reel-tool/config.json is where the real one lives.
  const bundled = { backendUrl: "https://hosted.example" };
  assert.equal(config.resolve({ env: {}, file: bundled, userFile: { authToken: "mine" } }).authToken, "mine");
  assert.equal(
    config.resolve({ env: { ISTV_BACKEND_TOKEN: "from-env" }, file: bundled, userFile: { authToken: "mine" } }).authToken,
    "from-env"
  );
  // A bundle that DOES carry one (an internal build) still works as a fallback.
  assert.equal(config.resolve({ env: {}, file: { authToken: "baked" }, userFile: {} }).authToken, "baked");
  assert.equal(config.resolve({ env: {}, file: {}, userFile: {} }).authToken, "");
});

test("hasToken and tokenSource let the panel explain itself", () => {
  const none = config.resolve({ env: {}, file: {}, userFile: {} });
  assert.equal(none.hasToken, false);
  assert.equal(none.tokenSource, "");

  assert.equal(config.resolve({ env: {}, file: {}, userFile: { authToken: "t" } }).tokenSource, "this machine");
  assert.equal(config.resolve({ env: {}, file: { authToken: "t" }, userFile: {} }).tokenSource, "the installed bundle");
  assert.equal(config.resolve({ env: { ISTV_BACKEND_TOKEN: "t" }, file: {}, userFile: {} }).tokenSource, "environment");
  assert.equal(config.resolve({ env: {}, file: {}, userFile: { authToken: "t" } }).hasToken, true);
});

test("a whitespace-only token counts as no token", () => {
  // Otherwise an editor who pastes a stray space gets "token rejected" from the
  // server instead of "no token set", which points at the wrong problem.
  const r = config.resolve({ env: {}, file: {}, userFile: { authToken: "   " } });
  assert.equal(r.authToken, "");
  assert.equal(r.hasToken, false);
});

test("the user config can also override the backend URL", () => {
  const r = config.resolve({
    env: {},
    file: { backendUrl: "https://hosted.example" },
    userFile: { backendUrl: "https://staging.example" },
  });
  assert.equal(r.backendUrl, "https://staging.example");
});

test("saveUserToken round-trips and preserves other user settings", () => {
  const fsMod = require("node:fs");
  const backup = fsMod.existsSync(config.USER_CONFIG_PATH)
    ? fsMod.readFileSync(config.USER_CONFIG_PATH, "utf8")
    : null;
  try {
    // Seed an unrelated setting to prove saving the token doesn't clobber it.
    fsMod.mkdirSync(config.USER_CONFIG_DIR, { recursive: true });
    fsMod.writeFileSync(config.USER_CONFIG_PATH, JSON.stringify({ canvas: { width: 720, height: 1280 } }), "utf8");

    const saved = config.saveUserToken("  tok-with-spaces  ");
    assert.equal(saved.ok, true);
    const back = config.readUserConfig();
    assert.equal(back.authToken, "tok-with-spaces", "trimmed on save");
    assert.deepEqual(back.canvas, { width: 720, height: 1280 }, "other settings survive");

    // current() must reflect the new token immediately — the panel relies on this
    // instead of asking the editor to reload after saving.
    assert.equal(config.current().authToken, "tok-with-spaces");

    // Saving empty clears it rather than storing "".
    config.saveUserToken("");
    assert.equal("authToken" in config.readUserConfig(), false);
    assert.equal(config.current().hasToken, false);
  } finally {
    if (backup !== null) fsMod.writeFileSync(config.USER_CONFIG_PATH, backup, "utf8");
    else fsMod.rmSync(config.USER_CONFIG_PATH, { force: true });
  }
});

test("a corrupt user config degrades to the bundled settings", () => {
  const fsMod = require("node:fs");
  const backup = fsMod.existsSync(config.USER_CONFIG_PATH)
    ? fsMod.readFileSync(config.USER_CONFIG_PATH, "utf8")
    : null;
  try {
    fsMod.mkdirSync(config.USER_CONFIG_DIR, { recursive: true });
    fsMod.writeFileSync(config.USER_CONFIG_PATH, "{ not json", "utf8");
    assert.deepEqual(config.readUserConfig(), {});
    assert.doesNotThrow(() => config.current());
  } finally {
    if (backup !== null) fsMod.writeFileSync(config.USER_CONFIG_PATH, backup, "utf8");
    else fsMod.rmSync(config.USER_CONFIG_PATH, { force: true });
  }
});

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
