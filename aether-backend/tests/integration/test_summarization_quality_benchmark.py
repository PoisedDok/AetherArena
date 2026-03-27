"""
Summarization Quality Benchmark: Non-LLM (DocumentUtility) vs LLM Strategies

Compares 4 approaches on real academic papers -- NO TRUNCATION:
  A. DocumentUtility extractive (sentence-level LexRank, zero LLM calls)
  B. LLM per-page: summarize each PDF page individually, then merge
  C. LLM sliding-window: overlapping text windows, each summarized, then merge
  D. LLM hierarchical: chunk → summarize → group → summarize → final

Metrics measured per strategy:
  - Key concept coverage (how many ground-truth terms appear)
  - Latency (wall clock seconds)
  - LLM calls count
  - Estimated input/output tokens

Requires aether-inference at settings.inference_url (default: http://127.0.0.1:7090/v1).

@.architecture
Incoming: pytest --- {test invocation}
Processing: 4 summarization strategies on real PDFs --- {extraction, LLM calls, scoring}
Outgoing: comparison table + assertions --- {pass/fail, printed report}
"""

import sys
import time
from pathlib import Path
from typing import List, Tuple
from dataclasses import dataclass, field

import httpx
import pytest

pytestmark = pytest.mark.skip(
    reason="Benchmark suite: run manually with `pytest tests/integration/test_summarization_quality_benchmark.py --timeout=600`"
)

BACKEND_ROOT = Path(__file__).resolve().parents[2]
SAMPLE_DIR = BACKEND_ROOT.parent / "sample"
PAPERS_DIR = SAMPLE_DIR / "papers"

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from utils.document_processing import DocumentUtility
from config.settings import get_settings, reload_settings


# =============================================================================
# Configuration (resolved from central config — no hardcoded provider URLs)
# =============================================================================

def _resolve_llm_config():
    """Resolve LLM URL and model from central config (aether-inference default)."""
    reload_settings()
    settings = get_settings()
    return settings.inference_url, settings.llm.model

LLM_URL, LLM_MODEL = _resolve_llm_config()
LLM_TIMEOUT = 300.0

# Sliding window params (chars)
WINDOW_SIZE = 6000
WINDOW_OVERLAP = 800

# Hierarchical params
HIER_CHUNK_SIZE = 4000
HIER_GROUP_SIZE = 5  # summaries per group in level 2

# Rough token estimate: 1 token ~ 4 chars
def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


# =============================================================================
# Ground Truth Key Concepts
# =============================================================================

# These are the concepts a good summary MUST capture from each paper.
# Scored as: count of concepts found (case-insensitive substring match).

GROUND_TRUTH = {
    "timeseries_bpe_2026.pdf": {
        "display_name": "Time Series BPE (1.6MB)",
        "concepts": [
            "byte pair encoding",
            "BPE",
            "motif",
            "tokeniz",          # tokenization, tokenizer, tokenizing
            "time series",
            "forecast",         # forecasting, forecast
            "compress",         # compression, compressed
            "vocabular",        # vocabulary
            "conditional decod", # conditional decoding, decoder
            "patch",            # patching, patch-based
            "transformer",
            "discrete",
            "pattern",
            "adaptive",
        ],
    },
    "multilingual_pretraining_2026.pdf": {
        "display_name": "Multilingual Pretraining (7.9MB)",
        "concepts": [
            "multilingual",
            "pretrain",         # pretraining, pretrained
            "curse of multilinguality",
            "english",
            "language transfer",
            "data mix",         # data mixture, data mixing
            "language model",
            "tokeniz",
            "curriculum",
            "cross-lingual",
            "low-resource",
            "scaling",
            "benchmark",
            "1B",               # model sizes mentioned
        ],
    },
}


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class StrategyResult:
    name: str
    output_text: str
    latency_s: float
    llm_calls: int
    input_tokens_est: int
    output_tokens_est: int
    concept_hits: int = 0
    concept_total: int = 0
    concepts_found: List[str] = field(default_factory=list)
    concepts_missed: List[str] = field(default_factory=list)


# =============================================================================
# LLM Call Helper
# =============================================================================

class LLMTracker:
    """Tracks LLM calls, tokens, and latency."""

    def __init__(self):
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0

    async def summarize_chunk(self, text: str, instruction: str, max_tokens: int = 600) -> str:
        """Single LLM call with tracking."""
        system_prompt = (
            "You are a precise academic paper summarization engine.\n"
            f"{instruction}\n"
            "Be concise but capture ALL key technical concepts, methods, and findings.\n"
            "Output plain text summary only. No JSON, no markdown fences."
        )
        self.calls += 1
        self.input_tokens += _estimate_tokens(system_prompt) + _estimate_tokens(text)

        async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
            resp = await client.post(
                f"{LLM_URL}/chat/completions",
                json={
                    "model": LLM_MODEL,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": text},
                    ],
                    "temperature": 0.3,
                    "max_tokens": max_tokens,
                },
            )
            if resp.status_code != 200:
                raise RuntimeError(f"LLM error {resp.status_code}: {resp.text[:200]}")

            content = resp.json()["choices"][0]["message"]["content"]
            self.output_tokens += _estimate_tokens(content)
            return content

    async def final_summary(self, combined_text: str, max_tokens: int = 1200) -> str:
        """Final merge/summary call."""
        return await self.summarize_chunk(
            combined_text,
            instruction=(
                "Below are partial summaries of sections from an academic paper.\n"
                "Synthesize them into ONE coherent, comprehensive summary.\n"
                "Capture: paper title/topic, core method, key results, main conclusions.\n"
                "Include all important technical terms and findings."
            ),
            max_tokens=max_tokens,
        )


# =============================================================================
# Scoring
# =============================================================================

def score_concepts(text: str, concepts: List[str]) -> Tuple[int, List[str], List[str]]:
    """Score how many ground-truth concepts appear in the text."""
    text_lower = text.lower()
    found = []
    missed = []
    for concept in concepts:
        if concept.lower() in text_lower:
            found.append(concept)
        else:
            missed.append(concept)
    return len(found), found, missed


# =============================================================================
# Strategy A: DocumentUtility Extractive (Non-LLM)
# =============================================================================

def run_strategy_extractive(file_path: Path) -> StrategyResult:
    """Pure extractive summarization via sentence-level LexRank. Zero LLM calls."""
    t0 = time.perf_counter()
    util = DocumentUtility()
    output = util.extract_context(file_path) or ""
    elapsed = time.perf_counter() - t0

    return StrategyResult(
        name="A. DocumentUtility (extractive, no LLM)",
        output_text=output,
        latency_s=elapsed,
        llm_calls=0,
        input_tokens_est=0,
        output_tokens_est=_estimate_tokens(output),
    )


# =============================================================================
# Strategy B: LLM Per-Page
# =============================================================================

async def run_strategy_per_page(file_path: Path) -> StrategyResult:
    """Summarize each PDF page individually, then merge all page summaries."""
    import pypdfium2 as pdfium

    t0 = time.perf_counter()
    tracker = LLMTracker()

    # Extract text per page
    pdf = pdfium.PdfDocument(str(file_path))
    pages = []
    for page in pdf:
        tp = page.get_textpage()
        text = tp.get_text_range()
        if text and text.strip():
            pages.append(text.strip())
        tp.close()
        page.close()
    pdf.close()

    # Summarize each page (skip tiny pages)
    page_summaries = []
    for i, page_text in enumerate(pages):
        if len(page_text) < 100:
            continue
        summary = await tracker.summarize_chunk(
            page_text,
            instruction=f"Summarize page {i+1}/{len(pages)} of this academic paper. Capture key methods, results, and technical terms.",
            max_tokens=300,
        )
        page_summaries.append(f"[Page {i+1}] {summary}")

    # Final merge
    combined = "\n\n".join(page_summaries)
    final = await tracker.final_summary(combined)

    elapsed = time.perf_counter() - t0
    return StrategyResult(
        name="B. LLM Per-Page",
        output_text=final,
        latency_s=elapsed,
        llm_calls=tracker.calls,
        input_tokens_est=tracker.input_tokens,
        output_tokens_est=tracker.output_tokens,
    )


# =============================================================================
# Strategy C: LLM Sliding Window
# =============================================================================

async def run_strategy_sliding_window(file_path: Path) -> StrategyResult:
    """Overlapping sliding windows over full cleaned text, each summarized, then merge."""
    t0 = time.perf_counter()
    tracker = LLMTracker()
    util = DocumentUtility()

    # Get cleaned full text
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(str(file_path))
    text_parts = []
    for page in pdf:
        tp = page.get_textpage()
        text_parts.append(tp.get_text_range())
        tp.close()
        page.close()
    pdf.close()
    full_text = util._clean_pdf_text("\n".join(text_parts))

    # Create overlapping windows
    windows = []
    pos = 0
    while pos < len(full_text):
        end = min(pos + WINDOW_SIZE, len(full_text))
        windows.append(full_text[pos:end])
        pos += WINDOW_SIZE - WINDOW_OVERLAP
        if end == len(full_text):
            break

    # Summarize each window
    window_summaries = []
    for i, window in enumerate(windows):
        if len(window.strip()) < 100:
            continue
        summary = await tracker.summarize_chunk(
            window,
            instruction=f"Summarize section {i+1}/{len(windows)} of this text. Capture all key technical concepts and findings.",
            max_tokens=400,
        )
        window_summaries.append(f"[Window {i+1}] {summary}")

    # Final merge
    combined = "\n\n".join(window_summaries)
    final = await tracker.final_summary(combined)

    elapsed = time.perf_counter() - t0
    return StrategyResult(
        name="C. LLM Sliding Window",
        output_text=final,
        latency_s=elapsed,
        llm_calls=tracker.calls,
        input_tokens_est=tracker.input_tokens,
        output_tokens_est=tracker.output_tokens,
    )


# =============================================================================
# Strategy D: LLM Hierarchical
# =============================================================================

async def run_strategy_hierarchical(file_path: Path) -> StrategyResult:
    """Chunk → L1 summaries → group → L2 summaries → final summary."""
    t0 = time.perf_counter()
    tracker = LLMTracker()
    util = DocumentUtility()

    # Get cleaned full text
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(str(file_path))
    text_parts = []
    for page in pdf:
        tp = page.get_textpage()
        text_parts.append(tp.get_text_range())
        tp.close()
        page.close()
    pdf.close()
    full_text = util._clean_pdf_text("\n".join(text_parts))

    # Level 0: Chunk text (non-overlapping for hierarchy)
    chunks = []
    pos = 0
    while pos < len(full_text):
        end = min(pos + HIER_CHUNK_SIZE, len(full_text))
        chunk = full_text[pos:end].strip()
        if len(chunk) >= 100:
            chunks.append(chunk)
        pos = end

    # Level 1: Summarize each chunk
    l1_summaries = []
    for i, chunk in enumerate(chunks):
        summary = await tracker.summarize_chunk(
            chunk,
            instruction=f"Summarize chunk {i+1}/{len(chunks)}. Capture ALL key concepts, methods, and results.",
            max_tokens=300,
        )
        l1_summaries.append(summary)

    # Level 2: Group L1 summaries and summarize each group
    l2_summaries = []
    for g in range(0, len(l1_summaries), HIER_GROUP_SIZE):
        group = l1_summaries[g : g + HIER_GROUP_SIZE]
        group_text = "\n\n".join(f"[Section {g+j+1}] {s}" for j, s in enumerate(group))
        summary = await tracker.summarize_chunk(
            group_text,
            instruction="Merge these section summaries into a single coherent summary. Preserve all key technical details.",
            max_tokens=500,
        )
        l2_summaries.append(summary)

    # Final: Merge all L2 summaries
    combined = "\n\n".join(f"[Part {i+1}] {s}" for i, s in enumerate(l2_summaries))
    final = await tracker.final_summary(combined)

    elapsed = time.perf_counter() - t0
    return StrategyResult(
        name="D. LLM Hierarchical",
        output_text=final,
        latency_s=elapsed,
        llm_calls=tracker.calls,
        input_tokens_est=tracker.input_tokens,
        output_tokens_est=tracker.output_tokens,
    )


# =============================================================================
# Report Printer
# =============================================================================

def print_comparison_report(paper_name: str, results: List[StrategyResult], concepts: List[str]):
    """Print a formatted comparison table."""
    width = 100
    print(f"\n{'=' * width}")
    print(f"  BENCHMARK: {paper_name}")
    print(f"  Ground-truth concepts: {len(concepts)}")
    print(f"{'=' * width}")

    # Score all results
    for r in results:
        hits, found, missed = score_concepts(r.output_text, concepts)
        r.concept_hits = hits
        r.concept_total = len(concepts)
        r.concepts_found = found
        r.concepts_missed = missed

    # Table header
    print(f"\n{'Strategy':<42} {'Coverage':>10} {'Latency':>10} {'LLM Calls':>10} {'In Tokens':>10} {'Out Tokens':>10}")
    print(f"{'-' * 42} {'-' * 10} {'-' * 10} {'-' * 10} {'-' * 10} {'-' * 10}")

    for r in results:
        pct = f"{r.concept_hits}/{r.concept_total} ({100 * r.concept_hits / max(r.concept_total, 1):.0f}%)"
        print(
            f"{r.name:<42} {pct:>10} {r.latency_s:>9.1f}s {r.llm_calls:>10} {r.input_tokens_est:>10} {r.output_tokens_est:>10}"
        )

    # Detail: concepts found/missed per strategy
    print("\n--- Concept Coverage Detail ---")
    for r in results:
        print(f"\n  {r.name}")
        print(f"    Found ({r.concept_hits}): {', '.join(r.concepts_found)}")
        if r.concepts_missed:
            print(f"    MISSED ({len(r.concepts_missed)}): {', '.join(r.concepts_missed)}")
        else:
            print("    MISSED: None (perfect coverage)")

    # Output previews
    print("\n--- Output Previews (first 600 chars) ---")
    for r in results:
        preview = r.output_text[:600].replace("\n", " ")
        print(f"\n  {r.name}:")
        print(f"    {preview}...")

    print(f"\n{'=' * width}\n")


# =============================================================================
# Availability check
# =============================================================================

async def _inference_available() -> bool:
    """Check if aether-inference is reachable at the configured LLM_URL."""
    try:
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get(f"{LLM_URL}/models")
            return r.status_code == 200
    except Exception:
        return False


# =============================================================================
# Tests
# =============================================================================

@pytest.mark.asyncio
async def test_benchmark_timeseries_bpe():
    """Full 4-strategy benchmark on Time Series BPE paper (1.6MB)."""
    if not await _inference_available():
        pytest.skip(f"aether-inference not available at {LLM_URL}")

    paper = PAPERS_DIR / "timeseries_bpe_2026.pdf"
    if not paper.exists():
        pytest.skip(f"Paper not found: {paper}")

    gt = GROUND_TRUTH["timeseries_bpe_2026.pdf"]

    # Run all 4 strategies
    result_a = run_strategy_extractive(paper)

    result_b = await run_strategy_per_page(paper)
    result_c = await run_strategy_sliding_window(paper)
    result_d = await run_strategy_hierarchical(paper)

    results = [result_a, result_b, result_c, result_d]
    print_comparison_report(gt["display_name"], results, gt["concepts"])

    # Assertions: every strategy should capture at least SOME concepts
    for r in results:
        assert r.concept_hits > 0, f"{r.name} captured 0 concepts"
        assert len(r.output_text) > 100, f"{r.name} output too short"

    # DocumentUtility should be fastest (no LLM calls)
    assert result_a.latency_s < result_b.latency_s
    assert result_a.latency_s < result_c.latency_s
    assert result_a.latency_s < result_d.latency_s
    assert result_a.llm_calls == 0


@pytest.mark.asyncio
async def test_benchmark_multilingual_pretraining():
    """Full 4-strategy benchmark on Multilingual Pretraining paper (7.9MB)."""
    if not await _inference_available():
        pytest.skip(f"aether-inference not available at {LLM_URL}")

    paper = PAPERS_DIR / "multilingual_pretraining_2026.pdf"
    if not paper.exists():
        pytest.skip(f"Paper not found: {paper}")

    gt = GROUND_TRUTH["multilingual_pretraining_2026.pdf"]

    result_a = run_strategy_extractive(paper)
    result_b = await run_strategy_per_page(paper)
    result_c = await run_strategy_sliding_window(paper)
    result_d = await run_strategy_hierarchical(paper)

    results = [result_a, result_b, result_c, result_d]
    print_comparison_report(gt["display_name"], results, gt["concepts"])

    for r in results:
        assert r.concept_hits > 0, f"{r.name} captured 0 concepts"
        assert len(r.output_text) > 100, f"{r.name} output too short"

    assert result_a.latency_s < result_b.latency_s
    assert result_a.llm_calls == 0


@pytest.mark.asyncio
async def test_extractive_vs_llm_coverage_gap():
    """
    Focused analysis: Does the LLM add coverage that extractive misses?
    Uses timeseries paper. Reports the delta.
    """
    if not await _inference_available():
        pytest.skip(f"aether-inference not available at {LLM_URL}")

    paper = PAPERS_DIR / "timeseries_bpe_2026.pdf"
    if not paper.exists():
        pytest.skip(f"Paper not found: {paper}")

    gt = GROUND_TRUTH["timeseries_bpe_2026.pdf"]
    concepts = gt["concepts"]

    # Run extractive and one LLM strategy (hierarchical as the most thorough)
    result_a = run_strategy_extractive(paper)
    result_d = await run_strategy_hierarchical(paper)

    _, found_a, missed_a = score_concepts(result_a.output_text, concepts)
    _, found_d, missed_d = score_concepts(result_d.output_text, concepts)

    # Concepts only LLM found (not in extractive)
    llm_only = [c for c in found_d if c not in found_a]
    # Concepts only extractive found (not in LLM)
    extract_only = [c for c in found_a if c not in found_d]

    print("\n--- Coverage Gap Analysis (timeseries_bpe) ---")
    print(f"Extractive found: {len(found_a)}/{len(concepts)}")
    print(f"Hierarchical LLM found: {len(found_d)}/{len(concepts)}")
    print(f"LLM-only concepts: {llm_only}")
    print(f"Extractive-only concepts: {extract_only}")
    print(f"Latency: Extractive={result_a.latency_s:.1f}s, Hierarchical={result_d.latency_s:.1f}s")
    print(f"LLM calls: {result_d.llm_calls}, Input tokens: {result_d.input_tokens_est}")

    # The extractive approach should capture many concepts from raw text
    assert len(found_a) >= 5, "Extractive should find at least 5 concepts from raw text"
