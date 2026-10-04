"""LLM providers. `AnthropicProvider` is the only code in this package that makes network calls."""

from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

from .models import Effort, Usage, get_model

if TYPE_CHECKING:
    import anthropic

FALLBACK_BETA = "server-side-fallback-2026-07-01"


@dataclass(frozen=True, slots=True)
class Completion:
    text: str
    stop_reason: str
    model: str
    usage: Usage


class ProviderError(Exception):
    def __init__(self, message: str, *, retryable: bool = False, status: int | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status


class Provider(Protocol):
    @property
    def name(self) -> str: ...

    def complete(
        self, *, model: str, system: str, prompt: str, effort: Effort, max_tokens: int
    ) -> Completion: ...


class MockProvider:
    """Deterministic offline provider. Simulates prompt-cache writes then reads per system prompt."""

    def __init__(self) -> None:
        self._seen: set[str] = set()
        self._lock = threading.Lock()

    @property
    def name(self) -> str:
        return "mock"

    def complete(
        self, *, model: str, system: str, prompt: str, effort: Effort, max_tokens: int
    ) -> Completion:
        get_model(model)
        key = hashlib.sha256(f"{model}\0{system}".encode()).hexdigest()
        with self._lock:
            cached = key in self._seen
            self._seen.add(key)
        system_tokens = max(1, len(system) // 4)
        prompt_tokens = max(1, len(prompt) // 4)
        text = f"[mock:{model}:{effort}] {prompt.strip()[:400]}"
        return Completion(
            text=text,
            stop_reason="end_turn",
            model=model,
            usage=Usage(
                input_tokens=prompt_tokens,
                output_tokens=min(max_tokens, max(1, len(text) // 4)),
                cache_read_tokens=system_tokens if cached else 0,
                cache_write_tokens=0 if cached else system_tokens,
            ),
        )


class AnthropicProvider:
    """Claude Messages API via the official SDK.

    EXTERNAL API CALL: every `complete()` sends one request to api.anthropic.com.

    The agent's system prompt is sent as a single text block with `cache_control`, so repeated runs of the
    same agent read it from the prompt cache. Prompts shorter than the model's minimum cacheable prefix
    (512-4096 tokens depending on model) are silently not cached; check `cache_read_tokens` in the run log.
    """

    def __init__(
        self, client: anthropic.Anthropic | None = None, *, timeout_s: float = 600.0, max_retries: int = 2
    ) -> None:
        if client is None:
            try:
                import anthropic  # noqa: PLC0415 - optional dependency, imported on use
            except ImportError as exc:
                msg = "install the SDK: pip install 'aios-dashboard[anthropic]'"
                raise ProviderError(msg) from exc
            client = anthropic.Anthropic(timeout=timeout_s, max_retries=max_retries)
        self._client = client

    @property
    def name(self) -> str:
        return "anthropic"

    def build_request(
        self, *, model: str, system: str, prompt: str, effort: Effort, max_tokens: int
    ) -> dict[str, Any]:
        """Request body, kept separate from the call so tests can assert the exact shape."""
        spec = get_model(model)
        request: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": prompt}],
            "betas": [],
        }
        if spec.supports_effort:
            request["output_config"] = {"effort": effort}
        if spec.supports_fallbacks:
            request["betas"].append(FALLBACK_BETA)
            request["fallbacks"] = "default"
        return request

    def complete(
        self, *, model: str, system: str, prompt: str, effort: Effort, max_tokens: int
    ) -> Completion:
        import anthropic  # noqa: PLC0415 - only reachable when the SDK is installed

        request = self.build_request(
            model=model, system=system, prompt=prompt, effort=effort, max_tokens=max_tokens
        )
        try:
            response = self._client.beta.messages.create(**request)
        except anthropic.RateLimitError as exc:
            raise ProviderError("rate limited by Anthropic API", retryable=True, status=429) from exc
        except anthropic.APIStatusError as exc:
            raise ProviderError(
                f"Anthropic API error {exc.status_code}: {exc.message}",
                retryable=exc.status_code >= 500,
                status=exc.status_code,
            ) from exc
        except anthropic.APIConnectionError as exc:
            raise ProviderError("cannot reach Anthropic API", retryable=True) from exc

        stop_reason = response.stop_reason or "unknown"
        if stop_reason == "refusal":
            text = ""
        else:
            text = "".join(block.text for block in response.content if block.type == "text")
        u = response.usage
        return Completion(
            text=text,
            stop_reason=stop_reason,
            model=str(response.model),
            usage=Usage(
                input_tokens=u.input_tokens,
                output_tokens=u.output_tokens,
                cache_read_tokens=u.cache_read_input_tokens or 0,
                cache_write_tokens=u.cache_creation_input_tokens or 0,
            ),
        )


def make_provider(name: str, *, timeout_s: float = 600.0) -> Provider:
    if name == "anthropic":
        return AnthropicProvider(timeout_s=timeout_s)
    if name == "mock":
        return MockProvider()
    raise ValueError(f"unknown provider {name!r}")
