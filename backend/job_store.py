"""Durable job registry backing `_JOBS` in app.py.

The in-memory dict alone loses every in-flight job (transcription, Claude
selection) if the process crashes or restarts — for a long transcription that can
mean redoing an hour of work. This writes job state through on every update, so
`app.py` can reload it on startup and either reattach to the still-running
external job (Rev.ai) or, where no external job exists to reattach to (Claude
selection), re-run it from the saved input instead of losing the request.

TWO BACKENDS, same four-function interface:

  Postgres  when ISTV_DATABASE_URL or DATABASE_URL is set.
            The right choice for any real deployment, and required on hosts with
            no persistent disk — a Render *native* service has none, so a SQLite
            file there lives on ephemeral storage and is wiped on every restart,
            silently defeating the entire point of this module.

  SQLite    otherwise. Zero setup for local development: stdlib, no service to
            run. Fine for a single process on a real disk.

The table is named `istv_reel_jobs`, not `jobs`, because the Postgres instance is
expected to be a SHARED one that already has other applications' tables in it.
Override with ISTV_DB_TABLE if even that collides.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time
from pathlib import Path

_log = logging.getLogger(__name__)

# Deliberately not "jobs" — see the module docstring.
TABLE = os.getenv("ISTV_DB_TABLE") or "istv_reel_jobs"
if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", TABLE):
    # Table names cannot be parameterised, so they are interpolated into SQL.
    # Validate rather than trust the environment.
    raise ValueError(f"ISTV_DB_TABLE must be a plain identifier, got {TABLE!r}")

DATABASE_URL = (os.getenv("ISTV_DATABASE_URL") or os.getenv("DATABASE_URL") or "").strip()

# SQLite path, used only when there is no DATABASE_URL. The default sits next to
# this file, which is fine locally but is INSIDE THE IMAGE LAYER in a container.
DB_PATH = Path(os.getenv("ISTV_JOBS_DB") or (Path(__file__).resolve().parent / "jobs.db"))


# ── SQLite ────────────────────────────────────────────────────────────────────


class _SqliteStore:
    """Single connection guarded by a lock. Self-heals a corrupted file."""

    backend = "sqlite"

    _CREATE = f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
            job_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            data TEXT NOT NULL,
            updated_at REAL NOT NULL
        )
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._conn = self._connect()
        self.location = str(DB_PATH)

    def _connect(self) -> sqlite3.Connection:
        """Open the DB, quarantining the file if it is itself corrupted.

        This module exists to survive crashes — it would be self-defeating if a
        corrupted file (itself the product of a crash mid-write) instead took down
        the whole backend at import time.
        """
        conn = None
        try:
            conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
            conn.execute(self._CREATE)
            conn.commit()
            return conn
        except sqlite3.DatabaseError as exc:
            _log.error("%s is corrupted (%s); quarantining and starting fresh", DB_PATH.name, exc)
            if conn is not None:
                # Must close before rename/unlink — Windows keeps an open file
                # locked, so a live handle makes the rename fail silently and we
                # would reopen the same corrupted file.
                conn.close()
            quarantine = DB_PATH.with_name(f"{DB_PATH.name}.corrupt-{int(time.time())}")
            try:
                DB_PATH.rename(quarantine)
            except OSError:
                try:
                    DB_PATH.unlink()
                except OSError:
                    pass
            conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
            conn.execute(self._CREATE)
            conn.commit()
            return conn

    def save(self, job_id: str, kind: str, data: dict) -> None:
        with self._lock:
            self._conn.execute(
                f"INSERT INTO {TABLE} (job_id, kind, data, updated_at) "
                "VALUES (?, ?, ?, strftime('%s','now')) "
                "ON CONFLICT(job_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
                (job_id, kind, json.dumps(data)),
            )
            self._conn.commit()

    def rows(self) -> list[tuple[str, str, str]]:
        with self._lock:
            return self._conn.execute(f"SELECT job_id, kind, data FROM {TABLE}").fetchall()

    def delete(self, job_id: str) -> None:
        with self._lock:
            self._conn.execute(f"DELETE FROM {TABLE} WHERE job_id = ?", (job_id,))
            self._conn.commit()

    def purge_older_than(self, max_age_seconds: int) -> int:
        with self._lock:
            cur = self._conn.execute(
                f"DELETE FROM {TABLE} WHERE updated_at < strftime('%s','now') - ?",
                (max_age_seconds,),
            )
            self._conn.commit()
            return cur.rowcount or 0


# ── Postgres ──────────────────────────────────────────────────────────────────


class _PostgresStore:
    """Connect-per-operation against Postgres.

    Deliberately not holding a long-lived connection. The write rate is tiny (a
    few statements per job per poll tick), while a persistent connection has to
    survive idle timeouts, failovers and network blips — reconnect logic that
    would be far more code than it saves. Connect-per-op is stateless and cannot
    go stale.

    Rows are stored as TEXT, not JSONB, so both backends behave identically: the
    caller always parses the JSON itself.
    """

    backend = "postgres"

    _CREATE = f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
            job_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            data TEXT NOT NULL,
            updated_at DOUBLE PRECISION NOT NULL
        )
    """

    def __init__(self, url: str) -> None:
        try:
            import psycopg  # noqa: F401
        except ImportError as exc:  # pragma: no cover - deploy-time misconfiguration
            raise RuntimeError(
                "ISTV_DATABASE_URL/DATABASE_URL is set but psycopg is not installed. "
                "Add it: pip install -r backend/requirements.txt"
            ) from exc
        self._psycopg = __import__("psycopg")
        self._url = url
        # Redacted form for logs — a connection string carries the password.
        self.location = re.sub(r"://[^@/]*@", "://***@", url)
        with self._connect() as conn:
            conn.execute(self._CREATE)
            conn.commit()

    def _connect(self):
        # 10s cap so a wedged DB surfaces as an error rather than hanging a
        # request thread indefinitely.
        return self._psycopg.connect(self._url, connect_timeout=10)

    def save(self, job_id: str, kind: str, data: dict) -> None:
        with self._connect() as conn:
            conn.execute(
                f"INSERT INTO {TABLE} (job_id, kind, data, updated_at) "
                "VALUES (%s, %s, %s, EXTRACT(EPOCH FROM now())) "
                "ON CONFLICT (job_id) DO UPDATE SET data=EXCLUDED.data, updated_at=EXCLUDED.updated_at",
                (job_id, kind, json.dumps(data)),
            )
            conn.commit()

    def rows(self) -> list[tuple[str, str, str]]:
        with self._connect() as conn:
            return conn.execute(f"SELECT job_id, kind, data FROM {TABLE}").fetchall()

    def delete(self, job_id: str) -> None:
        with self._connect() as conn:
            conn.execute(f"DELETE FROM {TABLE} WHERE job_id = %s", (job_id,))
            conn.commit()

    def purge_older_than(self, max_age_seconds: int) -> int:
        with self._connect() as conn:
            cur = conn.execute(
                f"DELETE FROM {TABLE} WHERE updated_at < EXTRACT(EPOCH FROM now()) - %s",
                (max_age_seconds,),
            )
            conn.commit()
            return cur.rowcount or 0


# ── Active store ──────────────────────────────────────────────────────────────


def _build_store():
    if DATABASE_URL:
        store = _PostgresStore(DATABASE_URL)
        _log.info("job store: postgres table %s at %s", TABLE, store.location)
        return store
    store = _SqliteStore()
    _log.info("job store: sqlite at %s", store.location)
    return store


_store = _build_store()

# What backend is live — surfaced by /health so a deploy that silently fell back
# to ephemeral SQLite is visible rather than discovered after losing a job.
BACKEND = _store.backend
LOCATION = _store.location


# Opportunistic purge state. purge_older_than() used to be called only from
# startup, so on an always-on instance it never ran again and the table grew
# without bound — every row stores its full payload, and for `select` jobs that
# includes the entire word-level transcript. That is a few MB per job sitting in a
# SHARED Postgres instance, so it is now also swept during normal operation.
_PURGE_EVERY_SECONDS = 3600
_last_purge = time.monotonic()
_purge_lock = threading.Lock()


def _maybe_purge() -> None:
    global _last_purge
    with _purge_lock:
        if time.monotonic() - _last_purge < _PURGE_EVERY_SECONDS:
            return
        _last_purge = time.monotonic()
    try:
        purge_older_than()
    except Exception as exc:  # never let housekeeping break a live job write
        _log.warning("opportunistic purge failed: %s", exc)


def save(job_id: str, kind: str, data: dict) -> None:
    _store.save(job_id, kind, data)
    _maybe_purge()


def load_all() -> list[tuple[str, str, dict]]:
    """All persisted jobs, dropping any row whose JSON is corrupted.

    One bad row (e.g. a partial write from the very crash this store exists to
    survive) must not take down the whole backend on startup.
    """
    out: list[tuple[str, str, dict]] = []
    bad_ids: list[str] = []
    for job_id, kind, data in _store.rows():
        try:
            out.append((job_id, kind, json.loads(data)))
        except (json.JSONDecodeError, TypeError):
            _log.error("job %s has corrupted data; dropping it", job_id)
            bad_ids.append(job_id)
    for job_id in bad_ids:
        delete(job_id)
    return out


def delete(job_id: str) -> None:
    _store.delete(job_id)


def purge_older_than(max_age_seconds: int = 86400) -> None:
    """Drop finished/stale rows so the table doesn't grow unbounded."""
    removed = _store.purge_older_than(max_age_seconds)
    if removed:
        _log.info("purged %d job row(s) older than %ds", removed, max_age_seconds)
