# ISTV Reels — Backend

FastAPI service that holds the API keys server-side and reuses the repo's pipeline
modules (`src/transcription.py`, `src/transcript_cleanup.py`, `src/analyzer.py`).
Clients upload **only compressed audio** — the full video never reaches this service.

This is what the Premiere plugin talks to. Editors never see a key.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET  | `/health` | open | Liveness + whether each key is configured |
| POST | `/transcribe` | bearer | Raw audio body (`octet-stream`, `X-Filename` header) → starts a Rev.ai job, returns `{job_id}` |
| POST | `/select` | bearer | JSON `{transcript, name, num_reels}` → starts Claude selection, returns `{job_id}` |
| GET  | `/jobs/{id}` | bearer | Poll status/progress; on `done` includes `transcript` or `analysis` |

`/select` applies the same `updated_v2_test2` profile the CLI uses, so reels match
the approved behaviour (including the ±10s completeness tuning).

## Auth

`/transcribe` and `/select` spend real money — Rev.ai minutes and Claude Opus at
`max_tokens=12000` — and `/jobs` returns the transcripts and analysis. All three
require `Authorization: Bearer <ISTV_API_TOKEN>`.

`/health` is deliberately open so platform health checks and smoke tests work; it
reports only *whether* keys are set, never their values.

**If `ISTV_API_TOKEN` is unset the service runs open** and logs a warning at
startup. That is the right default for localhost and the wrong one anywhere else.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `REVAI_API_KEY` | yes | Rev.ai transcription |
| `CLAUDE_API_KEY` | yes | Claude cleanup + reel selection |
| `ISTV_API_TOKEN` | for any non-local deploy | Shared bearer token clients must send |
| `ISTV_DATABASE_URL` | recommended | Postgres connection string for the durable job registry. See **Job storage** below |
| `ISTV_JOBS_DB` | SQLite path only | Path to the SQLite job DB, used only when no `ISTV_DATABASE_URL` is set. **Needs a mounted volume** — the default is inside the image layer |
| `ISTV_DB_TABLE` | no | Job table name. Defaults to `istv_reel_jobs` |
| `ISTV_CORS_ORIGINS` | no | Comma-separated allowed origins. Empty = closed. Both real clients call from Node, not a browser, so this is normally left empty |

Locally, keys are read from the repo-root `.env` (see `.env.example`).

## Job storage

In-flight jobs (a running transcription, a running Claude selection) are held in an
in-process dict and **written through to a durable store**, so a crash or restart
reloads them instead of losing an hour of transcription. Two backends, one
interface:

| | When | Notes |
|---|---|---|
| **Postgres** | `ISTV_DATABASE_URL` (or `DATABASE_URL`) is set | What any real deployment should use |
| **SQLite** | otherwise | Zero setup for local development |

**Use Postgres if you have one.** It is not just a preference on Render:

- A **native** Render service has **no persistent disk at all**, so a SQLite file
  there sits on ephemeral storage and is wiped on every restart — silently
  defeating the point of the durable store. Verified: a job written before a
  restart is recovered from Postgres with its `revai_job_id` intact (so the poller
  reattaches without re-uploading), and is simply gone from ephemeral SQLite.
- It removes the need for a paid disk, and therefore for a Docker service.

Point it at an existing shared instance safely: the table is named
**`istv_reel_jobs`**, not `jobs`, so it will not collide with another
application's table. Override with `ISTV_DB_TABLE` if needed. Nothing else in the
database is read or written.

```bash
ISTV_DATABASE_URL="postgresql://user:pass@host:5432/dbname" \
  python -m uvicorn backend.app:app --port 8722
```

`GET /health` reports which store is live (`"job_store": "postgres"`,
`"durable": true`) so a deploy whose `ISTV_DATABASE_URL` never arrived is visible
immediately rather than discovered after losing a job. The connection string is
never echoed — logs and `/health` show a redacted form.

Stale rows are swept hourly during normal operation as well as at startup. That
matters on a shared database: every row stores its full payload, and for a
`select` job that includes the entire word-level transcript.

## Run locally

```bash
pip install -r backend/requirements.txt
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8722
```

`backend/requirements.txt` is now self-contained — it previously listed only
fastapi/uvicorn and deferred the rest to the root file, which made the service
impossible to containerise on its own.

## Run in Docker

Build from the **repo root**, not from `backend/` — `app.py` puts the repo root on
`sys.path` and imports `src/` and `generate_reels.py`, so a `backend/`-only context
produces an image that fails at import:

```bash
docker build -f backend/Dockerfile -t istv-reels-backend .

docker run -p 8722:8722 \
  -e ISTV_API_TOKEN=<token> \
  -e REVAI_API_KEY=<key> \
  -e CLAUDE_API_KEY=<key> \
  -v istv-jobs:/data \
  istv-reels-backend
```

~285 MB image, non-root, honours `$PORT`, no ffmpeg (the backend's import path
never calls it — audio arrives already compressed).

## Deploy to Render

A blueprint is committed at [`../render.yaml`](../render.yaml):

1. Render dashboard → **New ▸ Blueprint** → pick this repo.
2. Render prompts for `REVAI_API_KEY` and `CLAUDE_API_KEY` (they're marked
   `sync: false`, so they stay out of git). `ISTV_API_TOKEN` is generated for you.
3. After the deploy, copy the generated `ISTV_API_TOKEN` from
   **Environment**, then build the plugin against it:

```bash
cd premiere-plugin
node tools/build.mjs --backend-url https://<service>.onrender.com --auth-token <token>
```

4. Verify: `curl https://<service>.onrender.com/health` should return
   `revai_key: true, claude_key: true`.

**Use a paid instance type (`starter` or above).** The free tier has no persistent
disk, so `ISTV_JOBS_DB` lands on an ephemeral filesystem, and free instances spin
down when idle — which kills a 20-minute transcription poll mid-flight.

## Scaling — read before adding a second instance

**One worker, one replica.** Job state is an in-process dict (`_JOBS`) written
through to SQLite, and startup resumes in-flight jobs. A second worker or replica
resumes *the same* jobs and re-runs them: for a `select` job that is a second real
Claude Opus call. Both `render.yaml` (`numInstances: 1`) and the Dockerfile
(`--workers 1`) pin this.

Resumption used to run at module *import*, which meant two workers double-billed on
every restart. It is now in a startup handler, so it runs once per process — that
makes a second worker merely wrong rather than actively expensive. Scaling out
properly needs the registry moved to Redis first.

Known remaining limits, in rough priority order:

- **Uploads are buffered in RAM.** `await request.body()` holds the whole upload
  before writing it to a temp file. At the panel's 64 kbps mono encoding a 60-minute
  interview is ~29 MB, a 3-hour multi-cam day ~86 MB. Raise your host's request
  body limit accordingly.
- **Scale-to-zero breaks in-flight work.** Jobs run on daemon threads, killed at
  process exit. Transcription recovers on next boot via the stored Rev.ai job id;
  selection re-runs and re-bills.

## Tests

```bash
python -m pip install -r backend/requirements.txt httpx
python backend/test_backend.py
```

16 checks: the auth guard on each route (including a token prefix, a token with
trailing junk, and a missing `Bearer` prefix), that `/health` stays open and leaks
no key values, and that the declared dependency list really is sufficient — `PIL`
and `numpy` are deliberately excluded and the test fails if either returns to the
import path.
