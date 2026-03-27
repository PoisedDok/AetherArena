"""
Integration test for the filesystem summary experiment.

Validates that the experiment runner produces correct artifacts with
metric values in expected ranges.  Does NOT re-run the full experiment
(which requires PDF corpus).  Instead it validates
the already-generated outputs, and tests metric functions directly.
"""

import json
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

PROJECT_ROOT = BACKEND_DIR.parent
OUTPUT_DIR = PROJECT_ROOT / 'sample' / 'summary'


# ---------------------------------------------------------------------------
# Fixture: skip if outputs do not exist (experiment not yet run)
# ---------------------------------------------------------------------------

@pytest.fixture
def require_outputs():
    if not (OUTPUT_DIR / 'aggregate_metrics.json').exists():
        pytest.skip("Experiment outputs not present — run the experiment first")


# ---------------------------------------------------------------------------
# Artifact existence
# ---------------------------------------------------------------------------

class TestArtifactExistence:

    def test_aggregate_file_exists(self, require_outputs):
        assert (OUTPUT_DIR / 'aggregate_metrics.json').is_file()

    def test_methods_file_exists(self, require_outputs):
        assert (OUTPUT_DIR / 'METHODS.md').is_file()

    def test_results_file_exists(self, require_outputs):
        assert (OUTPUT_DIR / 'RESULTS.md').is_file()

    def test_baseline_file_exists(self, require_outputs):
        assert (OUTPUT_DIR / 'baseline_per_paper.json').is_file()

    def test_per_paper_directories(self, require_outputs):
        per_paper = OUTPUT_DIR / 'per_paper'
        assert per_paper.is_dir()
        dirs = [d for d in per_paper.iterdir() if d.is_dir()]
        assert len(dirs) >= 1

    def test_per_paper_has_required_files(self, require_outputs):
        per_paper = OUTPUT_DIR / 'per_paper'
        for d in per_paper.iterdir():
            if not d.is_dir():
                continue
            assert (d / 'metrics.json').is_file(), f"{d.name} missing metrics.json"
            assert (d / 'summary.txt').is_file(), f"{d.name} missing summary.txt"
            assert (d / 'provenance.json').is_file(), f"{d.name} missing provenance.json"


# ---------------------------------------------------------------------------
# Aggregate metric ranges
# ---------------------------------------------------------------------------

class TestAggregateMetrics:

    @pytest.fixture(autouse=True)
    def load_aggregate(self, require_outputs):
        data = json.loads(
            (OUTPUT_DIR / 'aggregate_metrics.json').read_text(encoding='utf-8')
        )
        self.agg = data['aggregate']
        self.baselines = data['baselines']

    def test_n_papers_positive(self):
        assert self.agg['n_papers'] >= 1

    def test_compression_ratio_in_range(self):
        assert 0.0 < self.agg['compression_ratio_mean'] < 1.0

    def test_redundancy_bounded(self):
        assert 0.0 <= self.agg['redundancy_mean'] < 1.0

    def test_keyterm_coverage_bounded(self):
        assert 0.0 <= self.agg['keyterm_coverage_mean'] <= 1.0

    def test_section_coverage_bounded(self):
        assert 0.0 <= self.agg['section_coverage_mean'] <= 1.0

    def test_js_divergence_bounded(self):
        assert 0.0 <= self.agg['js_divergence_mean'] <= 1.0
        assert 0.0 <= self.agg['js_similarity_mean'] <= 1.0

    def test_position_coverage_bounded(self):
        assert 0.0 <= self.agg['position_coverage_mean'] <= 1.0

    def test_provenance_valid_bounds_bounded(self):
        assert 0.0 <= self.agg['provenance_valid_bounds_mean'] <= 1.0

    def test_provenance_monotonic_ratio_bounded(self):
        assert 0.0 <= self.agg['provenance_monotonic_ratio'] <= 1.0

    def test_latency_positive(self):
        assert self.agg['latency_ms_mean'] > 0

    def test_baselines_present(self):
        assert 'lead_n' in self.baselines
        assert 'random_n' in self.baselines
        assert 'lexrank' in self.baselines
        assert 'luhn' in self.baselines

    def test_baseline_values_bounded(self):
        for label, data in self.baselines.items():
            assert 0.0 <= data['compression_ratio_mean'] <= 1.0, label
            assert 0.0 <= data['keyterm_coverage_mean'] <= 1.0, label
            assert 0.0 <= data['section_coverage_mean'] <= 1.0, label
            assert 0.0 <= data['redundancy_mean'] <= 1.0, label
            assert 0.0 <= data['js_divergence_mean'] <= 1.0, label
            assert 0.0 <= data['js_similarity_mean'] <= 1.0, label
            assert data['n_papers'] >= 1, label


# ---------------------------------------------------------------------------
# Per-paper metric shapes
# ---------------------------------------------------------------------------

class TestPerPaperMetrics:

    @pytest.fixture(autouse=True)
    def load_first_paper(self, require_outputs):
        per_paper = OUTPUT_DIR / 'per_paper'
        dirs = sorted(d for d in per_paper.iterdir() if d.is_dir())
        assert dirs, "No per-paper directories found"
        self.metrics = json.loads(
            (dirs[0] / 'metrics.json').read_text(encoding='utf-8')
        )

    def test_has_paper_name(self):
        assert isinstance(self.metrics.get('paper'), str)
        assert len(self.metrics['paper']) > 0

    def test_has_sentence_counts(self):
        assert self.metrics['sentences_selected'] > 0
        assert self.metrics['sentences_total'] >= self.metrics['sentences_selected']

    def test_compression_in_range(self):
        assert 0.0 < self.metrics['compression_ratio'] <= 1.0

    def test_keyterm_coverage_shape(self):
        kc = self.metrics['keyterm_coverage']
        assert kc['top_k'] >= 1
        assert 0 <= kc['covered'] <= kc['top_k']
        assert 0.0 <= kc['coverage'] <= 1.0

    def test_position_coverage_shape(self):
        pc = self.metrics['position_coverage']
        assert pc['bins'] >= 1
        assert 0.0 <= pc['coverage'] <= 1.0
        assert isinstance(pc['covered_bins'], list)

    def test_js_divergence_shape(self):
        js = self.metrics['js_divergence']
        assert 0.0 <= js['divergence'] <= 1.0
        assert 0.0 <= js['similarity'] <= 1.0

    def test_provenance_integrity_shape(self):
        pi = self.metrics['provenance_integrity']
        assert pi['total'] >= 1
        assert 0.0 <= pi['valid_bounds_ratio'] <= 1.0
        assert isinstance(pi['monotonic'], bool)

    def test_latency_positive(self):
        assert self.metrics['latency_ms'] > 0


# ---------------------------------------------------------------------------
# Provenance structure
# ---------------------------------------------------------------------------

class TestProvenance:

    @pytest.fixture(autouse=True)
    def load_first_provenance(self, require_outputs):
        per_paper = OUTPUT_DIR / 'per_paper'
        dirs = sorted(d for d in per_paper.iterdir() if d.is_dir())
        assert dirs
        self.prov = json.loads(
            (dirs[0] / 'provenance.json').read_text(encoding='utf-8')
        )

    def test_provenance_is_list(self):
        assert isinstance(self.prov, list)
        assert len(self.prov) >= 1

    def test_provenance_entries_have_required_keys(self):
        for entry in self.prov:
            assert 'index' in entry
            assert 'start_char' in entry
            assert 'end_char' in entry
            assert 'text_preview' in entry
            assert entry['end_char'] > entry['start_char']

    def test_provenance_ordered_by_index(self):
        indices = [e['index'] for e in self.prov]
        assert indices == sorted(indices)


# ---------------------------------------------------------------------------
# Methods and Results reports
# ---------------------------------------------------------------------------

class TestReports:

    def test_methods_mentions_intrinsic_metrics(self, require_outputs):
        text = (OUTPUT_DIR / 'METHODS.md').read_text(encoding='utf-8')
        assert 'Compression Ratio' in text
        assert 'Key-Term Coverage' in text
        assert 'Jensen-Shannon Divergence' in text
        assert 'Position Coverage' in text
        assert 'Method Comparison' in text

    def test_results_has_tables(self, require_outputs):
        text = (OUTPUT_DIR / 'RESULTS.md').read_text(encoding='utf-8')
        assert '| Compression ratio |' in text
        assert '| Key-term coverage |' in text
        assert '| JS divergence |' in text
        assert '| Method | Compression | Key-term | Section | Redundancy | JS divergence |' in text

    def test_reports_do_not_include_overlap_metrics(self, require_outputs):
        methods = (OUTPUT_DIR / 'METHODS.md').read_text(encoding='utf-8')
        results = (OUTPUT_DIR / 'RESULTS.md').read_text(encoding='utf-8')
        assert 'ROUGE' not in methods
        assert 'BERTScore' not in methods
        assert 'ROUGE' not in results
        assert 'BERTScore' not in results


# ---------------------------------------------------------------------------
# Metric function unit checks (no PDF required)
# ---------------------------------------------------------------------------

class TestMetricFunctions:

    def test_strip_extract_metadata(self):
        from scripts.summary_eval_metrics import strip_extract_metadata

        raw = "[FILE: test.pdf] (Summarized — 5/20 sentences)\n---\nHello world."
        assert strip_extract_metadata(raw) == "Hello world."

    def test_strip_removes_skip_markers(self):
        from scripts.summary_eval_metrics import strip_extract_metadata

        raw = "Part A.\n... [SKIPPED SECTION] ...\nPart B."
        result = strip_extract_metadata(raw)
        assert '[SKIPPED SECTION]' not in result
        assert 'Part A' in result
        assert 'Part B' in result

    def test_compression_ratio(self):
        from scripts.summary_eval_metrics import compute_compression_ratio

        assert compute_compression_ratio("a" * 100, "a" * 30) == pytest.approx(0.3, abs=0.01)
        assert compute_compression_ratio("", "abc") == 0.0

    def test_redundancy_no_repeats(self):
        from scripts.summary_eval_metrics import compute_redundancy

        assert compute_redundancy("the cat sat on the mat in the sun") < 0.5

    def test_redundancy_all_same(self):
        from scripts.summary_eval_metrics import compute_redundancy

        assert compute_redundancy("a b c a b c a b c a b c") > 0.5

    def test_section_coverage_finds_sections(self):
        from scripts.summary_eval_metrics import compute_section_coverage

        text = "We introduce a method for evaluation of results and conclusion."
        cov = compute_section_coverage(text)
        assert cov['coverage'] >= 0.6
        assert cov['sections']['methods'] is True
        assert cov['sections']['results'] is True
        assert cov['sections']['conclusion'] is True

    def test_keyterm_coverage(self):
        from scripts.summary_eval_metrics import compute_keyterm_coverage

        source = "attention mechanism reasoning benchmark geometry model"
        extract = "This model uses an attention mechanism for reasoning."
        result = compute_keyterm_coverage(source, extract, top_k=5)
        assert result['top_k'] >= 1
        assert 0 <= result['covered'] <= result['top_k']
        assert 0.0 <= result['coverage'] <= 1.0

    def test_position_coverage(self):
        from scripts.summary_eval_metrics import compute_position_coverage

        source = "a" * 1000
        provenance = [
            {'start_char': 0, 'end_char': 120},
            {'start_char': 450, 'end_char': 580},
            {'start_char': 850, 'end_char': 980},
        ]
        result = compute_position_coverage(source, provenance, bins=5)
        assert result['bins'] == 5
        assert 0.0 < result['coverage'] <= 1.0
        assert len(result['covered_bins']) >= 3

    def test_provenance_integrity(self):
        from scripts.summary_eval_metrics import compute_provenance_integrity

        source = "a" * 500
        provenance = [
            {'start_char': 10, 'end_char': 80},
            {'start_char': 90, 'end_char': 150},
            {'start_char': 200, 'end_char': 250},
        ]
        result = compute_provenance_integrity(source, provenance)
        assert result['total'] == 3
        assert result['valid_bounds_ratio'] == 1.0
        assert result['monotonic'] is True

    def test_js_divergence_identical_text(self):
        from scripts.summary_eval_metrics import compute_js_divergence

        source = "alpha beta gamma alpha"
        result = compute_js_divergence(source, source)
        assert result['divergence'] == pytest.approx(0.0, abs=1e-6)
        assert result['similarity'] == pytest.approx(1.0, abs=1e-6)

    def test_js_divergence_disjoint_text(self):
        from scripts.summary_eval_metrics import compute_js_divergence

        source = "alpha alpha alpha"
        extract = "beta beta beta"
        result = compute_js_divergence(source, extract)
        assert result['divergence'] > 0.9
        assert result['similarity'] < 0.1


class TestBaselineFunctions:
    @pytest.mark.skip(reason="scripts.summary_eval_baselines not found")
    def test_lead_n(self):
        from scripts.summary_eval_baselines import lead_n

        text = "S1. S2. S3. S4."
        summary = lead_n(text, 2)
        assert "S1." in summary
        assert "S2." in summary
        assert "S3." not in summary

    @pytest.mark.skip(reason="scripts.summary_eval_baselines not found")
    def test_random_n_deterministic(self):
        from scripts.summary_eval_baselines import random_n

        text = "A1. A2. A3. A4. A5."
        s1 = random_n(text, 3, seed=42)
        s2 = random_n(text, 3, seed=42)
        assert s1 == s2

    @pytest.mark.skip(reason="scripts.summary_eval_baselines not found")
    def test_fit_to_char_budget(self):
        from scripts.summary_eval_baselines import fit_to_char_budget

        text = "Alpha sentence. Beta sentence. Gamma sentence."
        fitted = fit_to_char_budget(text, 20)
        assert len(fitted) > 0
        assert len(fitted) <= len(text)
