# Repo analysis — shipping the Premiere extension cross-platform

> **STATUS: point-in-time audit, superseded in part.** This describes the repo
> *before* the cross-platform work. Kept for the reasoning and the `file:line`
> evidence, not as a description of current behaviour.
>
> **Fixed since** (see `premiere-plugin/README.md` and the test suite):
> B3 per-platform FFmpeg vendoring with architecture verification · B4 macOS
> install/packaging path · B6 macOS preset/MOGRT discovery inside the `.app`
> bundle · Bu1 `spawn("explorer")` on macOS · Bu3 missing `.env.example` ·
> Bu4 shipped `config.json` pointing at localhost (now a hard build guard) ·
> the `renderCaptionOverlay` dead code · most of the documentation-drift table.
>
> **Still open:** B1 backend auth · B2 backend not self-contained ·
> B5 backend concurrency/durability · Bu2 `purge_older_than` · Bu5 desktop
> `.venv` path · Bu6 hardcoded `Segoe UI Black` in the CLI render path.
> All of these are backend/CLI concerns, not the plugin.
>
> Two bugs found later, by tests rather than by this audit: caption timing used
> the *unsorted* cut sheet while clips used the sorted one, and
> `ffprobe-static`'s `darwin/arm64` binary is actually x86_64.

Read-only audit. No files were changed except this one.

**Target being assessed:** `premiere-plugin/` shipped to video editors on Windows
**and** macOS, talking to a hosted `backend/` that holds the Rev.ai + Anthropic keys.

## Method and limits

Every claim below cites `file:line`. Claims I could not settle from source alone
are labelled **unverified — needs a test on real hardware** and say exactly what
to run.

Two things constrain what could be checked statically:

- `premiere-plugin/node_modules/` is absent, so the bundled FFmpeg binary's
  build flags (libass / libmp3lame / prores_ks) could not be inspected.
- No `.venv` and no installed Python deps, so the backend's import chain was
  traced by reading imports rather than by executing them. Local interpreter is
  Python 3.10.0; `README.md:16` and `README.md:68` require 3.11+.

**Note:** `docs/` disappeared from disk partway through this audit. The first
directory listing showed `AGENT-PROMPT.md` and `SHIPPING.md`; a listing seconds
later showed no `docs/` at all, and `git status` reported a clean tree. This
report therefore does not cross-check anything against `docs/SHIPPING.md` — it
was not readable. Worth confirming that file still exists before Pass 2, since
Passes 2–4 are specified against it.

---

## Blockers, ranked

| # | Blocker | Evidence |
|---|---------|----------|
| B1 | Backend has no auth — anyone with the URL spends the Rev.ai/Anthropic budget | `backend/app.py:230`, `backend/app.py:264` |
| B2 | Backend cannot be containerised from `backend/` alone — it reaches into the repo root | `backend/app.py:28-39` |
| B3 | A bundle built on Windows ships a Windows-only FFmpeg and never falls back | `premiere-plugin/js/ffmpeg.js:21-39` |
| B4 | No macOS install or packaging path exists at all | `premiere-plugin/installer/` (all `.ps1`/`.bat`) |
| B5 | Multi-worker/multi-replica double-resumes and double-bills; job DB lives inside the image | `backend/app.py:376`, `backend/job_store.py:24` |
| B6 | macOS preset/MOGRT auto-detection points at a path that cannot exist | `premiere-plugin/js/main.js:62` |

---

### B1 — No authentication on the money-spending endpoints

**Severity: blocker**

`POST /transcribe` (`backend/app.py:230-261`) and `POST /select`
(`backend/app.py:264-305`) accept unauthenticated requests. `/transcribe` writes
the body to a temp file and immediately submits it to Rev.ai
(`backend/app.py:260` → `_run_transcription` → `src/transcription.py:62`).
`/select` runs two Claude calls — `correct_transcript_words`
(`backend/app.py:184`) and `analyze_with_claude` (`backend/app.py:199`) with
`max_tokens=12000` (`src/analyzer.py:362`) on `claude-opus-4-8`
(`src/analyzer.py:29`).

CORS is `allow_origins=["*"]` (`backend/app.py:47`). Note that CORS is *not* the
exposure here — both clients call the backend from Node, not from a browser
context (`premiere-plugin/js/backend.js:16-17`,
`desktop/src/main/backend.js:11-12`), so the wildcard is vestigial rather than
load-bearing. The actual exposure is that there is no credential check anywhere
in the request path.

**Smallest fix:** a FastAPI dependency that compares
`Authorization: Bearer <token>` against an env var, applied to `/transcribe` and
`/select` (leave `/health` open for smoke tests). The panel side needs a
matching change — `premiere-plugin/js/backend.js:66-71` and
`premiere-plugin/js/backend.js:110` build headers explicitly, so the token
threads through `premiere-plugin/js/config.js:29` alongside `backendUrl`.
Replace the CORS wildcard with an env-driven list in the same change.

---

### B2 — The backend is not a self-contained deployable

**Severity: blocker**

`backend/app.py:28-29` inserts the repo root on `sys.path`, then
`backend/app.py:33` loads `ROOT/.env`, then imports across the whole tree:

```
backend/app.py:36  from src.transcription import poll_transcription_job, transcribe_audio
backend/app.py:37  from src.transcript_cleanup import correct_transcript_words
backend/app.py:38  from src.analyzer import analyze_with_claude, DEFAULT_CLAUDE_MODEL
backend/app.py:39  from generate_reels import DEFAULT_PROFILE, apply_profile, detect_name_aliases
```

That last import is the expensive one. `generate_reels.py:30` pulls in
`export_pipeline`, which at `export_pipeline.py:18` pulls in
`src.marketing_doc`, which at `src/marketing_doc.py:10-13` imports `python-docx`.
So the transitive closure the container must contain is:

`src/transcription.py` → `src/cutter.py`; `src/analyzer.py` →
`src/transcript_segments.py`, `src/transcript_snippets.py`, `src/marketing_doc.py`;
`generate_reels.py` → `export_pipeline.py`, `paths.py`, `src/audio_processor.py`,
`src/source_video_paths.py`, `src/validate.py`, `src/caption_builder.py`.

Docker implications, concretely:

- **`backend/requirements.txt` is insufficient.** It lists only `fastapi` and
  `uvicorn` (`backend/requirements.txt:3-4`) and says the rest comes from the
  root file. The image also needs `python-dotenv`, `rev-ai`, `anthropic`, and
  **`python-docx`** (`requirements.txt:1-4`) — the last purely because
  `analyze_with_claude` imports `normalize_recommendations` from
  `src/marketing_doc.py:22`.
- **`Pillow` and `numpy` are not needed.** `Pillow` (`requirements.txt:5`) is
  imported by no Python file in the repo. `numpy` (`requirements.txt:6`) is
  imported only by `src/camera_sync.py:20`, which nothing in the backend chain
  reaches.
- **FFmpeg is genuinely not needed server-side — confirmed.** The only ffmpeg
  callers are `src/audio_processor.py:13,31,52` and `src/camera_sync.py:30,48`.
  The backend imports `check_ffmpeg`, `compress_audio`, `extract_audio` via
  `generate_reels.py:34` but calls none of them; `check_ffmpeg()` runs only in
  `generate_reels.py:171`, inside `main()`. No import-time subprocess. A slim
  Python base is correct.
- `paths.py:4-6` computes `TOOL_ROOT`/`INPUT_DIR`/`OUTPUT_ROOT` from the module
  location and `export_pipeline.py:21-22` computes a path to
  `export/export_reel_cli.cjs`. Neither is created or checked at import, so they
  are harmless in a container — but they do mean the *directory layout* must
  survive the copy, not just the modules.

**Smallest fix:** exactly what Pass 2 proposes — make the pipeline an installable
package so `backend/` depends on it instead of `sys.path.insert`. As an
intermediate step that unblocks nothing structurally but does document the truth,
`backend/requirements.txt` should list its real transitive deps.

---

### B3 — A Windows-built bundle ships a Windows-only FFmpeg, and silently fails on macOS

**Severity: blocker**

`premiere-plugin/package.json:10-12` depends on `ffmpeg-static` and
`ffprobe-static`. Both download **one** binary at `npm install` time, for the
platform doing the install. `installer/package.ps1:29-34` runs `npm install` on
the packaging machine and `installer/package.ps1:48-51` copies the whole plugin
root (including `node_modules/`) into the staged bundle. So the zip contains
whatever platform packaged it.

The resolution code makes this worse rather than degrading gracefully:

```js
// premiere-plugin/js/ffmpeg.js:21-35
function tryResolve(mod, pick) {
  try {
    const v = require(mod);
    ...
  } catch (e) { return null; }
}
function ffmpegPath() {
  return tryResolve("ffmpeg-static") || "ffmpeg";
}
```

The `|| "ffmpeg"` PATH fallback fires **only if `require()` throws**. `require()`
of `ffmpeg-static` returns a path string computed from `process.platform`; it
does not stat the file. On macOS, `require` succeeds and returns a path to a
`ffmpeg` binary that a Windows-built bundle does not contain, so `ffmpegPath()`
returns a non-existent path and the PATH fallback never runs. `spawn` then emits
`error` and `premiere-plugin/js/ffmpeg.js:52` rejects with a raw ENOENT — the
user sees a failed "Extract audio" step with no hint that FFmpeg is the problem.

Compounding it: `installer/package.ps1:63` uses `Compress-Archive`, which does
not preserve the POSIX executable bit. Even a bundle containing the correct
macOS binary would arrive non-executable, and additionally carry
`com.apple.quarantine` after download.

**What the code actually requires of FFmpeg.** Every flag in the shipped panel:

| Call site | Flags | Required features |
|---|---|---|
| `js/ffmpeg.js:62` `probe` | `-show_format -show_streams` | ffprobe, none special |
| `js/ffmpeg.js:104-113` `extractCompressedAudio` | `-vn -ac 1 -ar 16000 -b:a 64k -codec:a libmp3lame` | **libmp3lame** |
| `js/ffmpeg.js:174-186` `renderProxy` | `-vf scale=-2:540 -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -c:a aac -b:a 128k` | **libx264**, **aac encoder**, `scale` |
| `js/ffmpeg.js:145-154` `renderCaptionOverlay` | `-f lavfi -i color=…,format=rgba -vf subtitles=…:alpha=1 -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le` | libass, prores_ks, lavfi — **but see below** |

`renderCaptionOverlay` is **dead code**: exported at
`premiere-plugin/js/ffmpeg.js:194` and called from nowhere in the repo. The panel
does captions through Premiere (`jsx/captions.jsx`), not through an alpha overlay.
So the panel's live FFmpeg requirement is **libmp3lame, libx264, aac, and the
`scale` filter** — *not* libass or prores_ks.

This matters for Pass 3: its deliverable #1 says the vendoring script must fail
loudly if the binary lacks libass or prores_ks "— the panel needs all three."
Against the current code that is false; it would gate the build on features only
dead code uses. Either delete `renderCaptionOverlay` first, or keep the check but
know it is protecting a future feature rather than a current one.

(For completeness, the *CLI/desktop* render path does need libass and lanczos:
`export/media.cjs:732` `subtitles='…'`, `export/media.cjs:467`
`scale=…:flags=lanczos+accurate_rnd+full_chroma_int`, `export/media.cjs:521`
`libx264`. That path is not shipped in the panel.)

**Smallest fix:** vendor per-platform binaries under an explicit
`<platform>-<arch>` directory and select on `process.platform`/`process.arch`,
with a real `fs.existsSync` check before accepting the vendored path so the PATH
fallback actually engages. That is Pass 3 deliverables #1–#2; the existsSync
detail is the part not currently specified.

---

### B4 — There is no macOS install or packaging path

**Severity: blocker**

Everything in `premiere-plugin/installer/` is Windows-only. Enumerating the
OS-specific assumptions, since Pass 1 asks for all of them:

**Registry.** `installer/install.ps1:20-24` and `installer/dev-install.ps1:16-20`
write `HKCU:\Software\Adobe\CSXS.{9,10,11,12}\PlayerDebugMode = "1"`. macOS uses
`defaults write com.adobe.CSXS.<n> PlayerDebugMode 1` — no equivalent exists.

**Install directory.** `installer/install.ps1:33` uses
`$env:APPDATA\Adobe\CEP\extensions`; `installer/uninstall.ps1:8` and
`installer/dev-install.ps1:31` the same. macOS is
`~/Library/Application Support/Adobe/CEP/extensions`.

**Shell and executables.** `installer/install.bat:5` and
`installer/uninstall.bat:3` invoke `powershell -NoProfile -ExecutionPolicy Bypass`.
`.bat` does not execute on macOS; a macOS equivalent must be a `.command` file
with the exec bit set.

**Copy tooling.** `installer/install.ps1:39`, `installer/package.ps1:48`, and
`installer/dev-install.ps1:41` all use `robocopy` — Windows-only, and its
`$LASTEXITCODE >= 8` convention (`install.ps1:42`) has no cross-platform analogue.

**Symlink.** `installer/dev-install.ps1:37` uses
`New-Item -ItemType SymbolicLink`, which needs Admin or Developer Mode on Windows
(the script handles that at `dev-install.ps1:39-42`). On macOS `ln -s` needs
neither.

**Archive format.** `installer/package.ps1:63` `Compress-Archive` — see B3 for
the executable-bit loss.

**Program-folder discovery.** `premiere-plugin/js/main.js:51-70` — see B6.

**Opening a folder.** `premiere-plugin/js/main.js:735` and
`premiere-plugin/js/main.js:859` spawn `explorer` (see the Bugs section — this
one is also a crash risk, not just a no-op).

**Path separators.** These are mostly handled well and worth recording as *not*
a problem: `js/main.js:873` `base()` splits on both separators; `jsx/host.jsx:68`
`normPath` normalises backslashes; `jsx/captions.jsx:66` forward-slashes the
MOGRT path for `importMGT`; `js/ffmpeg.js:144` and `export/media.cjs:684` apply
the libass escaping (`\` → `/`, `:` → `\:`). No shell string concatenation
anywhere — all spawns pass argv arrays.

**Smallest fix:** Pass 3 deliverables #3 and #5 as written (Node-only builder +
`install.command`). One addition: `install.command` must also `chmod +x` the
vendored ffmpeg/ffprobe and clear `com.apple.quarantine`, which Pass 3 already
calls out.

---

### B5 — Concurrency and durability assumptions are unenforced

**Severity: blocker (for a hosted deployment)**

**Statefulness.** `backend/app.py:61` holds `_JOBS` in process memory.
`backend/job_store.py:24` writes the durable copy to
`Path(__file__).parent / "jobs.db"` — i.e. *inside the source tree*, which in a
container means inside the image layer. Without a volume mounted at that exact
path, every restart loses all job state; `.gitignore:26` already excludes it
locally.

**The multi-worker hazard is real and correctly identified.** `_bootstrap_jobs()`
is called at module import (`backend/app.py:376`), not inside a FastAPI startup
event. Two uvicorn workers import the module twice, so each independently loads
every persisted in-flight job (`backend/app.py:340`) and spawns resume threads.
For `kind == "select"` (`backend/app.py:355-373`) that re-runs
`analyze_with_claude` — a real Claude charge, doubled per worker. For
`kind == "transcribe"` it double-polls the same Rev.ai job (cheap, but both
workers race to write the result).

There is one existing mitigation worth noting: `_MAX_SELECT_RESUME_ATTEMPTS = 5`
(`backend/app.py:335`, enforced at `backend/app.py:360-367`) caps a poison-pill
transcript from re-billing forever. It caps *per job row*, not per worker, so two
workers still burn two calls per restart.

**Scale-to-zero breaks in-flight work.** Jobs run on
`threading.Thread(..., daemon=True)` (`backend/app.py:260`,
`backend/app.py:302`). Daemon threads are killed at process exit with no cleanup.
A scale-to-zero host that idles out during a 20-minute transcription kills the
poller. Transcription recovers on next boot via `revai_job_id`
(`backend/app.py:112-138`) — genuinely good design. Selection does not recover
free: it re-runs, paying again for at least the reel-selection call, though the
`cleaned_words` checkpoint (`backend/app.py:194`) does spare the cleanup call.
Also, HTTP keep-alive means the panel's poller (`js/backend.js:138-149`,
30-minute ceiling) will see a connection error, not a clean status.

**Request size.** `backend/app.py:239` does `body = await request.body()`, which
buffers the entire upload in RAM before writing it to a temp file
(`backend/app.py:244-246`). At the panel's 64 kbps mono encoding
(`js/ffmpeg.js:109-111`) a 60-minute interview is ~29 MB; a 3-hour multi-cam day
is ~86 MB. Two concurrent uploads are two copies resident. Most PaaS ingress
proxies default well below that — this needs an explicit body-size limit raised
on whichever host is chosen. `/select` is also large: it posts the full
word-level transcript as JSON (`js/backend.js:160`), which for a 60-minute
interview is several MB.

**Timeouts.** Client-side: `js/backend.js:25` 15 s and `js/backend.js:101` 20 s.
Both are Node's socket-*inactivity* timeout, not a total-duration cap, so a slow
but progressing multi-MB `/jobs/{id}` response is not at risk. The endpoints
themselves all return immediately (work is handed to a thread), so no long-lived
request needs an ingress timeout raised. The only long timeout that matters is
the poll ceiling at `js/backend.js:138` (30 min), which is under Rev.ai's own
30-minute cap at `src/transcription.py:107-108`.

**Smallest fix:** pin one replica and `--workers 1` in the host config (not a
comment); mount a volume and point `DB_PATH` at it via env; move
`_bootstrap_jobs()` into a startup handler so the import-time double-execution
stops being the thing standing between you and a second worker.

---

### B6 — macOS preset and MOGRT discovery looks in a path that cannot exist

**Severity: blocker on macOS (silent quality regression, not a crash)**

```js
// premiere-plugin/js/main.js:51-70
const bases = process.platform === "darwin" ? ["/Applications"] : [...];
for (const d of fs.readdirSync(b)) {
  if (/Premiere Pro/i.test(d)) {
    out.push(process.platform === "darwin" ? path.join(b, d, "Contents") : path.join(b, d));
  }
}
```

On macOS, `/Applications/Adobe Premiere Pro 2025` is a **folder** containing
`Adobe Premiere Pro 2025.app`. The `Contents` directory lives inside the `.app`
bundle, so the constructed path
`/Applications/Adobe Premiere Pro 2025/Contents` does not exist. Both
`findVerticalPreset()` (`js/main.js:76`) and `findCaptionMogrt()`
(`js/main.js:94`) then return `""`.

The consequences are silent-ish rather than loud. With no preset,
`createVerticalSequence` (`jsx/host.jsx:373-374`) pushes a warning and falls back
to the project default raster — reels come out 16:9, not 1080×1920. With no
MOGRT, `payload.captionMode` becomes `"native"` (`js/main.js:593`) and every reel
ships an SRT the editor must drag on by hand (`jsx/captions.jsx:237-260`). A
macOS editor gets a materially worse product and only a toast
(`js/main.js:351`) explaining half of it.

**Smallest fix:** on darwin, glob one level deeper — `path.join(b, d, d + ".app", "Contents")`
plus a direct `path.join(b, d, "Contents")` fallback for the case where the
`.app` sits at the top of `/Applications` — and keep `firstExisting` semantics so
a wrong guess costs nothing.

---

## Bugs

### Bu1 — `spawn("explorer")` will throw an unhandled error event on macOS

**Severity: bug**

```js
// premiere-plugin/js/main.js:734-738 (and identically at 858-862)
try {
  require("child_process").spawn("explorer", [baseDir], { detached: true, windowsHide: true });
} catch (e) {
  /* folder still written; just couldn't auto-open */
}
```

`spawn` does not throw synchronously on a missing executable — it emits an
asynchronous `'error'` event. The `try`/`catch` cannot catch that. With no
`.on("error")` listener attached, Node's EventEmitter rethrows, so on macOS
(where `explorer` does not exist) both "Save all SRTs" and "Save .txt" raise an
uncaught error *after* successfully writing the files.

**Unverified — needs a test on real hardware:** whether CEP's CEF surfaces this
as a panel-killing exception or merely logs it. Either way the comment's promise
("folder still written; just couldn't auto-open") is not what happens.

**Smallest fix:** attach a no-op `.on("error", () => {})`, and pick the opener by
platform (`explorer` / `open`).

### Bu2 — `purge_older_than()` runs only at startup

**Severity: bug**

`backend/job_store.py:115-122` deletes rows older than 24 h, but it is called
exactly once, from `_bootstrap_jobs()` at `backend/app.py:339` — i.e. at import.
On an always-on single instance (which is precisely the deployment Pass 4 asks
for) it therefore never runs again. Every job row stores its full payload
(`backend/job_store.py:85` `json.dumps(data)`), and for `select` jobs that
includes the entire transcript (`backend/app.py:293`) and, mid-run, the entire
cleaned word list (`backend/app.py:194`). `jobs.db` grows without bound, and
`_JOBS` in memory grows with it (`backend/app.py:342` never evicts).

**Smallest fix:** call `purge_older_than()` on a timer, or opportunistically from
`_create`.

### Bu3 — `.env.example` is referenced five times and does not exist

**Severity: bug**

`git ls-files` has no `.env.example`. It is referenced at `README.md:19`,
`README.md:22`, `README.md:78`, `README.md:157`, and — worst — in the error
message a first-time user actually hits: `generate_reels.py:213`
`"Copy .env.example to .env and add your API keys."` Commit `855bad7` is titled
"Add .env.example template…", so it was presumably written and then lost to
`.gitignore`; note `.gitignore:1` ignores `.env`, not `.env.example`, so nothing
currently prevents committing it.

**Smallest fix:** add it (Pass 4 already lists this).

### Bu4 — Shipped `config.json` points at localhost

**Severity: bug**

`premiere-plugin/config.json:2` is `http://127.0.0.1:8722`. If a release is cut
without `-BackendUrl` (`installer/package.ps1:16-18,37-43`), every editor who
installs it gets "Backend not reachable" (`js/main.js:343`) and has no way to fix
it except editing JSON inside the installed extension. The failure is at least
legible, but the packaging step has no guard against shipping it.

**Smallest fix:** make `package.ps1`/`build-panel.mjs` refuse to build a
distributable bundle when `backendUrl` resolves to a loopback address, unless an
explicit `-AllowLocalhost` flag is passed.

### Bu5 — Desktop app hardcodes a repo-relative `.venv`

**Severity: bug (in the superseded component)**

`desktop/src/main/export.js:20-21,36-42` and `desktop/src/main/sync.js:16-24`
resolve `REPO_ROOT/.venv/Scripts/python.exe` (or `bin/python`), falling back to
`python`/`python3` on PATH, and spawn with `cwd: REPO_ROOT`
(`export.js:143`, `sync.js:53`). This only works when the app runs from a checkout
— which `desktop/README.md:84-86` acknowledges. Listed for completeness since the
Premiere extension supersedes this path (see Dead code).

### Bu6 — `Segoe UI Black` is hardcoded in the ASS caption style

**Severity: bug (CLI/desktop render path only)**

`export/media.cjs:215` sets `KARAOKE_FONT = "Segoe UI Black"`, used in all three
style rows (`export/media.cjs:363-365`). That font ships with Windows and not
with macOS. libass will silently substitute a default face, so the same
`analysis.json` renders with different typography depending on which machine ran
the export. Does not affect the Premiere panel (captions go through
`jsx/captions.jsx`, not ASS).

**Smallest fix:** a per-platform font constant, or ship the face and pass
`fontsdir` to the `subtitles` filter.

### Bu7 — `evalScript` payload size on "Build all"

**Severity: bug — unverified, needs a test on real hardware**

`js/main.js:236` embeds the whole build payload as a double-JSON-encoded string
literal into an ExtendScript expression, and `js/main.js:612` sends **all** reels
in one call. The payload carries every caption block with its full per-word
objects (`js/captions.js:127`). Rough arithmetic: a 60 s reel at conversational
pace is ~150 words → ~50 blocks at `CAPTION_CHUNK_SIZE = 3` (`js/main.js:32`) →
on the order of 15 KB per reel, so ~150 KB for ten reels, roughly doubled by
JSON-escaping. That is probably under CEP's practical `evalScript` limit, but the
limit is not documented by Adobe and the code has no chunking or size guard.

**How to check:** build 20 reels from a 90-minute source and watch for a
truncated-JSON failure in `host()`'s parse path (`js/main.js:225-230`).

**Smallest fix if it bites:** write the payload to a temp file and pass the path.

### Bu8 — `.debug` ships in the dev-install fallback

**Severity: bug (minor)**

`installer/package.ps1:50` correctly excludes `.debug` from release bundles, so
editors are unaffected. But `installer/install.ps1:39-41` excludes only
`.gitignore`, and its dev fallback at `install.ps1:30-32` points `$source` at the
live plugin folder — so a dev install copies `.debug` in, opening the remote
debug port on 8088 (`premiere-plugin/.debug:10`). Acceptable for a dev machine;
just not something to inherit into any future Node builder.

---

## Runtime compatibility in the panel

**ExtendScript (`jsx/`) is clean — this is a positive finding.** ExtendScript is
ES3 with partial ES5. I checked the host layer for post-ES3 constructs and found
none: no `Array.isArray`, no `Array.prototype.forEach/map/filter`, no
`String.prototype.trim`, no arrow functions, no `let`/`const`. Everything is
`var` + indexed `for` loops (`jsx/host.jsx:73`, `jsx/host.jsx:189`,
`jsx/captions.jsx:69`), `String.indexOf` (`jsx/captions.jsx:211`), `isFinite`
(`jsx/captions.jsx:287`), `substring` (`jsx/host.jsx:539`). `JSON` is supplied by
`jsx/json2.js`, loaded explicitly rather than via `//@include` — and the reason
is documented at `jsx/host.jsx:23-28`. The implicit-global pattern
(`jsx/host.jsx:32`, `jsx/captions.jsx:26`) is deliberate and correct for
`$.evalFile` scoping.

**The CEF panel (`js/`) is also within range, but the manifest understates the
floor.** The panel uses object spread (`js/main.js:361` `{...r, built: false}`;
`js/captions.js:80` `{...raw, ...}`), template literals, `async`/`await`, and
`String.prototype.padStart` (`js/main.js:696`). Highest requirement is object
spread in object literals — ES2018, Chrome 60. There is **no** optional chaining
or nullish coalescing anywhere in `premiere-plugin/` (grepped; zero matches),
which is the usual thing that breaks on older CEF. So the panel code is
comfortably inside what any CEP 9+ CEF provides.

The `.gitignore`d `node_modules` aside, one manifest detail is worth flagging:
`CSXS/manifest.xml:30` declares `<RequiredRuntime Name="CSXS" Version="9.0"/>`
while `manifest.xml:24` allows `PPRO [15.0,99.9]`. Premiere 15.0 is 2021. The
installer meanwhile sets `PlayerDebugMode` for CSXS 9 through 12
(`install.ps1:20`), which is a superset and harmless.

**Unverified — needs a test on real hardware:** whether
`--enable-nodejs` + `--mixed-context` (`manifest.xml:40-41`) behave identically
across the CEP versions spanned by that host range, and whether `require()` of
absolute paths (`js/main.js:25-28`) works on all of them. This is the single
highest-value thing to test on an actual macOS Premiere install, because if Node
integration differs the entire `js/` layer is affected, not one function.

Two Premiere-API items the README already flags honestly
(`premiere-plugin/README.md:94-114`) and that I can confirm are written
defensively rather than assumed: `insertClip` with an `overwriteClip` fallback
(`jsx/host.jsx:316-319`), `setInPoint` with a two-signature fallback
(`jsx/host.jsx:415-430`), `importMGT` presence-checked before use
(`jsx/captions.jsx:52,57`), and `attachProxy` presence-checked
(`jsx/host.jsx:557`). Nothing to fix; recording it so Pass 2 does not "clean up"
the fallbacks.

---

## Documentation drift

| Where | Says | Reality |
|---|---|---|
| `README.md:19,22,78,157`; `generate_reels.py:213` | copy `.env.example` | file does not exist (Bu3) |
| `README.md:4` | "this repo has **three components**" | the table immediately below lists four (`README.md:9-12`) |
| `README.md:146-158` | folder layout rooted at `the reels tool logic - main file/`, listing only CLI files | wrong root name; omits `backend/`, `desktop/`, `premiere-plugin/` |
| `README.md:16` | "FFmpeg + ffprobe on your PATH" as a prerequisite for **all** components | the Premiere plugin bundles its own (`premiere-plugin/package.json:10-12`) and `premiere-plugin/README.md:37-38` says editors need nothing installed |
| `README.md:68` | Python 3.11+ | no `python_requires` anywhere; local interpreter is 3.10.0 and the code's `from __future__ import annotations` usage makes 3.9+ sufficient |
| `premiere-plugin/README.md:33` | "Windows-first, **macOS supported**" | no macOS install path exists (B4), and preset detection is broken there (B6) |
| `premiere-plugin/README.md:23` | lists `export/media.cjs` and `export_cli.py` under "**Removed**" | both still exist and are still used by the CLI and desktop app |
| `premiere-plugin/README.md:80`; `installer/README-EDITORS.txt:18` | "pick how many reels **and a caption style**" | no caption-style control exists in `index.html`; removed per `js/main.js:30-32` |
| `installer/README-EDITORS.txt:19` | button labelled "Build all in Premiere" | actual label is "🎬 Build reels" (`index.html:72`) |
| `backend/README.md:26` | `.venv/Scripts/python -m uvicorn …` | Windows-only path in the doc for a service being containerised |
| `backend/README.md:17-18` | "in-memory registry (single-instance; swap for Redis to scale)" | accurate, but nothing *enforces* single-instance (B5) |
| `docs/AGENT-PROMPT.md` (Passes 2–4) | references `docs/SHIPPING.md` | not present on disk at audit time — see Method note |

Checked and **correct**, for the record: `desktop/README.md:35` `npm run smoke`
(`desktop/package.json:12`), `desktop/README.md:30` `scripts/launch.js`
(exists), `README.md:108` `--export-only --job-dir` (`generate_reels.py:146-154`),
`README.md:100` `--transcript` (`generate_reels.py:140`), `README.md:42-44`
`cd premiere-plugin && npm install`, and `premiere-plugin/README.md:74` that
presets are picked up by `package.ps1` (`installer/package.ps1:48`, which copies
the whole root).

---

## Dead or superseded code

Given that the Premiere extension supersedes the desktop app's render path:

**Dead now, no dependents:**

- `premiere-plugin/js/ffmpeg.js:138-164` `renderCaptionOverlay` — exported at
  `:194`, called nowhere. This is the *only* consumer of libass and `prores_ks`
  in the panel. Deleting it removes two hard requirements from the vendored
  binary (see B3).
- `export/media.cjs:763-789` `createProxy` — exported at `:797`, called nowhere.
  The desktop app uses its own `desktop/src/main/ffmpeg.js:103` `generateProxy`;
  the panel uses `premiere-plugin/js/ffmpeg.js:173` `renderProxy`. Three proxy
  implementations, one unused.
- `Pillow` in `requirements.txt:5` — no `PIL` import anywhere.

**Superseded but still live — do not delete without a decision:**

- `desktop/` as a whole. `premiere-plugin/README.md:19-23` states Premiere now
  owns rendering, proxying, the timeline, and reframing. But `desktop/` still
  drives `export_cli.py` → `export_pipeline.py` → `export/media.cjs`
  (`desktop/src/main/export.js:21,142`), and `desktop/test/model.test.js` is the
  repo's only automated test — which Pass 2 wants to run after every commit.
  Killing `desktop/` also kills the test suite.
- `export/media.cjs` + `export_cli.py` + `export_pipeline.py`. Superseded *for
  the panel*, but they are the CLI's entire render path
  (`generate_reels.py:291`). The CLI is a documented product
  (`README.md:53-111`).
- `src/camera_sync.py` + `sync_cameras_cli.py`. Reached only from
  `desktop/src/main/sync.js:17`. Sole reason `numpy` is a dependency
  (`src/camera_sync.py:20`). Dead if `desktop/` goes; alive otherwise.
- `premiere-plugin/package.json:6-8` — the `postinstall` script is a
  `console.log`. Harmless, but it is the sort of thing a Node builder should not
  inherit.

I have not proposed deleting any of these. Pass 2's "stop and ask before
deleting anything" is the right instinct: the only genuinely safe deletions
today are `renderCaptionOverlay`, `createProxy`, and the `Pillow` requirement.

---

## Appendix — verifying the unverified claims

```bash
# B3: what the vendored binary can actually do
cd premiere-plugin && npm install
node -e "console.log(require('ffmpeg-static'))"
"$(node -e "process.stdout.write(require('ffmpeg-static'))")" -hide_banner -encoders  | grep -E 'libmp3lame|libx264|prores_ks'
"$(node -e "process.stdout.write(require('ffmpeg-static'))")" -hide_banner -filters   | grep -E '\bsubtitles\b|\bscale\b'

# B2: does the backend import chain hold without ffmpeg on PATH?
python -c "import sys; sys.path.insert(0,'.'); import backend.app; print('ok')"

# Bu7: evalScript payload size
#   generate 20 reels from a 90-min source, click "Build reels", then inspect
#   %TEMP%/istv-reel-tool-lastbuild.json (js/main.js:618) for a truncated result
```

The `--enable-nodejs` / `--mixed-context` question (Runtime compatibility) and
the macOS half of B4/B6 cannot be settled without a Mac running Premiere. Those
two are the highest-value hardware tests before Pass 3.
