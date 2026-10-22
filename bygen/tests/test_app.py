from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.rendering import render_markdown
from app.slugs import slugify


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    settings = Settings(database_url=f"sqlite:///{tmp_path / 'test.db'}", site_title="Test")
    with TestClient(create_app(settings)) as c:
        yield c


def test_slugify_danish() -> None:
    assert slugify("Rødgrød med fløde på Ærø!") == "roedgroed-med-floede-paa-aeroe"
    assert slugify("!!!") == "side"


def test_render_strips_script_and_js_urls() -> None:
    html = render_markdown("<script>alert(1)</script>\n\n[x](javascript:alert(1)) **ok**")
    assert "<script" not in html
    assert "javascript:" not in html
    assert "<strong>ok</strong>" in html


def test_create_view_edit_delete(client: TestClient) -> None:
    r = client.post("/pages", data={"title": "Byens Park", "body_md": "# Hej\n\n*park*"},
                    follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"] == "/pages/byens-park"

    r = client.get("/pages/byens-park")
    assert r.status_code == 200
    assert "<em>park</em>" in r.text
    assert "default-src 'self'" in r.headers["content-security-policy"]

    r = client.post("/pages/byens-park", data={"title": "Nyt navn", "body_md": "x"},
                    follow_redirects=False)
    assert r.headers["location"] == "/pages/byens-park"  # slug stays stable
    assert "Nyt navn" in client.get("/").text

    r = client.post("/pages/byens-park/delete", follow_redirects=False)
    assert r.status_code == 303
    assert client.get("/pages/byens-park").status_code == 404


def test_duplicate_titles_get_unique_slugs(client: TestClient) -> None:
    locs = [client.post("/pages", data={"title": "Torvet"}, follow_redirects=False)
            .headers["location"] for _ in range(3)]
    assert locs == ["/pages/torvet", "/pages/torvet-2", "/pages/torvet-3"]


def test_validation_rerenders_form(client: TestClient) -> None:
    r = client.post("/pages", data={"title": "   ", "body_md": "bevar mig"})
    assert r.status_code == 422
    assert "Titel mangler." in r.text
    assert "bevar mig" in r.text


def test_form_escapes_user_input(client: TestClient) -> None:
    client.post("/pages", data={"title": "a", "body_md": "</textarea><script>x</script>"})
    r = client.get("/pages/a/edit")
    assert "</textarea><script>" not in r.text


def test_static_editor_assets_served(client: TestClient) -> None:
    for path in ("vendor/simplemde.min.js", "vendor/bulma.min.css", "js/editor.js"):
        assert client.get(f"/static/{path}").status_code == 200
