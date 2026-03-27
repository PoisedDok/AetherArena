"""
Intrinsic extractive summary evaluation metrics.

This module intentionally avoids overlap-based source-vs-extract metrics
because they are degenerate for verbatim extractive systems. The metrics
below are intrinsic quality signals for extractive
selection quality, compression behavior, and provenance reliability.

Metrics
-------
Compression Ratio
    len(extract) / len(source). Lower means stronger compression.

Redundancy
    Fraction of repeated trigrams inside the extract. Lower is better.

Section Coverage
    Lexical-anchor check for abstract/introduction/methods/results/conclusion.

Key-Term Coverage
    Fraction of top-TF-IDF source terms retained in the extract.

Position Coverage
    Fraction of document-position bins touched by selected chunk spans.

Provenance Integrity
    Bounds validity and monotonic ordering checks for provenance spans.
"""

import math
import re
from collections import Counter
from typing import Any, Dict, List, Optional, Sequence

from scipy.spatial.distance import jensenshannon
from sklearn.feature_extraction.text import TfidfVectorizer


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_HEADER_RE = re.compile(r'^\[FILE:.*?\]\s*\(.*?\)\n---\n', re.DOTALL)
_SKIP_MARKER_RE = re.compile(r'\n?\.\.\.\s*\[SKIPPED SECTION\]\s*\.\.\.\n?')
_SPACE_RE = re.compile(r'\s+')
_TOKEN_RE = re.compile(r"[a-zA-Z][a-zA-Z\-']*")


def strip_extract_metadata(extract: str) -> str:
    """Remove utility header and skipped-section markers from an extract."""
    text = _HEADER_RE.sub('', extract)
    text = _SKIP_MARKER_RE.sub(' ', text)
    return text.strip()


def _normalize_space(text: str) -> str:
    return _SPACE_RE.sub(' ', text).strip()


def _coerce_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Compression ratio
# ---------------------------------------------------------------------------

def compute_compression_ratio(source: str, extract: str) -> float:
    """len(extract) / len(source), clamped to [0, 1]."""
    if not source:
        return 0.0
    return round(min(len(extract) / len(source), 1.0), 6)


# ---------------------------------------------------------------------------
# Redundancy
# ---------------------------------------------------------------------------

def compute_redundancy(extract: str) -> float:
    """Fraction of trigrams repeated within the extract."""
    words = extract.lower().split()
    if len(words) < 4:
        return 0.0
    trigrams = [tuple(words[i:i + 3]) for i in range(len(words) - 2)]
    seen: set = set()
    repeated = 0
    for trigram in trigrams:
        if trigram in seen:
            repeated += 1
        seen.add(trigram)
    return round(repeated / len(trigrams), 6)


# ---------------------------------------------------------------------------
# Section coverage
# ---------------------------------------------------------------------------

_SECTION_ANCHORS = {
    'abstract': re.compile(
        r'\b(?:abstract|we\s+(?:propose|present|introduce))\b', re.I,
    ),
    'introduction': re.compile(
        r'\b(?:introduction|background|motivation)\b', re.I,
    ),
    'methods': re.compile(
        r'\b(?:method|approach|framework|architecture|model)\b', re.I,
    ),
    'results': re.compile(
        r'\b(?:results?|experiments?|evaluation|ablation)\b', re.I,
    ),
    'conclusion': re.compile(
        r'\b(?:conclusion|summary|future\s+work|limitation)\b', re.I,
    ),
}


def compute_section_coverage(extract: str) -> Dict[str, Any]:
    """Presence check for key paper sections using lexical anchors."""
    hits: Dict[str, bool] = {}
    for section, pattern in _SECTION_ANCHORS.items():
        hits[section] = bool(pattern.search(extract))
    covered = sum(hits.values())
    return {
        'sections': hits,
        'coverage': round(covered / len(_SECTION_ANCHORS), 4),
    }


# ---------------------------------------------------------------------------
# Key-term coverage
# ---------------------------------------------------------------------------

def compute_keyterm_coverage(
    source: str,
    extract: str,
    *,
    top_k: int = 40,
) -> Dict[str, Any]:
    """Coverage of top TF-IDF key terms from source within extract."""
    if not source or not source.strip():
        return {'top_k': 0, 'covered': 0, 'coverage': 0.0}

    vectorizer = TfidfVectorizer(
        stop_words='english',
        ngram_range=(1, 2),
        token_pattern=r'(?u)\b[a-zA-Z][a-zA-Z\-]{2,}\b',
    )

    try:
        tfidf = vectorizer.fit_transform([source])
    except ValueError:
        return {'top_k': 0, 'covered': 0, 'coverage': 0.0}

    terms = vectorizer.get_feature_names_out()
    if len(terms) == 0:
        return {'top_k': 0, 'covered': 0, 'coverage': 0.0}

    weights = tfidf.toarray()[0]
    ranked_indices = weights.argsort()[::-1]

    selected_terms: List[str] = []
    for idx in ranked_indices:
        if weights[idx] <= 0:
            break
        selected_terms.append(terms[idx])
        if len(selected_terms) >= top_k:
            break

    if not selected_terms:
        return {'top_k': 0, 'covered': 0, 'coverage': 0.0}

    extract_norm = _normalize_space(extract.lower())
    covered = 0
    for term in selected_terms:
        if re.search(rf'(?<!\w){re.escape(term)}(?!\w)', extract_norm):
            covered += 1

    return {
        'top_k': len(selected_terms),
        'covered': covered,
        'coverage': round(covered / len(selected_terms), 4),
    }


# ---------------------------------------------------------------------------
# Provenance-aware structural metrics
# ---------------------------------------------------------------------------

def _token_counts(text: str) -> Counter:
    tokens = _TOKEN_RE.findall(text.lower())
    return Counter(tokens)


def compute_js_divergence(source: str, extract: str) -> Dict[str, float]:
    """
    Jensen-Shannon divergence between source and extract unigram distributions.

    scipy.spatial.distance.jensenshannon returns the JS *distance* (square root
    of divergence).  We square it to obtain the actual divergence, which is the
    quantity reported by Louis & Nenkova (2013).  With base=2 the divergence is
    bounded in [0, 1].  Similarity is reported as (1 - divergence).
    """
    source_counts = _token_counts(source)
    extract_counts = _token_counts(extract)

    if not source_counts and not extract_counts:
        return {'divergence': 0.0, 'similarity': 1.0}
    if not source_counts or not extract_counts:
        return {'divergence': 1.0, 'similarity': 0.0}

    vocabulary = sorted(set(source_counts) | set(extract_counts))
    source_total = sum(source_counts.values())
    extract_total = sum(extract_counts.values())

    p = [source_counts[token] / source_total for token in vocabulary]
    q = [extract_counts[token] / extract_total for token in vocabulary]

    js_distance = float(jensenshannon(p, q, base=2.0))
    if math.isnan(js_distance):
        js_distance = 1.0

    divergence = round(max(0.0, min(js_distance ** 2, 1.0)), 6)
    similarity = round(1.0 - divergence, 6)
    return {'divergence': divergence, 'similarity': similarity}

def compute_position_coverage(
    source: str,
    provenance: Sequence[Dict[str, Any]],
    *,
    bins: int = 5,
) -> Dict[str, Any]:
    """Coverage of document positions touched by selected chunk spans."""
    source_len = len(source)
    if source_len <= 0 or bins <= 0:
        return {'bins': bins, 'covered_bins': [], 'coverage': 0.0}

    bin_size = source_len / bins
    covered_bins = set()

    for entry in provenance:
        start = _coerce_int(entry.get('start_char'))
        end = _coerce_int(entry.get('end_char'))
        if start is None or end is None:
            continue
        if start < 0 or end <= start or end > source_len:
            continue

        first = min(bins - 1, int(start / bin_size))
        last = min(bins - 1, int((end - 1) / bin_size))
        for b in range(first, last + 1):
            covered_bins.add(b)

    return {
        'bins': bins,
        'covered_bins': sorted(covered_bins),
        'coverage': round(len(covered_bins) / bins, 4),
    }


def compute_provenance_integrity(
    source: str,
    provenance: Sequence[Dict[str, Any]],
) -> Dict[str, Any]:
    """Validate provenance spans against source bounds and ordering."""
    total = len(provenance)
    if total == 0:
        return {'total': 0, 'valid_bounds_ratio': 0.0, 'monotonic': False}

    source_len = len(source)
    valid_bounds = 0
    monotonic = True
    prev_start = -1

    for entry in provenance:
        start = _coerce_int(entry.get('start_char'))
        end = _coerce_int(entry.get('end_char'))
        if start is None or end is None:
            monotonic = False
            continue
        if not (0 <= start < end <= source_len):
            continue

        valid_bounds += 1
        if start < prev_start:
            monotonic = False
        prev_start = start

    return {
        'total': total,
        'valid_bounds_ratio': round(valid_bounds / total, 4),
        'monotonic': monotonic,
    }


# ---------------------------------------------------------------------------
# Aggregate convenience
# ---------------------------------------------------------------------------

def compute_all_metrics(
    source: str,
    extract: str,
    provenance: Optional[Sequence[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Full intrinsic metric suite for one (source, extract) pair."""
    clean = strip_extract_metadata(extract)
    metrics: Dict[str, Any] = {
        'compression_ratio': compute_compression_ratio(source, clean),
        'redundancy': compute_redundancy(clean),
        'section_coverage': compute_section_coverage(clean),
        'keyterm_coverage': compute_keyterm_coverage(source, clean),
        'js_divergence': compute_js_divergence(source, clean),
    }
    if provenance is not None:
        metrics['position_coverage'] = compute_position_coverage(source, provenance)
        metrics['provenance_integrity'] = compute_provenance_integrity(
            source, provenance,
        )
    return metrics
