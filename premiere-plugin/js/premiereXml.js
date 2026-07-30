"use strict";

/**
 * Premiere caption graphics via Final Cut Pro 7 XML import — NOT MOGRT/importMGT.
 *
 * Pattern taken from JorianWoltjer/AutoCaptions (github.com/JorianWoltjer/AutoCaptions,
 * MIT-style open source, GraphicAndType + base64 text-param approach): build a plain
 * .xml sequence (the classic `xmeml` interchange format Premiere has imported for
 * decades) where every caption is a <clipitem> using Premiere's own built-in
 * "GraphicAndType" filter/generator — the same thing Premiere's classic Titler
 * produces — with the text+style baked into the "Source Text" parameter as a
 * base64-encoded blob (Premiere's own internal serialization for that parameter).
 *
 * Why this instead of MOGRT: no captions.mogrt file to author/ship, no
 * sequence.importMGT() (missing on some builds), no runtime property-reflection to
 * find "the text field" on an unknown component (jsx/captions.jsx's applyKaraoke
 * already documents that guesswork). XML import is one of Premiere's oldest,
 * best-supported interchange paths and needs none of that at runtime — the finished
 * XML already contains fully-styled, fully-positioned clips.
 *
 * Everything here is pure JS/data — no CEP/ExtendScript dependency. The caller
 * (js/main.js) builds the XML text and hands it to jsx/captions.jsx's
 * applyGraphicsXml, which just writes it to a temp file, imports it, and nests the
 * resulting sequence as one clip on the reel — exactly like the already-proven
 * applyNative's importFiles() call, just importing a sequence instead of an .srt.
 */

const captionDoc = require("./captionDoc");

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** "#RRGGBB" -> the packed-integer-as-float Premiere stores color params as
 *  (e.g. white "#FFFFFF" -> 16777215.0, exactly AutoCaptions' hardcoded value). */
function hexToColorFloat(hex) {
  const h = String(hex || "#FFFFFF").replace("#", "");
  const r = parseInt(h.substring(0, 2), 16) || 0;
  const g = parseInt(h.substring(2, 4), 16) || 0;
  const b = parseInt(h.substring(4, 6), 16) || 0;
  return r * 65536 + g * 256 + b;
}

/**
 * A template's `font.family` (e.g. "Segoe UI Black") is a display name for
 * the browser preview — Premiere's font menu keys off the installed font's
 * exact PostScript name, which varies per machine/Windows version and can't
 * be derived reliably from a display name. Guessing wrong doesn't just look
 * different: importing an XML that references an unresolvable font pops
 * Premiere's *blocking* "Resolve Fonts" dialog, which can desync the import
 * from applyGraphicsXml's own post-import bookkeeping (the actual cause of
 * captions landing in the project panel but never reaching the reel).
 *
 * So: default to a PostScript name virtually guaranteed to resolve without a
 * dialog (Arial ships with Windows and Premiere itself), and only use
 * something else if a template explicitly sets `font.postscriptName` (opt-in,
 * for once someone has confirmed the exact name on their machine).
 */
function guessPostScriptName(weight) {
  if (weight === "black") return "Arial-Black";
  if (weight === "semibold" || weight === "bold") return "Arial-BoldMT";
  return "ArialMT";
}

/**
 * Build the base64 "Source Text" parameter value — Premiere's own internal
 * serialization: an 8-byte header, then UTF-16LE JSON, then base64. Structure
 * ported field-for-field from a real exported Premiere XML (via AutoCaptions);
 * not independently verified against Premiere from this environment (see
 * README "Verify in Premiere") — flagged here rather than assumed correct.
 */
function buildSourceTextValue(text, opts = {}) {
  const data = {
    mShadowFontMapHash: null,
    mTextParam: {
      mAlignment: 2.0,
      mBackFillColor: 0.0,
      mBackFillOpacity: 0.0,
      mBackFillSize: 0.0,
      mBackFillVisible: false,
      mDefaultRun: [],
      mHeight: 0.0,
      mHindiDigits: false,
      mIndic: false,
      mIsMask: false,
      mIsMaskInverted: false,
      mIsVerticalText: false,
      mLeading: 0.0,
      mLigatures: false,
      mLineCapType: 0.0,
      mLineJoinType: 0.0,
      mMiterLimit: 0.0,
      mNumStrokes: 1.0,
      mRTL: false,
      mShadowAngle: 135.0,
      mShadowBlur: 40.0,
      mShadowColor: 4144959.0,
      mShadowOffset: 7.0,
      mShadowOpacity: 75.0,
      mShadowSize: 0.0,
      mShadowVisible: !!opts.shadowVisible,
      mStyleSheet: {
        mAdditionalStrokeColor: [],
        mAdditionalStrokeVisible: [],
        mAdditionalStrokeWidth: [],
        mBaselineOption: { mParamValues: [[0.0, 0.0]] },
        mBaselineShift: { mParamValues: [[0.0, 0.0]] },
        mCapsOption: { mParamValues: [[0.0, 0.0]] },
        mFauxBold: { mParamValues: [[0, false]] },
        mFauxItalic: { mParamValues: [[0, false]] },
        mFillColor: { mParamValues: [[0.0, num(opts.fillColorFloat, 16777215.0)]] },
        mFillOverStroke: { mParamValues: [[0, true]] },
        mFillVisible: { mParamValues: [[0, true]] },
        mFontName: { mParamValues: [[0, opts.fontName || "ArialMT"]] },
        mFontSize: { mParamValues: [[0.0, num(opts.fontSize, 60.0)]] },
        mKerning: { mParamValues: [[0.0, 0.0]] },
        mStrokeColor: { mParamValues: [[0.0, num(opts.strokeColorFloat, 0.0)]] },
        mStrokeVisible: { mParamValues: [[0, !!opts.strokeVisible]] },
        mStrokeWidth: { mParamValues: [[0.0, num(opts.strokeWidth, 10.0)]] },
        mText: String(text || ""),
        mTracking: { mParamValues: [[0.0, 0.0]] },
        mTsumi: { mParamValues: [[0.0, 0.0]] },
        mUnderline: null,
      },
      mTabWidth: 400.0,
      mVerticalAlignment: 0.0,
      mWidth: 0.0,
    },
    mUseLegacyTextBox: false,
    mVersion: 1.0,
  };
  const header = Buffer.from([0x0f, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const body = Buffer.from(JSON.stringify(data), "utf16le");
  return Buffer.concat([header, body]).toString("base64");
}

/** Decode a value built by buildSourceTextValue back to its text — for tests. */
function decodeSourceTextValue(base64Value) {
  const buf = Buffer.from(base64Value, "base64");
  const json = buf.slice(8).toString("utf16le");
  const data = JSON.parse(json);
  return data.mTextParam.mStyleSheet.mText;
}

function escapeXml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Rough average glyph-width-to-font-size ratio for a bold sans-serif face
// (Arial-Black/Arial-BoldMT) — NOT real typography, just a conservative
// stand-in since there's no way to measure actual Premiere text metrics from
// here. Used only to keep a chunk from overflowing the frame width, which is
// exactly what happened with a flat, uncalibrated font size (135, carried
// over from an unrelated ASS/libass renderer with different size units) —
// real-Premiere testing showed multi-word chunks rendering roughly 2x wider
// than the 1080px frame and getting clipped on both edges.
const AVG_CHAR_WIDTH_RATIO = 0.65;
const SAFE_WIDTH_FRACTION = 0.82; // ~9% margin on each side

/** Shrink fontSize (never grow it) just enough that `text` is unlikely to
 *  overflow `canvasWidth` at the given size, using the rough ratio above.
 *  Short chunks keep the template's full requested size; only long ones
 *  shrink — a flat reduction would either still overflow on long chunks or
 *  make short ones needlessly tiny. */
function fitFontSizeToWidth(text, requestedSize, canvasWidth) {
  const len = String(text || "").length;
  if (!len || !canvasWidth) return requestedSize;
  const safeWidth = canvasWidth * SAFE_WIDTH_FRACTION;
  const maxSizeForWidth = safeWidth / (len * AVG_CHAR_WIDTH_RATIO);
  return Math.max(24, Math.min(requestedSize, Math.floor(maxSizeForWidth)));
}

/**
 * Convert a caption doc into plain clip descriptors ready for the XML builder.
 * "native" = one clip per cue (full line); "karaoke" = one clip per chunk from
 * docToCaptionBlocks (the same doc-driven karaoke pop blocks the MOGRT path
 * uses — §1's rule that everything downstream comes from the JSON master
 * applies here too, not just to the legacy MOGRT/SRT paths).
 */
function clipsFromCaptionDoc(doc, template, opts = {}) {
  const mode = opts.mode || "karaoke";
  const fps = num(opts.fps, 30);
  const canvasWidth = num(opts.width, 1080);
  const t = template || {};
  const fill = hexToColorFloat(t.fill && t.fill.color);
  const stroke = t.stroke || {};
  const strokeColorFloat = hexToColorFloat(stroke.color);
  const strokeWidth = num(stroke.width, 0);
  const fontFamily = (t.font && t.font.postscriptName) || guessPostScriptName(t.font && t.font.weight);
  const requestedFontSize = num(t.font && t.font.size, 60);
  const shadowVisible = !!(t.shadow && t.shadow.enabled);
  const xFrac = num(t.position && t.position.xPct, 50) / 100;
  const yFrac = num(t.position && t.position.yPct, 85) / 100;
  const positionValue = `0,${xFrac}:${yFrac},0,0,0,0,0,0,0,0,0,0,0,0`;

  const items =
    mode === "native"
      ? (doc.cues || []).map((cue) => ({ text: cue.text, startSec: cue.start, endSec: cue.end }))
      : captionDoc.docToCaptionBlocks(doc, { chunkSize: opts.chunkSize }).map((b) => ({ text: b.text, startSec: b.start_time_seconds, endSec: b.end_time_seconds }));

  return items
    .filter((it) => it.text && it.text.trim())
    .map((it) => {
      const startFrame = Math.max(0, Math.round(it.startSec * fps));
      const endFrame = Math.max(startFrame + 1, Math.round(it.endSec * fps));
      const fontSize = fitFontSizeToWidth(it.text, requestedFontSize, canvasWidth);
      return {
        name: it.text.slice(0, 40),
        startFrame,
        endFrame,
        sourceTextValue: buildSourceTextValue(it.text, {
          fillColorFloat: fill,
          fontName: fontFamily,
          fontSize,
          strokeColorFloat,
          strokeWidth,
          strokeVisible: strokeWidth > 0,
          shadowVisible,
        }),
        positionValue,
      };
    });
}

/** Build the full xmeml (FCP7) XML text for a sequence of caption clips. */
function buildCaptionSequenceXml(clips, opts = {}) {
  const fps = num(opts.fps, 30);
  const width = num(opts.width, 1080);
  const height = num(opts.height, 1920);
  const sequenceName = escapeXml(opts.sequenceName || "Captions");
  const duration = clips.length ? Math.max(...clips.map((c) => c.endFrame)) : 0;

  const clipItemsXml = clips
    .map(
      (c, i) => `
                    <clipitem id="clipitem-${i}">
                        <masterclipid>masterclip-${i}</masterclipid>
                        <name>Graphic</name>
                        <enabled>true</enabled>
                        <rate>
                            <timebase>${fps}</timebase>
                            <ntsc>false</ntsc>
                        </rate>
                        <start>${c.startFrame}</start>
                        <end>${c.endFrame}</end>
                        <alphatype>none</alphatype>
                        <pixelaspectratio>square</pixelaspectratio>
                        <anamorphic>false</anamorphic>
                        <file id="file-${i}">
                            <name>Graphic</name>
                            <mediaSource>GraphicAndType</mediaSource>
                            <media>
                                <video>
                                    <samplecharacteristics>
                                        <width>${width}</width>
                                        <height>${height}</height>
                                        <anamorphic>false</anamorphic>
                                        <pixelaspectratio>square</pixelaspectratio>
                                        <fielddominance>none</fielddominance>
                                    </samplecharacteristics>
                                </video>
                            </media>
                        </file>
                        <filter>
                            <effect>
                                <name>${escapeXml(c.name)}</name>
                                <effectid>GraphicAndType</effectid>
                                <effectcategory>graphic</effectcategory>
                                <effecttype>filter</effecttype>
                                <pproBypass>false</pproBypass>
                                <parameter authoringApp="PremierePro">
                                    <parameterid>1</parameterid>
                                    <name>Source Text</name>
                                    <value>${c.sourceTextValue}</value>
                                </parameter>
                                <parameter authoringApp="PremierePro">
                                    <parameterid>3</parameterid>
                                    <name>Position</name>
                                    <IsTimeVarying>false</IsTimeVarying>
                                    <value>${c.positionValue}</value>
                                </parameter>
                            </effect>
                        </filter>
                    </clipitem>`
    )
    .join("");

  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
    <sequence>
        <duration>${duration}</duration>
        <rate>
            <timebase>${fps}</timebase>
            <ntsc>false</ntsc>
        </rate>
        <name>${sequenceName}</name>
        <media>
            <video>
                <format>
                    <samplecharacteristics>
                        <rate>
                            <timebase>${fps}</timebase>
                            <ntsc>false</ntsc>
                        </rate>
                        <width>${width}</width>
                        <height>${height}</height>
                        <anamorphic>false</anamorphic>
                        <pixelaspectratio>square</pixelaspectratio>
                        <fielddominance>none</fielddominance>
                        <colordepth>24</colordepth>
                    </samplecharacteristics>
                </format>
                <track>${clipItemsXml}
                </track>
            </video>
        </media>
    </sequence>
    <marker></marker>
</xmeml>`;
}

module.exports = {
  hexToColorFloat,
  guessPostScriptName,
  buildSourceTextValue,
  decodeSourceTextValue,
  fitFontSizeToWidth,
  clipsFromCaptionDoc,
  buildCaptionSequenceXml,
};
