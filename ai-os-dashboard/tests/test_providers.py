import unittest
from types import SimpleNamespace
from typing import Any

from aios.providers import FALLBACK_BETA, AnthropicProvider, MockProvider, ProviderError

try:
    import anthropic
    import httpx2  # type: ignore[import-not-found,unused-ignore]
except ImportError:  # pragma: no cover - SDK is optional
    anthropic = None  # type: ignore[assignment]


class FakeMessages:
    def __init__(self, response: Any = None, error: Exception | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.response = response
        self.error = error

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.response


def fake_client(messages: FakeMessages) -> Any:
    return SimpleNamespace(beta=SimpleNamespace(messages=messages))


def response(stop_reason: str = "end_turn", model: str = "claude-opus-5-5") -> Any:
    return SimpleNamespace(
        stop_reason=stop_reason,
        model=model,
        content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text="Hello")],
        usage=SimpleNamespace(
            input_tokens=12, output_tokens=34, cache_read_input_tokens=2048, cache_creation_input_tokens=None
        ),
    )


class RequestShapeTests(unittest.TestCase):
    def test_opus_request_caches_system_and_opts_into_fallbacks(self) -> None:
        req = AnthropicProvider(client=fake_client(FakeMessages())).build_request(
            model="claude-opus-5-5", system="SYS", prompt="hi", effort="high", max_tokens=100
        )
        self.assertEqual(
            req["system"], [{"type": "text", "text": "SYS", "cache_control": {"type": "ephemeral"}}]
        )
        self.assertEqual(req["messages"], [{"role": "user", "content": "hi"}])
        self.assertEqual(req["output_config"], {"effort": "high"})
        self.assertEqual(req["fallbacks"], "default")
        self.assertEqual(req["betas"], [FALLBACK_BETA])
        self.assertNotIn("thinking", req)

    def test_haiku_request_omits_effort_and_fallbacks(self) -> None:
        req = AnthropicProvider(client=fake_client(FakeMessages())).build_request(
            model="claude-haiku-4-5", system="SYS", prompt="hi", effort="high", max_tokens=100
        )
        self.assertNotIn("output_config", req)
        self.assertNotIn("fallbacks", req)
        self.assertEqual(req["betas"], [])


@unittest.skipIf(anthropic is None, "anthropic SDK not installed")
class AnthropicProviderTests(unittest.TestCase):
    def test_reads_text_blocks_and_usage(self) -> None:
        msgs = FakeMessages(response())
        c = AnthropicProvider(client=fake_client(msgs)).complete(
            model="claude-opus-5-5", system="S", prompt="P", effort="medium", max_tokens=50
        )
        self.assertEqual(c.text, "Hello")
        self.assertEqual((c.usage.input_tokens, c.usage.output_tokens), (12, 34))
        self.assertEqual((c.usage.cache_read_tokens, c.usage.cache_write_tokens), (2048, 0))
        self.assertEqual(len(msgs.calls), 1)

    def test_refusal_returns_no_text(self) -> None:
        c = AnthropicProvider(client=fake_client(FakeMessages(response("refusal")))).complete(
            model="claude-opus-5-5", system="S", prompt="P", effort="medium", max_tokens=50
        )
        self.assertEqual((c.text, c.stop_reason), ("", "refusal"))

    def test_connection_error_maps_to_retryable_provider_error(self) -> None:
        err = anthropic.APIConnectionError(
            request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
        )
        provider = AnthropicProvider(client=fake_client(FakeMessages(error=err)))
        with self.assertRaises(ProviderError) as ctx:
            provider.complete(model="claude-opus-5-5", system="S", prompt="P", effort="low", max_tokens=5)
        self.assertTrue(ctx.exception.retryable)


class MockProviderTests(unittest.TestCase):
    def test_rejects_unknown_model(self) -> None:
        with self.assertRaises(ValueError):
            MockProvider().complete(model="nope", system="s", prompt="p", effort="low", max_tokens=10)


if __name__ == "__main__":
    unittest.main()
