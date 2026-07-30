# The Update Log

Running changelog of work done on this project via Claude Code, starting from
the initial clone. Newest entries go on top. Keep adding a new dated section
each session instead of editing old ones.

---

## 2026-07-30 — v1.2.0: cross-platform release (Windows + both Macs)

Audited the merged tree before releasing. Four real defects found and fixed, all
of them macOS or packaging:

- **`adobeRoots()` was silently broken on macOS.** It built
  `/Applications/Adobe Premiere Pro 2025/Contents` — a path that cannot exist,
  because Adobe's layout is a version *folder* containing the `.app`. This
  reproduced exactly the bug the (deleted) `src/core/platform.js` had fixed and
  documented: every Mac found no 9:16 sequence preset, so editors silently got
  reels at the project's raster — **16:9 instead of 1080×1920**, with only a
  warning. Now handles the version-folder layout, a bare `.app` in
  `/Applications`, and `~/Applications`. 8 simulated-layout tests.
- **Uncaught crash on non-Windows.** `spawn("explorer", …)` in "Save all SRTs"
  and "Save transcript". The surrounding `try/catch` caught nothing: a missing
  binary arrives as an async `'error'` event, and with no listener that is an
  uncaught exception (verified empirically). Replaced with `revealInFolder()` —
  `open`/`explorer`/`xdg-open` plus a real error listener.
- **`js/ffmpeg.js` accepted unverified binary paths.** `require("ffmpeg-static")`
  computes a path from `process.platform` and returns it *without touching the
  disk*, so a bundle installed on the wrong platform resolved to a non-existent
  binary and — because `require()` didn't throw — never fell through to `PATH`.
  Restored the vendor-first chain (`vendor/ffmpeg/<platform>-<arch>` →
  `node_modules` → `PATH`) with a `statSync` on every candidate.
- **Bundle was 3× larger than necessary.** `ffprobe-static` ships all six
  platform builds; five were dead weight in every download.

**Restored from git history** to make three-platform shipping real:
`installer/install.command` + `uninstall.command`, `tools/build.mjs`,
`tools/zip.mjs` (stores POSIX permissions, so a Windows-built Mac bundle still
arrives executable), and `tools/vendor-ffmpeg.mjs`. `build.mjs` was adapted to the
flat `js/`+`jsx/`+`css/` layout, and its `--auth-token` flag now **throws** rather
than baking a token into a distributed bundle.

`installer/package.ps1` was rewritten as a thin wrapper around `build.mjs`. It had
become a second, divergent builder — node_modules instead of `vendor/`,
Windows-only output — so a release could be cut either way and get different
contents. Dropped `tools/dev-install.mjs` (it depended on the deleted
`platform.js`); Windows dev install uses `installer/dev-install.ps1`, macOS uses
`install.command`'s repo fallback.

Versions unified at **1.2.0** across `package.json` and both `CSXS/manifest.xml`
fields — deliberately past the previously shipped 1.1.0, so editors already on
1.1.0 see an upgrade rather than an apparent downgrade.

**Verified against the live service** (`https://istv-reels-tool-plugin.onrender.com`):
`/health` reports `job_store: postgres, durable: true` — the Postgres store kept
from the 07-25 work is what production is actually running on. The real token is
accepted (404 on the free `/jobs` probe), a wrong token is refused (401). Bundles
checked at the zip level: exec bit `0755` on every binary and `.command`, LF line
endings on the `.command` files (CRLF would fail with `bad interpreter: /bin/bash^M`),
manifest 1.2.0 inside each, and no `authToken` in any `config.json`.

73 checks pass: 19 captionDoc, 15 premiereXml, 18 ffmpeg, 13 desktop model,
8 platform-layout, plus the full backend suite.

| Bundle | Zipped | Installed |
|---|---|---|
| `ISTV-Reel-Tool-win-x64.zip` | 60.7 MB | 165.7 MB |
| `ISTV-Reel-Tool-mac-arm64.zip` | 40.3 MB | 91.3 MB |
| `ISTV-Reel-Tool-mac-x64.zip` | 51.5 MB | 157.9 MB |

---

## 2026-07-30 — Merged the newer plugin branch without losing the deployment work

Brought in a separately-developed copy of the repo (dropped in as a nested
`reels-tool---premiere-pro-plugin/` folder). It turned out **not** to be strictly
newer: it had branched *before* the 2026-07-25 deployment commits, so a wholesale
overwrite would have silently reverted them.

**Taken from the new copy** (genuinely newer work):
- `src/transcription.py` — drops non-lexical filler words (`um`/`uh`/`hmm`, never
  real words like "like"/"so"), re-attaches Rev.ai's detached punctuation elements
  to the preceding word, and raises the audio-upload retry budget to 10 attempts
  with a 5s base delay (it's the one long transfer in the pipeline).
- `src/analyzer.py` — "Claude" removed from user-facing progress text.
- `premiere-plugin/` — restructured from `src/{core,host,panel}/` to flat
  `js/`, `jsx/`, `css/`, `index.html`. New: a 3-step wizard UI, a caption editor
  with per-word timing (`js/captionDoc.js`, `js/captionPanel.js`), data-driven
  caption style templates (`presets/caption-templates.json`), and **FCP7 XML
  caption import** (`js/premiereXml.js`) replacing the MOGRT path — no `.mogrt`
  to author, no `importMGT()`, no runtime property-guessing.

**Kept from this repo** (the new copy would have reverted all of it):
- `backend/app.py` — the `ISTV_API_TOKEN` bearer guard on `/transcribe`,
  `/select`, `/jobs`, the constant-time compare, and the startup-handler job
  resume (the new copy resumed at *module import*, so two workers each re-billed
  every in-flight Claude selection).
- `backend/job_store.py` — the Postgres backend and `ISTV_JOBS_DB` support. The
  new copy hardcoded a path next to the file, which would make `render.yaml`'s
  `ISTV_DATABASE_URL` and `/data` mount do nothing.
- `backend/requirements.txt` / `requirements.txt` — the full transitive set and
  the `-r backend/requirements.txt` line that stops the default PaaS build
  command producing a backend with no uvicorn.
- `render.yaml`, `backend/Dockerfile`, `.dockerignore`, `docs/`, `.env.example` —
  absent from the new copy, so untouched.

**Ported forward** (the new plugin had no auth at all, so it would have 401'd
against the deployed backend):
- `js/config.js` — four-layer resolution (env → `~/.istv-reel-tool/config.json` →
  bundled `config.json` → default), read at call time so a freshly saved token
  works without reloading the panel. The shipped bundle still carries the URL and
  never a token.
- `js/backend.js` — `Authorization: Bearer` on every request, plus
  `verifyToken()`, which probes `GET /jobs/<nonexistent-id>`: guarded by the same
  token but free, so checking a token never submits a Rev.ai job or runs Claude.
- `index.html` / `css/styles.css` / `js/main.js` — a **Backend access required**
  card that appears only when the backend actually rejects us, including
  mid-run (a rotated token now prompts instead of failing with a bare 401).
- `installer/package.ps1` — strips `authToken` from the *staged* config (a local
  testing token can no longer leak into a distributed zip), excludes `vendor/`
  from the bundle (~400 MB the panel no longer reads — FFmpeg comes from
  `node_modules` via `ffmpeg-static`), and warns when about to ship a bundle
  still pointing at localhost.

**Also fixed:** the new copy's `.gitignore` had dropped the `vendor/` rule, which
left 396 MB of FFmpeg binaries staged for the next `git add -A`. Restored.

**Deliberately not deleted:** `premiere-plugin/vendor/` (396 MB) and
`premiere-plugin/dist/` (542 MB) are gitignored and untracked, so removing them
would be unrecoverable. They are now stale — `dist/` holds bundles of the old
plugin structure — but harmless.

**Dropped in the restructure** (recoverable via git history): the macOS
installers (`install.command`/`uninstall.command`), the Node build/vendor tooling
(`tools/*.mjs`), and 10 of the 12 plugin test files — `platform.js`, `cache.js`
and `presets.js` no longer exist to test. Plugin coverage is now 34 tests across
`captionDoc` and `premiereXml`.

**Verified:** 34 plugin tests, 13 desktop model tests and the full backend check
suite pass. Auth confirmed end-to-end against a live local backend with
`ISTV_API_TOKEN` set: `/health` open, no token → 401, wrong token → 401, correct
token → 404 (authorised), and a guarded `/select` call reaching application
validation rather than the auth guard. Token persistence tested against a
redirected home directory, including env-over-user precedence.

---

## 2026-07-01 — Fixed: "Select reel moments" failing on Claude 529 Overloaded

**Symptom:** Generate Reels failed at the "Select reel moments (Claude)" step
with `{'type': 'overloaded_error', 'message': 'Overloaded'}` — the retry logic
added earlier this session didn't actually retry it.

**Root cause:** the Anthropic SDK raises a distinct `OverloadedError` (HTTP
529) that is a *sibling* of `InternalServerError`, not a subclass — and it
(along with `ServiceUnavailableError`/`DeadlineExceededError`) isn't even
re-exported from the public `anthropic` top-level namespace, only from the
private `anthropic._exceptions` module. The retry list in `src/analyzer.py`
and `src/transcript_cleanup.py` named specific exception classes and simply
didn't include it.

**Fix:** replaced the exception-class allowlist with a status-code check
against the public `anthropic.APIStatusError` base class
(`_is_retryable_claude_error` in `src/analyzer.py`, `_is_retryable` in
`src/transcript_cleanup.py`) — retries on 408/409/429/500/502/503/504/529.
This catches `OverloadedError` and any future status-specific subclass
Anthropic adds without needing another code change, since they all inherit
from the same public base class. Also bumped the main reel-selection/brand-story
retry budget from 3 to 6 attempts with backoff capped at 30s (was uncapped
exponential) — 529s are common under load and can take longer than a couple
of quick retries to clear, and a bigger source video means more Claude calls
and more chances to hit one.

**Verified:** built a real `OverloadedError` (529) via `httpx.Response` and
confirmed both `_is_retryable_claude_error` and `_is_retryable` return `True`
for it and `False` for a genuine 400 (shouldn't be retried — retrying a bad
request just fails identically every time). Ran `_call_with_retries` against a
function that raises 529 twice then succeeds — recovered on the 3rd attempt
with correct backoff messages.

---

## 2026-07-01 — ANALYZER_PROMPT: client-post framing

- Documented the full reel-selection pipeline in `reels-pipeline-logic.md`
  (transcription → cleanup → segmentation → Claude reel selection → cut-boundary
  math → captions), quoting every prompt verbatim so it can be diffed against
  source if either drifts.
- Patched `ANALYZER_PROMPT` in `src/analyzer.py` with two additions, requested
  after reviewing that doc: a "Who these reels are for" block establishing that
  the subject is a paying client posting to their own accounts (so reels should
  cover both who they are and what they do), and a "CLIENT-POST TEST" gate
  applied per-reel before finalizing (drop anything that makes the client look
  bad; vulnerability is fine as long as the reel resolves into strength by the
  end). Also reframed the title-writing bullet toward "would the subject
  proudly repost this." Verified the `# How to build each reel` header still
  appears exactly once and the file compiles.
- **Did not** apply the requested backend "fix" for a claimed 15–60s vs.
  30–90s length-window bug — traced it first and the premise didn't hold:
  `backend/app.py`'s `_run_selection` (the only path to `analyze_with_claude`
  from the desktop backend) already calls `apply_profile(DEFAULT_PROFILE)`
  before selection runs, and `analyzer.py` passes `max_len=reel_max_seconds()`
  (a live env lookup) explicitly into `build_reel_cut_sheet`, not a frozen
  default parameter. The 30–90s window should already be active on the
  desktop path with no change needed. Flagged this instead of applying the
  snippet as given, which also called `apply_profile()` with zero arguments —
  the real signature requires the `profile` dict, so as written it would have
  raised `TypeError`.

---

## 2026-07-01 — Multi-camera (Cam A/B/C) sync + generate

Added support for shoots with multiple cameras plus a dedicated audio
recorder — import all camera files + the reference recorder, auto-sync them
via audio cross-correlation, pick which camera a reel uses, and export pulls
the correct footage from each camera at the correct time.

Design (confirmed via planning Q&A before building):
- **One transcript/timeline.** Only the dedicated reference audio gets
  transcribed; Claude's reel-selection logic (`src/analyzer.py`) needed zero
  changes — it already just picks time ranges from one transcript. Cameras are
  purely an edit/export-time overlay: a fixed time offset per camera,
  translated at export time.
- **Purely additive.** Existing single-camera projects/exports are completely
  unaffected — no schema break, no migration.
- **Constant-offset model only** — no clock-drift correction across
  multi-hour recordings (explicit non-goal, fine for a standardized studio
  setup where cameras don't drift meaningfully over an interview-length
  shoot).

### Sync engine (`src/camera_sync.py`, new)
- FFT-based audio cross-correlation (pure numpy, no scipy/librosa) computes
  each camera's offset against the reference audio: `camera_time =
  reference_time + offset_sec`.
- Extracts a short (5 min default), low-samplerate (4kHz) mono WAV window per
  file for correlation — fast regardless of source file size, since only a
  window is read.
- New `sync_cameras_cli.py` at repo root (same shape as `export_cli.py`) for
  the desktop app to spawn.
- **Verified:** synthetic signals with known offsets (including camera-before-
  reference, camera-after-reference, and zero-offset cases) all recovered
  exact offsets. Also verified through real ffmpeg-extracted audio/video files
  end-to-end, and through the actual `desktop/src/main/sync.js` spawn wrapper.
- One real bug caught during testing: an initial periodic test tone produced
  garbage results (periodic signals correlate with many shifted copies of
  themselves) — switched to aperiodic noise-like test signals, which is also
  the reminder for why real speech/room-tone correlates reliably but a pure
  tone wouldn't.

### Export generalization (`export/media.cjs`, `export_pipeline.py`)
- `exportReel` now accepts an optional `sources: {camera_id: {path,
  offsetSec}}` map; each segment can carry a `camera` field selecting which
  source to pull from (falls back to the primary source when unset — fully
  backward compatible). This was a small, surgical change since the earlier
  single-pass rewrite already builds one `-ss/-t -i <path>` input group per
  segment — it just needed a per-segment path instead of one shared path.
- **Verified:** a 2-camera export (visually distinct red/blue test videos, one
  segment per camera with a real offset) produced exactly the right footage at
  the right time, both calling `exportReel` directly and through the full
  `export_pipeline.py` → Node pipeline.
- Known v1 limitation (documented in code): crop geometry is computed once
  from the primary camera's resolution and reused for every segment, even
  ones sourced from a different camera — fine when all cameras share the same
  resolution/framing (a standardized studio setup), not handled if a secondary
  camera has a different native resolution.

### Desktop app (Electron)
- New "Cameras" dialog: add a reference audio file + Cam A/B/C video files,
  "Sync" button computes offsets live (per-camera progress, confidence score,
  manual override input for low-confidence results).
- New `desktop/src/main/sync.js` (mirrors `export.js`'s spawn/parse pattern)
  and 4 new IPC channels (`PICK_REFERENCE_AUDIO`, `ADD_CAMERA_DIALOG`,
  `SYNC_CAMERAS`, `SYNC_EVENT`).
- Project schema bumped to v2 (`referenceAudioPath` + `cameras[]`, both
  optional) — a v1 project with neither field loads/exports identically to
  before.
- **Scope adjustment from the original plan:** the plan called for a
  per-segment (per-cut) camera picker in the timeline editor. Exploration
  showed the existing editor doesn't have per-inner-segment editing UI at all
  today — reels are edited as one continuous in/out span (`setReelIn`/
  `setReelOut` in `model.js` only ever touch the first/last segment). Built a
  **per-reel** camera picker instead (applies to the whole reel), which
  matches the actual editing granularity that exists today. Nothing is lost
  architecturally — the export pipeline already supports full per-segment
  camera switching; a future finer-grained editor UI could set `camera` per
  span without any pipeline changes.
- **Verified:** IPC channel names cross-checked for consistency across
  `channels.js`/`main.js`/`preload.js`/`renderer.js` (all match). Existing
  `desktop/test/model.test.js` suite still passes (13/13, unaffected since
  `model.js` wasn't touched). Electron smoke test (`npm run smoke`) confirms
  the app boots cleanly with all UI changes loaded through the real renderer
  process. Full interactive click-through in the running app was **not**
  done — this sandboxed environment has no display for that; someone should
  manually run through: add cameras + reference audio → Sync → assign a
  camera to a reel → Generate → confirm the exported file cuts between the
  right angles at the right times.

---

## 2026-07-01 — Clone + export speed/quality overhaul + reliability pass

### Cloned the repo
- Cloned `srinith009/AI-reels-editor-` into this folder.

### Export pipeline: single-pass rewrite (speed)
- **Problem:** exports were slow — every clip was decoded and re-encoded *twice*
  (once per cut segment, then again for the final render), entirely on CPU
  (libx264, no GPU), one segment at a time.
- **Fix (`export/media.cjs`):** rewrote `exportReel` to do fast per-segment
  seeking (`-ss/-t` before each `-i`, same trick as before) directly into a
  single ffmpeg filter graph — trim → concat → crop → subtitle burn-in → one
  final encode. Removed the now-dead `cutSegment` / `concatSegments` /
  `renderReelPreview` functions.
- Result: one fewer full re-encode generation. Same quality settings as
  before, so output quality is unchanged or slightly better (no double
  quantization), just faster.
- Verified end-to-end with synthetic test clips (segment durations, crop, and
  captions all correct in the single-pass output).

### Parallel reel export
- **`export_pipeline.py` / `export_cli.py`** (used by the desktop app and the
  batch pipeline): reels now export concurrently via a bounded thread pool
  (`REEL_MAX_WORKERS` env var, default `min(4, cpu_count)`) instead of
  strictly one-at-a-time.

### New export options
- **"Original" resolution** — added alongside 720p/1080p/2K/4K. Crops to 9:16
  using the source's native pixel density with no `scale` filter at all — no
  upscale, no downscale. (4K/2K/1080p/720p still always upscale a smaller
  source, per explicit choice, for platform-compatibility reasons.)
- **Lossless audio** — new checkbox in the export dialog. Encodes audio as
  `pcm_s16le` (uncompressed) instead of AAC, auto-switches the container to
  `.mov` (MP4 doesn't support raw PCM reliably). Removes the one remaining
  lossy compression step; audio is still normalized to 48kHz/stereo for
  concat/mix compatibility (a transparent format match, not a compression
  loss).
- Both verified via direct `exportReel` smoke tests (native-resolution output
  dimensions, PCM codec + correct container).

### Production-scaling fixes
- **Configurable worker cap** — `REEL_MAX_WORKERS` env var overrides the
  `min(4, cpu_count)` default for exporting many reels concurrently on bigger
  hardware.
- **Duration-scaled export timeouts** — replaced flat 1200s/1800s
  `subprocess.run` timeouts with one that scales with the *reel's own cut
  duration* (not source file size — the single-pass export only touches the
  segments it needs). Tunable via `REEL_EXPORT_TIMEOUT_MULTIPLIER` (default 8s
  per second of cut) and `REEL_EXPORT_TIMEOUT_MIN` (default 300s floor).
- **Durable backend job registry** (`backend/job_store.py`, new) — SQLite-backed
  (no new service dependency). Every job update writes through to it. On
  startup, `backend/app.py` reloads persisted state and:
  - Reattaches to a still-running **Rev.ai** transcription job by its saved
    job id — no re-upload needed, Rev.ai keeps running server-side regardless
    of our process.
  - Re-runs **Claude selection** from the saved transcript/name/num_reels —
    there's no external job to reattach to there, so this is a from-scratch
    redo, but the request is never silently lost.
  - Restores already-finished jobs for polling with no wasted resume work.
  - Mid-run checkpoint: `_run_selection` persists `cleaned_words` right after
    the transcript-cleanup Claude call finishes (before the costlier
    reel-selection call), so a restart resumes straight into selection instead
    of redoing both Claude calls.
  - Capped at 5 auto-resume attempts (`resume_attempts`) — a persistently
    failing ("poison-pill") job now gives up permanently with a clear error
    instead of silently re-billing the Claude call forever across restarts.

### Failure-mode audit + fixes
Ran a full audit of where the app can fail (backend security/abuse, SQLite
concurrency, ffmpeg command-line limits, crash cleanup, race conditions, path
handling). Fixed the concrete, in-scope findings:
- **No retry on Claude failures** — added `_call_with_retries` in
  `src/analyzer.py` (exponential backoff; retries transient network errors and
  malformed JSON, since retrying the same prompt often just works) wrapping
  reel-selection and brand-story extraction. Added a matching per-chunk retry
  in `src/transcript_cleanup.py`.
- **`workDir` collision risk** (introduced by the parallel-export change) —
  `media.cjs` used to name each export's temp dir with `Date.now()`
  (millisecond resolution); with parallel exports now firing off back-to-back,
  two processes could collide and silently share (and race on) the same
  `subs.ass` file. Switched to `fs.mkdtempSync`, which is atomic and
  OS-guaranteed unique.
- **Orphaned temp dirs on hard-kill** — added `cleanupStaleExportDirs()` in
  `media.cjs`, sweeping `istv-export-*` dirs older than 6h on every export call
  (best-effort, never blocks the real export).
- **`job_store` corruption resilience** — `load_all()` now skips and drops
  individually corrupted rows instead of crashing the whole backend on
  startup; a fully corrupted DB file gets quarantined and replaced with a
  fresh one. (Caught and fixed a real Windows-specific bug here during
  testing: the corrupted connection has to be closed before the file can be
  renamed, or the rename silently fails and quarantine does nothing.)
- **Filler-word removal is now subtitle-only** — removed the
  `cutFillersFromVideo` video-cutting path entirely (word-level cuts could
  split one reel into 50-100+ tiny segments, risking the ffmpeg
  command-line-length limit on filler-heavy reels). Filler words are still
  hidden from burned-in captions via the existing `hideFillersInSubtitles`
  flag, and the desktop editor's live transcript-preview hiding
  (`model.js`) is untouched. The now-dead `removeFillersFromSegments`
  function was removed.

### Also discussed (not yet implemented)
- Scaling to multi-camera (Cam A/B/C) shoots — no concept of multiple sources
  exists yet anywhere in the data model; would need sync (timecode or
  waveform), a `source_id`/`camera` field per segment, and generalizing the
  single-pass filter graph to open the right source per segment.
- Scaling to 100GB+ combined footage — export itself scales fine (streams from
  disk, no full-file loads). **Correction from initial assessment:** a 100GB
  video file doesn't threaten Rev.ai's 200MB cap by itself — 100GB is a
  bitrate/resolution thing (4K/6K footage), not a duration thing, and the
  pipeline already extracts + compresses audio (down to ~64kbps mono) before
  it ever reaches Rev.ai, so a normal 1-3hr shoot at any file size is fine
  regardless of video size. The real ceiling is audio *duration* — a
  multi-camera shoot running 5-10+ hours of continuous audio would still need
  chunking across multiple transcription jobs, or a local ASR fallback (e.g.
  faster-whisper), to remove that ceiling entirely. Not a concern for typical
  documentary/interview-length shoots.
- A Premiere Pro plugin — feasible via Premiere's scripting API (place cuts on
  Premiere's own timeline, let it render natively); main tradeoff is losing
  the current custom karaoke caption fidelity (would need Premiere's Essential
  Graphics/captions instead of the ASS/ffmpeg burn-in), and a different tech
  stack (UXP/CEP, not Electron) for the panel UI.
- Backend has no auth (`CORSMiddleware` wide open, no API key check on
  `/transcribe` / `/select`) — flagged as the top remaining risk if this
  backend is ever deployed reachable from outside the local machine, since
  anyone could trigger billed API calls. Not yet fixed.
