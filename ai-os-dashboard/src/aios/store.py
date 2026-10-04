"""SQLite persistence. One connection guarded by a lock; safe under ThreadingHTTPServer."""

from __future__ import annotations

import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .models import Effort, Usage

RunStatus = Literal["ok", "refused", "error"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS agents (
    id            INTEGER PRIMARY KEY,
    name          TEXT    NOT NULL UNIQUE,
    model         TEXT    NOT NULL,
    effort        TEXT    NOT NULL,
    system_prompt TEXT    NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    REAL    NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
    id                 INTEGER PRIMARY KEY,
    agent_id           INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    agent_name         TEXT    NOT NULL,
    model              TEXT    NOT NULL,
    provider           TEXT    NOT NULL,
    prompt             TEXT    NOT NULL,
    output             TEXT    NOT NULL,
    status             TEXT    NOT NULL CHECK (status IN ('ok', 'refused', 'error')),
    stop_reason        TEXT,
    error              TEXT,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd           REAL    NOT NULL DEFAULT 0,
    latency_ms         INTEGER NOT NULL DEFAULT 0,
    created_at         REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_created_at ON runs(created_at);
CREATE INDEX IF NOT EXISTS runs_agent_id ON runs(agent_id);
"""


@dataclass(frozen=True, slots=True)
class Agent:
    id: int
    name: str
    model: str
    effort: Effort
    system_prompt: str
    enabled: bool
    created_at: float


@dataclass(frozen=True, slots=True)
class Run:
    id: int
    agent_id: int | None
    agent_name: str
    model: str
    provider: str
    prompt: str
    output: str
    status: RunStatus
    stop_reason: str | None
    error: str | None
    usage: Usage
    cost_usd: float
    latency_ms: int
    created_at: float


@dataclass(frozen=True, slots=True)
class NewRun:
    agent_id: int | None
    agent_name: str
    model: str
    provider: str
    prompt: str
    output: str
    status: RunStatus
    stop_reason: str | None
    error: str | None
    usage: Usage
    cost_usd: float
    latency_ms: int


class NotFoundError(LookupError):
    pass


class ConflictError(ValueError):
    pass


def _agent(row: sqlite3.Row) -> Agent:
    return Agent(
        id=row["id"],
        name=row["name"],
        model=row["model"],
        effort=row["effort"],
        system_prompt=row["system_prompt"],
        enabled=bool(row["enabled"]),
        created_at=row["created_at"],
    )


def _run(row: sqlite3.Row) -> Run:
    return Run(
        id=row["id"],
        agent_id=row["agent_id"],
        agent_name=row["agent_name"],
        model=row["model"],
        provider=row["provider"],
        prompt=row["prompt"],
        output=row["output"],
        status=row["status"],
        stop_reason=row["stop_reason"],
        error=row["error"],
        usage=Usage(
            input_tokens=row["input_tokens"],
            output_tokens=row["output_tokens"],
            cache_read_tokens=row["cache_read_tokens"],
            cache_write_tokens=row["cache_write_tokens"],
        ),
        cost_usd=row["cost_usd"],
        latency_ms=row["latency_ms"],
        created_at=row["created_at"],
    )


class Store:
    def __init__(self, path: Path | str) -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._tx() as db:
            db.execute("PRAGMA foreign_keys = ON")
            if str(path) != ":memory:":
                db.execute("PRAGMA journal_mode = WAL")
        self._db.executescript(SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._db.close()

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            yield self._db

    # -- agents -------------------------------------------------------------------------------------

    def create_agent(
        self, *, name: str, model: str, effort: Effort, system_prompt: str, enabled: bool = True
    ) -> Agent:
        with self._tx() as db:
            try:
                cur = db.execute(
                    "INSERT INTO agents (name, model, effort, system_prompt, enabled, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (name, model, effort, system_prompt, int(enabled), time.time()),
                )
            except sqlite3.IntegrityError as exc:
                raise ConflictError(f"agent named {name!r} already exists") from exc
            row = db.execute("SELECT * FROM agents WHERE id = ?", (cur.lastrowid,)).fetchone()
        return _agent(row)

    def get_agent(self, agent_id: int) -> Agent:
        with self._tx() as db:
            row = db.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"agent {agent_id} not found")
        return _agent(row)

    def list_agents(self) -> list[Agent]:
        with self._tx() as db:
            rows = db.execute("SELECT * FROM agents ORDER BY name COLLATE NOCASE").fetchall()
        return [_agent(r) for r in rows]

    def update_agent(self, agent_id: int, changes: dict[str, Any]) -> Agent:
        allowed = {"name", "model", "effort", "system_prompt", "enabled"}
        unknown = set(changes) - allowed
        if unknown:
            raise ValueError(f"cannot update fields: {sorted(unknown)}")
        if not changes:
            return self.get_agent(agent_id)
        cols = sorted(changes)
        values = [int(changes[c]) if c == "enabled" else changes[c] for c in cols]
        assignments = ", ".join(f"{c} = ?" for c in cols)  # column names come from the allowlist above
        with self._tx() as db:
            try:
                cur = db.execute(f"UPDATE agents SET {assignments} WHERE id = ?", (*values, agent_id))  # noqa: S608
            except sqlite3.IntegrityError as exc:
                raise ConflictError(f"agent named {changes.get('name')!r} already exists") from exc
        if cur.rowcount == 0:
            raise NotFoundError(f"agent {agent_id} not found")
        return self.get_agent(agent_id)

    def delete_agent(self, agent_id: int) -> None:
        with self._tx() as db:
            cur = db.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
        if cur.rowcount == 0:
            raise NotFoundError(f"agent {agent_id} not found")

    # -- runs ---------------------------------------------------------------------------------------

    def insert_run(self, run: NewRun, *, created_at: float | None = None) -> Run:
        u = run.usage
        with self._tx() as db:
            cur = db.execute(
                "INSERT INTO runs (agent_id, agent_name, model, provider, prompt, output, status,"
                " stop_reason, error, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,"
                " cost_usd,"
                " latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    run.agent_id,
                    run.agent_name,
                    run.model,
                    run.provider,
                    run.prompt,
                    run.output,
                    run.status,
                    run.stop_reason,
                    run.error,
                    u.input_tokens,
                    u.output_tokens,
                    u.cache_read_tokens,
                    u.cache_write_tokens,
                    run.cost_usd,
                    run.latency_ms,
                    time.time() if created_at is None else created_at,
                ),
            )
            row = db.execute("SELECT * FROM runs WHERE id = ?", (cur.lastrowid,)).fetchone()
        return _run(row)

    def list_runs(self, *, limit: int = 50, agent_id: int | None = None) -> list[Run]:
        limit = max(1, min(limit, 500))
        with self._tx() as db:
            if agent_id is None:
                rows = db.execute("SELECT * FROM runs ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
            else:
                rows = db.execute(
                    "SELECT * FROM runs WHERE agent_id = ? ORDER BY id DESC LIMIT ?", (agent_id, limit)
                ).fetchall()
        return [_run(r) for r in rows]

    # -- metrics ------------------------------------------------------------------------------------

    def totals(self, since: float) -> dict[str, float]:
        with self._tx() as db:
            row = db.execute(
                "SELECT COUNT(*) AS runs,"
                " COALESCE(SUM(status = 'error'), 0) AS errors,"
                " COALESCE(SUM(status = 'refused'), 0) AS refusals,"
                " COALESCE(SUM(input_tokens), 0) AS input_tokens,"
                " COALESCE(SUM(output_tokens), 0) AS output_tokens,"
                " COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,"
                " COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,"
                " COALESCE(SUM(cost_usd), 0) AS cost_usd"
                " FROM runs WHERE created_at >= ?",
                (since,),
            ).fetchone()
        return {k: float(row[k]) for k in row.keys()}  # noqa: SIM118 - sqlite3.Row is not a Mapping

    def latencies(self, since: float) -> list[int]:
        with self._tx() as db:
            rows = db.execute(
                "SELECT latency_ms FROM runs WHERE created_at >= ? AND status != 'error' ORDER BY latency_ms",
                (since,),
            ).fetchall()
        return [int(r[0]) for r in rows]

    def daily(self, since: float, tz_offset_s: int = 0) -> list[dict[str, Any]]:
        with self._tx() as db:
            rows = db.execute(
                "SELECT CAST((created_at + ?) / 86400 AS INTEGER) AS day, COUNT(*) AS runs,"
                " COALESCE(SUM(status = 'error'), 0) AS errors, COALESCE(SUM(cost_usd), 0) AS cost_usd"
                " FROM runs WHERE created_at >= ? GROUP BY day ORDER BY day",
                (tz_offset_s, since),
            ).fetchall()
        return [dict(r) for r in rows]

    def per_agent(self, since: float) -> list[dict[str, Any]]:
        with self._tx() as db:
            rows = db.execute(
                "SELECT agent_id, agent_name, COUNT(*) AS runs, COALESCE(SUM(status = 'error'), 0) AS errors,"
                " COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)"
                " AS tokens, COALESCE(SUM(cost_usd), 0) AS cost_usd,"
                " COALESCE(AVG(latency_ms), 0) AS avg_latency_ms"
                " FROM runs WHERE created_at >= ? GROUP BY agent_id, agent_name ORDER BY cost_usd DESC",
                (since,),
            ).fetchall()
        return [dict(r) for r in rows]
