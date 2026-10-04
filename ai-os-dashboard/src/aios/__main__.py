"""CLI entry point: `python -m aios serve` / `python -m aios seed`."""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import replace
from pathlib import Path

from .config import Settings, resolve_provider
from .providers import ProviderError, make_provider
from .seed import seed_demo
from .server import make_server
from .service import Dashboard
from .store import Store


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aios", description="AI OS Dashboard")
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="run the dashboard server")
    serve.add_argument("--host")
    serve.add_argument("--port", type=int)
    serve.add_argument("--db", type=Path)
    serve.add_argument("--provider", choices=("auto", "anthropic", "mock"))
    seed = sub.add_parser("seed", help="write demo agents and synthetic runs (no network)")
    seed.add_argument("--db", type=Path)
    seed.add_argument("--days", type=int, default=14)
    args = parser.parse_args(argv)

    settings = Settings.from_env(os.environ)
    if args.db:
        settings = replace(settings, db_path=args.db)

    if args.command == "seed":
        store = Store(settings.db_path)
        count = seed_demo(store, days=args.days)
        store.close()
        print(f"seeded {count} demo runs into {settings.db_path}")
        return 0

    if args.host:
        settings = replace(settings, host=args.host)
    if args.port is not None:
        settings = replace(settings, port=args.port)
    if args.provider:
        settings = replace(settings, provider=resolve_provider(args.provider, os.environ))
    if settings.host not in ("127.0.0.1", "localhost", "::1") and settings.api_token is None:
        print("refusing to bind a non-loopback host without AIOS_TOKEN set", file=sys.stderr)
        return 2

    try:
        provider = make_provider(settings.provider, timeout_s=settings.request_timeout_s)
    except ProviderError as exc:
        print(f"provider error: {exc}", file=sys.stderr)
        return 2
    store = Store(settings.db_path)
    server = make_server(Dashboard(store, provider, max_output_tokens=settings.max_output_tokens), settings)
    print(f"AI OS Dashboard on http://{settings.host}:{server.server_port}  provider={provider.name}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
