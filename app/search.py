"""Keyless web search via DuckDuckGo HTML."""

from __future__ import annotations
import logging, re
from urllib.parse import parse_qs, unquote, urlparse
import httpx

logger = logging.getLogger(__name__)

_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

_RX = re.compile(
    r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>'
    r'.*?(?:<a[^>]+class="result__snippet"[^>]*>(.*?)</a>)?',
    re.DOTALL | re.IGNORECASE,
)


def _clean(html: str) -> str:
    t = re.sub(r"<[^>]+>", "", html or "")
    for a, b in (("&amp;", "&"), ("&quot;", '"'), ("&#x27;", "'"),
                 ("&lt;", "<"), ("&gt;", ">"), ("&nbsp;", " ")):
        t = t.replace(a, b)
    return re.sub(r"\s+", " ", t).strip()


def _unwrap(url: str) -> str:
    if "uddg=" in url:
        try:
            qs = parse_qs(urlparse(url).query)
            if "uddg" in qs:
                return unquote(qs["uddg"][0])
        except Exception:
            pass
    return url


async def web_search(query: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=True,
                                     headers={"User-Agent": _UA}) as c:
            r = await c.post("https://html.duckduckgo.com/html/",
                             data={"q": query, "kl": "in-en"})
            r.raise_for_status()
            html = r.text
    except Exception as e:
        logger.warning("web_search failed: %s", e)
        return {"kind": "web_search", "query": query, "results": [],
                "answer_text": f"Web search unavailable ({type(e).__name__})."}

    results = []
    for m in _RX.finditer(html):
        href = _unwrap(m.group(1))
        title = _clean(m.group(2))
        snippet = _clean(m.group(3) or "")
        if not title or not href or href.startswith("//duckduckgo"):
            continue
        results.append({"title": title, "url": href, "snippet": snippet[:320]})
        if len(results) >= 5:
            break

    if results:
        lines = [f"{i}. {r['title']} — {r['snippet'] or '(no snippet)'}"
                 for i, r in enumerate(results[:3], 1)]
        answer_text = (f"Search results for '{query}':\n" + "\n".join(lines)
                       + "\n\nSummarise these in 2–4 sentences and cite the sources by name.")
    else:
        answer_text = f"No useful results found for '{query}'."

    return {"kind": "web_search", "query": query, "results": results,
            "answer_text": answer_text}