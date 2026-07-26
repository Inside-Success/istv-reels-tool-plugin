"use strict";

/*
 * ISTV Reel Tool — panel controller.
 *
 * Runs in the CEP panel (Node.js enabled) and does three things: wire up the DOM,
 * drive the pipeline, and hand finished reels to the ExtendScript host. All logic
 * worth testing lives in src/core/* — this file is deliberately the thin layer.
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

const path = require("path");
const fs = require("fs");
const os = require("os");

const cs = new CSInterface();
const EXT_ROOT = cs.getSystemPath(SystemPath.EXTENSION);

// CEP does not put the extension on Node's module search path, so core modules are
// required by absolute path. Works identically on Windows and macOS.
const core = (name) => require(path.join(EXT_ROOT, "src", "core", name));
const backend = core("backend.js");
const ffmpeg = core("ffmpeg.js");
const presets = core("presets.js");
const cache = core("cache.js");
const reelModel = core("reels.js");
const platformInfo = core("platform.js");
const config = core("config.js");

// Which templates we found, and what that means for output quality.
const TEMPLATES = presets.discover({ extRoot: EXT_ROOT });

// ── panel state ────────────────────────────────────────────────────────────────
const state = {
  source: null, // { name, path, meta:{fps,width,height,durationSec} }
  analysis: null, // backend /select result
  reels: [], // normalized reels for display + build
  transcript: null, // last Rev.ai transcript (for the viewer + cache reuse)
  sourceFingerprint: null, // fingerprint of the current source (transcript cache key)
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
  toast: $("toast"),
  backendBadge: $("backendBadge"),
  connCard: $("connCard"),
  connStatus: $("connStatus"),
  tokenInput: $("tokenInput"),
  saveTokenBtn: $("saveTokenBtn"),
  showTokenBtn: $("showTokenBtn"),
  closeConnBtn: $("closeConnBtn"),
  tokenPath: $("tokenPath"),
};

// ── connection / access token ──────────────────────────────────────────────────

/**
 * Check the service and the editor's token, and drive the UI from the result.
 *
 * Liveness (/health) and authorisation are separate questions, because /health is
 * intentionally unauthenticated: it answers "is the service up" but succeeds with
 * any token or none. verifyToken() answers "will my requests be accepted", using a
 * probe that costs nothing — see backend.verifyToken.
 *
 * Returns true when the panel is clear to run the pipeline.
 */
async function checkConnection({ quiet = false } = {}) {
  const settings = config.current();
  setBadge("checking", "Service…");

  let live;
  try {
    live = await backend.health();
  } catch (e) {
    setBadge("err", "Service down");
    showConn(
      "Can't reach the ISTV service at " +
        settings.backendUrl +
        (settings.isLocalBackend
          ? " — this build points at a local service. Start it, or ask for a build that points at the hosted one."
          : ". Check your internet connection, or ask your admin whether the service is running."),
      "err"
    );
    return false;
  }

  if (!live.revai_key || !live.claude_key) {
    toast("The service is up but is missing its API keys (Rev.ai/Claude). Contact your admin.", "warn");
  }

  // The service may not require a token at all (a local dev instance).
  if (live.auth_required === false) {
    setBadge("ok", "Connected");
    hideConn();
    return true;
  }

  const verdict = await backend.verifyToken().catch((e) => ({ ok: false, reason: e.message }));
  if (verdict.ok) {
    setBadge("ok", "Connected");
    hideConn();
    if (!quiet) toast("Connected to the ISTV service.", "ok");
    return true;
  }

  setBadge("err", settings.hasToken ? "Token rejected" : "Token needed");
  showConn(verdict.reason || "The service rejected this token.", settings.hasToken ? "err" : "warn");
  return false;
}

function setBadge(kind, text) {
  if (!els.backendBadge) return;
  els.backendBadge.textContent = text;
  els.backendBadge.className = "badge" + (kind === "ok" ? " ok" : kind === "err" ? " err" : "");
}

function showConn(message, kind) {
  if (!els.connCard) return;
  els.connCard.classList.remove("hidden");
  if (els.connStatus) {
    els.connStatus.textContent = message || "";
    els.connStatus.className = kind === "err" ? "err" : kind === "warn" ? "warn" : "muted";
  }
  // Only offer Close once a working token exists — otherwise the panel is unusable
  // and dismissing the one thing that fixes it would just be confusing.
  if (els.closeConnBtn) els.closeConnBtn.classList.toggle("hidden", !config.current().hasToken);
  if (els.tokenPath) els.tokenPath.textContent = config.USER_CONFIG_PATH;
}

function hideConn() {
  if (els.connCard) els.connCard.classList.add("hidden");
}

/** Save the token the editor typed, then immediately re-verify it. */
async function saveToken() {
  const value = (els.tokenInput.value || "").trim();
  if (!value) {
    showConn("Paste the token first.", "warn");
    return;
  }
  els.saveTokenBtn.disabled = true;
  try {
    const saved = config.saveUserToken(value);
    if (!saved.ok) {
      showConn("Could not save the token: " + saved.error, "err");
      return;
    }
    els.tokenInput.value = ""; // don't leave the secret sitting in the DOM
    const ok = await checkConnection();
    if (ok) {
      toast("Token saved. You're connected — this is a one-time setup.", "ok");
      await detectSource();
    }
  } finally {
    els.saveTokenBtn.disabled = false;
  }
}

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
  // Forward slashes: ExtendScript's $.evalFile accepts them on both platforms, and
  // a Windows backslash inside a JS string literal would be read as an escape.
  const jsxDir = path.join(EXT_ROOT, "src", "host").replace(/\\/g, "/");
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
  { key: "transcribe", label: "Transcribe (Rev.ai)" },
  { key: "select", label: "Select reels (Claude)" },
];

function renderSteps() {
  els.steps.innerHTML = "";
  STEPS.forEach((s) => {
    const li = document.createElement("li");
    li.id = "step-" + s.key;
    li.innerHTML = `<span class="dot"></span><span class="lbl">${s.label}</span><span class="pct"></span>`;
    els.steps.appendChild(li);
  });
}
function stepState(key, cls, pct) {
  const li = $("step-" + key);
  if (!li) return;
  li.classList.remove("active", "done", "err");
  if (cls) li.classList.add(cls);
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

// ── init ─────────────────────────────────────────────────────────────────────
async function init() {
  renderSteps();
  els.detectBtn.addEventListener("click", detectSource);
  els.generateBtn.addEventListener("click", generate);
  els.buildAllBtn.addEventListener("click", () => buildReels(state.reels));
  const srtAllBtn = $("srtAllBtn");
  if (srtAllBtn) srtAllBtn.addEventListener("click", () => saveSrts(state.reels));
  if (els.viewTranscriptBtn) els.viewTranscriptBtn.addEventListener("click", openTranscriptModal);
  if (els.smoothBtn) els.smoothBtn.addEventListener("click", makeProxy);
  const closeT = $("closeTranscriptBtn");
  if (closeT) closeT.addEventListener("click", closeTranscriptModal);
  const saveTxt = $("saveTxtBtn");
  if (saveTxt) saveTxt.addEventListener("click", saveTranscriptTxt);
  if (els.transcriptModal) {
    // Click the dark backdrop (outside the box) to dismiss.
    els.transcriptModal.addEventListener("click", (e) => {
      if (e.target === els.transcriptModal) closeTranscriptModal();
    });
  }

  // Access-token controls.
  if (els.saveTokenBtn) els.saveTokenBtn.addEventListener("click", saveToken);
  if (els.tokenInput) {
    els.tokenInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveToken();
    });
  }
  if (els.showTokenBtn) {
    els.showTokenBtn.addEventListener("click", () => {
      const hidden = els.tokenInput.type === "password";
      els.tokenInput.type = hidden ? "text" : "password";
      els.showTokenBtn.textContent = hidden ? "🙈 Hide" : "👁 Show";
    });
  }
  if (els.closeConnBtn) els.closeConnBtn.addEventListener("click", hideConn);
  // The badge reopens the card so a token can be changed after setup.
  if (els.backendBadge) {
    els.backendBadge.style.cursor = "pointer";
    els.backendBadge.addEventListener("click", () => {
      if (els.connCard.classList.contains("hidden")) {
        showConn(
          config.current().hasToken
            ? "A token is already saved on this machine. Paste a new one to replace it."
            : "Paste the token from your admin.",
          "muted"
        );
      } else {
        hideConn();
      }
    });
  }

  // Log which FFmpeg we resolved — first thing to check on any "Extract audio"
  // failure, and the fastest way to spot a bundle built for the wrong platform.
  const ffDiag = ffmpeg.diagnostics();
  console.log("[ISTV] platform:", ffDiag.platform);
  console.log("[ISTV] ffmpeg:", ffDiag.ffmpeg.source, ffDiag.ffmpeg.path);
  console.log("[ISTV] ffprobe:", ffDiag.ffprobe.source, ffDiag.ffprobe.path);
  console.log("[ISTV] vertical preset:", TEMPLATES.verticalPreset || "(none)");
  console.log("[ISTV] caption mogrt:", TEMPLATES.captionMogrt || "(none)");

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
  // Service reachability + the editor's access token. Runs quiet on startup so a
  // working setup doesn't nag; surfaces the token card when it isn't working.
  await checkConnection({ quiet: true });

  TEMPLATES.warnings.forEach((w) => toast(w, "warn"));

  await detectSource();

  // Restore last run's reels so the editor can rebuild without re-transcribing.
  const cached = cache.loadLastRun();
  if (cached && Array.isArray(cached.reels) && cached.reels.length) {
    // A fresh Premiere session has none of last run's sequences, so clear the
    // built flags — Build will recreate them on demand.
    state.reels = cached.reels.map((r) => ({ ...r, built: false, sequenceName: "" }));
    if (!state.source && cached.source) state.source = cached.source;
    renderReels();
    toast(`Restored ${state.reels.length} reels from your last run. Click Build reels, or Generate to refresh.`, "ok");
  }
}

async function detectSource() {
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
      `<b>${escapeHtml(res.data.name)}</b> · ${meta.width}×${meta.height} · ${meta.fps}fps · ${reelModel.fmtDur(meta.durationSec)}` +
      `<br/><span class="small">${escapeHtml(res.data.path)}</span>`;
    els.generateBtn.disabled = false;
    refreshTranscriptAvailability();
  } catch (e) {
    state.source = { ...res.data, meta: { fps: 30, width: 1920, height: 1080, durationSec: 0 } };
    els.sourceLine.innerHTML = `<b>${escapeHtml(res.data.name)}</b> <span class="small">(probe failed: ${escapeHtml(e.message)})</span>`;
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
  const fp = cache.sourceFingerprint(state.source.path);
  state.sourceFingerprint = fp;
  const cached = cache.loadTranscript(fp);
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

  // Check the token BEFORE extracting audio. Without this the editor waits through
  // a full audio export only to hit a 401 on upload, and the error arrives with no
  // hint that a token is the problem.
  if (!(await checkConnection())) {
    toast("Enter your access token to continue — see the panel above.", "warn");
    return;
  }

  els.generateBtn.disabled = true;
  els.pipeline.classList.remove("hidden");
  els.reelsCard.classList.add("hidden");
  STEPS.forEach((s) => stepState(s.key, ""));
  els.toast.classList.add("hidden");

  try {
    stepState("source", "done");

    // Fingerprint the source so the transcript can be cached/reused (path+size+mtime).
    const fp = cache.sourceFingerprint(state.source.path);
    state.sourceFingerprint = fp;
    const forceRetranscribe = !!(els.forceTranscribe && els.forceTranscribe.checked);
    const cachedTranscript = forceRetranscribe ? null : cache.loadTranscript(fp);

    let transcript;
    if (cachedTranscript) {
      // Same file as a previous run → reuse the saved Rev.ai transcript and skip
      // extract/upload/transcribe entirely (no Rev.ai cost, no wait).
      transcript = cachedTranscript;
      stepState("extract", "done");
      stepState("upload", "done");
      stepState("transcribe", "done");
      const wc = cachedTranscript.word_count || (cachedTranscript.words || []).length;
      pipeMsg(`Loaded saved transcript (${wc} words) — skipped Rev.ai. Tick "Re-transcribe" to force a fresh run.`);
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
      } catch (e) {
        /* temp file; the OS will reap it */
      }

      // Save the transcript so a re-run of this exact file skips Rev.ai next time.
      if (cache.saveTranscript(fp, transcript)) {
        pipeMsg("Transcript saved — re-runs of this file will skip Rev.ai.");
      }
    }

    // Keep the transcript for the viewer + enable the "View transcript" button.
    state.transcript = transcript;
    showTranscriptButton(true);

    // 3) Claude reel selection.
    stepState("select", "active");
    pipeMsg("Selecting reels with Claude (v2_test2 profile)…");
    const name = els.speaker.value.trim();
    const num = Math.max(1, Math.min(20, parseInt(els.numReels.value, 10) || 10));
    const analysis = await backend.selectReels(transcript, name, num, {
      onStatus: (s) => pipeMsg(s.message || "Selecting…"),
    });
    stepState("select", "done");

    state.analysis = analysis;
    state.reels = reelModel.normalizeReels(analysis);
    renderReels();
    cache.saveLastRun({ source: state.source, reels: state.reels });
    pipeMsg(`${state.reels.length} reels selected. Review, then build in Premiere.`);
    toast("Reels ready. Click a reel's Build button, or Build all.", "ok");
  } catch (e) {
    const active = els.steps.querySelector(".active");
    if (active) active.classList.replace("active", "err");
    pipeMsg("");
    toast("Failed: " + e.message, "err");
  } finally {
    els.generateBtn.disabled = false;
  }
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
        <button class="btn small ghost srt" title="Save this reel's .srt caption file">📝 SRT</button>
        <span class="status"></span>
      </div>`;
    div.querySelector(".build").addEventListener("click", () => buildReels([reel]));
    div.querySelector(".srt").addEventListener("click", () => saveSrts([reel]));
    els.reels.appendChild(div);
  });
}

// ── build reels inside Premiere ─────────────────────────────────────────────────
async function buildReels(reels) {
  if (!reels.length || !state.source) return;
  els.buildAllBtn.disabled = true;
  reels.forEach((r) => setReelStatus(r, "Building…", ""));

  const payload = reelModel.buildPayload(reels, {
    source: state.source,
    canvas: config.current().canvas,
    presetPath: TEMPLATES.verticalPreset,
    mogrtPath: TEMPLATES.captionMogrt,
  });

  const res = await hostCall("buildReels", payload);
  els.buildAllBtn.disabled = false;

  // Write the full build result (incl. per-reel caption diagnostics) to a temp
  // file for troubleshooting.
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
    const card = $("reel-" + state.reels.indexOf(reel));
    if (card && b.ok) card.classList.add("built");
  });
  const okReels = (res.data.built || []).filter((b) => b && b.ok).length;
  const warns = res.data.warnings || [];
  const captionNote = TEMPLATES.captionMogrt
    ? "Captions are placed on the sequence."
    : "Captions imported as .srt — drag each onto its reel's timeline once.";
  toast(`Built ${okReels} reel sequence(s). ${captionNote}` + (warns[0] ? " " + warns[0] : ""), "ok");
}

function setReelStatus(reel, text, cls) {
  const card = $("reel-" + state.reels.indexOf(reel));
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
    cache.ensureDir(cache.PROXY_DIR);
    const fp = cache.sourceFingerprint(state.source.path);
    const proxyPath = cache.proxyPath(fp);
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

// ── SRT export (reliable manual caption path: drag onto the reel timeline) ──────

/** Where per-reel caption files go: next to the source video, else the temp dir. */
function captionsDir() {
  const src = state.source && state.source.path;
  return path.join(src ? path.dirname(src) : os.tmpdir(), "ISTV_Captions");
}

/** Write .srt files for the given reels and reveal the folder so you can drag them in. */
function saveSrts(reels) {
  if (!reels || !reels.length) return;
  const baseDir = captionsDir();
  let written = 0;
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    reels.forEach((r) => {
      const srt = reelModel.reelToSrt(r);
      if (!srt.trim()) return;
      fs.writeFileSync(path.join(baseDir, reelModel.srtFileName(r)), srt, "utf8");
      written++;
    });
  } catch (e) {
    toast("Could not write SRT files: " + e.message, "err");
    return;
  }
  platformInfo.openFolder(baseDir);
  toast(
    `Saved ${written} SRT file(s) to ${baseDir}. In Premiere: File ▸ Import the .srt (or drag it), then drop it on the reel's timeline — it becomes an editable caption track.`,
    "ok"
  );
}

// ── transcript & subtitles viewer ──────────────────────────────────────────────

function openTranscriptModal() {
  if (!els.transcriptModal || !els.transcriptBody) return;
  const t = state.transcript;
  if (!t) {
    toast("No transcript yet — click Generate first.", "warn");
    return;
  }
  const dur = t.duration ? " · " + reelModel.fmtClock(t.duration) : "";
  const wc = t.word_count || (t.words || []).length;
  const parts = [];
  parts.push(
    '<div class="tsec"><div class="tsec-h">Transcription — Rev.ai' +
      dur +
      " · " +
      wc +
      ' words</div><div class="tbody">' +
      escapeHtml(reelModel.transcriptToText(t)) +
      "</div></div>"
  );
  if (state.reels && state.reels.length) {
    const subs = state.reels
      .map((r) => {
        const srt = (reelModel.reelToSrt(r) || "").trim();
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
  const baseDir = captionsDir();
  const stem = state.source ? reelModel.baseName(state.source.path).replace(/\.[^.]+$/, "") : "transcript";
  const out = ["TRANSCRIPTION (Rev.ai)", "", reelModel.transcriptToText(t)];
  if (state.reels && state.reels.length) {
    out.push("", "========================================", "SUBTITLES PER REEL");
    state.reels.forEach((r) => {
      out.push("", "#" + r.rank + "  " + String(r.title || "") + " (" + r.durationSec + "s)", (reelModel.reelToSrt(r) || "").trim());
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
  platformInfo.openFolder(baseDir);
  toast("Saved transcript to " + file, "ok");
}

// ── utils ────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

window.addEventListener("DOMContentLoaded", init);
