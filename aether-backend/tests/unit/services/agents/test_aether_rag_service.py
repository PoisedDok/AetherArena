"""
Tests for application/indexing/aether_rag_service.py
"""

import json
from pathlib import Path
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest

from application.indexing.aether_rag_service import AetherRagService, get_aether_rag_service

@pytest.fixture(autouse=True)
def _aether_rag_module():
    import sys as _sys
    mock_mod = MagicMock()
    saved = _sys.modules.get("aether_rag")
    _sys.modules["aether_rag"] = mock_mod
    yield mock_mod
    if saved is not None:
        _sys.modules["aether_rag"] = saved
    else:
        _sys.modules.pop("aether_rag", None)

@pytest.fixture
def tmp_index_dir(tmp_path):
    d = tmp_path / "agent_indexes"
    d.mkdir()
    return d

@pytest.fixture
def manager():
    return AetherRagService(
        embedding_model="text-embedding-3-small",
        api_base="http://localhost:3000/api/embeddings",
        api_key="test-key"
    )

@pytest.fixture
def manager_no_api_base():
    return AetherRagService(
        embedding_model="all-MiniLM-L6-v2",
        api_base=None,
        api_key=None
    )

class TestIndexNameForAgent:
    def test_normal_agent_name(self):
        assert AetherRagService.index_name_for_agent("memory") == "agent_memory_index"

    def test_name_with_spaces_and_caps(self):
        result = AetherRagService.index_name_for_agent("  Research Agent  ")
        assert result == "agent_research_agent_index"

    def test_name_with_special_chars(self):
        result = AetherRagService.index_name_for_agent("research-v2.0")
        assert result == "agent_research_v2_0_index"

    def test_empty_string_returns_none(self):
        assert AetherRagService.index_name_for_agent("") is None

    def test_none_returns_none(self):
        assert AetherRagService.index_name_for_agent(None) is None

class TestExtractText:
    def test_string_input_returned_as_is(self, manager):
        assert manager._extract_text_from_content("hello world", "content") == "hello world"

    def test_dict_with_matching_string_field(self, manager):
        content = {"content": "Legal memory text here", "id": "123"}
        result = manager._extract_text_from_content(content, "content")
        assert result == "Legal memory text here"

    def test_dict_with_matching_dict_field_serialized(self, manager):
        inner = {"clause": "termination", "risk": "high"}
        content = {"content": inner, "id": "123"}
        result = manager._extract_text_from_content(content, "content")
        parsed = json.loads(result)
        assert parsed == inner

class TestExtractMetadata:
    def test_extracts_known_fields(self, manager):
        content = {
            "chunk_index": 3,
            "attachment_id": "att-123",
            "chat_id": "chat-456",
            "priority": "high",
            "due_date": "2026-03-01",
            "jurisdiction": "California",
            "irrelevant_field": "ignored"
        }
        meta = manager._extract_searchable_metadata(content)
        assert meta == {
            "chunk_index": 3,
            "attachment_id": "att-123",
            "chat_id": "chat-456",
            "priority": "high",
            "due_date": "2026-03-01",
            "jurisdiction": "California",
        }

class TestIndexAgentOutput:
    @patch("aether_rag.AetherRagBuilder")
    async def test_creates_new_index(self, MockBuilder, manager, tmp_index_dir):
        mock_builder = MagicMock()
        MockBuilder.return_value = mock_builder

        output_id = uuid4()
        content = {"content": "This is a legal memory about contract terms and conditions"}
        result = await manager.index_agent_output(tmp_index_dir, "memory", output_id, content)

        assert result is True
        MockBuilder.assert_called_once()
        mock_builder.build_index.assert_called_once()

    async def test_bad_agent_name_returns_false(self, manager, tmp_index_dir):
        result = await manager.index_agent_output(tmp_index_dir, "", uuid4(), {"content": "text"})
        assert result is False

class TestSearch:
    @patch("aether_rag.AetherRagSearcher")
    async def test_search_returns_formatted_results(self, MockSearcher, manager, tmp_index_dir):
        index_path = tmp_index_dir / "agent_memory_index.aether_rag"
        meta_path = Path(f"{index_path}.meta.json")
        meta_path.write_text(json.dumps({"enable_bm25": True}))

        mock_result = MagicMock()
        mock_result.text = "Found memory"
        mock_result.score = 0.95
        mock_result.metadata = {"output_id": "abc", "agent_name": "memory"}

        mock_searcher = MagicMock()
        mock_searcher.search.return_value = [mock_result]
        MockSearcher.return_value = mock_searcher

        results = await manager.search(tmp_index_dir, "agent_memory_index", "contract terms")
        assert len(results) == 1
        assert results[0]["text"] == "Found memory"

    async def test_search_missing_index(self, manager, tmp_index_dir):
        results = await manager.search(tmp_index_dir, "agent_memory_index", "query")
        assert results == []

class TestBatchIndex:
    @patch("aether_rag.AetherRagBuilder")
    async def test_batch_indexes_multiple_outputs(self, MockBuilder, manager, tmp_index_dir):
        mock_builder = MagicMock()
        MockBuilder.return_value = mock_builder

        outputs = [
            {"id": str(uuid4()), "content": "First memory text that is long enough to index"},
            {"id": str(uuid4()), "content": "Second memory text that also exceeds minimum length"},
        ]
        count = await manager.batch_index_agent_outputs(tmp_index_dir, "memory", outputs)
        assert count == 2

class TestGetIndexStats:
    def test_index_not_found(self, manager, tmp_index_dir):
        result = manager.get_agent_index_stats(tmp_index_dir, "memory")
        assert result["exists"] is False
        assert "path" in result

class TestFactory:
    @patch("config.settings.get_settings")
    def test_factory_uses_settings_defaults(self, mock_get_settings):
        mock_settings = MagicMock()
        mock_settings.embedding_service.model = "text-embedding-3-small"
        mock_settings.embedding_service.openai_base_url = "http://embed:3000"
        mock_get_settings.return_value = mock_settings

        mgr = get_aether_rag_service(
            embedding_model=None
        )
        assert mgr.embedding_model == "text-embedding-3-small"
        assert mgr.api_base == "http://embed:3000"
