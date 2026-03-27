"""
Proactive Test Suite -- Shared Infrastructure

Data factories that produce schema-accurate synthetic source_docs matching
the exact format produced by the proactive_agent_handler worker (lines 316-323):
  {source, timestamp, metadata: {all remaining SQLite columns + _context_type + _batch}}
"""

import pytest
import requests
from datetime import datetime, timezone
from pathlib import PurePosixPath
from uuid import uuid4

BASE_URL = "http://localhost:8765"

# Module-scoped session for TCP connection pooling across the full suite.
_session = requests.Session()


# ---------------------------------------------------------------------------
# Timestamp helpers
# ---------------------------------------------------------------------------

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def today_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Synthetic data factories
# ---------------------------------------------------------------------------

class SyntheticEmail:
    """Build a schema-accurate email source_doc matching email_logs table."""

    @staticmethod
    def make(
        subject: str,
        sender: str,
        body_preview: str,
        recipients: str = "user@company.com",
        file_path: str = "Mail.app",
        timestamp: str = None,
    ) -> dict:
        ts = timestamp or now_iso()
        day = ts[:10] if len(ts) >= 10 else today_str()
        return {
            "source": "email",
            "timestamp": ts,
            "metadata": {
                "subject": subject,
                "sender": sender,
                "recipients": recipients,
                "body_preview": body_preview,
                "file_path": file_path,
                "day_date": day,
                "_context_type": "triggering_log",
                "_batch": "current",
            },
        }


class SyntheticBrowser:
    """Build a schema-accurate browser source_doc matching browser_logs table."""

    @staticmethod
    def make(
        url: str,
        title: str,
        visit_count: int = 1,
        typed_count: int = 0,
        profile: str = "Default",
        timestamp: str = None,
    ) -> dict:
        ts = timestamp or now_iso()
        day = ts[:10] if len(ts) >= 10 else today_str()
        return {
            "source": "browser",
            "timestamp": ts,
            "metadata": {
                "url": url,
                "title": title,
                "visit_count": visit_count,
                "typed_count": typed_count,
                "profile": profile,
                "day_date": day,
                "_context_type": "triggering_log",
                "_batch": "current",
            },
        }


class SyntheticFilesystem:
    """Build a schema-accurate filesystem source_doc matching fs_logs table."""

    @staticmethod
    def make(
        action: str,
        file_path: str,
        content_preview: str = "",
        location_name: str = "",
        timestamp: str = None,
    ) -> dict:
        ts = timestamp or now_iso()
        day = ts[:10] if len(ts) >= 10 else today_str()
        p = PurePosixPath(file_path)
        return {
            "source": "filesystem",
            "timestamp": ts,
            "metadata": {
                "action": action,
                "file_path": file_path,
                "file_name": p.name,
                "file_extension": p.suffix.lower(),
                "content_preview": content_preview,
                "location_name": location_name or p.parent.name,
                "day_date": day,
                "_context_type": "triggering_log",
                "_batch": "current",
            },
        }


class SyntheticPreviousQuery:
    """Build a background_history doc representing a previous query batch."""

    @staticmethod
    def make(query: str, batch_offset: int = 1, timestamp: str = None) -> dict:
        ts = timestamp or now_iso()
        return {
            "source": "query_gen",
            "timestamp": ts,
            "metadata": {
                "_context_type": "previous_query",
                "_batch": f"N-{batch_offset}",
                "query": query,
                "batch_id": str(uuid4())[:8],
                "query_id": str(uuid4()),
            },
        }


# ---------------------------------------------------------------------------
# Scout API helper
# ---------------------------------------------------------------------------

def scout(
    queries: list,
    source_docs: list,
    query_ids: list = None,
    mode: str = "balanced",
    timeout: int = 180,
) -> dict:
    """POST to /v1/proactive/scout. Fails the test on non-200."""
    payload = {
        "query_ids": query_ids or [str(uuid4()) for _ in queries],
        "queries": queries,
        "source_docs": source_docs,
        "day_date": today_str(),
    }
    resp = _session.post(
        f"{BASE_URL}/v1/proactive/scout",
        json=payload,
        timeout=timeout,
    )
    if resp.status_code != 200:
        pytest.fail(f"Scout returned {resp.status_code}: {resp.text[:500]}")
    result = resp.json()
    # Debug output (captured by pytest -s)
    decision = result.get("decision")
    budget = result.get("tool_budget")
    tools = result.get("tool_calls_count")
    rec = "yes" if result.get("recommendation") else "no"
    print(f"  -> decision={decision}  budget={budget}  tools={tools}  rec={rec}")
    return result


def post_feedback(run_id: str, feedback: str) -> dict:
    """POST feedback for a proactive run."""
    resp = _session.post(
        f"{BASE_URL}/v1/proactive/{run_id}/feedback",
        params={"feedback": feedback},
        timeout=30,
    )
    assert resp.status_code == 200, f"Feedback returned {resp.status_code}: {resp.text[:300]}"
    return resp.json()


def get_stats(days: int = 1) -> dict:
    """GET proactive stats."""
    resp = _session.get(
        f"{BASE_URL}/v1/proactive/stats",
        params={"days": days},
        timeout=30,
    )
    assert resp.status_code == 200, f"Stats returned {resp.status_code}: {resp.text[:300]}"
    return resp.json()
