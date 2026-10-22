"""URL slug generation with Danish transliteration."""

from __future__ import annotations

import re
import unicodedata

_DANISH = str.maketrans({"æ": "ae", "ø": "oe", "å": "aa", "Æ": "ae", "Ø": "oe", "Å": "aa"})
_NON_ALNUM = re.compile(r"[^a-z0-9]+")
MAX_SLUG_LEN = 100


def slugify(text: str) -> str:
    text = text.translate(_DANISH)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    slug = _NON_ALNUM.sub("-", text.lower()).strip("-")
    return slug[:MAX_SLUG_LEN].rstrip("-") or "side"
