"""
Single-Source Filesystem Tests

10 tests covering filesystem-only proactive scenarios. Filesystem signal
depends entirely on WHAT file and WHAT action, not the source type itself.
content_preview uses DocumentUtility output format.
"""

import pytest
from tests.integration.proactive.helpers import SyntheticFilesystem, scout


# ======================================================================
# CRITICAL -- must defer (noise filtering). Hard assert defer.
# ======================================================================


@pytest.mark.severity_critical
class TestFilesystemCriticalDefer:

    def test_ide_config_autosave(self):
        """IDE auto-saving settings.json -- pure noise."""
        doc = SyntheticFilesystem.make(
            action="modified",
            file_path="/Users/dev/project/.vscode/settings.json",
            content_preview=(
                '[FILE: settings.json] (Type: Full)\n---\n'
                '{\n'
                '    "editor.fontSize": 14,\n'
                '    "editor.tabSize": 2,\n'
                '    "editor.formatOnSave": true,\n'
                '    "python.linting.enabled": true,\n'
                '    "typescript.tsdk": "node_modules/typescript/lib"\n'
                '}'
            ),
        )
        result = scout(
            queries=["ide configuration change"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"

    def test_build_artifact_created(self):
        """Build system creating dist/ output -- noise from tooling."""
        doc = SyntheticFilesystem.make(
            action="created",
            file_path="/Users/dev/project/dist/bundle.js",
            content_preview=(
                '[FILE: bundle.js] (Type: Large)\n---\n'
                '!function(e,t){"object"==typeof exports&&"object"==typeof module?'
                'module.exports=t():"function"==typeof define&&define.amd?define([],t):'
                '"object"==typeof exports?exports.app=t():e.app=t()}(globalThis,(()=>'
                '(()=>{"use strict";var e={};return(()=>{var t=e;Object.defineProperty(t,'
                '"__esModule",{value:!0});const n=require("react")...'
            ),
        )
        result = scout(
            queries=["build artifact generated"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"

    def test_ds_store_modification(self):
        """.DS_Store modification -- macOS metadata noise, no content."""
        doc = SyntheticFilesystem.make(
            action="modified",
            file_path="/Users/dev/project/.DS_Store",
            content_preview="",
        )
        result = scout(
            queries=["macos metadata file change"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"


# ======================================================================
# HIGH -- should intervene. Hard assert.
# ======================================================================


@pytest.mark.severity_high
class TestFilesystemHigh:

    @pytest.mark.xfail(
        strict=False,
        reason="Rapid file modifications are structurally significant but LLM may not "
               "interpret code content as urgent without cross-source context",
    )
    def test_rapid_project_file_modifications(self):
        """Two project files modified within seconds -- active sprint work."""
        doc1 = SyntheticFilesystem.make(
            action="modified",
            file_path="/Users/dev/aether/backend/services/auth_service.py",
            content_preview=(
                '[FILE: auth_service.py] (Type: Full)\n---\n'
                'import jwt\n'
                'from datetime import datetime, timedelta\n'
                'from fastapi import HTTPException, status\n\n'
                'class AuthService:\n'
                '    def __init__(self, secret_key: str, algorithm: str = "HS256"):\n'
                '        self.secret_key = secret_key\n'
                '        self.algorithm = algorithm\n'
                '        self.token_expiry = timedelta(minutes=15)\n\n'
                '    async def refresh_token(self, refresh_token: str) -> dict:\n'
                '        """BUGFIX: Token refresh was silently failing after 15min idle.\n'
                '        Root cause: refresh_token_expiry was using access_token_expiry.\n'
                '        Fix: Use dedicated refresh_expiry of 7 days."""\n'
                '        try:\n'
                '            payload = jwt.decode(refresh_token, self.secret_key, algorithms=[self.algorithm])\n'
                '            # ... rest of implementation\n'
            ),
            location_name="backend",
        )
        doc2 = SyntheticFilesystem.make(
            action="modified",
            file_path="/Users/dev/aether/backend/tests/test_auth_service.py",
            content_preview=(
                '[FILE: test_auth_service.py] (Type: Full)\n---\n'
                'import pytest\n'
                'from services.auth_service import AuthService\n\n'
                'class TestTokenRefresh:\n'
                '    async def test_refresh_after_idle(self):\n'
                '        """Regression test: token refresh must work after 15min idle.\n'
                '        Previously failed with 401 because refresh_token_expiry\n'
                '        was incorrectly set to access_token_expiry (15min)."""\n'
                '        svc = AuthService(secret_key="test")\n'
                '        tokens = await svc.login("user", "pass")\n'
                '        # Simulate 20 minutes idle\n'
                '        refreshed = await svc.refresh_token(tokens["refresh_token"])\n'
                '        assert refreshed["access_token"] is not None\n'
            ),
            location_name="backend",
        )
        result = scout(
            queries=["fixing authentication token refresh bug"],
            source_docs=[doc1, doc2],
        )
        assert result["decision"] == "intervene"


# ======================================================================
# MEDIUM -- LLM-dependent. xfail.
# ======================================================================


@pytest.mark.severity_medium
class TestFilesystemMedium:

    @pytest.mark.xfail(strict=False, reason="Incident notes are contextually urgent but single-source filesystem may not have enough signal")
    def test_incident_response_notes_created(self):
        """Creating incident response notes -- implies active incident handling."""
        doc = SyntheticFilesystem.make(
            action="created",
            file_path="/Users/dev/incidents/INC-2026-0209-payments.md",
            content_preview=(
                '[FILE: INC-2026-0209-payments.md] (Type: Full)\n---\n'
                '# Incident: Payment Processing Failure\n'
                '## Status: ACTIVE\n'
                '## Severity: P1\n\n'
                '### Timeline\n'
                '- 14:30 UTC: First alert from Datadog - payment_success_rate dropped to 62%\n'
                '- 14:35 UTC: Confirmed Stripe webhook delivery failing (timeout after 30s)\n'
                '- 14:40 UTC: Root cause identified - new firewall rule blocking outbound to api.stripe.com:443\n'
                '- 14:45 UTC: Firewall rule reverted, monitoring recovery\n\n'
                '### Action Items\n'
                '- [ ] Verify all pending webhooks are replayed\n'
                '- [ ] Add Stripe IP ranges to firewall allowlist permanently\n'
                '- [ ] Post-mortem scheduled for Feb 10\n\n'
                '### Impact\n'
                '- ~180 failed payment attempts\n'
                '- 12 customer complaints received\n'
                '- Estimated revenue impact: $4,200\n'
            ),
            location_name="incidents",
        )
        result = scout(
            queries=["incident response payment processing failure"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"

    @pytest.mark.xfail(strict=False, reason="Security config edit is contextually significant but may lack urgency signal")
    def test_security_config_edited(self):
        """Editing nginx SSL/TLS configuration -- security-sensitive change."""
        doc = SyntheticFilesystem.make(
            action="modified",
            file_path="/etc/nginx/conf.d/ssl.conf",
            content_preview=(
                '[FILE: ssl.conf] (Type: Full)\n---\n'
                'server {\n'
                '    listen 443 ssl http2;\n'
                '    server_name api.company.com;\n\n'
                '    # TLS 1.3 only - CRITICAL: Disabled TLS 1.2 per security audit\n'
                '    ssl_protocols TLSv1.3;\n'
                '    ssl_ciphers TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256;\n'
                '    ssl_prefer_server_ciphers on;\n\n'
                '    # Certificate renewal - expires March 1, 2026\n'
                '    ssl_certificate /etc/ssl/certs/api.company.com.pem;\n'
                '    ssl_certificate_key /etc/ssl/private/api.company.com.key;\n\n'
                '    # HSTS - 1 year with includeSubDomains\n'
                '    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\n'
                '}\n'
            ),
            location_name="nginx",
        )
        result = scout(
            queries=["ssl tls configuration security change"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"


# ======================================================================
# LOW -- must defer. Hard assert defer.
# ======================================================================


@pytest.mark.severity_low
class TestFilesystemLowDefer:

    def test_log_file_rotation(self):
        """Log file being rotated -- automated system activity."""
        doc = SyntheticFilesystem.make(
            action="created",
            file_path="/var/log/app/production.log.1",
            content_preview=(
                '[FILE: production.log.1] (Type: Large)\n---\n'
                '2026-02-09 14:30:01 INFO  [main] Application started on port 8765\n'
                '2026-02-09 14:30:02 INFO  [pool] Connection pool initialized (20 connections)\n'
                '2026-02-09 14:30:15 DEBUG [auth] Token refresh for user_id=12345\n'
                '2026-02-09 14:30:16 INFO  [api] GET /v1/health -> 200 (2ms)\n'
                '2026-02-09 14:30:22 INFO  [api] POST /v1/chat -> 200 (1234ms)\n'
            ),
            location_name="log",
        )
        result = scout(
            queries=["application log file rotated"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"

    def test_git_merge_message(self):
        """Git auto-generated merge message -- tooling noise."""
        doc = SyntheticFilesystem.make(
            action="created",
            file_path="/Users/dev/project/.git/MERGE_MSG",
            content_preview=(
                "[FILE: MERGE_MSG] (Type: Full)\n---\n"
                "Merge branch 'feature/auth-improvements' into main\n\n"
                "# Conflicts:\n"
                "#\tsrc/services/auth.py\n"
                "#\ttests/test_auth.py\n"
            ),
            location_name=".git",
        )
        result = scout(
            queries=["git merge operation"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"


# ======================================================================
# LONG-DOC -- filesystem with substantial extracted content
# ======================================================================


@pytest.mark.severity_medium
class TestFilesystemLongDoc:

    @pytest.mark.xfail(strict=False, reason="Research paper content may not trigger intervention without urgency markers")
    def test_research_paper_pdf_created(self):
        """PDF paper created -- extracted abstract about tokenization methods (~1KB)."""
        doc = SyntheticFilesystem.make(
            action="created",
            file_path="/Users/dev/papers/wetok_tokenization_2026.pdf",
            content_preview=(
                '[FILE: wetok_tokenization_2026.pdf] (Type: PDF)\n---\n'
                'WeTok: Efficient Tokenization for Multilingual Language Models\n\n'
                'Abstract\n'
                'We present WeTok, a novel tokenization framework that addresses the '
                'fundamental inefficiency of current BPE-based tokenizers when applied to '
                'multilingual corpora. Current approaches suffer from vocabulary fragmentation '
                'across scripts, leading to 3-5x longer sequences for non-Latin languages '
                'compared to English. WeTok introduces a script-aware merge strategy that '
                'balances compression ratios across 100+ languages while maintaining '
                'compatibility with existing transformer architectures.\n\n'
                'Our key contributions are:\n'
                '1. A weighted merge priority function that considers script-specific '
                'character distributions during BPE training\n'
                '2. An adaptive vocabulary allocation algorithm that dynamically assigns '
                'vocabulary budget based on corpus statistics\n'
                '3. A multi-objective optimization framework balancing compression, '
                'downstream task performance, and vocabulary coverage\n\n'
                'Experimental results on mC4 and CC-100 show WeTok achieves 23% better '
                'compression for Arabic, 31% for Hindi, and 18% for Chinese compared to '
                'SentencePiece, while maintaining English performance within 2% of baseline. '
                'On downstream multilingual benchmarks (XNLI, XQuAD, TyDi QA), models '
                'trained with WeTok tokenization show consistent improvements of 1.5-4.2 '
                'points across all evaluation languages.\n'
            ),
            location_name="papers",
        )
        result = scout(
            queries=["research paper multilingual tokenization framework"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"

    def test_production_incident_markdown_modified(self):
        """Large production incident doc modified -- active incident with P0 status."""
        doc = SyntheticFilesystem.make(
            action="modified",
            file_path="/Users/dev/incidents/urgent_production_issue_2026.md",
            content_preview=(
                '[FILE: urgent_production_issue_2026.md] (Type: Full)\n---\n'
                '# URGENT: Production API Rate Limiting Issue - 2026-02-02\n\n'
                '## Critical Alert\n'
                'Our production API is experiencing rate limit violations causing '
                '429 errors for 40% of requests.\n\n'
                '## Impact\n'
                '- **Users affected**: 15,000+ active sessions\n'
                '- **Services down**: Payment processing, user authentication\n'
                '- **Revenue impact**: ~$2,500/hour in lost transactions\n'
                '- **Customer complaints**: 127 support tickets in last 30 minutes\n\n'
                '## Root Cause Analysis\n'
                'Initial investigation shows:\n'
                '1. New deployment at 14:30 UTC introduced aggressive retry logic\n'
                '2. Exponential backoff NOT implemented correctly\n'
                '3. Circuit breaker threshold set too high (90% instead of 50%)\n\n'
                '## Immediate Action Required\n'
                '1. Rollback deployment to v2.4.3 (last stable)\n'
                '2. Patch rate limiter configuration\n'
                '3. Implement proper exponential backoff with jitter\n\n'
                '## Timeline\n'
                '- 14:30 - Bad deployment goes live\n'
                '- 14:45 - Error rate hits 40%\n'
                '- 15:00 - Support tickets surge\n'
                '- **15:20 - CURRENT TIME - NEED IMMEDIATE ROLLBACK**\n\n'
                '**STATUS**: CRITICAL - IMMEDIATE ACTION NEEDED\n'
                '**PRIORITY**: P0 - Production Down\n'
            ),
            location_name="incidents",
        )
        result = scout(
            queries=["production api rate limiting outage"],
            source_docs=[doc],
        )
        # This has temporal markers ("CURRENT TIME", "IMMEDIATE"), urgency signals,
        # and rich actionable content -- should intervene even as single-source filesystem.
        assert result["decision"] == "intervene"
