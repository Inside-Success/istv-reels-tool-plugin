"use strict";

/**
 * Caption style templates (§5) — data-driven, loaded from
 * presets/caption-templates.json, so new looks are added without touching
 * code. Consumed by the editable form's live preview and by docToSrt's
 * line-wrap (maxChars/maxLines).
 */
const fs = require("fs");
const path = require("path");

function readTemplatesFile() {
  try {
    const p = path.join(__dirname, "..", "presets", "caption-templates.json");
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!data || !Array.isArray(data.templates)) return { defaultTemplateId: "clean-bold", templates: [] };
    return data;
  } catch (e) {
    return { defaultTemplateId: "clean-bold", templates: [] };
  }
}

const cached = readTemplatesFile();
const DEFAULT_TEMPLATE_ID = cached.defaultTemplateId || "clean-bold";

function listTemplates() {
  return cached.templates;
}

function getTemplate(id) {
  return cached.templates.find((t) => t.id === id) || cached.templates.find((t) => t.id === DEFAULT_TEMPLATE_ID) || cached.templates[0];
}

module.exports = { listTemplates, getTemplate, DEFAULT_TEMPLATE_ID };
