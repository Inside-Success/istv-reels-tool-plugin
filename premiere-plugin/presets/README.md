# Bundled presets (one-time setup)

The plugin looks for two optional template files here. Both are **binary Adobe
formats** that must be created once from inside Premiere (they can't be authored
by hand). The plugin works without them — it falls back gracefully — but they
make the output exact.

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

## 2. `captions.mogrt` — the karaoke caption text template

A Motion Graphics template with **one editable text field**. The plugin drops
one instance per caption block and sets its text, giving word-by-word "pop"
karaoke (1-word blocks) or chunked captions (2-word blocks).

**Create it once:**
1. **Window ▸ Essential Graphics** → **New Layer ▸ Text**.
2. Style it like the reel captions: large, centered, bold, white with a dark
   stroke/shadow, positioned in the lower third.
3. Select the text layer, and in the Essential Graphics **Edit** tab check the
   box next to the text property so it becomes an **exposed/editable** control
   (this is the field the plugin sets per instance).
4. **Export As Motion Graphics Template…**, name it `captions`, save it here as
   `captions.mogrt`.

If it's missing, the plugin falls back to a **native caption track** (writes an
`.srt` and imports it) and posts a warning.

> These two files are intentionally **not** committed (see `.gitignore`) because
> they're environment/brand specific — each editor generates them once.
