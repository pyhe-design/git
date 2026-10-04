"""Model registry: the single source of truth for model IDs, prices and capabilities.

Prices are USD per million tokens, Anthropic first-party API rates (cached 2026-09-25).
Cache writes use the 5-minute TTL multiplier (1.25x input). Verify against the live
pricing page before using these numbers for billing decisions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal

Effort = Literal["low", "medium", "high", "xhigh", "max"]
EFFORTS: Final[tuple[Effort, ...]] = ("low", "medium", "high", "xhigh", "max")

CACHE_WRITE_5M_MULTIPLIER: Final = 1.25
_PER_TOKEN: Final = 1_000_000


@dataclass(frozen=True, slots=True)
class ModelSpec:
    id: str
    label: str
    input_per_mtok: float
    output_per_mtok: float
    cache_read_per_mtok: float
    supports_effort: bool
    supports_fallbacks: bool


@dataclass(frozen=True, slots=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


MODELS: Final[dict[str, ModelSpec]] = {
    spec.id: spec
    for spec in (
        ModelSpec("claude-opus-5-5", "Claude Opus 5.5", 4.00, 20.00, 0.20, True, True),
        ModelSpec("claude-fable-5-1", "Claude Fable 5.1", 10.00, 50.00, 0.25, True, True),
        ModelSpec("claude-sonnet-5-5", "Claude Sonnet 5.5", 2.00, 10.00, 0.20, True, True),
        ModelSpec("claude-haiku-4-5", "Claude Haiku 4.5", 1.00, 5.00, 0.10, False, False),
    )
}
DEFAULT_MODEL: Final = "claude-opus-5-5"


def get_model(model_id: str) -> ModelSpec:
    try:
        return MODELS[model_id]
    except KeyError:
        raise ValueError(f"unknown model {model_id!r}; expected one of {sorted(MODELS)}") from None


def cost_usd(model_id: str, usage: Usage) -> float:
    """Estimated request cost in USD. Raises ValueError for unknown models."""
    spec = get_model(model_id)
    total = (
        usage.input_tokens * spec.input_per_mtok
        + usage.output_tokens * spec.output_per_mtok
        + usage.cache_read_tokens * spec.cache_read_per_mtok
        + usage.cache_write_tokens * spec.input_per_mtok * CACHE_WRITE_5M_MULTIPLIER
    )
    return round(total / _PER_TOKEN, 8)
