"""
Tests for core.integrations.providers.memory_context.tools

Coverage target: 100% of tools.py (299 lines, 0 existing tests).

Mock boundaries:
- config.settings.get_settings → late import inside every function; patched at source module
- httpx.post/get/patch/delete → external HTTP calls

Real logic under test:
- URL construction (_get_api_base builds {base_url}/v1/memory)
- URL reconstruction in memories_search (rsplit + /v1/search/memories)
- Payload/params conditional assembly with settings defaults vs exception fallbacks
- Response extraction (.json(), .get("results", []), static dict for delete)
- HTTP error propagation via raise_for_status()
"""

from unittest.mock import MagicMock, patch

import httpx
import pytest

from core.integrations.providers.memory_context.tools import (
    _get_api_base,
    _get_timeout,
    memories_add,
    memories_delete,
    memories_edit,
    memories_get,
    memories_get_relations,
    memories_list,
    memories_relate,
    memories_search,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_BASE = "http://127.0.0.1:8765"
_MEMORY_URL = f"{_BASE}/v1/memory"
_TIMEOUT = 60.0
_MEM_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
_REL_ID = "11111111-2222-3333-4444-555555555555"


def _settings(
    base_url=_BASE,
    timeout=_TIMEOUT,
    valid_types=None,
    search_limit=10,
    match_threshold=0.5,
    default_auto_importance=0.5,
):
    """Build a mock settings object matching the attributes tools.py accesses."""
    s = MagicMock()
    s.base_url = base_url
    s.http_client.default_timeout = timeout
    s.memory_service.valid_memory_types = valid_types or [
        "fact", "decision", "preference", "insight", "skill"
    ]
    s.memory_service.default_search_limit = search_limit
    s.memory_service.vector_match_threshold = match_threshold
    s.memory_service.default_auto_importance = default_auto_importance
    return s


def _http_response(json_data=None, status_code=200):
    """Build a mock httpx.Response."""
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.json.return_value = json_data if json_data is not None else {}
    if status_code >= 400:
        resp.raise_for_status.side_effect = httpx.HTTPStatusError(
            f"HTTP {status_code}",
            request=MagicMock(),
            response=resp,
        )
    else:
        resp.raise_for_status.return_value = None
    return resp


# ---------------------------------------------------------------------------
# _get_api_base
# ---------------------------------------------------------------------------

class TestGetApiBase:
    """URL construction from settings.base_url."""

    @patch("config.settings.get_settings")
    def test_returns_correct_url(self, mock_gs):
        mock_gs.return_value = _settings(base_url="http://10.0.0.1:9000")
        assert _get_api_base() == "http://10.0.0.1:9000/v1/memory"

    @patch("config.settings.get_settings")
    def test_uses_default_base_url(self, mock_gs):
        mock_gs.return_value = _settings()
        assert _get_api_base() == f"{_BASE}/v1/memory"

    @patch("config.settings.get_settings", side_effect=RuntimeError("no config"))
    def test_propagates_settings_error(self, mock_gs):
        """_get_api_base has NO fallback — settings failure must propagate."""
        with pytest.raises(RuntimeError, match="no config"):
            _get_api_base()


# ---------------------------------------------------------------------------
# _get_timeout
# ---------------------------------------------------------------------------

class TestGetTimeout:
    """Timeout retrieval with exception fallback to 30.0."""

    @patch("config.settings.get_settings")
    def test_returns_settings_timeout(self, mock_gs):
        mock_gs.return_value = _settings(timeout=120.0)
        assert _get_timeout() == 120.0

    @patch("config.settings.get_settings", side_effect=ImportError)
    def test_fallback_on_import_error(self, mock_gs):
        assert _get_timeout() == 30.0

    @patch("config.settings.get_settings")
    def test_fallback_on_attribute_error(self, mock_gs):
        """Settings load but http_client.default_timeout access raises."""

        class _NoTimeout:
            @property
            def default_timeout(self):
                raise AttributeError("no attr")

        s = MagicMock()
        s.http_client = _NoTimeout()
        mock_gs.return_value = s
        assert _get_timeout() == 30.0


# ---------------------------------------------------------------------------
# memories_add
# ---------------------------------------------------------------------------

class TestMemoriesAdd:
    """POST to /v1/memory/create — payload assembly, settings defaults, fallbacks."""

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_full_args(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({"id": _MEM_ID, "status": "created"})

        result = memories_add(
            content="User prefers dark mode",
            memory_type="preference",
            importance=0.9,
            source_chat_id="some-chat-uuid",
            tags=["ui", "preferences"],
            created_by="user",
        )

        mock_post.assert_called_once()
        call_args = mock_post.call_args
        assert call_args[0][0] == f"{_MEMORY_URL}/create"
        payload = call_args[1]["json"]
        assert payload["content"] == "User prefers dark mode"
        assert payload["memory_type"] == "preference"
        assert payload["importance_score"] == 0.9
        assert payload["source_chat_id"] == "some-chat-uuid"
        assert payload["metadata"] == {"tags": ["ui", "preferences"]}
        assert payload["created_by"] == "user"
        assert call_args[1]["timeout"] == _TIMEOUT
        assert result == {"id": _MEM_ID, "status": "created"}

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_defaults_from_settings(self, mock_post, mock_gs):
        """When memory_type/importance not provided, uses settings defaults."""
        mock_gs.return_value = _settings(valid_types=["decision", "fact"], default_auto_importance=0.8)
        mock_post.return_value = _http_response({"id": "x"})

        memories_add(content="test")

        payload = mock_post.call_args[1]["json"]
        assert payload["memory_type"] == "decision"  # first in valid_types
        assert payload["importance_score"] == 0.8
        assert payload["source_chat_id"] is None
        assert payload["metadata"] == {"tags": []}
        assert payload["created_by"] == "agent"

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_settings_exception_fallback(self, mock_post, mock_gs):
        """When settings fail on defaults, falls back to memory_type='fact', importance=0.5.

        get_settings() is called 3 times: once for defaults (try/except), once via
        _get_api_base(), once via _get_timeout(). First call must raise, rest succeed.
        """
        mock_gs.side_effect = [RuntimeError("boom"), _settings(), _settings()]
        mock_post.return_value = _http_response({"id": "y"})

        memories_add(content="fallback test")

        payload = mock_post.call_args[1]["json"]
        assert payload["memory_type"] == "fact"
        assert payload["importance_score"] == 0.5

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_caller_type_survives_settings_exception(self, mock_post, mock_gs):
        """If caller provides memory_type, it persists even if settings fail."""
        mock_gs.side_effect = [RuntimeError("boom"), _settings(), _settings()]
        mock_post.return_value = _http_response({"id": "z"})

        memories_add(content="x", memory_type="skill", importance=0.7)

        payload = mock_post.call_args[1]["json"]
        assert payload["memory_type"] == "skill"
        assert payload["importance_score"] == 0.7

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_importance_zero_not_overridden(self, mock_post, mock_gs):
        """importance=0.0 is falsy but valid (uses `is not None` check)."""
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({})

        memories_add(content="x", importance=0.0)

        payload = mock_post.call_args[1]["json"]
        assert payload["importance_score"] == 0.0

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_tags_none_becomes_empty_list(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({})

        memories_add(content="x", tags=None)

        payload = mock_post.call_args[1]["json"]
        assert payload["metadata"] == {"tags": []}

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_http_error_propagates(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response(status_code=500)

        with pytest.raises(httpx.HTTPStatusError):
            memories_add(content="fail")

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_returns_response_json(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        body = {"id": _MEM_ID, "content": "hi", "embedding": [0.1, 0.2]}
        mock_post.return_value = _http_response(body)

        result = memories_add(content="hi")
        assert result == body


# ---------------------------------------------------------------------------
# memories_search
# ---------------------------------------------------------------------------

class TestMemoriesSearch:
    """POST to /v1/search/memories — URL reconstruction, defaults, extraction."""

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_full_args_correct_url(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({"results": [{"id": "1"}]})

        result = memories_search(
            query="dark mode preferences",
            search_type="hybrid",
            limit=5,
            threshold=0.7,
            memory_type="preference",
        )

        call_args = mock_post.call_args
        # URL must be /v1/search/memories, NOT /v1/memory/search
        assert call_args[0][0] == f"{_BASE}/v1/search/memories"
        payload = call_args[1]["json"]
        assert payload["query"] == "dark mode preferences"
        assert payload["search_type"] == "hybrid"
        assert payload["match_count"] == 5
        assert payload["match_threshold"] == 0.7
        assert payload["memory_type"] == "preference"
        assert result == [{"id": "1"}]

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_defaults_from_settings(self, mock_post, mock_gs):
        mock_gs.return_value = _settings(search_limit=20, match_threshold=0.8)
        mock_post.return_value = _http_response({"results": []})

        memories_search(query="test")

        payload = mock_post.call_args[1]["json"]
        assert payload["search_type"] == "vector"  # default param
        assert payload["match_count"] == 20
        assert payload["match_threshold"] == 0.8
        assert payload["memory_type"] is None

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_settings_exception_fallback(self, mock_post, mock_gs):
        """First get_settings() call (defaults) fails; _get_api_base and _get_timeout succeed."""
        mock_gs.side_effect = [RuntimeError("boom"), _settings(), _settings()]
        mock_post.return_value = _http_response({"results": []})

        memories_search(query="test")

        payload = mock_post.call_args[1]["json"]
        assert payload["match_count"] == 10
        assert payload["match_threshold"] == 0.5

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_extracts_results_key(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({
            "results": [{"id": "a", "score": 0.9}],
            "total": 1,
            "query_time_ms": 42,
        })

        result = memories_search(query="test")
        # Only "results" key extracted; total/query_time_ms discarded
        assert result == [{"id": "a", "score": 0.9}]

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_missing_results_key_returns_empty(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({"data": [1, 2, 3]})

        result = memories_search(query="test")
        assert result == []

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_url_reconstruction_via_rsplit(self, mock_post, mock_gs):
        """Verify rsplit strips /v1/memory and reconstructs /v1/search/memories."""
        mock_gs.return_value = _settings(base_url="http://custom:9999")
        mock_post.return_value = _http_response({"results": []})

        memories_search(query="q")

        url = mock_post.call_args[0][0]
        assert url == "http://custom:9999/v1/search/memories"

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_http_error_propagates(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response(status_code=503)

        with pytest.raises(httpx.HTTPStatusError):
            memories_search(query="fail")

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_caller_limit_zero_not_overridden(self, mock_post, mock_gs):
        """limit=0 is falsy but should NOT be overridden (uses `is not None`)."""
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({"results": []})

        memories_search(query="q", limit=0, threshold=0.0)

        payload = mock_post.call_args[1]["json"]
        assert payload["match_count"] == 0
        assert payload["match_threshold"] == 0.0


# ---------------------------------------------------------------------------
# memories_list
# ---------------------------------------------------------------------------

class TestMemoriesList:
    """GET to /v1/memory/list — conditional params construction."""

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_no_filters(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        mock_get.return_value = _http_response([{"id": "a"}, {"id": "b"}])

        result = memories_list()

        call_args = mock_get.call_args
        assert call_args[0][0] == f"{_MEMORY_URL}/list"
        assert call_args[1]["params"] == {"limit": 50}
        assert result == [{"id": "a"}, {"id": "b"}]

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_with_memory_type(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        mock_get.return_value = _http_response([])

        memories_list(memory_type="decision")

        params = mock_get.call_args[1]["params"]
        assert params["memory_type"] == "decision"
        assert params["limit"] == 50

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_with_min_importance(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        mock_get.return_value = _http_response([])

        memories_list(min_importance=0.7)

        params = mock_get.call_args[1]["params"]
        assert params["min_importance"] == 0.7
        assert "memory_type" not in params

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_with_both_filters(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        mock_get.return_value = _http_response([])

        memories_list(memory_type="fact", min_importance=0.3, limit=5)

        params = mock_get.call_args[1]["params"]
        assert params == {"limit": 5, "memory_type": "fact", "min_importance": 0.3}

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_min_importance_zero_included(self, mock_get, mock_gs):
        """min_importance=0.0 is falsy but valid (uses `is not None`)."""
        mock_gs.return_value = _settings()
        mock_get.return_value = _http_response([])

        memories_list(min_importance=0.0)

        params = mock_get.call_args[1]["params"]
        assert params["min_importance"] == 0.0

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_http_error_propagates(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        mock_get.return_value = _http_response(status_code=404)

        with pytest.raises(httpx.HTTPStatusError):
            memories_list()


# ---------------------------------------------------------------------------
# memories_get
# ---------------------------------------------------------------------------

class TestMemoriesGet:
    """GET to /v1/memory/get/{memory_id}."""

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_correct_url_and_return(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        body = {"id": _MEM_ID, "content": "stored memory", "importance_score": 0.8}
        mock_get.return_value = _http_response(body)

        result = memories_get(_MEM_ID)

        assert mock_get.call_args[0][0] == f"{_MEMORY_URL}/get/{_MEM_ID}"
        assert mock_get.call_args[1]["timeout"] == _TIMEOUT
        assert result == body

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_http_404_propagates(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        mock_get.return_value = _http_response(status_code=404)

        with pytest.raises(httpx.HTTPStatusError):
            memories_get("nonexistent-id")

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_memory_id_in_url_path(self, mock_get, mock_gs):
        """Verifies memory_id is interpolated into the URL path correctly."""
        mock_gs.return_value = _settings()
        mock_get.return_value = _http_response({})
        custom_id = "12345678-abcd-efef-abab-123456789012"

        memories_get(custom_id)

        url = mock_get.call_args[0][0]
        assert url.endswith(f"/get/{custom_id}")


# ---------------------------------------------------------------------------
# memories_edit
# ---------------------------------------------------------------------------

class TestMemoriesEdit:
    """PATCH to /v1/memory/update/{memory_id} — conditional payload construction."""

    @patch("config.settings.get_settings")
    @patch("httpx.patch")
    def test_all_fields(self, mock_patch, mock_gs):
        mock_gs.return_value = _settings()
        updated = {"id": _MEM_ID, "content": "new", "importance_score": 0.9}
        mock_patch.return_value = _http_response(updated)

        result = memories_edit(
            memory_id=_MEM_ID,
            content="new",
            memory_type="insight",
            importance=0.9,
            tags=["critical"],
        )

        call_args = mock_patch.call_args
        assert call_args[0][0] == f"{_MEMORY_URL}/update/{_MEM_ID}"
        payload = call_args[1]["json"]
        assert payload["content"] == "new"
        assert payload["memory_type"] == "insight"
        assert payload["importance_score"] == 0.9
        assert payload["metadata"] == {"tags": ["critical"]}
        assert result == updated

    @patch("config.settings.get_settings")
    @patch("httpx.patch")
    def test_only_content(self, mock_patch, mock_gs):
        mock_gs.return_value = _settings()
        mock_patch.return_value = _http_response({})

        memories_edit(memory_id=_MEM_ID, content="updated")

        payload = mock_patch.call_args[1]["json"]
        assert payload == {"content": "updated"}

    @patch("config.settings.get_settings")
    @patch("httpx.patch")
    def test_only_importance(self, mock_patch, mock_gs):
        mock_gs.return_value = _settings()
        mock_patch.return_value = _http_response({})

        memories_edit(memory_id=_MEM_ID, importance=0.1)

        payload = mock_patch.call_args[1]["json"]
        assert payload == {"importance_score": 0.1}

    @patch("config.settings.get_settings")
    @patch("httpx.patch")
    def test_only_tags(self, mock_patch, mock_gs):
        mock_gs.return_value = _settings()
        mock_patch.return_value = _http_response({})

        memories_edit(memory_id=_MEM_ID, tags=["a", "b"])

        payload = mock_patch.call_args[1]["json"]
        assert payload == {"metadata": {"tags": ["a", "b"]}}

    @patch("config.settings.get_settings")
    @patch("httpx.patch")
    def test_no_fields_sends_empty_payload(self, mock_patch, mock_gs):
        """All args None → empty payload {}. Tests the conditional assembly."""
        mock_gs.return_value = _settings()
        mock_patch.return_value = _http_response({})

        memories_edit(memory_id=_MEM_ID)

        payload = mock_patch.call_args[1]["json"]
        assert payload == {}

    @patch("config.settings.get_settings")
    @patch("httpx.patch")
    def test_importance_zero_included(self, mock_patch, mock_gs):
        """importance=0.0 is not None, so it must be included."""
        mock_gs.return_value = _settings()
        mock_patch.return_value = _http_response({})

        memories_edit(memory_id=_MEM_ID, importance=0.0)

        payload = mock_patch.call_args[1]["json"]
        assert payload == {"importance_score": 0.0}

    @patch("config.settings.get_settings")
    @patch("httpx.patch")
    def test_empty_tags_list_included(self, mock_patch, mock_gs):
        """tags=[] is not None, so metadata should be included."""
        mock_gs.return_value = _settings()
        mock_patch.return_value = _http_response({})

        memories_edit(memory_id=_MEM_ID, tags=[])

        payload = mock_patch.call_args[1]["json"]
        assert payload == {"metadata": {"tags": []}}

    @patch("config.settings.get_settings")
    @patch("httpx.patch")
    def test_http_error_propagates(self, mock_patch, mock_gs):
        mock_gs.return_value = _settings()
        mock_patch.return_value = _http_response(status_code=422)

        with pytest.raises(httpx.HTTPStatusError):
            memories_edit(memory_id=_MEM_ID, content="x")


# ---------------------------------------------------------------------------
# memories_delete
# ---------------------------------------------------------------------------

class TestMemoriesDelete:
    """DELETE to /v1/memory/delete/{memory_id} — static return, body ignored."""

    @patch("config.settings.get_settings")
    @patch("httpx.delete")
    def test_correct_url_and_static_return(self, mock_del, mock_gs):
        mock_gs.return_value = _settings()
        # API might return anything — source ignores it
        mock_del.return_value = _http_response({"deleted": True, "timestamp": "now"})

        result = memories_delete(_MEM_ID)

        assert mock_del.call_args[0][0] == f"{_MEMORY_URL}/delete/{_MEM_ID}"
        assert mock_del.call_args[1]["timeout"] == _TIMEOUT
        # Returns static dict, NOT response.json()
        assert result == {"status": "deleted", "memory_id": _MEM_ID}

    @patch("config.settings.get_settings")
    @patch("httpx.delete")
    def test_response_body_ignored(self, mock_del, mock_gs):
        """Verifies response.json() is never called — body is discarded."""
        mock_gs.return_value = _settings()
        resp = _http_response()
        mock_del.return_value = resp

        memories_delete(_MEM_ID)

        resp.json.assert_not_called()

    @patch("config.settings.get_settings")
    @patch("httpx.delete")
    def test_http_error_propagates(self, mock_del, mock_gs):
        mock_gs.return_value = _settings()
        mock_del.return_value = _http_response(status_code=404)

        with pytest.raises(httpx.HTTPStatusError):
            memories_delete("bad-id")

    @patch("config.settings.get_settings")
    @patch("httpx.delete")
    def test_memory_id_in_return_dict(self, mock_del, mock_gs):
        """Return dict must contain the exact memory_id that was passed."""
        mock_gs.return_value = _settings()
        mock_del.return_value = _http_response()
        custom_id = "custom-uuid-value"

        result = memories_delete(custom_id)

        assert result["memory_id"] == custom_id
        assert result["status"] == "deleted"


# ---------------------------------------------------------------------------
# memories_relate
# ---------------------------------------------------------------------------

class TestMemoriesRelate:
    """POST to /v1/memory/relation/create/{memory_id}."""

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_full_args(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        body = {"id": "rel-1", "type": "caused_by"}
        mock_post.return_value = _http_response(body)

        result = memories_relate(
            memory_id=_MEM_ID,
            related_memory_id=_REL_ID,
            relation_type="caused_by",
            strength=0.8,
        )

        call_args = mock_post.call_args
        assert call_args[0][0] == f"{_MEMORY_URL}/relation/create/{_MEM_ID}"
        payload = call_args[1]["json"]
        assert payload["related_memory_id"] == _REL_ID
        assert payload["relation_type"] == "caused_by"
        assert payload["strength"] == 0.8
        assert result == body

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_defaults(self, mock_post, mock_gs):
        """Default relation_type='related_to', strength=0.5."""
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({})

        memories_relate(memory_id=_MEM_ID, related_memory_id=_REL_ID)

        payload = mock_post.call_args[1]["json"]
        assert payload["relation_type"] == "related_to"
        assert payload["strength"] == 0.5

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_http_error_propagates(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response(status_code=400)

        with pytest.raises(httpx.HTTPStatusError):
            memories_relate(_MEM_ID, _REL_ID)

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_strength_zero_valid(self, mock_post, mock_gs):
        """strength=0.0 should not be overridden by defaults."""
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({})

        memories_relate(_MEM_ID, _REL_ID, strength=0.0)

        payload = mock_post.call_args[1]["json"]
        assert payload["strength"] == 0.0


# ---------------------------------------------------------------------------
# memories_get_relations
# ---------------------------------------------------------------------------

class TestMemoriesGetRelations:
    """GET to /v1/memory/relation/list/{memory_id}."""

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_correct_url_and_return(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        body = [{"related_id": _REL_ID, "type": "related_to", "strength": 0.5}]
        mock_get.return_value = _http_response(body)

        result = memories_get_relations(_MEM_ID)

        assert mock_get.call_args[0][0] == f"{_MEMORY_URL}/relation/list/{_MEM_ID}"
        assert mock_get.call_args[1]["timeout"] == _TIMEOUT
        assert result == body

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_empty_relations(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        mock_get.return_value = _http_response([])

        result = memories_get_relations(_MEM_ID)
        assert result == []

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_http_error_propagates(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        mock_get.return_value = _http_response(status_code=500)

        with pytest.raises(httpx.HTTPStatusError):
            memories_get_relations(_MEM_ID)


# ---------------------------------------------------------------------------
# Cross-cutting: _get_timeout integration with all HTTP functions
# ---------------------------------------------------------------------------

class TestTimeoutIntegration:
    """Verifies all HTTP functions pass _get_timeout() result to httpx."""

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_add_uses_settings_timeout(self, mock_post, mock_gs):
        mock_gs.return_value = _settings(timeout=99.0)
        mock_post.return_value = _http_response({})

        memories_add(content="x")

        assert mock_post.call_args[1]["timeout"] == 99.0

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_search_uses_settings_timeout(self, mock_post, mock_gs):
        mock_gs.return_value = _settings(timeout=42.0)
        mock_post.return_value = _http_response({"results": []})

        memories_search(query="q")

        assert mock_post.call_args[1]["timeout"] == 42.0

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_list_uses_settings_timeout(self, mock_get, mock_gs):
        mock_gs.return_value = _settings(timeout=15.0)
        mock_get.return_value = _http_response([])

        memories_list()

        assert mock_get.call_args[1]["timeout"] == 15.0

    @patch("config.settings.get_settings")
    @patch("httpx.delete")
    def test_delete_uses_settings_timeout(self, mock_del, mock_gs):
        mock_gs.return_value = _settings(timeout=5.0)
        mock_del.return_value = _http_response()

        memories_delete(_MEM_ID)

        assert mock_del.call_args[1]["timeout"] == 5.0

    @patch("config.settings.get_settings")
    @patch("httpx.patch")
    def test_edit_uses_settings_timeout(self, mock_patch, mock_gs):
        mock_gs.return_value = _settings(timeout=77.0)
        mock_patch.return_value = _http_response({})

        memories_edit(memory_id=_MEM_ID, content="x")

        assert mock_patch.call_args[1]["timeout"] == 77.0
