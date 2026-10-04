"""Business logic: input validation, agent runs and dashboard metrics. No HTTP, no SQL."""

from __future__ import annotations

import math
import time
from dataclasses import asdict
from typing import Any

from .models import DEFAULT_MODEL, EFFORTS, MODELS, Effort, Usage, cost_usd
from .providers import Provider, ProviderError
from .store import Agent, NewRun, Run, Store

MAX_NAME = 80
MAX_SYSTEM_PROMPT = 200_000
MAX_PROMPT = 100_000
DAY_S = 86_400


class ValidationError(ValueError):
    pass


def _text(payload: dict[str, Any], key: str, *, max_len: int, required: bool) -> str | None:
    value = payload.get(key)
    if value is None:
        if required:
            raise ValidationError(f"'{key}' is required")
        return None
    if not isinstance(value, str):
        raise ValidationError(f"'{key}' must be a string")
    value = value.strip()
    if required and not value:
        raise ValidationError(f"'{key}' must not be empty")
    if len(value) > max_len:
        raise ValidationError(f"'{key}' exceeds {max_len} characters")
    return value


def _model(value: Any) -> str:
    if value not in MODELS:
        raise ValidationError(f"'model' must be one of {sorted(MODELS)}")
    return str(value)


def _effort(value: Any) -> Effort:
    if value not in EFFORTS:
        raise ValidationError(f"'effort' must be one of {list(EFFORTS)}")
    return value  # type: ignore[no-any-return]


def agent_fields(payload: dict[str, Any], *, partial: bool) -> dict[str, Any]:
    known = {"name", "model", "effort", "system_prompt", "enabled"}
    unknown = set(payload) - known
    if unknown:
        raise ValidationError(f"unknown fields: {sorted(unknown)}")
    out: dict[str, Any] = {}
    name = _text(payload, "name", max_len=MAX_NAME, required=not partial)
    if name is not None:
        out["name"] = name
    system = _text(payload, "system_prompt", max_len=MAX_SYSTEM_PROMPT, required=not partial)
    if system is not None:
        out["system_prompt"] = system
    if "model" in payload or not partial:
        out["model"] = _model(payload.get("model", DEFAULT_MODEL))
    if "effort" in payload or not partial:
        out["effort"] = _effort(payload.get("effort", "medium"))
    if "enabled" in payload:
        if not isinstance(payload["enabled"], bool):
            raise ValidationError("'enabled' must be a boolean")
        out["enabled"] = payload["enabled"]
    return out


def percentile(sorted_values: list[int], pct: float) -> int:
    if not sorted_values:
        return 0
    rank = max(0, math.ceil(pct / 100 * len(sorted_values)) - 1)
    return sorted_values[rank]


class Dashboard:
    def __init__(self, store: Store, provider: Provider, *, max_output_tokens: int = 16_000) -> None:
        self.store = store
        self.provider = provider
        self.max_output_tokens = max_output_tokens

    def create_agent(self, payload: dict[str, Any]) -> Agent:
        return self.store.create_agent(**agent_fields(payload, partial=False))

    def update_agent(self, agent_id: int, payload: dict[str, Any]) -> Agent:
        return self.store.update_agent(agent_id, agent_fields(payload, partial=True))

    def run_agent(self, agent_id: int, payload: dict[str, Any]) -> Run:
        """SIDE EFFECT: calls the configured provider (network for `anthropic`) and persists the run."""
        agent = self.store.get_agent(agent_id)
        if not agent.enabled:
            raise ValidationError(f"agent {agent.name!r} is disabled")
        prompt = _text(payload, "prompt", max_len=MAX_PROMPT, required=True)
        assert prompt is not None

        started = time.perf_counter()
        try:
            completion = self.provider.complete(
                model=agent.model,
                system=agent.system_prompt,
                prompt=prompt,
                effort=agent.effort,
                max_tokens=self.max_output_tokens,
            )
        except ProviderError as exc:
            return self.store.insert_run(
                NewRun(
                    agent_id=agent.id,
                    agent_name=agent.name,
                    model=agent.model,
                    provider=self.provider.name,
                    prompt=prompt,
                    output="",
                    status="error",
                    stop_reason=None,
                    error=str(exc),
                    usage=Usage(),
                    cost_usd=0.0,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                )
            )
        latency_ms = int((time.perf_counter() - started) * 1000)
        # A server-side fallback can serve the request on another model; bill at the serving model's rate.
        billed_model = completion.model if completion.model in MODELS else agent.model
        return self.store.insert_run(
            NewRun(
                agent_id=agent.id,
                agent_name=agent.name,
                model=billed_model,
                provider=self.provider.name,
                prompt=prompt,
                output=completion.text,
                status="refused" if completion.stop_reason == "refusal" else "ok",
                stop_reason=completion.stop_reason,
                error=None,
                usage=completion.usage,
                cost_usd=cost_usd(billed_model, completion.usage),
                latency_ms=latency_ms,
            )
        )

    def overview(self, *, days: int = 7, now: float | None = None) -> dict[str, Any]:
        days = max(1, min(days, 90))
        now = time.time() if now is None else now
        today = math.floor(now / DAY_S)
        since = (today - days + 1) * DAY_S
        t = self.store.totals(since)
        prompt_side = t["input_tokens"] + t["cache_read_tokens"] + t["cache_write_tokens"]
        lat = self.store.latencies(since)

        by_day = {int(d["day"]): d for d in self.store.daily(since)}
        series = []
        for day in range(today - days + 1, today + 1):
            d = by_day.get(day, {"runs": 0, "errors": 0, "cost_usd": 0.0})
            series.append(
                {
                    "date": time.strftime("%Y-%m-%d", time.gmtime(day * DAY_S)),
                    "runs": int(d["runs"]),
                    "errors": int(d["errors"]),
                    "cost_usd": round(float(d["cost_usd"]), 6),
                }
            )

        return {
            "window_days": days,
            "provider": self.provider.name,
            "totals": {
                "runs": int(t["runs"]),
                "errors": int(t["errors"]),
                "refusals": int(t["refusals"]),
                "error_rate": t["errors"] / t["runs"] if t["runs"] else 0.0,
                "input_tokens": int(t["input_tokens"]),
                "output_tokens": int(t["output_tokens"]),
                "cache_read_tokens": int(t["cache_read_tokens"]),
                "cache_write_tokens": int(t["cache_write_tokens"]),
                "cache_hit_rate": t["cache_read_tokens"] / prompt_side if prompt_side else 0.0,
                "cost_usd": round(t["cost_usd"], 6),
                "latency_p50_ms": percentile(lat, 50),
                "latency_p95_ms": percentile(lat, 95),
            },
            "daily": series,
            "agents": [
                {
                    **a,
                    "cost_usd": round(float(a["cost_usd"]), 6),
                    "avg_latency_ms": round(float(a["avg_latency_ms"])),
                }
                for a in self.store.per_agent(since)
            ],
        }


def to_json(obj: Agent | Run) -> dict[str, Any]:
    data = asdict(obj)
    if isinstance(obj, Run):
        data.update(data.pop("usage"))
    return data


def models_json() -> list[dict[str, Any]]:
    return [asdict(m) for m in MODELS.values()]
