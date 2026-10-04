import http.client
import json
import threading
import unittest
from typing import Any

from aios.config import Settings
from aios.providers import MockProvider
from aios.server import make_server
from aios.service import Dashboard
from aios.store import Store


class ServerTests(unittest.TestCase):
    token: str | None = None

    def setUp(self) -> None:
        self.store = Store(":memory:")
        settings = Settings(port=0, provider="mock", api_token=self.token, max_body_bytes=4096)
        self.server = make_server(Dashboard(self.store, MockProvider()), settings)
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.store.close()

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        headers: dict[str, str] | None = None,
        raw: bytes | None = None,
    ) -> tuple[int, dict[str, str], Any]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        hdrs = {"Host": f"127.0.0.1:{self.port}", **(headers or {})}
        payload = raw if raw is not None else None if body is None else json.dumps(body).encode()
        if payload is not None:
            hdrs.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=payload, headers=hdrs)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        ctype = res.getheader("Content-Type", "")
        parsed = json.loads(data) if ctype.startswith("application/json") else data
        return res.status, {k.lower(): v for k, v in res.getheaders()}, parsed


class ApiTests(ServerTests):
    def test_full_flow(self) -> None:
        status, _, health = self.request("GET", "/api/health")
        self.assertEqual((status, health["provider"]), (200, "mock"))
        status, _, agent = self.request("POST", "/api/agents", {"name": "A", "system_prompt": "S"})
        self.assertEqual(status, 201)
        status, _, run = self.request("POST", f"/api/agents/{agent['id']}/runs", {"prompt": "hi"})
        self.assertEqual((status, run["status"]), (201, "ok"))
        status, _, runs = self.request("GET", f"/api/runs?agent_id={agent['id']}")
        self.assertEqual((status, len(runs)), (200, 1))
        status, _, overview = self.request("GET", "/api/overview?days=1")
        self.assertEqual(overview["totals"]["runs"], 1)
        status, _, patched = self.request("PATCH", f"/api/agents/{agent['id']}", {"enabled": False})
        self.assertFalse(patched["enabled"])
        status, _, _ = self.request("DELETE", f"/api/agents/{agent['id']}")
        self.assertEqual(status, 200)
        status, _, _ = self.request("GET", f"/api/agents/{agent['id']}")
        self.assertEqual(status, 404)

    def test_models_listed(self) -> None:
        _, _, models = self.request("GET", "/api/models")
        self.assertIn("claude-opus-5-5", [m["id"] for m in models])

    def test_error_statuses(self) -> None:
        self.assertEqual(self.request("POST", "/api/agents", {"name": "A"})[0], 400)
        self.request("POST", "/api/agents", {"name": "A", "system_prompt": "S"})
        self.assertEqual(self.request("POST", "/api/agents", {"name": "A", "system_prompt": "S"})[0], 409)
        self.assertEqual(self.request("POST", "/api/agents", raw=b"{not json")[0], 400)
        self.assertEqual(self.request("POST", "/api/agents", raw=b"[]")[0], 400)
        self.assertEqual(self.request("POST", "/api/agents", raw=b"x" * 5000)[0], 413)
        self.assertEqual(
            self.request(
                "POST",
                "/api/agents",
                raw=b"name=A",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )[0],
            415,
        )
        self.assertEqual(self.request("GET", "/api/runs?limit=abc")[0], 400)
        self.assertEqual(self.request("GET", "/api/nope")[0], 404)
        self.assertEqual(self.request("PUT", "/api/agents/1")[0], 501)

    def test_dns_rebinding_host_rejected(self) -> None:
        status, _, _ = self.request("GET", "/api/health", headers={"Host": "evil.example:80"})
        self.assertEqual(status, 421)

    def test_static_and_security_headers(self) -> None:
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"AI OS Dashboard", body)
        self.assertIn("default-src 'self'", headers["content-security-policy"])
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertEqual(self.request("GET", "/static/app.js")[0], 200)
        self.assertEqual(self.request("GET", "/static/../server.py")[0], 404)
        self.assertEqual(self.request("GET", "/%2e%2e/server.py")[0], 404)


class TokenTests(ServerTests):
    token = "s3cret"

    def test_api_requires_bearer_token(self) -> None:
        self.assertEqual(self.request("GET", "/api/health")[0], 401)
        self.assertEqual(
            self.request("GET", "/api/health", headers={"Authorization": "Bearer wrong"})[0], 401
        )
        self.assertEqual(
            self.request("GET", "/api/health", headers={"Authorization": "Bearer s3cret"})[0], 200
        )
        self.assertEqual(self.request("GET", "/")[0], 200)  # UI shell is public; data is not


if __name__ == "__main__":
    unittest.main()
