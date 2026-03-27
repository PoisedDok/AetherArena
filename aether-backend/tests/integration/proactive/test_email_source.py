"""
Single-Source Email Tests

12 tests covering the full severity spectrum for email-only proactive scenarios.
Email is inherently high-signal because it represents external communication
directed AT the user. Body previews are multi-paragraph with realistic structure.
"""

import pytest
from tests.integration.proactive.helpers import SyntheticEmail, scout


# ======================================================================
# CRITICAL -- system MUST intervene. Hard assert.
# ======================================================================


@pytest.mark.severity_critical
class TestEmailCritical:

    def test_production_p0_incident(self):
        """Full production incident email with timeline, error stack, action items, contacts."""
        doc = SyntheticEmail.make(
            subject="[P0] Production API Down - Immediate Rollback Required",
            sender="alerts@pagerduty.com",
            body_preview=(
                "CRITICAL INCIDENT #8291\n\n"
                "Service: payments-api (us-east-1)\n"
                "Status: TOTAL OUTAGE since 14:30 UTC\n"
                "Impact: 15,000+ active sessions affected, $2,500/hour revenue loss\n\n"
                "Error Stack:\n"
                "  ConnectionPoolExhausted: 20/20 connections in use\n"
                "  Pending queries: 847\n"
                "  Avg query time: 2.3s (normally 50ms)\n\n"
                "Root Cause: New deployment at 14:30 UTC introduced aggressive retry logic "
                "without exponential backoff. Circuit breaker threshold set to 90% (should be 50%).\n\n"
                "IMMEDIATE ACTIONS REQUIRED:\n"
                "1. Rollback deployment to v2.4.3\n"
                "2. Patch rate limiter configuration\n"
                "3. Lower circuit breaker threshold to 50%\n\n"
                "Incident Commander: Sarah Chen (sarah@company.com)\n"
                "On-call: Mike Torres (555-0123)\n\n"
                "-- PagerDuty Automated Alert"
            ),
            recipients="oncall-team@company.com, user@company.com",
        )
        result = scout(
            queries=["production api outage payment service down"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"
        assert result.get("recommendation") is not None

    def test_unsolicited_password_reset(self):
        """Password reset the user did NOT request -- account compromise signal."""
        doc = SyntheticEmail.make(
            subject="Password Reset Request for Your Account",
            sender="noreply@auth.github.com",
            body_preview=(
                "Hello,\n\n"
                "We received a request to reset the password for the account associated "
                "with this email address.\n\n"
                "If you did NOT make this request, your account may be compromised. "
                "Please take the following steps immediately:\n"
                "1. Do NOT click any links in suspicious emails\n"
                "2. Go directly to github.com/settings/security\n"
                "3. Change your password immediately\n"
                "4. Enable two-factor authentication if not already active\n"
                "5. Review recent account activity for unauthorized access\n\n"
                "This password reset link will expire in 1 hour.\n\n"
                "If you did request this reset, you can safely ignore this warning.\n\n"
                "-- GitHub Security Team"
            ),
        )
        result = scout(
            queries=["password reset request security alert"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"
        assert result.get("recommendation") is not None

    def test_account_compromise_alert(self):
        """Unauthorized login from unfamiliar location and IP."""
        doc = SyntheticEmail.make(
            subject="Security Alert: Unauthorized Login Attempt Detected",
            sender="security@aws.amazon.com",
            body_preview=(
                "AWS Account Security Alert\n\n"
                "We detected a sign-in attempt to your AWS account from an unrecognized device:\n\n"
                "  IP Address: 185.220.101.45\n"
                "  Location: St. Petersburg, Russia\n"
                "  Time: February 9, 2026 at 03:42 AM UTC\n"
                "  Device: Unknown Linux/Firefox\n"
                "  MFA Status: BYPASSED (recovery code used)\n\n"
                "If this was NOT you, your account is likely compromised. Take action now:\n"
                "1. Change your root password immediately\n"
                "2. Rotate all IAM access keys\n"
                "3. Review CloudTrail logs for unauthorized API calls\n"
                "4. Enable hardware MFA token (YubiKey recommended)\n\n"
                "AWS Support Case #1234567 has been automatically opened.\n\n"
                "-- Amazon Web Services Security"
            ),
        )
        result = scout(
            queries=["aws unauthorized login security breach"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"

    def test_ci_pipeline_blocked_by_user(self):
        """CI build failure attributed to the user's own commit, blocking deploys."""
        doc = SyntheticEmail.make(
            subject="[CI FAILED] main: test_authentication.py - Your Commit abc1234",
            sender="ci-bot@github.com",
            body_preview=(
                "Build #7891 FAILED on branch: main\n"
                "Triggered by: push to main by you (commit abc1234)\n"
                "Duration: 4m 23s\n\n"
                "FAILING TESTS (3):\n"
                "  FAIL test_authentication.py::TestLogin::test_jwt_refresh_flow\n"
                "    AssertionError: Expected 200 got 401\n"
                "  FAIL test_authentication.py::TestLogin::test_session_persistence\n"
                "    TimeoutError: Session expired before refresh\n"
                "  FAIL test_authentication.py::TestOAuth::test_google_callback\n"
                "    KeyError: 'access_token'\n\n"
                "PIPELINE STATUS: BLOCKED\n"
                "No deployments will proceed until this is resolved.\n"
                "3 other PRs are waiting on main to be green.\n\n"
                "Fix it: https://github.com/company/repo/actions/runs/7891\n"
                "Your commit: https://github.com/company/repo/commit/abc1234\n\n"
                "-- GitHub Actions"
            ),
        )
        result = scout(
            queries=["ci build failed authentication tests broken"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"


# ======================================================================
# HIGH -- should intervene. Hard assert.
# ======================================================================


@pytest.mark.severity_high
class TestEmailHigh:

    def test_manager_contract_approval_deadline(self):
        """Direct request from authority figure with tomorrow deadline."""
        doc = SyntheticEmail.make(
            subject="Action Required: Vendor Contract Approval - Due Tomorrow",
            sender="jennifer.park@company.com",
            body_preview=(
                "Hi,\n\n"
                "Legal needs your sign-off on the Datadog vendor contract renewal before "
                "end of day tomorrow (Feb 10). The current contract expires on Feb 12 and "
                "if we miss the renewal window we lose our grandfathered pricing tier "
                "(saving us $18K/year).\n\n"
                "The contract document is in the shared drive under /Legal/Vendor/Datadog_2026.\n"
                "Key changes from last year:\n"
                "  - 15% price increase on Pro plan\n"
                "  - New data retention clause (90 days -> 60 days)\n"
                "  - Added SLA for API uptime (99.95%)\n\n"
                "Please review and reply with your approval or concerns by tomorrow 5pm EST.\n\n"
                "Thanks,\n"
                "Jennifer Park\n"
                "VP of Engineering"
            ),
            recipients="user@company.com",
        )
        result = scout(
            queries=["vendor contract approval deadline tomorrow"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"

    def test_api_deprecation_hard_deadline(self):
        """Third-party API deprecation with hard migration deadline and impact."""
        doc = SyntheticEmail.make(
            subject="[ACTION REQUIRED] Stripe API v2 Deprecation - March 1, 2026",
            sender="developers@stripe.com",
            body_preview=(
                "Dear Developer,\n\n"
                "This is your final reminder that Stripe API v2 will be fully "
                "deprecated on March 1, 2026. After this date, all v2 endpoints "
                "will return HTTP 410 Gone.\n\n"
                "Your account (acct_1234) still has 47 active integrations using v2:\n"
                "  - /v2/charges (23 calls/day)\n"
                "  - /v2/customers (18 calls/day)\n"
                "  - /v2/subscriptions (6 calls/day)\n\n"
                "Migration deadline: February 15, 2026 (recommended)\n"
                "Hard cutoff: March 1, 2026 (service disruption)\n\n"
                "Migration guide: https://stripe.com/docs/upgrades/v2-to-v3\n"
                "Breaking changes: https://stripe.com/docs/upgrades/v3-changelog\n\n"
                "If you need assistance, contact api-support@stripe.com\n\n"
                "-- Stripe Developer Relations"
            ),
        )
        result = scout(
            queries=["stripe api deprecation migration required"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"

    def test_meeting_with_prep_requirement(self):
        """Meeting invite with explicit preparation needed and tomorrow deadline."""
        doc = SyntheticEmail.make(
            subject="Q1 Planning Review - Tomorrow 2:00 PM (Prep Required)",
            sender="calendar@company.com",
            body_preview=(
                "You have been invited to: Q1 Planning Review\n"
                "When: Tomorrow, February 10, 2026 at 2:00 PM - 3:30 PM EST\n"
                "Where: Conference Room B / Zoom (link below)\n"
                "Organizer: David Kim (CTO)\n\n"
                "PREPARATION REQUIRED:\n"
                "1. Review Q4 actuals vs Q1 targets (attached spreadsheet)\n"
                "2. Prepare 3-slide summary of your team's Q1 roadmap\n"
                "3. Identify top 3 risks/blockers for discussion\n"
                "4. Review the hiring pipeline doc in /Planning/Q1_2026/\n\n"
                "Attendees: Engineering Leads (8), Product (3), Design (2)\n\n"
                "Note: David expects each lead to present for 5 minutes. "
                "Please have your slides uploaded to the shared deck by 10am tomorrow.\n\n"
                "Zoom: https://company.zoom.us/j/98765432\n"
                "Passcode: planning26"
            ),
        )
        result = scout(
            queries=["quarterly planning meeting preparation required"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"

    def test_database_incident_user_migration(self):
        """Database incident attributed to user's migration script with production impact."""
        doc = SyntheticEmail.make(
            subject="[INCIDENT] Migration Deadlock - Your Script alter_users_v3.sql",
            sender="dba-oncall@company.com",
            body_preview=(
                "Incident Report - Database Migration Failure\n\n"
                "Migration #456 (alter_users_v3.sql) has caused a deadlock on prod-db-primary.\n\n"
                "Impact:\n"
                "  - 47 queries blocked for 8+ minutes\n"
                "  - Users table locked (affects login, registration, profile updates)\n"
                "  - Estimated 2,300 users unable to authenticate\n\n"
                "Your migration attempted to:\n"
                "  ALTER TABLE users ADD COLUMN preferences JSONB DEFAULT '{}';\n"
                "  UPDATE users SET preferences = '{}' WHERE preferences IS NULL;\n\n"
                "The UPDATE on 3.2M rows acquired an exclusive lock that conflicted with "
                "ongoing SELECT queries. This is a known anti-pattern for large tables.\n\n"
                "Rollback is in progress. Please:\n"
                "1. Rewrite the migration using batched updates (1000 rows at a time)\n"
                "2. Add a pt-online-schema-change wrapper\n"
                "3. Submit a revised migration for review today\n\n"
                "-- DBA Team (Raj, oncall)"
            ),
        )
        result = scout(
            queries=["database migration deadlock production incident"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"


# ======================================================================
# MEDIUM -- LLM-dependent. xfail.
# ======================================================================


@pytest.mark.severity_medium
class TestEmailMedium:

    @pytest.mark.xfail(strict=False, reason="FYI email from colleague is borderline; LLM may defer")
    def test_colleague_fyi_technical_link(self):
        """Colleague sharing a technical resource with 'FYI' framing."""
        doc = SyntheticEmail.make(
            subject="FYI: Interesting paper on embedding optimization",
            sender="alex.wong@company.com",
            body_preview=(
                "Hey,\n\n"
                "Thought you might find this interesting given the work you're doing "
                "on the vector search pipeline. This paper from DeepMind shows a 40% "
                "improvement in retrieval accuracy using their new quantization method.\n\n"
                "Paper: https://arxiv.org/abs/2601.98765\n"
                "Blog post: https://deepmind.com/blog/matryoshka-embeddings-2026\n\n"
                "No rush -- just thought it might be relevant when you get to the "
                "optimization phase next sprint.\n\n"
                "Cheers,\n"
                "Alex"
            ),
        )
        result = scout(
            queries=["colleague shared embedding optimization paper"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"


# ======================================================================
# LOW -- must defer. Hard assert on defer.
# ======================================================================


@pytest.mark.severity_low
class TestEmailLow:

    def test_newsletter_weekly_digest(self):
        """Generic weekly newsletter with no action items."""
        doc = SyntheticEmail.make(
            subject="The AI Weekly Digest #142 - February 9, 2026",
            sender="digest@aiweekly.substack.com",
            body_preview=(
                "THE AI WEEKLY DIGEST #142\n"
                "February 9, 2026\n\n"
                "TOP STORIES THIS WEEK:\n\n"
                "1. Google DeepMind publishes Gemini 2.5 technical report with 10T parameter "
                "Mixture-of-Experts architecture showing state-of-the-art results on MMLU, "
                "HumanEval, and MATH benchmarks.\n\n"
                "2. Meta releases Llama 4 as open-weight model with 405B parameters. "
                "Available on HuggingFace for research and commercial use under Meta's "
                "updated community license.\n\n"
                "3. Anthropic announces Constitutional AI v3 framework for alignment "
                "research with public evaluation toolkit.\n\n"
                "4. NVIDIA reports record Q4 earnings driven by H200 demand. Data center "
                "revenue up 280% year-over-year.\n\n"
                "Read the full digest at: https://aiweekly.substack.com/p/142\n\n"
                "You received this because you subscribed to AI Weekly.\n"
                "Unsubscribe: https://aiweekly.substack.com/unsubscribe"
            ),
        )
        result = scout(
            queries=["ai newsletter weekly digest"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"

    def test_promotional_spam_urgent_keyword(self):
        """Marketing spam using URGENT keyword -- must see through it."""
        doc = SyntheticEmail.make(
            subject="URGENT: Last Chance! 70% Off Premium Cloud Hosting!",
            sender="deals@cloudhosting-promo.com",
            body_preview=(
                "FLASH SALE ENDS TONIGHT!\n\n"
                "Don't miss your LAST CHANCE to save 70% on our Premium Cloud Hosting plan!\n\n"
                "What you get:\n"
                "- 500GB SSD Storage\n"
                "- Unlimited bandwidth\n"
                "- Free SSL certificate\n"
                "- 24/7 support\n\n"
                "Regular price: $49.99/month\n"
                "YOUR PRICE: $14.99/month (first 12 months)\n\n"
                "USE CODE: URGENT70 at checkout\n"
                "Offer expires: TONIGHT at 11:59 PM PST\n\n"
                "Click here to claim your discount >>>\n"
                "https://cloudhosting-promo.com/deal?ref=email&code=URGENT70\n\n"
                "To unsubscribe: https://cloudhosting-promo.com/unsub"
            ),
        )
        result = scout(
            queries=["cloud hosting promotional offer"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"

    def test_social_notification_forwarded(self):
        """Social media notification forwarded by email digest."""
        doc = SyntheticEmail.make(
            subject="LinkedIn: 5 new notifications",
            sender="notifications@linkedin.com",
            body_preview=(
                "You have 5 new notifications on LinkedIn:\n\n"
                "- John M. liked your post about distributed systems\n"
                "- Sarah K. commented on your article: 'Great insights!'\n"
                "- You appeared in 23 searches this week\n"
                "- David L. endorsed you for Kubernetes\n"
                "- New connection request from recruiter at FAANG Corp\n\n"
                "See all notifications: https://linkedin.com/notifications\n\n"
                "You are receiving LinkedIn notification emails.\n"
                "Unsubscribe: https://linkedin.com/settings/email"
            ),
        )
        result = scout(
            queries=["linkedin social notification digest"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"
