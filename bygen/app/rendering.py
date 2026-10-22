"""Markdown -> sanitized HTML.

SimpleMDE's preview is client-side only and is NOT a security boundary.
Everything shown to other users is rendered and sanitized here.
"""

from __future__ import annotations

import markdown
import nh3

_MD_EXTENSIONS = ["fenced_code", "tables", "sane_lists"]

_ALLOWED_TAGS = {
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "em", "del", "code", "pre", "blockquote",
    "ul", "ol", "li", "a", "img",
    "table", "thead", "tbody", "tr", "th", "td",
}
_ALLOWED_ATTRS = {
    "a": {"href", "title"},
    "img": {"src", "alt", "title"},
    "th": {"align"},
    "td": {"align"},
}


def render_markdown(source: str) -> str:
    html = markdown.markdown(source, extensions=_MD_EXTENSIONS, output_format="html")
    return nh3.clean(
        html,
        tags=_ALLOWED_TAGS,
        attributes=_ALLOWED_ATTRS,
        url_schemes={"http", "https", "mailto"},
        link_rel="noopener noreferrer nofollow",
    )
