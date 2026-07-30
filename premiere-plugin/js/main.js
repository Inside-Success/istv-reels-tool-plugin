"use strict";

/*
 * ISTV Reel Tool — panel controller.
 *
 * Runs in the CEP panel (Node.js enabled). It orchestrates the AI half of the
 * pipeline exactly like the old Electron app, then hands finished reels to the
 * ExtendScript host (host.jsx) to build inside Premiere:
 *
 *   detect source (active sequence clip)
 *     → extract compressed audio (bundled FFmpeg)
 *     → upload + transcribe (backend / Rev.ai)
 *     → select reels (backend / Claude, v2_test2 profile)
 *     → build one 9:16 sequence per reel in Premiere (host.jsx)
 *
 * The full video never leaves the machine — only the mono 16 kHz MP3 is uploaded.
 */

/* global CSInterface, SystemPath */

// ── Node modules (loaded by absolute path from the extension root) ─────────────
const path = require("path");
const cs = new CSInterface();
const EXT_ROOT = cs.getSystemPath(SystemPath.EXTENSION);

// NOTE: Adobe's own CEP docs confirm CSInterface.resizeContent() is a no-op
// for Panel-type extensions in Premiere Pro specifically (it only works for
// Custom/modal extensions) — there is no scripted way to force this panel's
// size once Premiere has cached a manually-resized geometry for it. The
// manifest's <Geometry><Size> (CSXS/manifest.xml) is the real default, but it
// only applies the first time this extension is ever opened on a machine —
// after that, drag-resize once and Premiere remembers it from then on.
const backend = require(path.join(EXT_ROOT, "js", "backend.js"));
const ffmpeg = require(path.join(EXT_ROOT, "js", "ffmpeg.js"));
const captionDoc = require(path.join(EXT_ROOT, "js", "captionDoc.js"));
const captionTemplates = require(path.join(EXT_ROOT, "js", "captionTemplates.js"));
const premiereXml = require(path.join(EXT_ROOT, "js", "premiereXml.js"));
const { createCaptionPanel } = require(path.join(EXT_ROOT, "js", "captionPanel.js"));
const config = require(path.join(EXT_ROOT, "js", "config.js"));
const { DEFAULT_CANVAS } = config;

// Fallback words-per-MOGRT-pop when a template doesn't specify karaoke.chunkSize
// (see buildCaptionBlocksForTemplate — chunk size is otherwise template-driven).
const CAPTION_CHUNK_SIZE = 3;

/** Karaoke-style MOGRT chunk size for a template — see §5/§7b: this is words
 *  per pop-in, not a per-word color sweep (Premiere/ExtendScript can't do that). */
function chunkSizeForTemplate(templateId) {
  const t = captionTemplates.getTemplate(templateId);
  const n = t && t.karaoke && Number(t.karaoke.chunkSize);
  return Number.isFinite(n) && n > 0 ? n : CAPTION_CHUNK_SIZE;
}

/** Karaoke MOGRT blocks are generated FROM the caption doc (not the raw
 *  transcript) so panel edits — text changes, split/merge, SRT import — are
 *  what actually gets built into the sequence (§1). */
function buildCaptionBlocksForTemplate(doc, templateId) {
  return captionDoc.docToCaptionBlocks(doc, { chunkSize: chunkSizeForTemplate(templateId) });
}

/** Recompute a reel's MOGRT caption blocks after its caption doc changes
 *  (template swap, edits, SRT import) — called from the caption panel. */
function rebuildCaptionBlocks(reel) {
  reel.captionBlocks = buildCaptionBlocksForTemplate(reel.captionDoc, reel.captionDoc.templateId);
}

/**
 * Build the Premiere caption graphics XML (js/premiereXml.js) for a reel —
 * the primary caption path (see jsx/captions.jsx applyGraphicsXml). Pattern
 * from JorianWoltjer/AutoCaptions: a plain FCP7 XML sequence Premiere imports
 * natively, with text/style baked into each clip — no MOGRT file, no
 * importMGT, no runtime property-guessing. Empty string if the reel has no
 * cues yet (nothing to render).
 *
 * `fps` must be the SAME rate host.jsx will actually apply to the reel
 * sequence (see resolveTrueFps) — not just the raw ffprobe value, which can
 * genuinely differ from Premiere's own footage interpretation for some
 * footage. A caption sequence built at one fps nested inside a reel running
 * at a different one drifts out of sync over the reel's length (reported as
 * captions starting in sync and slowly landing later — the signature of a
 * frame-rate mismatch, not a placement bug).
 */
function buildXmlForReel(reel, fps) {
  const doc = reel.captionDoc;
  if (!doc || !Array.isArray(doc.cues) || !doc.cues.length) return "";
  const template = captionTemplates.getTemplate(doc.templateId);
  const clips = premiereXml.clipsFromCaptionDoc(doc, template, {
    mode: "karaoke",
    chunkSize: chunkSizeForTemplate(doc.templateId),
    fps,
    width: DEFAULT_CANVAS.width,
  });
  if (!clips.length) return "";
  return premiereXml.buildCaptionSequenceXml(clips, {
    fps,
    width: DEFAULT_CANVAS.width,
    height: DEFAULT_CANVAS.height,
    sequenceName: `Captions (${reel.title || "Reel"})`,
  });
}

/**
 * Ask Premiere for the source clip's own footage-interpretation frame rate —
 * the exact same call host.jsx's buildOneReel makes to set the reel
 * sequence's real fps — and cache it. Falls back to the ffprobe value (or
 * 30) if the host call fails, same as host.jsx's own fallback chain, so a
 * failure here degrades gracefully rather than blocking Build.
 */
async function resolveTrueFps() {
  const probedFps = (state.source && state.source.meta && state.source.meta.fps) || 30;
  if (state.trueFps) return state.trueFps;
  if (!state.source || !state.source.path) return probedFps;
  try {
    const res = await hostCall("getSourceFrameRate", { sourcePath: state.source.path, fallbackFps: probedFps });
    const fps = res.ok && res.data && res.data.fps > 0 ? res.data.fps : probedFps;
    state.trueFps = fps;
    return fps;
  } catch (e) {
    return probedFps;
  }
}

// Presets: prefer a bundled custom template, else auto-detect Premiere's
// built-in 9:16 sequence preset + caption MOGRT so the plugin works out of the
// box with zero manual setup.
const fs = require("fs");

function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (e) {
      /* ignore */
    }
  }
  return "";
}

/**
 * Reveal a folder in the OS file manager. Never allowed to take the panel down.
 *
 * TWO THINGS TO KNOW. First, the command is per-OS: `explorer` does not exist on
 * macOS. Second, and less obvious, a missing binary is NOT throwable — spawn()
 * returns normally and delivers ENOENT as an asynchronous 'error' event, so a
 * try/catch around the call catches nothing and an 'error' event with no listener
 * is an uncaught exception. Hence the explicit listener: this is a nice-to-have
 * after the files are already written, and must never become a crash.
 */
function revealInFolder(dir) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const child = require("child_process").spawn(cmd, [dir], { detached: true, windowsHide: true });
    child.on("error", () => {
      /* files are written; auto-opening the folder is optional */
    });
    child.unref();
  } catch (e) {
    /* ignore — see above */
  }
}

/**
 * Installed Premiere Pro program roots (any version), Windows + macOS.
 *
 * The macOS branch is fiddly and was wrong once before, silently: Adobe's standard
 * layout is a VERSION FOLDER containing the bundle —
 * `/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app` — so joining
 * "Contents" straight onto the folder yields a path that cannot exist. Every Mac
 * then found no 9:16 sequence preset and editors silently got reels at the
 * project's raster (16:9) instead of 1080x1920. Both layouts are handled here, and
 * `~/Applications` is checked as well as `/Applications`.
 */
function adobeRoots() {
  const out = [];
  const push = (p) => {
    try {
      if (p && out.indexOf(p) === -1 && fs.existsSync(p)) out.push(p);
    } catch (e) {
      /* ignore */
    }
  };
  const readdir = (p) => {
    try {
      return fs.existsSync(p) ? fs.readdirSync(p) : [];
    } catch (e) {
      return [];
    }
  };

  if (process.platform === "darwin") {
    for (const base of ["/Applications", path.posix.join(require("os").homedir(), "Applications")]) {
      for (const entry of readdir(base)) {
        if (!/Premiere Pro/i.test(entry)) continue;
        const full = path.posix.join(base, entry);
        if (/\.app$/i.test(entry)) {
          push(path.posix.join(full, "Contents")); // the bundle sits directly in /Applications
          continue;
        }
        // A version folder holding the bundle: prefer the same-named .app, then
        // any Premiere .app inside it, then resources beside the bundle.
        push(path.posix.join(full, entry + ".app", "Contents"));
        for (const inner of readdir(full)) {
          if (/Premiere Pro.*\.app$/i.test(inner)) push(path.posix.join(full, inner, "Contents"));
        }
        push(path.posix.join(full, "Contents"));
      }
    }
    return out;
  }

  for (const base of ["C:\\Program Files\\Adobe", "C:\\Program Files (x86)\\Adobe"]) {
    for (const entry of readdir(base)) {
      if (/Premiere Pro/i.test(entry)) push(path.win32.join(base, entry));
    }
  }
  return out;
}

/** Find a 9:16 sequence preset: bundled first, else Premiere's built-in Social one. */
function findVerticalPreset() {
  const bundled = path.join(EXT_ROOT, "presets", "ISTV_Vertical_1080x1920.sqpreset");
  if (fs.existsSync(bundled)) return bundled;
  for (const root of adobeRoots()) {
    const dir = path.join(root, "Settings", "SequencePresets", "Social");
    try {
      if (!fs.existsSync(dir)) continue;
      const f = fs.readdirSync(dir).find((n) => /9x16/i.test(n) && n.toLowerCase().endsWith(".sqpreset"));
      if (f) return path.join(dir, f);
    } catch (e) {
      /* ignore */
    }
  }
  return "";
}

/** Find a caption MOGRT — LEGACY only. The default caption path is now the
 *  FCP XML importer (js/premiereXml.js, jsx/captions.jsx applyGraphicsXml),
 *  which needs no MOGRT file at all. This stays only so captions.jsx's old
 *  applyKaraoke (importMGT) remains reachable if ever needed by hand. */
function findCaptionMogrt() {
  const bundled = path.join(EXT_ROOT, "presets", "captions.mogrt");
  if (fs.existsSync(bundled)) return bundled;
  for (const root of adobeRoots()) {
    const dir = path.join(root, "Essential Graphics", "Captions and Subtitles");
    try {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".mogrt"));
      const pick =
        files.find((n) => /simple web/i.test(n)) ||
        files.find((n) => /web caption/i.test(n)) ||
        files.find((n) => /caption/i.test(n)) ||
        files[0];
      if (pick) return path.join(dir, pick);
    } catch (e) {
      /* ignore */
    }
  }
  return "";
}

const VERTICAL_PRESET = findVerticalPreset();
const CAPTION_MOGRT = findCaptionMogrt();

// Cache the last selected reels so reopening the panel can restore them and the
// editor can re-build in Premiere WITHOUT re-transcribing (saves time + API cost).
const os = require("os");
const crypto = require("crypto");
const CACHE_FILE = path.join(os.tmpdir(), "istv-reel-tool-last.json");
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ source: state.source, reels: state.reels }), "utf8");
  } catch (e) {
    /* non-fatal */
  }
}
function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (e) {
    return null;
  }
}

// ── Transcript cache (skip Rev.ai when the same source is re-run) ──────────────
// The Rev.ai transcript is the slow/paid step. We key a saved copy by a
// fingerprint of the SOURCE FILE (path + size + mtime), so re-running the exact
// same clip loads the transcript from disk and jumps straight to reel selection.
// Change the file (re-edit/re-export) and the fingerprint changes → it re-runs.
// Persisted under the user's home dir so it survives temp-dir cleanup and reboots.
const TRANSCRIPT_DIR = path.join(os.homedir(), ".istv-reel-tool", "transcripts");
const PROXY_DIR = path.join(os.homedir(), ".istv-reel-tool", "proxies");
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    /* non-fatal */
  }
}
function sourceFingerprint(srcPath) {
  try {
    const st = fs.statSync(srcPath);
    return crypto
      .createHash("sha1")
      .update(String(srcPath) + "|" + st.size + "|" + Math.round(st.mtimeMs))
      .digest("hex")
      .slice(0, 16);
  } catch (e) {
    return crypto.createHash("sha1").update(String(srcPath || "unknown")).digest("hex").slice(0, 16);
  }
}
function transcriptCachePath(fp) {
  return path.join(TRANSCRIPT_DIR, fp + ".json");
}
function loadTranscriptCache(fp) {
  try {
    const t = JSON.parse(fs.readFileSync(transcriptCachePath(fp), "utf8"));
    return t && Array.isArray(t.words) && t.words.length ? t : null;
  } catch (e) {
    return null;
  }
}
function saveTranscriptCache(fp, transcript) {
  try {
    ensureDir(TRANSCRIPT_DIR);
    fs.writeFileSync(transcriptCachePath(fp), JSON.stringify(transcript), "utf8");
    return true;
  } catch (e) {
    return false;
  }
}

// ── panel state ────────────────────────────────────────────────────────────────
const state = {
  source: null, // { name, path, meta:{fps,width,height,durationSec} }
  analysis: null, // backend /select result
  reels: [], // normalized reels for display + build
  transcript: null, // last Rev.ai transcript (for the viewer + cache reuse)
  sourceFingerprint: null, // fingerprint of the current source (transcript cache key)
  trueFps: null, // Premiere's own footage-interpretation fps (see resolveTrueFps) — reset when source changes
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  hostBadge: $("hostBadge"),
  sourceLine: $("sourceLine"),
  detectBtn: $("detectBtn"),
  viewTranscriptBtn: $("viewTranscriptBtn"),
  smoothBtn: $("smoothBtn"),
  speaker: $("speaker"),
  numReels: $("numReels"),
  forceTranscribe: $("forceTranscribe"),
  generateBtn: $("generateBtn"),
  transcriptModal: $("transcriptModal"),
  transcriptBody: $("transcriptBody"),
  pipeline: $("pipeline"),
  steps: $("steps"),
  pipeMsg: $("pipeMsg"),
  reelsCard: $("reelsCard"),
  reelCount: $("reelCount"),
  reels: $("reels"),
  buildAllBtn: $("buildAllBtn"),
  reelsDetailToggle: $("reelsDetailToggle"),
  reelsDetail: $("reelsDetail"),
  sourceDetailToggle: $("sourceDetailToggle"),
  sourceDetail: $("sourceDetail"),
  toast: $("toast"),
  stepBackBtn: $("stepBackBtn"),
  stepNextBtn: $("stepNextBtn"),
  authCard: $("authCard"),
  authMsg: $("authMsg"),
  authToken: $("authToken"),
  authSaveBtn: $("authSaveBtn"),
  authHideBtn: $("authHideBtn"),
  authWhere: $("authWhere"),
};

// ── wizard step navigation ───────────────────────────────────────────────────
// Three steps: 1 Source+Generate, 2 Working (pipeline progress), 3 Reels+Build.
// `maxUnlockedStep` tracks how far the user has actually progressed so Back/
// Next/dots never jump ahead of content that doesn't exist yet.
let currentStep = 1;
let maxUnlockedStep = 1;

function goToStep(n) {
  currentStep = Math.max(1, Math.min(maxUnlockedStep, n));
  updateWizardUI();
}

function updateWizardUI() {
  document.querySelectorAll(".step").forEach((el) => {
    el.classList.toggle("hidden", Number(el.dataset.step) !== currentStep);
  });
  document.querySelectorAll(".wdot").forEach((el) => {
    const n = Number(el.dataset.step);
    el.classList.toggle("active", n === currentStep);
    el.classList.toggle("done", n !== currentStep && n <= maxUnlockedStep);
    el.classList.toggle("locked", n > maxUnlockedStep);
  });
  if (els.stepBackBtn) els.stepBackBtn.disabled = currentStep <= 1;
  if (els.stepNextBtn) els.stepNextBtn.disabled = currentStep >= maxUnlockedStep;
}

// ── caption editor panel (§4) ────────────────────────────────────────────────
const captionPanel = createCaptionPanel({ toast, onChange: saveCache, importSrtForReel, rebuildCaptionBlocks, pullCaptionsFromPremiere });

// ── host bridge ────────────────────────────────────────────────────────────────

/** Run an ExtendScript expression; resolve with the parsed {ok,data|error}. */
function host(expr) {
  return new Promise((resolve) => {
    cs.evalScript(expr, (raw) => {
      if (raw === "EvalScript error." || /EvalScript error/.test(raw)) {
        resolve({ ok: false, error: "ExtendScript error running: " + expr });
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        resolve({ ok: false, error: "Bad host response: " + String(raw).slice(0, 200) });
      }
    });
  });
}

/** Call ISTV.<fn>(jsonArg) safely — jsonArg is embedded as a JS string literal. */
function hostCall(fn, arg) {
  const expr = arg === undefined ? `ISTV.${fn}()` : `ISTV.${fn}(${JSON.stringify(JSON.stringify(arg))})`;
  return host(expr);
}

/**
 * Load the ExtendScript host explicitly (json2 → captions → host, in order) via
 * $.evalFile with absolute paths. This is more reliable than the manifest
 * ScriptPath + //@include, which doesn't consistently process includes — without
 * json2.js the host's JSON.stringify is undefined and every ISTV call throws.
 * Resolves "ok" when both JSON and ISTV are defined afterward.
 */
function loadHost() {
  const jsxDir = path.join(EXT_ROOT, "jsx").replace(/\\/g, "/");
  const files = ["json2.js", "captions.jsx", "host.jsx"];
  // Load each file in its own try/catch so a parse/runtime failure names the file.
  const parts = files
    .map((f) => `try{ $.evalFile("${jsxDir}/${f}"); }catch(e){ return "err in ${f}: "+e.toString(); }`)
    .join(" ");
  const check =
    '(typeof ISTV!=="undefined" && typeof ISTV_Captions!=="undefined" && typeof JSON!=="undefined") ? "ok" ' +
    ': ("missing ISTV="+(typeof ISTV)+" caps="+(typeof ISTV_Captions)+" JSON="+(typeof JSON))';
  const expr = `(function(){ ${parts} return ${check}; })()`;
  return new Promise((resolve) => cs.evalScript(expr, (r) => resolve(r)));
}

// ── pipeline UI ─────────────────────────────────────────────────────────────────
const STEPS = [
  { key: "source", label: "Detect source" },
  { key: "extract", label: "Extract audio" },
  { key: "upload", label: "Upload audio" },
  { key: "transcribe", label: "Transcribe" },
  { key: "select", label: "Select reels" },
];

function renderSteps() {
  els.steps.innerHTML = "";
  STEPS.forEach((s) => {
    const li = document.createElement("li");
    li.id = "step-" + s.key;
    li.innerHTML = `<span class="dot">○</span><span class="lbl">${s.label}</span><span class="pct"></span>`;
    els.steps.appendChild(li);
  });
}
// Status is conveyed by icon + weight, not color (no accent hue in this UI —
// see css/styles.css), so each state needs a visibly distinct glyph.
const STEP_DOT_ICON = { "": "○", active: "●", done: "✓", err: "✕" };
function stepState(key, cls, pct) {
  const li = $("step-" + key);
  if (!li) return;
  li.classList.remove("active", "done", "err");
  if (cls) li.classList.add(cls);
  const dot = li.querySelector(".dot");
  if (dot) dot.textContent = STEP_DOT_ICON[cls || ""] || STEP_DOT_ICON[""];
  const p = li.querySelector(".pct");
  if (p) p.textContent = pct != null ? Math.round(pct * 100) + "%" : "";
}
function pipeMsg(msg) {
  els.pipeMsg.textContent = msg || "";
}
function toast(msg, kind) {
  els.toast.textContent = msg;
  els.toast.className = "toast " + (kind || "");
  els.toast.classList.remove("hidden");
}

// ── backend reachability + access token ──────────────────────────────────────

/** Reveal the token prompt with an explanation of why it appeared. */
function showAuthCard(message) {
  if (!els.authCard) return;
  const cfg = config.current();
  els.authMsg.textContent = message;
  els.authToken.value = "";
  els.authWhere.textContent = cfg.hasToken
    ? `Current token comes from ${cfg.tokenSource}. Saved tokens live in ${config.USER_CONFIG_PATH}.`
    : `Saved to ${config.USER_CONFIG_PATH} — outside the extension folder, so it survives reinstalls.`;
  els.authCard.classList.remove("hidden");
}

function hideAuthCard() {
  if (els.authCard) els.authCard.classList.add("hidden");
}

/**
 * Startup check, in the order the editor cares about: is the server there, is our
 * token accepted, are the server's own API keys configured. The token probe runs
 * only when the backend is reachable — a connection error is its own problem and
 * prompting for a token would be misleading.
 */
async function checkBackend() {
  const url = backend.BACKEND_URL;
  let h;
  try {
    h = await backend.health();
  } catch (e) {
    const local = config.current().isLocalBackend;
    toast(
      local
        ? `Backend not reachable at ${url} — start it locally before generating.`
        : `Backend not reachable at ${url}. Check your connection, or that the service is awake.`,
      "err"
    );
    return;
  }

  // /health is unauthenticated by design, so reaching it proves nothing about the
  // token. Probe separately — and only when the server says it requires one.
  if (h.auth_required !== false) {
    try {
      const v = await backend.verifyToken();
      if (!v.ok) {
        showAuthCard(v.reason);
        toast("Backend needs an access token before you can generate.", "err");
        return;
      }
      hideAuthCard();
    } catch (e) {
      // Reachable for /health but not for the probe — report, don't block.
      toast("Could not verify the access token: " + e.message, "warn");
    }
  }

  if (!h.revai_key || !h.claude_key) {
    toast("Backend is up but missing API keys. Set them server-side.", "warn");
  }
}

/** Save the entered token for this machine, then re-run the whole check. */
async function saveAndVerifyToken() {
  const token = (els.authToken.value || "").trim();
  if (!token) {
    els.authMsg.textContent = "Paste the token first.";
    return;
  }
  const saved = config.saveUserToken(token);
  if (!saved.ok) {
    els.authMsg.textContent = "Could not save the token: " + saved.error;
    return;
  }
  els.authMsg.textContent = "Saved. Verifying…";
  try {
    const v = await backend.verifyToken();
    if (v.ok) {
      hideAuthCard();
      toast("Access token accepted.", "ok");
      checkBackend();
    } else {
      els.authMsg.textContent = v.reason;
    }
  } catch (e) {
    els.authMsg.textContent = "Backend not reachable: " + e.message;
  }
}

// ── init ─────────────────────────────────────────────────────────────────────
async function init() {
  renderSteps();
  els.detectBtn.addEventListener("click", detectSource);
  els.generateBtn.addEventListener("click", generate);
  els.buildAllBtn.addEventListener("click", () => buildReels(state.reels));
  if (els.sourceDetailToggle) {
    els.sourceDetailToggle.addEventListener("click", () => {
      const showing = els.sourceDetail.classList.toggle("hidden") === false;
      els.sourceDetailToggle.textContent = showing ? "Show less" : "Show more";
    });
  }
  if (els.reelsDetailToggle) {
    els.reelsDetailToggle.addEventListener("click", () => {
      const showing = els.reelsDetail.classList.toggle("hidden") === false;
      els.reelsDetailToggle.textContent = showing ? "Hide reel details" : "Show reel details";
    });
  }
  const srtAllBtn = document.getElementById("srtAllBtn");
  if (srtAllBtn) srtAllBtn.addEventListener("click", () => saveSrts(state.reels));
  if (els.viewTranscriptBtn) els.viewTranscriptBtn.addEventListener("click", openTranscriptModal);
  if (els.smoothBtn) els.smoothBtn.addEventListener("click", makeProxy);
  const closeT = document.getElementById("closeTranscriptBtn");
  if (closeT) closeT.addEventListener("click", closeTranscriptModal);
  const saveTxt = document.getElementById("saveTxtBtn");
  if (saveTxt) saveTxt.addEventListener("click", saveTranscriptTxt);
  if (els.transcriptModal) {
    // Click the dark backdrop (outside the box) to dismiss.
    els.transcriptModal.addEventListener("click", (e) => {
      if (e.target === els.transcriptModal) closeTranscriptModal();
    });
  }
  if (els.stepBackBtn) els.stepBackBtn.addEventListener("click", () => goToStep(currentStep - 1));
  if (els.stepNextBtn) els.stepNextBtn.addEventListener("click", () => goToStep(currentStep + 1));
  if (els.authSaveBtn) els.authSaveBtn.addEventListener("click", saveAndVerifyToken);
  if (els.authHideBtn) els.authHideBtn.addEventListener("click", hideAuthCard);
  if (els.authToken) {
    els.authToken.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveAndVerifyToken();
    });
  }
  document.querySelectorAll(".wdot").forEach((el) => {
    el.addEventListener("click", () => {
      const n = Number(el.dataset.step);
      if (n <= maxUnlockedStep) goToStep(n);
    });
  });
  updateWizardUI();

  // Load the ExtendScript host explicitly (see loadHost) before anything calls it.
  const loaded = await loadHost();
  if (loaded !== "ok") {
    els.hostBadge.textContent = "Host load failed";
    els.hostBadge.classList.add("err");
    els.sourceLine.textContent = "Could not load the Premiere host script: " + loaded;
    toast("Host script failed to load: " + loaded, "err");
    return;
  }

  // Host + backend health.
  const ping = await host("ISTV.ping()");
  if (ping.ok) {
    els.hostBadge.textContent = "Premiere " + (ping.data.version || "").split(" ")[0];
    els.hostBadge.classList.add("ok");
  } else {
    els.hostBadge.textContent = "Host error";
    els.hostBadge.classList.add("err");
  }
  checkBackend();

  // Confirm the auto-detected sequence preset (helps diagnose framing issues).
  // Captions need no template file anymore — see buildXmlForReel.
  console.log("[ISTV] vertical preset:", VERTICAL_PRESET || "(none)");

  await detectSource();

  // Restore last run's reels so the editor can rebuild without re-transcribing.
  const cached = loadCache();
  if (cached && Array.isArray(cached.reels) && cached.reels.length) {
    // A fresh Premiere session has none of last run's sequences, so clear the
    // built flags — Build will recreate them on demand.
    state.reels = cached.reels.map((r) => ({ ...r, built: false, sequenceName: "" }));
    if (!state.source && cached.source) state.source = cached.source;
    renderReels();
    maxUnlockedStep = 3;
    goToStep(3);
    toast(`Restored ${state.reels.length} reels from your last run. Click Build reels, or Generate to refresh.`, "ok");
  }
}

async function detectSource() {
  state.trueFps = null; // a new/different source may have a different real fps — never reuse a stale one
  els.sourceLine.textContent = "Detecting active sequence…";
  const res = await hostCall("getActiveSource");
  if (!res.ok) {
    els.sourceLine.textContent = res.error;
    els.generateBtn.disabled = true;
    return;
  }
  els.sourceLine.textContent = "Probing " + res.data.name + "…";
  try {
    const meta = await ffmpeg.probe(res.data.path);
    state.source = { ...res.data, meta };
    els.sourceLine.innerHTML =
      `<b>${res.data.name}</b> · ${meta.width}×${meta.height} · ${meta.fps}fps · ${fmtDur(meta.durationSec)}` +
      `<br/><span class="small">${res.data.path}</span>`;
    els.generateBtn.disabled = false;
    refreshTranscriptAvailability();
  } catch (e) {
    state.source = { ...res.data, meta: { fps: 30, width: 1920, height: 1080, durationSec: 0 } };
    els.sourceLine.innerHTML = `<b>${res.data.name}</b> <span class="small">(probe failed: ${e.message})</span>`;
    els.generateBtn.disabled = false;
    refreshTranscriptAvailability();
  }
}

/** If a saved transcript exists for the current source, load it and reveal the
 *  "View transcript" button — so you can read it (and skip Rev.ai) without
 *  regenerating. Called whenever the source is (re)detected. */
function refreshTranscriptAvailability() {
  if (!state.source || !state.source.path) {
    showTranscriptButton(false);
    return;
  }
  const fp = sourceFingerprint(state.source.path);
  state.sourceFingerprint = fp;
  const cached = loadTranscriptCache(fp);
  if (cached) {
    state.transcript = cached;
    showTranscriptButton(true);
  } else if (!state.transcript) {
    showTranscriptButton(false);
  }
}

function showTranscriptButton(show) {
  if (!els.viewTranscriptBtn) return;
  els.viewTranscriptBtn.classList.toggle("hidden", !show);
}

// ── generate: audio → transcribe → select ──────────────────────────────────────
async function generate() {
  if (!state.source) return;
  els.generateBtn.disabled = true;
  maxUnlockedStep = Math.max(maxUnlockedStep, 2);
  goToStep(2);
  STEPS.forEach((s) => stepState(s.key, ""));
  els.toast.classList.add("hidden");

  try {
    stepState("source", "done");

    // Fingerprint the source so the transcript can be cached/reused (path+size+mtime).
    const fp = sourceFingerprint(state.source.path);
    state.sourceFingerprint = fp;
    const forceRetranscribe = !!(els.forceTranscribe && els.forceTranscribe.checked);
    const cachedTranscript = forceRetranscribe ? null : loadTranscriptCache(fp);

    let transcript;
    if (cachedTranscript) {
      // Same file as a previous run → reuse the saved Rev.ai transcript and skip
      // extract/upload/transcribe entirely (no Rev.ai cost, no wait).
      transcript = cachedTranscript;
      stepState("extract", "done");
      stepState("upload", "done");
      stepState("transcribe", "done");
      const wc = cachedTranscript.word_count || (cachedTranscript.words || []).length;
      pipeMsg(`Loaded saved transcript (${wc} words) — skipped re-transcribing. Tick "Re-transcribe" to force a fresh run.`);
    } else {
      // 1) Extract compressed audio from the master.
      stepState("extract", "active");
      pipeMsg("Extracting mono 16 kHz MP3 (only audio ever leaves the machine)…");
      const audio = await ffmpeg.extractCompressedAudio(state.source.path, {
        onProgress: (p) => stepState("extract", "active", p),
      });
      stepState("extract", "done");

      // 2) Upload + transcribe.
      stepState("upload", "active");
      const { job_id } = await backend.uploadAudio(audio.path, {
        onProgress: (p) => stepState("upload", "active", p),
      });
      stepState("upload", "done");
      stepState("transcribe", "active");
      const tScript = await backend.pollJob(job_id, {
        onStatus: (s) => {
          pipeMsg(s.message || "Transcribing…");
          if (s.elapsed) stepState("transcribe", "active");
        },
      });
      transcript = tScript.transcript;
      stepState("transcribe", "done");
      try {
        fs.unlinkSync(audio.path);
      } catch (e) {}

      // Save the transcript so a re-run of this exact file skips Rev.ai next time.
      if (saveTranscriptCache(fp, transcript)) {
        pipeMsg("Transcript saved — re-runs of this file will skip transcription.");
      }
    }

    // Keep the transcript for the viewer + enable the "View transcript" button.
    state.transcript = transcript;
    showTranscriptButton(true);

    // 3) Claude reel selection.
    stepState("select", "active");
    pipeMsg("Selecting reels…");
    const name = els.speaker.value.trim();
    const num = Math.max(1, Math.min(20, parseInt(els.numReels.value, 10) || 10));
    const analysis = await backend.selectReels(transcript, name, num, {
      onStatus: (s) => pipeMsg(s.message || "Selecting…"),
    });
    stepState("select", "done");

    state.analysis = analysis;
    state.reels = normalizeReels(analysis);
    renderReels();
    saveCache();
    maxUnlockedStep = 3;
    goToStep(3);
    pipeMsg(`${state.reels.length} reels selected. Review, then build in Premiere.`);
    toast("Reels ready. Click Build the Reels.", "ok");
  } catch (e) {
    const active = els.steps.querySelector(".active");
    if (active) active.classList.replace("active", "err");
    pipeMsg("");
    // A token that was valid at startup can be rotated or revoked mid-run. The
    // backend errors carry the status code in their message (see backend.js), so
    // surface the token prompt instead of a bare "Failed: Backend 401".
    if (/\b40[13]\b/.test(e.message)) {
      showAuthCard("The backend rejected the access token mid-run. It may have been rotated.");
      toast("Access token rejected — enter a current one.", "err");
    } else {
      toast("Failed: " + e.message, "err");
    }
  } finally {
    els.generateBtn.disabled = false;
  }
}

// ── normalize analysis reels for display + build ────────────────────────────────
function normalizeReels(analysis) {
  const reels = Array.isArray(analysis && analysis.reels) ? analysis.reels : [];
  return reels.map((r, i) => {
    const sheet = Array.isArray(r.editor_cut_sheet) ? r.editor_cut_sheet : [];
    let segments = sheet
      .map((row) => ({
        startSec: num(row.start_time_seconds),
        endSec: num(row.end_time_seconds),
        role: String(row.role || "BODY").toUpperCase(),
      }))
      .filter((s) => s.endSec > s.startSec)
      .sort((a, b) => a.startSec - b.startSec);
    if (!segments.length) {
      const a = num(r.start_time_seconds);
      segments = [{ startSec: a, endSec: num(r.end_time_seconds, a + 30), role: "HOOK" }];
    }
    const durationSec = segments.reduce((t, s) => t + (s.endSec - s.startSec), 0);

    // The JSON caption master (§2) — the editable source of truth. Built from
    // the same word timeline as captionBlocks, but grouped at sentence/pause/
    // size boundaries rather than a fixed word-chunk size, since this is what
    // an editor reviews and edits, not what gets "popped" one MOGRT at a time.
    const doc = captionDoc.docFromReel(r, segments, {
      sequenceName: "",
      fps: (state.source && state.source.meta && state.source.meta.fps) || 0,
      templateId: captionTemplates.DEFAULT_TEMPLATE_ID,
    });

    // Karaoke-style MOGRT pop blocks are generated from the doc, chunk size
    // is template-driven (§5/§7b) — see buildCaptionBlocksForTemplate.
    const captionBlocks = buildCaptionBlocksForTemplate(doc, doc.templateId);

    return {
      id: num(r.id, i + 1),
      index: i + 1,
      rank: num(r.rank, i + 1),
      title: String(r.title || `Reel ${i + 1}`),
      caption: String(r.caption || ""),
      hashtags: Array.isArray(r.hashtags) ? r.hashtags : [],
      whyItWorks: String(r.why_it_works || r.theme || ""),
      spokenHook: String(r.spoken_hook || ""),
      segments,
      durationSec: Math.round(durationSec * 10) / 10,
      captionBlocks,
      captionDoc: doc,
      captionValidation: captionDoc.validateDoc(doc),
      _raw: r, // keep the analysis reel so the caption panel's Regenerate can rebuild the doc from scratch
      sequenceName: "", // set once built in Premiere
      built: false,
    };
  });
}

// ── caption document ingest (§3) ────────────────────────────────────────────

/** Import an .srt file from disk as a reel's caption master (line-level — SRT
 *  carries no word timing, so karaoke is unavailable for imported cues until
 *  re-aligned). Replaces the reel's existing captionDoc wholesale. */
function importSrtForReel(reel, filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const doc = captionDoc.srtToDoc(text, {
      sequenceName: reel.sequenceName || "",
      fps: (state.source && state.source.meta && state.source.meta.fps) || 0,
      templateId: (reel.captionDoc && reel.captionDoc.templateId) || captionTemplates.DEFAULT_TEMPLATE_ID,
    });
    reel.captionDoc = doc;
    reel.captionValidation = captionDoc.validateDoc(doc);
    rebuildCaptionBlocks(reel); // imported cues have no word timing — karaoke blocks become empty for them
    return { ok: true, doc };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Best-effort pull-back of an existing caption track (§7c). Expected to
 *  resolve with ok:false and an honest "unsupported" reason on most Premiere
 *  builds — see jsx/captions.jsx pullCaptionTrack for why. */
async function pullCaptionsFromPremiere() {
  const res = await hostCall("pullCaptions");
  if (!res.ok) return { ok: false, warning: res.error || "Pull-back failed." };
  return res.data; // { ok:false, warning } in the expected case
}

function renderReels() {
  els.reelsCard.classList.remove("hidden");
  els.reelCount.textContent = state.reels.length;
  els.reels.innerHTML = "";
  state.reels.forEach((reel, i) => {
    const div = document.createElement("div");
    div.className = "reel" + (reel.built ? " built" : "");
    div.id = "reel-" + i;
    div.innerHTML = `
      <div class="head">
        <span class="rank">#${reel.rank}</span>
        <span class="title">${escapeHtml(reel.title)}</span>
        <span class="dur">${reel.durationSec}s</span>
      </div>
      ${reel.caption ? `<div class="cap">${escapeHtml(reel.caption)}</div>` : ""}
      ${reel.hashtags.length ? `<div class="tags">${escapeHtml(reel.hashtags.join(" "))}</div>` : ""}
      ${reel.whyItWorks ? `<div class="why">${escapeHtml(reel.whyItWorks)}</div>` : ""}
      <div class="actions">
        <button class="btn small primary build" title="Create this reel's 9:16 sequence with captions already placed on it">🎬 Build</button>
        <button class="btn small ghost caps" title="Review and edit this reel's captions before building">✏️ Captions</button>
        <button class="btn small ghost srt" title="Save this reel's .srt caption file">📝 SRT</button>
        <span class="status"></span>
      </div>`;
    div.querySelector(".build").addEventListener("click", () => buildReels([reel]));
    div.querySelector(".caps").addEventListener("click", () => captionPanel.open(reel));
    div.querySelector(".srt").addEventListener("click", () => saveSrts([reel]));
    els.reels.appendChild(div);
  });
}

// ── build reels inside Premiere ─────────────────────────────────────────────────
async function buildReels(reels) {
  if (!reels.length || !state.source) return;
  els.buildAllBtn.disabled = true;
  reels.forEach((r) => setReelStatus(r, "Building…", ""));

  // Resolve BEFORE building any caption XML — host.jsx sets the reel
  // sequence to this exact rate too (see getSourceFrameRate/sourceFrameRate),
  // so the caption sequence's baked-in frame numbers and the reel's actual
  // playback rate can never mismatch and drift apart over the reel's length.
  const trueFps = await resolveTrueFps();

  const meta = state.source.meta || {};
  const payload = {
    sourcePath: state.source.path,
    canvas: DEFAULT_CANVAS,
    fps: trueFps || (meta.fps && meta.fps > 0 ? meta.fps : 0), // match the reel sequence to the source fps
    presetPath: VERTICAL_PRESET,
    mogrtPath: CAPTION_MOGRT || "", // legacy fallback only — see findCaptionMogrt
    // Captions are placed directly on the sequence as part of the build — no
    // separate "Apply subtitles" step. Karaoke-style pop captions (phrase-by-
    // phrase text — not an in-line word-highlight sweep, which Premiere's
    // scripting API can't do, see jsx/captions.jsx) via FCP XML import
    // (js/premiereXml.js) — no MOGRT file needed, works out of the box.
    captionMode: "karaoke",
    binName: "ISTV Reels",
    reels: reels.map((r) => ({
      id: r.id,
      index: r.index,
      title: r.title,
      segments: r.segments,
      reframe: { cropX: 0.5, cropY: 0.5, zoom: 1, srcW: meta.width || 1920, srcH: meta.height || 1080 },
      captionBlocks: r.captionBlocks,
      // Both pre-rendered from the JSON caption master (§2/§6) so Premiere
      // gets exactly what the editor reviewed/edited in the Captions panel,
      // not a re-derivation in ExtendScript. xmlText is the primary path
      // (applyGraphicsXml); srtText is the legacy native-caption-bin fallback.
      srtText: reelToSrt(r),
      xmlText: buildXmlForReel(r, trueFps),
      metadata: {
        title: r.title,
        caption: r.caption,
        hashtags: r.hashtags,
        whyItWorks: r.whyItWorks,
        spokenHook: r.spokenHook,
      },
    })),
  };

  const res = await hostCall("buildReels", payload);
  els.buildAllBtn.disabled = false;

  // Write the full build result (incl. per-reel caption diagnostics) to a temp
  // file for troubleshooting — safe to remove later.
  try {
    fs.writeFileSync(path.join(os.tmpdir(), "istv-reel-tool-lastbuild.json"), JSON.stringify(res, null, 2), "utf8");
  } catch (e) {
    /* non-fatal */
  }

  if (!res.ok) {
    reels.forEach((r) => setReelStatus(r, "Failed", "err"));
    toast("Build failed: " + res.error + (res.detail ? " — " + res.detail : ""), "err");
    return;
  }
  (res.data.built || []).forEach((b, i) => {
    const reel = reels[i];
    if (!reel) return;
    reel.built = !!b.ok;
    if (b.sequenceName) reel.sequenceName = b.sequenceName;
    const status = b.ok ? `✓ Built ${b.sequenceName}` : "Failed: " + (b.error || "unknown");
    setReelStatus(reel, status, b.ok ? "ok" : "err");
    const card = document.getElementById("reel-" + state.reels.indexOf(reel));
    if (card && b.ok) card.classList.add("built");
  });
  const okReels = (res.data.built || []).filter((b) => b && b.ok).length;
  const warns = res.data.warnings || [];
  const captionNote = "Karaoke-style pop captions are placed on the sequence (phrase-by-phrase, not a word-highlight sweep).";
  toast(`Built ${okReels} reel sequence(s). ${captionNote}` + (warns[0] ? " " + warns[0] : ""), "ok");
}

function setReelStatus(reel, text, cls) {
  const idx = state.reels.indexOf(reel);
  const card = document.getElementById("reel-" + idx);
  if (!card) return;
  const st = card.querySelector(".status");
  st.textContent = text;
  st.className = "status " + (cls || "");
}

// ── smooth playback: build + attach a proxy so 4K plays without stutter ─────────
async function makeProxy() {
  if (!state.source || !state.source.path) {
    toast("Detect a source clip first.", "warn");
    return;
  }
  els.smoothBtn.disabled = true;
  toast("Preparing smooth-playback proxy…", "");
  try {
    ensureDir(PROXY_DIR);
    const fp = sourceFingerprint(state.source.path);
    const proxyPath = path.join(PROXY_DIR, fp + ".mp4");
    if (!fs.existsSync(proxyPath) || fs.statSync(proxyPath).size < 1024) {
      await ffmpeg.renderProxy(state.source.path, proxyPath, {
        onProgress: (p) => toast(`Building smooth-playback proxy… ${Math.round(p * 100)}% (one-time)`, ""),
      });
    }
    const res = await hostCall("attachProxy", { sourcePath: state.source.path, proxyPath });
    if (res && res.ok) {
      if (res.data && res.data.autoEnabled) {
        toast("✓ Proxy attached & enabled — 4K should play smoothly now. Exports still use full 4K.", "ok");
      } else {
        toast("✓ Proxy attached. If it's not smooth yet, click 'Toggle Proxies' in the Program monitor (add it via the + button editor). Exports still use full 4K.", "ok");
      }
    } else {
      toast("Proxy attach failed: " + ((res && res.error) || "unknown"), "err");
    }
  } catch (e) {
    toast("Proxy failed: " + e.message, "err");
  } finally {
    els.smoothBtn.disabled = false;
  }
}

// ── SRT export (§6 — spec-clean, generated from the JSON caption master) ────────

/** Export a reel's caption master as .srt, line-wrapped by its active template.
 *  This is the single SRT code path — also the payload source for the native
 *  caption-track push (see buildReels below). */
function reelToSrt(reel) {
  const doc = reel && reel.captionDoc;
  if (!doc || !Array.isArray(doc.cues) || !doc.cues.length) return "";
  const template = captionTemplates.getTemplate(doc.templateId);
  return captionDoc.docToSrt(doc, template);
}

/** Write .srt files for the given reels and open the folder so you can drag them in. */
function saveSrts(reels) {
  if (!reels || !reels.length) return;
  const baseDir = path.join(
    path.dirname((state.source && state.source.path) || os.tmpdir()),
    "ISTV_Captions"
  );
  let written = 0;
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    reels.forEach((r) => {
      const srt = reelToSrt(r);
      if (!srt.trim()) return;
      const safe = String(r.title || "reel").replace(/[\\/:*?"<>|]/g, "").slice(0, 40).trim() || "reel";
      const name = `Reel_${String(r.index).padStart(2, "0")}_${safe}.srt`;
      fs.writeFileSync(path.join(baseDir, name), srt, "utf8");
      written++;
    });
  } catch (e) {
    toast("Could not write SRT files: " + e.message, "err");
    return;
  }
  revealInFolder(baseDir);
  toast(
    `Saved ${written} SRT file(s) to ${baseDir}. In Premiere: File ▸ Import the .srt (or drag it), then drop it on the reel's timeline — it becomes an editable caption track.`,
    "ok"
  );
}

// ── transcript & subtitles viewer ──────────────────────────────────────────────
function fmtClock(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

/** Turn the Rev.ai word list into readable text, grouped into speaker turns. */
function transcriptToText(t) {
  const words = t && Array.isArray(t.words) ? t.words : [];
  if (!words.length) return "(no transcript words available)";
  const lines = [];
  let curSpk = null;
  let startSec = 0;
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const who = curSpk != null ? " · Speaker " + curSpk : "";
    lines.push("[" + fmtClock(startSec) + who + "]  " + buf.join(" "));
    buf = [];
  };
  words.forEach((w) => {
    const spk = w.speaker != null ? w.speaker : 0;
    const ws = num(w.start != null ? w.start : w.time);
    if (curSpk === null) {
      curSpk = spk;
      startSec = ws;
    } else if (spk !== curSpk) {
      flush();
      curSpk = spk;
      startSec = ws;
    }
    const word = String(w.word || "").trim();
    if (word) buf.push(word);
  });
  flush();
  return lines.join("\n\n");
}

function openTranscriptModal() {
  if (!els.transcriptModal || !els.transcriptBody) return;
  const t = state.transcript;
  if (!t) {
    toast("No transcript yet — click Generate first.", "warn");
    return;
  }
  const dur = t.duration ? " · " + fmtClock(t.duration) : "";
  const wc = t.word_count || (t.words || []).length;
  const parts = [];
  parts.push(
    '<div class="tsec"><div class="tsec-h">Transcription' +
      dur +
      " · " +
      wc +
      ' words</div><div class="tbody">' +
      escapeHtml(transcriptToText(t)) +
      "</div></div>"
  );
  if (state.reels && state.reels.length) {
    const subs = state.reels
      .map((r) => {
        const srt = (reelToSrt(r) || "").trim();
        return (
          '<div class="sub-reel"><div class="sub-h">#' +
          r.rank +
          "  " +
          escapeHtml(r.title) +
          " · " +
          r.durationSec +
          's</div><div class="tbody">' +
          escapeHtml(srt || "(no captions)") +
          "</div></div>"
        );
      })
      .join("");
    parts.push('<div class="tsec"><div class="tsec-h">Subtitles per reel (' + state.reels.length + ")</div>" + subs + "</div>");
  } else {
    parts.push('<div class="tsec"><div class="tsec-h">Subtitles</div><div class="tbody">Generate reels to see per-reel subtitles here.</div></div>');
  }
  els.transcriptBody.innerHTML = parts.join("");
  els.transcriptModal.classList.remove("hidden");
}

function closeTranscriptModal() {
  if (els.transcriptModal) els.transcriptModal.classList.add("hidden");
}

/** Save the full transcription (+ per-reel subtitles) as a .txt next to the source. */
function saveTranscriptTxt() {
  const t = state.transcript;
  if (!t) {
    toast("No transcript to save yet.", "warn");
    return;
  }
  const baseDir = path.join(path.dirname((state.source && state.source.path) || os.tmpdir()), "ISTV_Captions");
  const stem = state.source ? base(state.source.path).replace(/\.[^.]+$/, "") : "transcript";
  const out = ["TRANSCRIPTION", "", transcriptToText(t)];
  if (state.reels && state.reels.length) {
    out.push("", "========================================", "SUBTITLES PER REEL");
    state.reels.forEach((r) => {
      out.push("", "#" + r.rank + "  " + String(r.title || "") + " (" + r.durationSec + "s)", (reelToSrt(r) || "").trim());
    });
  }
  let file;
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    file = path.join(baseDir, stem + "_transcript.txt");
    fs.writeFileSync(file, out.join("\n"), "utf8");
  } catch (e) {
    toast("Could not save transcript: " + e.message, "err");
    return;
  }
  revealInFolder(baseDir);
  toast("Saved transcript to " + file, "ok");
}

// ── utils ────────────────────────────────────────────────────────────────────
function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function base(p) {
  const s = String(p || "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}
function fmtDur(sec) {
  sec = Math.round(sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

window.addEventListener("DOMContentLoaded", init);
