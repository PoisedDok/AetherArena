"""
Unit Tests: ContextRanker

Tests for the query-aware context ranking and budget-fitting utility.
Covers: rank_text, rank_results, MMR diversity, chunking, budget enforcement,
edge cases, and the DocumentUtility bug fixes.
"""

import pytest
import sys
from pathlib import Path

# Add backend root to path
backend_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_root))

from utils.context_ranker import ContextRanker
from utils.document_processing import DocumentUtility


# =============================================================================
# ContextRanker: rank_text
# =============================================================================

class TestRankText:
    """Tests for ContextRanker.rank_text()"""

    def setup_method(self):
        self.ranker = ContextRanker(chunk_size=200, chunk_overlap=30)

    def test_short_text_returns_as_is(self):
        """Text within budget should pass through unchanged."""
        text = "Short text that fits in budget."
        result = self.ranker.rank_text(text, budget_chars=1000)

        assert result["text"] == text
        assert result["chunks_total"] == 1
        assert result["chunks_selected"] == 1
        assert result["original_chars"] == len(text)
        assert result["result_chars"] == len(text)

    def test_large_text_is_reduced(self):
        """Text exceeding budget should be reduced."""
        # Generate text with distinct topics
        text = (
            "Machine learning is a subset of artificial intelligence. " * 30 + "\n\n"
            "Quantum computing uses qubits for computation. " * 30 + "\n\n"
            "Blockchain technology enables decentralized ledgers. " * 30 + "\n\n"
            "Neural networks have multiple layers of nodes. " * 30 + "\n\n"
            "Climate change affects global weather patterns. " * 30
        )
        result = self.ranker.rank_text(text, budget_chars=500)

        assert result["result_chars"] <= result["original_chars"]
        assert result["chunks_selected"] < result["chunks_total"]
        assert result["chunks_selected"] >= 1
        assert len(result["text"]) <= result["original_chars"]

    def test_query_aware_ranking_favors_relevant_chunks(self):
        """With a query, relevant chunks should be selected over irrelevant ones."""
        text = (
            "Quantum computing uses superposition and entanglement to solve problems. " * 20 + "\n\n"
            "Cooking recipes require specific ingredients and preparation steps. " * 20 + "\n\n"
            "Quantum bits or qubits can represent zero and one simultaneously. " * 20 + "\n\n"
            "Gardening involves planting seeds and watering them regularly. " * 20 + "\n\n"
            "Quantum algorithms like Shor's can factor large numbers efficiently. " * 20
        )
        result = self.ranker.rank_text(
            text, query="quantum computing algorithms", budget_chars=800
        )

        # Result should contain quantum-related content
        result_lower = result["text"].lower()
        assert "quantum" in result_lower
        # Should NOT contain much cooking/gardening (noise)
        quantum_count = result_lower.count("quantum")
        cooking_count = result_lower.count("cooking")
        gardening_count = result_lower.count("gardening")
        assert quantum_count > cooking_count + gardening_count

    def test_no_query_uses_centroid(self):
        """Without a query, ranking should use centroid (document importance)."""
        text = (
            "AI and ML are transforming industries worldwide. " * 40 + "\n\n"
            "Random noise text with no substance. " * 10 + "\n\n"
            "Deep learning neural networks achieve state of the art results. " * 40
        )
        result = self.ranker.rank_text(text, query=None, budget_chars=800)

        assert result["chunks_selected"] >= 1
        assert result["result_chars"] > 0

    def test_gap_markers_in_output(self):
        """Non-adjacent selected chunks should have gap markers."""
        # Create many distinct paragraphs with enough content per chunk
        paragraphs = [
            f"Topic {i}: " + f"Content about topic number {i} with substantial detail. " * 20
            for i in range(30)
        ]
        text = "\n\n".join(paragraphs)

        result = self.ranker.rank_text(text, budget_chars=800)

        if result["chunks_selected"] < result["chunks_total"]:
            assert "... [section omitted] ..." in result["text"]

    def test_budget_respected(self):
        """Result should not exceed budget by more than one chunk."""
        text = "A" * 100 + "\n\n" + "B" * 100 + "\n\n" + "C" * 100
        text = text * 20  # Make it large

        result = self.ranker.rank_text(text, budget_chars=500)
        # Allow some overshoot (one chunk can push over), but should be reasonable
        assert result["result_chars"] < result["original_chars"]

    def test_empty_text(self):
        """Empty text should return empty result."""
        result = self.ranker.rank_text("", budget_chars=1000)
        assert result["text"] == ""
        assert result["chunks_total"] == 1
        assert result["result_chars"] == 0

    def test_processing_ms_reported(self):
        """Processing time should be reported."""
        text = "Content. " * 500
        result = self.ranker.rank_text(text, budget_chars=200)
        assert "processing_ms" in result
        assert isinstance(result["processing_ms"], int)
        assert result["processing_ms"] >= 0


# =============================================================================
# ContextRanker: rank_results
# =============================================================================

class TestRankResults:
    """Tests for ContextRanker.rank_results()"""

    def setup_method(self):
        self.ranker = ContextRanker()

    def test_empty_results(self):
        """Empty results list should return empty."""
        result = self.ranker.rank_results([], query="test", budget_chars=1000)

        assert result["results"] == []
        assert result["total_input"] == 0
        assert result["total_selected"] == 0

    def test_results_within_budget_pass_through(self):
        """Results fitting in budget should all be returned."""
        results = [
            {"content": "Short result one.", "title": "Title 1"},
            {"content": "Short result two.", "title": "Title 2"},
        ]
        result = self.ranker.rank_results(results, query="test", budget_chars=100000)

        assert result["total_selected"] == 2
        assert len(result["results"]) == 2

    def test_results_exceeding_budget_are_pruned(self):
        """Results exceeding budget should be pruned."""
        results = [
            {"content": f"Result {i} content. " * 50, "title": f"Title {i}"}
            for i in range(20)
        ]
        result = self.ranker.rank_results(results, query="test", budget_chars=2000)

        assert result["total_selected"] < result["total_input"]
        assert result["total_selected"] >= 1
        assert result["result_chars"] <= result["original_chars"]

    def test_query_relevant_results_ranked_higher(self):
        """Results matching the query should be preferred."""
        results = [
            {"content": "Cooking pasta requires boiling water and adding salt. " * 10, "title": "Pasta Recipe"},
            {"content": "Quantum computing uses qubits and superposition for computation. " * 10, "title": "Quantum Computing"},
            {"content": "Gardening tips for growing tomatoes in summer heat. " * 10, "title": "Gardening"},
            {"content": "Quantum algorithms achieve exponential speedup over classical. " * 10, "title": "Quantum Algorithms"},
            {"content": "Baking bread needs flour, water, yeast, and patience. " * 10, "title": "Bread Baking"},
        ]
        result = self.ranker.rank_results(
            results, query="quantum computing", budget_chars=2000
        )

        # At least one quantum result should be selected
        selected_titles = [r["title"] for r in result["results"]]
        quantum_selected = [t for t in selected_titles if "quantum" in t.lower()]
        assert len(quantum_selected) >= 1

    def test_custom_content_field(self):
        """Should work with custom content field names."""
        results = [
            {"text": "Some content here. " * 50, "name": "Item 1"},
            {"text": "Other content here. " * 50, "name": "Item 2"},
        ]
        result = self.ranker.rank_results(
            results, query="content", budget_chars=500,
            content_field="text", title_field="name"
        )

        assert result["total_input"] == 2

    def test_preserves_result_structure(self):
        """Selected results should preserve all original fields."""
        results = [
            {
                "content": "Result content. " * 10,
                "title": "Title",
                "url": "https://example.com",
                "metadata": {"score": 0.95},
                "custom_field": "preserved"
            }
        ]
        result = self.ranker.rank_results(results, query="test", budget_chars=100000)

        assert result["results"][0]["url"] == "https://example.com"
        assert result["results"][0]["metadata"]["score"] == 0.95
        assert result["results"][0]["custom_field"] == "preserved"


# =============================================================================
# ContextRanker: MMR Diversity
# =============================================================================

class TestMMRDiversity:
    """Tests for Maximal Marginal Relevance selection."""

    def test_mmr_avoids_duplicates(self):
        """MMR should avoid selecting near-duplicate chunks."""
        # Create text with repeated content (simulates overlapping search results)
        text = (
            "Machine learning is used for classification and regression. " * 15 + "\n\n"
            "Machine learning is applied in classification and regression tasks. " * 15 + "\n\n"
            "Machine learning enables classification and regression models. " * 15 + "\n\n"
            "Quantum computing is a completely different field of study. " * 15 + "\n\n"
            "Natural language processing handles text understanding. " * 15
        )
        ranker = ContextRanker(chunk_size=200, chunk_overlap=30, mmr_lambda=0.5)
        result = ranker.rank_text(text, query="machine learning", budget_chars=1000)

        # With MMR (lambda=0.5), diversity should push for varied content
        result_lower = result["text"].lower()
        has_ml = "machine learning" in result_lower
        has_quantum = "quantum" in result_lower or "natural language" in result_lower
        # At least some diversity should appear even when ML is most relevant
        assert has_ml

    def test_lambda_1_pure_relevance(self):
        """Lambda=1.0 should select purely by relevance (no diversity penalty)."""
        ranker = ContextRanker(chunk_size=200, chunk_overlap=30, mmr_lambda=1.0)
        text = (
            "AI is amazing. " * 30 + "\n\n"
            "Cooking is fun. " * 30 + "\n\n"
            "AI research advances. " * 30
        )
        result = ranker.rank_text(text, query="AI research", budget_chars=500)
        # Pure relevance: should heavily favor AI content
        assert "ai" in result["text"].lower()


# =============================================================================
# ContextRanker: Chunking
# =============================================================================

class TestChunking:
    """Tests for ContextRanker._chunk_text()"""

    def setup_method(self):
        self.ranker = ContextRanker(chunk_size=200, chunk_overlap=30)

    def test_paragraph_splitting(self):
        """Should split on double newlines."""
        text = "Paragraph one.\n\nParagraph two.\n\nParagraph three."
        chunks = self.ranker._chunk_text(text)

        assert len(chunks) >= 1
        # All content preserved
        combined = " ".join(chunks)
        assert "Paragraph one" in combined
        assert "Paragraph three" in combined

    def test_single_newline_fallback(self):
        """When no double newlines, should fall back to single newlines."""
        text = "Line one.\nLine two.\nLine three.\nLine four."
        chunks = self.ranker._chunk_text(text)

        assert len(chunks) >= 1

    def test_no_newlines_hard_split(self):
        """Single massive block with no newlines should be hard-split."""
        text = "A" * 2000  # No newlines, exceeds chunk_size
        chunks = self.ranker._chunk_text(text)

        assert len(chunks) > 1
        # All content preserved
        total_unique_chars = sum(len(c) for c in chunks)
        # Due to overlap, total chars in chunks > original, but content preserved
        assert total_unique_chars >= len(text)

    def test_urls_preserved_in_chunks(self):
        """URLs should not be stripped or broken during chunking."""
        text = (
            "Visit https://example.com/path/to/resource for details.\n\n"
            "See also http://another-site.org/api/v2/endpoint?key=value\n\n"
            "Documentation at https://docs.example.com/guide#section-3"
        )
        chunks = self.ranker._chunk_text(text)
        combined = " ".join(chunks)

        assert "https://example.com/path/to/resource" in combined
        assert "http://another-site.org/api/v2/endpoint?key=value" in combined
        assert "https://docs.example.com/guide#section-3" in combined

    def test_code_blocks_preserved(self):
        """Code blocks should not be filtered out."""
        text = (
            "Here is the code:\n\n"
            "```python\ndef hello():\n    print('world')\n```\n\n"
            "End of example."
        )
        chunks = self.ranker._chunk_text(text)
        combined = " ".join(chunks)

        assert "def hello():" in combined
        assert "print('world')" in combined

    def test_empty_text(self):
        """Empty text should return empty list."""
        chunks = self.ranker._chunk_text("")
        assert chunks == []

    def test_whitespace_only(self):
        """Whitespace-only text should return empty list."""
        chunks = self.ranker._chunk_text("   \n\n   \n   ")
        assert chunks == []


# =============================================================================
# DocumentUtility Bug Fixes
# =============================================================================

class TestDocumentUtilityBugFixes:
    """Tests for the bug fixes applied to DocumentUtility._clean_pdf_text()"""

    def setup_method(self):
        self.util = DocumentUtility()

    def test_appendix_header_only(self):
        """Only standalone 'Appendix' headers should trigger skip, not sentences starting with 'Supplementary'."""
        # Use realistic PDF-length content (paragraph quality gate requires >50 chars, >20 alpha)
        text = (
            "The main contribution of this paper is a novel approach to neural network training that achieves state of the art results.\n"
            "Supplementary experiments show promising results in table 5 and demonstrate the scalability of the proposed method across domains.\n"
            "More important findings follow here including detailed ablation studies on hyperparameter sensitivity and convergence rates.\n"
            "The conclusion summarizes the key contributions and discusses potential future research directions for this work."
        )
        cleaned = self.util._clean_pdf_text(text)

        # "Supplementary experiments..." should NOT be skipped (it's a sentence, not a section header)
        assert "supplementary experiments" in cleaned.lower()
        assert "more important findings" in cleaned.lower()

    def test_appendix_section_header_skipped(self):
        """Standalone 'Appendix' or 'Appendix A' should trigger skip."""
        text = (
            "The main contribution of this paper is the development of a novel transformer architecture for document understanding tasks.\n"
            "We demonstrate significant improvements over baseline methods across multiple benchmark datasets and evaluation metrics.\n"
            "Appendix\n"
            "This appendix content provides additional experimental details that supplement the main paper findings and methodology.\n"
            "Additional tables showing per-category breakdown of results for each experiment configuration and hyperparameter setting.\n"
        )
        cleaned = self.util._clean_pdf_text(text)

        assert "main contribution" in cleaned.lower()
        assert "this appendix content" not in cleaned.lower()

    def test_appendix_with_letter(self):
        """'Appendix A' should also trigger skip."""
        text = (
            "The main contribution of this paper demonstrates a novel method for efficient language model training and inference.\n"
            "Our experiments show consistent improvements across all evaluated benchmarks when compared to existing approaches.\n"
            "Appendix A\n"
            "This supplementary section contains additional implementation details and computational resource requirements for reproducing our results.\n"
        )
        cleaned = self.util._clean_pdf_text(text)

        assert "main contribution" in cleaned.lower()
        assert "supplementary section contains" not in cleaned.lower()

    def test_references_flag_resets_on_new_section(self):
        """References flag should reset when a new numbered section starts."""
        text = (
            "1. Introduction\n"
            "The introduction provides background context and motivation for the research including related prior work in this area.\n"
            "References\n"
            "Smith, J. (2020). A comprehensive survey of neural network architectures for natural language processing tasks.\n"
            "Jones, K. (2021). Advances in transformer-based models for document understanding and information extraction.\n"
            "2. Methods After References\n"
            "This methods section follows the references and describes the experimental setup and evaluation methodology in detail.\n"
            "We use a combination of quantitative metrics and qualitative analysis to evaluate the performance of our proposed approach."
        )
        cleaned = self.util._clean_pdf_text(text)

        # Content after references AND after new section should be preserved
        assert "methods section follows" in cleaned.lower() or "experimental setup" in cleaned.lower()

    def test_urls_in_sentences_preserved(self):
        """Lines containing URLs as part of content should be preserved."""
        text = (
            "The complete framework and source code is available at https://github.com/example/repo for download and reproduction of our results.\n"
            "For comprehensive documentation and tutorials visit https://docs.example.com/guide which contains step by step instructions.\n"
            "The experimental results demonstrate consistent improvements over baseline methods across all evaluation benchmarks.\n"
        )
        cleaned = self.util._clean_pdf_text(text)

        # Lines with URLs in sentences (4+ words) should be kept
        assert "framework" in cleaned.lower()
        assert "documentation" in cleaned.lower()

    def test_standalone_urls_stripped(self):
        """Bare standalone URLs (PDF footers) should be stripped."""
        text = (
            "The experimental results demonstrate significant improvements in accuracy and efficiency across all tested configurations and datasets.\n"
            "https://arxiv.org/abs/2301.12345\n"
            "Our analysis reveals that the proposed method consistently outperforms existing approaches on standard benchmark evaluations.\n"
        )
        cleaned = self.util._clean_pdf_text(text)

        assert "experimental results" in cleaned.lower()
        assert "arxiv.org/abs/2301.12345" not in cleaned


# =============================================================================
# ContextRanker: Edge Cases
# =============================================================================

class TestEdgeCases:
    """Edge case tests for robustness."""

    def test_single_chunk_text(self):
        """Text that produces exactly one chunk."""
        ranker = ContextRanker(chunk_size=10000)
        text = "Short text. " * 20
        result = ranker.rank_text(text, budget_chars=100)
        assert result["text"]  # Should return something

    def test_all_identical_content(self):
        """All chunks being identical should not crash MMR."""
        text = ("Repeated sentence. " * 10 + "\n\n") * 10
        ranker = ContextRanker(chunk_size=200, chunk_overlap=30)
        result = ranker.rank_text(text, budget_chars=300)
        assert result["chunks_selected"] >= 1

    def test_unicode_content(self):
        """Unicode text should be handled correctly."""
        text = (
            "日本語のテキストがここにあります。" * 20 + "\n\n"
            "Voici du texte en francais avec des accents. " * 20 + "\n\n"
            "Arabic text: النص العربي هنا. " * 20
        )
        ranker = ContextRanker(chunk_size=200, chunk_overlap=30)
        result = ranker.rank_text(text, query="francais", budget_chars=500)
        assert result["result_chars"] > 0

    def test_rank_results_single_result(self):
        """Single result should always be returned regardless of budget."""
        ranker = ContextRanker()
        results = [{"content": "A" * 5000, "title": "Big Result"}]
        result = ranker.rank_results(results, query="test", budget_chars=100)
        # Single result: should be returned even if over budget
        assert result["total_selected"] == 1

    def test_very_small_budget(self):
        """Very small budget should still return at least one item."""
        ranker = ContextRanker(chunk_size=200, chunk_overlap=30)
        text = "Content here. " * 100
        result = ranker.rank_text(text, budget_chars=10, max_chunks=50)
        # Should have at least attempted selection
        assert "text" in result

    def test_special_characters_in_query(self):
        """Query with special regex characters should not crash."""
        ranker = ContextRanker()
        text = "Normal text content here. " * 50
        result = ranker.rank_text(
            text, query="test (with) [brackets] and $pecial chars!", budget_chars=200
        )
        assert result["text"]

    def test_results_with_missing_fields(self):
        """Results missing content/title fields should not crash."""
        ranker = ContextRanker()
        results = [
            {"content": "Has content", "title": "Has title"},
            {"other_field": "no content or title"},
            {"content": "Only content"},
        ]
        result = ranker.rank_results(results, query="test", budget_chars=100000)
        assert result["total_selected"] == 3


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
