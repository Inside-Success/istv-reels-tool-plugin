# Bundled presets (one-time setup)

Only the sequence preset below is needed. Captions build from a plain XML
sequence import (`js/premiereXml.js`) — no template file to create, ship, or
keep in sync.

## 1. `ISTV_Vertical_1080x1920.sqpreset` — the 9:16 sequence raster

Gives every reel an exact 1080×1920 vertical frame instead of inheriting the
project's default (usually 16:9).

**Create it once:**
1. In Premiere: **File ▸ New ▸ Sequence…**
2. Go to the **Settings** tab → Editing Mode: **Custom**.
3. Frame size **1080 × 1920**, matching your project's timebase (e.g. 30 fps),
   square pixels (1.0), progressive.
4. Click **Save Preset…**, name it `ISTV_Vertical_1080x1920`.
5. Premiere writes a `.sqpreset` file under your user settings
   (`…/Documents/Adobe/Premiere Pro/<ver>/Profile-<user>/Settings/Custom/` on
   Windows). Copy it into this folder with the exact name above.

If it's missing, the plugin creates each reel sequence with the project default
frame size and posts a warning telling the editor to run **Sequence ▸ Auto
Reframe** or set the raster manually.

## 2. `captions.mogrt` — LEGACY, not needed by default

Captions no longer need a MOGRT file. The default path builds an XML sequence
(Premiere's built-in "GraphicAndType" graphic, same pattern as the
[JorianWoltjer/AutoCaptions](https://github.com/JorianWoltjer/AutoCaptions)
tool) with the text baked in, and imports it — no template to author or ship.
Word count per pop is set by the active caption template's `karaoke.chunkSize`
in `presets/caption-templates.json`. This still isn't an in-line
word-highlight sweep — Premiere's scripting API can't recolor part of a single
text parameter, so a true karaoke sweep isn't achievable from this plugin
either way.

If you still want the old MOGRT-based path for some reason, `jsx/captions.jsx`
`applyKaraoke` is kept and works exactly as before — it's just no longer the
default (the panel always supplies `xmlText`, which takes priority). Building
one requires: **Window ▸ Essential Graphics** → **New Layer ▸ Text**, expose
the text property as an editable control, then **Export As Motion Graphics
Template…** → save here as `captions.mogrt`. Not committed (see `.gitignore`)
since it's environment/brand specific.
