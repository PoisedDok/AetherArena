"""
Integration Test: Document Processing Utility → LLM Summarization Pipeline

Real end-to-end test using actual papers from sample/ folder.
No mocking. Requires:
  - pypdfium2 installed
  - aether-inference at settings.inference_url (default: http://127.0.0.1:7090/v1)

@.architecture
Incoming: pytest --- {test invocation}
Processing: DocumentUtility.extract_context() → LLM summarization --- {PDF parse, sentence extraction, LexRank selection, LLM call}
Outgoing: assertions + printed summaries --- {pass/fail}
"""

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[2]
SAMPLE_DIR = BACKEND_ROOT.parent / "sample"
PAPERS_DIR = SAMPLE_DIR / "papers"

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import httpx
from utils.document_processing import DocumentUtility
from config.settings import get_settings, reload_settings
from application.chat.summary_service import ChatSummaryService
from data.database.persistence_gateway import SupabasePersistenceGateway


# =============================================================================
# Helpers
# =============================================================================

class _StubClient:
    pass


def _make_summary_service():
    """Build ChatSummaryService using central config (aether-inference default)."""
    reload_settings()
    settings = get_settings()
    gateway = SupabasePersistenceGateway(_StubClient())
    uow = SimpleNamespace(gateway=gateway)
    svc = ChatSummaryService(uow, settings)
    return svc


def _get_inference_url() -> str:
    """Get the inference URL from central config."""
    reload_settings()
    return get_settings().inference_url


async def _inference_available() -> bool:
    """Check if aether-inference is reachable at the configured inference_url."""
    url = _get_inference_url()
    try:
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get(f"{url}/models")
            return r.status_code == 200
    except Exception:
        return False


# =============================================================================
# Stage 1: DocumentUtility Extraction (no LLM needed)
# =============================================================================

class TestDocumentUtilityRealFiles:
    """Test DocumentUtility against actual files in sample/."""

    def _get_util(self, **overrides) -> DocumentUtility:
        return DocumentUtility(**overrides)

    # --- PDF papers ---

    def test_parse_wetok_processed_v2(self):
        """Small processed PDF (22KB) should parse fully."""
        f = PAPERS_DIR / "wetok_tokenization_2026_PROCESSED_V2.pdf"
        if not f.exists():
            pytest.skip(f"File not found: {f}")
        util = self._get_util()
        result = util.extract_context(f)
        assert result is not None
        assert len(result) > 200
        assert "[FILE:" in result
        print("\n--- wetok_PROCESSED_V2 ---")
        print(f"Length: {len(result)} chars")
        print(f"First 500 chars:\n{result[:500]}")

    def test_parse_wetok_processed(self):
        """Medium processed PDF (110KB) should parse and may trigger summarization."""
        f = PAPERS_DIR / "wetok_tokenization_2026_PROCESSED.pdf"
        if not f.exists():
            pytest.skip(f"File not found: {f}")
        util = self._get_util()
        result = util.extract_context(f)
        assert result is not None
        assert len(result) > 200
        print("\n--- wetok_PROCESSED ---")
        print(f"Length: {len(result)} chars")
        print(f"First 500 chars:\n{result[:500]}")

    def test_parse_timeseries_bpe(self):
        """1.6MB paper - should trigger large-file extractive summarization."""
        f = PAPERS_DIR / "timeseries_bpe_2026.pdf"
        if not f.exists():
            pytest.skip(f"File not found: {f}")
        util = self._get_util()
        result = util.extract_context(f)
        assert result is not None
        assert len(result) > 500
        # Large file should show sentence extraction metadata
        print("\n--- timeseries_bpe ---")
        print(f"Length: {len(result)} chars")
        if "Summarized" in result:
            print("  -> Triggered large-file summarization pipeline")
        print(f"First 800 chars:\n{result[:800]}")

    def test_parse_multilingual_pretraining(self):
        """7.9MB paper - heavy extractive pipeline."""
        f = PAPERS_DIR / "multilingual_pretraining_2026.pdf"
        if not f.exists():
            pytest.skip(f"File not found: {f}")
        util = self._get_util()
        result = util.extract_context(f)
        assert result is not None
        assert len(result) > 500
        print("\n--- multilingual_pretraining ---")
        print(f"Length: {len(result)} chars")
        if "Summarized" in result:
            print("  -> Triggered large-file summarization pipeline")
        print(f"First 800 chars:\n{result[:800]}")

    def test_parse_wetok_full(self):
        """20MB full paper - stress test for DocumentUtility."""
        f = PAPERS_DIR / "wetok_tokenization_2026.pdf"
        if not f.exists():
            pytest.skip(f"File not found: {f}")
        util = self._get_util()
        result = util.extract_context(f)
        assert result is not None
        assert len(result) > 500
        print("\n--- wetok_full (20MB) ---")
        print(f"Length: {len(result)} chars")
        if "Summarized" in result:
            sentence_info = result.split("\n")[0]
            print(f"  -> {sentence_info}")
        print(f"First 800 chars:\n{result[:800]}")

    def test_parse_equity_slip(self):
        """122KB equity investment slip PDF."""
        f = SAMPLE_DIR / "equity_investment_slip-1.pdf"
        if not f.exists():
            pytest.skip(f"File not found: {f}")
        util = self._get_util()
        result = util.extract_context(f)
        assert result is not None
        print("\n--- equity_investment_slip ---")
        print(f"Length: {len(result)} chars")
        print(f"First 500 chars:\n{result[:500]}")

    # --- Text files ---

    def test_parse_markdown_file(self):
        """breaking_ai_news.md - text file."""
        f = SAMPLE_DIR / "breaking_ai_news.md"
        if not f.exists():
            pytest.skip(f"File not found: {f}")
        util = self._get_util()
        result = util.extract_context(f)
        assert result is not None
        assert "[FILE:" in result
        print("\n--- breaking_ai_news.md ---")
        print(f"Length: {len(result)} chars")

    def test_parse_txt_file(self):
        """nodejs_critical_zero_day.txt - text file."""
        f = SAMPLE_DIR / "nodejs_critical_zero_day.txt"
        if not f.exists():
            pytest.skip(f"File not found: {f}")
        util = self._get_util()
        result = util.extract_context(f)
        assert result is not None
        assert "[FILE:" in result
        print("\n--- nodejs_critical_zero_day.txt ---")
        print(f"Length: {len(result)} chars")

    # --- Sentence extraction quality ---

    def test_sentence_extraction_from_pdf(self):
        """Verify sentence splitting produces valid sentences from real PDF content."""
        f = PAPERS_DIR / "timeseries_bpe_2026.pdf"
        if not f.exists():
            pytest.skip(f"File not found: {f}")

        util = self._get_util()
        try:
            import pypdfium2 as pdfium
            pdf = pdfium.PdfDocument(str(f))
            text_parts = []
            for page in pdf:
                tp = page.get_textpage()
                text_parts.append(tp.get_text_range())
                tp.close()
                page.close()
            pdf.close()
            raw_text = "\n".join(text_parts)
        except ImportError:
            pytest.skip("pypdfium2 not installed")

        cleaned = util._clean_pdf_text(raw_text)
        sentences = util._split_sentences_with_offsets(cleaned)

        assert len(sentences) > 0, "No sentences produced"
        print("\n--- Sentence extraction (timeseries_bpe) ---")
        print(f"Raw text: {len(raw_text)} chars")
        print(f"Cleaned text: {len(cleaned)} chars")
        print(f"Sentences: {len(sentences)}")
        avg_len = sum(len(s[0]) for s in sentences) / len(sentences)
        print(f"Avg sentence length: {avg_len:.0f} chars")

        non_noise = [s for s in sentences if not util._is_noise_sentence(s[0])]
        assert len(non_noise) > 0, "All sentences classified as noise"
        print(f"Non-noise sentences: {len(non_noise)}")

        for text, start, end in sentences:
            assert end > start, f"Invalid offsets: start={start}, end={end}"
            assert len(text.strip()) > 0, "Empty sentence text"

    def test_lexrank_selection_from_pdf(self):
        """Verify LexRank sentence selection works on real PDF content."""
        f = PAPERS_DIR / "timeseries_bpe_2026.pdf"
        if not f.exists():
            pytest.skip(f"File not found: {f}")

        util = self._get_util()
        try:
            import pypdfium2 as pdfium
            pdf = pdfium.PdfDocument(str(f))
            text_parts = []
            for page in pdf:
                tp = page.get_textpage()
                text_parts.append(tp.get_text_range())
                tp.close()
                page.close()
            pdf.close()
            raw_text = "\n".join(text_parts)
        except ImportError:
            pytest.skip("pypdfium2 not installed")

        cleaned = util._clean_pdf_text(raw_text)
        sentences = util._split_sentences_with_offsets(cleaned)

        if len(sentences) <= 10:
            pytest.skip("Too few sentences for LexRank test")

        target = min(30, len(sentences))
        selected = util._lexrank_select(cleaned, sentences, target)
        assert len(selected) == target
        assert all(0 <= idx < len(sentences) for idx in selected)

        print("\n--- LexRank selection (timeseries_bpe) ---")
        print(f"Total sentences: {len(sentences)}")
        print(f"Selected: {len(selected)}")
        print(f"Top selected indices: {sorted(selected)[:5]}")
        print(f"Top sentence preview: {sentences[min(selected)][0][:200]}")


# =============================================================================
# Stage 2: Full Pipeline - DocumentUtility → LLM Summarization
# =============================================================================

@pytest.mark.asyncio
async def test_pipeline_small_pdf_to_llm_summary():
    """Parse small processed PDF → feed extracted text to LLM → get summary."""
    if not await _inference_available():
        pytest.skip(f"aether-inference not available at {_get_inference_url()}")

    f = PAPERS_DIR / "wetok_tokenization_2026_PROCESSED_V2.pdf"
    if not f.exists():
        pytest.skip(f"File not found: {f}")

    # Stage 1: Extract
    util = DocumentUtility()
    extracted = util.extract_context(f)
    assert extracted and len(extracted) > 100

    # Stage 2: Summarize via LLM
    svc = _make_summary_service()
    # Simulate as a "medium" chat conversation text
    import httpx
    try:
        result = await svc._call_llm_for_summary(extracted, "full", message_count=1)
    except httpx.HTTPError as e:
        if "503" in str(e):
            pytest.skip("Inference server returned 503 (model load failure)")
        raise

    assert isinstance(result, dict)
    assert len(result["title"]) > 0
    assert len(result["summary"]) > 0
    assert len(result["key_points"]) > 0

    print("\n=== PIPELINE: wetok_PROCESSED_V2 (22KB PDF) ===")
    print(f"Extracted: {len(extracted)} chars")
    print(f"Title: {result['title']}")
    print(f"Summary: {result['summary']}")
    print(f"Key Points ({len(result['key_points'])}):")
    for kp in result["key_points"]:
        print(f"  - {kp}")
    print(f"Entities: {result['entities']}")
    print(f"Topics: {result['topics']}")


@pytest.mark.asyncio
async def test_pipeline_medium_pdf_to_llm_summary():
    """Parse 1.6MB paper → extractive summarization → LLM summary."""
    if not await _inference_available():
        pytest.skip(f"aether-inference not available at {_get_inference_url()}")

    f = PAPERS_DIR / "timeseries_bpe_2026.pdf"
    if not f.exists():
        pytest.skip(f"File not found: {f}")

    # Stage 1: Extract
    util = DocumentUtility()
    extracted = util.extract_context(f)
    assert extracted and len(extracted) > 500

    # Stage 2: Summarize via LLM
    svc = _make_summary_service()
    # Trim to max_conversation_chars to fit LLM context
    max_chars = svc._settings.summary_service.max_conversation_chars
    conversation_text = extracted[:max_chars] if len(extracted) > max_chars else extracted

    import httpx
    try:
        result = await svc._call_llm_for_summary(conversation_text, "technical", message_count=1)
    except httpx.HTTPError as e:
        if "503" in str(e):
            pytest.skip("Inference server returned 503 (model load failure)")
        raise

    assert isinstance(result, dict)
    assert len(result["title"]) > 0

    print("\n=== PIPELINE: timeseries_bpe (1.6MB PDF) ===")
    print(f"Extracted: {len(extracted)} chars → Trimmed to: {len(conversation_text)} chars")
    print(f"Title: {result['title']}")
    print(f"Summary: {result['summary']}")
    print(f"Key Points ({len(result['key_points'])}):")
    for kp in result["key_points"]:
        print(f"  - {kp}")
    print(f"Entities: {result['entities']}")
    print(f"Topics: {result['topics']}")


@pytest.mark.asyncio
async def test_pipeline_large_pdf_to_llm_summary():
    """Parse 7.9MB paper → heavy extractive summarization → LLM summary."""
    if not await _inference_available():
        pytest.skip(f"aether-inference not available at {_get_inference_url()}")

    f = PAPERS_DIR / "multilingual_pretraining_2026.pdf"
    if not f.exists():
        pytest.skip(f"File not found: {f}")

    # Stage 1: Extract
    util = DocumentUtility()
    extracted = util.extract_context(f)
    assert extracted and len(extracted) > 500

    # Stage 2: Summarize via LLM
    svc = _make_summary_service()
    max_chars = svc._settings.summary_service.max_conversation_chars
    conversation_text = extracted[:max_chars] if len(extracted) > max_chars else extracted

    import httpx
    try:
        result = await svc._call_llm_for_summary(conversation_text, "full", message_count=1)
    except httpx.HTTPError as e:
        if "503" in str(e):
            pytest.skip("Inference server returned 503 (model load failure)")
        raise

    assert isinstance(result, dict)
    assert len(result["title"]) > 0

    print("\n=== PIPELINE: multilingual_pretraining (7.9MB PDF) ===")
    print(f"Extracted: {len(extracted)} chars → Trimmed to: {len(conversation_text)} chars")
    print(f"Title: {result['title']}")
    print(f"Summary: {result['summary']}")
    print(f"Key Points ({len(result['key_points'])}):")
    for kp in result["key_points"]:
        print(f"  - {kp}")
    print(f"Entities: {result['entities']}")
    print(f"Topics: {result['topics']}")


@pytest.mark.asyncio
async def test_pipeline_equity_slip_to_llm_summary():
    """Parse equity investment slip → LLM summary (non-academic document)."""
    if not await _inference_available():
        pytest.skip(f"aether-inference not available at {_get_inference_url()}")

    f = SAMPLE_DIR / "equity_investment_slip-1.pdf"
    if not f.exists():
        pytest.skip(f"File not found: {f}")

    # Stage 1: Extract
    util = DocumentUtility()
    extracted = util.extract_context(f)
    assert extracted is not None

    # Stage 2: Summarize via LLM
    svc = _make_summary_service()
    import httpx
    try:
        result = await svc._call_llm_for_summary(extracted, "executive", message_count=1)
    except httpx.HTTPError as e:
        if "503" in str(e):
            pytest.skip("Inference server returned 503 (model load failure)")
        raise

    assert isinstance(result, dict)

    print("\n=== PIPELINE: equity_investment_slip (122KB PDF) ===")
    print(f"Extracted: {len(extracted)} chars")
    print(f"Title: {result['title']}")
    print(f"Summary: {result['summary']}")
    print(f"Key Points ({len(result['key_points'])}):")
    for kp in result["key_points"]:
        print(f"  - {kp}")
    print(f"Entities: {result['entities']}")
    print(f"Topics: {result['topics']}")


@pytest.mark.asyncio
async def test_pipeline_markdown_to_llm_summary():
    """Parse markdown file → LLM summary."""
    if not await _inference_available():
        pytest.skip(f"aether-inference not available at {_get_inference_url()}")

    f = SAMPLE_DIR / "breaking_ai_news.md"
    if not f.exists():
        pytest.skip(f"File not found: {f}")

    util = DocumentUtility()
    extracted = util.extract_context(f)
    assert extracted is not None and len(extracted) > 50

    svc = _make_summary_service()
    import httpx
    try:
        result = await svc._call_llm_for_summary(extracted, "brief", message_count=1)
    except httpx.HTTPError as e:
        if "503" in str(e):
            pytest.skip("Inference server returned 503 (model load failure)")
        raise

    assert isinstance(result, dict)
    assert len(result["title"]) > 0

    print("\n=== PIPELINE: breaking_ai_news.md ===")
    print(f"Extracted: {len(extracted)} chars")
    print(f"Title: {result['title']}")
    print(f"Summary: {result['summary']}")
    print(f"Key Points: {result['key_points']}")
    print(f"Topics: {result['topics']}")
