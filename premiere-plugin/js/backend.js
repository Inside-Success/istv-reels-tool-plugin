"use strict";

/**
 * Client for the hosted backend (unchanged contract from the desktop app):
 * uploads compressed audio and polls the transcription / selection jobs. Uses
 * Node's built-in http/https — CEP panels have Node.js, so this ports verbatim.
 *
 *   GET  /health              liveness + which keys are configured
 *   POST /transcribe          raw audio bytes -> { job_id }
 *   POST /select              { transcript, name, num_reels } -> { job_id }
 *   GET  /jobs/{id}           poll -> status + transcript|analysis
 *
 * Every request carries `Authorization: Bearer <token>` when a token is
 * configured (see js/config.js). /transcribe, /select and /jobs are all gated by
 * that token server-side because they spend real money and return transcripts; a
 * local backend running without ISTV_API_TOKEN simply ignores the header.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const config = require("./config");

function lib(u) {
  return u.protocol === "https:" ? https : http;
}

/** Current backend base URL. Read per call — the editor can change it at runtime. */
function baseUrl() {
  return config.current().backendUrl;
}

/**
 * Auth header for every request. The token is read at call time, not captured at
 * module load, so a token the editor just saved works without reloading the panel.
 */
function authHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  const token = config.current().authToken;
  if (token) headers.Authorization = "Bearer " + token;
  return headers;
}

function getJSON(urlStr, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = lib(u).request(u, { method: "GET", timeout: timeoutMs, headers: authHeaders() }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error("Bad JSON from backend: " + e.message));
          }
        } else {
          reject(new Error(`Backend ${res.statusCode}: ${body.slice(0, 300)}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Backend request timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** GET /health — fail fast with a clear message if the server is down. */
async function health() {
  return getJSON(`${baseUrl()}/health`);
}

/**
 * Check whether the configured token is accepted, WITHOUT spending any money.
 *
 * The probe is `GET /jobs/<nonexistent-id>`, which is guarded by the same bearer
 * check as the paid endpoints but does no work:
 *
 *   401 → the token is missing or wrong
 *   404 → authorised; the job genuinely does not exist  ✅
 *   200 → authorised (astronomically unlikely id collision)
 *
 * Deliberately NOT /transcribe or /select: hitting those to test auth submits a
 * real Rev.ai job or runs two Claude Opus calls. /health can't be used either —
 * it is intentionally unauthenticated, so it succeeds with any token or none.
 *
 * Resolves { ok, status, reason }. Never throws for an auth failure; only a
 * genuinely unreachable backend rejects.
 */
function verifyToken({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const probeId = "auth-probe-000000000000000000000000";
    const u = new URL(`${baseUrl()}/jobs/${probeId}`);
    const req = lib(u).request(u, { method: "GET", timeout: timeoutMs, headers: authHeaders() }, (res) => {
      res.resume(); // drain, we only care about the status
      res.on("end", () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          resolve({
            ok: false,
            status: res.statusCode,
            reason: config.current().hasToken
              ? "The backend rejected this token. Check it for typos, or ask for a current one."
              : "This backend requires an access token, and none is set.",
          });
        } else if (res.statusCode === 404 || (res.statusCode >= 200 && res.statusCode < 300)) {
          resolve({ ok: true, status: res.statusCode, reason: "" });
        } else {
          resolve({ ok: false, status: res.statusCode, reason: `Backend returned ${res.statusCode}.` });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Backend request timed out")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Upload an audio file to POST /transcribe as raw bytes, reporting upload
 * progress (0..1). Resolves to the backend's { job_id }.
 */
function uploadAudio(audioPath, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${baseUrl()}/transcribe`);
    const total = fs.statSync(audioPath).size;
    let sent = 0;

    const req = lib(u).request(u, {
      method: "POST",
      headers: authHeaders({
        "Content-Type": "application/octet-stream",
        "Content-Length": total,
        "X-Filename": path.basename(audioPath),
      }),
    });

    req.on("response", (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error("Bad JSON from /transcribe: " + e.message));
          }
        } else {
          reject(new Error(`Upload failed ${res.statusCode}: ${body.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);

    const stream = fs.createReadStream(audioPath);
    stream.on("data", (chunk) => {
      sent += chunk.length;
      if (onProgress) onProgress(Math.min(1, sent / total));
    });
    stream.on("error", reject);
    stream.pipe(req);
  });
}

/** POST JSON to a path, returning the parsed response. */
function postJSON(pathName, obj, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${baseUrl()}${pathName}`);
    const data = Buffer.from(JSON.stringify(obj), "utf8");
    const req = lib(u).request(
      u,
      {
        method: "POST",
        timeout: timeoutMs,
        headers: authHeaders({ "Content-Type": "application/json", "Content-Length": data.length }),
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(new Error("Bad JSON: " + e.message));
            }
          } else {
            reject(new Error(`Backend ${res.statusCode}: ${body.slice(0, 300)}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    req.end(data);
  });
}

/**
 * Poll GET /jobs/{id} until status is done/error. Calls onStatus each tick.
 * Resolves with the full final status object (has .transcript or .analysis).
 */
async function pollJob(jobId, { onStatus, intervalMs = 2500, timeoutMs = 30 * 60 * 1000 } = {}) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const s = await getJSON(`${baseUrl()}/jobs/${jobId}`);
    if (onStatus) onStatus(s);
    if (s.status === "done") return s;
    if (s.status === "error") throw new Error(s.error || "Job failed");
    if (Date.now() - start > timeoutMs) throw new Error("Job timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** POST /transcribe then poll → resolves with the transcript. */
async function transcribe(audioPath, { onUpload, onStatus } = {}) {
  const { job_id } = await uploadAudio(audioPath, { onProgress: onUpload });
  const final = await pollJob(job_id, { onStatus });
  return final.transcript;
}

/** POST /select then poll → resolves with the analysis (reels + metadata). */
async function selectReels(transcript, name, numReels, { onStatus } = {}) {
  const { job_id } = await postJSON("/select", { transcript, name, num_reels: numReels });
  const final = await pollJob(job_id, { onStatus });
  return final.analysis;
}

module.exports = {
  health,
  verifyToken,
  uploadAudio,
  transcribe,
  pollJob,
  selectReels,
  // A getter, not a captured value: the effective URL can change while the panel
  // is open (env override, user config), and error messages must show the real one.
  get BACKEND_URL() {
    return baseUrl();
  },
};
