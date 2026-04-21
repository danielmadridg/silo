"""Web search (DuckDuckGo HTML scraping) + web fetch."""
import re
import html as html_lib
import httpx


HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Silo/1.0",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


async def web_search(query: str, max_results: int = 8) -> str:
    """Scrape DuckDuckGo HTML results — no API key needed."""
    try:
        async with httpx.AsyncClient(timeout=15.0, headers=HEADERS, follow_redirects=True) as c:
            r = await c.get("https://html.duckduckgo.com/html/", params={"q": query})
            r.raise_for_status()
            html = r.text

        result_re = re.compile(
            r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?'
            r'<a[^>]+class="result__snippet"[^>]*>(.*?)</a>',
            re.DOTALL,
        )
        results: list[str] = []
        for i, m in enumerate(result_re.finditer(html)):
            if i >= max_results:
                break
            url = html_lib.unescape(m.group(1))
            title = re.sub(r"<[^>]+>", "", m.group(2)).strip()
            snippet = re.sub(r"<[^>]+>", "", m.group(3)).strip()
            url = re.sub(r"^//duckduckgo\.com/l/\?uddg=", "", url)
            try:
                from urllib.parse import unquote
                if "uddg=" in url:
                    url = unquote(url.split("uddg=")[1].split("&")[0])
            except Exception:
                pass
            results.append(f"{i+1}. {html_lib.unescape(title)}\n   {url}\n   {html_lib.unescape(snippet)}")

        if not results:
            return f"No results for: {query}"
        return f"Search: {query}\n\n" + "\n\n".join(results)
    except Exception as e:
        return f"Error: web_search failed: {e}"


async def web_fetch(url: str, max_chars: int = 8000) -> str:
    """Fetch a URL and return extracted text content."""
    try:
        async with httpx.AsyncClient(timeout=20.0, headers=HEADERS, follow_redirects=True) as c:
            r = await c.get(url)
            r.raise_for_status()
            ctype = r.headers.get("content-type", "")
            body = r.text

        if "html" in ctype or "<html" in body[:1000].lower():
            body = re.sub(r"<script[^>]*>.*?</script>", " ", body, flags=re.DOTALL | re.IGNORECASE)
            body = re.sub(r"<style[^>]*>.*?</style>", " ", body, flags=re.DOTALL | re.IGNORECASE)
            body = re.sub(r"<[^>]+>", " ", body)
            body = html_lib.unescape(body)
            body = re.sub(r"\s+", " ", body).strip()

        truncated = len(body) > max_chars
        out = body[:max_chars]
        if truncated:
            out += f"\n\n[truncated — {len(body):,} total chars]"
        return f"URL: {url}\n\n{out}"
    except Exception as e:
        return f"Error: web_fetch failed: {e}"
