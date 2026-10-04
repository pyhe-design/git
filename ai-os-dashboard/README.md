# AI OS Dashboard

Local control panel for your AI agents. Define agents (model, effort, system prompt), run them from a
console, and track every run's tokens, prompt-cache hit rate, estimated cost, latency and errors.

- **Zero runtime dependencies** in mock mode: Python 3.11+ standard library only (`http.server`, `sqlite3`).
- **One optional dependency** for live calls: the official `anthropic` SDK.
- **No build step, no CDN**: the UI is plain HTML/CSS/ES modules served by the same process.
- **Local-first**: binds `127.0.0.1`, stores everything in one SQLite file, sends data only to the provider you pick.

## Quickstart

```sh
cd ai-os-dashboard
python3 -m venv .venv && . .venv/bin/activate
pip install -e .                        # mock provider, no network
aios seed                               # optional: demo agents + 14 days of synthetic runs
aios serve                              # http://127.0.0.1:8787
```

Live Claude calls:

```sh
pip install -e '.[anthropic]'
export ANTHROPIC_API_KEY=...            # never stored by the dashboard
aios serve                              # provider auto-switches to "anthropic"
```

Without installing: `PYTHONPATH=src python3 -m aios serve`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AIOS_PROVIDER` | `auto` | `anthropic`, `mock`, or `auto` (Anthropic when the SDK and a key are present) |
| `AIOS_HOST` | `127.0.0.1` | Bind address. Non-loopback requires `AIOS_TOKEN` |
| `AIOS_PORT` | `8787` | Port |
| `AIOS_DB` | `data/aios.sqlite3` | SQLite database path |
| `AIOS_TOKEN` | unset | If set, every `/api/*` request needs `Authorization: Bearer <token>` |

CLI flags `--host`, `--port`, `--db` and `--provider` override the environment.

## Layout

```
src/aios/
  models.py      model registry: IDs, prices, capabilities, cost function
  providers.py   Provider protocol, MockProvider, AnthropicProvider (the only network code)
  store.py       SQLite schema and queries
  service.py     validation, run orchestration, overview metrics (no HTTP, no SQL)
  server.py      HTTP routing, auth, security headers, static files
  seed.py        demo data (mock only)
  static/        index.html, app.js, styles.css
tests/           unittest suites; the SDK-specific ones skip when the SDK is absent
```

## Claude API usage

`AnthropicProvider` sends one `beta.messages.create` request per run:

- The agent's system prompt is a single text block with `cache_control: {"type": "ephemeral"}`. Repeat runs of
  the same agent read it from the prompt cache. Keep system prompts stable: any byte change invalidates the cache.
  Prompts below the model's minimum cacheable length (512 to 4096 tokens) are not cached; the Runs view shows
  `cache_read_tokens` so you can verify.
- `output_config.effort` is sent for models that support it (all except Haiku 4.5).
- Server-side refusal fallbacks are on (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) for
  Opus 5.5, Fable 5.1 and Sonnet 5.5. A fallback-served run is billed at the serving model's rate.
- `stop_reason: "refusal"` is recorded as status `refused`. API errors are recorded as status `error` and
  never crash the server. The SDK retries 408/409/429/5xx twice.

Default model: `claude-opus-5-5`. Prices in `models.py` are first-party API list prices cached on 2026-09-25,
with 5-minute cache writes at 1.25x input. Costs shown are estimates; your invoice is authoritative.

## HTTP API

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/api/health` | |
| GET | `/api/models` | |
| GET | `/api/overview` | `?days=1..90` |
| GET / POST | `/api/agents` | `{name, system_prompt, model?, effort?, enabled?}` |
| GET / PATCH / DELETE | `/api/agents/{id}` | partial agent fields |
| POST | `/api/agents/{id}/runs` | `{prompt}` |
| GET | `/api/runs` | `?limit=1..500&agent_id=` |

## Security model

- Loopback bind by default; the server refuses a public bind without `AIOS_TOKEN`.
- Host-header check blocks DNS rebinding against the loopback server.
- Mutating requests must be `application/json`, which forces a CORS preflight and blocks cross-site form posts.
- Strict CSP (`default-src 'self'`, no inline script or style), `nosniff`, `no-referrer`, `frame-ancestors 'none'`.
- Request bodies are capped at 256 KB; static file serving is confined to `static/`.
- The UI renders all model and user text with `textContent`, never as HTML.
- API keys are read by the SDK from the environment and never written to disk or returned by the API.

There are no user accounts. Treat `AIOS_TOKEN` as a single shared secret and put TLS in front of any
non-loopback deployment.

## Develop

```sh
pip install -e '.[dev]'
ruff check . && ruff format --check .
mypy                                     # strict
python -m unittest discover -s tests -t .
```
