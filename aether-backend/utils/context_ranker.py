"""
Query-Aware Context Ranker

Ranks and selects text chunks or structured results against a user query,
fitting within a character budget. Designed for LLM context preparation
where query relevance and diversity both matter.

Separate from DocumentUtility by design:
- DocumentUtility: document-centric extractive summarization for indexing (no query).
- ContextRanker:   query-centric ranking + MMR diversity for LLM context fitting.

Pipeline:
1. TF-IDF vectorization of chunks + query
2. Query-relevance scoring (chunk × query cosine similarity)
3. MMR selection (Maximal Marginal Relevance — balance relevance vs. diversity)
4. Budget-aware cutoff (character limit)
5. Document-order reassembly with gap markers

@.architecture
Incoming: api/v1/endpoints/utils.py, any internal service --- {text/chunks + query + budget}
Processing: TF-IDF vectorize → query-score → MMR select → budget fit --- {JOB_RANK, JOB_SELECT}
Outgoing: Caller --- {ranked/selected text or results within budget}
"""

import logging
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer

logger = logging.getLogger(__name__)


class ContextRanker:
    """
    Query-aware ranking and budget-fitting for LLM context windows.

    Usage:
        ranker = ContextRanker()

        # Rank raw text
        result = ranker.rank_text(text, query="what is attention?", budget_chars=40000)

        # Rank structured results
        ranked = ranker.rank_results(results, query="attention mechanism", budget_chars=40000)
    """

    def __init__(
        self,
        chunk_size: int = 800,
        chunk_overlap: int = 150,
        mmr_lambda: float = 0.7,  # 0=pure diversity, 1=pure relevance
    ):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.mmr_lambda = mmr_lambda

    # ==========================================================================
    # Public API: Text Ranking
    # ==========================================================================

    def rank_text(
        self,
        text: str,
        query: Optional[str] = None,
        budget_chars: int = 40000,
        max_chunks: int = 50,
    ) -> Dict[str, Any]:
        """
        Chunk text, rank by query relevance (or centrality if no query),
        select with MMR diversity, fit to budget.

        Returns dict with: text, chunks_total, chunks_selected,
        original_chars, result_chars, processing_ms
        """
        start = time.time()
        original_chars = len(text)

        # Short-circuit: already within budget
        if original_chars <= budget_chars:
            return self._text_result(
                text, 1, 1, original_chars, original_chars, start
            )

        chunks = self._chunk_text(text)

        if not chunks or len(chunks) <= 3:
            return self._text_result(
                text, len(chunks) or 1, len(chunks) or 1,
                original_chars, original_chars, start
            )

        # Vectorize
        try:
            all_texts = chunks + ([query] if query else [])
            vectorizer = TfidfVectorizer(
                stop_words='english',
                max_features=10000,
                sublinear_tf=True,
            )
            tfidf_matrix = vectorizer.fit_transform(all_texts)

            if query:
                chunk_matrix = tfidf_matrix[:-1]
                query_vec = tfidf_matrix[-1]
            else:
                chunk_matrix = tfidf_matrix
                query_vec = None
        except ValueError:
            # Empty vocabulary — return head truncation
            truncated = text[:budget_chars]
            return self._text_result(
                truncated, len(chunks), 1,
                original_chars, len(truncated), start
            )

        # Score
        if query_vec is not None:
            # Query-aware: cosine similarity to query
            scores = np.asarray(chunk_matrix.dot(query_vec.T).todense()).flatten()
        else:
            # No query: centroid similarity (same as DocumentUtility)
            centroid = np.asarray(chunk_matrix.mean(axis=0))
            scores = np.asarray(chunk_matrix.dot(centroid.T)).flatten()

        # MMR selection with budget
        selected_indices = self._mmr_select(
            chunk_matrix, scores, budget_chars, max_chunks, chunks
        )

        # Reassemble in document order with gap markers
        result_text = self._reassemble(chunks, selected_indices)

        return self._text_result(
            result_text, len(chunks), len(selected_indices),
            original_chars, len(result_text), start
        )

    # ==========================================================================
    # Public API: Structured Results Ranking
    # ==========================================================================

    def rank_results(
        self,
        results: List[Dict[str, Any]],
        query: str,
        budget_chars: int = 40000,
        content_field: str = "content",
        title_field: str = "title",
    ) -> Dict[str, Any]:
        """
        Rank structured search results by query relevance using TF-IDF + MMR,
        select within budget.

        Returns dict with: results, total_input, total_selected,
        original_chars, result_chars, processing_ms
        """
        start = time.time()
        total_input = len(results)

        if total_input == 0:
            return self._results_result([], 0, 0, 0, 0, start)

        contents = [str(r.get(content_field, "")) for r in results]
        titles = [str(r.get(title_field, "")) for r in results]
        total_chars = sum(len(c) for c in contents)

        # Short-circuit
        if total_chars <= budget_chars:
            return self._results_result(
                results, total_input, total_input,
                total_chars, total_chars, start
            )

        # Vectorize: content+title for each result, plus query
        combined = [f"{t} {t} {c}" for t, c in zip(titles, contents)]  # title weighted 2x
        all_texts = combined + [query]

        try:
            vectorizer = TfidfVectorizer(
                stop_words='english',
                max_features=10000,
                sublinear_tf=True,
            )
            tfidf_matrix = vectorizer.fit_transform(all_texts)
            result_matrix = tfidf_matrix[:-1]
            query_vec = tfidf_matrix[-1]
        except ValueError:
            # Fallback: first N that fit
            selected, used = self._budget_select_linear(
                results, contents, budget_chars
            )
            return self._results_result(
                selected, total_input, len(selected),
                total_chars, used, start
            )

        # Query relevance scores
        scores = np.asarray(result_matrix.dot(query_vec.T).todense()).flatten()

        # Position decay: earlier search results get a small boost
        # (search engines already did relevance sorting)
        position_boost = np.array([1.0 / (1.0 + i * 0.03) for i in range(total_input)])
        scores = 0.85 * scores + 0.15 * position_boost

        # MMR selection with budget
        selected_indices = self._mmr_select(
            result_matrix, scores, budget_chars, total_input, contents
        )

        # Re-sort by original position (preserve search engine ordering)
        selected_indices = sorted(selected_indices)
        selected_results = [results[i] for i in selected_indices]
        used_chars = sum(len(contents[i]) for i in selected_indices)

        return self._results_result(
            selected_results, total_input, len(selected_results),
            total_chars, used_chars, start
        )

    # ==========================================================================
    # Core: MMR Selection
    # ==========================================================================

    def _mmr_select(
        self,
        tfidf_matrix,
        relevance_scores: np.ndarray,
        budget_chars: int,
        max_items: int,
        texts: List[str],
    ) -> List[int]:
        """
        Maximal Marginal Relevance selection.

        At each step, picks the item that maximizes:
            MMR(i) = λ * Relevance(i) - (1-λ) * max_j∈S Similarity(i, j)

        Stops when budget_chars or max_items is reached.
        """
        n = len(texts)
        if n == 0:
            return []

        # Normalize relevance to [0, 1]
        rel_min, rel_max = relevance_scores.min(), relevance_scores.max()
        if rel_max > rel_min:
            norm_rel = (relevance_scores - rel_min) / (rel_max - rel_min)
        else:
            norm_rel = np.ones(n)

        # Precompute pairwise similarity (sparse dot product for efficiency)
        # For large N (>500), compute on-demand instead
        precomputed_sim = None
        if n <= 500:
            precomputed_sim = (tfidf_matrix * tfidf_matrix.T).toarray()

        selected: List[int] = []
        used_chars = 0
        remaining = set(range(n))

        lam = self.mmr_lambda

        while remaining and len(selected) < max_items:
            best_idx = -1
            best_mmr = -float('inf')

            for idx in remaining:
                item_chars = len(texts[idx])

                # Skip if adding this item exceeds budget (unless nothing selected yet)
                if selected and used_chars + item_chars > budget_chars:
                    continue

                # Relevance component
                rel = norm_rel[idx]

                # Diversity component: max similarity to already-selected items
                if selected:
                    if precomputed_sim is not None:
                        max_sim = max(precomputed_sim[idx][j] for j in selected)
                    else:
                        vec_i = tfidf_matrix[idx]
                        max_sim = max(
                            float((vec_i * tfidf_matrix[j].T).toarray()[0, 0])
                            for j in selected
                        )
                else:
                    max_sim = 0.0

                mmr = lam * rel - (1 - lam) * max_sim

                if mmr > best_mmr:
                    best_mmr = mmr
                    best_idx = idx

            if best_idx == -1:
                break  # Nothing fits budget

            selected.append(best_idx)
            used_chars += len(texts[best_idx])
            remaining.discard(best_idx)

            # Early exit if budget filled
            if used_chars >= budget_chars:
                break

        return selected

    # ==========================================================================
    # Chunking (lightweight, no quality gates — those belong to DocumentUtility)
    # ==========================================================================

    def _chunk_text(self, text: str) -> List[str]:
        """
        Split text into overlapping chunks by newlines/paragraphs first,
        then by character limit. No quality filtering — preserves all content
        including code, lists, URLs, structured data.
        """
        # Split on paragraph boundaries (double newline or section breaks)
        paragraphs = [p.strip() for p in text.split('\n\n') if p.strip()]

        # If no paragraph structure, split on single newlines
        if len(paragraphs) <= 1:
            paragraphs = [p.strip() for p in text.split('\n') if p.strip()]

        chunks: List[str] = []
        current: List[str] = []
        current_len = 0

        for para in paragraphs:
            para_len = len(para)

            if current_len + para_len > self.chunk_size and current:
                chunks.append('\n'.join(current))

                # Overlap: keep last paragraph(s)
                overlap_parts: List[str] = []
                overlap_len = 0
                for p in reversed(current):
                    if overlap_len + len(p) < self.chunk_overlap:
                        overlap_parts.insert(0, p)
                        overlap_len += len(p)
                    else:
                        break
                current = overlap_parts
                current_len = overlap_len

            # Handle single paragraphs exceeding chunk_size
            if para_len > self.chunk_size and not current:
                # Hard split at chunk_size boundaries
                for i in range(0, para_len, self.chunk_size - self.chunk_overlap):
                    chunk_slice = para[i:i + self.chunk_size]
                    if chunk_slice.strip():
                        chunks.append(chunk_slice)
                continue

            current.append(para)
            current_len += para_len

        if current:
            chunks.append('\n'.join(current))

        return chunks

    # ==========================================================================
    # Assembly
    # ==========================================================================

    def _reassemble(self, chunks: List[str], selected_indices: List[int]) -> str:
        """Reassemble selected chunks in document order with gap markers."""
        ordered = sorted(selected_indices)
        parts: List[str] = []
        last_idx = -1

        for idx in ordered:
            if last_idx != -1 and idx > last_idx + 1:
                parts.append("\n... [section omitted] ...\n")
            parts.append(chunks[idx])
            last_idx = idx

        return "\n".join(parts)

    # ==========================================================================
    # Fallback helpers
    # ==========================================================================

    def _budget_select_linear(
        self,
        results: List[Dict],
        contents: List[str],
        budget_chars: int,
    ) -> Tuple[List[Dict], int]:
        """Fallback: select first N results that fit budget."""
        selected: List[Dict] = []
        used = 0
        for r, c in zip(results, contents):
            if used + len(c) > budget_chars and selected:
                break
            selected.append(r)
            used += len(c)
        return selected, used

    # ==========================================================================
    # Result formatting
    # ==========================================================================

    def _text_result(
        self, text: str, total: int, selected: int,
        orig: int, result: int, start: float,
    ) -> Dict[str, Any]:
        elapsed = int((time.time() - start) * 1000)
        logger.info(
            f"ContextRanker text: {total} -> {selected} chunks, "
            f"{orig} -> {result} chars, {elapsed}ms"
        )
        return {
            "text": text,
            "chunks_total": total,
            "chunks_selected": selected,
            "original_chars": orig,
            "result_chars": result,
            "processing_ms": elapsed,
        }

    def _results_result(
        self, results: List, total: int, selected: int,
        orig: int, result: int, start: float,
    ) -> Dict[str, Any]:
        elapsed = int((time.time() - start) * 1000)
        logger.info(
            f"ContextRanker results: {total} -> {selected}, "
            f"{orig} -> {result} chars, {elapsed}ms"
        )
        return {
            "results": results,
            "total_input": total,
            "total_selected": selected,
            "original_chars": orig,
            "result_chars": result,
            "processing_ms": elapsed,
        }
