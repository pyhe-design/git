"""HTTP layer: stdlib ThreadingHTTPServer, JSON API under /api, static UI at /."""

from __future__ import annotations

import hmac
import json
import mimetypes
import re
from collections.abc import Callable
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from . import __version__
from .config import Settings
from .service import Dashboard, ValidationError, models_json, to_json
from .store import ConflictError, NotFoundError

STATIC_DIR = Path(__file__).parent / "static"
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
}
LOOPBACK = frozenset({"127.0.0.1", "localhost", "::1"})
_AGENT = re.compile(r"^/api/agents/(\d+)$")
_AGENT_RUNS = re.compile(r"^/api/agents/(\d+)/runs$")


class HttpError(Exception):
    def __init__(self, status: HTTPStatus, message: str) -> None:
        super().__init__(message)
        self.status = status


def _int_param(query: dict[str, list[str]], key: str, default: int | None) -> int | None:
    raw = query.get(key, [None])[0]
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        raise HttpError(HTTPStatus.BAD_REQUEST, f"'{key}' must be an integer") from None


def make_handler(app: Dashboard, settings: Settings) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = f"aios/{__version__}"
        sys_version = ""
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            if settings.host not in LOOPBACK:
                super().log_message(format, *args)

        # -- plumbing -------------------------------------------------------------------------------

        def _send(
            self, status: int, body: bytes, content_type: str, extra: dict[str, str] | None = None
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for key, value in {**SECURITY_HEADERS, **(extra or {})}.items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, status: int, payload: Any) -> None:
            self._send(status, json.dumps(payload).encode(), "application/json; charset=utf-8")

        def _read_json(self) -> dict[str, Any]:
            if self.headers.get_content_type() != "application/json":
                # Also blocks cross-site form posts: a JSON content type forces a CORS preflight.
                raise HttpError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Content-Type must be application/json")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise HttpError(HTTPStatus.BAD_REQUEST, "invalid Content-Length") from None
            if length > settings.max_body_bytes:
                self.close_connection = True
                raise HttpError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body too large")
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except (json.JSONDecodeError, UnicodeDecodeError):
                raise HttpError(HTTPStatus.BAD_REQUEST, "body is not valid JSON") from None
            if not isinstance(data, dict):
                raise HttpError(HTTPStatus.BAD_REQUEST, "body must be a JSON object")
            return data

        def _check_host(self) -> None:
            # DNS-rebinding guard for a loopback-bound server: only accept our own Host header.
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
            if settings.host in LOOPBACK and host not in LOOPBACK:
                raise HttpError(HTTPStatus.MISDIRECTED_REQUEST, "unexpected Host header")

        def _check_auth(self) -> None:
            if settings.api_token is None:
                return
            header = self.headers.get("Authorization", "")
            supplied = header.removeprefix("Bearer ").strip() if header.startswith("Bearer ") else ""
            if not hmac.compare_digest(supplied.encode(), settings.api_token.encode()):
                raise HttpError(HTTPStatus.UNAUTHORIZED, "missing or invalid bearer token")

        def _dispatch(self, method: str) -> None:
            try:
                self._check_host()
                url = urlsplit(self.path)
                if url.path.startswith("/api/"):
                    self._check_auth()
                    self._api(method, url.path, parse_qs(url.query))
                elif method in ("GET", "HEAD"):
                    self._static(url.path)
                else:
                    raise HttpError(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")
            except HttpError as exc:
                self._json(exc.status, {"error": str(exc)})
            except ValidationError as exc:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except NotFoundError as exc:
                self._json(HTTPStatus.NOT_FOUND, {"error": str(exc)})
            except ConflictError as exc:
                self._json(HTTPStatus.CONFLICT, {"error": str(exc)})
            except Exception:
                self.log_error("unhandled error on %s %s", method, self.path)
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "internal error"})

        def do_GET(self) -> None:
            self._dispatch("GET")

        def do_HEAD(self) -> None:
            self._dispatch("HEAD")

        def do_POST(self) -> None:
            self._dispatch("POST")

        def do_PATCH(self) -> None:
            self._dispatch("PATCH")

        def do_DELETE(self) -> None:
            self._dispatch("DELETE")

        # -- routes ---------------------------------------------------------------------------------

        def _api(self, method: str, path: str, query: dict[str, list[str]]) -> None:
            routes: dict[tuple[str, str], Callable[[], Any]] = {
                ("GET", "/api/health"): lambda: {
                    "status": "ok",
                    "version": __version__,
                    "provider": app.provider.name,
                },
                ("GET", "/api/models"): models_json,
                ("GET", "/api/overview"): lambda: app.overview(days=_int_param(query, "days", 7) or 7),
                ("GET", "/api/agents"): lambda: [to_json(a) for a in app.store.list_agents()],
                ("GET", "/api/runs"): lambda: [
                    to_json(r)
                    for r in app.store.list_runs(
                        limit=_int_param(query, "limit", 50) or 50,
                        agent_id=_int_param(query, "agent_id", None),
                    )
                ],
            }
            if method == "HEAD":
                method = "GET"
            if (method, path) in routes:
                self._json(HTTPStatus.OK, routes[(method, path)]())
                return
            if (method, path) == ("POST", "/api/agents"):
                self._json(HTTPStatus.CREATED, to_json(app.create_agent(self._read_json())))
                return
            if m := _AGENT.match(path):
                agent_id = int(m.group(1))
                if method == "GET":
                    self._json(HTTPStatus.OK, to_json(app.store.get_agent(agent_id)))
                elif method == "PATCH":
                    self._json(HTTPStatus.OK, to_json(app.update_agent(agent_id, self._read_json())))
                elif method == "DELETE":
                    app.store.delete_agent(agent_id)
                    self._json(HTTPStatus.OK, {"deleted": agent_id})
                else:
                    raise HttpError(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed")
                return
            if (m := _AGENT_RUNS.match(path)) and method == "POST":
                run = app.run_agent(int(m.group(1)), self._read_json())
                self._json(HTTPStatus.CREATED, to_json(run))
                return
            raise HttpError(HTTPStatus.NOT_FOUND, "no such endpoint")

        def _static(self, path: str) -> None:
            rel = "index.html" if path in ("", "/") else path.lstrip("/").removeprefix("static/")
            target = (STATIC_DIR / rel).resolve()
            if not target.is_relative_to(STATIC_DIR.resolve()) or not target.is_file():
                raise HttpError(HTTPStatus.NOT_FOUND, "not found")
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype == "application/javascript":
                ctype += "; charset=utf-8"
            self._send(HTTPStatus.OK, target.read_bytes(), ctype)

    return Handler


def make_server(app: Dashboard, settings: Settings) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((settings.host, settings.port), make_handler(app, settings))
    server.daemon_threads = True
    return server
