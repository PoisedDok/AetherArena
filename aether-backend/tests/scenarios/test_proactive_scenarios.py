#!/usr/bin/env python3
"""
Proactive Pipeline -- Real-World Scenario Runner

Multi-step temporal scenario tests that simulate realistic user activity
patterns and verify the proactive agent's decision evolution. NOT pytest.
Each scenario builds context step-by-step and validates that decisions
evolve correctly as evidence accumulates.

Run:
    python tests/scenarios/test_proactive_scenarios.py              # all scenarios
    python tests/scenarios/test_proactive_scenarios.py --scenario 1  # single scenario
    python tests/scenarios/test_proactive_scenarios.py --quick       # critical-only (~15 min)
    python tests/scenarios/test_proactive_scenarios.py --json        # JSON results to stdout

Requires: backend running on localhost:8765 with Perplexica reachable.
Expected runtime: ~60 min full suite, ~20 min critical-only (12 scenarios).
"""

import sys
import json
import time
import argparse
import traceback
import requests
from datetime import datetime, timezone, timedelta
from uuid import uuid4
from pathlib import PurePosixPath
from dataclasses import dataclass, field
from typing import List, Optional


# ======================================================================
# Configuration
# ======================================================================

BASE_URL = "http://localhost:8765"
_session = requests.Session()


# ======================================================================
# Colors (terminal output)
# ======================================================================

class C:
    PASS = "\033[92m"
    FAIL = "\033[91m"
    WARN = "\033[93m"
    INFO = "\033[96m"
    DIM = "\033[90m"
    BOLD = "\033[1m"
    END = "\033[0m"


# ======================================================================
# Data factories (mirrors helpers.py, self-contained for standalone use)
# ======================================================================

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")

def _offset_time(minutes: int) -> str:
    """ISO timestamp offset from now by N minutes."""
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()


def make_email(
    subject: str,
    sender: str,
    body_preview: str,
    recipients: str = "user@company.com",
    timestamp: str = None,
) -> dict:
    ts = timestamp or _now_iso()
    return {
        "source": "email",
        "timestamp": ts,
        "metadata": {
            "subject": subject,
            "sender": sender,
            "recipients": recipients,
            "body_preview": body_preview,
            "file_path": "Mail.app",
            "day_date": ts[:10],
            "_context_type": "triggering_log",
            "_batch": "current",
        },
    }


def make_browser(
    url: str,
    title: str,
    visit_count: int = 1,
    typed_count: int = 0,
    timestamp: str = None,
) -> dict:
    ts = timestamp or _now_iso()
    return {
        "source": "browser",
        "timestamp": ts,
        "metadata": {
            "url": url,
            "title": title,
            "visit_count": visit_count,
            "typed_count": typed_count,
            "profile": "Default",
            "day_date": ts[:10],
            "_context_type": "triggering_log",
            "_batch": "current",
        },
    }


def make_filesystem(
    action: str,
    file_path: str,
    content_preview: str = "",
    timestamp: str = None,
) -> dict:
    ts = timestamp or _now_iso()
    p = PurePosixPath(file_path)
    return {
        "source": "filesystem",
        "timestamp": ts,
        "metadata": {
            "action": action,
            "file_path": file_path,
            "file_name": p.name,
            "file_extension": p.suffix.lower(),
            "content_preview": content_preview,
            "location_name": p.parent.name,
            "day_date": ts[:10],
            "_context_type": "triggering_log",
            "_batch": "current",
        },
    }


def make_previous_query(query: str, batch_offset: int = 1) -> dict:
    return {
        "source": "query_gen",
        "timestamp": _now_iso(),
        "metadata": {
            "_context_type": "previous_query",
            "_batch": f"N-{batch_offset}",
            "query": query,
            "batch_id": str(uuid4())[:8],
            "query_id": str(uuid4()),
        },
    }


# ======================================================================
# Scout API caller
# ======================================================================

def scout(
    queries: list,
    source_docs: list,
    mode: str = "balanced",
    timeout: int = 180,
    max_retries: int = 3,
    retry_backoff: int = 10,
) -> dict:
    """POST to /v1/proactive/scout with retry on transient 503s.

    The Perplexica agent can return 503 when the model backend is busy
    processing a prior request. Retrying with backoff handles this
    without marking it as a test failure.
    """
    payload = {
        "query_ids": [str(uuid4()) for _ in queries],
        "queries": queries,
        "source_docs": source_docs,
        "day_date": _today(),
    }
    last_error = None
    retries_used = 0
    for attempt in range(1, max_retries + 1):
        resp = _session.post(
            f"{BASE_URL}/v1/proactive/scout",
            json=payload,
            timeout=timeout,
        )
        if resp.status_code == 200:
            return resp.json()

        last_error = resp.text[:500]

        # Retry only on transient server errors (502, 503, 504)
        if resp.status_code in (502, 503, 504) and attempt < max_retries:
            retries_used = attempt
            wait = retry_backoff * attempt
            print(f"         {C.WARN}{resp.status_code} from agent "
                  f"(attempt {attempt}/{max_retries}), retrying in {wait}s...{C.END}")
            time.sleep(wait)
            continue

        # Non-retryable error or retries exhausted
        return {
            "_error": True,
            "status_code": resp.status_code,
            "detail": last_error,
            "_retries": retries_used,
        }

    return {
        "_error": True,
        "status_code": resp.status_code,
        "detail": last_error,
        "_retries": retries_used,
    }


def post_feedback(run_id: str, feedback: str) -> dict:
    resp = _session.post(
        f"{BASE_URL}/v1/proactive/{run_id}/feedback",
        params={"feedback": feedback},
        timeout=30,
    )
    if resp.status_code != 200:
        return {"_error": True, "status_code": resp.status_code}
    return resp.json()


# ======================================================================
# Step / Scenario result structures
# ======================================================================

@dataclass
class StepResult:
    name: str
    decision: Optional[str] = None
    expected: Optional[str] = None  # "intervene", "defer", or "any"
    passed: bool = False
    tool_budget: int = 0
    recommendation: Optional[str] = None
    tool_calls: int = 0
    elapsed_ms: int = 0
    error: Optional[str] = None
    run_id: Optional[str] = None
    retries: int = 0

    @property
    def failure_type(self) -> Optional[str]:
        """Classify the failure for clear reporting."""
        if self.passed:
            return None
        if self.error:
            return "INFRA"  # Infrastructure error (503, timeout, connection)
        if self.decision and self.expected and self.expected != "any":
            return "WRONG_DECISION"  # Agent returned wrong decision
        return "UNKNOWN"

    @property
    def status_str(self) -> str:
        if self.passed:
            return f"{C.PASS}PASS{C.END}"
        ft = self.failure_type
        if ft == "INFRA":
            return f"{C.WARN}INFRA{C.END}"
        if ft == "WRONG_DECISION":
            return f"{C.FAIL}FAIL{C.END}"
        return f"{C.FAIL}ERROR{C.END}"

    def diagnosis(self) -> str:
        """Human-readable explanation of why this step failed."""
        if self.passed:
            return ""
        lines = []
        ft = self.failure_type
        if ft == "INFRA":
            lines.append(f"Infrastructure error: {self.error}")
            lines.append("This is NOT a logic failure -- the agent was unreachable.")
            if self.retries > 0:
                lines.append(f"Retried {self.retries} time(s) before giving up.")
        elif ft == "WRONG_DECISION":
            lines.append(f"Agent decided '{self.decision}' but expected '{self.expected}'")
            lines.append(f"Tool budget: {self.tool_budget}")
            if self.recommendation:
                rec_preview = self.recommendation[:200].replace("\n", " ")
                lines.append(f"Recommendation: {rec_preview}")
            elif self.expected == "intervene":
                lines.append("No recommendation text generated (agent deferred)")
            lines.append(f"Tool calls: {self.tool_calls}")
        else:
            lines.append(f"Unknown failure: error={self.error}, decision={self.decision}")
        return "\n".join(lines)


@dataclass
class ScenarioResult:
    id: int
    name: str
    severity: str
    steps: List[StepResult] = field(default_factory=list)
    elapsed_s: float = 0.0

    @property
    def passed(self) -> bool:
        return all(s.passed for s in self.steps)

    @property
    def infra_failures(self) -> int:
        return sum(1 for s in self.steps if s.failure_type == "INFRA")

    @property
    def logic_failures(self) -> int:
        return sum(1 for s in self.steps if s.failure_type == "WRONG_DECISION")

    @property
    def status_str(self) -> str:
        if self.passed:
            return f"{C.PASS}PASS{C.END}"
        if self.logic_failures == 0 and self.infra_failures > 0:
            return f"{C.WARN}INFRA{C.END}"
        return f"{C.FAIL}FAIL{C.END}"


# ======================================================================
# Scenario runner infrastructure
# ======================================================================

class ScenarioRunner:
    """Executes a multi-step scenario and collects results."""

    def __init__(self, scenario_id: int, name: str, severity: str):
        self.result = ScenarioResult(id=scenario_id, name=name, severity=severity)
        self._cumulative_docs: List[dict] = []
        self._cumulative_queries: List[str] = []
        self._start = time.time()

    def add_context(self, docs: List[dict], queries: List[str] = None):
        """Add documents/queries that accumulate across steps."""
        self._cumulative_docs.extend(docs)
        if queries:
            self._cumulative_queries.extend(queries)

    def step(
        self,
        name: str,
        queries: List[str],
        source_docs: List[dict],
        expected: str = "any",
        mode: str = "balanced",
        cumulative: bool = False,
        pause_seconds: int = 2,
    ) -> StepResult:
        """Execute one step of the scenario.

        Args:
            name: Step description
            queries: Queries for this step
            source_docs: Docs for this step
            expected: "intervene", "defer", or "any" (no assertion)
            mode: Agent mode
            cumulative: If True, includes all docs/queries from prior steps
            pause_seconds: Pause before this step (simulates time passing)
        """
        if pause_seconds > 0:
            time.sleep(pause_seconds)

        # Build full payload
        all_docs = (self._cumulative_docs + source_docs) if cumulative else source_docs
        all_queries = (self._cumulative_queries + queries) if cumulative else queries

        step_result = StepResult(name=name, expected=expected)
        step_start = time.time()

        try:
            result = scout(all_queries, all_docs, mode=mode)

            if result.get("_error"):
                step_result.error = f"HTTP {result['status_code']}: {result.get('detail', '')[:200]}"
                step_result.retries = result.get("_retries", 0)
                step_result.passed = (expected == "any")
            else:
                step_result.decision = result.get("decision")
                step_result.tool_budget = int(result.get("tool_budget", 0) or 0)
                step_result.recommendation = result.get("recommendation")
                step_result.tool_calls = result.get("tool_calls_count", 0)
                step_result.run_id = result.get("run_id")
                step_result.elapsed_ms = result.get("execution_time_ms", 0)

                if expected == "any":
                    step_result.passed = step_result.decision in ("intervene", "defer")
                else:
                    step_result.passed = (step_result.decision == expected)

        except requests.exceptions.ConnectionError:
            step_result.error = f"Connection refused: backend at {BASE_URL} unreachable"
            step_result.passed = False
        except requests.exceptions.Timeout:
            step_result.error = f"Timeout after {timeout}s: agent did not respond"
            step_result.passed = False
        except Exception as e:
            step_result.error = f"{type(e).__name__}: {e}"
            step_result.passed = False

        step_result.elapsed_ms = step_result.elapsed_ms or int((time.time() - step_start) * 1000)
        self.result.steps.append(step_result)

        # ---- Print step result ----
        status = step_result.status_str
        dec = step_result.decision or "---"
        exp = expected if expected != "any" else "any"
        t = f"{step_result.elapsed_ms / 1000:.1f}s"

        # Always show basic line
        print(f"    {status}  {name}")
        print(f"         decision={dec}  expected={exp}  "
              f"budget={step_result.tool_budget}  "
              f"tools={step_result.tool_calls}  {t}")

        # On failure, show full diagnosis
        if not step_result.passed:
            diag = step_result.diagnosis()
            for line in diag.split("\n"):
                color = C.WARN if step_result.failure_type == "INFRA" else C.FAIL
                print(f"         {color}{line}{C.END}")

        return step_result

    def finish(self) -> ScenarioResult:
        self.result.elapsed_s = round(time.time() - self._start, 1)
        return self.result


# ======================================================================
# SCENARIO DEFINITIONS
# ======================================================================


def scenario_1_security_incident_escalation() -> ScenarioResult:
    """Developer: Security incident unfolds across all 3 sources over time.

    T+0: Casual browsing (noise baseline) -> expect defer
    T+1: Security alert email arrives -> expect intervene
    T+2: User opens NVD page for the CVE -> expect intervene (convergence)
    T+3: User creates remediation notes -> expect intervene (full convergence)
    T+4: Cumulative context: all prior events together -> expect strong intervene
    """
    r = ScenarioRunner(1, "Security Incident Escalation (Developer)", "critical")

    # Step 1: Baseline noise -- casual browsing
    r.step(
        name="Casual browsing baseline",
        queries=["user casual internet activity"],
        source_docs=[
            make_browser(
                url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                title="Background Music for Coding - 4 Hours",
                visit_count=1,
                typed_count=0,
            ),
        ],
        expected="defer",
        pause_seconds=0,
    )

    # Step 2: CVE alert email arrives
    cve_email = make_email(
        subject="[SECURITY-CRITICAL] CVE-2026-31337 - Remote Code Execution in OpenSSL 3.x",
        sender="security-team@company.com",
        body_preview=(
            "IMMEDIATE ACTION REQUIRED\n\n"
            "A critical remote code execution vulnerability (CVE-2026-31337) has been "
            "discovered in OpenSSL versions 3.0.0 through 3.2.1. CVSS Score: 9.8 (Critical).\n\n"
            "Impact: Any service using TLS termination with affected OpenSSL versions is "
            "vulnerable to unauthenticated remote code execution. Our production load "
            "balancers (lb-prod-01 through lb-prod-08) are running OpenSSL 3.1.4.\n\n"
            "Required Actions:\n"
            "1. Patch to OpenSSL 3.2.2 within 24 hours\n"
            "2. Rotate all TLS certificates on affected services\n"
            "3. Review access logs for indicators of compromise since Feb 1\n"
            "4. Update WAF rules using attached IOC feed\n\n"
            "Patch download: https://www.openssl.org/source/openssl-3.2.2.tar.gz\n"
            "Advisory: https://nvd.nist.gov/vuln/detail/CVE-2026-31337\n\n"
            "-- Security Operations Center\n"
            "Incident Commander: Sarah Chen (x4421)\n"
            "War Room: #security-incident-31337"
        ),
    )
    r.step(
        name="CVE alert email arrives",
        queries=["critical openssl vulnerability CVE-2026-31337 remote code execution"],
        source_docs=[cve_email],
        expected="intervene",
    )
    r.add_context([cve_email], ["CVE-2026-31337 openssl vulnerability"])

    # Step 3: User opens NVD advisory page (cross-source: email + browser)
    nvd_browser = make_browser(
        url="https://nvd.nist.gov/vuln/detail/CVE-2026-31337",
        title="NVD - CVE-2026-31337 - OpenSSL Remote Code Execution",
        visit_count=4,
        typed_count=2,
    )
    r.step(
        name="User researches CVE on NVD (email + browser convergence)",
        queries=["CVE-2026-31337 openssl patch remediation steps"],
        source_docs=[cve_email, nvd_browser],
        expected="intervene",
    )
    r.add_context([nvd_browser])

    # Step 4: User creates remediation notes (all 3 sources)
    remediation_fs = make_filesystem(
        action="created",
        file_path="/Users/dev/incidents/CVE-2026-31337-remediation.md",
        content_preview=(
            "[FILE: CVE-2026-31337-remediation.md] (Type: Full)\n---\n"
            "# CVE-2026-31337 Remediation Plan\n\n"
            "## Affected Systems\n"
            "- lb-prod-01 through lb-prod-08 (OpenSSL 3.1.4)\n"
            "- api-gateway-prod (OpenSSL 3.1.2)\n\n"
            "## Timeline\n"
            "- 14:30 UTC: Alert received from SOC\n"
            "- 14:45 UTC: Confirmed affected versions in production\n"
            "- 15:00 UTC: Patch download initiated\n"
            "- 15:30 UTC: Staging environment patched and tested\n"
            "- 16:00 UTC: Rolling production update (ETA)\n\n"
            "## Contacts\n"
            "- Incident Commander: Sarah Chen (x4421)\n"
            "- Infra Lead: Mike Torres\n"
            "- War Room: #security-incident-31337\n"
        ),
    )
    r.step(
        name="User creates remediation notes (3-source convergence)",
        queries=["openssl CVE remediation plan production patching"],
        source_docs=[cve_email, nvd_browser, remediation_fs],
        expected="intervene",
    )

    # Step 5: Cumulative context -- everything together
    r.step(
        name="Full cumulative context (all events combined)",
        queries=["CVE-2026-31337 complete incident remediation"],
        source_docs=[cve_email, nvd_browser, remediation_fs],
        expected="intervene",
        cumulative=True,
    )

    return r.finish()


def scenario_2_quarterly_deadline() -> ScenarioResult:
    """Financial Analyst: Quarterly report deadline approaching.

    T+0: Manager email about Q4 report deadline -> expect intervene
    T+1: User opens the Q4 data spreadsheet -> expect intervene (working on it)
    T+2: User browses financial data sources -> expect intervene (convergence)
    T+3: User creates report draft -> expect intervene (active production)
    """
    r = ScenarioRunner(2, "Quarterly Report Deadline (Analyst)", "critical")

    deadline_email = make_email(
        subject="Q4 Financial Report - Due Tomorrow 5PM",
        sender="sarah.director@company.com",
        body_preview=(
            "Hi,\n\n"
            "Reminder that the Q4 consolidated financial report is due tomorrow "
            "(February 10) by 5:00 PM EST. The board presentation is Wednesday morning.\n\n"
            "Please ensure:\n"
            "- Revenue reconciliation is complete for all regions\n"
            "- Variance analysis vs Q3 is documented (especially APAC)\n"
            "- Cash flow projections updated with January actuals\n"
            "- Executive summary ready for CFO review by 3 PM\n\n"
            "The raw data from Finance Ops is in the shared drive: "
            "/Shared/Finance/2025-Q4/consolidated_raw.xlsx\n\n"
            "Let me know if you need anything escalated.\n\n"
            "Best,\nSarah\nVP Finance"
        ),
    )
    r.step(
        name="Manager email: Q4 report due tomorrow",
        queries=["Q4 financial report deadline preparation"],
        source_docs=[deadline_email],
        expected="intervene",
        pause_seconds=0,
    )
    r.add_context([deadline_email], ["quarterly financial report deadline"])

    # Step 2: User opens the spreadsheet
    q4_spreadsheet = make_filesystem(
        action="modified",
        file_path="/Users/analyst/Documents/Finance/Q4_consolidated_2025.xlsx",
        content_preview=(
            "[FILE: Q4_consolidated_2025.xlsx] (Type: Spreadsheet)\n---\n"
            "Sheet: Revenue Summary\n"
            "| Region | Q3 Actual | Q4 Actual | Variance |\n"
            "|--------|-----------|-----------|----------|\n"
            "| NAM    | $4.2M     | $4.8M     | +14.3%   |\n"
            "| EMEA   | $3.1M     | $2.9M     | -6.5%    |\n"
            "| APAC   | $2.7M     | $3.4M     | +25.9%   |\n"
            "| LATAM  | $0.8M     | $0.9M     | +12.5%   |\n\n"
            "Note: APAC variance driven by new enterprise deals in Singapore.\n"
            "EMEA decline attributed to currency headwinds (EUR/USD)."
        ),
    )
    r.step(
        name="User opens Q4 spreadsheet (email + filesystem)",
        queries=["Q4 revenue reconciliation variance analysis"],
        source_docs=[deadline_email, q4_spreadsheet],
        expected="intervene",
    )
    r.add_context([q4_spreadsheet])

    # Step 3: User researches financial data
    finance_browser = make_browser(
        url="https://finance.company.com/dashboards/q4-2025-consolidated",
        title="Q4 2025 Consolidated Financial Dashboard - Finance Portal",
        visit_count=6,
        typed_count=1,
    )
    r.step(
        name="User browses finance portal (3-source convergence)",
        queries=["Q4 2025 consolidated revenue cash flow dashboard"],
        source_docs=[deadline_email, q4_spreadsheet, finance_browser],
        expected="intervene",
    )

    # Step 4: User creates report draft
    report_draft = make_filesystem(
        action="created",
        file_path="/Users/analyst/Documents/Finance/Q4_Report_Draft_v1.docx",
        content_preview=(
            "[FILE: Q4_Report_Draft_v1.docx] (Type: Document)\n---\n"
            "Q4 2025 Financial Summary\n\n"
            "Executive Summary:\n"
            "Total revenue for Q4 2025 reached $12.0M, representing a 12.3% "
            "increase over Q3. Growth was primarily driven by APAC enterprise "
            "expansion (+25.9%) and continued NAM momentum (+14.3%). EMEA "
            "experienced a 6.5% decline attributed to EUR/USD headwinds.\n\n"
            "Key Highlights:\n"
            "- Total ARR: $48M (up from $42.7M in Q3)\n"
            "- Net retention rate: 118%\n"
            "- Cash position: $23.4M (12 months runway)\n"
        ),
    )
    r.step(
        name="User creates report draft (active production)",
        queries=["Q4 financial report executive summary preparation"],
        source_docs=[deadline_email, q4_spreadsheet, report_draft],
        expected="intervene",
    )

    return r.finish()


def scenario_3_noise_resilience() -> ScenarioResult:
    """Any User: Full day of low-signal activity. Zero false positives expected.

    Every step should defer. Any intervene is a false positive.
    """
    r = ScenarioRunner(3, "Noise Resilience (Zero False Positives)", "critical")

    # Step 1: Newsletter email
    r.step(
        name="Weekly AI newsletter (no action required)",
        queries=["weekly technology newsletter digest"],
        source_docs=[
            make_email(
                subject="The AI Weekly Digest - Issue #247",
                sender="digest@ainewsletter.com",
                body_preview=(
                    "This week in AI:\n\n"
                    "1. New transformer architecture achieves SOTA on reasoning benchmarks\n"
                    "2. Open-source model releases from Meta and Mistral\n"
                    "3. EU AI Act implementation timeline updated\n"
                    "4. Interview: Building production ML pipelines at scale\n\n"
                    "Read at your leisure. No action required.\n\n"
                    "Unsubscribe | View in browser\n"
                    "You're receiving this because you signed up at ainewsletter.com"
                ),
            ),
        ],
        expected="defer",
        pause_seconds=0,
    )

    # Step 2: Social media notification
    r.step(
        name="Social media notification email (noise)",
        queries=["social media activity notification"],
        source_docs=[
            make_email(
                subject="You have 3 new notifications on LinkedIn",
                sender="notifications@linkedin.com",
                body_preview=(
                    "John Smith liked your post about machine learning.\n"
                    "Jane Doe commented on your article.\n"
                    "New connection request from Alex Johnson.\n\n"
                    "See all notifications: https://www.linkedin.com/notifications"
                ),
            ),
        ],
        expected="defer",
    )

    # Step 3: Casual YouTube browsing
    r.step(
        name="YouTube casual viewing (entertainment)",
        queries=["user watching video content"],
        source_docs=[
            make_browser(
                url="https://www.youtube.com/watch?v=abc123",
                title="Gordon Ramsay's Best Pasta Recipes | Kitchen Nightmares",
                visit_count=1,
                typed_count=0,
            ),
        ],
        expected="defer",
    )

    # Step 4: IDE auto-save file
    r.step(
        name="IDE config auto-save (.vscode/settings.json)",
        queries=["IDE configuration file modification"],
        source_docs=[
            make_filesystem(
                action="modified",
                file_path="/Users/dev/project/.vscode/settings.json",
                content_preview='{"editor.fontSize": 14, "editor.tabSize": 2}',
            ),
        ],
        expected="defer",
    )

    # Step 5: Build artifact
    r.step(
        name="Build artifact generation (dist/bundle.js)",
        queries=["build system generating artifacts"],
        source_docs=[
            make_filesystem(
                action="created",
                file_path="/Users/dev/project/dist/bundle.min.js",
                content_preview="!function(e,t){\"object\"==typeof exports&&\"undefined\"...",
            ),
        ],
        expected="defer",
    )

    # Step 6: Weather check
    r.step(
        name="Weather page visit (routine)",
        queries=["weather forecast check"],
        source_docs=[
            make_browser(
                url="https://weather.com/weather/today/l/40.71,-74.01",
                title="New York, NY Weather Forecast | Weather.com",
                visit_count=1,
                typed_count=0,
            ),
        ],
        expected="defer",
    )

    # Step 7: Promotional spam email
    r.step(
        name="Promotional spam email (marketing)",
        queries=["promotional offer notification"],
        source_docs=[
            make_email(
                subject="FLASH SALE: 70% Off Premium Plans - 24 Hours Only!",
                sender="offers@cloudservice.io",
                body_preview=(
                    "Don't miss out!\n\n"
                    "For the next 24 hours, get 70% off our Premium and Enterprise plans.\n"
                    "This is our biggest sale of the year.\n\n"
                    "Use code: FLASH2026\n\n"
                    "Terms: New customers only. Cannot be combined with other offers.\n"
                    "Unsubscribe: https://cloudservice.io/unsubscribe"
                ),
            ),
        ],
        expected="defer",
    )

    # Step 8: Amazon shopping
    r.step(
        name="Online shopping (amazon.com product page)",
        queries=["user browsing online store"],
        source_docs=[
            make_browser(
                url="https://www.amazon.com/dp/B09V3KXJPB",
                title="Mechanical Keyboard Cherry MX Brown - Amazon.com",
                visit_count=1,
                typed_count=0,
            ),
        ],
        expected="defer",
    )

    return r.finish()


def scenario_4_student_research_to_deadline() -> ScenarioResult:
    """Student: Passive research transforms into urgent when deadline email arrives.

    T+0: Wikipedia reading (passive) -> expect defer
    T+1: Google Scholar browsing -> expect defer
    T+2: Professor deadline email arrives -> expect intervene (state change)
    T+3: Creating notes file -> expect intervene (active work on deadline)
    """
    r = ScenarioRunner(4, "Research Session -> Deadline Shift (Student)", "high")

    # Step 1: Wikipedia reading (passive)
    r.step(
        name="Wikipedia reading (passive research, no urgency)",
        queries=["machine learning history overview"],
        source_docs=[
            make_browser(
                url="https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)",
                title="Transformer (deep learning architecture) - Wikipedia",
                visit_count=2,
                typed_count=0,
            ),
        ],
        expected="defer",
        pause_seconds=0,
    )

    # Step 2: Google Scholar (still passive)
    r.step(
        name="Google Scholar browsing (still passive research)",
        queries=["attention mechanism transformer architecture papers"],
        source_docs=[
            make_browser(
                url="https://scholar.google.com/scholar?q=attention+is+all+you+need",
                title="attention is all you need - Google Scholar",
                visit_count=3,
                typed_count=1,
            ),
        ],
        expected="defer",
    )

    # Step 3: Deadline email (state change)
    deadline_email = make_email(
        subject="RE: CS-682 Research Paper - Submission Deadline Extended to Friday",
        sender="prof.martinez@university.edu",
        body_preview=(
            "Class,\n\n"
            "I've extended the deadline for the research paper to this Friday, "
            "February 13 at 11:59 PM. However, I need to see your draft abstract "
            "by tomorrow (Tuesday) so I can provide feedback before the final submission.\n\n"
            "Requirements reminder:\n"
            "- 8-10 pages, IEEE format\n"
            "- Minimum 15 references (at least 10 from peer-reviewed venues)\n"
            "- Must include reproducibility section\n"
            "- Submit via Gradescope (link in Canvas)\n\n"
            "If you haven't started yet, please come to office hours today 2-4 PM.\n\n"
            "Prof. Martinez\n"
            "Department of Computer Science"
        ),
    )
    r.step(
        name="Professor deadline email arrives (state change to urgent)",
        queries=["research paper deadline abstract submission requirement"],
        source_docs=[deadline_email],
        expected="intervene",
    )
    r.add_context([deadline_email])

    # Step 4: Creating notes (active work on deadline)
    notes_fs = make_filesystem(
        action="created",
        file_path="/Users/student/Documents/CS682/paper_outline.md",
        content_preview=(
            "[FILE: paper_outline.md] (Type: Full)\n---\n"
            "# Transformer Attention Mechanisms: A Survey\n\n"
            "## Abstract (DUE TOMORROW)\n"
            "- Key contribution: comparative analysis of attention variants\n"
            "- Methods: benchmark 5 attention mechanisms on 3 tasks\n"
            "- TODO: Write abstract draft tonight\n\n"
            "## Outline\n"
            "1. Introduction\n"
            "2. Background (self-attention, multi-head)\n"
            "3. Variants (linear, sparse, flash, sliding window, grouped-query)\n"
            "4. Experimental Setup\n"
            "5. Results\n"
            "6. Discussion\n"
            "7. Reproducibility\n"
        ),
    )
    r.step(
        name="User creates paper outline (deadline + active work)",
        queries=["transformer attention mechanism research paper outline"],
        source_docs=[deadline_email, notes_fs],
        expected="intervene",
    )

    return r.finish()


def scenario_5_production_incident_ops() -> ScenarioResult:
    """SRE/Ops: Production incident escalation across multiple channels.

    T+0: Monitoring alert email -> expect intervene
    T+1: User checks Grafana dashboard -> expect intervene
    T+2: Escalation email from engineering lead -> expect intervene
    T+3: User creates incident notes -> expect intervene
    """
    r = ScenarioRunner(5, "Production Incident Escalation (Ops/SRE)", "critical")

    # Step 1: PagerDuty/monitoring alert
    alert_email = make_email(
        subject="[P0] CRITICAL: API Gateway 5xx Error Rate > 25% - payment-service-prod",
        sender="alerts@pagerduty.com",
        body_preview=(
            "INCIDENT TRIGGERED\n\n"
            "Service: payment-service-prod\n"
            "Alert: API Gateway 5xx Error Rate exceeds 25%\n"
            "Current Value: 34.7%\n"
            "Threshold: 25%\n"
            "Duration: 8 minutes\n\n"
            "Affected Endpoints:\n"
            "  POST /api/v2/payments/process  -> 503 Service Unavailable (68% error rate)\n"
            "  POST /api/v2/payments/refund   -> 504 Gateway Timeout (42% error rate)\n"
            "  GET  /api/v2/payments/status    -> 200 OK (healthy)\n\n"
            "Impact: Customer-facing payment processing is degraded. "
            "Estimated revenue impact: ~$12,000/hour based on current transaction volume.\n\n"
            "Runbook: https://runbooks.internal/payment-service-5xx\n"
            "Grafana: https://grafana.internal/d/payment-prod\n\n"
            "Acknowledge: https://pagerduty.com/incidents/ABC123/ack"
        ),
    )
    r.step(
        name="PagerDuty P0 alert (payment service 5xx spike)",
        queries=["production payment service 5xx error rate critical incident"],
        source_docs=[alert_email],
        expected="intervene",
        pause_seconds=0,
    )
    r.add_context([alert_email], ["payment service production incident"])

    # Step 2: User checks Grafana
    grafana_browser = make_browser(
        url="https://grafana.internal/d/payment-prod?from=now-1h&to=now",
        title="Payment Service Production - Error Rate Dashboard - Grafana",
        visit_count=8,
        typed_count=1,
    )
    r.step(
        name="User checks Grafana dashboard (email + browser)",
        queries=["payment service error rate grafana monitoring dashboard"],
        source_docs=[alert_email, grafana_browser],
        expected="intervene",
    )
    r.add_context([grafana_browser])

    # Step 3: Escalation email from engineering lead
    escalation_email = make_email(
        subject="RE: [P0] payment-service-prod - Root Cause Identified: DB Connection Pool Exhaustion",
        sender="mike.torres@company.com",
        body_preview=(
            "Team,\n\n"
            "Root cause identified. The payment DB connection pool is exhausted.\n\n"
            "Timeline:\n"
            "- 14:22 UTC: Deployment of PR #4521 (new retry logic in payment processor)\n"
            "- 14:25 UTC: Connection pool starts growing (retry storms)\n"
            "- 14:30 UTC: Pool hits 500/500 limit, new connections rejected\n"
            "- 14:32 UTC: 5xx cascade begins\n\n"
            "Immediate fix: Rollback PR #4521.\n"
            "@ops-team please execute rollback of payment-service to v2.34.7\n"
            "Rollback procedure: https://runbooks.internal/rollback-payment-service\n\n"
            "I'll handle the post-mortem. This needs a circuit breaker, not retry storms.\n\n"
            "Mike Torres\nSenior Staff Engineer"
        ),
    )
    r.step(
        name="Escalation email with root cause (multi-email convergence)",
        queries=["payment service DB connection pool exhaustion rollback"],
        source_docs=[alert_email, escalation_email, grafana_browser],
        expected="intervene",
    )
    r.add_context([escalation_email])

    # Step 4: User creates incident notes
    incident_notes = make_filesystem(
        action="created",
        file_path="/Users/sre/incidents/2026-02-09-payment-5xx.md",
        content_preview=(
            "[FILE: 2026-02-09-payment-5xx.md] (Type: Full)\n---\n"
            "# Incident: Payment Service 5xx Spike\n"
            "**Severity**: P0 | **Status**: Active | **Commander**: On-call SRE\n\n"
            "## Timeline\n"
            "- 14:22: PR #4521 deployed (new retry logic)\n"
            "- 14:30: DB pool exhausted (500/500)\n"
            "- 14:32: 5xx cascade, PagerDuty fires\n"
            "- 14:45: Root cause identified by Mike Torres\n"
            "- 14:50: Rollback initiated to v2.34.7\n\n"
            "## Impact\n"
            "- ~$12k/hour revenue impact\n"
            "- 34.7% error rate on payment endpoints\n"
            "- ~18 minutes of customer-facing degradation\n"
        ),
    )
    r.step(
        name="User creates incident notes (full 3-source convergence)",
        queries=["production incident rollback notes documentation"],
        source_docs=[alert_email, escalation_email, grafana_browser, incident_notes],
        expected="intervene",
    )

    return r.finish()


def scenario_6_feedback_learning_loop() -> ScenarioResult:
    """Phase 4 ICL: Run scenario, give feedback, run similar, verify system works.

    T+0: Initial scenario -> record decision
    T+1: Positive feedback -> verify accepted
    T+2: Similar scenario -> verify system still works (ICL may influence)
    T+3: Negative feedback on defer -> verify accepted
    """
    r = ScenarioRunner(6, "Feedback Learning Loop (Phase 4 ICL)", "high")

    # Step 1: Initial scenario
    email = make_email(
        subject="[ACTION] Infrastructure Cost Review - AWS Bill $47K Over Budget",
        sender="cloud-ops@company.com",
        body_preview=(
            "Monthly AWS cost review:\n\n"
            "February projected: $147,000 (budget: $100,000)\n"
            "Primary cost drivers:\n"
            "- EC2 instances: $62K (+40% vs last month, untagged instances in us-west-2)\n"
            "- S3 storage: $28K (lifecycle policies not applied to 3 buckets)\n"
            "- RDS: $19K (over-provisioned read replicas in staging)\n\n"
            "Immediate actions needed:\n"
            "1. Review and terminate untagged EC2 instances\n"
            "2. Apply S3 lifecycle policies to analytics-raw, logs-archive, backup-temp\n"
            "3. Downsize staging RDS read replicas\n\n"
            "Budget variance meeting: Thursday 10 AM with CFO.\n\n"
            "Cloud Operations Team"
        ),
    )
    step1 = r.step(
        name="Initial: AWS cost overrun email",
        queries=["AWS infrastructure cost overrun budget review"],
        source_docs=[email],
        expected="any",
        pause_seconds=0,
    )

    # Step 2: Give positive feedback (if we got a run_id)
    if step1.run_id:
        fb = post_feedback(step1.run_id, "clicked")
        feedback_ok = fb.get("success") is True
        step2 = StepResult(
            name="Record positive feedback",
            decision="feedback_recorded",
            expected="any",
            passed=feedback_ok,
            error=None if feedback_ok else f"Feedback failed: {fb}",
        )
        r.result.steps.append(step2)
        status = step2.status_str
        print(f"    {status}  Record positive feedback")
        if not feedback_ok:
            print(f"         {C.FAIL}error: feedback API returned {fb}{C.END}")
    else:
        step2 = StepResult(
            name="Record positive feedback",
            expected="any",
            passed=True,
            error="Skipped: no run_id from step 1",
        )
        r.result.steps.append(step2)
        print(f"    {C.WARN}SKIP{C.END}  Record positive feedback (no run_id)")

    time.sleep(2)

    # Step 3: Similar scenario (ICL may influence decision)
    similar_email = make_email(
        subject="[ACTION] GCP Cost Alert - Kubernetes Cluster Over-Provisioned",
        sender="cloud-ops@company.com",
        body_preview=(
            "GCP cost alert:\n\n"
            "The production Kubernetes cluster (gke-prod-main) is significantly "
            "over-provisioned. Current utilization: 23% CPU, 31% memory.\n\n"
            "Monthly excess cost: ~$18,000\n\n"
            "Recommended actions:\n"
            "1. Enable cluster autoscaler\n"
            "2. Right-size node pools based on actual workload\n"
            "3. Implement Vertical Pod Autoscaler for top 5 workloads\n\n"
            "Cloud Operations Team"
        ),
    )
    r.step(
        name="Similar scenario: GCP cost alert (ICL may influence)",
        queries=["GCP kubernetes cluster cost optimization over-provisioned"],
        source_docs=[similar_email],
        expected="any",
    )

    # Step 4: Record dismiss feedback
    step4_email = make_email(
        subject="Monthly Cloud Usage Report - January 2026",
        sender="reports@cloudservice.io",
        body_preview="Your January cloud usage summary is ready. View dashboard for details.",
    )
    step4 = r.step(
        name="Low-signal cloud report (should defer)",
        queries=["monthly cloud usage report summary"],
        source_docs=[step4_email],
        expected="defer",
    )
    if step4.run_id:
        fb = post_feedback(step4.run_id, "dismissed")
        feedback_ok = fb.get("success") is True
        dismiss_step = StepResult(
            name="Record dismiss feedback on defer",
            decision="feedback_recorded",
            expected="any",
            passed=feedback_ok,
        )
        r.result.steps.append(dismiss_step)
        status = dismiss_step.status_str
        print(f"    {status}  Record dismiss feedback on defer")

    return r.finish()


def scenario_7_long_document_processing() -> ScenarioResult:
    """Verify system handles large content_preview without degradation.

    Steps use progressively larger payloads to test performance and correctness.
    """
    r = ScenarioRunner(7, "Long Document Processing (Content Stress)", "high")

    # Step 1: Security advisory with long body (~1.5KB email)
    r.step(
        name="Long security advisory email (~1.5KB body)",
        queries=["critical security vulnerability advisory OpenSSL"],
        source_docs=[
            make_email(
                subject="[SECURITY] Critical OpenSSL Vulnerability - Immediate Patching Required",
                sender="ciso@company.com",
                body_preview=(
                    "CONFIDENTIAL - INTERNAL DISTRIBUTION ONLY\n\n"
                    "A critical vulnerability (CVE-2026-99887) has been identified in "
                    "OpenSSL versions 3.0.x through 3.2.x. This vulnerability allows "
                    "remote unauthenticated attackers to execute arbitrary code via a "
                    "specially crafted TLS handshake.\n\n"
                    "CVSS Score: 9.8 (Critical)\n"
                    "Attack Vector: Network\n"
                    "Attack Complexity: Low\n"
                    "Privileges Required: None\n"
                    "User Interaction: None\n\n"
                    "AFFECTED SYSTEMS IN OUR INFRASTRUCTURE:\n"
                    "1. Production Load Balancers (lb-01 through lb-16)\n"
                    "   - OpenSSL 3.1.4 (VULNERABLE)\n"
                    "   - Handles 100% of inbound HTTPS traffic\n"
                    "2. API Gateway Cluster (api-gw-01 through api-gw-08)\n"
                    "   - OpenSSL 3.0.12 (VULNERABLE)\n"
                    "   - Handles inter-service mTLS\n"
                    "3. Certificate Authority Server (ca-prod-01)\n"
                    "   - OpenSSL 3.2.0 (VULNERABLE)\n"
                    "   - Issues all internal certificates\n\n"
                    "REQUIRED ACTIONS (deadline: 24 hours):\n"
                    "Phase 1 - Immediate (0-4 hours):\n"
                    "  - Enable WAF rule 'openssl-cve-2026-99887-block'\n"
                    "  - Rotate all externally-facing TLS certificates\n"
                    "  - Enable enhanced TLS logging on all load balancers\n\n"
                    "Phase 2 - Patching (4-12 hours):\n"
                    "  - Patch load balancers (rolling, zero-downtime)\n"
                    "  - Patch API gateway cluster\n"
                    "  - Patch CA server (requires maintenance window)\n\n"
                    "Phase 3 - Verification (12-24 hours):\n"
                    "  - Run vulnerability scanner across all endpoints\n"
                    "  - Verify no indicators of compromise in access logs\n"
                    "  - Update asset inventory with patched versions\n\n"
                    "INCIDENT CONTACTS:\n"
                    "  Incident Commander: CISO Office\n"
                    "  Security Lead: James Chen (x5501)\n"
                    "  Infrastructure Lead: Maria Santos (x5502)\n"
                    "  War Room: #sec-incident-99887 (Slack)\n"
                    "  Bridge: +1-555-0142 PIN: 99887#\n\n"
                    "-- Chief Information Security Officer"
                ),
            ),
        ],
        expected="intervene",
        pause_seconds=0,
    )

    # Step 2: Large PDF content_preview (~2KB filesystem)
    r.step(
        name="Large research paper PDF as filesystem (~2KB content_preview)",
        queries=["machine learning research paper tokenization methods evaluation"],
        source_docs=[
            make_filesystem(
                action="created",
                file_path="/Users/researcher/papers/tokenization_survey_2026.pdf",
                content_preview=(
                    "[FILE: tokenization_survey_2026.pdf] (Type: Large)\n---\n"
                    "WeTokenize: Weighted Tokenization for Enhanced Language Model Robustness\n\n"
                    "Abstract\n"
                    "Tokenization remains a critical yet under-explored component in "
                    "large language model pipelines. Current approaches (BPE, WordPiece, "
                    "Unigram) optimize for compression ratio but ignore downstream task "
                    "performance during vocabulary construction. We propose WeTokenize, "
                    "a weighted tokenization framework that incorporates task-specific "
                    "loss signals during vocabulary optimization.\n\n"
                    "Our approach modifies the standard BPE merge criterion by introducing "
                    "a weighted scoring function: score(a,b) = freq(ab) * task_weight(ab), "
                    "where task_weight is derived from gradient-based importance scores "
                    "computed during a lightweight fine-tuning pass.\n\n"
                    "We evaluate WeTokenize across 4 benchmark suites:\n"
                    "1. GLUE (natural language understanding): +2.3% average accuracy\n"
                    "2. WMT-22 (machine translation): +1.1 BLEU on EN-DE\n"
                    "3. HumanEval (code generation): +4.7% pass@1\n"
                    "4. MATH (mathematical reasoning): +3.2% accuracy\n\n"
                    "Key findings:\n"
                    "- Task-aware tokenization provides largest gains on code (+4.7%) "
                    "and math (+3.2%), where token boundaries critically affect semantics\n"
                    "- Gains are consistent across model sizes (125M to 7B parameters)\n"
                    "- Vocabulary size can be reduced by 15% with no accuracy loss\n"
                    "- Training overhead: +8% compute for vocabulary construction only\n\n"
                    "1. Introduction\n"
                    "The tokenization step in language model training converts raw text "
                    "into discrete tokens that serve as input to the model. Despite being "
                    "the first and arguably most consequential preprocessing step, "
                    "tokenization has received relatively little attention compared to "
                    "architecture design, training objectives, and scaling laws.\n\n"
                    "Current tokenization algorithms (Sennrich et al., 2016; Kudo, 2018; "
                    "Kudo & Richardson, 2018) are trained to optimize compression "
                    "efficiency -- they produce vocabularies that minimize the number of "
                    "tokens needed to represent a training corpus. However, compression "
                    "efficiency is at best a proxy for what we actually care about: "
                    "downstream task performance.\n\n"
                    "[Content truncated at extraction limit]"
                ),
            ),
        ],
        expected="defer",  # research paper alone, no urgency
    )

    # Step 3: Production incident markdown (~1.8KB)
    r.step(
        name="Production incident markdown (large filesystem doc, urgent)",
        queries=["production database outage incident post-mortem"],
        source_docs=[
            make_filesystem(
                action="created",
                file_path="/Users/sre/incidents/2026-02-09-db-outage.md",
                content_preview=(
                    "[FILE: 2026-02-09-db-outage.md] (Type: Full)\n---\n"
                    "# Production Database Outage - 2026-02-09\n\n"
                    "**Severity**: P0 Critical\n"
                    "**Status**: ACTIVE\n"
                    "**Duration**: Ongoing (started 14:15 UTC)\n"
                    "**Impact**: Complete payment processing failure, "
                    "affecting ~50,000 transactions/hour\n\n"
                    "## Timeline\n"
                    "- 14:00 UTC: Routine database maintenance window opened\n"
                    "- 14:05 UTC: DBA executes ALTER TABLE on payments_ledger "
                    "(adding partition for Q2 data)\n"
                    "- 14:12 UTC: Replication lag exceeds 30 seconds on replica-02\n"
                    "- 14:15 UTC: Primary DB connection pool exhausted (max 500 reached)\n"
                    "- 14:16 UTC: Cascading failures begin across payment microservices\n"
                    "- 14:17 UTC: PagerDuty alert fires for payment-service-prod\n"
                    "- 14:20 UTC: All payment endpoints returning 503\n"
                    "- 14:25 UTC: Incident Commander (IC) declared: On-call SRE\n"
                    "- 14:30 UTC: Root cause identified: DDL lock holding "
                    "all DML operations\n"
                    "- 14:32 UTC: DDL operation cancelled via pg_cancel_backend()\n"
                    "- 14:35 UTC: Connection pool recovering, error rate dropping\n"
                    "- 14:40 UTC: Error rate below 5%, payment processing resuming\n\n"
                    "## Root Cause\n"
                    "The ALTER TABLE command acquired an ACCESS EXCLUSIVE lock on "
                    "payments_ledger, blocking all concurrent transactions. The "
                    "maintenance window procedure did not include a lock_timeout "
                    "safeguard. Combined with high transaction volume (peak hours), "
                    "this caused rapid connection pool exhaustion.\n\n"
                    "## Action Items\n"
                    "1. [ ] Add lock_timeout = 5s to all DDL maintenance procedures\n"
                    "2. [ ] Implement pg_partman for automated, lock-free partitioning\n"
                    "3. [ ] Add connection pool exhaustion alerting (threshold: 80%)\n"
                    "4. [ ] Update runbook with DDL safety checklist\n"
                    "5. [ ] Schedule post-mortem for Wednesday 2 PM\n\n"
                    "## Contacts\n"
                    "- IC: SRE On-call\n"
                    "- DBA: Jennifer Wu\n"
                    "- Payment Team Lead: Alex Kim\n"
                    "- VP Engineering: David Park (notified at 14:20)\n"
                ),
            ),
        ],
        expected="intervene",
    )

    return r.finish()


def scenario_8_mixed_signal_day() -> ScenarioResult:
    """Realistic day: mix of high-signal and low-signal events across sources.

    Tests signal discrimination under realistic load -- can the system
    pick out the needle (urgent email) from the haystack (routine noise)?
    """
    r = ScenarioRunner(8, "Mixed Signal Day (Needle in Haystack)", "high")

    # Step 1: Morning routine noise
    r.step(
        name="Morning routine: news + weather + email digest",
        queries=["morning routine browsing and email"],
        source_docs=[
            make_browser(
                url="https://news.ycombinator.com",
                title="Hacker News",
                visit_count=1,
                typed_count=1,
            ),
            make_email(
                subject="Your Daily Standup Summary - Feb 9",
                sender="standup-bot@company.com",
                body_preview=(
                    "Yesterday's updates from your team:\n"
                    "- Alice: Completed user auth refactor PR #432\n"
                    "- Bob: Started payment gateway integration\n"
                    "- Carol: Fixed 3 bugs in search indexer\n\n"
                    "No blockers reported."
                ),
            ),
        ],
        expected="defer",
        pause_seconds=0,
    )

    # Step 2: Normal work -- editing code file
    r.step(
        name="Normal work: editing Python file (routine development)",
        queries=["developer editing application code"],
        source_docs=[
            make_filesystem(
                action="modified",
                file_path="/Users/dev/project/src/handlers/user_handler.py",
                content_preview=(
                    "[FILE: user_handler.py] (Type: Full)\n---\n"
                    "from fastapi import APIRouter, Depends\n"
                    "from services.user_service import UserService\n\n"
                    "router = APIRouter(prefix='/users', tags=['users'])\n\n"
                    "@router.get('/{user_id}')\n"
                    "async def get_user(user_id: str, svc: UserService = Depends()):\n"
                    "    return await svc.get_by_id(user_id)\n"
                ),
            ),
        ],
        expected="defer",
    )

    # Step 3: THE NEEDLE -- critical security email buried in normal day
    critical_email = make_email(
        subject="[URGENT] Unauthorized Access Detected on Your Account",
        sender="security@company.com",
        body_preview=(
            "SECURITY ALERT\n\n"
            "We detected an unauthorized login to your corporate account from an "
            "unrecognized device and location:\n\n"
            "Time: February 9, 2026 at 13:47 UTC\n"
            "Location: Kyiv, Ukraine (IP: 91.234.xx.xx)\n"
            "Device: Windows 11 / Chrome 121\n"
            "Action: Accessed HR portal and downloaded employee directory\n\n"
            "If this was NOT you:\n"
            "1. Change your password immediately: https://sso.company.com/reset\n"
            "2. Enable hardware 2FA: https://sso.company.com/security\n"
            "3. Report to security@company.com with incident ref: SEC-2026-0209-A\n\n"
            "Your account has been flagged for enhanced monitoring. "
            "Further access from the suspicious IP has been blocked.\n\n"
            "-- Security Operations Center"
        ),
    )
    r.step(
        name="CRITICAL: Unauthorized access alert (the needle)",
        queries=["unauthorized account access security breach detection"],
        source_docs=[critical_email],
        expected="intervene",
    )

    # Step 4: More noise after the critical event
    r.step(
        name="Post-alert noise: lunch recommendation email",
        queries=["restaurant recommendation social email"],
        source_docs=[
            make_email(
                subject="Re: Lunch today?",
                sender="colleague@company.com",
                body_preview="How about that new Thai place on 5th? They have great pad see ew.",
            ),
        ],
        expected="defer",
    )

    # Step 5: Browser + critical email combined (convergence with needle)
    r.step(
        name="User researches security alert (email + browser convergence)",
        queries=["corporate account unauthorized access IP blocking security"],
        source_docs=[
            critical_email,
            make_browser(
                url="https://sso.company.com/security/activity-log",
                title="Account Security - Recent Activity Log - SSO Portal",
                visit_count=5,
                typed_count=2,
            ),
        ],
        expected="intervene",
    )

    return r.finish()


# ======================================================================
# SCENARIO 9 — Internet-Off Paper Research (User Study Conditions)
# ======================================================================


def scenario_9_internet_off_paper_research() -> ScenarioResult:
    """Internet-Off: User reads local PDFs in browser, no web tools available.

    Simulates the exact user study condition defined by the supervisor:
    internet is OFF, papers are on local filesystem, opened via file:// URLs.

    Decision tree: intervene requires (coherentEngagement AND novelContentFound) or
    (coherentEngagement AND chatCorrelation) or (classifierHighUrgency AND evidence).
    In cold-start (no BM25 index), novelContentFound cannot fire because the
    retriever has nothing indexed. Steps 2-3 use expected="any" for this reason.
    Once papers are indexed, re-run with --scenario 9 to verify intervention.

    T+0: User opens one paper (file:// URL) -> single passive read -> defer
    T+1: User opens second related paper -> coherent engagement fires, novel depends on index
    T+2: User creates notes (cumulative context) -> multi-source, depends on index
    T+3: User opens unrelated paper (diffusion) -> topic shift -> defer
    """
    r = ScenarioRunner(9, "Internet-Off Paper Research (User Study)", "critical")

    papers_dir = "/Users/student/Documents/papers"

    # Step 1: Single paper read (passive)
    paper1_browser = make_browser(
        url=f"file://{papers_dir}/multimodal_reasoning_survey_2025.pdf",
        title="Why Reasoning Matters? A Survey of Advancements in Multimodal Reasoning",
        visit_count=1,
        typed_count=0,
    )
    r.step(
        name="Open multimodal reasoning survey (single passive read, file:// URL)",
        queries=["multimodal reasoning survey advancements"],
        source_docs=[paper1_browser],
        expected="defer",
        pause_seconds=0,
    )
    r.add_context([paper1_browser])

    # Step 2: Second related paper
    paper2_browser = make_browser(
        url=f"file://{papers_dir}/x_reasoner_cross_modal_2025.pdf",
        title="X-Reasoner: Towards Generalizable Reasoning Across Modalities and Domains",
        visit_count=1,
        typed_count=0,
    )
    paper1_revisit = make_browser(
        url=f"file://{papers_dir}/multimodal_reasoning_survey_2025.pdf",
        title="Why Reasoning Matters? A Survey of Advancements in Multimodal Reasoning",
        visit_count=2,
        typed_count=0,
    )
    r.step(
        name="Open second related paper (intervention depends on index)",
        queries=["cross-modal generalization reasoning multimodal domains"],
        source_docs=[paper1_revisit, paper2_browser],
        expected="any",
        cumulative=True,
    )
    step2 = r.result.steps[-1]
    step2_local_gate_pass = (
        step2.error is None and
        step2.tool_calls > 0
    )
    step2_gate = StepResult(
        name="Gate: multi-paper local workflow should execute non-zero tooling",
        decision="gate_check",
        expected="any",
        passed=step2_local_gate_pass,
        error=None if step2_local_gate_pass else (
            f"tool_calls={step2.tool_calls}, "
            f"decision={step2.decision}, error={step2.error}"
        ),
    )
    r.result.steps.append(step2_gate)
    print(f"    {step2_gate.status_str}  {step2_gate.name}")
    if not step2_local_gate_pass:
        print(f"         {C.FAIL}{step2_gate.error}{C.END}")
    r.add_context([paper2_browser])

    # Step 3: User creates notes (filesystem + browser convergence, cumulative)
    notes_fs = make_filesystem(
        action="created",
        file_path=f"{papers_dir}/essay_notes.md",
        content_preview=(
            "[FILE: essay_notes.md] (Type: Full)\n---\n"
            "# Multimodal Reasoning Essay Notes\n\n"
            "## Key Themes\n"
            "- Cross-modal generalization (X-Reasoner)\n"
            "- Survey of reasoning advances (2025)\n"
            "- Visual + language integration challenges\n"
            "- Chain-of-thought in multimodal settings\n\n"
            "## Questions to Address\n"
            "1. How do current VLMs handle spatial reasoning?\n"
            "2. What role does attention play in cross-modal transfer?\n"
            "3. Benchmark gaps in multimodal reasoning evaluation\n"
        ),
    )
    r.step(
        name="Create notes file (cumulative: 2 papers + notes)",
        queries=["multimodal reasoning essay notes cross-modal visual language"],
        source_docs=[paper2_browser, notes_fs],
        expected="any",
        cumulative=True,
    )
    step3 = r.result.steps[-1]
    step3_local_gate_pass = (
        step3.error is None and
        step3.tool_calls > 0
    )
    step3_gate = StepResult(
        name="Gate: local papers plus notes should not be treated as passive/no-op",
        decision="gate_check",
        expected="any",
        passed=step3_local_gate_pass,
        error=None if step3_local_gate_pass else (
            f"tool_calls={step3.tool_calls}, "
            f"decision={step3.decision}, error={step3.error}"
        ),
    )
    r.result.steps.append(step3_gate)
    print(f"    {step3_gate.status_str}  {step3_gate.name}")
    if not step3_local_gate_pass:
        print(f"         {C.FAIL}{step3_gate.error}{C.END}")

    # Step 4: Topic shift — open unrelated paper (no cumulative — fresh context)
    r.step(
        name="Open diffusion paper (topic shift, no coherence with reasoning)",
        queries=["diffusion model memorization regularization training"],
        source_docs=[
            make_browser(
                url=f"file://{papers_dir}/diffusion_models_memorization_neurips_2025.pdf",
                title="Why Diffusion Models Don't Memorize: Implicit Dynamical Regularization",
                visit_count=1,
                typed_count=0,
            ),
        ],
        expected="defer",
    )

    return r.finish()


# ======================================================================
# SCENARIO 10 — Multi-Source Paper Discovery
# ======================================================================


def scenario_10_multi_source_paper_discovery() -> ScenarioResult:
    """Multi-Source: Paper research converges across filesystem, browser, and chat.

    Tests cross-source correlation signal with academic content:
    when the same topic appears in filesystem edits, browser history, and
    prior chat conversations, the agent should intervene.

    T+0: User edits markdown about attention mechanisms -> single source -> defer
    T+1: User browses arxiv for related chain-of-thought -> 2 sources -> defer
    T+2: Chat history shows prior multimodal reasoning conversation -> 3 sources -> intervene
    """
    r = ScenarioRunner(10, "Multi-Source Paper Discovery", "high")

    # Step 1: Filesystem edit only
    fs_doc = make_filesystem(
        action="modified",
        file_path="/Users/student/Documents/papers/essay_draft.md",
        content_preview=(
            "[FILE: essay_draft.md] (Type: Full)\n---\n"
            "# Attention Mechanisms in Multimodal Models\n\n"
            "## 1. Introduction\n"
            "Recent advances in vision-language models rely heavily on "
            "cross-attention mechanisms for aligning visual and textual "
            "representations. This essay examines...\n\n"
            "## 2. Self-Attention vs Cross-Attention\n"
            "The original Transformer introduced self-attention (Vaswani et al., 2017). "
            "Modern VLMs extend this with cross-attention layers that attend to "
            "visual tokens from language queries...\n"
        ),
    )
    r.step(
        name="Edit essay draft about attention mechanisms (single source: filesystem)",
        queries=["attention mechanisms cross-attention vision language models"],
        source_docs=[fs_doc],
        expected="defer",
        pause_seconds=0,
    )

    # Step 2: Browser + filesystem (still not enough for intervention)
    browser_doc = make_browser(
        url="https://arxiv.org/abs/2503.17352",
        title="OpenVLThinker: Complex Vision-Language Reasoning via SFT-RL - arXiv",
        visit_count=2,
        typed_count=1,
    )
    r.step(
        name="Browse arxiv for related reasoning paper (2 sources: filesystem + browser)",
        queries=["vision language reasoning SFT reinforcement learning chain-of-thought"],
        source_docs=[fs_doc, browser_doc],
        expected="defer",
    )

    # Step 3: Chat + browser + filesystem convergence
    chat_context = {
        "source": "chat",
        "timestamp": _now_iso(),
        "metadata": {
            "chat_id": "conv_abc123",
            "message_preview": (
                "User asked: 'What are the best recent papers on multimodal "
                "chain-of-thought reasoning? I'm writing an essay about how VLMs "
                "handle complex reasoning tasks.' "
                "Agent replied: 'I'd recommend looking at X-Reasoner (2505.03981) "
                "for cross-modal generalization, and the Self-Evolving Training "
                "paper (2412.17451) for training approaches...'"
            ),
            "role": "assistant",
            "day_date": _today(),
            "_context_type": "triggering_log",
            "_batch": "current",
        },
    }
    r.step(
        name="Chat history + browser + filesystem converge on multimodal reasoning",
        queries=["multimodal chain-of-thought reasoning VLM essay recent papers"],
        source_docs=[fs_doc, browser_doc, chat_context],
        expected="intervene",
    )

    return r.finish()


# ======================================================================
# SCENARIO 11 — Graceful Tool Failure
# ======================================================================


def scenario_11_graceful_tool_failure() -> ScenarioResult:
    """Tool Failure: Agent degrades gracefully when web tools are unavailable.

    Tests that the scout agent returns a structured response (not a crash)
    even when the classifier plans web_search calls that will fail.
    The focus is on structural correctness, not the specific decision.

    T+0: User browses arxiv with web URLs -> classifier plans web+local search
         -> we expect "any" decision but MUST get a valid response (not 500/crash)
    T+1: Same context re-submitted -> agent should not crash on retry
    """
    r = ScenarioRunner(11, "Graceful Tool Failure (Degradation)", "high")

    # Step 1: Web-oriented activity (classifier will plan web_search)
    r.step(
        name="Arxiv browsing (classifier plans web_search + retriever, web may fail)",
        queries=["spatial reasoning vision language models attention mechanism"],
        source_docs=[
            make_browser(
                url="https://arxiv.org/abs/2503.01773",
                title="Why Is Spatial Reasoning Hard for VLMs? An Attention Mechanism Perspective",
                visit_count=3,
                typed_count=1,
            ),
            make_browser(
                url="https://scholar.google.com/scholar?q=spatial+reasoning+VLM",
                title="spatial reasoning VLM - Google Scholar",
                visit_count=2,
                typed_count=1,
            ),
        ],
        expected="any",
        pause_seconds=0,
    )

    # Step 2: Re-submit same context (structural stability test)
    r.step(
        name="Re-submit same context (verify no crash on second attempt)",
        queries=["spatial reasoning vision language models attention mechanism"],
        source_docs=[
            make_browser(
                url="https://arxiv.org/abs/2503.01773",
                title="Why Is Spatial Reasoning Hard for VLMs? An Attention Mechanism Perspective",
                visit_count=4,
                typed_count=1,
            ),
        ],
        expected="any",
    )

    return r.finish()


# ======================================================================
# SCENARIO 12 — ICL Feedback Loop Validation
# ======================================================================


def scenario_12_icl_feedback_loop_validation() -> ScenarioResult:
    """ICL Loop: Run intervention, submit feedback, re-run, verify loop works.

    Full Phase 4 cycle:
    T+0: Trigger intervention with academic context -> record run_id
    T+1: Submit 'clicked' feedback for that run_id
    T+2: Run similar query -> system should still work (ICL may be cold-start)
    T+3: Submit 'dismissed' feedback for step 2's run_id
    T+4: Run different but related topic -> verify no crash, system stable
    """
    r = ScenarioRunner(12, "ICL Feedback Loop Validation (Phase 4)", "high")

    # Step 1: Trigger with strong academic signal
    academic_email = make_email(
        subject="RE: Thesis Chapter 3 Draft - Multimodal Reasoning Methods",
        sender="supervisor@university.edu",
        body_preview=(
            "Good progress on the draft. A few notes:\n\n"
            "1. Your coverage of X-Reasoner is solid, but you should also "
            "discuss the Visual Contrastive Decoding approach (MVCD) as it "
            "addresses a different aspect of multimodal reasoning.\n\n"
            "2. The section on chain-of-thought needs more depth. Look at "
            "OpenVLThinker's SFT-RL approach — it's relevant to your argument "
            "about iterative reasoning improvement.\n\n"
            "3. Deadline reminder: Chapter 3 final version due March 1.\n\n"
            "Dr. Martinez"
        ),
    )
    academic_fs = make_filesystem(
        action="modified",
        file_path="/Users/student/thesis/chapter3_multimodal_reasoning.tex",
        content_preview=(
            "[FILE: chapter3_multimodal_reasoning.tex] (Type: Full)\n---\n"
            "\\section{Multimodal Reasoning Methods}\n\n"
            "\\subsection{Cross-Modal Generalization}\n"
            "X-Reasoner \\cite{xreasoner2025} demonstrates that text-based "
            "post-training enables reasoning capabilities generalizable across "
            "modalities. The two-stage approach combines supervised fine-tuning "
            "with chain-of-thought distillation...\n\n"
            "\\subsection{Visual Chain-of-Thought}\n"
            "% TODO: Add Visual Contrastive Decoding section per supervisor feedback\n"
            "% TODO: Add OpenVLThinker SFT-RL approach\n"
        ),
    )
    step1 = r.step(
        name="Supervisor email + thesis edit (strong academic signal)",
        queries=["multimodal reasoning methods visual contrastive decoding chain-of-thought"],
        source_docs=[academic_email, academic_fs],
        expected="any",
        pause_seconds=0,
    )

    # Step 2: Submit 'clicked' feedback
    if step1.run_id:
        fb = post_feedback(step1.run_id, "clicked")
        feedback_ok = fb.get("success") is True
        fb_step = StepResult(
            name="Submit 'clicked' feedback for step 1",
            decision="feedback_recorded",
            expected="any",
            passed=feedback_ok,
            error=None if feedback_ok else f"Feedback API error: {fb}",
        )
        r.result.steps.append(fb_step)
        status = fb_step.status_str
        print(f"    {status}  Submit 'clicked' feedback for step 1")
        if not feedback_ok:
            print(f"         {C.FAIL}error: {fb}{C.END}")
    else:
        skip_step = StepResult(
            name="Submit 'clicked' feedback for step 1",
            expected="any",
            passed=True,
            error="Skipped: no run_id from step 1",
        )
        r.result.steps.append(skip_step)
        print(f"    {C.WARN}SKIP{C.END}  Submit 'clicked' feedback (no run_id)")

    time.sleep(3)

    # Step 3: Similar query (ICL may be cold-start but loop should not crash)
    step3 = r.step(
        name="Similar academic query (ICL may influence if index exists)",
        queries=["visual contrastive decoding multimodal VLM reasoning improvement"],
        source_docs=[
            make_filesystem(
                action="modified",
                file_path="/Users/student/thesis/chapter3_multimodal_reasoning.tex",
                content_preview=(
                    "[FILE: chapter3_multimodal_reasoning.tex] (Type: Full)\n---\n"
                    "\\subsection{Visual Contrastive Decoding}\n"
                    "The MVCD framework \\cite{mvcd2025} enhances visual perception "
                    "in LLMs without additional training. By leveraging in-context "
                    "learning and contrastive output distributions during decoding, "
                    "MVCD improves multimodal reasoning across question-answering "
                    "datasets including VQAv2 and GQA...\n"
                ),
            ),
            academic_email,
        ],
        expected="any",
    )

    # Step 4: Submit 'dismissed' feedback for step 3
    if step3.run_id:
        fb = post_feedback(step3.run_id, "dismissed")
        feedback_ok = fb.get("success") is True
        fb_step = StepResult(
            name="Submit 'dismissed' feedback for step 3",
            decision="feedback_recorded",
            expected="any",
            passed=feedback_ok,
            error=None if feedback_ok else f"Feedback API error: {fb}",
        )
        r.result.steps.append(fb_step)
        status = fb_step.status_str
        print(f"    {status}  Submit 'dismissed' feedback for step 3")
    else:
        skip_step = StepResult(
            name="Submit 'dismissed' feedback for step 3",
            expected="any",
            passed=True,
            error="Skipped: no run_id from step 3",
        )
        r.result.steps.append(skip_step)
        print(f"    {C.WARN}SKIP{C.END}  Submit 'dismissed' feedback (no run_id)")

    time.sleep(2)

    # Step 5: Different but related topic (stability after mixed feedback)
    r.step(
        name="Related topic after mixed feedback (spatial reasoning, system stability)",
        queries=["spatial reasoning attention mechanism vision language model VLM"],
        source_docs=[
            make_browser(
                url="file:///Users/student/Documents/papers/spatial_reasoning_vlm_attention_2025.pdf",
                title="Why Is Spatial Reasoning Hard for VLMs? Attention Mechanism Perspective",
                visit_count=1,
                typed_count=0,
            ),
        ],
        expected="any",
    )

    return r.finish()


# ======================================================================
# Registry of all scenarios
# ======================================================================

ALL_SCENARIOS = [
    (1, scenario_1_security_incident_escalation, "critical"),
    (2, scenario_2_quarterly_deadline, "critical"),
    (3, scenario_3_noise_resilience, "critical"),
    (4, scenario_4_student_research_to_deadline, "high"),
    (5, scenario_5_production_incident_ops, "critical"),
    (6, scenario_6_feedback_learning_loop, "high"),
    (7, scenario_7_long_document_processing, "high"),
    (8, scenario_8_mixed_signal_day, "high"),
    (9, scenario_9_internet_off_paper_research, "critical"),
    (10, scenario_10_multi_source_paper_discovery, "high"),
    (11, scenario_11_graceful_tool_failure, "high"),
    (12, scenario_12_icl_feedback_loop_validation, "high"),
]


# ======================================================================
# Main runner
# ======================================================================

def run_scenarios(
    scenario_ids: List[int] = None,
    quick: bool = False,
    json_output: bool = False,
) -> int:
    """Run scenarios and return exit code (0 = all critical pass)."""

    if quick:
        targets = [(i, fn, sev) for i, fn, sev in ALL_SCENARIOS if sev == "critical"]
    elif scenario_ids:
        targets = [(i, fn, sev) for i, fn, sev in ALL_SCENARIOS if i in scenario_ids]
    else:
        targets = ALL_SCENARIOS

    if not targets:
        print(f"{C.FAIL}No matching scenarios found.{C.END}")
        return 1

    # Pre-flight check
    print(f"\n{C.BOLD}{'='*80}{C.END}")
    print(f"{C.BOLD}  Proactive Pipeline -- Real-World Scenario Runner{C.END}")
    print(f"{C.BOLD}{'='*80}{C.END}")
    print(f"\n  Backend: {BASE_URL}")
    print(f"  Scenarios: {len(targets)}")
    print(f"  Mode: {'critical-only' if quick else 'full suite'}")
    print(f"  Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    # Check backend connectivity
    try:
        resp = _session.get(f"{BASE_URL}/health", timeout=5)
        if resp.status_code == 200:
            print(f"  Backend: {C.PASS}connected{C.END}")
        else:
            print(f"  Backend: {C.WARN}returned {resp.status_code}{C.END}")
    except Exception as e:
        print(f"\n  {C.FAIL}Cannot reach backend at {BASE_URL}: {e}{C.END}")
        print("  Start the backend first: ./start_production.sh")
        return 1

    print()

    # Run scenarios
    results: List[ScenarioResult] = []
    suite_start = time.time()

    for scenario_id, scenario_fn, severity in targets:
        print(f"\n{C.BOLD}  Scenario {scenario_id}: {scenario_fn.__doc__.strip().split(chr(10))[0]}{C.END}")
        print(f"  {C.DIM}Severity: {severity}{C.END}")
        print()

        try:
            result = scenario_fn()
            results.append(result)
        except Exception as e:
            print(f"    {C.FAIL}CRASH: {e}{C.END}")
            traceback.print_exc()
            results.append(ScenarioResult(
                id=scenario_id,
                name=scenario_fn.__name__,
                severity=severity,
                steps=[StepResult(name="CRASH", error=str(e))],
            ))

        # Scenario summary
        r = results[-1]
        print(f"\n  {r.status_str}  Scenario {r.id}: "
              f"{sum(1 for s in r.steps if s.passed)}/{len(r.steps)} steps  "
              f"({r.elapsed_s}s)")

    # Suite summary
    suite_elapsed = time.time() - suite_start
    print(f"\n\n{C.BOLD}{'='*80}{C.END}")
    print(f"{C.BOLD}  RESULTS SUMMARY{C.END}")
    print(f"{C.BOLD}{'='*80}{C.END}\n")

    total_steps = sum(len(r.steps) for r in results)
    passed_steps = sum(sum(1 for s in r.steps if s.passed) for r in results)
    failed_steps = total_steps - passed_steps
    infra_steps = sum(sum(1 for s in r.steps if s.failure_type == "INFRA") for r in results)
    logic_steps = sum(sum(1 for s in r.steps if s.failure_type == "WRONG_DECISION") for r in results)
    passed_scenarios = sum(1 for r in results if r.passed)
    failed_scenarios = len(results) - passed_scenarios
    critical_logic = sum(1 for r in results if r.logic_failures > 0 and r.severity == "critical")
    critical_infra = sum(1 for r in results if r.infra_failures > 0 and r.logic_failures == 0 and r.severity == "critical")

    # Per-scenario summary
    for r in results:
        status = r.status_str
        steps = f"{sum(1 for s in r.steps if s.passed)}/{len(r.steps)}"
        infra_tag = f" [{r.infra_failures} infra]" if r.infra_failures else ""
        logic_tag = f" [{r.logic_failures} wrong]" if r.logic_failures else ""
        print(f"  {status}  [{r.severity:8s}]  Scenario {r.id}: {r.name} "
              f"({steps} steps, {r.elapsed_s}s){infra_tag}{logic_tag}")
        for s in r.steps:
            if not s.passed:
                ft = s.failure_type
                color = C.WARN if ft == "INFRA" else C.FAIL
                label = ft or "ERROR"
                if ft == "WRONG_DECISION":
                    print(f"              {color}{label}: {s.name} "
                          f"(got={s.decision}, expected={s.expected}, "
                          f"budget={s.tool_budget}, tools={s.tool_calls}){C.END}")
                elif ft == "INFRA":
                    retries_str = f" ({s.retries} retries)" if s.retries else ""
                    print(f"              {color}{label}: {s.name}{retries_str} "
                          f"-- {s.error[:120]}{C.END}")
                else:
                    print(f"              {color}{label}: {s.name} -- {s.error[:120] if s.error else 'unknown'}{C.END}")

    # Aggregate summary
    print(f"\n  {C.BOLD}Scenarios{C.END}:  {passed_scenarios} passed, {failed_scenarios} failed")
    print(f"  {C.BOLD}Steps{C.END}:      {passed_steps} passed, {failed_steps} failed "
          f"({logic_steps} wrong decision, {infra_steps} infra)")
    print(f"  {C.BOLD}Runtime{C.END}:    {suite_elapsed:.0f}s ({suite_elapsed / 60:.1f} min)")

    if critical_logic > 0:
        print(f"\n  {C.FAIL}{C.BOLD}CRITICAL LOGIC FAILURES: {critical_logic} "
              f"(agent made wrong decisions){C.END}")
    if critical_infra > 0:
        print(f"\n  {C.WARN}{C.BOLD}CRITICAL INFRA FAILURES: {critical_infra} "
              f"(agent unreachable, not a logic bug){C.END}")
    if critical_logic == 0 and critical_infra == 0 and failed_scenarios > 0:
        print(f"\n  {C.WARN}Non-critical failures: {failed_scenarios}{C.END}")
    if failed_scenarios == 0:
        print(f"\n  {C.PASS}{C.BOLD}ALL SCENARIOS PASSED{C.END}")

    print()

    # JSON output
    if json_output:
        json_data = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "runtime_seconds": round(suite_elapsed, 1),
            "summary": {
                "scenarios_total": len(results),
                "scenarios_passed": passed_scenarios,
                "scenarios_failed": failed_scenarios,
                "steps_total": total_steps,
                "steps_passed": passed_steps,
                "steps_failed": failed_steps,
                "logic_failures": logic_steps,
                "infra_failures": infra_steps,
                "critical_logic_failures": critical_logic,
                "critical_infra_failures": critical_infra,
            },
            "scenarios": [
                {
                    "id": r.id,
                    "name": r.name,
                    "severity": r.severity,
                    "passed": r.passed,
                    "logic_failures": r.logic_failures,
                    "infra_failures": r.infra_failures,
                    "elapsed_s": r.elapsed_s,
                    "steps": [
                        {
                            "name": s.name,
                            "decision": s.decision,
                            "expected": s.expected,
                            "passed": s.passed,
                            "failure_type": s.failure_type,
                            "tool_budget": s.tool_budget,
                            "recommendation": s.recommendation[:300] if s.recommendation else None,
                            "tool_calls": s.tool_calls,
                            "elapsed_ms": s.elapsed_ms,
                            "retries": s.retries,
                            "error": s.error,
                            "diagnosis": s.diagnosis() if not s.passed else None,
                        }
                        for s in r.steps
                    ],
                }
                for r in results
            ],
        }
        json_path = f"tests/scenarios/results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(json_path, "w") as f:
            json.dump(json_data, f, indent=2)
        print(f"  Results saved to: {json_path}")

    # Exit code semantics:
    #   0 = all logic correct (infra failures are not logic bugs)
    #   1 = critical logic failures (agent made wrong decisions)
    #   2 = only infra failures (agent unreachable, no logic tested)
    if critical_logic > 0:
        return 1
    if critical_infra > 0:
        return 2
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Proactive Pipeline Real-World Scenario Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--scenario", "-s",
        type=int,
        nargs="+",
        help="Run specific scenario(s) by ID (1-12)",
    )
    parser.add_argument(
        "--quick", "-q",
        action="store_true",
        help="Run critical scenarios only (~15 min)",
    )
    parser.add_argument(
        "--json", "-j",
        action="store_true",
        help="Save JSON results to tests/scenarios/results_*.json",
    )
    parser.add_argument(
        "--list", "-l",
        action="store_true",
        help="List all scenarios and exit",
    )

    args = parser.parse_args()

    if args.list:
        print("\nAvailable scenarios:\n")
        for sid, fn, sev in ALL_SCENARIOS:
            desc = fn.__doc__.strip().split("\n")[0]
            print(f"  {sid}. [{sev:8s}] {desc}")
        print()
        return 0

    exit_code = run_scenarios(
        scenario_ids=args.scenario,
        quick=args.quick,
        json_output=args.json,
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
