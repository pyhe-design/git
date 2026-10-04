"""Demo data so a fresh dashboard has something to show. Uses the mock provider only: no network."""

from __future__ import annotations

import random
import time

from .models import Usage, cost_usd
from .store import ConflictError, NewRun, RunStatus, Store

DEMO_AGENTS = (
    ("Researcher", "claude-opus-5-5", "high", "You research questions thoroughly and cite your sources."),
    ("Summarizer", "claude-sonnet-5-5", "low", "You summarize documents into five bullet points."),
    ("Triage", "claude-haiku-4-5", "low", "You classify incoming tickets as bug, feature or question."),
)


def seed_demo(store: Store, *, days: int = 14, rng_seed: int = 7) -> int:
    """Create demo agents and synthetic runs. Returns the number of runs written. Idempotent for agents."""
    rng = random.Random(rng_seed)  # noqa: S311 - demo data, not security
    agents = []
    for name, model, effort, system in DEMO_AGENTS:
        try:
            agents.append(store.create_agent(name=name, model=model, effort=effort, system_prompt=system))  # type: ignore[arg-type]
        except ConflictError:
            agents.extend(a for a in store.list_agents() if a.name == name)
    now = time.time()
    written = 0
    for day in range(days):
        for _ in range(rng.randint(3, 12)):
            agent = rng.choice(agents)
            status: RunStatus = "error" if rng.random() < 0.05 else "refused" if rng.random() < 0.02 else "ok"
            usage = (
                Usage()
                if status == "error"
                else Usage(
                    input_tokens=rng.randint(50, 800),
                    output_tokens=rng.randint(100, 2500),
                    cache_read_tokens=rng.choice((0, 2048, 4096)),
                    cache_write_tokens=rng.choice((0, 0, 0, 4096)),
                )
            )
            store.insert_run(
                NewRun(
                    agent_id=agent.id,
                    agent_name=agent.name,
                    model=agent.model,
                    provider="mock",
                    prompt="(demo) synthetic run",
                    output="" if status != "ok" else "(demo) synthetic output",
                    status=status,
                    stop_reason=None
                    if status == "error"
                    else "refusal"
                    if status == "refused"
                    else "end_turn",
                    error="demo: simulated timeout" if status == "error" else None,
                    usage=usage,
                    cost_usd=cost_usd(agent.model, usage),
                    latency_ms=rng.randint(400, 30_000),
                ),
                created_at=now - day * 86_400 - rng.randint(0, 80_000),
            )
            written += 1
    return written
