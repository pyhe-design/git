"""Runtime settings, read once from the environment."""

from __future__ import annotations

import importlib.util
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

ProviderName = Literal["anthropic", "mock"]


@dataclass(frozen=True, slots=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8787
    db_path: Path = Path("data/aios.sqlite3")
    provider: ProviderName = "mock"
    api_token: str | None = None
    max_body_bytes: int = 256_000
    max_output_tokens: int = 16_000
    request_timeout_s: float = 600.0

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> Settings:
        port = int(env.get("AIOS_PORT", "8787"))
        if not 0 <= port <= 65535:
            raise ValueError(f"AIOS_PORT out of range: {port}")
        return cls(
            host=env.get("AIOS_HOST", "127.0.0.1"),
            port=port,
            db_path=Path(env.get("AIOS_DB", "data/aios.sqlite3")),
            provider=resolve_provider(env.get("AIOS_PROVIDER", "auto"), env),
            api_token=env.get("AIOS_TOKEN") or None,
        )


def resolve_provider(choice: str, env: Mapping[str, str]) -> ProviderName:
    """`auto` picks Anthropic only when the SDK is installed and a credential is present."""
    if choice in ("anthropic", "mock"):
        return choice  # type: ignore[return-value]
    if choice != "auto":
        raise ValueError(f"AIOS_PROVIDER must be auto, anthropic or mock, got {choice!r}")
    has_sdk = importlib.util.find_spec("anthropic") is not None
    has_key = bool(env.get("ANTHROPIC_API_KEY") or env.get("ANTHROPIC_AUTH_TOKEN"))
    return "anthropic" if has_sdk and has_key else "mock"
