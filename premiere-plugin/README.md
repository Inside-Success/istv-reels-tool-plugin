# ISTV Reel Tool — Premiere Pro plugin (CEP)

Turns a long-form interview into **editable 9:16 reels with karaoke-style
captions — as native Premiere sequences**. The plugin is the same AI brain as
the CLI / desktop app (Rev.ai transcription + Claude reel selection,
`v2_test2` profile), but instead of rendering MP4s with FFmpeg it **builds one
9:16 sequence per reel inside Premiere** so the editor refines and exports
through Media Encoder.

```
Active sequence clip
  → extract mono 16 kHz MP3 (bundled FFmpeg — the only thing that leaves the box)
  → backend /transcribe (Rev.ai)  → transcript
  → backend /select    (Claude)   → reels + cut sheets + marketing metadata
  → each reel gets an editable JSON caption master (js/captionDoc.js) — review/
     edit it in the ✏️ Captions panel before building
  → host.jsx builds, per reel: a 9:16 sequence, the cut-sheet spans placed on
     V1/A1, a vertical reframe, and karaoke-style pop captions — imported as a
     plain XML sequence (js/premiereXml.js) and nested on the reel, no MOGRT
     file needed (phrase-by-phrase text, not an in-line word-highlight sweep,
     see "Verify in Premiere" below)
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

- **Adobe Premiere Pro 2021 (15.0) or newer** on **Windows x64, macOS Apple
  Silicon, or macOS Intel** — one bundle per platform, see *Platform support*.
- The **backend** reachable (see [`../backend/README.md`](../backend/README.md)) —
  hosted for the team, or run locally while testing. The panel reads its URL
  from `config.json` (`backendUrl`), defaulting to `http://127.0.0.1:8722`.
- An **access token**, if the backend has `ISTV_API_TOKEN` set (any real
  deployment should). See *Access token* below.
- Node.js is needed **only to build/package** (to bundle FFmpeg) — editors who
  receive the packaged zip need nothing installed.

## Access token

The hosted backend gates `/transcribe`, `/select` and `/jobs` behind a bearer
token, because those endpoints spend Rev.ai minutes and Claude Opus tokens and
return transcripts. The panel sends `Authorization: Bearer <token>` on every
request (`js/backend.js`).

**The token is deliberately NOT in the shipped zip.** The bundle is handed out;
anyone who receives it could unzip it and read `config.json`. So the builder
strips `authToken` from every bundle and `--auth-token` is rejected outright, and
each editor enters the token once in the panel instead. It is saved to
`~/.istv-reel-tool/config.json` — outside the extension folder, so it survives
reinstalls and upgrades.

Resolution order, first hit wins (`js/config.js`):

| Layer | Where | Holds a token? |
|---|---|---|
| 1 | `ISTV_BACKEND_URL` / `ISTV_BACKEND_TOKEN` env vars | yes — handy for testing |
| 2 | `~/.istv-reel-tool/config.json` | yes — the editor's own |
| 3 | `<extension>/config.json` (shipped) | **no** — URL only |
| 4 | built-in default `http://127.0.0.1:8722` | no |

If the backend rejects the token, the panel shows a **Backend access required**
prompt rather than failing with a bare 401. The check uses
`GET /jobs/<nonexistent-id>` — guarded by the same token but costing nothing, so
verifying a token never submits a Rev.ai job or runs a Claude call.

Get the token from the Render dashboard: **istv-reels-backend → Environment →
`ISTV_API_TOKEN`**.

## Sharing with editors (simple, no dev tools)

**You (once per release):**
```bash
npm install                    # dev only — fetches the vendoring helper's deps
npm run vendor                 # fetch FFmpeg for Windows + both Macs (~400 MB, once)
node tools/build.mjs --backend-url https://istv-reels-tool-plugin.onrender.com
```
That writes **one zip per platform** to `dist/`, so an editor downloads ~40–60 MB
instead of a combined bundle:

| Bundle | For | Installer |
|---|---|---|
| `ISTV-Reel-Tool-win-x64.zip` | Windows x64 | `install.bat` |
| `ISTV-Reel-Tool-mac-arm64.zip` | macOS Apple Silicon | `install.command` |
| `ISTV-Reel-Tool-mac-x64.zip` | macOS Intel | `install.command` |

Either OS can build for all three — the binaries come from `vendor/`, not from
the build machine. `./installer/package.ps1 -BackendUrl "…"` is a Windows wrapper
around the same script. Add `--targets win32-x64` to build just one, or
`--universal` for a single fatter zip carrying every platform.

**Each editor:**
1. Unzip the bundle for their machine.
2. Close Premiere, then double-click **`install.bat`** (Windows) or
   **`install.command`** (macOS). Both enable CEP and copy the panel; neither needs
   admin rights.
3. Open Premiere → **Window ▸ Extensions ▸ ISTV Reel Tool**.
4. Paste the access token when the panel asks (once per machine).

No Node, npm, Python, or Adobe tools on the editor's side. To remove:
`uninstall.bat` / `uninstall.command`. Editor-facing steps also live in
`installer/README-EDITORS.txt`.

> **Backend:** one hosted backend serves the team (Render blueprint in
> [`../render.yaml`](../render.yaml)). Build with `--backend-url` so editors point
> at it automatically and never touch keys or Python. The builder **refuses** to
> produce a bundle pointing at localhost unless you pass `--allow-localhost`, since
> such a bundle only works on the machine that built it.
>
> Editors still need the access token once — see **Access token** above. It is
> never baked into the zip.

## Platform support

Ships for **Windows x64, macOS Apple Silicon (arm64), and macOS Intel (x64)**.

FFmpeg is the only platform-specific part. Bundles carry their own binary under
`vendor/ffmpeg/<platform>-<arch>/`, fetched by `npm run vendor`
(`tools/vendor-ffmpeg.mjs`, which verifies each download's architecture). That is
why one machine can build for all three: nothing is taken from the builder's own
`node_modules`.

At runtime `js/ffmpeg.js` resolves in this order, **stat-ing each candidate**:

1. `vendor/ffmpeg/<platform>-<arch>/` — what editors get
2. `ffmpeg-static` / `ffprobe-static` in `node_modules` — dev machines only
3. `ffmpeg` / `ffprobe` on `PATH` — last resort

The on-disk check in step 2 matters: `require("ffmpeg-static")` computes a path
from `process.platform` and returns it **without touching the disk**, so an
unchecked chain hands back a non-existent path and never falls through to `PATH`.
`test/ffmpeg.test.js` locks that down for all three targets.

macOS specifics handled in `js/main.js`: `adobeRoots()` resolves Premiere inside
its `.app` bundle (both the version-folder and bare-`.app` layouts, plus
`~/Applications`), and `revealInFolder()` uses `open` rather than `explorer`.
`install.command` additionally sets the exec bit and clears Gatekeeper's
`com.apple.quarantine` flag from the bundled binaries — both fatal to "Extract
audio" if skipped, and a zip built on Windows cannot carry the exec bit itself.

## Developing locally (you, on the repo machine)

**Windows** — symlink the live folder so edits show on the next panel reload:
```powershell
./installer/dev-install.ps1     # sets CEP flag, npm install if needed, symlinks
```

**macOS** — run the installer straight out of the repo; it falls back to the
parent folder as the payload when there is no bundle beside it:
```bash
chmod +x installer/install.command && ./installer/install.command
```

Either way you need `npm run vendor` once (or an `ffmpeg` on `PATH`) so the panel
can extract audio. Start the backend, open Premiere, then **Window ▸ Extensions ▸
ISTV Reel Tool**.

### Optional preset file (recommended for exact framing)
See [`presets/README.md`](presets/README.md) to create, once, the vertical
`.sqpreset`. Without it the plugin still works (project-default raster +
warning). Captions need **no** preset/template file — they're built as a
plain XML sequence import (js/premiereXml.js), not a MOGRT. If the
`.sqpreset` is present, it's included automatically when you `package.ps1`.

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
- **Karaoke-style pop captions** — the primary path (`jsx/captions.jsx`
  `applyGraphicsXml`) builds a plain Final Cut Pro 7 XML sequence
  (`js/premiereXml.js`) whose clips use Premiere's own built-in
  **"GraphicAndType"** filter — the same thing the classic Titler produces —
  with the text+style baked into its "Source Text" parameter (a base64 blob;
  the exact byte layout is ported from a real exported Premiere XML via the
  open-source [JorianWoltjer/AutoCaptions](https://github.com/JorianWoltjer/AutoCaptions)
  tool, not independently re-derived from Adobe docs — confirm it renders on
  your build). `app.project.importFiles()` brings it in as a new sequence;
  that sequence is then nested as one clip on a fresh top video track of the
  reel. No MOGRT file, no `importMGT`, no runtime guessing which component
  property holds "the text". A `mogrtPath`/legacy MOGRT path
  (`applyKaraoke`) still exists in `captions.jsx` and is used only if the
  panel doesn't supply `xmlText`.
  This is still phrase-by-phrase text swapping, **not** an in-line
  word-highlight sweep — Premiere's ExtendScript API has no way to recolor a
  sub-range of a single text parameter, and no scriptable caption-track API
  at all (confirmed against Adobe's own docs/community threads), so true
  karaoke and a live pull-back of an existing caption track are both out of
  reach for this plugin. The Captions panel's live preview shows a word
  sweep for judging template look/timing only — it says as much under the
  preview stage, since the built sequence won't look like that.
- **Pull captions back from Premiere** — best-effort only, for the reason
  above; expect an "unsupported" message rather than a live read of an
  existing caption track. Re-import the last exported `.srt` instead (✏️
  Captions → Import SRT).
- **Marker metadata** — `markers.createMarker`; cosmetic if it fails.

Each host call returns `{ ok, data | error }` and collects non-fatal `warnings`,
surfaced in the panel, so failures are visible rather than silent.
