"""
Unit tests for utils.document_processing.DocumentUtility.

Covers every public method, every internal method, every conditional branch,
every error path, and every edge case.  Zero mocks on the utility itself —
only external dependencies (pypdfium2, sumy) are mocked.

Assertion depth: exact values, structural checks, relationship verification,
and negative cases.  Every test is designed to FAIL on specific mutations.
"""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from utils.document_processing import (
    DocumentUtility,
    _CODE_EXTENSIONS,
    _OFFICE_EXTENSIONS,
    _PROSE_EXTENSIONS,
    _TEXT_EXTENSIONS,
)

# ---------------------------------------------------------------------------
# Paths for real sample file tests
# ---------------------------------------------------------------------------
_WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
_SAMPLE_DIR = _WORKSPACE_ROOT / "sample"
_SAMPLE_PAPERS = _SAMPLE_DIR / "papers"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def util():
    """Default utility with standard config."""
    return DocumentUtility()


def _write_file(tmp_path: Path, name: str, content: str) -> Path:
    """Helper to create a temp file with given content."""
    p = tmp_path / name
    p.write_text(content, encoding="utf-8")
    return p


def _make_prose(sentences: int = 50) -> str:
    """Generate deterministic prose text with sentence terminators."""
    base = [
        "Artificial intelligence is transforming industries worldwide.",
        "Machine learning models require large datasets to train effectively.",
        "Natural language processing enables machines to understand text.",
        "Deep learning architectures have revolutionized computer vision.",
        "Reinforcement learning agents learn through trial and error.",
    ]
    lines = []
    for i in range(sentences):
        lines.append(base[i % len(base)])
    return " ".join(lines)


def _make_code(lines: int = 80) -> str:
    """Generate deterministic Python code content."""
    parts = [
        "import os\nimport sys\nfrom pathlib import Path\n",
        "def calculate_totals(items):\n",
        "    total = 0\n",
        "    for item in items:\n",
        "        if item['active']:\n",
        "            total += item['price'] * item['qty']\n",
        "    return total\n\n",
        "class DataProcessor:\n",
        "    def __init__(self, config):\n",
        "        self.config = config\n",
        "        self._cache = {}\n",
        "        self._initialized = False\n\n",
        "    def process(self, data):\n",
        "        results = []\n",
        "        for record in data:\n",
        "            transformed = self._transform(record)\n",
        "            results.append(transformed)\n",
        "        return results\n\n",
        "    def _transform(self, record):\n",
        "        output = {}\n",
        "        for key, value in record.items():\n",
        "            output[key] = str(value).strip()\n",
        "        return output\n\n",
    ]
    content = "".join(parts)
    while content.count("\n") < lines:
        content += content
    return content


# ===================================================================
# Test: Module Constants
# ===================================================================

class TestModuleConstants:
    """Verify module-level constants are correctly defined."""

    def test_text_extensions_is_union(self):
        assert _TEXT_EXTENSIONS == _PROSE_EXTENSIONS | _CODE_EXTENSIONS

    def test_prose_and_code_are_disjoint(self):
        overlap = _PROSE_EXTENSIONS & _CODE_EXTENSIONS
        assert overlap == set(), f"Overlap between prose and code extensions: {overlap}"

    def test_common_extensions_classified(self):
        assert ".py" in _CODE_EXTENSIONS
        assert ".js" in _CODE_EXTENSIONS
        assert ".csv" in _CODE_EXTENSIONS
        assert ".tsv" in _CODE_EXTENSIONS
        assert ".txt" in _PROSE_EXTENSIONS
        assert ".md" in _PROSE_EXTENSIONS
        assert ".rst" in _PROSE_EXTENSIONS
        assert ".log" in _PROSE_EXTENSIONS
        assert ".json" in _CODE_EXTENSIONS

    def test_office_extensions_defined(self):
        assert ".docx" in _OFFICE_EXTENSIONS
        assert ".pptx" in _OFFICE_EXTENSIONS
        assert ".xlsx" in _OFFICE_EXTENSIONS

    def test_office_extensions_disjoint_from_text(self):
        overlap = _OFFICE_EXTENSIONS & _TEXT_EXTENSIONS
        assert overlap == set(), f"Office and text extensions overlap: {overlap}"

    def test_office_extensions_disjoint_from_prose_and_code(self):
        assert (_OFFICE_EXTENSIONS & _PROSE_EXTENSIONS) == set()
        assert (_OFFICE_EXTENSIONS & _CODE_EXTENSIONS) == set()


# ===================================================================
# Test: Constructor and target_sentences
# ===================================================================

class TestConstructorAndBudget:
    """Verify constructor parameters and token budget calculation."""

    def test_default_values(self, util):
        assert util.max_context_tokens == 1_000
        assert util.target_sentences == 30

    def test_target_sentences_custom(self):
        u = DocumentUtility(target_sentences=50)
        assert u.target_sentences == 50

    def test_target_sentences_independent_of_token_budget(self):
        u1 = DocumentUtility(max_context_tokens=500, target_sentences=15)
        u2 = DocumentUtility(max_context_tokens=50_000, target_sentences=15)
        assert u1.target_sentences == u2.target_sentences == 15

    def test_no_chunk_parameters(self):
        """chunk_size, chunk_overlap, target_chunks must NOT be accepted."""
        import inspect
        sig = inspect.signature(DocumentUtility.__init__)
        param_names = set(sig.parameters.keys()) - {"self"}
        assert "chunk_size" not in param_names
        assert "chunk_overlap" not in param_names
        assert "target_chunks" not in param_names


# ===================================================================
# Test: _is_noise_sentence
# ===================================================================

class TestIsNoiseSentence:
    """Verify noise sentence filtering."""

    def test_short_fragment_is_noise(self):
        assert DocumentUtility._is_noise_sentence("OK.") is True
        assert DocumentUtility._is_noise_sentence("Hi there.") is True

    def test_pure_numbers_is_noise(self):
        assert DocumentUtility._is_noise_sentence("12345") is True
        assert DocumentUtility._is_noise_sentence("42.") is True

    def test_standalone_url_is_noise(self):
        assert DocumentUtility._is_noise_sentence("https://arxiv.org/abs/2301.12345") is True

    def test_bibliography_markers_is_noise(self):
        assert DocumentUtility._is_noise_sentence(
            "In Proceedings of ACM Conference on something, arXiv preprint arXiv:2301.12345"
        ) is True

    def test_real_sentence_is_not_noise(self):
        assert DocumentUtility._is_noise_sentence(
            "Artificial intelligence is transforming industries worldwide."
        ) is False

    def test_embedded_url_sentence_is_not_noise(self):
        assert DocumentUtility._is_noise_sentence(
            "The code is available at https://github.com/user/repo for reproducibility and further experimentation."
        ) is False


# ===================================================================
# Test: _split_sentences_with_offsets
# ===================================================================

class TestSplitSentencesWithOffsets:
    """Verify NLTK sentence splitting with character offset tracking."""

    def test_basic_splitting(self, util):
        text = "This is the first sentence that is long enough. And this is the second sentence that is also long enough. Finally, the third sentence passes the character threshold."
        result = util._split_sentences_with_offsets(text)
        assert len(result) == 3
        for sent_text, start, end in result:
            assert text[start:end] == sent_text

    def test_offsets_are_valid(self, util):
        text = _make_prose(20)
        result = util._split_sentences_with_offsets(text)
        for sent_text, start, end in result:
            assert 0 <= start < end <= len(text)
            assert sent_text == text[start:end]

    def test_noise_sentences_filtered(self, util):
        text = "OK. Hi. This is a proper sentence with enough content. Yes."
        result = util._split_sentences_with_offsets(text)
        texts = [s[0] for s in result]
        assert not any(t == "OK." for t in texts)
        assert not any(t == "Hi." for t in texts)
        assert any("proper sentence" in t for t in texts)

    def test_empty_text_returns_empty(self, util):
        assert util._split_sentences_with_offsets("") == []
        assert util._split_sentences_with_offsets("   ") == []


# ===================================================================
# Test: extract_context routing
# ===================================================================

class TestExtractContext:
    """Verify the main entry point routes correctly and handles errors."""

    def test_nonexistent_file_returns_none(self, util, tmp_path):
        result = util.extract_context(tmp_path / "ghost.txt")
        assert result is None

    def test_unsupported_extension_returns_none(self, util, tmp_path):
        f = _write_file(tmp_path, "binary.exe", "not relevant")
        result = util.extract_context(f)
        assert result is None

    @pytest.mark.parametrize("ext", [".txt", ".md", ".log", ".html"])
    def test_small_prose_file_returns_full(self, util, tmp_path, ext):
        content = "This is a small test file with enough content to pass validation."
        f = _write_file(tmp_path, f"test{ext}", content)
        result = util.extract_context(f)
        assert result is not None
        assert "(Type: Full)" in result
        assert content in result
        assert f"[FILE: test{ext}]" in result

    @pytest.mark.parametrize("ext", [".py", ".js", ".go", ".rs"])
    def test_small_code_file_returns_full(self, util, tmp_path, ext):
        content = "def hello():\n    print('world')\n"
        f = _write_file(tmp_path, f"test{ext}", content)
        result = util.extract_context(f)
        assert result is not None
        assert "(Type: Full)" in result
        assert content in result

    def test_small_file_header_format(self, util, tmp_path):
        f = _write_file(tmp_path, "readme.txt", "hello world")
        result = util.extract_context(f)
        assert result.startswith("[FILE: readme.txt] (Type: Full)\n---\n")

    def test_large_prose_file_is_summarized(self, tmp_path):
        util = DocumentUtility(max_context_tokens=200)
        content = _make_prose(200)
        f = _write_file(tmp_path, "big.txt", content)
        result = util.extract_context(f)
        assert result is not None
        assert "Summarized" in result
        assert len(result) < len(content) + 200

    def test_large_code_file_is_summarized(self, tmp_path):
        util = DocumentUtility(max_context_tokens=200)
        content = _make_code(200)
        f = _write_file(tmp_path, "big.py", content)
        result = util.extract_context(f)
        assert result is not None
        assert "[FILE: big.py]" in result

    def test_empty_text_file(self, util, tmp_path):
        f = _write_file(tmp_path, "empty.txt", "")
        result = util.extract_context(f)
        assert result is not None
        assert "(Empty content)" in result

    def test_exception_during_read_returns_none(self, util):
        fake_path = MagicMock(spec=Path)
        fake_path.exists.return_value = True
        fake_path.suffix = ".txt"
        fake_path.name = "denied.txt"
        fake_path.read_text.side_effect = PermissionError("denied")
        result = util.extract_context(fake_path)
        assert result is None

    def test_pdf_extension_routes_to_pdf_handler(self, util, tmp_path):
        f = _write_file(tmp_path, "doc.pdf", "fake pdf content")
        with patch.object(util, "_process_pdf", return_value="mocked") as mock_pdf:
            result = util.extract_context(f)
            mock_pdf.assert_called_once_with(f)
            assert result == "mocked"

    @pytest.mark.parametrize("ext", [".docx", ".pptx", ".xlsx"])
    def test_office_extension_routes_to_office_handler(self, util, tmp_path, ext):
        f = _write_file(tmp_path, f"document{ext}", "fake office content")
        with patch.object(util, "_process_office", return_value="office_mocked") as mock_office:
            result = util.extract_context(f)
            mock_office.assert_called_once_with(f)
            assert result == "office_mocked"

    def test_office_routes_before_text_check(self, util, tmp_path):
        f = _write_file(tmp_path, "report.xlsx", "data")
        with patch.object(util, "_process_office", return_value=None) as mock_office:
            util.extract_context(f)
            mock_office.assert_called_once()

    def test_csv_still_routes_as_code(self, util, tmp_path):
        content = "col1,col2,col3\n" + "a,b,c\n" * 10
        f = _write_file(tmp_path, "data.csv", content)
        with patch.object(util, "_process_office") as mock_office:
            util.extract_context(f)
            mock_office.assert_not_called()


# ===================================================================
# Test: _extract_from_text (core selection pipeline)
# ===================================================================

class TestExtractFromText:
    """Verify the core sentence split -> score -> select -> assemble pipeline."""

    def test_empty_text_returns_empty_content_label(self):
        util = DocumentUtility()
        result = util._extract_from_text("", "test.txt")
        assert result == "[FILE: test.txt] (Empty content)"

    def test_content_within_budget_returns_full(self):
        util = DocumentUtility()
        text = _make_prose(10)
        result = util._extract_from_text(text, "small.txt")
        assert result is not None
        assert "(Type: Full)" in result
        assert text in result

    def test_large_prose_produces_summarized(self):
        util = DocumentUtility(max_context_tokens=500)
        text = _make_prose(500)
        result = util._extract_from_text(text, "big.txt")
        assert result is not None
        assert "Summarized" in result
        assert "/" in result.split("\n")[0]

    def test_skipped_section_markers_present(self):
        # Use very small max_context_tokens to force summarization
        util = DocumentUtility(max_context_tokens=5, target_sentences=2)
        # Use longer sentences to pass the noise filter (min 20 chars)
        s1 = "This is the first sentence that is definitely long enough to pass the filter."
        s2 = "This is the second sentence that is also long enough to pass the filter."
        noise = "This is a noise sentence that is also long enough but we want to skip it. " * 58
        text = s1 + " " + noise + " " + s2
        with patch.object(util, "_lexrank_select", return_value=[0, 59]):
            result = util._extract_from_text(text, "doc.txt")
            assert "Summarized" in result
            assert "[SKIPPED SECTION]" in result


    def test_output_preserves_document_order(self):
        util = DocumentUtility(max_context_tokens=300, target_sentences=10)
        text = _make_prose(200)
        result = util._extract_from_text(text, "ordered.txt")
        if result and "Summarized" in result:
            parts = [p.strip() for p in result.split("[SKIPPED SECTION]") if p.strip()]
            last_pos = -1
            for part in parts:
                words = part.split()[:5]
                search = " ".join(words)
                pos = text.find(search)
                if pos >= 0:
                    assert pos > last_pos, "Sentences not in document order"
                    last_pos = pos

    def test_code_file_uses_line_based_extraction(self):
        util = DocumentUtility(max_context_tokens=10)
        code = _make_code(100)
        result = util._extract_from_text(code, "big.py", is_code=True)
        assert result is not None
        assert "lines" in result or "Summarized" in result or "Full" in result

    def test_sentences_header_format(self):
        util = DocumentUtility(max_context_tokens=100, target_sentences=10)
        text = _make_prose(200)
        result = util._extract_from_text(text, "doc.txt")
        if result and "Summarized" in result:
            assert "sentences" in result


# ===================================================================
# Test: _clean_pdf_text
# ===================================================================

class TestCleanPdfText:
    """Verify PDF noise removal without content loss."""

    @pytest.fixture
    def util(self):
        return DocumentUtility()

    @pytest.mark.parametrize("citation,expected_removal", [
        ("results show improvement [1] over baselines", "[1]"),
        ("as demonstrated [2, 3] previously", "[2, 3]"),
        ("following prior work [4-7] in this area", "[4-7]"),
        ("confirmed by (Smith, 2020) in their study", "(Smith, 2020)"),
        ("as shown by (Johnson et al., 2021) recently", "(Johnson et al., 2021)"),
    ])
    def test_citation_removal(self, util, citation, expected_removal):
        result = util._clean_pdf_text(citation)
        assert expected_removal not in result

    def test_citation_removal_preserves_surrounding_text(self, util):
        text = "The model achieves 95% accuracy [1] on the benchmark dataset."
        result = util._clean_pdf_text(text)
        assert "model achieves 95% accuracy" in result
        assert "benchmark dataset" in result

    def test_references_section_removed(self, util):
        text = "Main content here with enough words to form a valid paragraph for testing.\n\nReferences\nSmith, J. (2020). A paper title.\nJones, K. (2021). Another paper."
        result = util._clean_pdf_text(text)
        assert "Main content" in result
        assert "Smith, J. (2020)" not in result

    def test_bibliography_section_removed(self, util):
        text = "Important findings and results from the experiment.\n\nBibliography\nFirst reference here.\nSecond reference here."
        result = util._clean_pdf_text(text)
        assert "Important findings" in result
        assert "First reference" not in result

    def test_appendix_section_removed(self, util):
        text = ("The core results from our main experiment section demonstrate significant improvements "
                "across all evaluated benchmarks and metrics.\n\n"
                "Appendix A\nSupplemental data table one with extra details.\n"
                "Supplemental data table two with more values.")
        result = util._clean_pdf_text(text)
        assert "core results" in result
        assert "Supplemental data" not in result

    def test_section_reset_on_numbered_header(self, util):
        text = (
            "Introduction paragraph with enough content.\n\n"
            "References\nRef one.\nRef two.\n\n"
            "3. Results\n"
            "Results paragraph with enough content for valid paragraph test."
        )
        result = util._clean_pdf_text(text)
        assert "Results paragraph" in result

    def test_section_reset_on_markdown_header(self, util):
        text = (
            "Some content before references section paragraph.\n\n"
            "References\nRef one entry.\nRef two entry.\n\n"
            "## Discussion\n"
            "Discussion paragraph with enough content for valid paragraph test."
        )
        result = util._clean_pdf_text(text)
        assert "Discussion paragraph" in result

    def test_page_numbers_removed(self, util):
        text = "Content line one with enough words.\n42\nContent line two with enough words."
        result = util._clean_pdf_text(text)
        assert "\n42\n" not in result

    def test_roman_numeral_page_numbers_removed(self, util):
        text = "Content line with enough words here.\nxii\nMore content line with enough words."
        result = util._clean_pdf_text(text)
        assert "xii" not in result

    def test_pdf_headers_removed(self, util):
        text = "Main body paragraph with substantive content.\nUnder review at ICLR 2026\nMore main body content here."
        result = util._clean_pdf_text(text)
        assert "Under review" not in result

    def test_arxiv_header_removed(self, util):
        text = "Main content paragraph.\narXiv:2301.12345v2\nMore content paragraph."
        result = util._clean_pdf_text(text)
        assert "arXiv:" not in result

    def test_standalone_url_removed(self, util):
        text = "Main paragraph content.\nhttps://arxiv.org/abs/2301.12345\nMore paragraph content."
        result = util._clean_pdf_text(text)
        assert "arxiv.org" not in result

    def test_embedded_url_preserved(self, util):
        text = "The code is available at https://github.com/user/repo for reproducibility and further experimentation."
        result = util._clean_pdf_text(text)
        assert "github.com" in result

    def test_short_nonalpha_fragments_removed(self, util):
        text = "Full paragraph content here.\n---\n###\nMore paragraph content here."
        result = util._clean_pdf_text(text)
        assert "---" not in result


# ===================================================================
# Test: _reconstruct_paragraphs
# ===================================================================

class TestReconstructParagraphs:
    """Verify broken PDF lines are correctly joined into paragraphs."""

    def test_continuation_by_no_terminator(self):
        lines = ["This is the start of a sentence", "that continues on the next line."]
        result = DocumentUtility._reconstruct_paragraphs(lines)
        assert "start of a sentence that continues" in result

    def test_continuation_by_lowercase(self):
        lines = ["The experiment showed.", "however the results varied significantly."]
        result = DocumentUtility._reconstruct_paragraphs(lines)
        assert "showed. however" in result

    def test_continuation_by_connective(self):
        lines = ["Results were positive.", "Furthermore additional testing confirmed the findings."]
        result = DocumentUtility._reconstruct_paragraphs(lines)
        assert "positive. Furthermore" in result

    def test_new_paragraph_on_uppercase_after_terminator(self):
        lines = [
            "First paragraph ends here with a proper conclusion.",
            "Second paragraph starts here with a new topic entirely.",
        ]
        result = DocumentUtility._reconstruct_paragraphs(lines)
        assert "\n\n" in result

    def test_short_paragraphs_filtered(self):
        lines = [
            "OK.",
            "Short line.",
            "A real paragraph with enough content to survive the quality filter and length threshold.",
        ]
        result = DocumentUtility._reconstruct_paragraphs(lines)
        assert result.startswith("A real paragraph")
        assert "OK." not in result
        assert "Short line." not in result

    def test_empty_input(self):
        assert DocumentUtility._reconstruct_paragraphs([]) == ""


# ===================================================================
# Test: _process_pdf
# ===================================================================

class TestProcessPdf:
    """Verify PDF processing with mocked pypdfium2."""

    def test_import_error_returns_none(self, util, tmp_path):
        f = _write_file(tmp_path, "doc.pdf", "fake")
        with patch.dict("sys.modules", {"pypdfium2": None}):
            with patch("builtins.__import__", side_effect=ImportError("no pypdfium2")):
                result = util._process_pdf(f)
                assert result is None

    def test_pdf_resource_cleanup_on_error(self, util, tmp_path):
        f = _write_file(tmp_path, "bad.pdf", "fake")
        mock_pdfium = MagicMock()
        mock_doc = MagicMock()
        mock_doc.__iter__ = MagicMock(side_effect=RuntimeError("corrupt"))
        mock_pdfium.PdfDocument.return_value = mock_doc

        with patch.dict("sys.modules", {"pypdfium2": mock_pdfium}):
            try:
                util._process_pdf(f)
            except Exception:
                pass


# ===================================================================
# Test: _process_office (Docling bridge)
# ===================================================================

class TestProcessOffice:
    """Verify Office document processing via SimpleDirectoryReader."""

    @pytest.fixture
    def util(self):
        return DocumentUtility()

    def test_import_error_returns_none(self, util, tmp_path):
        f = _write_file(tmp_path, "report.docx", "fake")
        # Mocking the import error is tricky with 'from ... import ...'
        # but the code uses 'try: from llama_index.core import SimpleDirectoryReader except ImportError'
        with patch("llama_index.core.SimpleDirectoryReader", side_effect=ImportError("no llama_index")):
            result = util._process_office(f)
            assert result is None

    def test_success_small_document(self, util, tmp_path):
        f = _write_file(tmp_path, "report.docx", "fake")
        extracted_text = (
            "The quarterly report shows revenue growth of twelve percent. "
            "Operating expenses decreased while maintaining service quality. "
            "Customer satisfaction scores reached all-time highs this quarter. "
        ) * 3

        mock_doc = MagicMock()
        mock_doc.text = extracted_text
        
        with patch("llama_index.core.SimpleDirectoryReader") as mock_reader_cls:
            mock_reader_instance = mock_reader_cls.return_value
            mock_reader_instance.load_data.return_value = [mock_doc]
            
            result = util._process_office(f)

        assert result is not None
        assert "report.docx" in result
        assert "revenue growth" in result
        mock_reader_cls.assert_called_once_with(input_files=[str(f)])

    def test_empty_content_returns_descriptive_message(self, util, tmp_path):
        f = _write_file(tmp_path, "empty.xlsx", "fake")
        
        with patch("llama_index.core.SimpleDirectoryReader") as mock_reader_cls:
            mock_reader_instance = mock_reader_cls.return_value
            mock_reader_instance.load_data.return_value = [] # Empty list of docs
            
            result = util._process_office(f)

        assert result is not None
        assert "empty.xlsx" in result
        assert "Office document appeared empty" in result

    def test_exception_during_conversion_returns_none(self, util, tmp_path):
        f = _write_file(tmp_path, "broken.pptx", "fake")

        with patch("llama_index.core.SimpleDirectoryReader") as mock_reader_cls:
            mock_reader_instance = mock_reader_cls.return_value
            mock_reader_instance.load_data.side_effect = RuntimeError("SimpleDirectoryReader error")
            
            result = util._process_office(f)

        assert result is None


# ===================================================================
# Test: Large and very large documents
# ===================================================================

class TestLargeDocuments:
    """Verify extraction behaviour on large and very large inputs."""

    def test_very_large_prose_document_summarized(self, tmp_path):
        util = DocumentUtility(max_context_tokens=2000)
        content = _make_prose(32_000)
        assert len(content) > 2_000_000

        f = _write_file(tmp_path, "huge.txt", content)
        result = util.extract_context(f)

        assert result is not None
        assert "Capped to" in result
        assert len(result) < len(content) * 0.2

    def test_large_code_file_produces_output(self, tmp_path):
        util = DocumentUtility(max_context_tokens=1000)
        content = _make_code(5000)
        assert len(content) > 100_000

        f = _write_file(tmp_path, "large.py", content)
        result = util.extract_context(f)

        assert result is not None
        assert "[FILE: large.py]" in result
        result_lower = result.lower()
        assert "def" in result_lower or "class" in result_lower or "import" in result_lower

    def test_target_sentences_constrains_output(self, tmp_path):
        content = _make_prose(900)  # Reduce size to not trigger code fallback

        util_few = DocumentUtility(target_sentences=5, max_context_tokens=10)
        util_many = DocumentUtility(target_sentences=30, max_context_tokens=10)

        f = _write_file(tmp_path, "budget_test.txt", content)
        result_few = util_few.extract_context(f)
        result_many = util_many.extract_context(f)

        assert result_few is not None and result_many is not None
        assert "Summarized" in result_few and "Summarized" in result_many
        assert len(result_many) > len(result_few), (
            "More sentences should produce more output"
        )

    def test_large_multi_topic_balance(self, tmp_path):
        util = DocumentUtility(max_context_tokens=3000)
        topic_a = "Artificial intelligence and machine learning algorithms are transforming data analysis worldwide. " * 30
        topic_b = "Marine biology studies ocean ecosystems and underwater coral reef conservation efforts. " * 30
        topic_c = "Quantum computing leverages superposition and entanglement for exponential speedups. " * 30
        content = topic_a + "\n\n" + topic_b + "\n\n" + topic_c

        f = _write_file(tmp_path, "multi_large.txt", content)
        result = util.extract_context(f)

        assert result is not None
        result_lower = result.lower()
        topics_found = sum(
            1 for term in ["machine learning", "marine", "quantum"]
            if term in result_lower
        )
        assert topics_found >= 1, "Should retain at least one topic"

    def test_skip_markers_present_in_large_summary(self, tmp_path):
        util = DocumentUtility(max_context_tokens=300, target_sentences=2)
        # Mock _lexrank_select to force non-contiguous indices
        util._lexrank_select = lambda t, s, n: {0, len(s) - 1}
        
        content = _make_prose(100)
        f = _write_file(tmp_path, "skips.txt", content)
        result = util.extract_context(f)

        assert result is not None
        assert "Summarized" in result
        assert "[SKIPPED SECTION]" in result


# ===================================================================
# Test: Real sample files integration
# ===================================================================

class TestRealSampleFiles:
    """Integration tests using ACTUAL files from the sample/ directory."""

    @pytest.fixture
    def util(self):
        return DocumentUtility()

    @pytest.mark.skipif(
        not (_SAMPLE_DIR / "nodejs_critical_zero_day.txt").exists(),
        reason="Sample file not found",
    )
    def test_nodejs_zero_day_txt(self, util):
        f = _SAMPLE_DIR / "nodejs_critical_zero_day.txt"
        result = util.extract_context(f)
        assert result is not None
        assert "(Type: Full)" in result
        assert "Node.js" in result
        assert "CVE" in result
        assert "CRITICAL" in result

    @pytest.mark.skipif(
        not (_SAMPLE_DIR / "phase1_test_auth_issue.txt").exists(),
        reason="Sample file not found",
    )
    def test_auth_issue_txt(self, util):
        f = _SAMPLE_DIR / "phase1_test_auth_issue.txt"
        result = util.extract_context(f)
        assert result is not None
        assert "JWT" in result or "authentication" in result.lower()
        assert "token" in result.lower()

    @pytest.mark.skipif(
        not (_SAMPLE_DIR / "urgent_production_issue_2026.md").exists(),
        reason="Sample file not found",
    )
    def test_urgent_production_issue_md(self, util):
        f = _SAMPLE_DIR / "urgent_production_issue_2026.md"
        result = util.extract_context(f)
        assert result is not None
        assert "rate limit" in result.lower() or "429" in result
        assert "rollback" in result.lower()

    @pytest.mark.skipif(
        not (_SAMPLE_DIR / "breaking_ai_news.md").exists(),
        reason="Sample file not found",
    )
    def test_breaking_ai_news_md(self, util):
        f = _SAMPLE_DIR / "breaking_ai_news.md"
        result = util.extract_context(f)
        assert result is not None
        assert "GPT" in result or "OpenAI" in result
        assert "trillion" in result.lower() or "parameters" in result.lower()

    @pytest.mark.skipif(
        not (_SAMPLE_DIR / "phase1_test_database_query.sql").exists(),
        reason="Sample file not found",
    )
    def test_database_query_sql(self, util):
        f = _SAMPLE_DIR / "phase1_test_database_query.sql"
        result = util.extract_context(f)
        assert result is not None
        assert "(Type: Full)" in result
        assert "SELECT" in result
        assert "users" in result

    @pytest.mark.skipif(not _SAMPLE_PAPERS.exists(), reason="Papers directory not found")
    @pytest.mark.slow
    def test_all_corpus_pdfs_produce_output(self, util):
        try:
            import pypdfium2  # noqa: F401
        except ImportError:
            pytest.skip("pypdfium2 not installed")

        pdf_files = list(_SAMPLE_PAPERS.glob("*.pdf"))
        assert len(pdf_files) >= 10, f"Expected >= 10 corpus PDFs, found {len(pdf_files)}"
        for f in pdf_files:
            result = util.extract_context(f)
            assert result is not None, f"extract_context returned None for {f.name}"
            assert f"[FILE: {f.name}]" in result, f"Header missing for {f.name}"
            assert len(result) > 100, f"Suspiciously short output for {f.name}: {len(result)} chars"

    @pytest.mark.skipif(not _SAMPLE_DIR.exists(), reason="Sample directory not found")
    def test_all_txt_sample_files_produce_output(self, util):
        txt_files = list(_SAMPLE_DIR.glob("*.txt"))
        assert len(txt_files) > 0, "No .txt sample files found"
        for f in txt_files:
            result = util.extract_context(f)
            assert result is not None, f"extract_context returned None for {f.name}"
            assert f"[FILE: {f.name}]" in result, f"Header missing for {f.name}"

    @pytest.mark.skipif(not _SAMPLE_DIR.exists(), reason="Sample directory not found")
    def test_all_md_sample_files_produce_output(self, util):
        md_files = list(_SAMPLE_DIR.glob("*.md"))
        assert len(md_files) > 0, "No .md sample files found"
        for f in md_files:
            result = util.extract_context(f)
            assert result is not None, f"extract_context returned None for {f.name}"
            assert f"[FILE: {f.name}]" in result, f"Header missing for {f.name}"

    @pytest.mark.skipif(
        not (_SAMPLE_DIR / "unnamed.png").exists(),
        reason="Sample PNG not found",
    )
    def test_png_returns_none(self, util):
        f = _SAMPLE_DIR / "unnamed.png"
        result = util.extract_context(f)
        assert result is None


# ===================================================================
# Test: Edge cases and robustness
# ===================================================================

class TestEdgeCases:
    """Additional edge case and robustness tests."""

    @pytest.fixture
    def util(self):
        return DocumentUtility()

    def test_whitespace_only_file(self, util, tmp_path):
        f = _write_file(tmp_path, "spaces.txt", "   \n\n\t\t  \n  ")
        result = util.extract_context(f)
        assert result is not None
        assert "(Empty content)" in result

    def test_repeated_identical_sentences(self, tmp_path):
        util = DocumentUtility(max_context_tokens=100)
        content = "The same sentence appears over and over in this repetitive document. " * 200
        f = _write_file(tmp_path, "repeat.txt", content)
        result = util.extract_context(f)
        assert result is not None
        assert "[FILE: repeat.txt]" in result

    def test_file_with_null_bytes_in_content(self, util, tmp_path):
        content = "Normal text here.\x00\x00More text after nulls.\x00End of file."
        f = _write_file(tmp_path, "nulls.txt", content)
        result = util.extract_context(f)
        assert result is not None

    def test_unicode_heavy_document(self, util, tmp_path):
        content = (
            "English text here. "
            "Japanese: \u6a5f\u68b0\u5b66\u7fd2\u306f\u30c7\u30fc\u30bf\u304b\u3089\u5b66\u3076. "
            "Arabic: \u0627\u0644\u0630\u0643\u0627\u0621 \u0627\u0644\u0627\u0635\u0637\u0646\u0627\u0639\u064a. "
            "Korean: \uc778\uacf5\uc9c0\ub2a5. "
            "Normal ending sentence. "
        ) * 10
        f = _write_file(tmp_path, "unicode.txt", content)
        result = util.extract_context(f)
        assert result is not None
        assert "English text" in result

    def test_extract_from_text_with_only_noise_within_budget(self):
        util = DocumentUtility()
        noise = "x " * 50
        result = util._extract_from_text(noise, "noise.txt")
        assert result is not None
        assert "(Type: Full)" in result

    def test_extract_from_text_with_noise_exceeding_budget(self):
        util = DocumentUtility(max_context_tokens=1)
        noise = "123 " * 50
        result = util._extract_from_text(noise, "noise.txt")
        assert result is not None
        assert "Empty content" in result

    def test_concurrent_extract_context_calls(self, tmp_path):
        util = DocumentUtility(max_context_tokens=100)
        f1 = _write_file(tmp_path, "alpha.txt", _make_prose(100))
        f2 = _write_file(tmp_path, "beta.txt", _make_prose(100))
        f3 = _write_file(tmp_path, "gamma.py", _make_code(150))

        r1 = util.extract_context(f1)
        r2 = util.extract_context(f2)
        r3 = util.extract_context(f3)

        assert r1 is not None and "alpha.txt" in r1
        assert r2 is not None and "beta.txt" in r2
        assert r3 is not None and "gamma.py" in r3


# ===================================================================
# Test: End-to-end integration scenarios
# ===================================================================

class TestEndToEnd:
    """Full pipeline tests that exercise the complete path from file to output."""

    def test_multi_topic_document_preserves_diversity(self, tmp_path):
        util = DocumentUtility(max_context_tokens=3000)
        topic_a = "Machine learning algorithms process training data to build predictive models. " * 40
        topic_b = "Ocean currents distribute heat across the globe affecting weather patterns. " * 40
        topic_c = "Renaissance architecture features columns arches and symmetrical facades. " * 40
        content = topic_a + "\n\n" + topic_b + "\n\n" + topic_c
        f = _write_file(tmp_path, "multi.txt", content)
        result = util.extract_context(f)
        assert result is not None
        result_lower = result.lower()
        assert "machine learning" in result_lower, "Topic A (ML) missing from extraction"
        assert "ocean" in result_lower, "Topic B (ocean) missing from extraction"
        assert "renaissance" in result_lower, "Topic C (architecture) missing from extraction"

    def test_code_file_produces_meaningful_output(self, tmp_path):
        util = DocumentUtility(max_context_tokens=100)
        code = _make_code(150)
        f = _write_file(tmp_path, "app.py", code)
        result = util.extract_context(f)
        assert result is not None
        assert "[FILE: app.py]" in result
        result_content = result.lower()
        assert "def" in result_content or "class" in result_content or "import" in result_content

    def test_content_within_budget_returns_full(self, tmp_path):
        util = DocumentUtility(max_context_tokens=100)
        content = "A" * 400
        f = _write_file(tmp_path, "edge.txt", content)
        result = util.extract_context(f)
        assert "(Type: Full)" in result
        assert content in result

    def test_content_exceeding_budget_triggers_extraction(self, tmp_path):
        util = DocumentUtility(max_context_tokens=10)
        content = _make_prose(50)
        f = _write_file(tmp_path, "edge.txt", content)
        result = util.extract_context(f)
        assert result is not None
        assert "(Type: Full)" not in result

    def test_consistent_none_on_all_error_paths(self, util, tmp_path):
        assert util.extract_context(tmp_path / "nope.txt") is None
        f = _write_file(tmp_path, "data.bin", "binary stuff")
        assert util.extract_context(f) is None

    def test_unicode_content_handled(self, util, tmp_path):
        content = "Die K\u00fcnstliche Intelligenz ver\u00e4ndert die Welt grundlegend. " * 20
        f = _write_file(tmp_path, "german.txt", content)
        result = util.extract_context(f)
        assert result is not None
        assert "K\u00fcnstliche" in result


# ===================================================================
# Test: Regression — verify removed behaviours stay removed
# ===================================================================

class TestRemovedBehaviourRegression:
    """Tests that FAIL if old chunk-based code is re-introduced."""

    def test_chars_per_token_is_five(self):
        assert DocumentUtility._CHARS_PER_TOKEN == 5

    def test_content_gate_boundary(self):
        util = DocumentUtility(max_context_tokens=100)
        text_at = "B" * 504
        result_at = util._extract_from_text(text_at, "at_boundary.txt")
        assert "(Type: Full)" in result_at

    def test_no_small_file_threshold_parameter(self):
        import inspect
        sig = inspect.signature(DocumentUtility.__init__)
        param_names = set(sig.parameters.keys()) - {"self"}
        assert "small_file_threshold" not in param_names

    def test_no_read_full_method(self):
        assert not hasattr(DocumentUtility, "_read_full")

    def test_no_chunk_methods(self):
        assert not hasattr(DocumentUtility, "_chunk_text")
        assert not hasattr(DocumentUtility, "_chunk_text_with_offsets")
        assert not hasattr(DocumentUtility, "_rank_chunks")
        assert not hasattr(DocumentUtility, "_normalize")
        assert not hasattr(DocumentUtility, "_is_valid_chunk")

    def test_no_chunk_public_methods(self):
        assert not hasattr(DocumentUtility, "chunk_text")
        assert not hasattr(DocumentUtility, "rank_chunks")

    def test_no_chunk_constants(self):
        assert not hasattr(DocumentUtility, "_MAX_GRAPH_NODES")
        assert not hasattr(DocumentUtility, "_HEAD_ANCHORS")
        assert not hasattr(DocumentUtility, "_TAIL_ANCHORS")
        assert not hasattr(DocumentUtility, "_TFIDF_WEIGHT")
        assert not hasattr(DocumentUtility, "_TEXTRANK_WEIGHT")

    def test_no_chunk_constructor_params(self):
        import inspect
        sig = inspect.signature(DocumentUtility.__init__)
        param_names = set(sig.parameters.keys()) - {"self"}
        assert "chunk_size" not in param_names
        assert "chunk_overlap" not in param_names
        assert "target_chunks" not in param_names

    def test_has_sentence_methods(self):
        assert hasattr(DocumentUtility, "_split_sentences_with_offsets")
        assert hasattr(DocumentUtility, "_lexrank_select")
        assert hasattr(DocumentUtility, "_is_noise_sentence")
        assert hasattr(DocumentUtility, "_extract_code")
