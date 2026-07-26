"use strict";

/**
 * Panel configuration, resolved from three layers (first hit wins per setting):
 *
 *   1. environment variables     ISTV_BACKEND_URL / ISTV_BACKEND_TOKEN
 *   2. user config               ~/.istv-reel-tool/config.json      ← the editor's
 *   3. bundled config            <extension>/config.json            ← what you ship
 *   4. built-in default          http://127.0.0.1:8722
 *
 * WHY THE USER LAYER EXISTS. The backend requires a bearer token, and the bundle is
 * published for public download. Baking the token into the bundle would publish the
 * token too — anyone could unzip it, read config.json, and spend the Rev.ai and
 * Anthropic budget. So the shipped bundle carries the backend URL (not secret) and
 * NO token; each editor enters the token once in the panel and it is saved here,
 * under their home directory, outside the extension folder so it survives
 * reinstalls and upgrades.
 *
 * Settings are re-read on every access rather than cached at module load, so saving
 * a token takes effect immediately instead of needing a panel reload.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_BACKEND_URL = "http://127.0.0.1:8722";

/** Shipped with the extension. Contains the backend URL; never a token. */
const CONFIG_PATH = path.resolve(__dirname, "..", "..", "config.json");

/** The editor's own settings. Holds the token they entered. */
const USER_CONFIG_DIR = path.join(os.homedir(), ".istv-reel-tool");
const USER_CONFIG_PATH = path.join(USER_CONFIG_DIR, "config.json");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

function readConfigFile(configPath) {
  return readJson(configPath || CONFIG_PATH);
}

function readUserConfig() {
  return readJson(USER_CONFIG_PATH);
}

/**
 * True for URLs that only resolve on the machine that built the bundle. Used by
 * the packaging guard and by the panel to explain a failure instead of just
 * reporting it.
 */
function isLoopbackUrl(url) {
  const host = String(url || "")
    .replace(/^[a-z]+:\/\//i, "")
    .split("/")[0]
    .split("@")
    .pop()
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    // Anchored at both ends: a bare /^127\./ also matched real hostnames like
    // "127.0.0.1.example.com", which would block a legitimate release.
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /\.local$/.test(host)
  );
}

/**
 * Resolve the effective settings. Pure with respect to its inputs so the tests can
 * drive every precedence branch: resolve({ env, file, userFile }).
 */
function resolve({ env = process.env, file, userFile } = {}) {
  const bundled = file || readConfigFile();
  const user = userFile || readUserConfig();

  const backendUrl = String(
    env.ISTV_BACKEND_URL || user.backendUrl || bundled.backendUrl || DEFAULT_BACKEND_URL
  ).replace(/\/+$/, "");

  // The user layer is checked BEFORE the bundled one: a published bundle has no
  // token, and this is where the editor's own token lives.
  const authToken = String(env.ISTV_BACKEND_TOKEN || user.authToken || bundled.authToken || "").trim();

  const canvas =
    (user.canvas && user.canvas.width && user.canvas.height && user.canvas) ||
    (bundled.canvas && bundled.canvas.width && bundled.canvas.height && bundled.canvas) ||
    { width: 1080, height: 1920 };

  return {
    backendUrl,
    authToken,
    canvas,
    isLocalBackend: isLoopbackUrl(backendUrl),
    hasToken: authToken.length > 0,
    // Where the token came from, so the panel can explain itself.
    tokenSource: env.ISTV_BACKEND_TOKEN
      ? "environment"
      : user.authToken
      ? "this machine"
      : bundled.authToken
      ? "the installed bundle"
      : "",
  };
}

/**
 * Persist the editor's token to ~/.istv-reel-tool/config.json, preserving anything
 * else already in there. Returns { ok, error } — the panel surfaces the reason
 * rather than silently failing to save.
 */
function saveUserToken(token) {
  try {
    fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
    const current = readUserConfig();
    const next = { ...current, authToken: String(token || "").trim() };
    if (!next.authToken) delete next.authToken;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
    return { ok: true, path: USER_CONFIG_PATH };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Live settings — a getter, so a freshly saved token is picked up at once. */
function current() {
  return resolve();
}

module.exports = {
  DEFAULT_BACKEND_URL,
  CONFIG_PATH,
  USER_CONFIG_PATH,
  USER_CONFIG_DIR,
  isLoopbackUrl,
  resolve,
  current,
  readConfigFile,
  readUserConfig,
  saveUserToken,
  // Convenience accessors. These read at call time; do not destructure and cache.
  get BACKEND_URL() {
    return resolve().backendUrl;
  },
  get AUTH_TOKEN() {
    return resolve().authToken;
  },
  get DEFAULT_CANVAS() {
    return resolve().canvas;
  },
  get IS_LOCAL_BACKEND() {
    return resolve().isLocalBackend;
  },
};
