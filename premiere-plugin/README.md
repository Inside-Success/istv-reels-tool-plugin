# ISTV Reel Tool — Premiere Pro plugin (CEP)

Turns a long-form interview into **editable 9:16 karaoke reels — as native
Premiere sequences**. The plugin is the same AI brain as the CLI / desktop app
(Rev.ai transcription + Claude reel selection, `v2_test2` profile), but instead
of rendering MP4s with FFmpeg it **builds one 9:16 sequence per reel inside
Premiere** so the editor refines and exports through Media Encoder.

```
Active sequence clip
  → extract mono 16 kHz MP3 (bundled FFmpeg — the only thing that leaves the box)
  → backend /transcribe (Rev.ai)  → transcript
  → backend /select    (Claude)   → reels + cut sheets + marketing metadata
  → host.jsx builds, per reel: a 9:16 sequence, the cut-sheet spans placed on
     V1/A1, a vertical reframe, and karaoke captions
  → editor tweaks in Premiere → export via Media Encoder
```

## What changed vs the desktop app

**Removed** (Premiere now owns these): the Electron shell, proxy generation, the
custom timeline/scrubbing/transport, the FFmpeg **render** engine
(`export/media.cjs`, `export_cli.py`), and the custom 9:16 drag-reframe preview.

**Kept**: the FastAPI **backend** (holds the keys) and the `src/` AI pipeline,
untouched. The caption-timing logic was ported to JS (`js/captions.js`).

**Added**: this CEP extension — an HTML/JS panel (`index.html`, `js/`) plus an
ExtendScript host (`jsx/`) that drives Premiere's scripting DOM.

## Requirements

- **Adobe Premiere Pro 2021 (15.0) or newer** (Windows-first, macOS supported).
- The **backend** reachable (see [`../backend/README.md`](../backend/README.md)) —
  hosted for the team, or run locally while testing. The panel reads its URL
  from `config.json` (`backendUrl`), defaulting to `http://127.0.0.1:8722`.
- Node.js is needed **only to build/package** (to bundle FFmpeg) — editors who
  receive the packaged zip need nothing installed.

## Sharing with editors (simple, no dev tools)

**You (once per release):**
```powershell
./installer/package.ps1                                   # local backend (testing)
./installer/package.ps1 -BackendUrl "https://your-host"   # bake in hosted backend
```
This bundles FFmpeg and produces `dist/ISTV-Reel-Tool.zip`. Send that zip.

**Each editor (Windows):**
1. Unzip.
2. Close Premiere, double-click **`install.bat`** (enables CEP + copies the panel).
3. Open Premiere → **Window ▸ Extensions ▸ ISTV Reel Tool**.

No Node, npm, Python, or Adobe tools on the editor's side. To remove:
`uninstall.bat`. Editor-facing steps also live in `installer/README-EDITORS.txt`.

> **Backend:** the plan is one hosted backend for the team — build with
> `-BackendUrl` so editors point at it automatically and never touch keys or
> Python. Until it's hosted, leave `config.json` on localhost and run `backend/`
> on your own machine for testing.

## Developing locally (you, on the repo machine)

Symlink the live folder so edits show on the next panel reload:
```powershell
./installer/dev-install.ps1     # sets CEP flag, npm install if needed, symlinks
```
Start the backend, open Premiere, then **Window ▸ Extensions ▸ ISTV Reel Tool**.

### Optional template files (recommended for exact output)
See [`presets/README.md`](presets/README.md) to create, once, the vertical
`.sqpreset` and the karaoke `captions.mogrt`. Without them the plugin still
works (default raster + native-caption fallback) and tells you what's missing.
If present, they're included automatically when you `package.ps1`.

## Use

1. Open your interview in a sequence (drag the clip onto a timeline).
2. In the panel: it auto-detects the V1 clip as the source. Enter the speaker
   name, pick how many reels and a caption style.
3. **Generate reels** — watch the pipeline (Extract → Upload → Transcribe →
   Select). Selected reels appear with their AI titles, captions, hashtags.
4. **Build in Premiere** (per reel, or **Build all**) — each reel becomes a
   9:16 sequence in an **ISTV Reels** bin, with the cuts, reframe, and captions.
   The AI's caption/hashtags/why-it-works are stamped as a sequence marker.
5. Refine on Premiere's timeline and export via **File ▸ Export** / Media Encoder.

Config: backend URL via `ISTV_BACKEND_URL` (defaults to `http://127.0.0.1:8722`).

## Debugging
`.debug` opens a remote-debug port — with the panel loaded, open
`http://localhost:8088` in Chrome for the panel's console/network/DOM.

## Verify in Premiere (honest status)

The AI half (audio export, backend calls, caption timing, reel normalization) is
straight ports of the proven desktop code and runs as-is. The **ExtendScript
host** (`jsx/host.jsx`, `jsx/captions.jsx`) drives Premiere's scripting API,
which has drifted across versions — these steps should be validated on your
Premiere build and may need small tweaks:

- **Sequence creation** — uses a bundled `.sqpreset` via QE when present, else
  `createNewSequence` with the project default (+ warning). Confirm the reel
  raster is 1080×1920.
- **Clip placement** — `insertClip` with per-span in/out; falls back to
  `overwriteClip`. Confirm multi-span reels concatenate correctly.
- **Reframe** — sets Motion **Scale**/**Position**; property names/shape can
  vary. Confirm the vertical framing fills the frame.
- **Karaoke captions** — `importMGT` per block + set text; confirm the text
  field name matches your `captions.mogrt` (the setter matches /text|caption/i).
- **Marker metadata** — `markers.createMarker`; cosmetic if it fails.

Each host call returns `{ ok, data | error }` and collects non-fatal `warnings`,
surfaced in the panel, so failures are visible rather than silent.
