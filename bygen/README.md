# Bygen

A small CMS for pages. It uses FastAPI, SQLite with SQLAlchemy 2, Bulma and SimpleMDE.

```sh
pip install -r requirements-dev.txt
uvicorn app.main:create_app --factory --reload   # http://127.0.0.1:8000
pytest -q
```

| Env var              | Default              |
|----------------------|----------------------|
| `BYGEN_DATABASE_URL` | `sqlite:///bygen.db` |
| `BYGEN_SITE_TITLE`   | `Bygen`              |

## Layout

- `app/main.py`: app factory and HTML routes (`/`, `/pages/new`, `/pages/{slug}`, `/edit`, `/delete`)
- `app/pages.py`: DB operations and validation. It has no HTTP code.
- `app/rendering.py`: server-side Markdown rendering with `nh3` sanitizing. The SimpleMDE preview is not a security boundary.
- `app/slugs.py`: slugs with æ/ø/å transliteration. A slug stays the same when a page is renamed.
- `app/static/vendor/`: Bulma 1.0.4, SimpleMDE 1.11.2 and Font Awesome 4.7, served locally.

## Privacy

The app makes no external calls. Every asset is served same-origin, and the CSP enforces `default-src 'self'`.
SimpleMDE's own CDN fetches are turned off in `static/js/editor.js`: Font Awesome auto-download and the spell-checker dictionaries.

## Not implemented yet

- **Authentication.** Anyone who can reach the server can create, edit and delete pages. Put it behind a reverse proxy with auth, or add a login, before exposing it.
- **CSRF protection.** This matters once there is a login.
- **Migrations.** Tables are created with `create_all`. Add Alembic before the schema changes.
- **Time zone.** Times are stored and shown in UTC, so they are not in Danish local time yet.
