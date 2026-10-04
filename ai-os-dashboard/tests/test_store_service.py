import time
import unittest

from aios.models import Usage
from aios.providers import Completion, MockProvider, ProviderError
from aios.seed import seed_demo
from aios.service import Dashboard, ValidationError, percentile, to_json
from aios.store import ConflictError, NewRun, NotFoundError, RunStatus, Store

DAY = 86_400


class FailingProvider:
    name = "failing"

    def complete(self, **_: object) -> Completion:
        raise ProviderError("boom", retryable=True)


class RefusingProvider:
    name = "refusing"

    def complete(self, **kw: object) -> Completion:
        return Completion(
            text="", stop_reason="refusal", model=str(kw["model"]), usage=Usage(input_tokens=10)
        )


class FallbackProvider:
    name = "fallback"

    def complete(self, **_: object) -> Completion:
        return Completion(
            text="hi", stop_reason="end_turn", model="claude-sonnet-5-5", usage=Usage(input_tokens=1_000_000)
        )


def agent_payload(**overrides: object) -> dict[str, object]:
    return {
        "name": "Researcher",
        "system_prompt": "You research.",
        "model": "claude-opus-5-5",
        "effort": "high",
        **overrides,
    }


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = Store(":memory:")

    def tearDown(self) -> None:
        self.store.close()

    def test_agent_crud(self) -> None:
        a = self.store.create_agent(name="A", model="claude-opus-5-5", effort="low", system_prompt="s")
        self.assertEqual(self.store.get_agent(a.id).name, "A")
        b = self.store.update_agent(a.id, {"name": "B", "enabled": False})
        self.assertEqual((b.name, b.enabled), ("B", False))
        self.store.delete_agent(a.id)
        with self.assertRaises(NotFoundError):
            self.store.get_agent(a.id)

    def test_duplicate_name_conflicts(self) -> None:
        self.store.create_agent(name="A", model="claude-opus-5-5", effort="low", system_prompt="s")
        with self.assertRaises(ConflictError):
            self.store.create_agent(name="A", model="claude-opus-5-5", effort="low", system_prompt="s")

    def test_update_rejects_unknown_columns(self) -> None:
        a = self.store.create_agent(name="A", model="claude-opus-5-5", effort="low", system_prompt="s")
        with self.assertRaises(ValueError):
            self.store.update_agent(a.id, {"id; DROP TABLE agents": 1})

    def test_runs_survive_agent_deletion(self) -> None:
        a = self.store.create_agent(name="A", model="claude-opus-5-5", effort="low", system_prompt="s")
        self.store.insert_run(
            NewRun(
                a.id,
                "A",
                "claude-opus-5-5",
                "mock",
                "p",
                "o",
                "ok",
                "end_turn",
                None,
                Usage(1, 2, 3, 4),
                0.1,
                10,
            )
        )
        self.store.delete_agent(a.id)
        runs = self.store.list_runs()
        self.assertEqual(len(runs), 1)
        self.assertIsNone(runs[0].agent_id)
        self.assertEqual(runs[0].agent_name, "A")


class DashboardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = Store(":memory:")
        self.app = Dashboard(self.store, MockProvider(), max_output_tokens=1000)

    def tearDown(self) -> None:
        self.store.close()

    def test_validation(self) -> None:
        with self.assertRaises(ValidationError):
            self.app.create_agent(agent_payload(model="gpt-4"))
        with self.assertRaises(ValidationError):
            self.app.create_agent(agent_payload(effort="extreme"))
        with self.assertRaises(ValidationError):
            self.app.create_agent(agent_payload(name="   "))
        with self.assertRaises(ValidationError):
            self.app.create_agent(agent_payload(extra=1))
        with self.assertRaises(ValidationError):
            self.app.update_agent(1, {"enabled": "yes"})

    def test_create_defaults(self) -> None:
        a = self.app.create_agent({"name": "X", "system_prompt": "s"})
        self.assertEqual((a.model, a.effort, a.enabled), ("claude-opus-5-5", "medium", True))

    def test_mock_run_writes_then_reads_cache(self) -> None:
        a = self.app.create_agent(agent_payload(system_prompt="x" * 4000))
        first = self.app.run_agent(a.id, {"prompt": "hello"})
        second = self.app.run_agent(a.id, {"prompt": "again"})
        self.assertEqual(first.status, "ok")
        self.assertGreater(first.usage.cache_write_tokens, 0)
        self.assertEqual(first.usage.cache_read_tokens, 0)
        self.assertGreater(second.usage.cache_read_tokens, 0)
        self.assertGreater(first.cost_usd, 0)

    def test_disabled_agent_and_empty_prompt_rejected(self) -> None:
        a = self.app.create_agent(agent_payload(enabled=False))
        with self.assertRaises(ValidationError):
            self.app.run_agent(a.id, {"prompt": "hi"})
        b = self.app.create_agent(agent_payload(name="B"))
        with self.assertRaises(ValidationError):
            self.app.run_agent(b.id, {"prompt": ""})
        with self.assertRaises(ValidationError):
            self.app.run_agent(b.id, {"prompt": 42})

    def test_provider_error_is_recorded(self) -> None:
        app = Dashboard(self.store, FailingProvider())
        a = app.create_agent(agent_payload())
        run = app.run_agent(a.id, {"prompt": "hi"})
        self.assertEqual((run.status, run.error, run.cost_usd), ("error", "boom", 0.0))

    def test_refusal_is_recorded(self) -> None:
        app = Dashboard(self.store, RefusingProvider())
        a = app.create_agent(agent_payload())
        self.assertEqual(app.run_agent(a.id, {"prompt": "hi"}).status, "refused")

    def test_fallback_billed_at_serving_model(self) -> None:
        app = Dashboard(self.store, FallbackProvider())
        a = app.create_agent(agent_payload())
        run = app.run_agent(a.id, {"prompt": "hi"})
        self.assertEqual(run.model, "claude-sonnet-5-5")
        self.assertAlmostEqual(run.cost_usd, 2.0)

    def test_overview_aggregates_window(self) -> None:
        a = self.app.create_agent(agent_payload())
        now = 100 * DAY + 3600

        def mk(status: RunStatus, usage: Usage, cost: float, lat: int) -> NewRun:
            return NewRun(a.id, a.name, a.model, "mock", "p", "o", status, None, None, usage, cost, lat)

        self.store.insert_run(mk("ok", Usage(100, 50, 300, 100), 1.0, 100), created_at=now)
        self.store.insert_run(mk("error", Usage(), 0.0, 9999), created_at=now - DAY)
        self.store.insert_run(mk("ok", Usage(1, 1, 0, 0), 5.0, 200), created_at=now - 30 * DAY)  # outside
        o = self.app.overview(days=7, now=now)
        t = o["totals"]
        self.assertEqual((t["runs"], t["errors"]), (2, 1))
        self.assertAlmostEqual(t["error_rate"], 0.5)
        self.assertAlmostEqual(t["cache_hit_rate"], 300 / 500)
        self.assertAlmostEqual(t["cost_usd"], 1.0)
        self.assertEqual(t["latency_p95_ms"], 100)  # errors excluded from latency
        self.assertEqual(len(o["daily"]), 7)
        self.assertEqual([d["runs"] for d in o["daily"]][-2:], [1, 1])
        self.assertEqual(o["agents"][0]["runs"], 2)

    def test_to_json_flattens_usage(self) -> None:
        a = self.app.create_agent(agent_payload())
        data = to_json(self.app.run_agent(a.id, {"prompt": "hi"}))
        self.assertIn("cache_read_tokens", data)
        self.assertNotIn("usage", data)

    def test_percentile(self) -> None:
        self.assertEqual(percentile([], 95), 0)
        self.assertEqual(percentile(list(range(1, 101)), 50), 50)
        self.assertEqual(percentile(list(range(1, 101)), 95), 95)


class SeedTests(unittest.TestCase):
    def test_seed_is_idempotent_for_agents(self) -> None:
        store = Store(":memory:")
        n = seed_demo(store, days=3)
        seed_demo(store, days=3)
        self.assertGreater(n, 0)
        self.assertEqual(len(store.list_agents()), 3)
        self.assertLessEqual(max(r.created_at for r in store.list_runs(limit=500)), time.time())
        store.close()


if __name__ == "__main__":
    unittest.main()
