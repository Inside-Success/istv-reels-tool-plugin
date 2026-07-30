"use strict";

/*
 * ISTV Reel Tool — editable caption panel (§4).
 *
 * Renders a per-reel modal over the reel's captionDoc (js/captionDoc.js): a
 * cue list with inline text edit, split/merge/shift-all, per-word timing for
 * cues that carry word data, a live style preview (js/captionTemplates.js),
 * and inline validation. All edits mutate the in-memory doc only — nothing
 * reaches Premiere until Save SRT / Build (main.js's existing actions).
 *
 * The preview simulates a smooth per-word color sweep for judging template
 * look/timing, but that is NOT what Premiere ends up showing (§7b: MOGRT text
 * fields can't recolor a sub-range from script) — a static note under the
 * stage says so, so the gap between "preview" and "built sequence" is visible
 * rather than implied away.
 */

const captionDoc = require("./captionDoc");
const captionTemplates = require("./captionTemplates");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function hexWithAlpha(hex, alpha) {
  const h = String(hex || "#000000").replace("#", "");
  const r = parseInt(h.substring(0, 2), 16) || 0;
  const g = parseInt(h.substring(2, 4), 16) || 0;
  const b = parseInt(h.substring(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha == null ? 1 : alpha})`;
}

/** @param {{toast?:Function, onChange?:Function, importSrtForReel?:Function}} deps */
function createCaptionPanel(deps = {}) {
  const { toast, onChange, importSrtForReel, rebuildCaptionBlocks, pullCaptionsFromPremiere } = deps;
  const els = {};
  let activeReel = null;
  let previewCueId = null;
  let previewTimers = null;

  function bindEls() {
    if (els.modal) return;
    els.modal = document.getElementById("captionsModal");
    els.title = document.getElementById("capModalTitle");
    els.templateSelect = document.getElementById("capTemplateSelect");
    els.importBtn = document.getElementById("capImportSrtBtn");
    els.fileInput = document.getElementById("capSrtFileInput");
    els.regenBtn = document.getElementById("capRegenBtn");
    els.pullBtn = document.getElementById("capPullBtn");
    els.closeBtn = document.getElementById("capCloseBtn");
    els.validation = document.getElementById("capValidation");
    els.cueList = document.getElementById("capCueList");
    els.previewStage = document.getElementById("capPreviewStage");
    els.previewPlayBtn = document.getElementById("capPreviewPlayBtn");
    els.shiftInput = document.getElementById("capShiftInput");
    els.shiftBtn = document.getElementById("capShiftBtn");
    if (!els.modal) return; // markup not present (shouldn't happen once index.html is updated)

    captionTemplates.listTemplates().forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      els.templateSelect.appendChild(opt);
    });

    els.templateSelect.addEventListener("change", () => {
      if (!activeReel) return;
      activeReel.captionDoc.templateId = els.templateSelect.value;
      if (rebuildCaptionBlocks) rebuildCaptionBlocks(activeReel); // karaoke chunk size is template-driven (§5/§7b)
      notifyChange();
      renderPreview(previewCueId);
    });
    els.closeBtn.addEventListener("click", close);
    els.modal.addEventListener("click", (e) => {
      if (e.target === els.modal) close();
    });
    els.regenBtn.addEventListener("click", regenerate);
    if (els.pullBtn) els.pullBtn.addEventListener("click", pullFromPremiere);
    els.importBtn.addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", onImportFile);
    els.shiftBtn.addEventListener("click", applyShift);
    els.previewPlayBtn.addEventListener("click", playPreview);
  }

  function open(reel) {
    bindEls();
    if (!els.modal) return;
    activeReel = reel;
    els.title.textContent = reel.title || "Captions";
    els.templateSelect.value = reel.captionDoc.templateId || captionTemplates.DEFAULT_TEMPLATE_ID;
    renderAll();
    els.modal.classList.remove("hidden");
  }

  function close() {
    stopPreview();
    if (els.modal) els.modal.classList.add("hidden");
    activeReel = null;
  }

  function notifyChange() {
    if (!activeReel) return;
    activeReel.captionValidation = captionDoc.validateDoc(activeReel.captionDoc);
    renderValidation();
    if (onChange) onChange(activeReel);
  }

  function renderAll() {
    renderValidation();
    renderCueList();
    renderPreview(previewCueId);
  }

  function renderValidation() {
    const v = (activeReel && activeReel.captionValidation) || captionDoc.validateDoc(activeReel.captionDoc);
    if (v.ok) {
      els.validation.classList.add("hidden");
      els.validation.innerHTML = "";
      return;
    }
    els.validation.classList.remove("hidden");
    els.validation.innerHTML =
      `<div class="cap-val-head">⚠ ${v.errors.length} issue(s)</div>` + v.errors.map((e) => `<div class="cap-val-row">${escapeHtml(e)}</div>`).join("");
  }

  function renderCueList() {
    const doc = activeReel.captionDoc;
    els.cueList.innerHTML = "";
    doc.cues.forEach((cue, i) => {
      const row = document.createElement("div");
      row.className = "cap-cue" + (cue.id === previewCueId ? " selected" : "");
      row.dataset.cueId = cue.id;
      const hasWords = Array.isArray(cue.words) && cue.words.length > 0;
      row.innerHTML = `
        <div class="cap-cue-head">
          <span class="cap-idx">#${i + 1}</span>
          <span class="cap-tc">${fmtTime(cue.start)} → ${fmtTime(cue.end)}</span>
          ${hasWords ? '<span class="cap-flag ok">karaoke</span>' : '<span class="cap-flag muted">line only</span>'}
          <span class="cap-cue-actions">
            <button type="button" class="btn tiny ghost cap-split" title="Split at the cursor's word">✂ Split</button>
            <button type="button" class="btn tiny ghost cap-merge" title="Merge with the next cue"${i === doc.cues.length - 1 ? " disabled" : ""}>⤵ Merge next</button>
            ${hasWords ? '<button type="button" class="btn tiny ghost cap-words-toggle" title="Edit per-word timing">🔤 Words</button>' : ""}
          </span>
        </div>
        <textarea class="cap-text" rows="2">${escapeHtml(cue.text)}</textarea>
        ${hasWords ? `<div class="cap-words hidden">${cue.words.map((w, wi) => wordRowHtml(w, wi)).join("")}</div>` : ""}
      `;
      wireCueRow(row, cue);
      els.cueList.appendChild(row);
    });
  }

  function wordRowHtml(w, wi) {
    return `
      <div class="cap-word-row" data-word-index="${wi}">
        <span class="cap-word-text">${escapeHtml(w.text)}${
      w.needsTiming ? ' <i class="cap-needs-timing" title="Timing not confirmed — this word was added/edited">●</i>' : ""
    }</span>
        <input class="cap-word-start" type="number" step="0.01" value="${w.start.toFixed(2)}" title="Word start (sec)" />
        <input class="cap-word-end" type="number" step="0.01" value="${w.end.toFixed(2)}" title="Word end (sec)" />
      </div>`;
  }

  function wireCueRow(row, cue) {
    const textarea = row.querySelector(".cap-text");
    textarea.addEventListener("blur", () => {
      if (textarea.value === cue.text) return;
      captionDoc.syncCueWords(cue, textarea.value);
      renderCueList();
      notifyChange();
    });

    row.querySelector(".cap-split").addEventListener("click", () => {
      const idx = wordIndexAtCursor(cue, textarea);
      if (idx == null) {
        if (toast) toast("Place the cursor between two words to split there.", "warn");
        return;
      }
      try {
        captionDoc.splitCue(activeReel.captionDoc, cue.id, idx);
        renderAll();
        notifyChange();
      } catch (e) {
        if (toast) toast("Split failed: " + e.message, "err");
      }
    });

    const mergeBtn = row.querySelector(".cap-merge");
    if (mergeBtn && !mergeBtn.disabled) {
      mergeBtn.addEventListener("click", () => {
        const doc = activeReel.captionDoc;
        const i = doc.cues.findIndex((c) => c.id === cue.id);
        const next = doc.cues[i + 1];
        if (!next) return;
        captionDoc.mergeCues(doc, cue.id, next.id);
        renderAll();
        notifyChange();
      });
    }

    const wordsToggle = row.querySelector(".cap-words-toggle");
    if (wordsToggle) {
      wordsToggle.addEventListener("click", () => row.querySelector(".cap-words").classList.toggle("hidden"));
    }

    row.querySelectorAll(".cap-word-row").forEach((wrow) => {
      const wi = Number(wrow.dataset.wordIndex);
      const startInput = wrow.querySelector(".cap-word-start");
      const endInput = wrow.querySelector(".cap-word-end");
      const apply = () => {
        const w = cue.words[wi];
        if (!w) return;
        w.start = Math.max(0, Number(startInput.value) || 0);
        w.end = Math.max(w.start + 0.01, Number(endInput.value) || w.start + 0.01);
        delete w.needsTiming; // an explicit edit confirms the timing
        cue.start = Math.min(cue.start, cue.words[0].start);
        cue.end = Math.max(cue.end, cue.words[cue.words.length - 1].end);
        renderCueList();
        notifyChange();
      };
      startInput.addEventListener("change", apply);
      endInput.addEventListener("change", apply);
    });

    row.addEventListener("click", (e) => {
      if (e.target.closest(".cap-cue-actions") || e.target.closest(".cap-words") || e.target === textarea) return;
      renderPreview(cue.id);
      row.parentElement.querySelectorAll(".cap-cue.selected").forEach((r) => r.classList.remove("selected"));
      row.classList.add("selected");
    });
  }

  /** Map a textarea cursor position to the nearest word-index for Split. */
  function wordIndexAtCursor(cue, textarea) {
    const pos = textarea.selectionStart;
    const before = textarea.value.slice(0, pos).trim();
    if (!before) return null;
    const wordCount = before.split(/\s+/).filter(Boolean).length;
    const totalWords = Array.isArray(cue.words) && cue.words.length ? cue.words.length : textarea.value.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount <= 0 || wordCount >= totalWords) return null;
    return wordCount;
  }

  // ── live preview ─────────────────────────────────────────────────────────

  function renderPreview(cueId) {
    stopPreview();
    const doc = activeReel.captionDoc;
    const cue = doc.cues.find((c) => c.id === cueId) || doc.cues[0];
    previewCueId = cue ? cue.id : null;
    const template = captionTemplates.getTemplate(doc.templateId);
    if (!cue || !template) {
      els.previewStage.innerHTML = '<div class="cap-preview-empty">Select a cue to preview.</div>';
      return;
    }
    applyTemplateToStage(template);
    const words = Array.isArray(cue.words) && cue.words.length ? cue.words : [{ text: cue.text, start: cue.start, end: cue.end }];
    els.previewStage.innerHTML = `<div class="cap-preview-line">${words
      .map((w, i) => `<span class="cap-preview-word" data-w="${i}">${escapeHtml(w.text)}</span>`)
      .join(" ")}</div>`;
  }

  function applyTemplateToStage(t) {
    const stage = els.previewStage;
    stage.style.setProperty("--cap-fill", (t.fill && t.fill.color) || "#fff");
    stage.style.setProperty("--cap-stroke-w", `${(t.stroke && t.stroke.width) || 0}px`);
    stage.style.setProperty("--cap-stroke-c", (t.stroke && t.stroke.color) || "#000");
    stage.style.setProperty("--cap-active", (t.karaoke && t.karaoke.activeColor) || "#E6B450");
    stage.style.setProperty("--cap-inactive", (t.karaoke && t.karaoke.inactiveColor) || "#fff");
    stage.style.setProperty("--cap-scale", (t.karaoke && t.karaoke.activeScale) || 1);
    stage.style.setProperty("--cap-weight", t.font && t.font.weight === "black" ? "900" : t.font && t.font.weight === "semibold" ? "600" : "400");
    stage.style.background = t.box && t.box.enabled ? hexWithAlpha(t.box.color, t.box.opacity) : "transparent";
    stage.style.borderRadius = t.box && t.box.enabled ? `${t.box.cornerRadius || 0}px` : "0";
  }

  /** Sweep the preview word-by-word using real timing — a reference for
   *  template look/timing, not a promise about the built Premiere sequence. */
  function playPreview() {
    if (!activeReel) return;
    const doc = activeReel.captionDoc;
    const cue = doc.cues.find((c) => c.id === previewCueId);
    if (!cue) {
      if (toast) toast("Click a cue first to preview it.", "warn");
      return;
    }
    renderPreview(cue.id);
    const spans = els.previewStage.querySelectorAll(".cap-preview-word");
    const words = Array.isArray(cue.words) && cue.words.length ? cue.words : null;
    if (!words) {
      if (toast) toast("This cue has no word timing — nothing to sweep (line-level only).", "warn");
      return;
    }
    const t0 = cue.start;
    const timers = [];
    words.forEach((w, i) => {
      const span = spans[i];
      if (!span) return;
      timers.push(setTimeout(() => span.classList.add("active"), Math.max(0, (w.start - t0) * 1000)));
      timers.push(setTimeout(() => span.classList.remove("active"), Math.max(0, (w.end - t0) * 1000)));
    });
    previewTimers = timers;
  }

  function stopPreview() {
    if (Array.isArray(previewTimers)) previewTimers.forEach((t) => clearTimeout(t));
    previewTimers = null;
    if (els.previewStage) els.previewStage.querySelectorAll(".cap-preview-word.active").forEach((s) => s.classList.remove("active"));
  }

  // ── ingest actions ─────────────────────────────────────────────────────────

  function regenerate() {
    if (!activeReel) return;
    if (!window.confirm("Regenerate captions from the transcript? This discards any edits made in this panel.")) return;
    const meta = activeReel.captionDoc.meta || {};
    const templateId = activeReel.captionDoc.templateId;
    activeReel.captionDoc = captionDoc.docFromReel(activeReel._raw, activeReel.segments, {
      sequenceName: meta.sequenceName,
      fps: meta.fps,
      templateId,
    });
    activeReel.captionValidation = captionDoc.validateDoc(activeReel.captionDoc);
    if (rebuildCaptionBlocks) rebuildCaptionBlocks(activeReel);
    els.templateSelect.value = templateId;
    renderAll();
    if (onChange) onChange(activeReel);
  }

  function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file || !activeReel || !importSrtForReel) return;
    const res = importSrtForReel(activeReel, file.path);
    if (!res.ok) {
      if (toast) toast("SRT import failed: " + res.error, "err");
      return;
    }
    els.templateSelect.value = activeReel.captionDoc.templateId;
    renderAll();
    if (onChange) onChange(activeReel);
    if (toast) toast(`Imported ${res.doc.cues.length} caption line(s) from SRT. Karaoke is unavailable for these until re-aligned.`, "ok");
  }

  /** Best-effort pull-back (§7c) — expected to report "unsupported" on most
   *  Premiere/CEP builds (see jsx/captions.jsx pullCaptionTrack); the honest
   *  failure message points at Import SRT as the practical alternative. */
  async function pullFromPremiere() {
    if (!activeReel || !pullCaptionsFromPremiere) return;
    if (els.pullBtn) els.pullBtn.disabled = true;
    try {
      const res = await pullCaptionsFromPremiere();
      if (toast) toast(res && res.warning ? res.warning : "Pull-back did not return a caption track.", res && res.ok ? "ok" : "warn");
    } finally {
      if (els.pullBtn) els.pullBtn.disabled = false;
    }
  }

  function applyShift() {
    if (!activeReel) return;
    const off = Number(els.shiftInput.value) || 0;
    captionDoc.shiftAll(activeReel.captionDoc, off);
    renderAll();
    notifyChange();
  }

  return { open, close };
}

module.exports = { createCaptionPanel };
