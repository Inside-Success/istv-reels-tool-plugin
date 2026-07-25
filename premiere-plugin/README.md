# ISTV Reel Tool — Premiere Pro plugin (CEP)

Turns a long-form interview into **editable 9:16 karaoke reels — as native Premiere
sequences**. Same AI brain as the CLI (Rev.ai transcription + Claude reel selection,
`v2_test2` profile), but instead of rendering MP4s with FFmpeg it **builds one 9:16
sequence per reel inside Premiere**, so the editor refines and exports through Media
Encoder.

```
Active sequence clip
  → extract mono 16 kHz MP3 (bundled FFmpeg — the only thing that leaves the box)
  → backend /transcribe (Rev.ai)  → transcript
  → backend /select    (Claude)   → reels + cut sheets + marketing metadata
  → host.jsx builds, per reel: a 9:16 sequence, the cut-sheet spans placed on
     V1/A1, a vertical reframe, and karaoke captions
  → editor tweaks in Premiere → export via Media Encoder
```

**Ships for Windows x64, macOS Apple Silicon, and macOS Intel.** Editors install
with one double-click and need nothing else — no Node, no Python, no FFmpeg, no
Adobe developer tools.

---

## For editors: installing

You get one zip for your machine. See [`installer/README-EDITORS.txt`](installer/README-EDITORS.txt).

| Your machine | Zip | Install |
|---|---|---|
| Windows | `ISTV-Reel-Tool-win-x64.zip` | unzip → double-click **`install.bat`** |
| Mac (Apple Silicon: M1–M4) | `ISTV-Reel-Tool-mac-arm64.zip` | unzip → double-click **`install.command`** |
| Mac (Intel) | `ISTV-Reel-Tool-mac-x64.zip` | unzip → double-click **`install.command`** |

Then restart Premiere and open **Window ▸ Extensions ▸ ISTV Reel Tool**.
To remove: `uninstall.bat` / `uninstall.command`.

Not sure which Mac you have?  Apple menu ▸ About This Mac — "Apple M…" means
arm64, "Intel" means x64.

## Using it

1. Open your interview in a sequence (drag the clip onto a timeline).
2. The panel auto-detects the V1 clip as the source. Enter the speaker name and how
   many reels you want.
3. **Generate reels** — watch the pipeline (Extract → Upload → Transcribe → Select).
   Selected reels appear with their AI titles, captions, and hashtags.
4. **Build reels** (per reel, or all) — each becomes a 9:16 sequence in an **ISTV
   Reels** bin, with the cuts, reframe, and captions in place. The AI's
   caption/hashtags/why-it-works are stamped on a sequence marker.
5. Refine on the timeline and export via **File ▸ Export** / Media Encoder.

**Smooth playback** builds a one-time low-res proxy so 4K scrubs without stutter;
exports still use the full-resolution original.

The **transcript is cached per source file**, so re-running the same clip skips
Rev.ai entirely (no cost, no wait). Tick *Re-transcribe* to force a fresh run.

---

## Requirements

- **Adobe Premiere Pro 2021 (15.0) or newer**, Windows x64 or macOS.
- The **backend** reachable (see [`../backend/README.md`](../backend/README.md)) —
  hosted for the team, or run locally while testing. Its URL is baked into
  `config.json` at build time; `ISTV_BACKEND_URL` overrides it per machine.
- Node.js **only to build or develop**. Editors need nothing.

## Project layout

```
premiere-plugin/
├── CSXS/manifest.xml        CEP manifest (MainPath -> src/panel/index.html)
├── config.json              backendUrl, optional authToken, reel canvas
├── src/
│   ├── panel/               the CEF/browser half
│   │   ├── index.html
│   │   ├── panel.js         DOM wiring + pipeline orchestration (thin)
│   │   ├── css/styles.css
│   │   └── lib/CSInterface.js
│   ├── core/                the Node half — all testable logic lives here
│   │   ├── platform.js      every OS difference, in one place
│   │   ├── ffmpeg.js        binary resolution, probe, audio extract, proxy
│   │   ├── backend.js       /health /transcribe /select /jobs client
│   │   ├── captions.js      karaoke timing (port of src/caption_builder.py)
│   │   ├── reels.js         analysis -> reel model, host payload, SRT
│   │   ├── presets.js       finds the 9:16 preset + caption MOGRT
│   │   ├── cache.js         transcript/proxy/last-run caches
│   │   └── config.js        settings precedence + loopback detection
│   └── host/                the ExtendScript half (runs inside Premiere)
│       ├── host.jsx         sequence creation, clip placement, reframe
│       ├── captions.jsx     MOGRT karaoke / native SRT captions
│       └── json2.js         ES5 JSON polyfill (vendored)
├── tools/                   cross-platform build tooling (Node, no shell deps)
│   ├── vendor-ffmpeg.mjs    fetch per-platform binaries
│   ├── build.mjs            stage + zip the shippable bundles
│   ├── zip.mjs              ZIP writer that preserves POSIX exec bits
│   └── dev-install.mjs      symlink the live folder into Premiere
├── installer/               what editors double-click
│   ├── install.bat / install.ps1 / uninstall.bat / uninstall.ps1     (Windows)
│   └── install.command / uninstall.command                            (macOS)
├── test/                    node --test suite (see Testing)
├── presets/                 optional .sqpreset + .mogrt (see presets/README.md)
├── vendor/ffmpeg/           per-platform binaries (gitignored, fetched on demand)
└── dist/                    built bundles (gitignored)
```

The three-way split is the important part. `src/core/` never touches the DOM or
Premiere, so it is unit-testable; `src/panel/` is DOM wiring only; `src/host/` is
ES3 ExtendScript that can only run inside Premiere.

---

## Building a release

Once per machine:

```bash
cd premiere-plugin
npm install                       # build-time only: pulls ffmpeg-static/ffprobe-static
npm run vendor                    # fetch FFmpeg for all three targets (~420 MB)
```

Then per release:

```bash
node tools/build.mjs --backend-url https://reels.your-host.com
```

That produces three zips in `dist/`, one per platform (~45–52 MB each):

```
dist/ISTV-Reel-Tool-win-x64.zip
dist/ISTV-Reel-Tool-mac-arm64.zip
dist/ISTV-Reel-Tool-mac-x64.zip
```

Useful flags:

| Flag | Effect |
|---|---|
| `--targets darwin-arm64` | build just one platform |
| `--universal` | one zip containing all platforms (~140 MB) instead of three |
| `--auth-token <t>` | bake a bearer token into `config.json` |
| `--allow-localhost` | permit a loopback `backendUrl` (testing bundles only) |

**Either OS can build for both.** The vendoring script fetches binaries for every
target regardless of the machine it runs on, and `tools/zip.mjs` writes the archive
itself so the executable bits survive even when a Mac bundle is built on Windows.

**The build refuses to ship a loopback backend URL** unless you pass
`--allow-localhost`. A bundle pointing at `127.0.0.1` works only on the machine that
built it: every editor would install it, see "Backend not reachable", and have no way
to fix it short of editing JSON inside the installed panel.

`config.json` in the repo is never modified — the URL is baked into the staged copy.

### Developing locally

```bash
node tools/dev-install.mjs            # symlink the live folder into Premiere's CEP dir
node tools/dev-install.mjs --status   # what's installed, which FFmpeg, which templates
node tools/dev-install.mjs --uninstall
```

Edits then show up on the next panel reload. `.debug` opens a remote-debug port —
with the panel loaded, open `http://localhost:8088` in Chrome for its console,
network, and DOM. `.debug` is excluded from release bundles.

### Optional template files

See [`presets/README.md`](presets/README.md) to create, once, the vertical
`.sqpreset` and the karaoke `captions.mogrt`. Without them the plugin still works —
it auto-detects Premiere's built-in 9:16 preset and caption templates, and warns in
the panel if it finds neither. If present they are bundled automatically.

---

## Testing

```bash
npm test
```

119 tests, no network and no Premiere required. What they cover:

| Area | What is verified |
|---|---|
| `captions.test.js` | reel-timeline mapping across spans, block ordering/overlap, chunking, speaker breaks, cut-seam boundaries |
| `reels.test.js` | cut-sheet sorting/filtering, duration sums, host payload, SubRip output, transcript formatting |
| `platform.test.js` | Windows *and* macOS paths, both driven with a fake filesystem so each OS's branches are exercised from either machine |
| `presets.test.js` | preset/MOGRT discovery inside the macOS `.app` bundle and under Program Files |
| `ffmpeg.test.js` | binary resolution order, probe parsing (23.976/25/29.97), argument vectors |
| `config.test.js` | settings precedence, loopback detection |
| `cache.test.js` | fingerprint stability and invalidation |
| `host-extendscript.test.js` | `src/host/*.jsx` parses and uses no syntax or library call ExtendScript lacks |
| `build.test.js` | the loopback release guard, and ZIP permission bits at the byte level |
| `integration.test.js` | runs the **real bundled FFmpeg**: codecs present, mono 16 kHz MP3 actually produced, proxy raster/duration, error messages |

The integration tests skip cleanly if `npm run vendor` hasn't run yet.

### What tests cannot cover

`src/host/*.jsx` drives Premiere's scripting DOM, which has drifted across versions.
The suite proves it parses and stays inside ExtendScript's language subset, but these
steps still need eyes on a real Premiere build:

- **Sequence creation** — a bundled/auto-detected `.sqpreset` via QE, else
  `createNewSequence`. Confirm the reel raster is 1080×1920.
- **Clip placement** — `insertClip` with per-span in/out, falling back to
  `overwriteClip`. Confirm multi-span reels concatenate correctly.
- **Reframe** — sets Motion Scale/Position; property shapes vary by version.
- **Karaoke captions** — `importMGT` per block; confirm the text field name matches
  your `captions.mogrt` (the setter matches `/text|caption/i`).
- **Marker metadata** — cosmetic if it fails.

Each host call returns `{ ok, data | error }` and collects non-fatal `warnings`,
surfaced in the panel, so failures are visible rather than silent. Build results are
also written to `istv-reel-tool-lastbuild.json` in the temp dir for support.

---

## Cross-platform notes

Everything OS-specific is in `src/core/platform.js` and the two installer pairs.
The specifics, for anyone maintaining this:

| Concern | Windows | macOS |
|---|---|---|
| Enable unsigned extensions | `HKCU\Software\Adobe\CSXS.{9-12}\PlayerDebugMode` | `defaults write com.adobe.CSXS.{9-12} PlayerDebugMode` + `killall cfprefsd` |
| CEP extensions folder | `%APPDATA%\Adobe\CEP\extensions` | `~/Library/Application Support/Adobe/CEP/extensions` |
| Premiere resources | `C:\Program Files\Adobe\<version>\` | `/Applications/<version>/<version>.app/Contents/` — **inside the bundle** |
| Reveal a folder | `explorer` | `open` |
| FFmpeg binary | `vendor/ffmpeg/win32-x64/ffmpeg.exe` | `vendor/ffmpeg/darwin-{arm64,x64}/ffmpeg` |
| Post-install fixups | none | `chmod +x` the binaries, `xattr -dr com.apple.quarantine` |

Three of these were previously wrong or missing and each produced a distinct
macOS-only failure — a plugin that couldn't be installed at all, silently 16:9 reels
with no karaoke captions, an unrunnable FFmpeg path, and an uncaught exception after
saving SRTs. They are covered by tests that run on either OS.
