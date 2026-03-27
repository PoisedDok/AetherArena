"""
Cross-Source Convergence Tests

10 tests where the same topic appears across 2-3 distinct source types.
Cross-source convergence is the strongest signal -- it means the user's
attention is genuinely focused on a topic from multiple angles.
"""

import pytest
from tests.integration.proactive.helpers import (
    SyntheticEmail, SyntheticBrowser, SyntheticFilesystem,
    SyntheticPreviousQuery, scout,
)


# ======================================================================
# CRITICAL -- must intervene. Hard assert.
# ======================================================================


@pytest.mark.severity_critical
class TestCrossSourceCritical:

    def test_email_cve_plus_browser_researching(self):
        """Email CVE alert + Browser researching the same CVE on NVD."""
        email = SyntheticEmail.make(
            subject="[SECURITY] Critical: OpenSSL CVE-2026-12345 Affects Your Infrastructure",
            sender="security-team@company.com",
            body_preview=(
                "SECURITY ADVISORY\n\n"
                "A critical remote code execution vulnerability (CVE-2026-12345) has been "
                "discovered in OpenSSL 3.4.0. CVSS score: 9.8/10.\n\n"
                "Your infrastructure scan shows 14 servers running affected versions:\n"
                "  - prod-web-01 through prod-web-08 (OpenSSL 3.4.0)\n"
                "  - prod-api-01 through prod-api-04 (OpenSSL 3.4.0)\n"
                "  - staging-01, staging-02 (OpenSSL 3.4.0)\n\n"
                "Active exploitation detected in the wild. Proof-of-concept published on GitHub.\n\n"
                "REQUIRED ACTIONS:\n"
                "1. Update to OpenSSL 3.4.1 on all affected servers within 4 hours\n"
                "2. Restart all TLS-dependent services after update\n"
                "3. Review access logs for IoCs since December 15, 2025\n"
                "4. Regenerate SSL certificates if compromise suspected\n\n"
                "Patch: https://www.openssl.org/source/\n"
                "Advisory: https://nvd.nist.gov/vuln/detail/CVE-2026-12345\n\n"
                "-- Infrastructure Security Team"
            ),
        )
        browser = SyntheticBrowser.make(
            url="https://nvd.nist.gov/vuln/detail/CVE-2026-12345",
            title="NVD - CVE-2026-12345 - OpenSSL RCE Vulnerability",
            visit_count=4,
            typed_count=1,
        )
        result = scout(
            queries=["openssl cve-2026-12345 critical vulnerability patch"],
            source_docs=[email, browser],
        )
        assert result["decision"] == "intervene"
        assert result.get("recommendation") is not None

    def test_email_deadline_plus_filesystem_editing(self):
        """Email about Q4 report deadline + Filesystem editing the report file."""
        email = SyntheticEmail.make(
            subject="Q4 Financial Report Due Friday - Final Reminder",
            sender="finance@company.com",
            body_preview=(
                "Hi team,\n\n"
                "This is your final reminder that the Q4 financial report is due by "
                "end of day Friday, February 14.\n\n"
                "Please ensure:\n"
                "1. All department revenue numbers are finalized\n"
                "2. Expense reconciliation is complete\n"
                "3. Variance explanations for any >5% deviation from forecast\n"
                "4. Submit via the shared drive under /Finance/Q4_2026/\n\n"
                "The board presentation is on Monday and we need all numbers locked.\n\n"
                "Thanks,\n"
                "Finance Team"
            ),
        )
        fs_doc = SyntheticFilesystem.make(
            action="modified",
            file_path="/Users/dev/Documents/Finance/Q4_Financial_Report.xlsx",
            content_preview=(
                '[FILE: Q4_Financial_Report.xlsx] (Type: Large)\n---\n'
                'Q4 2026 Financial Summary\n\n'
                'Revenue by Department:\n'
                '  Engineering Services: $2,340,000 (forecast: $2,200,000, +6.4%)\n'
                '  Cloud Infrastructure: $1,890,000 (forecast: $1,950,000, -3.1%)\n'
                '  Professional Services: $780,000 (forecast: $750,000, +4.0%)\n\n'
                'Total Revenue: $5,010,000\n'
                'Total Expenses: $3,820,000\n'
                'Net Income: $1,190,000\n\n'
                'Notes: Cloud Infrastructure revenue shortfall due to delayed '
                'enterprise contract closure (now expected Q1). Professional Services '
                'overperformance driven by 3 new consulting engagements.\n'
            ),
            location_name="Finance",
        )
        result = scout(
            queries=["quarterly financial report preparation deadline"],
            source_docs=[email, fs_doc],
        )
        assert result["decision"] == "intervene"

    def test_three_source_security_convergence(self):
        """Email alert + Browser research + Filesystem remediation notes -- full convergence."""
        email = SyntheticEmail.make(
            subject="[CRITICAL] Kubernetes CVE-2026-5678 - Active Exploitation",
            sender="k8s-security@company.com",
            body_preview=(
                "CRITICAL: Kubernetes API Server RCE vulnerability CVE-2026-5678 "
                "detected in your production cluster. CVSS 9.8.\n\n"
                "Affected: prod-cluster-east (v1.28.4)\n"
                "Exploit status: Active in the wild\n"
                "Patch: Available in k8s 1.29.3\n\n"
                "Immediate patching required before end of day.\n\n"
                "-- K8s Security Team"
            ),
        )
        browser = SyntheticBrowser.make(
            url="https://github.com/kubernetes/kubernetes/issues/CVE-2026-5678",
            title="CVE-2026-5678: API Server Remote Code Execution - kubernetes/kubernetes",
            visit_count=6,
            typed_count=1,
        )
        fs_doc = SyntheticFilesystem.make(
            action="created",
            file_path="/Users/dev/incidents/cve-2026-5678-remediation.md",
            content_preview=(
                '[FILE: cve-2026-5678-remediation.md] (Type: Full)\n---\n'
                '# CVE-2026-5678 Remediation Plan\n\n'
                '## Affected Clusters\n'
                '- prod-cluster-east: v1.28.4 (VULNERABLE)\n'
                '- prod-cluster-west: v1.29.2 (SAFE)\n'
                '- staging: v1.28.4 (VULNERABLE)\n\n'
                '## Patch Steps\n'
                '1. Drain nodes in prod-cluster-east\n'
                '2. Upgrade control plane to v1.29.3\n'
                '3. Rolling upgrade of worker nodes\n'
                '4. Verify API server audit logs for exploitation\n\n'
                '## ETA: Today before EOD\n'
            ),
            location_name="incidents",
        )
        result = scout(
            queries=["kubernetes cve-2026-5678 remediation patching"],
            source_docs=[email, browser, fs_doc],
        )
        assert result["decision"] == "intervene"
        assert result.get("recommendation") is not None


# ======================================================================
# HIGH -- should intervene. Hard assert.
# ======================================================================


@pytest.mark.severity_high
class TestCrossSourceHigh:

    def test_email_deprecation_plus_browser_migration(self):
        """API deprecation email + Browser reading migration documentation."""
        email = SyntheticEmail.make(
            subject="Stripe API v2 Sunset - Final Warning",
            sender="api-team@stripe.com",
            body_preview=(
                "Your account still has 47 active v2 integrations.\n"
                "Hard cutoff: March 1, 2026. After this date, all v2 endpoints "
                "return HTTP 410 Gone.\n\n"
                "Migrate now: https://stripe.com/docs/upgrades/v2-to-v3"
            ),
        )
        browser = SyntheticBrowser.make(
            url="https://stripe.com/docs/upgrades/v2-to-v3",
            title="Migrate from API v2 to v3 | Stripe Documentation",
            visit_count=3,
            typed_count=1,
        )
        result = scout(
            queries=["stripe api migration v2 to v3 deadline"],
            source_docs=[email, browser],
        )
        assert result["decision"] == "intervene"

    def test_cascading_incident_emails(self):
        """Multiple emails from different senders about the same cascading incident."""
        email1 = SyntheticEmail.make(
            subject="[INCIDENT #9012] Database Connection Pool Exhausted - prod-db-1",
            sender="monitoring@datadog.com",
            body_preview=(
                "Alert: Database connection pool on prod-db-1 is exhausted.\n"
                "Current: 50/50 connections in use.\n"
                "Queue depth: 234 pending queries.\n"
                "Service impact: payments-api, auth-service, user-service.\n\n"
                "Dashboard: https://app.datadoghq.com/apm/service/prod-db-1"
            ),
        )
        email2 = SyntheticEmail.make(
            subject="RE: [INCIDENT #9012] Customer Reports - 502 Errors Across All Regions",
            sender="support-escalation@company.com",
            body_preview=(
                "Escalation from Customer Support:\n\n"
                "We are now receiving 502 errors reports from customers across "
                "all 3 regions (US, EU, APAC). This appears to be cascading from "
                "the database incident #9012.\n\n"
                "Current ticket count: 89 (and growing at ~15/minute)\n"
                "Enterprise customer Acme Corp is threatening SLA breach penalty.\n"
                "Please prioritize resolution.\n\n"
                "-- Support Escalation Team"
            ),
        )
        result = scout(
            queries=["database connection pool incident customer impact"],
            source_docs=[email1, email2],
        )
        assert result["decision"] == "intervene"

    def test_email_meeting_plus_filesystem_prep(self):
        """Meeting invite email + Filesystem creating a prep document."""
        email = SyntheticEmail.make(
            subject="Board Demo Tomorrow 10am - Your Module",
            sender="cto@company.com",
            body_preview=(
                "Quick reminder: board demo is tomorrow at 10am.\n"
                "You're presenting the proactive agent module (15 min slot).\n"
                "Please have your demo environment ready and a backup recording.\n\n"
                "-- David"
            ),
        )
        fs_doc = SyntheticFilesystem.make(
            action="created",
            file_path="/Users/dev/presentations/board-demo-proactive-agent.md",
            content_preview=(
                '[FILE: board-demo-proactive-agent.md] (Type: Full)\n---\n'
                '# Board Demo: Proactive Agent\n\n'
                '## Demo Flow\n'
                '1. Show email triggering proactive notification (2 min)\n'
                '2. Show cross-source convergence with browser + filesystem (3 min)\n'
                '3. Live demo of ICL feedback loop (5 min)\n'
                '4. Architecture overview slide (2 min)\n'
                '5. Q&A buffer (3 min)\n\n'
                '## Backup: Screen recording saved in /demos/\n'
            ),
            location_name="presentations",
        )
        result = scout(
            queries=["board demo preparation proactive agent module"],
            source_docs=[email, fs_doc],
        )
        assert result["decision"] == "intervene"

    def test_academic_deadline_plus_local_chapter_edit(self):
        """Supervisor deadline email + local dissertation chapter edits (non-dev domain)."""
        email = SyntheticEmail.make(
            subject="Dissertation Methods Chapter Due Friday 5pm",
            sender="supervisor@university.edu",
            body_preview=(
                "Hi,\n\n"
                "Reminder that your revised Methods chapter is due this Friday at 5:00 PM.\n"
                "Please include:\n"
                "1) participant recruitment criteria,\n"
                "2) coding rubric for qualitative analysis,\n"
                "3) reliability plan (inter-rater agreement), and\n"
                "4) final rationale for mixed-method design.\n\n"
                "I will review your chapter over the weekend before ethics submission.\n\n"
                "Best,\n"
                "Dr. Elena Ruiz"
            ),
        )
        fs_doc = SyntheticFilesystem.make(
            action="modified",
            file_path="/Users/student/dissertation/chapters/04-methods.tex",
            content_preview=(
                "[FILE: 04-methods.tex] (Type: Full)\n---\n"
                "\\section{Methodology}\n"
                "\\subsection{Design Rationale}\n"
                "This study uses a convergent mixed-method design to evaluate user trust.\n"
                "\\subsection{Participants}\n"
                "N=36 participants recruited from graduate and industry cohorts.\n"
                "\\subsection{Reliability}\n"
                "Two coders independently annotate responses; Cohen's kappa target >= 0.80.\n"
                "\\subsection{Submission Timeline}\n"
                "Final supervisor submission deadline: Friday 17:00.\n"
            ),
            location_name="dissertation",
        )
        result = scout(
            queries=["dissertation methods revision deadline and reliability criteria"],
            source_docs=[email, fs_doc],
        )
        assert result["decision"] == "intervene"

    def test_paper_review_plus_local_synthesis_notes(self):
        """Academic paper review in browser + local synthesis notes should intervene."""
        browser = SyntheticBrowser.make(
            url="https://aclanthology.org/2025.acl-long.123",
            title="Retrieval-Augmented Planning for Long-Horizon Tasks - ACL Anthology",
            visit_count=3,
            typed_count=1,
        )
        fs_doc = SyntheticFilesystem.make(
            action="created",
            file_path="/Users/student/research/notes/rag_planning_comparison.md",
            content_preview=(
                "[FILE: rag_planning_comparison.md] (Type: Full)\n---\n"
                "# Paper Comparison Notes\n"
                "- Compare planner latency vs answer faithfulness across ACL and NeurIPS papers.\n"
                "- Extract evaluation protocol differences (human rubric vs automatic metrics).\n"
                "- Decide final baseline set for user study protocol by Thursday.\n"
                "- Produce synthesis paragraph for evaluation chapter tonight.\n"
            ),
            location_name="research",
        )
        result = scout(
            queries=["compare long-horizon rag planning papers for evaluation design"],
            source_docs=[browser, fs_doc],
        )
        assert result["decision"] == "intervene"


# ======================================================================
# MEDIUM -- LLM-dependent. xfail.
# ======================================================================


@pytest.mark.severity_medium
class TestCrossSourceMedium:

    @pytest.mark.xfail(strict=False, reason="Learning activity with cross-source may or may not trigger intervention")
    def test_browser_tutorial_plus_filesystem_practice(self):
        """Browser tutorial + Filesystem creating a practice file -- learning, not urgent."""
        browser = SyntheticBrowser.make(
            url="https://react.dev/learn/tutorial-tic-tac-toe",
            title="Tutorial: Tic-Tac-Toe - React",
            visit_count=2,
            typed_count=0,
        )
        fs_doc = SyntheticFilesystem.make(
            action="created",
            file_path="/Users/dev/learning/react-tutorial/App.jsx",
            content_preview=(
                '[FILE: App.jsx] (Type: Full)\n---\n'
                'import { useState } from "react";\n\n'
                'function Square({ value, onSquareClick }) {\n'
                '  return <button className="square" onClick={onSquareClick}>{value}</button>;\n'
                '}\n\n'
                'export default function Board() {\n'
                '  const [squares, setSquares] = useState(Array(9).fill(null));\n'
                '  // TODO: implement game logic\n'
                '}\n'
            ),
            location_name="learning",
        )
        result = scout(
            queries=["learning react tutorial tic tac toe"],
            source_docs=[browser, fs_doc],
        )
        assert result["decision"] == "intervene"

    @pytest.mark.xfail(strict=False, reason="Background correlation is a single signal; may not be enough for intervention")
    def test_browser_research_plus_background_query(self):
        """Browser research with background query correlation from previous batch."""
        browser = SyntheticBrowser.make(
            url="https://docs.qdrant.tech/documentation/guides/distributed_deployment/",
            title="Distributed Deployment - Qdrant Documentation",
            visit_count=3,
            typed_count=1,
        )
        prev_query = SyntheticPreviousQuery.make(
            query="vector database scaling distributed deployment options",
            batch_offset=1,
        )
        result = scout(
            queries=["qdrant distributed deployment documentation"],
            source_docs=[browser, prev_query],
        )
        assert result["decision"] == "intervene"


# ======================================================================
# LOW -- must defer. Hard assert defer.
# ======================================================================


@pytest.mark.severity_low
class TestCrossSourceLowDefer:

    def test_newsletter_email_plus_newsletter_browser(self):
        """Newsletter email + Browser on the same newsletter site -- both low-signal."""
        email = SyntheticEmail.make(
            subject="This Week in ML #89",
            sender="newsletter@weekinml.com",
            body_preview=(
                "This week's highlights:\n"
                "- New diffusion model beats DALL-E 3 on FID scores\n"
                "- Open-source speech model matches Whisper V3\n"
                "- Tutorial: Building RAG with LangChain and Qdrant\n\n"
                "Read more: https://weekinml.com/issue/89"
            ),
        )
        browser = SyntheticBrowser.make(
            url="https://weekinml.com/issue/89",
            title="This Week in ML #89",
            visit_count=1,
            typed_count=0,
        )
        result = scout(
            queries=["reading machine learning newsletter"],
            source_docs=[email, browser],
        )
        assert result["decision"] == "defer"

    def test_social_email_plus_social_browser(self):
        """Social notification email + Browser on social page -- both noise."""
        email = SyntheticEmail.make(
            subject="5 new notifications on LinkedIn",
            sender="notifications@linkedin.com",
            body_preview=(
                "You have new notifications:\n"
                "- 3 people viewed your profile\n"
                "- 1 connection request\n"
                "- 1 endorsement for Python\n"
            ),
        )
        browser = SyntheticBrowser.make(
            url="https://www.linkedin.com/feed/",
            title="LinkedIn Feed",
            visit_count=1,
            typed_count=0,
        )
        result = scout(
            queries=["checking linkedin notifications and feed"],
            source_docs=[email, browser],
        )
        assert result["decision"] == "defer"
