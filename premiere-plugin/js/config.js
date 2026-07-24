"use strict";

/**
 * Panel configuration. CEP panels run with Node.js enabled, so we can read a
 * plain config.json shipped next to the extension. Resolution order for the
 * backend URL (first hit wins):
 *
 *   1. ISTV_BACKEND_URL environment variable   (per-machine override)
 *   2. <extension>/config.json  { "backendUrl": "..." }   (what you ship)
 *   3. http://127.0.0.1:8722                    (local dev default)
 *
 * To point every editor at your hosted backend, set backendUrl in config.json
 * once before packaging (or pass -BackendUrl to installer/package.ps1). For your
 * own local testing, leave it as the localhost default and run backend/ locally.
 */
const fs = require("fs");
const path = require("path");

function readConfigFile() {
  try {
    const p = path.join(__dirname, "..", "config.json");
    return JSON.parse(fs.readFileSync(p, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

const cfg = readConfigFile();
const BACKEND_URL = (process.env.ISTV_BACKEND_URL || cfg.backendUrl || "http://127.0.0.1:8722").replace(/\/$/, "");

// Target reel canvas (vertical 9:16). Overridable via config.json.canvas.
const DEFAULT_CANVAS = cfg.canvas || { width: 1080, height: 1920 };

module.exports = { BACKEND_URL, DEFAULT_CANVAS };
