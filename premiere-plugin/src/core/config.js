"use strict";

/**
 * Panel configuration. CEP panels run with Node.js enabled, so we read a plain
 * config.json shipped at the extension root. Resolution order per setting
 * (first hit wins):
 *
 *   1. environment variable            ISTV_BACKEND_URL / ISTV_BACKEND_TOKEN
 *   2. <extension>/config.json         { "backendUrl": "...", "authToken": "..." }
 *   3. built-in default                http://127.0.0.1:8722
 *
 * To point every editor at your hosted backend, pass --backend-url to
 * tools/build.mjs once per release; it rewrites config.json in the staged bundle.
 * The build refuses to ship a loopback URL unless you explicitly allow it, so a
 * release can't accidentally go out pointing at your own laptop.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_BACKEND_URL = "http://127.0.0.1:8722";
const CONFIG_PATH = path.resolve(__dirname, "..", "..", "config.json");

function readConfigFile(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath || CONFIG_PATH, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

/**
 * True for URLs that only resolve on the machine that built the bundle. Used by
 * the packaging guard and by the panel to warn instead of silently failing.
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
 * drive every precedence branch: resolve({ env, file }).
 */
function resolve({ env = process.env, file } = {}) {
  const cfg = file || readConfigFile();
  const backendUrl = String(env.ISTV_BACKEND_URL || cfg.backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
  return {
    backendUrl,
    // Optional bearer token. Only sent when set, so it stays compatible with a
    // backend that doesn't check one yet.
    authToken: String(env.ISTV_BACKEND_TOKEN || cfg.authToken || ""),
    canvas: cfg.canvas && cfg.canvas.width && cfg.canvas.height ? cfg.canvas : { width: 1080, height: 1920 },
    isLocalBackend: isLoopbackUrl(backendUrl),
  };
}

const settings = resolve();

module.exports = {
  DEFAULT_BACKEND_URL,
  CONFIG_PATH,
  isLoopbackUrl,
  resolve,
  readConfigFile,
  BACKEND_URL: settings.backendUrl,
  AUTH_TOKEN: settings.authToken,
  DEFAULT_CANVAS: settings.canvas,
  IS_LOCAL_BACKEND: settings.isLocalBackend,
};
