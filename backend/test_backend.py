"""Backend tests: the auth guard, and that the declared dependencies are enough.

Run with no test framework:

    python -m venv .venv
    .venv/Scripts/python -m pip install -r backend/requirements.txt httpx
    .venv/Scripts/python backend/test_backend.py

The auth cases are the ones worth keeping honest. /transcribe and /select spend
real money (Rev.ai minutes, Claude Opus at max_tokens=12000) and /jobs returns the
transcripts and analysis, so a regression that opens any of them is a budget leak
rather than a bug. /health must stay open or platform health checks fail and the
service gets marked unhealthy and restarted.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

TOKEN = "test-token-not-a-real-secret"
os.environ["ISTV_API_TOKEN"] = TOKEN
# Keep the test off any real durable state.
os.environ["ISTV_JOBS_DB"] = str(Path(os.environ.get("TEMP", "/tmp")) / "istv-test-jobs.db")

from fastapi.testclient import TestClient  # noqa: E402

import backend.app as app_module  # noqa: E402

_failures: list[str] = []


def _backdate(js, job_id: str, seconds_ago: int) -> None:
    """Age a row by rewriting updated_at directly.

    Purge is tested this way rather than with purge_older_than(0) because a
    zero-age boundary compares a row's write timestamp against "now" and can go
    either way on sub-millisecond timing — a flaky test that says nothing useful.
    Production always uses a real age (86400s default), so that is what is tested.
    """
    if js.BACKEND == "postgres":
        import psycopg

        with psycopg.connect(js.DATABASE_URL) as conn:
            conn.execute(
                f"UPDATE {js.TABLE} SET updated_at = EXTRACT(EPOCH FROM now()) - %s WHERE job_id = %s",
                (seconds_ago, job_id),
            )
            conn.commit()
    else:
        js._store._conn.execute(
            f"UPDATE {js.TABLE} SET updated_at = strftime('%s','now') - ? WHERE job_id = ?",
            (seconds_ago, job_id),
        )
        js._store._conn.commit()


def check(label: str, actual, expected) -> None:
    ok = actual == expected
    print(f"  {'ok  ' if ok else 'FAIL'}  {label:52} {actual!r}" + ("" if ok else f" != {expected!r}"))
    if not ok:
        _failures.append(f"{label}: got {actual!r}, expected {expected!r}")


def main() -> int:
    client = TestClient(app_module.app)
    auth = {"Authorization": f"Bearer {TOKEN}"}

    print("\nauth: /health stays open for platform health checks")
    check("GET /health without a token", client.get("/health").status_code, 200)
    body = client.get("/health").json()
    check("/health reports key configuration", set(body) >= {"ok", "revai_key", "claude_key"}, True)
    check("/health does not leak key VALUES", any(len(str(v)) > 40 for v in body.values()), False)

    print("\nauth: the paid endpoints reject anonymous callers")
    check("POST /transcribe no token", client.post("/transcribe", content=b"x").status_code, 401)
    check("POST /select no token", client.post("/select", json={}).status_code, 401)
    check("GET /jobs/{id} no token", client.get("/jobs/abc").status_code, 401)

    print("\nauth: only the exact bearer token is accepted")
    check("wrong token", client.get("/jobs/abc", headers={"Authorization": "Bearer nope"}).status_code, 401)
    check("no Bearer prefix", client.get("/jobs/abc", headers={"Authorization": TOKEN}).status_code, 401)
    check("prefix of the real token", client.get("/jobs/abc", headers={"Authorization": f"Bearer {TOKEN[:-1]}"}).status_code, 401)
    check("token with trailing junk", client.get("/jobs/abc", headers={"Authorization": f"Bearer {TOKEN}x"}).status_code, 401)
    # 404 not 401: authorised, and the job genuinely does not exist.
    check("correct token reaches the handler", client.get("/jobs/abc", headers=auth).status_code, 404)

    print("\nauth: open mode when no token is configured (localhost default)")
    saved = app_module.API_TOKEN
    try:
        app_module.API_TOKEN = ""
        check("GET /jobs/{id} with auth disabled", client.get("/jobs/abc").status_code, 404)
    finally:
        app_module.API_TOKEN = saved

    print("\nrouting: every money-spending route carries the guard")
    guarded = {
        r.path
        for r in app_module.app.routes
        if any(getattr(d.dependency, "__name__", "") == "require_token" for d in getattr(r, "dependencies", []))
    }
    check("guarded routes", guarded, {"/transcribe", "/select", "/jobs/{job_id}"})

    print("\ndeployability: the container's declared deps cover the import chain")
    # Pillow and numpy are deliberately excluded from backend/requirements.txt.
    # If either sneaks back onto the import path, the image silently needs them.
    for absent in ("PIL", "numpy"):
        check(f"{absent} not required at import", absent in sys.modules, False)
    check("job DB path is env-overridable", os.environ["ISTV_JOBS_DB"] in str(__import__("backend.job_store", fromlist=["DB_PATH"]).DB_PATH), True)

    print("\njob store: the active backend is reported, not assumed")
    import backend.job_store as js

    check("backend is sqlite or postgres", js.BACKEND in ("sqlite", "postgres"), True)
    check("table name is not the generic 'jobs'", js.TABLE != "jobs", True)
    check("/health reports the store", client.get("/health").json()["job_store"], js.BACKEND)
    check("/health reports durability", client.get("/health").json()["durable"], js.BACKEND == "postgres")
    check("/health never contains a password", "@" not in str(client.get("/health").json()), True)

    print(f"\njob store: round-trip against the live backend ({js.BACKEND})")
    js.save("t-1", "transcribe", {"status": "running", "revai_job_id": "rev-abc"})
    js.save("t-2", "select", {"status": "running", "transcript": {"words": [{"word": "hi", "time": 0}]}})
    rows = {jid: (kind, data) for jid, kind, data in js.load_all()}
    check("both jobs persisted", {"t-1", "t-2"} <= set(rows), True)
    check("kind survives", rows["t-1"][0], "transcribe")
    check("nested JSON survives", rows["t-2"][1]["transcript"]["words"][0]["word"], "hi")

    # Re-saving must UPDATE, not insert a duplicate: app.py calls save() on every
    # status change, so an INSERT-only path would grow a row per poll tick.
    before = len(js.load_all())
    js.save("t-1", "transcribe", {"status": "done"})
    after = js.load_all()
    check("re-save upserts rather than duplicating", len(after), before)
    check("re-save updated the payload", dict((j, d) for j, _, d in after)["t-1"]["status"], "done")

    js.delete("t-2")
    check("delete removes just that job", "t-2" in {j for j, _, _ in js.load_all()}, False)

    # Purge, tested deterministically: backdate the row rather than relying on a
    # zero-age boundary, which is inherently sub-second-timing dependent.
    _backdate(js, "t-1", seconds_ago=90_000)
    js.purge_older_than(86_400)
    check("purge drops a row older than the max age", "t-1" in {j for j, _, _ in js.load_all()}, False)

    js.save("t-3", "transcribe", {"status": "running"})
    js.purge_older_than(86_400)
    check("purge keeps a fresh row", "t-3" in {j for j, _, _ in js.load_all()}, True)
    js.delete("t-3")

    print()
    if _failures:
        print(f"FAILED — {len(_failures)} check(s):")
        for f in _failures:
            print(f"  - {f}")
        return 1
    print("ALL BACKEND CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
