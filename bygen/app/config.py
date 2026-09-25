"""Runtime configuration. Read once from the environment; no external calls."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class Settings:
    database_url: str
    site_title: str


def load_settings() -> Settings:
    default_db = Path(__file__).resolve().parent.parent / "bygen.db"
    return Settings(
        database_url=os.environ.get("BYGEN_DATABASE_URL", f"sqlite:///{default_db}"),
        site_title=os.environ.get("BYGEN_SITE_TITLE", "Bygen"),
    )
