"""Page persistence logic. Pure DB operations, no HTTP concerns."""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import Page
from .slugs import slugify

TITLE_MAX = 200
BODY_MAX = 200_000
_SLUG_RETRIES = 5


class ValidationError(ValueError):
    pass


def validate(title: str, body_md: str) -> tuple[str, str]:
    title = title.strip()
    if not title:
        raise ValidationError("Titel mangler.")
    if len(title) > TITLE_MAX:
        raise ValidationError(f"Titel må højst være {TITLE_MAX} tegn.")
    if len(body_md) > BODY_MAX:
        raise ValidationError(f"Indhold må højst være {BODY_MAX} tegn.")
    return title, body_md


def list_pages(db: Session) -> Sequence[Page]:
    return db.scalars(select(Page).order_by(Page.updated_at.desc())).all()


def get_page(db: Session, slug: str) -> Page | None:
    return db.scalars(select(Page).where(Page.slug == slug)).one_or_none()


def _free_slug(db: Session, base: str) -> str:
    taken = set(
        db.scalars(
            select(Page.slug).where((Page.slug == base) | Page.slug.like(f"{base}-%"))
        )
    )
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


def create_page(db: Session, title: str, body_md: str) -> Page:
    title, body_md = validate(title, body_md)
    base = slugify(title)
    for _ in range(_SLUG_RETRIES):
        page = Page(slug=_free_slug(db, base), title=title, body_md=body_md)
        db.add(page)
        try:
            db.commit()
        except IntegrityError:
            # Concurrent insert grabbed the same slug; recompute and retry.
            db.rollback()
            continue
        return page
    raise RuntimeError(f"Could not allocate a unique slug for {base!r}")


def update_page(db: Session, page: Page, title: str, body_md: str) -> Page:
    # Slug is intentionally stable: renaming a page must not break its URL.
    page.title, page.body_md = validate(title, body_md)
    db.commit()
    return page


def delete_page(db: Session, page: Page) -> None:
    db.delete(page)
    db.commit()
