"""
Cross-platform Chromium (Edge/Chrome/Chromium) history reader.

@.architecture
Incoming: application/services/source_indexing_service.py --- {browser: str, profile paths}
Processing: resolve profile directories, read History sqlite, format entries --- {JOB_LOAD_DATA, JOB_TRANSFORM_DATA}
Outgoing: application/services/source_indexing_service.py --- {List[dict] visit entries}
"""

import logging
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

logger = logging.getLogger(__name__)

# Domain → query parameter name for known search engines.
# Deterministic URL parsing — no LLM, no Chrome internals.
# Covers Google, Bing, DuckDuckGo, YouTube, Amazon, Reddit, arXiv,
# Semantic Scholar, PubMed, Baidu, Yandex, Brave, Ecosia, Wikipedia.
SEARCH_PARAMS: Dict[str, str] = {
    "google.com": "q",
    "google.co.uk": "q",
    "google.de": "q",
    "google.fr": "q",
    "scholar.google.com": "q",
    "bing.com": "q",
    "duckduckgo.com": "q",
    "youtube.com": "search_query",
    "amazon.com": "k",
    "amazon.co.uk": "k",
    "amazon.de": "k",
    "reddit.com": "q",
    "arxiv.org": "query",
    "semanticscholar.org": "q",
    "pubmed.ncbi.nlm.nih.gov": "term",
    "baidu.com": "wd",
    "yandex.com": "text",
    "search.brave.com": "q",
    "ecosia.org": "q",
    "en.wikipedia.org": "search",
}


def extract_search_query(url: str) -> Optional[str]:
    """
    Extract the user's search query from a URL's query parameters.

    Works for any Chromium browser — parses the URL directly, no Chrome internals.
    Returns None if the URL is not a recognized search engine or has no query param.
    """
    if not url:
        return None

    try:
        parsed = urlparse(url)
        hostname = (parsed.hostname or "").lower()

        # Match against known search engine domains (suffix match for subdomains)
        param_name = None
        for domain, param in SEARCH_PARAMS.items():
            if hostname == domain or hostname.endswith("." + domain):
                param_name = param
                break

        if param_name is None:
            return None

        qs = parse_qs(parsed.query, keep_blank_values=False)
        values = qs.get(param_name)
        if values:
            query = values[0].strip()
            return query if query else None
        return None
    except Exception:
        return None


def resolve_chromium_user_data_dir(browser: str) -> Optional[Path]:
    """
    Return the "User Data" directory that contains profiles (Default, Profile 1, ...).
    """
    browser = (browser or "").strip().lower()
    if browser not in {"edge", "chrome", "chromium"}:
        raise ValueError("browser must be one of: edge|chrome|chromium")

    home = Path.home()
    # Windows: LOCALAPPDATA points to AppData\\Local
    local_appdata = os.environ.get("LOCALAPPDATA")

    if os.name == "nt":
        if not local_appdata:
            return None
        base = Path(local_appdata)
        if browser == "edge":
            return base / "Microsoft" / "Edge" / "User Data"
        if browser == "chrome":
            return base / "Google" / "Chrome" / "User Data"
        return base / "Chromium" / "User Data"

    # macOS
    if sys_platform() == "darwin":
        if browser == "edge":
            return home / "Library" / "Application Support" / "Microsoft Edge"
        if browser == "chrome":
            return home / "Library" / "Application Support" / "Google" / "Chrome"
        return home / "Library" / "Application Support" / "Chromium"

    # Linux
    if sys_platform().startswith("linux"):
        if browser == "edge":
            return home / ".config" / "microsoft-edge"
        if browser == "chrome":
            return home / ".config" / "google-chrome"
        return home / ".config" / "chromium"

    return None


def sys_platform() -> str:
    import sys
    return sys.platform


def find_profile_dirs(user_data_dir: Path) -> List[Path]:
    """
    Locate profile directories under a Chromium user-data directory.
    """
    if not user_data_dir.exists():
        return []

    profiles: List[Path] = []
    default_profile = user_data_dir / "Default"
    if (default_profile / "History").exists():
        profiles.append(default_profile)

    for item in user_data_dir.iterdir():
        if item.is_dir() and item.name.startswith("Profile "):
            if (item / "History").exists():
                profiles.append(item)

    return profiles


def chrome_time_to_iso(chrome_time_microseconds: int) -> str:
    """
    Chrome/Chromium stores time as microseconds since 1601-01-01 UTC.
    """
    if not chrome_time_microseconds:
        return ""
    # 1601-01-01 -> 1970-01-01 = 11644473600 seconds
    unix_seconds = (chrome_time_microseconds / 1_000_000) - 11644473600
    dt = datetime.fromtimestamp(unix_seconds, tz=timezone.utc)
    return dt.isoformat()


def datetime_to_chrome_time(dt: datetime) -> int:
    """
    Convert Python datetime to Chrome/Chromium time format (microseconds since 1601-01-01 UTC).
    """
    unix_seconds = dt.timestamp()
    # 1601-01-01 -> 1970-01-01 = 11644473600 seconds
    chrome_seconds = unix_seconds + 11644473600
    chrome_microseconds = int(chrome_seconds * 1_000_000)
    return chrome_microseconds


def read_history_entries(
    profile_dir: Path,
    max_items: Optional[int] = None,
    since_time: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """
    Read recent history entries from a profile's History SQLite database.
    
    Args:
        profile_dir: Path to browser profile directory
        max_items: Maximum number of entries to return (None = all)
        since_time: Only return entries visited after this time (None = all)
    """
    history_db_path = profile_dir / "History"
    if not history_db_path.exists():
        return []

    # Use immutable mode to avoid database locks
    conn = sqlite3.connect(f"file:{history_db_path}?immutable=1", uri=True)
    try:
        cursor = conn.cursor()
        
        # Build query with optional time filtering
        if since_time:
            chrome_since_time = datetime_to_chrome_time(since_time)
            query = """
            SELECT
                last_visit_time,
                url,
                title,
                visit_count,
                typed_count
            FROM urls
            WHERE last_visit_time >= ?
            ORDER BY last_visit_time DESC
            """
            cursor.execute(query, (chrome_since_time,))
        else:
            query = """
            SELECT
                last_visit_time,
                url,
                title,
                visit_count,
                typed_count
            FROM urls
            ORDER BY last_visit_time DESC
            """
            cursor.execute(query)
        
        rows = cursor.fetchall()

        entries: List[Dict[str, Any]] = []
        limit = max_items if max_items and max_items > 0 else None
        for idx, row in enumerate(rows):
            if limit is not None and idx >= limit:
                break
            last_visit_time, url, title, visit_count, typed_count = row
            entries.append(
                {
                    "url": url or "",
                    "title": title or "",
                    "last_visit_time": chrome_time_to_iso(int(last_visit_time or 0)),
                    "visit_count": int(visit_count or 0),
                    "typed_count": int(typed_count or 0),
                    "profile": profile_dir.name,
                }
            )
        return entries
    finally:
        conn.close()


def format_history_entry(entry: Dict[str, Any]) -> str:
    title = (entry.get("title") or "").strip()
    url = (entry.get("url") or "").strip()
    last_visit = (entry.get("last_visit_time") or "").strip()
    visit_count = entry.get("visit_count", 0)
    typed_count = entry.get("typed_count", 0)
    profile = (entry.get("profile") or "").strip()

    parts = []
    if title:
        parts.append(f"[Title]: {title}")
    if url:
        parts.append(f"[URL]: {url}")
    if last_visit:
        parts.append(f"[Last visited]: {last_visit}")
    parts.append(f"[Visit count]: {visit_count}")
    parts.append(f"[Typed count]: {typed_count}")
    if profile:
        parts.append(f"[Profile]: {profile}")
    return "\n".join(parts)


def read_search_queries(
    profile_dir: Path,
    since_time: Optional[datetime] = None,
    max_items: int = 50,
) -> List[Dict[str, Any]]:
    """
    Read search queries from Chrome's keyword_search_terms table (supplementary).

    This table records omnibox keyword searches (custom keyword shortcuts, address
    bar searches). It does NOT capture searches typed directly on google.com —
    use extract_search_query() for that (primary method).

    Wrapped in try/except — the table may not exist in all Chrome versions.

    Args:
        profile_dir: Path to browser profile directory
        since_time: Only return entries after this time (None = all)
        max_items: Maximum entries to return
    """
    history_db_path = profile_dir / "History"
    if not history_db_path.exists():
        return []

    conn = sqlite3.connect(f"file:{history_db_path}?immutable=1", uri=True)
    try:
        cursor = conn.cursor()

        # Check if keyword_search_terms table exists (not present in all versions)
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='keyword_search_terms'"
        )
        if not cursor.fetchone():
            return []

        if since_time:
            chrome_since = datetime_to_chrome_time(since_time)
            cursor.execute(
                """
                SELECT kst.term, kst.normalized_term, u.url, u.title, u.last_visit_time
                FROM keyword_search_terms kst
                JOIN urls u ON kst.url_id = u.id
                WHERE u.last_visit_time >= ?
                ORDER BY u.last_visit_time DESC
                LIMIT ?
                """,
                (chrome_since, max_items),
            )
        else:
            cursor.execute(
                """
                SELECT kst.term, kst.normalized_term, u.url, u.title, u.last_visit_time
                FROM keyword_search_terms kst
                JOIN urls u ON kst.url_id = u.id
                ORDER BY u.last_visit_time DESC
                LIMIT ?
                """,
                (max_items,),
            )

        entries: List[Dict[str, Any]] = []
        for term, normalized_term, url, title, last_visit_time in cursor.fetchall():
            entries.append({
                "term": term or "",
                "normalized_term": normalized_term or "",
                "url": url or "",
                "title": title or "",
                "last_visit_time": chrome_time_to_iso(int(last_visit_time or 0)),
            })
        return entries
    except Exception as e:
        logger.warning("Failed to read keyword_search_terms: %s", e)
        return []
    finally:
        conn.close()

