"""
Unit tests for research helpers (api/v1/endpoints/research.py).

NOTE: research.py has NO HTTP route decorators — its functions are helpers called by
search.py and services.py. We test internal helpers directly.

CI: pytest tests/unit/api/test_research_endpoint.py -m unit --no-cov -q
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch




# ===========================================================================
# _get_research_agent_config
# ===========================================================================

class TestConfigHelpers:
    """Tests for config lookup helpers."""

    @pytest.mark.asyncio
    async def test_research_config_found(self):
        from api.v1.endpoints.research import _get_research_agent_config
        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[{"agent_name": "research", "enabled": True}])
        result = await _get_research_agent_config(mock_gw)
        assert result["agent_name"] == "research"

    @pytest.mark.asyncio
    async def test_research_config_not_found(self):
        from api.v1.endpoints.research import _get_research_agent_config
        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[])
        result = await _get_research_agent_config(mock_gw)
        assert result is None

    @pytest.mark.asyncio
    async def test_research_config_error(self):
        from api.v1.endpoints.research import _get_research_agent_config
        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(side_effect=RuntimeError("db"))
        result = await _get_research_agent_config(mock_gw)
        assert result is None



# ===========================================================================
# _search_web_fast
# ===========================================================================

class TestSearchWebFast:
    """Tests for _search_web_fast helper."""

    @pytest.mark.asyncio
    async def test_searxng_disabled(self):
        from api.v1.endpoints.research import _search_web_fast
        mock_settings = MagicMock()
        mock_settings.integrations.searxng_enabled = False
        result = await _search_web_fast("test", 5, mock_settings)
        assert result["total"] == 0
        assert "not enabled" in result.get("error", "")

    @pytest.mark.asyncio
    async def test_searxng_success(self):
        from api.v1.endpoints.research import _search_web_fast
    
        mock_settings = MagicMock()
        mock_settings.integrations.searxng_enabled = True
        mock_settings.integrations.searxng_url = "http://localhost:8080"
        mock_settings.http_client.default_timeout = 10.0
    
        mock_gw = MagicMock()
        mock_gw.search_searxng = AsyncMock(return_value={
            "results": [{"title": "Result 1", "url": "http://example.com"}],
            "suggestions": ["suggestion"],
            "unresponsive_engines": [],
        })
    
        result = await _search_web_fast("test", 5, mock_settings, mock_gw)
    
        assert result["total"] == 1
        assert result["source"] == "searxng"

    @pytest.mark.asyncio
    async def test_searxng_http_error(self):
        from api.v1.endpoints.research import _search_web_fast
        from core.exceptions import UpstreamServiceError
    
        mock_settings = MagicMock()
        mock_settings.integrations.searxng_enabled = True
        mock_settings.integrations.searxng_url = "http://localhost:8080"
        mock_settings.http_client.default_timeout = 10.0
    
        mock_gw = MagicMock()
        mock_gw.search_searxng = AsyncMock(side_effect=UpstreamServiceError("refused", "searxng"))
    
        result = await _search_web_fast("test", 5, mock_settings, mock_gw)
    
        assert result["total"] == 0
        assert "error" in result

    @pytest.mark.asyncio
    async def test_searxng_with_unresponsive_engines(self):
        from api.v1.endpoints.research import _search_web_fast
    
        mock_settings = MagicMock()
        mock_settings.integrations.searxng_enabled = True
        mock_settings.integrations.searxng_url = "http://localhost:8080"
        mock_settings.http_client.default_timeout = 10.0
        
        mock_gw = MagicMock()
        mock_gw.search_searxng = AsyncMock(return_value={
            "results": [{"title": "R1"}],
            "suggestions": [],
            "unresponsive_engines": [["brave", "timeout"]],
        })
    
        result = await _search_web_fast("test", 5, mock_settings, mock_gw)
    
        assert result["total"] == 1
        assert "brave" not in result["engines_working"]



class TestSearchWebFastMulti:
    """Tests for multi-query fast search."""

    @pytest.mark.asyncio
    async def test_deduplicates_results(self):
        from api.v1.endpoints.research import _search_web_fast_multi
    
        mock_settings = MagicMock()
        mock_gw = MagicMock()
    
        async def fake_search(q, max_r, s, g):
            return {"results": [{"url": "http://a.com", "title": q}], "total": 1}
    
        with patch("api.v1.endpoints.research._search_web_fast", side_effect=fake_search):
            result = await _search_web_fast_multi(["q1", "q2"], 10, mock_settings, mock_gw)
    
        # Same URL deduped
        assert result["total"] == 1
        assert len(result["queries"]) == 2

    @pytest.mark.asyncio
    async def test_handles_exceptions(self):
        from api.v1.endpoints.research import _search_web_fast_multi
        
        mock_gw = MagicMock()

        async def fail_search(q, max_r, s, g):
            raise RuntimeError("search fail")

        with patch("api.v1.endpoints.research._search_web_fast", side_effect=fail_search):
            result = await _search_web_fast_multi(["q1"], 10, MagicMock(), mock_gw)

        assert result["total"] == 0
        assert len(result["errors"]) == 1


# ===========================================================================
# _search_local_indexes
# ===========================================================================

class TestSearchLocalIndexes:
    """Tests for _search_local_indexes helper.

    _search_local_indexes uses late imports:
      from api.v1.endpoints.indexes import list_all_indexes, search_multiple_indexes
      from api.dependencies import require_file_indexing_repository
    Patch at the SOURCE modules so the from-import resolves to the mock.
    """

    @pytest.mark.asyncio
    async def test_local_search_no_indexes(self):
        """No indexes → empty results."""
        from api.v1.endpoints.research import _search_local_indexes

        mock_idx_service = AsyncMock()
        mock_idx_service.list_all_indexes.return_value = {"indexes": []}

        result = await _search_local_indexes("test", 5, mock_idx_service)

        assert result["results"] == []
        assert result["total"] == 0

    @pytest.mark.asyncio
    async def test_local_search_success(self):
        """Indexes exist → searches and returns results."""
        from api.v1.endpoints.research import _search_local_indexes
    
        mock_idx = MagicMock()
        mock_idx["index_name"] = "test_index"
    
        mock_indexes_resp = {"indexes": [mock_idx]}
    
        mock_search_resp = {
            "results": [{"text": "found", "score": 0.9}],
            "total_found": 1,
            "indexes_searched": ["test_index"]
        }
        
        mock_idx_service = AsyncMock()
        mock_idx_service.list_all_indexes.return_value = mock_indexes_resp
        mock_idx_service.search_multiple_indexes.return_value = mock_search_resp

        result = await _search_local_indexes("test", 5, mock_idx_service)

        assert result["total"] == 1
        assert len(result["results"]) == 1

    @pytest.mark.asyncio
    async def test_local_search_exception(self):
        """Exception → returns error dict."""
        from api.v1.endpoints.research import _search_local_indexes
        
        mock_idx_service = AsyncMock()
        mock_idx_service.list_all_indexes.side_effect = RuntimeError("no repo")

        result = await _search_local_indexes("test", 5, mock_idx_service)

        assert result["total"] == 0
        assert "error" in result



class TestResearchOrchestration:
    """Tests for the research() main helper."""

    def _mock_settings(self, perplexica=True, searxng=True):
        s = MagicMock()
        s.integrations.perplexica_enabled = perplexica
        s.integrations.perplexica_url = "http://localhost:3001"
        s.integrations.searxng_enabled = searxng
        s.integrations.searxng_url = "http://localhost:8080"
        s.llm.model = "qwen3-4b"
        s.base_url = "http://localhost:8765"
        s.http_client.default_timeout = 10.0
        return s

    @pytest.mark.asyncio
    async def test_ai_mode_web(self):
        """AI mode with web source calls perplexica_search."""
        from api.v1.endpoints.research import research

        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[])
        
        mock_idx_service = MagicMock()

        mock_perplexica = AsyncMock(return_value={
            "answer": "AI answer",
            "sources": [{"url": "http://example.com"}],
        })

        with patch("api.v1.endpoints.research.perplexica_search", mock_perplexica):
            result = await research(
                query="test query",
                sources=["web"],
                ai_mode=True,
                settings=self._mock_settings(),
                gateway=mock_gw,
                index_service=mock_idx_service,
                _context={}
            )

        assert result.ai_mode is True
        assert "web" in result.results
        assert result.model_used == "qwen3-4b"

    @pytest.mark.asyncio
    async def test_fast_mode_web(self):
        """Fast mode calls _search_web_fast_multi."""
        from api.v1.endpoints.research import research

        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[])
        
        mock_idx_service = MagicMock()

        mock_fast = AsyncMock(return_value={"results": [{"title": "Fast result"}], "total": 1})

        with patch("api.v1.endpoints.research._search_web_fast_multi", mock_fast):
            result = await research(
                query="test query",
                sources=["web"],
                ai_mode=False,
                settings=self._mock_settings(),
                gateway=mock_gw,
                index_service=mock_idx_service,
                _context={}
            )

        assert result.ai_mode is False
        assert result.model_used is None

    @pytest.mark.asyncio
    async def test_mode_alias_fast(self):
        """mode='fast' sets ai_mode=False."""
        from api.v1.endpoints.research import research

        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[])
        
        mock_idx_service = MagicMock()

        mock_fast = AsyncMock(return_value={"results": [], "total": 0})

        with patch("api.v1.endpoints.research._search_web_fast_multi", mock_fast):
            result = await research(
                query="test",
                mode="fast",
                settings=self._mock_settings(),
                gateway=mock_gw,
                index_service=mock_idx_service,
                _context={}
            )

        assert result.ai_mode is False

    @pytest.mark.asyncio
    async def test_mode_alias_invalid(self):
        """Invalid mode → 400."""
        from api.v1.endpoints.research import research
        from fastapi import HTTPException

        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[])
        
        mock_idx_service = MagicMock()

        with pytest.raises(HTTPException) as exc_info:
            await research(
                query="test",
                mode="invalid_mode",
                settings=self._mock_settings(),
                gateway=mock_gw,
                index_service=mock_idx_service,
                _context={}
            )
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    async def test_ai_mode_perplexica_disabled_503(self):
        """AI mode with perplexica disabled → 503."""
        from api.v1.endpoints.research import research
        from fastapi import HTTPException

        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[])
        
        mock_idx_service = MagicMock()

        with pytest.raises(HTTPException) as exc_info:
            await research(
                query="test",
                ai_mode=True,
                settings=self._mock_settings(perplexica=False),
                gateway=mock_gw,
                index_service=mock_idx_service,
                _context={}
            )
        assert exc_info.value.status_code == 503

    @pytest.mark.asyncio
    async def test_local_source(self):
        """local source calls _search_local_indexes."""
        from api.v1.endpoints.research import research

        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[])

        mock_local = AsyncMock(return_value={"results": [], "total": 0, "indexes_searched": []})
        
        mock_idx_service = MagicMock()

        with patch("api.v1.endpoints.research._search_local_indexes", mock_local):
            result = await research(
                query="test",
                sources=["local"],
                ai_mode=False,
                settings=self._mock_settings(),
                gateway=mock_gw,
                index_service=mock_idx_service,
                _context={}
            )

        assert "local" in result.results
        mock_local.assert_called_once()

    @pytest.mark.asyncio
    async def test_model_priority_request_override(self):
        """Request model override takes priority."""
        from api.v1.endpoints.research import research

        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[{
            "agent_name": "research",
            "configuration": {"model": "agent-model"},
        }])

        mock_perplexica = AsyncMock(return_value={"answer": "yes"})
        
        mock_idx_service = MagicMock()

        with patch("api.v1.endpoints.research.perplexica_search", mock_perplexica):
            result = await research(
                query="test",
                model="request-model",
                settings=self._mock_settings(),
                gateway=mock_gw,
                index_service=mock_idx_service,
                _context={}
            )

        assert result.model_used == "request-model"


# ===========================================================================
# research_status()
# ===========================================================================

class TestResearchStatus:
    """Tests for research_status helper."""

    @pytest.mark.asyncio
    async def test_status_success(self):
        from api.v1.endpoints.research import research_status
        mock_settings = MagicMock()
        mock_settings.integrations.perplexica_enabled = True
        mock_settings.integrations.perplexica_url = "http://localhost:3001"
        mock_settings.integrations.searxng_enabled = True
        mock_settings.integrations.searxng_url = "http://localhost:8080"
        mock_settings.llm.model = "qwen3-4b"

        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[])
        
        mock_research_service = MagicMock()
        mock_research_service.get_research_status = AsyncMock(return_value={
            "perplexica_enabled": True,
            "searxng_enabled": True,
            "default_model": "qwen3-4b"
        })

        result = await research_status(research_service=mock_research_service)
        assert result["perplexica_enabled"] is True
        assert result["searxng_enabled"] is True
        assert result["default_model"] == "qwen3-4b"

    @pytest.mark.asyncio
    async def test_status_exception(self):
        """Settings attribute access fails → 500 HTTPException.

        _get_research_agent_config catch gateway
        errors internally, so we trigger the outer except by making
        settings.integrations raise on attribute access via PropertyMock.
        """
        from api.v1.endpoints.research import research_status
        from fastapi import HTTPException

        mock_research_service = MagicMock()
        mock_research_service.get_research_status = AsyncMock(side_effect=RuntimeError("boom"))

        with pytest.raises(HTTPException) as exc_info:
            await research_status(research_service=mock_research_service)
        assert exc_info.value.status_code == 500


# ===========================================================================
# Additional gap-coverage tests
# ===========================================================================

class TestSearchWebFastDeep:
    """Cover remaining _search_web_fast branches."""

    @pytest.mark.asyncio
    async def test_generic_exception(self):
        """Non-HTTPError exception → error dict (lines 202-204)."""
        from api.v1.endpoints.research import _search_web_fast

        mock_settings = MagicMock()
        mock_settings.integrations.searxng_enabled = True
        mock_settings.integrations.searxng_url = "http://localhost:8080"
        mock_settings.http_client.default_timeout = 10.0

        mock_client = AsyncMock()
        mock_client.request = AsyncMock(side_effect=RuntimeError("unexpected"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("data.network.http_client.httpx.AsyncClient", return_value=mock_client):
            result = await _search_web_fast("test", 5, mock_settings)

        assert result["total"] == 0
        assert "error" in result

    @pytest.mark.asyncio
    async def test_unresponsive_row_exception(self):
        """Row processing raises in __getitem__ → except pass (line 181).
    
        The code does: ``if hasattr(row, '__iter__') and not isinstance(row, (str, bytes)):``
        so we need a real list subclass with len >= 2 that raises on row[0].
        """
        from api.v1.endpoints.research import _search_web_fast
    
        mock_settings = MagicMock()
        mock_settings.integrations.searxng_enabled = True
        mock_settings.integrations.searxng_url = "http://localhost:8080"
        mock_settings.http_client.default_timeout = 10.0
    
        class BadList(list):
            """List subclass that raises on item access."""
            def __getitem__(self, idx):
                raise RuntimeError("corrupt row data")
            def __iter__(self):
                raise RuntimeError("corrupt row data")
    
        bad_row = BadList([1, 2])  # len == 2, isinstance(..., list) == True
    
        mock_gw = MagicMock()
        mock_gw.search_searxng = AsyncMock(return_value={
            "results": [{"title": "r1", "url": "http://x.com", "content": "c"}],
            "unresponsive_engines": [bad_row],
        })
    
        result = await _search_web_fast("test", 5, mock_settings, mock_gw)
    
        assert result["total"] == 1






class TestResearchOrchestrationDeep:
    """Cover remaining research() branches."""

    def _mock_settings(self, perplexica=True, searxng=True):
        s = MagicMock()
        s.integrations.perplexica_enabled = perplexica
        s.integrations.perplexica_url = "http://localhost:3001"
        s.integrations.searxng_enabled = searxng
        s.integrations.searxng_url = "http://localhost:8080"
        s.llm.model = "qwen3-4b"
        s.base_url = "http://localhost:8765"
        s.http_client.default_timeout = 10.0
        return s

    @pytest.mark.asyncio
    async def test_mode_ai_alias(self):
        """mode='ai' sets ai_mode=True (line 429)."""
        from api.v1.endpoints.research import research

        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[])

        mock_perplexica = AsyncMock(return_value={"answer": "yes"})

        with patch("api.v1.endpoints.research.perplexica_search", mock_perplexica):
            result = await research(
                query="test",
                mode="ai",
                settings=self._mock_settings(),
                gateway=mock_gw,
                _context={}
            )

        assert result.ai_mode is True

    @pytest.mark.asyncio
    async def test_agent_config_model_priority(self):
        """Agent config model used when no request model (line 442)."""
        from api.v1.endpoints.research import research

        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[{
            "agent_name": "research",
            "configuration": {"model": "agent-configured-model"},
        }])

        mock_perplexica = AsyncMock(return_value={"answer": "ok"})
        mock_research_svc = AsyncMock()
        mock_research_svc.get_research_agent_config.return_value = {
            "agent_name": "research",
            "configuration": {"model": "agent-configured-model"}
        }

        with patch("api.v1.endpoints.research.perplexica_search", mock_perplexica), \
             patch("api.v1.endpoints.research._get_research_agent_config", return_value={"configuration": {"model": "agent-configured-model"}}):
            result = await research(
                query="test",
                model=None,  # No request override
                settings=self._mock_settings(),
                gateway=mock_gw,
                _context={}
            )

        assert result.model_used == "agent-configured-model"


    @pytest.mark.asyncio
    async def test_ai_mode_local_source_skip(self):
        """AI mode with 'local' in sources → local skipped in perplexica loop (line 484)."""
        from api.v1.endpoints.research import research

        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[])

        mock_perplexica = AsyncMock(return_value={"answer": "web result"})
        mock_local = AsyncMock(return_value={"results": [], "total": 0, "indexes_searched": []})
        
        mock_idx_service = MagicMock()

        with patch("api.v1.endpoints.research.perplexica_search", mock_perplexica):
            with patch("api.v1.endpoints.research._search_local_indexes", mock_local):
                result = await research(
                    query="test",
                    sources=["web", "local"],
                    ai_mode=True,
                    settings=self._mock_settings(),
                    gateway=mock_gw,
                    index_service=mock_idx_service,
                    _context={}
                )

        assert "web" in result.results
        assert "local" in result.results
        mock_local.assert_called_once()

    @pytest.mark.asyncio
    async def test_ai_mode_news_source(self):
        """AI mode with news source uses specific focus mode (line 490)."""
        from api.v1.endpoints.research import research

        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[])
        
        mock_idx_service = MagicMock()

        mock_perplexica = AsyncMock(return_value={"answer": "news result"})

        with patch("api.v1.endpoints.research.perplexica_search", mock_perplexica):
            result = await research(
                query="test",
                sources=["news"],
                ai_mode=True,
                settings=self._mock_settings(),
                gateway=mock_gw,
                index_service=mock_idx_service,
                _context={}
            )

        assert "news" in result.results


    @pytest.mark.asyncio
    async def test_gather_exception_result(self):
        """asyncio.gather returns Exception for a source → error in results (lines 539-540)."""
        from api.v1.endpoints.research import research

        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[])
        
        mock_idx_service = MagicMock()

        # Make perplexica raise so gather captures an exception
        mock_perplexica = AsyncMock(side_effect=RuntimeError("perplexica timeout"))

        with patch("api.v1.endpoints.research.perplexica_search", mock_perplexica):
            result = await research(
                query="test",
                sources=["web"],
                ai_mode=True,
                settings=self._mock_settings(),
                gateway=mock_gw,
                index_service=mock_idx_service,
                _context={}
            )

        assert "web" in result.results
        assert result.results["web"]["success"] is False

    @pytest.mark.asyncio
    async def test_research_generic_exception(self):
        """Unexpected exception in gather block → 500 HTTPException (lines 560-562).

        The try block only wraps asyncio.gather + result processing (line 528+).
        We mock asyncio.gather to raise so the outer except triggers.
        """
        from api.v1.endpoints.research import research
        from fastapi import HTTPException

        mock_gw = MagicMock()
        mock_gw.select = AsyncMock(return_value=[])
        
        mock_idx_service = MagicMock()

        mock_perplexica = AsyncMock(return_value={"answer": "ok"})

        with patch("api.v1.endpoints.research.perplexica_search", mock_perplexica):
            with patch("api.v1.endpoints.research.asyncio.gather",
                        new_callable=AsyncMock,
                        side_effect=RuntimeError("gather catastrophe")):
                with pytest.raises(HTTPException) as exc_info:
                    await research(
                        query="test",
                        sources=["web"],
                        ai_mode=True,
                        settings=self._mock_settings(),
                        gateway=mock_gw,
                        index_service=mock_idx_service,
                        _context={}
                    )
        assert exc_info.value.status_code == 500
