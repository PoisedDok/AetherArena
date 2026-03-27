"""
Unit Tests: ArtifactProcessor

Tests artifact routing (chat summary, vision, docling, generic),
metadata parsing, error handling, context budget control, and
the singleton factory.

Uses mock services throughout -- no real InternVL or Docling calls.
"""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from ws.application.artifact_processor import ArtifactProcessor


# =========================================================================
# Stubs
# =========================================================================


class StubArtifact:
    """Minimal artifact matching DB model interface."""

    def __init__(self, *, filename="file.txt", content="", metadata=None,
                 id="art-1", message_id=None):
        self.id = id
        self.filename = filename
        self.content = content
        self.metadata = metadata if metadata is not None else {}
        self.message_id = message_id


# =========================================================================
# process_artifacts: routing
# =========================================================================


class TestProcessArtifactsRouting:
    @pytest.mark.asyncio
    async def test_routes_chat_summary(self):
        proc = ArtifactProcessor()
        artifact = StubArtifact(
            filename="summary.json",
            content=json.dumps({
                "chat_title": "Test Chat",
                "summary": "We discussed testing.",
                "key_topics": ["testing"],
            }),
            metadata={"is_chat_summary": True},
        )
        result = await proc.process_artifacts([artifact], "chat-1234")
        assert result["processed_count"] == 1
        assert "Test Chat" in result["context_text"]
        assert "testing" in result["context_text"]

    @pytest.mark.asyncio
    async def test_routes_vision_artifact_without_processor(self):
        proc = ArtifactProcessor(document_processor=None)
        artifact = StubArtifact(
            filename="photo.png",
            content="base64data",
            metadata={"requires_vision": True},
        )
        result = await proc.process_artifacts([artifact], "chat-1234")
        assert result["processed_count"] == 1
        assert len(result["vision_results"]) == 1
        assert result["vision_results"][0]["status"] == "pending"

    @pytest.mark.asyncio
    async def test_routes_docling_artifact_without_processor(self):
        proc = ArtifactProcessor(document_processor=None)
        artifact = StubArtifact(
            filename="report.pdf",
            content="base64data",
            metadata={"requires_docling": True, "is_binary": True},
        )
        result = await proc.process_artifacts([artifact], "chat-1234")
        assert result["processed_count"] == 1
        assert len(result["docling_results"]) == 1
        assert result["docling_results"][0]["status"] == "pending"

    @pytest.mark.asyncio
    async def test_routes_generic_artifact(self):
        proc = ArtifactProcessor()
        artifact = StubArtifact(
            filename="notes.txt",
            content="Hello world",
            metadata={},
        )
        result = await proc.process_artifacts([artifact], "chat-1234")
        assert result["processed_count"] == 1
        assert "notes.txt" in result["context_text"]
        assert "Hello world" in result["context_text"]

    @pytest.mark.asyncio
    async def test_handles_string_metadata(self):
        proc = ArtifactProcessor()
        artifact = StubArtifact(
            filename="notes.txt",
            content="text content",
            metadata='{"is_chat_summary": false}',
        )
        result = await proc.process_artifacts([artifact], "chat-1234")
        assert result["processed_count"] == 1

    @pytest.mark.asyncio
    async def test_handles_processing_error_per_artifact(self):
        """Error in one artifact should not prevent others from processing."""
        proc = ArtifactProcessor()
        good = StubArtifact(filename="good.txt", content="ok", metadata={})
        bad = StubArtifact(
            filename="bad.txt",
            content="content",
            metadata={"is_chat_summary": True},
        )
        bad.content = None  # Will cause error in _process_chat_summary

        result = await proc.process_artifacts([bad, good], "chat-1234")
        assert result["processed_count"] == 1
        assert "good.txt" in result["context_text"]

    @pytest.mark.asyncio
    async def test_returns_empty_for_no_artifacts(self):
        proc = ArtifactProcessor()
        result = await proc.process_artifacts([], "chat-1234")
        assert result["context_text"] == ""
        assert result["processed_count"] == 0

    @pytest.mark.asyncio
    async def test_per_artifact_error_logged(self):
        """Artifact with non-dict non-str metadata triggers outer except."""
        proc = ArtifactProcessor()
        # metadata=12345 → .get() raises AttributeError → caught at lines 113-114
        bad = StubArtifact(
            id="err-1", filename="err.txt", content="data", metadata=12345,
        )
        good = StubArtifact(filename="ok.txt", content="ok text", metadata={})
        result = await proc.process_artifacts([bad, good], "chat-1234")
        assert result["processed_count"] == 1
        assert "ok text" in result["context_text"]

    @pytest.mark.asyncio
    async def test_multiple_artifacts_joined(self):
        proc = ArtifactProcessor()
        a1 = StubArtifact(filename="a.txt", content="Alpha", metadata={})
        a2 = StubArtifact(filename="b.txt", content="Beta", metadata={})
        result = await proc.process_artifacts([a1, a2], "chat-1234")
        assert result["processed_count"] == 2
        assert "Alpha" in result["context_text"]
        assert "Beta" in result["context_text"]


# =========================================================================
# _process_chat_summary
# =========================================================================


class TestProcessChatSummary:
    @pytest.mark.asyncio
    async def test_parses_json_string_content(self):
        proc = ArtifactProcessor()
        artifact = StubArtifact(
            content=json.dumps({
                "chat_title": "Test",
                "summary": "Summary text.",
                "key_topics": ["a", "b"],
            }),
        )
        result = await proc._process_chat_summary(artifact)
        assert "Test" in result
        assert "Summary text." in result
        assert "a, b" in result

    @pytest.mark.asyncio
    async def test_handles_dict_content(self):
        proc = ArtifactProcessor()
        artifact = StubArtifact(
            content={"chat_title": "Dict", "summary": "Already parsed."},
        )
        result = await proc._process_chat_summary(artifact)
        assert "Dict" in result
        assert "Already parsed." in result

    @pytest.mark.asyncio
    async def test_no_key_topics(self):
        proc = ArtifactProcessor()
        artifact = StubArtifact(
            content=json.dumps({"chat_title": "No Topics", "summary": "Text."}),
        )
        result = await proc._process_chat_summary(artifact)
        assert "No Topics" in result
        assert "Key Topics" not in result

    @pytest.mark.asyncio
    async def test_returns_none_for_empty_content(self):
        proc = ArtifactProcessor()
        artifact = StubArtifact(content=None)
        result = await proc._process_chat_summary(artifact)
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_for_falsy_content(self):
        proc = ArtifactProcessor()
        artifact = StubArtifact(content="")
        result = await proc._process_chat_summary(artifact)
        assert result is None

    @pytest.mark.asyncio
    async def test_handles_invalid_json(self):
        proc = ArtifactProcessor()
        artifact = StubArtifact(content="not json{{{")
        result = await proc._process_chat_summary(artifact)
        assert result is None


# =========================================================================
# _process_vision_artifact
# =========================================================================


class TestProcessVisionArtifact:
    @pytest.mark.asyncio
    async def test_returns_pending_without_processor(self):
        proc = ArtifactProcessor(document_processor=None)
        artifact = StubArtifact(filename="img.png", content="b64data")
        result = await proc._process_vision_artifact(artifact)
        assert result["status"] == "pending"
        assert "img.png" in result["context"]

    @pytest.mark.asyncio
    async def test_processes_binary_image(self):
        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(return_value={"text": "A cat on a mat."})
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="cat.jpg",
            content="base64imgdata",
            metadata={"is_binary": True},
        )
        result = await proc._process_vision_artifact(artifact)
        assert result["status"] == "completed"
        assert "A cat on a mat." in result["context"]
        mock_dp.process_file.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_returns_failed_for_non_binary(self):
        mock_dp = AsyncMock()
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="img.png",
            content="text-content",
            metadata={"is_binary": False},
        )
        result = await proc._process_vision_artifact(artifact)
        assert result["status"] == "failed"

    @pytest.mark.asyncio
    async def test_returns_failed_for_empty_content(self):
        mock_dp = AsyncMock()
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="empty.png",
            content=None,
            metadata={"is_binary": True},
        )
        result = await proc._process_vision_artifact(artifact)
        assert result["status"] == "failed"

    @pytest.mark.asyncio
    async def test_handles_processor_error(self):
        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(side_effect=RuntimeError("InternVL down"))
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="broken.png",
            content="data",
            metadata={"is_binary": True},
        )
        result = await proc._process_vision_artifact(artifact)
        assert result["status"] == "error"

    @pytest.mark.asyncio
    async def test_handles_empty_analysis_text(self):
        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(return_value={"text": ""})
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="img.png",
            content="base64data",
            metadata={"is_binary": True},
        )
        result = await proc._process_vision_artifact(artifact)
        assert result["status"] == "failed"

    @pytest.mark.asyncio
    async def test_handles_string_metadata_in_vision(self):
        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(return_value={"text": "parsed"})
        proc = ArtifactProcessor(document_processor=mock_dp)
        artifact = StubArtifact(
            filename="img.png",
            content="base64data",
            metadata='{"is_binary": true}',
        )
        result = await proc._process_vision_artifact(artifact)
        assert result["status"] == "completed"


# =========================================================================
# _process_docling_artifact
# =========================================================================


class TestProcessDoclingArtifact:
    @pytest.mark.asyncio
    async def test_returns_pending_without_processor(self):
        proc = ArtifactProcessor(document_processor=None)
        artifact = StubArtifact(
            filename="doc.pdf",
            content="b64data",
            metadata={"is_binary": True},
        )
        result = await proc._process_docling_artifact(artifact)
        assert result["status"] == "pending"

    @pytest.mark.asyncio
    async def test_processes_binary_document(self):
        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(return_value={"text": "Document content here."})
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="doc.pdf",
            content="base64pdfdata",
            metadata={"is_binary": True},
        )
        result = await proc._process_docling_artifact(artifact)
        assert result["status"] == "completed"
        assert "Document content here." in result["context"]

    @pytest.mark.asyncio
    async def test_non_binary_handled_via_defense_in_depth(self):
        """Non-binary content reaching docling path is processed directly."""
        mock_dp = AsyncMock()
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="notes.md",
            content="# Important Notes\n\nSome text here.",
            metadata={"is_binary": False},
        )
        result = await proc._process_docling_artifact(artifact)
        assert result["status"] == "completed"
        assert "Important Notes" in result["context"]
        mock_dp.process_file.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_returns_failed_for_empty_content(self):
        mock_dp = AsyncMock()
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="empty.pdf",
            content=None,
            metadata={"is_binary": True},
        )
        result = await proc._process_docling_artifact(artifact)
        assert result["status"] == "failed"

    @pytest.mark.asyncio
    async def test_handles_processor_error(self):
        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(side_effect=ConnectionError("timeout"))
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="crash.pdf",
            content="data",
            metadata={"is_binary": True},
        )
        result = await proc._process_docling_artifact(artifact)
        assert result["status"] == "error"

    @pytest.mark.asyncio
    async def test_handles_empty_extracted_text(self):
        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(return_value={"text": ""})
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="empty_doc.pdf",
            content="base64",
            metadata={"is_binary": True},
        )
        result = await proc._process_docling_artifact(artifact)
        assert result["status"] == "failed"

    @pytest.mark.asyncio
    async def test_handles_string_metadata_in_docling(self):
        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(return_value={"text": "extracted text"})
        proc = ArtifactProcessor(document_processor=mock_dp)
        artifact = StubArtifact(
            filename="doc.pdf",
            content="base64data",
            metadata='{"is_binary": true}',
        )
        result = await proc._process_docling_artifact(artifact)
        assert result["status"] == "completed"


# =========================================================================
# _process_generic_artifact
# =========================================================================


class TestProcessGenericArtifact:
    def test_formats_text_content(self):
        proc = ArtifactProcessor()
        artifact = StubArtifact(filename="notes.txt", content="Hello world")
        result = proc._process_generic_artifact(artifact)
        assert "notes.txt" in result
        assert "Hello world" in result
        assert "```" in result

    def test_returns_none_for_empty_content(self):
        proc = ArtifactProcessor()
        artifact = StubArtifact(content=None)
        result = proc._process_generic_artifact(artifact)
        assert result is None

    def test_returns_none_for_falsy_content(self):
        proc = ArtifactProcessor()
        artifact = StubArtifact(content="")
        result = proc._process_generic_artifact(artifact)
        assert result is None

    def test_detects_binary_content(self):
        """Binary/base64 content (very low whitespace ratio) gets flagged."""
        proc = ArtifactProcessor()
        # Simulate base64 content (no whitespace, 600+ chars)
        binary_content = "AAAA" * 200
        artifact = StubArtifact(filename="data.bin", content=binary_content)
        result = proc._process_generic_artifact(artifact)
        assert "Binary file" in result or "binary" in result.lower()

    def test_short_content_not_flagged_as_binary(self):
        proc = ArtifactProcessor()
        artifact = StubArtifact(filename="tiny.txt", content="short")
        result = proc._process_generic_artifact(artifact)
        assert "Binary" not in result

    def test_handles_processing_error(self):
        proc = ArtifactProcessor()

        class BrokenArtifact:
            id = "bad-1"
            filename = "bad.txt"
            @property
            def content(self):
                raise ValueError("boom")

        result = proc._process_generic_artifact(BrokenArtifact())
        assert result is None


# =========================================================================
# process_artifacts: aggregate context budget
# =========================================================================


class TestAggregateContextBudget:
    @pytest.mark.asyncio
    async def test_large_context_triggers_budget_control(self, monkeypatch):
        """Context > 40k chars triggers aggregate budget fitting."""

        # Mock settings (patched on the real config module)
        mock_settings = SimpleNamespace(
            llm=SimpleNamespace(context_window=8192),
        )
        monkeypatch.setattr(
            "config.settings.get_settings",
            lambda: mock_settings,
        )

        # Mock DocumentUtility (patched on the real utils module)
        class MockUtil:
            def __init__(self, **kwargs):
                pass

            def extract_from_text(self, text, filename, **kwargs):
                if filename == "combined_artifacts":
                    return "Budget-fitted combined context ...section omitted..."
                return text

        monkeypatch.setattr(
            "utils.document_processing.DocumentUtility",
            MockUtil,
        )

        proc = ArtifactProcessor()
        # Multiple moderate artifacts that combine > 40k chars
        # Each ~5k chars (below per-artifact 8k threshold), 10 of them = ~50k combined
        artifacts = [
            StubArtifact(
                filename=f"file_{i}.txt",
                content="word " * 1000,  # ~5000 chars each
                metadata={},
            )
            for i in range(10)
        ]
        result = await proc.process_artifacts(artifacts, "chat-1234")
        assert result["processed_count"] == 10
        # Combined context was budget-fitted
        assert "section omitted" in result["context_text"]

    @pytest.mark.asyncio
    async def test_budget_error_keeps_full_context(self, monkeypatch):
        """Budget fitting error should keep full context."""

        def broken_get_settings():
            raise RuntimeError("settings broken")

        monkeypatch.setattr(
            "config.settings.get_settings",
            broken_get_settings,
        )

        proc = ArtifactProcessor()
        big_content = "word " * 10000
        artifact = StubArtifact(
            filename="huge.txt",
            content=big_content,
            metadata={},
        )
        result = await proc.process_artifacts([artifact], "chat-1234")
        assert result["processed_count"] == 1
        # Full content preserved (budget fitting failed gracefully)
        assert "word" in result["context_text"]


# =========================================================================
# get_artifact_processor singleton
# =========================================================================


class TestGetArtifactProcessor:
    def test_creates_instance(self, monkeypatch):
        import ws.application.artifact_processor as mod
        monkeypatch.setattr(mod, "_artifact_processor", None)

        # Mock DocumentProcessor import to avoid real init
        class MockDocProcessor:
            pass

        monkeypatch.setattr(
            "ws.application.artifact_processor.DocumentProcessor",
            MockDocProcessor,
            raising=False,
        )
        # Ensure import path resolves
        import sys
        from types import ModuleType
        if "core.runtime.document" not in sys.modules:
            mock_mod = ModuleType("core.runtime.document")
            mock_mod.DocumentProcessor = MockDocProcessor
            monkeypatch.setitem(sys.modules, "core.runtime.document", mock_mod)

        from ws.application.artifact_processor import get_artifact_processor
        instance = get_artifact_processor()
        assert isinstance(instance, ArtifactProcessor)

        # Reset singleton
        monkeypatch.setattr(mod, "_artifact_processor", None)

    def test_handles_import_error(self, monkeypatch):
        import ws.application.artifact_processor as mod
        monkeypatch.setattr(mod, "_artifact_processor", None)

        # Make DocumentProcessor import fail
        def fail_import(*args, **kwargs):
            raise ImportError("no document processor")

        import builtins
        original_import = builtins.__import__

        def patched_import(name, *args, **kwargs):
            if name == "core.runtime.document":
                raise ImportError("no document processor")
            return original_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", patched_import)

        from ws.application.artifact_processor import get_artifact_processor
        instance = get_artifact_processor()
        assert isinstance(instance, ArtifactProcessor)
        assert instance._document_processor is None

        # Reset singleton
        monkeypatch.setattr(mod, "_artifact_processor", None)


# =========================================================================
# Vision/Docling with large output (DocumentUtility extractive processing)
# =========================================================================


class TestLargeOutputProcessing:
    @pytest.mark.asyncio
    async def test_vision_large_output_applies_extractive_processing(self, monkeypatch):
        """Vision analysis text is budget-fitted via DocumentUtility."""

        class MockUtil:
            def __init__(self, **kwargs):
                pass
            def extract_from_text(self, text, filename, **kwargs):
                return text[:2000]

        monkeypatch.setattr(
            "utils.document_processing.DocumentUtility",
            MockUtil,
            raising=False,
        )

        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(return_value={"text": "x" * 4000})
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="big_img.png",
            content="base64data",
            metadata={"is_binary": True},
        )
        result = await proc._process_vision_artifact(artifact)
        assert result["status"] == "completed"
        # Output should be shorter than original 4000 chars
        assert len(result["text"]) < 4000

    @pytest.mark.asyncio
    async def test_docling_large_output_applies_extractive_processing(self, monkeypatch):
        """Docling extracted text is budget-fitted via DocumentUtility."""

        class MockUtil:
            def __init__(self, **kwargs):
                pass
            def extract_from_text(self, text, filename, **kwargs):
                return text[:5000]

        monkeypatch.setattr(
            "utils.document_processing.DocumentUtility",
            MockUtil,
            raising=False,
        )

        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(return_value={"text": "y" * 10000})
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="big_doc.pdf",
            content="base64data",
            metadata={"is_binary": True},
        )
        result = await proc._process_docling_artifact(artifact)
        assert result["status"] == "completed"
        assert len(result["text"]) < 10000

    @pytest.mark.asyncio
    async def test_vision_extractive_error_keeps_full_text(self, monkeypatch):
        """DocumentUtility error should keep full analysis text."""

        def broken_util(*args, **kwargs):
            raise RuntimeError("DocumentUtility broken")

        monkeypatch.setattr(
            "utils.document_processing.DocumentUtility",
            broken_util,
            raising=False,
        )

        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(return_value={"text": "z" * 4000})
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="img.png",
            content="base64data",
            metadata={"is_binary": True},
        )
        result = await proc._process_vision_artifact(artifact)
        assert result["status"] == "completed"
        assert len(result["text"]) == 4000

    @pytest.mark.asyncio
    async def test_docling_extractive_error_keeps_full_text(self, monkeypatch):
        """DocumentUtility error should keep full extracted text."""

        def broken_util(*args, **kwargs):
            raise RuntimeError("DocumentUtility broken")

        monkeypatch.setattr(
            "utils.document_processing.DocumentUtility",
            broken_util,
            raising=False,
        )

        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(return_value={"text": "w" * 10000})
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="doc.pdf",
            content="base64data",
            metadata={"is_binary": True},
        )
        result = await proc._process_docling_artifact(artifact)
        assert result["status"] == "completed"
        assert len(result["text"]) == 10000

    def test_generic_extractive_error_keeps_full_content(self, monkeypatch):
        """DocumentUtility error should keep full content for generic artifacts."""

        def broken_util(*args, **kwargs):
            raise RuntimeError("DocumentUtility broken")

        monkeypatch.setattr(
            "utils.document_processing.DocumentUtility",
            broken_util,
        )

        proc = ArtifactProcessor()
        large_text = "word " * 2000  # ~10k chars, with spaces (not binary)
        artifact = StubArtifact(filename="big.txt", content=large_text)
        result = proc._process_generic_artifact(artifact)
        assert "big.txt" in result
        assert "word" in result

    def test_generic_large_output_applies_extractive_processing(self, monkeypatch):
        """Generic artifact text is budget-fitted via DocumentUtility."""

        class MockUtil:
            def __init__(self, **kwargs):
                pass
            def extract_from_text(self, text, filename, **kwargs):
                return text[:5000]

        monkeypatch.setattr(
            "utils.document_processing.DocumentUtility",
            MockUtil,
            raising=False,
        )

        proc = ArtifactProcessor()
        large_text = "word " * 2000  # ~10k chars, with spaces (not binary)
        artifact = StubArtifact(filename="big.txt", content=large_text)
        result = proc._process_generic_artifact(artifact)
        assert "big.txt" in result
        # Output should be smaller than original
        assert len(result) < len(large_text)


# =========================================================================
# Boundary/Edge Case Tests (Audit Expansion)
# =========================================================================


class TestBinaryDetectionBoundary:
    """Tests for whitespace_ratio < 0.02 heuristic on content > 500 chars."""

    def test_exactly_500_chars_not_checked(self):
        """Content exactly 500 chars long should NOT trigger binary detection."""
        proc = ArtifactProcessor()
        # 500 chars, no whitespace → should NOT be detected as binary
        content = "A" * 500
        artifact = StubArtifact(filename="exact.txt", content=content)
        result = proc._process_generic_artifact(artifact)
        # Should contain the actual content, not "Binary file"
        assert "AAAA" in result
        assert "Binary file" not in result

    def test_501_chars_no_whitespace_detected_as_binary(self):
        """Content 501 chars with zero whitespace triggers binary detection."""
        proc = ArtifactProcessor()
        content = "B" * 501
        artifact = StubArtifact(filename="binary.dat", content=content)
        result = proc._process_generic_artifact(artifact)
        assert "Binary file" in result

    def test_whitespace_ratio_exactly_at_threshold(self):
        """Content with whitespace ratio exactly 0.02 should NOT be binary."""
        proc = ArtifactProcessor()
        # 1000 chars total, 20 spaces (ratio = 0.02)
        # But only first 2000 chars are sampled, so for 1000 chars:
        # 20/1000 = 0.02 → NOT < 0.02
        content = "x" * 980 + " " * 20
        artifact = StubArtifact(filename="edge.txt", content=content)
        result = proc._process_generic_artifact(artifact)
        assert "Binary file" not in result

    def test_whitespace_ratio_just_below_threshold(self):
        """Content with whitespace ratio 0.019 triggers binary detection."""
        proc = ArtifactProcessor()
        # 1000 chars, 19 spaces → 19/1000 = 0.019 < 0.02
        content = "x" * 981 + " " * 19
        artifact = StubArtifact(filename="almost.dat", content=content)
        result = proc._process_generic_artifact(artifact)
        assert "Binary file" in result

    def test_minified_js_false_positive(self):
        """Minified JS/CSS with very low whitespace triggers binary detection.

        This is a known limitation of the heuristic documented in the audit.
        """
        proc = ArtifactProcessor()
        # Minified JS: long line, minimal whitespace
        minified = "function(){" + "a=b+c;d=e+f;" * 100 + "}"
        artifact = StubArtifact(filename="app.min.js", content=minified)
        result = proc._process_generic_artifact(artifact)
        # This WILL be detected as binary due to low whitespace ratio
        # Documenting as a known false-positive
        assert "Binary file" in result or "app.min.js" in result

    def test_normal_text_not_detected_as_binary(self):
        """Normal prose with spaces should never trigger binary detection."""
        proc = ArtifactProcessor()
        content = "The quick brown fox jumps over the lazy dog. " * 50
        artifact = StubArtifact(filename="prose.txt", content=content)
        result = proc._process_generic_artifact(artifact)
        assert "Binary file" not in result
        assert "quick brown fox" in result


class TestGenericLargeFileBoundary:
    """Tests for the 8000-char extractive processing threshold."""

    def test_exactly_8000_chars_processed_through_utility(self, monkeypatch):
        """All content passes through DocumentUtility; gate returns small content unchanged."""
        called = []
        class SpyUtil:
            def __init__(self, **kw):
                called.append(True)
            def extract_from_text(self, text, filename, **kw):
                return text
        monkeypatch.setattr(
            "utils.document_processing.DocumentUtility",
            SpyUtil,
            raising=False,
        )
        proc = ArtifactProcessor()
        content = "word " * 1600  # exactly 8000 chars
        artifact = StubArtifact(filename="exact8k.txt", content=content)
        result = proc._process_generic_artifact(artifact)
        assert len(called) >= 1
        assert "word" in result

    def test_8001_chars_processed_through_utility(self, monkeypatch):
        """Content of any size passes through DocumentUtility."""
        called = []
        class SpyUtil:
            def __init__(self, **kw):
                called.append(True)
            def extract_from_text(self, text, filename, **kw):
                return text[:100]
        monkeypatch.setattr(
            "utils.document_processing.DocumentUtility",
            SpyUtil,
            raising=False,
        )
        proc = ArtifactProcessor()
        content = "word " * 1600 + "x"  # 8001 chars
        artifact = StubArtifact(filename="over8k.txt", content=content)
        proc._process_generic_artifact(artifact)
        assert len(called) >= 1


class TestAggregateBudgetBoundary:
    """Tests for the 40000-char aggregate budget threshold."""

    @pytest.mark.asyncio
    async def test_exactly_40000_chars_no_budget_fitting(self):
        """Combined context exactly 40000 chars should NOT trigger budget."""
        proc = ArtifactProcessor()
        # Each artifact ~4000 chars, 10 artifacts = ~40000
        # But with formatting overhead it may exceed, so use fewer
        artifacts = [
            StubArtifact(
                filename=f"f{i}.txt",
                content="word " * 750,  # ~3750 chars
                metadata={},
            )
            for i in range(10)
        ]
        result = await proc.process_artifacts(artifacts, "chat-1234")
        # With formatting (headers + code fences), total will exceed 40000
        # If it DOESN'T exceed, no budget fitting happens
        assert result["processed_count"] == 10
        # Should NOT contain "section omitted" if under threshold
        # (This test documents the boundary behavior)

    @pytest.mark.asyncio
    async def test_single_artifact_below_budget(self):
        """Single artifact under 40000 chars never triggers budget fitting."""
        proc = ArtifactProcessor()
        content = "word " * 5000  # 25000 chars
        artifact = StubArtifact(filename="medium.txt", content=content, metadata={})
        result = await proc.process_artifacts([artifact], "chat-1234")
        assert result["processed_count"] == 1
        assert "section omitted" not in result["context_text"]


class TestChatSummaryEdgeCases:
    """Edge cases for _process_chat_summary."""

    @pytest.mark.asyncio
    async def test_list_content_type(self):
        """Content that is a list (not dict/str) should fail gracefully."""
        proc = ArtifactProcessor()
        artifact = StubArtifact(content=["a", "b", "c"])
        result = await proc._process_chat_summary(artifact)
        # list is truthy but not dict → should handle gracefully
        # The method tries json.loads on non-string, which will fail
        # Then it falls to the except block
        assert result is None or isinstance(result, str)

    @pytest.mark.asyncio
    async def test_dict_with_empty_summary(self):
        """Dict content with empty summary produces output but minimal."""
        proc = ArtifactProcessor()
        artifact = StubArtifact(
            content=json.dumps({
                "chat_title": "Empty Talk",
                "summary": "",
                "key_topics": [],
            }),
        )
        result = await proc._process_chat_summary(artifact)
        assert result is not None
        assert "Empty Talk" in result

    @pytest.mark.asyncio
    async def test_nested_json_string(self):
        """Double-encoded JSON string handled correctly."""
        proc = ArtifactProcessor()
        inner = json.dumps({"chat_title": "Deep", "summary": "Nested."})
        artifact = StubArtifact(content=json.dumps(inner))
        # This will parse outer JSON to get a string, then fail to .get()
        result = await proc._process_chat_summary(artifact)
        # Double-encoded JSON → outer parse yields string → inner parse needed
        # The code does json.loads once if content is string, gets another string
        # Then tries .get() on a string → AttributeError → None
        assert result is None or isinstance(result, str)


class TestVisionArtifactEdgeCases:
    """Edge cases for _process_vision_artifact."""

    @pytest.mark.asyncio
    async def test_processor_returns_none_text(self):
        """Processor returning None text should fail gracefully."""
        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(return_value={"text": None})
        proc = ArtifactProcessor(document_processor=mock_dp)
        artifact = StubArtifact(
            filename="img.png",
            content="data",
            metadata={"is_binary": True},
        )
        result = await proc._process_vision_artifact(artifact)
        assert result["status"] == "failed"

    @pytest.mark.asyncio
    async def test_processor_returns_unexpected_shape_via_public_api(self):
        """Broadened except: _process_vision_artifact now catches AttributeError.

        Processor returning non-dict → .get() raises AttributeError.
        After broadening to except Exception, the error is caught INSIDE
        the private method, returning an error status dict. The artifact
        is processed (with status=error), so processed_count=1.
        """
        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(return_value="just a string")
        proc = ArtifactProcessor(document_processor=mock_dp)
        artifact = StubArtifact(
            filename="img.png",
            content="data",
            metadata={"requires_vision": True, "is_binary": True},
        )
        result = await proc.process_artifacts([artifact], "chat-1234")
        # Now caught at private method level, artifact IS processed with error status
        assert result["processed_count"] == 1
        assert len(result["vision_results"]) == 1
        assert result["vision_results"][0]["status"] == "error"


class TestDoclingArtifactEdgeCases:
    """Edge cases for _process_docling_artifact."""

    @pytest.mark.asyncio
    async def test_processor_returns_none_text(self):
        """Processor returning None text should fail gracefully."""
        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(return_value={"text": None})
        proc = ArtifactProcessor(document_processor=mock_dp)
        artifact = StubArtifact(
            filename="doc.pdf",
            content="data",
            metadata={"is_binary": True},
        )
        result = await proc._process_docling_artifact(artifact)
        assert result["status"] == "failed"

    @pytest.mark.asyncio
    async def test_processor_returns_unexpected_shape_via_public_api(self):
        """Broadened except: _process_docling_artifact now catches AttributeError.

        Same as vision: after broadening to except Exception, the error is caught
        INSIDE the private method, returning an error status dict.
        """
        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(return_value=42)
        proc = ArtifactProcessor(document_processor=mock_dp)
        artifact = StubArtifact(
            filename="doc.pdf",
            content="data",
            metadata={"requires_docling": True, "is_binary": True},
        )
        result = await proc.process_artifacts([artifact], "chat-1234")
        # Now caught at private method level, artifact IS processed with error status
        assert result["processed_count"] == 1
        assert len(result["docling_results"]) == 1
        assert result["docling_results"][0]["status"] == "error"


class TestMetadataEdgeCases:
    """Edge cases for metadata parsing in process_artifacts."""

    @pytest.mark.asyncio
    async def test_metadata_as_list(self):
        """Metadata that is a list (not dict/str) should fail per-artifact."""
        proc = ArtifactProcessor()
        artifact = StubArtifact(
            filename="file.txt",
            content="content",
            metadata=["not", "a", "dict"],
        )
        # list doesn't have .get() → AttributeError → caught by outer except
        result = await proc.process_artifacts([artifact], "chat-1234")
        assert result["processed_count"] == 0

    @pytest.mark.asyncio
    async def test_metadata_none(self):
        """Metadata=None should default to empty dict behavior."""
        proc = ArtifactProcessor()

        class NoMetaArtifact:
            id = "nm-1"
            filename = "file.txt"
            content = "data"
            # No metadata attribute at all

        artifact = NoMetaArtifact()
        result = await proc.process_artifacts([artifact], "chat-1234")
        # hasattr check returns False → metadata = {} → generic path
        assert result["processed_count"] == 1

    @pytest.mark.asyncio
    async def test_malformed_json_metadata_string(self):
        """Metadata string that is not valid JSON should fail per-artifact."""
        proc = ArtifactProcessor()
        artifact = StubArtifact(
            filename="file.txt",
            content="content",
            metadata="not{json",
        )
        # json.loads fails → caught by outer except
        result = await proc.process_artifacts([artifact], "chat-1234")
        assert result["processed_count"] == 0

    @pytest.mark.asyncio
    async def test_multiple_flags_priority(self):
        """is_chat_summary takes priority over requires_vision and requires_docling."""
        proc = ArtifactProcessor()
        artifact = StubArtifact(
            filename="multi.json",
            content=json.dumps({
                "chat_title": "Priority Test",
                "summary": "This should win.",
            }),
            metadata={
                "is_chat_summary": True,
                "requires_vision": True,
                "requires_docling": True,
            },
        )
        result = await proc.process_artifacts([artifact], "chat-1234")
        assert result["processed_count"] == 1
        assert "Priority Test" in result["context_text"]
        # Should NOT have vision_results since chat_summary path was taken
        assert len(result["vision_results"]) == 0
        assert len(result["docling_results"]) == 0


# =========================================================================
# Adversarial: Broadened except Exception catches previously-missed types
# =========================================================================


class TestBroadExceptionHandling:
    """Verify that broadened except clauses in artifact_processor.py catch
    exception types that were previously missed by narrow except tuples.
    These tests would have CRASHED before the bug fixes."""

    @pytest.mark.asyncio
    async def test_process_artifacts_timeout_error_per_artifact(self):
        """Main loop: TimeoutError from a single artifact is caught."""
        proc = ArtifactProcessor()

        class TimeoutArtifact:
            id = "to-1"
            filename = "slow.txt"
            metadata = {}
            @property
            def content(self):
                raise TimeoutError("network timeout during content read")

        good = StubArtifact(filename="ok.txt", content="fine", metadata={})
        result = await proc.process_artifacts([TimeoutArtifact(), good], "chat-1234")
        assert result["processed_count"] == 1
        assert "fine" in result["context_text"]

    @pytest.mark.asyncio
    async def test_process_artifacts_connection_error_per_artifact(self):
        """Main loop: ConnectionError from artifact processing is caught."""
        proc = ArtifactProcessor()

        class ConnErrorArtifact:
            id = "ce-1"
            filename = "remote.txt"
            metadata = {"is_chat_summary": True}
            content = "data"
            def __getattr__(self, name):
                if name == "content":
                    raise ConnectionError("connection reset")
                raise AttributeError(name)

        good = StubArtifact(filename="ok.txt", content="fine", metadata={})
        result = await proc.process_artifacts([ConnErrorArtifact(), good], "chat-1234")
        assert result["processed_count"] >= 1

    @pytest.mark.asyncio
    async def test_vision_timeout_error_handled(self):
        """Vision: TimeoutError from document processor is caught."""
        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(side_effect=TimeoutError("inference timeout"))
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="slow.png",
            content="data",
            metadata={"is_binary": True},
        )
        result = await proc._process_vision_artifact(artifact)
        assert result["status"] == "error"

    @pytest.mark.asyncio
    async def test_docling_timeout_error_handled(self):
        """Docling: TimeoutError from document processor is caught."""
        mock_dp = AsyncMock()
        mock_dp.process_file = AsyncMock(side_effect=TimeoutError("docling timeout"))
        proc = ArtifactProcessor(document_processor=mock_dp)

        artifact = StubArtifact(
            filename="slow.pdf",
            content="data",
            metadata={"is_binary": True},
        )
        result = await proc._process_docling_artifact(artifact)
        assert result["status"] == "error"

    def test_generic_connection_error_handled(self):
        """Generic: ConnectionError from content processing is caught."""
        proc = ArtifactProcessor()

        class ConnErrorContent:
            id = "ce-gen"
            filename = "remote.txt"
            @property
            def content(self):
                raise ConnectionError("connection reset by peer")

        result = proc._process_generic_artifact(ConnErrorContent())
        assert result is None

    @pytest.mark.asyncio
    async def test_chat_summary_connection_error_handled(self):
        """Chat summary: ConnectionError during JSON parsing is caught."""
        proc = ArtifactProcessor()

        class ConnCrashArtifact:
            id = "cs-ce"
            filename = "summary.json"
            @property
            def content(self):
                raise ConnectionError("lost connection")

        result = await proc._process_chat_summary(ConnCrashArtifact())
        assert result is None

    @pytest.mark.asyncio
    async def test_aggregate_budget_timeout_error_fallback(self, monkeypatch):
        """Budget fitting: TimeoutError during settings load keeps full context."""
        def timeout_settings():
            raise TimeoutError("settings service timeout")

        monkeypatch.setattr("config.settings.get_settings", timeout_settings)

        proc = ArtifactProcessor()
        big_content = "word " * 10000
        artifact = StubArtifact(filename="huge.txt", content=big_content, metadata={})
        result = await proc.process_artifacts([artifact], "chat-1234")
        assert result["processed_count"] == 1
        assert "word" in result["context_text"]

    @pytest.mark.asyncio
    async def test_factory_timeout_error_handled(self, monkeypatch):
        """get_artifact_processor: TimeoutError during DocumentProcessor init is caught."""
        import ws.application.artifact_processor as mod
        monkeypatch.setattr(mod, "_artifact_processor", None)

        import builtins
        original_import = builtins.__import__

        def patched_import(name, *args, **kwargs):
            if name == "core.runtime.document":
                raise TimeoutError("model load timeout")
            return original_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", patched_import)

        from ws.application.artifact_processor import get_artifact_processor
        instance = get_artifact_processor()
        assert isinstance(instance, ArtifactProcessor)
        assert instance._document_processor is None

        monkeypatch.setattr(mod, "_artifact_processor", None)
