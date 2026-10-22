"""FastAPI application: HTML routes for creating, viewing, editing and deleting pages.

Run with: uvicorn app.main:create_app --factory
"""

from collections.abc import Iterator
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Form, HTTPException, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from . import pages
from .config import Settings, load_settings
from .db import Base, make_engine, make_sessionmaker, session_scope
from .models import Page
from .rendering import render_markdown

_HERE = Path(__file__).resolve().parent

# Pages load only same-origin assets; nothing is fetched from third-party CDNs.
_CSP = (
    "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; "
    "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    engine = make_engine(settings.database_url)
    Base.metadata.create_all(engine)
    factory = make_sessionmaker(engine)

    app = FastAPI(title=settings.site_title, docs_url=None, redoc_url=None, openapi_url=None)
    app.mount("/static", StaticFiles(directory=_HERE / "static"), name="static")
    templates = Jinja2Templates(directory=_HERE / "templates")
    templates.env.globals["site_title"] = settings.site_title

    def get_db() -> Iterator[Session]:
        yield from session_scope(factory)

    Db = Annotated[Session, Depends(get_db)]

    @app.middleware("http")
    async def security_headers(request: Request, call_next):  # type: ignore[no-untyped-def]
        response: Response = await call_next(request)
        response.headers.setdefault("Content-Security-Policy", _CSP)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        return response

    def page_or_404(db: Session, slug: str) -> Page:
        page = pages.get_page(db, slug)
        if page is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Siden findes ikke.")
        return page

    def form(request: Request, *, action: str, title: str, body_md: str,
             error: str | None = None, page: Page | None = None) -> HTMLResponse:
        return templates.TemplateResponse(
            request,
            "page_form.html",
            {"action": action, "title": title, "body_md": body_md, "error": error, "page": page},
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT if error else status.HTTP_200_OK,
        )

    def see_other(url: str) -> RedirectResponse:
        return RedirectResponse(url, status_code=status.HTTP_303_SEE_OTHER)

    @app.get("/", response_class=HTMLResponse)
    def index(request: Request, db: Db) -> HTMLResponse:
        return templates.TemplateResponse(request, "index.html", {"pages": pages.list_pages(db)})

    @app.get("/pages/new", response_class=HTMLResponse)
    def new_page(request: Request) -> HTMLResponse:
        return form(request, action="/pages", title="", body_md="")

    @app.post("/pages", response_model=None)
    def create_page(
        request: Request, db: Db,
        title: Annotated[str, Form()], body_md: Annotated[str, Form()] = "",
    ) -> Response:
        try:
            page = pages.create_page(db, title, body_md)
        except pages.ValidationError as exc:
            return form(request, action="/pages", title=title, body_md=body_md, error=str(exc))
        return see_other(f"/pages/{page.slug}")

    @app.get("/pages/{slug}", response_class=HTMLResponse)
    def view_page(request: Request, slug: str, db: Db) -> HTMLResponse:
        page = page_or_404(db, slug)
        return templates.TemplateResponse(
            request, "page_view.html", {"page": page, "body_html": render_markdown(page.body_md)}
        )

    @app.get("/pages/{slug}/edit", response_class=HTMLResponse)
    def edit_page(request: Request, slug: str, db: Db) -> HTMLResponse:
        page = page_or_404(db, slug)
        return form(request, action=f"/pages/{page.slug}", title=page.title,
                    body_md=page.body_md, page=page)

    @app.post("/pages/{slug}", response_model=None)
    def update_page(
        request: Request, slug: str, db: Db,
        title: Annotated[str, Form()], body_md: Annotated[str, Form()] = "",
    ) -> Response:
        page = page_or_404(db, slug)
        try:
            pages.update_page(db, page, title, body_md)
        except pages.ValidationError as exc:
            db.rollback()
            return form(request, action=f"/pages/{slug}", title=title, body_md=body_md,
                        error=str(exc), page=page)
        return see_other(f"/pages/{page.slug}")

    @app.post("/pages/{slug}/delete")
    def delete_page(slug: str, db: Db) -> RedirectResponse:
        pages.delete_page(db, page_or_404(db, slug))
        return see_other("/")

    return app

