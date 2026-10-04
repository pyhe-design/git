import unittest

from aios.models import MODELS, Usage, cost_usd, get_model


class CostTests(unittest.TestCase):
    def test_opus_cost_includes_cache_read_and_write(self) -> None:
        usage = Usage(
            input_tokens=1_000_000,
            output_tokens=1_000_000,
            cache_read_tokens=1_000_000,
            cache_write_tokens=1_000_000,
        )
        # 4 input + 20 output + 0.20 cache read + 4 * 1.25 cache write
        self.assertAlmostEqual(cost_usd("claude-opus-5-5", usage), 29.20)

    def test_zero_usage_costs_nothing(self) -> None:
        for model in MODELS:
            self.assertEqual(cost_usd(model, Usage()), 0.0)

    def test_unknown_model_raises(self) -> None:
        with self.assertRaises(ValueError):
            get_model("claude-3-sonnet-20240229")

    def test_haiku_has_no_effort_or_fallbacks(self) -> None:
        spec = get_model("claude-haiku-4-5")
        self.assertFalse(spec.supports_effort)
        self.assertFalse(spec.supports_fallbacks)


if __name__ == "__main__":
    unittest.main()
