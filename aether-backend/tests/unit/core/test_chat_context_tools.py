"""
Tests for core.integrations.providers.chat_context.tools

Coverage target: 100% of tools.py (242 lines, 0 existing tests).

Mock boundaries:
- config.settings.get_settings → late import inside every function; patched at source module
- httpx.post/get/delete → external HTTP calls

Real logic under test:
- URL construction (_get_backend_url + /v1/storage)
- Limit capping (min(limit, 50), min(limit, 100))
- Error-returning pattern (error dicts instead of exceptions)
- Nested try/except: inner for settings defaults, outer for HTTP
- Status code branching in chats_summarize (200/201, 404, 503, other)
- Response extraction with fallback (data.get("references", data))
- Timeout selection (_get_timeout vs _get_llm_timeout)
"""

from unittest.mock import MagicMock, patch

import httpx
import pytest

from core.integrations.providers.chat_context.tools import (
    _get_api_base,
    _get_backend_url,
    _get_llm_timeout,
    _get_timeout,
    chats_attach,
    chats_list,
    chats_list_references,
    chats_search,
    chats_summarize,
    chats_unlink,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_BASE = "http://127.0.0.1:8765"
_STORAGE_URL = f"{_BASE}/v1/storage"
_TIMEOUT = 60.0
_LLM_TIMEOUT = 300.0
_CHAT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
_TARGET_ID = "11111111-2222-3333-4444-555555555555"
_REF_ID = "fefefefe-abab-cdcd-efef-121212121212"


def _settings(
    base_url=_BASE,
    timeout=_TIMEOUT,
    llm_timeout=_LLM_TIMEOUT,
    search_limit=10,
):
    """Build a mock settings object matching the attributes tools.py accesses."""
    s = MagicMock()
    s.base_url = base_url
    s.http_client.default_timeout = timeout
    s.http_client.llm_timeout = llm_timeout
    s.summary_service.default_search_limit = search_limit
    return s


def _http_response(json_data=None, status_code=200, text=""):
    """Build a mock httpx.Response."""
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.text = text
    resp.json.return_value = json_data if json_data is not None else {}
    # No raise_for_status — this module checks status_code manually
    return resp


# ---------------------------------------------------------------------------
# _get_backend_url
# ---------------------------------------------------------------------------

class TestGetBackendUrl:
    """Returns settings.base_url directly, no fallback."""

    @patch("config.settings.get_settings")
    def test_returns_base_url(self, mock_gs):
        mock_gs.return_value = _settings(base_url="http://10.0.0.1:9000")
        assert _get_backend_url() == "http://10.0.0.1:9000"

    @patch("config.settings.get_settings", side_effect=RuntimeError("no config"))
    def test_propagates_settings_error(self, mock_gs):
        with pytest.raises(RuntimeError, match="no config"):
            _get_backend_url()


# ---------------------------------------------------------------------------
# _get_api_base
# ---------------------------------------------------------------------------

class TestGetApiBase:
    """Builds /v1/storage URL from _get_backend_url()."""

    @patch("config.settings.get_settings")
    def test_returns_storage_url(self, mock_gs):
        mock_gs.return_value = _settings()
        assert _get_api_base() == f"{_BASE}/v1/storage"

    @patch("config.settings.get_settings")
    def test_custom_base_url(self, mock_gs):
        mock_gs.return_value = _settings(base_url="http://custom:9999")
        assert _get_api_base() == "http://custom:9999/v1/storage"


# ---------------------------------------------------------------------------
# _get_timeout
# ---------------------------------------------------------------------------

class TestGetTimeout:
    """Timeout retrieval with exception fallback to 10.0."""

    @patch("config.settings.get_settings")
    def test_returns_settings_timeout(self, mock_gs):
        mock_gs.return_value = _settings(timeout=120.0)
        assert _get_timeout() == 120.0

    @patch("config.settings.get_settings", side_effect=ImportError)
    def test_fallback_on_import_error(self, mock_gs):
        assert _get_timeout() == 10.0

    @patch("config.settings.get_settings")
    def test_fallback_on_attribute_error(self, mock_gs):
        class _NoTimeout:
            @property
            def default_timeout(self):
                raise AttributeError("no attr")

        s = MagicMock()
        s.http_client = _NoTimeout()
        mock_gs.return_value = s
        assert _get_timeout() == 10.0


# ---------------------------------------------------------------------------
# _get_llm_timeout
# ---------------------------------------------------------------------------

class TestGetLlmTimeout:
    """LLM timeout retrieval with exception fallback to 60.0."""

    @patch("config.settings.get_settings")
    def test_returns_settings_llm_timeout(self, mock_gs):
        mock_gs.return_value = _settings(llm_timeout=500.0)
        assert _get_llm_timeout() == 500.0

    @patch("config.settings.get_settings", side_effect=ImportError)
    def test_fallback_on_import_error(self, mock_gs):
        assert _get_llm_timeout() == 60.0

    @patch("config.settings.get_settings")
    def test_fallback_on_attribute_error(self, mock_gs):
        class _NoLlmTimeout:
            @property
            def llm_timeout(self):
                raise AttributeError("no attr")

        s = MagicMock()
        s.http_client = _NoLlmTimeout()
        mock_gs.return_value = s
        assert _get_llm_timeout() == 60.0


# ---------------------------------------------------------------------------
# chats_search
# ---------------------------------------------------------------------------

class TestChatsSearch:
    """POST to /v1/storage/chats/search — limit capping, error dicts."""

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_success_with_results(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({
            "results": [{"id": "c1", "title": "Chat 1", "relevance_score": 0.9}]
        })

        result = chats_search("python examples", limit=5)

        call_args = mock_post.call_args
        assert call_args[0][0] == f"{_STORAGE_URL}/chats/search"
        payload = call_args[1]["json"]
        assert payload["query"] == "python examples"
        assert payload["limit"] == 5
        assert call_args[1]["timeout"] == _TIMEOUT
        assert result == [{"id": "c1", "title": "Chat 1", "relevance_score": 0.9}]

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_defaults_from_settings(self, mock_post, mock_gs):
        mock_gs.return_value = _settings(search_limit=20)
        mock_post.return_value = _http_response({"results": []})

        chats_search("test")

        payload = mock_post.call_args[1]["json"]
        assert payload["limit"] == 20  # from settings, capped at min(20, 50) = 20

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_settings_exception_fallback(self, mock_post, mock_gs):
        """First get_settings() (defaults) fails; _get_backend_url and _get_timeout succeed."""
        mock_gs.side_effect = [RuntimeError("boom"), _settings(), _settings()]
        mock_post.return_value = _http_response({"results": []})

        chats_search("test")

        payload = mock_post.call_args[1]["json"]
        assert payload["limit"] == 10  # fallback default

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_limit_capped_at_50(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({"results": []})

        chats_search("test", limit=200)

        payload = mock_post.call_args[1]["json"]
        assert payload["limit"] == 50  # min(200, 50)

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_limit_zero_not_overridden(self, mock_post, mock_gs):
        """limit=0 is not None, uses `is not None` check."""
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({"results": []})

        chats_search("test", limit=0)

        payload = mock_post.call_args[1]["json"]
        assert payload["limit"] == 0  # min(0, 50) = 0

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_missing_results_key(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({"data": [1, 2]})

        result = chats_search("test")
        assert result == []

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_http_error_returns_error_dict(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response(status_code=500, text="Internal Server Error")

        result = chats_search("test")

        assert len(result) == 1
        assert "error" in result[0]
        assert "500" in result[0]["error"]
        assert result[0]["detail"] == "Internal Server Error"

    @patch("config.settings.get_settings", side_effect=RuntimeError("total failure"))
    def test_total_settings_failure_returns_error(self, mock_gs):
        """All get_settings() calls fail — outer except catches _get_api_base failure."""
        result = chats_search("test")

        assert len(result) == 1
        assert "error" in result[0]
        assert "total failure" in result[0]["error"]

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_httpx_exception_returns_error(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.side_effect = httpx.ConnectError("connection refused")

        result = chats_search("test")

        assert len(result) == 1
        assert "error" in result[0]
        assert "connection refused" in result[0]["error"]


# ---------------------------------------------------------------------------
# chats_summarize
# ---------------------------------------------------------------------------

class TestChatsSummarize:
    """POST to /v1/storage/chats/{id}/summarize — multi-status, timeout handling."""

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_success_200(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        body = {"title": "Chat about Python", "key_points": ["lists", "dicts"]}
        mock_post.return_value = _http_response(body, status_code=200)

        result = chats_summarize(_CHAT_ID)

        call_args = mock_post.call_args
        assert call_args[0][0] == f"{_STORAGE_URL}/chats/{_CHAT_ID}/summarize"
        payload = call_args[1]["json"]
        assert payload["summary_type"] == "full"
        assert payload["force_regenerate"] is False
        assert call_args[1]["timeout"] == _LLM_TIMEOUT  # uses llm_timeout
        assert result == body

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_success_201(self, mock_post, mock_gs):
        """201 Created is also a success status for summarize."""
        mock_gs.return_value = _settings()
        body = {"title": "New summary"}
        mock_post.return_value = _http_response(body, status_code=201)

        result = chats_summarize(_CHAT_ID)
        assert result == body

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_custom_summary_type_and_force(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({}, status_code=200)

        chats_summarize(_CHAT_ID, summary_type="brief", force_regenerate=True)

        payload = mock_post.call_args[1]["json"]
        assert payload["summary_type"] == "brief"
        assert payload["force_regenerate"] is True

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_404_returns_not_found_error(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response(status_code=404, text="not found")

        result = chats_summarize(_CHAT_ID)

        assert result["error"] == "Chat not found or has no messages"
        assert result["detail"] == "not found"

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_503_returns_service_unavailable(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response(status_code=503)

        result = chats_summarize(_CHAT_ID)

        assert result["error"] == "LLM service unavailable"
        assert "Cannot generate summary" in result["detail"]

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_other_error_status(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response(status_code=422, text="validation error")

        result = chats_summarize(_CHAT_ID)

        assert "422" in result["error"]
        assert result["detail"] == "validation error"

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_timeout_exception(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.side_effect = httpx.TimeoutException("timed out")

        result = chats_summarize(_CHAT_ID)

        assert result["error"] == "Summarization timed out"
        assert "LLM took too long" in result["detail"]

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_generic_exception(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.side_effect = httpx.ConnectError("connection refused")

        result = chats_summarize(_CHAT_ID)

        assert "error" in result
        assert "connection refused" in result["error"]

    @patch("config.settings.get_settings", side_effect=RuntimeError("no config"))
    def test_total_settings_failure(self, mock_gs):
        result = chats_summarize(_CHAT_ID)

        assert "error" in result
        assert "no config" in result["error"]

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_uses_llm_timeout(self, mock_post, mock_gs):
        """Summarize must use _get_llm_timeout, not _get_timeout."""
        mock_gs.return_value = _settings(llm_timeout=500.0)
        mock_post.return_value = _http_response({}, status_code=200)

        chats_summarize(_CHAT_ID)

        assert mock_post.call_args[1]["timeout"] == 500.0


# ---------------------------------------------------------------------------
# chats_list
# ---------------------------------------------------------------------------

class TestChatsList:
    """GET to /v1/storage/chats — limit capping, pagination."""

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_success(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        body = [{"id": "c1", "title": "Chat 1"}, {"id": "c2", "title": "Chat 2"}]
        mock_get.return_value = _http_response(body)

        result = chats_list()

        call_args = mock_get.call_args
        assert call_args[0][0] == f"{_STORAGE_URL}/chats"
        assert call_args[1]["params"]["limit"] == 50  # min(50, 100) = 50
        assert call_args[1]["params"]["skip"] == 0
        assert result == body

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_limit_capped_at_100(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        mock_get.return_value = _http_response([])

        chats_list(limit=200)

        params = mock_get.call_args[1]["params"]
        assert params["limit"] == 100  # min(200, 100)

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_skip_param(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        mock_get.return_value = _http_response([])

        chats_list(limit=10, skip=20)

        params = mock_get.call_args[1]["params"]
        assert params["limit"] == 10
        assert params["skip"] == 20

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_settings_fallback_for_defaults(self, mock_get, mock_gs):
        """Inner try/except for settings defaults. With limit=50 default, settings path is
        only reached if caller passes limit=None explicitly."""
        # Provide settings that would set limit=25, but default param is 50
        mock_gs.return_value = _settings(search_limit=25)
        mock_get.return_value = _http_response([])

        # Default limit=50 is not None, so settings.default_search_limit is NOT used
        chats_list()

        params = mock_get.call_args[1]["params"]
        assert params["limit"] == 50  # default param, not settings

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_http_error_returns_error_list(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        mock_get.return_value = _http_response(status_code=500, text="server error")

        result = chats_list()

        assert len(result) == 1
        assert "error" in result[0]
        assert "500" in result[0]["error"]
        assert result[0]["detail"] == "server error"

    @patch("config.settings.get_settings", side_effect=RuntimeError("total failure"))
    def test_total_settings_failure(self, mock_gs):
        result = chats_list()

        assert len(result) == 1
        assert "error" in result[0]

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_httpx_exception_returns_error(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        mock_get.side_effect = httpx.ConnectError("refused")

        result = chats_list()

        assert len(result) == 1
        assert "refused" in result[0]["error"]


# ---------------------------------------------------------------------------
# chats_attach
# ---------------------------------------------------------------------------

class TestChatsAttach:
    """POST to /v1/storage/chats/{id}/references — reference creation."""

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_success_200(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        body = {"id": _REF_ID, "status": "created"}
        mock_post.return_value = _http_response(body, status_code=200)

        result = chats_attach(
            source_chat_id=_CHAT_ID,
            target_chat_id=_TARGET_ID,
            reference_type="context",
            metadata={"reason": "related topic"},
            created_by="agent",
        )

        call_args = mock_post.call_args
        assert call_args[0][0] == f"{_STORAGE_URL}/chats/{_CHAT_ID}/references"
        payload = call_args[1]["json"]
        assert payload["target_chat_id"] == _TARGET_ID
        assert payload["reference_type"] == "context"
        assert payload["metadata"] == {"reason": "related topic"}
        assert payload["created_by"] == "agent"
        assert result == body

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_success_201(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({"id": "new"}, status_code=201)

        result = chats_attach(_CHAT_ID, _TARGET_ID)
        assert result == {"id": "new"}

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_defaults(self, mock_post, mock_gs):
        """Default reference_type='context', metadata={}, created_by='user'."""
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({}, status_code=200)

        chats_attach(_CHAT_ID, _TARGET_ID)

        payload = mock_post.call_args[1]["json"]
        assert payload["reference_type"] == "context"
        assert payload["metadata"] == {}
        assert payload["created_by"] == "user"

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_metadata_none_becomes_empty_dict(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response({}, status_code=200)

        chats_attach(_CHAT_ID, _TARGET_ID, metadata=None)

        payload = mock_post.call_args[1]["json"]
        assert payload["metadata"] == {}

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_http_error_returns_error_dict(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.return_value = _http_response(status_code=409, text="conflict")

        result = chats_attach(_CHAT_ID, _TARGET_ID)

        assert "error" in result
        assert "409" in result["error"]
        assert result["detail"] == "conflict"

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_exception_returns_error_dict(self, mock_post, mock_gs):
        mock_gs.return_value = _settings()
        mock_post.side_effect = httpx.ConnectError("refused")

        result = chats_attach(_CHAT_ID, _TARGET_ID)

        assert "error" in result
        assert "refused" in result["error"]

    @patch("config.settings.get_settings", side_effect=RuntimeError("no config"))
    def test_total_settings_failure(self, mock_gs):
        result = chats_attach(_CHAT_ID, _TARGET_ID)

        assert "error" in result


# ---------------------------------------------------------------------------
# chats_list_references
# ---------------------------------------------------------------------------

class TestChatsListReferences:
    """GET to /v1/storage/chats/{id}/references — with fallback extraction."""

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_success_with_references_key(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        refs = [{"id": _REF_ID, "type": "context"}]
        mock_get.return_value = _http_response({"references": refs, "total": 1})

        result = chats_list_references(_CHAT_ID)

        call_args = mock_get.call_args
        assert call_args[0][0] == f"{_STORAGE_URL}/chats/{_CHAT_ID}/references"
        params = call_args[1]["params"]
        assert params["direction"] == "both"
        assert params["limit"] == 100
        assert params["offset"] == 0
        assert result == refs

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_success_bare_list_response(self, mock_get, mock_gs):
        """BUG REGRESSION: API returns bare list (no wrapping dict).
        Previously crashed with AttributeError because list has no .get().
        Fixed with isinstance(data, dict) check.
        """
        mock_gs.return_value = _settings()
        data = [{"id": "r1"}, {"id": "r2"}]
        mock_get.return_value = _http_response(data)

        result = chats_list_references(_CHAT_ID)

        assert result == data  # bare list returned directly

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_success_dict_without_references_key(self, mock_get, mock_gs):
        """When response is a dict without 'references' key, falls back to entire dict."""
        mock_gs.return_value = _settings()
        data = {"items": [{"id": "r1"}], "count": 1}
        mock_get.return_value = _http_response(data)

        result = chats_list_references(_CHAT_ID)

        assert result == data  # data.get("references", data) returns data itself

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_custom_params(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        mock_get.return_value = _http_response({"references": []})

        chats_list_references(_CHAT_ID, direction="outgoing", limit=10, offset=5)

        params = mock_get.call_args[1]["params"]
        assert params["direction"] == "outgoing"
        assert params["limit"] == 10
        assert params["offset"] == 5

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_http_error_returns_error_list(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        mock_get.return_value = _http_response(status_code=404, text="not found")

        result = chats_list_references(_CHAT_ID)

        assert len(result) == 1
        assert "error" in result[0]
        assert "404" in result[0]["error"]

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_exception_returns_error_list(self, mock_get, mock_gs):
        mock_gs.return_value = _settings()
        mock_get.side_effect = httpx.ConnectError("refused")

        result = chats_list_references(_CHAT_ID)

        assert len(result) == 1
        assert "refused" in result[0]["error"]

    @patch("config.settings.get_settings", side_effect=RuntimeError("no config"))
    def test_total_settings_failure(self, mock_gs):
        result = chats_list_references(_CHAT_ID)

        assert len(result) == 1
        assert "error" in result[0]


# ---------------------------------------------------------------------------
# chats_unlink
# ---------------------------------------------------------------------------

class TestChatsUnlink:
    """DELETE to /v1/storage/chats/references/{id}."""

    @patch("config.settings.get_settings")
    @patch("httpx.delete")
    def test_success(self, mock_del, mock_gs):
        mock_gs.return_value = _settings()
        body = {"status": "deleted", "id": _REF_ID}
        mock_del.return_value = _http_response(body)

        result = chats_unlink(_REF_ID)

        assert mock_del.call_args[0][0] == f"{_STORAGE_URL}/chats/references/{_REF_ID}"
        assert mock_del.call_args[1]["timeout"] == _TIMEOUT
        assert result == body

    @patch("config.settings.get_settings")
    @patch("httpx.delete")
    def test_http_error_returns_error_dict(self, mock_del, mock_gs):
        mock_gs.return_value = _settings()
        mock_del.return_value = _http_response(status_code=404, text="not found")

        result = chats_unlink("bad-id")

        assert "error" in result
        assert "404" in result["error"]
        assert result["detail"] == "not found"

    @patch("config.settings.get_settings")
    @patch("httpx.delete")
    def test_exception_returns_error_dict(self, mock_del, mock_gs):
        mock_gs.return_value = _settings()
        mock_del.side_effect = httpx.ConnectError("refused")

        result = chats_unlink(_REF_ID)

        assert "error" in result
        assert "refused" in result["error"]

    @patch("config.settings.get_settings", side_effect=RuntimeError("no config"))
    def test_total_settings_failure(self, mock_gs):
        result = chats_unlink(_REF_ID)

        assert "error" in result


# ---------------------------------------------------------------------------
# Cross-cutting: timeout routing
# ---------------------------------------------------------------------------

class TestTimeoutRouting:
    """Verifies each function uses the correct timeout function."""

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_search_uses_default_timeout(self, mock_post, mock_gs):
        mock_gs.return_value = _settings(timeout=15.0)
        mock_post.return_value = _http_response({"results": []})

        chats_search("q")

        assert mock_post.call_args[1]["timeout"] == 15.0

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_summarize_uses_llm_timeout(self, mock_post, mock_gs):
        mock_gs.return_value = _settings(llm_timeout=999.0)
        mock_post.return_value = _http_response({}, status_code=200)

        chats_summarize(_CHAT_ID)

        assert mock_post.call_args[1]["timeout"] == 999.0

    @patch("config.settings.get_settings")
    @patch("httpx.get")
    def test_list_uses_default_timeout(self, mock_get, mock_gs):
        mock_gs.return_value = _settings(timeout=25.0)
        mock_get.return_value = _http_response([])

        chats_list()

        assert mock_get.call_args[1]["timeout"] == 25.0

    @patch("config.settings.get_settings")
    @patch("httpx.post")
    def test_attach_uses_default_timeout(self, mock_post, mock_gs):
        mock_gs.return_value = _settings(timeout=33.0)
        mock_post.return_value = _http_response({}, status_code=200)

        chats_attach(_CHAT_ID, _TARGET_ID)

        assert mock_post.call_args[1]["timeout"] == 33.0

    @patch("config.settings.get_settings")
    @patch("httpx.delete")
    def test_unlink_uses_default_timeout(self, mock_del, mock_gs):
        mock_gs.return_value = _settings(timeout=8.0)
        mock_del.return_value = _http_response({})

        chats_unlink(_REF_ID)

        assert mock_del.call_args[1]["timeout"] == 8.0
