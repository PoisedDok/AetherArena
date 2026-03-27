"""
Regression guardrails for proactive prompt domain neutrality.

These tests enforce the current anti-bias hardening in proactive prompts so
future edits do not drift back to tech-only assumptions.
"""

from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[3]
CLASSIFIER_PROMPT_PATH = (
    BACKEND_ROOT
    / "services"
    / "perplexica"
    / "src"
    / "lib"
    / "prompts"
    / "proactive"
    / "classifier.ts"
)
DECISION_PROMPT_PATH = (
    BACKEND_ROOT
    / "services"
    / "perplexica"
    / "src"
    / "lib"
    / "prompts"
    / "proactive"
    / "decision.ts"
)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_classifier_prompt_includes_query_gen_in_tool_contract():
    prompt = _read(CLASSIFIER_PROMPT_PATH)
    assert (
        "sources: array of strings. You can use standard sources (${PROACTIVE_RETRIEVER_SOURCES_SLASH})" in prompt
    )
    assert (
        "Allowed sources: Standard sources (${PROACTIVE_RETRIEVER_SOURCES_CSV})" in prompt
    )
    assert '"sources": ["email", "chat", "query_gen"]' in prompt


def test_classifier_prompt_keeps_local_first_and_academic_workflow_clauses():
    prompt = _read(CLASSIFIER_PROMPT_PATH)
    assert "file://, localhost, intranet, local docs repositories -> local workflow" in prompt
    assert "Academic/library URLs -> filesystem + chat + query_gen + custom indexes retriever first" in prompt
    assert "Max 4 calls total. Max 2 per tool type. Be selective." in prompt


def test_classifier_prompt_excludes_legacy_tech_only_bias_examples():
    prompt = _read(CLASSIFIER_PROMPT_PATH).lower()
    assert "deployment failure" not in prompt
    assert "jwt authentication" not in prompt
    assert "cloud provider comparison" not in prompt
    assert "kubernetes cve" not in prompt


def test_decision_prompt_avoids_domain_specific_bias_examples():
    prompt = _read(DECISION_PROMPT_PATH).lower()
    assert "you might find this useful" not in prompt
    assert "you may want to check the latest developments" not in prompt
    assert "jwt token patterns" not in prompt
    assert "startup growth" not in prompt


def test_decision_prompt_enforces_observer_style_constraints():
    prompt = _read(DECISION_PROMPT_PATH)
    assert 'Decide exactly one outcome: "intervene" or "defer".' in prompt
    assert 'Hard rules for "recommendation"' in prompt
    assert "MUST BE EXTREMELY CONCISE:" in prompt
    assert "MUST sound like a helpful push notification, NOT a chatty assistant's paragraph." in prompt
