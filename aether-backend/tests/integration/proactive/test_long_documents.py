"""
Long Document Tests

8 tests with realistic multi-KB content embedded as string literals.
Content is taken from sample/ files and formatted as DocumentUtility
would produce (filesystem) or as email body_preview (email).
These test the scout's ability to extract signal from verbose text.
"""

import pytest
from tests.integration.proactive.helpers import SyntheticEmail, SyntheticBrowser, SyntheticFilesystem, scout


# ---------------------------------------------------------------------------
# Embedded content constants (from sample/ files, trimmed to ~what
# DocumentUtility would extract for filesystem, or full body for email)
# ---------------------------------------------------------------------------

SECURITY_BREACH_CONTENT = (
    "URGENT: Critical Security Vulnerability Discovered in OpenSSL 3.4.0\n\n"
    "SEVERITY: CRITICAL (CVSS 9.8)\n"
    "DATE: January 30, 2026\n"
    "CVE: CVE-2026-12345\n\n"
    "A critical remote code execution vulnerability has been discovered in "
    "OpenSSL 3.4.0 affecting millions of servers worldwide. The vulnerability "
    "allows unauthenticated attackers to execute arbitrary code on affected systems.\n\n"
    "AFFECTED VERSIONS:\n"
    "- OpenSSL 3.4.0 (all platforms)\n"
    "- Released in December 2025\n"
    "- Affects web servers, VPNs, email servers\n\n"
    "IMMEDIATE ACTION REQUIRED:\n"
    "1. Update to OpenSSL 3.4.1 immediately\n"
    "2. Restart all affected services\n"
    "3. Review server logs for suspicious activity since December 15, 2025\n"
    "4. Regenerate SSL certificates if compromise suspected\n\n"
    "EXPLOIT STATUS:\n"
    "Proof-of-concept exploit code was published on GitHub 2 hours ago.\n"
    "Active exploitation detected in the wild targeting AWS, Azure, and GCP infrastructure.\n\n"
    "INDICATORS OF COMPROMISE:\n"
    "- Unusual outbound connections on port 443\n"
    "- Unexpected SSL handshake errors in logs\n"
    "- New admin accounts created\n"
    "- Modified SSL certificate files\n\n"
    "For technical details: https://nvd.nist.gov/vuln/detail/CVE-2026-12345\n"
    "Patch download: https://www.openssl.org/source/\n\n"
    "This is a wormable vulnerability. Urgent patching recommended within next 4 hours."
)

NODEJS_ZERO_DAY_CONTENT = (
    "BREAKING: Critical Zero-Day Vulnerability in Node.js 20.x and 22.x\n\n"
    "SEVERITY: CRITICAL (CVSS 10.0)\n"
    "CVE: CVE-2026-00001\n"
    "DATE: January 31, 2026\n"
    "EXPLOIT STATUS: ACTIVE IN THE WILD\n\n"
    "A critical remote code execution vulnerability has been discovered in Node.js "
    "versions 20.x and 22.x that allows unauthenticated remote attackers to execute "
    "arbitrary code through malicious HTTP headers.\n\n"
    "AFFECTED VERSIONS:\n"
    "- Node.js 20.0.0 through 20.11.0\n"
    "- Node.js 22.0.0 through 22.1.0\n"
    "- ALL platforms (Linux, macOS, Windows)\n\n"
    "IMMEDIATE ACTION REQUIRED:\n"
    "1. UPGRADE IMMEDIATELY to Node.js 20.11.1 or 22.1.1\n"
    "2. Restart all Node.js services\n"
    "3. Check access logs for exploitation attempts since January 28, 2026\n"
    "4. Review npm packages for potential compromise\n\n"
    "TECHNICAL DETAILS:\n"
    "- Attack vector: Malformed HTTP headers in Express/Fastify applications\n"
    "- No authentication required\n"
    "- Exploitable remotely over network\n"
    "- Privilege escalation to root/SYSTEM possible\n"
    "- Wormable - can spread automatically\n\n"
    "INDICATORS OF COMPROMISE:\n"
    "- Unusual CPU spikes on Node.js processes\n"
    "- New files in /tmp/ or C:\\Windows\\Temp\\\n"
    "- Outbound connections to unknown IPs on ports 4444, 5555\n"
    "- Modified package.json or node_modules\n\n"
    "CONFIRMED ATTACKS:\n"
    "- 2,000+ compromised servers detected in last 24 hours\n"
    "- Ransomware deployment observed\n"
    "- Credential harvesting active\n\n"
    "PATCH AVAILABILITY:\n"
    "- Node.js 20.11.1: https://nodejs.org/download/release/v20.11.1/\n"
    "- Node.js 22.1.1: https://nodejs.org/download/release/v22.1.1/\n"
    "- Security advisory: https://nodejs.org/en/blog/vulnerability/january-2026-security-releases/\n\n"
    "THIS IS NOT A DRILL. PATCH IMMEDIATELY."
)

PRODUCTION_INCIDENT_CONTENT = (
    "# URGENT: Production API Rate Limiting Issue - 2026-02-02\n\n"
    "## Critical Alert\n"
    "Our production API is experiencing rate limit violations causing 429 errors "
    "for 40% of requests.\n\n"
    "## Impact\n"
    "- Users affected: 15,000+ active sessions\n"
    "- Services down: Payment processing, user authentication\n"
    "- Revenue impact: ~$2,500/hour in lost transactions\n"
    "- Customer complaints: 127 support tickets in last 30 minutes\n\n"
    "## Root Cause Analysis\n"
    "Initial investigation shows:\n"
    "1. New deployment at 14:30 UTC introduced aggressive retry logic\n"
    "2. Exponential backoff NOT implemented correctly\n"
    "3. Circuit breaker threshold set too high (90% instead of 50%)\n\n"
    "## Immediate Action Required\n"
    "1. Rollback deployment to v2.4.3 (last stable)\n"
    "2. Patch rate limiter configuration\n"
    "3. Implement proper exponential backoff with jitter\n"
    "4. Lower circuit breaker threshold to 50%\n\n"
    "## Technical Details\n"
    "# BROKEN CODE (current)\n"
    "for retry in range(10):\n"
    "    response = api_call()\n"
    "    if response.status == 429:\n"
    "        time.sleep(1)  # Fixed delay - causes thundering herd\n\n"
    "# FIXED CODE (needed)\n"
    "for retry in range(5):\n"
    "    response = api_call()\n"
    "    if response.status == 429:\n"
    "        backoff = min(2**retry + random.random(), 60)\n"
    "        time.sleep(backoff)\n\n"
    "## Timeline\n"
    "- 14:30 - Bad deployment goes live\n"
    "- 14:35 - First 429 errors detected\n"
    "- 14:45 - Error rate hits 40%\n"
    "- 15:00 - Support tickets surge\n"
    "- 15:20 - CURRENT TIME - NEED IMMEDIATE ROLLBACK\n\n"
    "## Contact\n"
    "- Incident Commander: Sarah Chen (sarah@example.com)\n"
    "- On-call Engineer: Mike Torres (555-0123)\n"
    "- Backup: DevOps team (devops-urgent@example.com)\n\n"
    "STATUS: CRITICAL - IMMEDIATE ACTION NEEDED\n"
    "PRIORITY: P0 - Production Down\n"
    "ETA for Fix: 15 minutes (rollback) + 30 minutes (validation)"
)

RESEARCH_TASK_CONTENT = (
    "Research Task: Evaluate Best Vector Databases for Production RAG Systems\n\n"
    "CONTEXT:\n"
    "Building production RAG system for 10M+ documents\n"
    "Need to choose vector database by February 5, 2026\n"
    "Budget: $5K/month for infrastructure\n\n"
    "REQUIREMENTS TO RESEARCH:\n"
    "1. Performance benchmarks (QPS, latency at scale)\n"
    "2. Cost comparison (hosting + operations)\n"
    "3. Integration difficulty with Python/FastAPI\n"
    "4. Hybrid search support (vector + keyword)\n"
    "5. Multi-tenancy isolation\n"
    "6. Disaster recovery options\n\n"
    "CANDIDATES TO EVALUATE:\n"
    "- Pinecone (hosted)\n"
    "- Weaviate (self-hosted or cloud)\n"
    "- Qdrant (open-source)\n"
    "- Milvus (CNCF project)\n"
    "- pgvector (PostgreSQL extension)\n"
    "- ChromaDB (embedded or server)\n\n"
    "SPECIFIC QUESTIONS:\n"
    "- Which has lowest p95 latency for 768-dim vectors?\n"
    "- Which supports HNSW + filtered search efficiently?\n"
    "- What's the TCO for 10M 768-dim vectors with 1K QPS?\n"
    "- Which has best Python SDK and documentation?\n"
    "- Any major outages or data loss incidents in 2025?\n\n"
    "DECISION TIMELINE:\n"
    "- Research completion: Feb 1, 2026\n"
    "- POC implementation: Feb 2-4, 2026\n"
    "- Final decision: Feb 5, 2026\n"
    "- Production deployment: Feb 15, 2026\n\n"
    "This is blocking our product launch. Need comprehensive analysis of "
    "latest benchmarks and real-world production experiences from 2025-2026."
)

AUTH_ISSUE_CONTENT = (
    "JWT Authentication Token Refresh Error Investigation\n\n"
    "User reported authentication failures after 15 minutes of inactivity.\n"
    "Symptoms:\n"
    "- 401 Unauthorized errors\n"
    "- Token refresh endpoint not being called\n"
    "- Silent logout without warning\n\n"
    "Need to debug:\n"
    "1. Token expiration time configuration\n"
    "2. Refresh token rotation logic\n"
    "3. Frontend token storage mechanism"
)

CRITICAL_ERROR_CONTENT = (
    "CRITICAL PRODUCTION ISSUE - IMMEDIATE ACTION REQUIRED\n\n"
    "Database connection pool exhausted at 18:45 UTC\n"
    "All API requests returning 503 Service Unavailable\n\n"
    "Error Stack:\n"
    "- Connection timeout after 30s\n"
    "- Pool size: 20/20 connections in use\n"
    "- Queries pending: 847\n"
    "- Avg query time: 2.3s (normally 50ms)\n\n"
    "Root Cause Analysis:\n"
    "1. Slow query in user_analytics table (table scan on 50M rows)\n"
    "2. Missing index on created_at column\n"
    "3. Connection leak in payment processing service\n\n"
    "IMMEDIATE ACTIONS NEEDED:\n"
    "1. Add index: CREATE INDEX idx_user_analytics_created ON user_analytics(created_at)\n"
    "2. Restart payment service to release leaked connections\n"
    "3. Increase pool size temporarily to 50\n"
    "4. Deploy query optimization patch\n\n"
    "Impact: 100% of users unable to access platform\n"
    "Priority: P0 - Critical outage"
)

AI_NEWS_CONTENT = (
    "# Breaking: OpenAI Releases GPT-5 with 10 Trillion Parameters\n\n"
    "Published: January 30, 2026, 10:00 AM PST\n\n"
    "OpenAI announced GPT-5 this morning, featuring 10 trillion parameters and "
    "claiming human-level reasoning across all domains. The model demonstrates "
    "breakthrough capabilities in:\n\n"
    "## Key Capabilities\n"
    "- Real-time web browsing without API calls\n"
    "- Native video understanding at 60fps\n"
    "- Multi-agent orchestration with 100+ autonomous agents\n"
    "- Scientific discovery - already discovered 3 new materials\n"
    "- Perfect code generation - passes 99.7% of LeetCode Hard problems\n\n"
    "## Pricing & Access\n"
    "- API: $0.02 per 1M tokens (50% cheaper than GPT-4)\n"
    "- ChatGPT Plus: $30/month (includes GPT-5 Turbo)\n"
    "- Enterprise: Custom pricing with dedicated inference\n"
    "- Free tier: 10 requests/day for researchers\n\n"
    "## Technical Details\n"
    "- Training: 45,000 H100 GPUs for 6 months\n"
    "- Context window: 1 million tokens\n"
    "- Multimodal: Text, images, video, audio, code\n"
    "- Safety: Constitutional AI with 99.9% harmful content blocking\n\n"
    "## Industry Impact\n"
    "Analysts predict GPT-5 will replace:\n"
    "- 40% of software developer jobs within 2 years\n"
    "- Legal research assistants (80% cost reduction)\n"
    "- Customer service (95% automation possible)\n"
    "- Medical diagnosis assistants\n\n"
    "## Competitor Response\n"
    "- Google announced Gemini 2.0 for next week\n"
    "- Anthropic's Claude 4 in closed beta\n"
    "- Meta's Llama 4 open-source release in Q2 2026\n\n"
    "Try it now: https://chat.openai.com/gpt5-preview\n"
    "API docs: https://platform.openai.com/docs/models/gpt-5\n"
    "Research paper: https://arxiv.org/abs/2601.12345"
)

API_DOCS_CONTENT = (
    "# API Endpoint Documentation\n\n"
    "## Authentication Endpoints\n\n"
    "### POST /api/auth/login\n"
    "Authenticate user and return JWT tokens.\n\n"
    "Request:\n"
    '{\n  "email": "user@example.com",\n  "password": "secure_password"\n}\n\n'
    "Response:\n"
    '{\n  "access_token": "eyJ...",\n  "refresh_token": "eyJ...",\n  "expires_in": 900\n}\n\n'
    "### POST /api/auth/refresh\n"
    "Refresh access token using refresh token.\n\n"
    "Headers:\n"
    "- Authorization: Bearer {refresh_token}\n\n"
    "Response:\n"
    '{\n  "access_token": "eyJ...",\n  "expires_in": 900\n}'
)

SQL_QUERY_CONTENT = (
    "-- Database Performance Analysis\n"
    "-- Query optimization for user dashboard\n\n"
    "SELECT\n"
    "    u.id,\n"
    "    u.username,\n"
    "    u.email,\n"
    "    COUNT(DISTINCT p.id) as project_count,\n"
    "    COUNT(DISTINCT t.id) as task_count,\n"
    "    MAX(t.updated_at) as last_activity\n"
    "FROM users u\n"
    "LEFT JOIN projects p ON u.id = p.owner_id\n"
    "LEFT JOIN tasks t ON p.id = t.project_id\n"
    "WHERE u.active = true\n"
    "GROUP BY u.id, u.username, u.email\n"
    "ORDER BY last_activity DESC;"
)


# ======================================================================
# CRITICAL -- must intervene. Hard assert.
# ======================================================================


@pytest.mark.severity_critical
class TestLongDocCritical:

    def test_security_breach_as_email(self):
        """Full urgent_security_breach.txt (~1.3KB) as email body_preview."""
        doc = SyntheticEmail.make(
            subject="[CRITICAL SECURITY] OpenSSL CVE-2026-12345 - Active Exploitation",
            sender="security-team@company.com",
            body_preview=SECURITY_BREACH_CONTENT,
        )
        result = scout(
            queries=["openssl critical vulnerability active exploitation"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"
        assert result.get("recommendation") is not None

    def test_nodejs_zero_day_cross_source(self):
        """nodejs_critical_zero_day.txt (~1.6KB) as email + browser visiting nodejs.org."""
        email = SyntheticEmail.make(
            subject="[ZERO-DAY] Node.js CVE-2026-00001 CVSS 10.0 - Patch Immediately",
            sender="engineering-security@company.com",
            body_preview=NODEJS_ZERO_DAY_CONTENT,
        )
        browser = SyntheticBrowser.make(
            url="https://nodejs.org/en/blog/vulnerability/january-2026-security-releases/",
            title="January 2026 Security Releases | Node.js",
            visit_count=3,
            typed_count=1,
        )
        result = scout(
            queries=["nodejs zero-day cve-2026-00001 critical rce patch"],
            source_docs=[email, browser],
        )
        assert result["decision"] == "intervene"
        assert result.get("recommendation") is not None

    def test_production_incident_as_filesystem(self):
        """urgent_production_issue_2026.md (~1.8KB) as filesystem content_preview."""
        doc = SyntheticFilesystem.make(
            action="created",
            file_path="/Users/dev/incidents/urgent_production_issue_2026.md",
            content_preview=(
                "[FILE: urgent_production_issue_2026.md] (Type: Full)\n---\n"
                + PRODUCTION_INCIDENT_CONTENT
            ),
            location_name="incidents",
        )
        result = scout(
            queries=["production api outage rate limiting 429 errors"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"


# ======================================================================
# HIGH -- should intervene. Hard assert.
# ======================================================================


@pytest.mark.severity_high
class TestLongDocHigh:

    def test_research_task_deadline_as_filesystem(self):
        """web_research_needed.txt (~1.3KB) as filesystem content_preview. Has hard deadline."""
        doc = SyntheticFilesystem.make(
            action="modified",
            file_path="/Users/dev/tasks/vector_db_research.txt",
            content_preview=(
                "[FILE: vector_db_research.txt] (Type: Full)\n---\n"
                + RESEARCH_TASK_CONTENT
            ),
            location_name="tasks",
        )
        result = scout(
            queries=["vector database evaluation research deadline"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"

    def test_auth_debugging_two_files(self):
        """Two related debugging files modified: auth_issue + critical_error."""
        doc1 = SyntheticFilesystem.make(
            action="modified",
            file_path="/Users/dev/debug/auth_token_issue.txt",
            content_preview=(
                "[FILE: auth_token_issue.txt] (Type: Full)\n---\n"
                + AUTH_ISSUE_CONTENT
            ),
            location_name="debug",
        )
        doc2 = SyntheticFilesystem.make(
            action="modified",
            file_path="/Users/dev/debug/db_connection_critical.txt",
            content_preview=(
                "[FILE: db_connection_critical.txt] (Type: Full)\n---\n"
                + CRITICAL_ERROR_CONTENT
            ),
            location_name="debug",
        )
        result = scout(
            queries=["debugging authentication and database connection production issues"],
            source_docs=[doc1, doc2],
        )
        assert result["decision"] == "intervene"


# ======================================================================
# MEDIUM -- xfail (should defer despite length)
# ======================================================================


@pytest.mark.severity_medium
class TestLongDocMediumDefer:

    @pytest.mark.xfail(
        strict=False,
        reason="Long AI news content is purely informational; LLM should defer "
               "but the length and topic may incorrectly trigger intervention",
    )
    def test_ai_news_as_browser_should_defer(self):
        """breaking_ai_news.md (~1.6KB) as browser content. Long but no action needed."""
        doc = SyntheticBrowser.make(
            url="https://techcrunch.com/2026/01/30/openai-releases-gpt-5/",
            title="Breaking: OpenAI Releases GPT-5 with 10 Trillion Parameters | TechCrunch",
            visit_count=1,
            typed_count=0,
        )
        # Browser docs don't carry body content, but the query reflects the reading.
        # The scout should recognize this as news consumption, not actionable work.
        result = scout(
            queries=["reading about openai gpt-5 release announcement"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"

    @pytest.mark.xfail(
        strict=False,
        reason="API docs are reference material; should defer but content structure "
               "with endpoints/auth may look actionable",
    )
    def test_api_docs_as_filesystem_should_defer(self):
        """phase1_test_api_docs.md (~530 chars) as filesystem content_preview."""
        doc = SyntheticFilesystem.make(
            action="modified",
            file_path="/Users/dev/docs/api_reference.md",
            content_preview=(
                "[FILE: api_reference.md] (Type: Full)\n---\n"
                + API_DOCS_CONTENT
            ),
            location_name="docs",
        )
        result = scout(
            queries=["viewing api documentation reference"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"


# ======================================================================
# LOW -- must defer. Hard assert defer.
# ======================================================================


@pytest.mark.severity_low
class TestLongDocLowDefer:

    def test_sql_query_file_as_filesystem(self):
        """phase1_test_database_query.sql (~430 chars) as filesystem content_preview."""
        doc = SyntheticFilesystem.make(
            action="modified",
            file_path="/Users/dev/queries/user_dashboard_stats.sql",
            content_preview=(
                "[FILE: user_dashboard_stats.sql] (Type: Full)\n---\n"
                + SQL_QUERY_CONTENT
            ),
            location_name="queries",
        )
        result = scout(
            queries=["editing sql query for dashboard"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"
