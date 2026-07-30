# The Reels Tool Logic

Turn a long-form documentary into short-form 9:16 karaoke reels. This repo has
**four components** that share the same core pipeline (`src/`); the CLI and
desktop app also share the FFmpeg render engine (`export/`), while the Premiere
plugin doesn't render at all — Premiere does.

| Component | What it is | Folder |
|-----------|-----------|--------|
| **CLI tool** | Drop a video in `input/`, run one command, get reels in `generated_data/`. | repo root (`generate_reels.py`) |
| **Backend** | FastAPI service: Rev.ai transcription + Claude reel selection. Holds the API keys. | [`backend/`](backend/) |
| **Desktop editor** | Cross-platform Electron app (Premiere-style) to edit + export reels. Only compressed audio leaves the machine. | [`desktop/`](desktop/) |
| **Premiere plugin** | CEP extension: same AI brain, but builds editable 9:16 karaoke reel **sequences inside Premiere** (Premiere renders, not FFmpeg). | [`premiere-plugin/`](premiere-plugin/) |

## First-time setup (all components)

1. **Install prerequisites:** Python 3.11+, Node.js, and FFmpeg + ffprobe on your PATH.
2. **Add your keys:**
   ```bash
   cp .env.example .env       # then edit .env and fill in the two keys
   ```
   `.env` is gitignored and never committed. You need a **Rev.ai** key and an
   **Anthropic (Claude)** key — see `.env.example` for where to get them.
3. **Python deps:** `pip install -r requirements.txt` (CLI) and, for the backend,
   `pip install -r backend/requirements.txt`.

### Run the backend (needed by the desktop app and the plugin)
```bash
python -m uvicorn backend.app:app --port 8722
```
For the hosted deployment (Render blueprint, container, auth token, Postgres job
store) see [`render.yaml`](render.yaml) and [`backend/README.md`](backend/README.md).

### Run the desktop editor
```bash
cd desktop
npm install
npm start        # opens the editor window
```
The app talks to the backend at `http://127.0.0.1:8722` (override with `ISTV_BACKEND_URL`).
See [`desktop/README.md`](desktop/README.md) and [`backend/README.md`](backend/README.md) for details.

### Run the Premiere Pro plugin
```bash
cd premiere-plugin
npm install      # bundled FFmpeg for audio extraction
```
Then run `installer/dev-install.ps1` (Windows) or `installer/install.command`
(macOS), start the backend, and open **Window ▸ Extensions ▸ ISTV Reel Tool** in
Premiere. It builds editable 9:16 reel sequences directly in your project instead
of rendering MP4s.

### Ship the Premiere plugin to editors
```bash
cd premiere-plugin
npm install                       # build-time only
npm run vendor                    # fetch FFmpeg for Windows + both Macs (once)
node tools/build.mjs --backend-url https://istv-reels-tool-plugin.onrender.com
```
That writes three zips to `premiere-plugin/dist/` — Windows x64, Apple Silicon,
and Intel Mac. Send each editor the one for their machine; they unzip and
double-click `install.bat` or `install.command`. Either OS can build for all
three. The access token is never baked into a bundle — each editor enters it once
in the panel. `npm test` runs the plugin suite. Full details in
[`premiere-plugin/README.md`](premiere-plugin/README.md).

---

## CLI tool

Standalone reel generation pipeline — no website, no desktop app, no API server.

Drop a source video into `input/`, run one command, get 9:16 karaoke reels in `generated_data/`.

Uses the **updated_v2_test2** profile (same as `caylene_updated_v2_test2`):
- 30–90 second reels with context-aware cut points (long narrative arcs up to ~93s)
- v2 transcript cleanup (STT spelling fixes)
- 4-word karaoke captions, fillers hidden in subtitles
- No burned-in text hook / speaker lower-third overlays
- Claude `claude-opus-4-8` for analysis

## Requirements

- **Python 3.11+**
- **Node.js** (for FFmpeg export only — no npm install needed)
- **FFmpeg + ffprobe** on your PATH
- **Rev.ai** API key (transcription)
- **Anthropic** API key (analysis + cleanup)

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` and add your `REVAI_API_KEY` and `CLAUDE_API_KEY`.

## Usage

1. Put your source video (`.mp4`, `.mov`, `.mkv`, etc.) in the `input/` folder.
2. Run:

```bash
python generate_reels.py --name "Speaker Name"
```

Reels are saved to `generated_data/<date>_updated_v2_test2/exported/`.

### Options

```bash
python generate_reels.py --video "C:\path\to\interview.mp4"
python generate_reels.py --name "Caylene Salii"
python generate_reels.py --num-reels 10
python generate_reels.py --transcript path\to\transcript.json   # skip Rev.ai
```

### Re-export from saved analysis (exact same reels)

If you already have a job bundle with `analysis.json` (e.g. the reference `caylene_updated_v2_test2` batch), re-export MP4s without re-running Claude:

```bash
python generate_reels.py --export-only --job-dir generated_data/caylene_updated_v2_test2 --name "Caylene Salii"
```

No API keys needed for export-only.

## Output

Each run creates a job folder under `generated_data/`:

```
generated_data/2026-06-30_updated_v2_test2/
├── transcript.json
├── analysis.json
├── source_video.json
└── exported/
    ├── reel_01_..._916_karaoke.mp4
    ├── reel_02_Her_Marriage_and_Job_Collapsed_the_Same_Day_916_karaoke.mp4
    ├── ...
    ├── Caylene_marketing_package.docx
    ├── Caylene_marketing_package.html
    └── Caylene_all_reels_916_karaoke.zip
```

## Pipeline

```
Video → FFmpeg audio extract → Rev.ai transcription
     → Claude transcript cleanup (v2)
     → Claude reel selection + cut sheets (v2 hardening)
     → Word-accurate cutter (context-aware, 30–90s)
     → Node/FFmpeg 9:16 karaoke export (no text overlays)
     → Marketing doc + zip
```

## Reference batch

The canonical reference output is `generated_data/caylene_updated_v2_test2/` — long-form narrative reels like reel 2 (93s, single continuous span). Fresh Claude runs may pick different moments; use `--export-only` to reproduce an exact saved `analysis.json`.

## Folder layout

```
reels-tool---premiere-pro-plugin/
├── premiere-plugin/       ← Premiere CEP extension (the shipped product)
├── backend/               ← FastAPI service holding the API keys
├── src/                   ← core Python pipeline, shared by all components
├── export/                ← FFmpeg render engine (Node) — CLI + desktop only
├── desktop/               ← Electron editor
├── generate_reels.py      ← CLI entry point
├── export_pipeline.py     ← MP4 export orchestration
├── input/                 ← drop videos here (CLI)
├── generated_data/        ← CLI output
├── render.yaml            ← Render blueprint for the hosted backend
├── requirements.txt
└── .env.example
```
