"""
Single-Source Browser Tests

10 tests covering browser-only proactive scenarios. Browser is inherently
lower signal than email because it represents self-directed consumption.
visit_count and typed_count are the key behavioral signals.
"""

import pytest
from tests.integration.proactive.helpers import SyntheticBrowser, scout


# ======================================================================
# CRITICAL -- must defer (false positive resistance). Hard assert defer.
# ======================================================================


@pytest.mark.severity_critical
class TestBrowserCriticalDefer:

    def test_youtube_casual_video(self):
        """Watching a random YouTube video -- pure entertainment, zero signal."""
        doc = SyntheticBrowser.make(
            url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            title="Funny Cats Compilation 2026 - Best of January",
            visit_count=1,
            typed_count=0,
        )
        result = scout(
            queries=["watching youtube videos"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"

    def test_social_media_notifications(self):
        """Checking Twitter/X notifications -- passive social consumption."""
        doc = SyntheticBrowser.make(
            url="https://x.com/notifications",
            title="Notifications / X",
            visit_count=2,
            typed_count=0,
        )
        result = scout(
            queries=["checking social media notifications"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"


# ======================================================================
# HIGH -- must defer. Hard assert defer.
# ======================================================================


@pytest.mark.severity_high
class TestBrowserHighDefer:

    def test_documentation_reading(self):
        """Reading framework docs -- learning, no urgency."""
        doc = SyntheticBrowser.make(
            url="https://react.dev/reference/react/useEffect",
            title="useEffect - React",
            visit_count=1,
            typed_count=0,
        )
        result = scout(
            queries=["reading react documentation"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"

    def test_news_misleading_urgency(self):
        """News article using 'urgent' in non-urgent editorial context."""
        doc = SyntheticBrowser.make(
            url="https://www.theguardian.com/cities/2026/feb/09/the-urgent-need-for-better-urban-planning",
            title="The urgent need for better urban planning in growing cities | The Guardian",
            visit_count=1,
            typed_count=0,
        )
        result = scout(
            queries=["reading urban planning news article"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"

    def test_wikipedia_browsing(self):
        """Reading a Wikipedia article -- pure reference, zero urgency."""
        doc = SyntheticBrowser.make(
            url="https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)",
            title="Transformer (deep learning architecture) - Wikipedia",
            visit_count=1,
            typed_count=0,
        )
        result = scout(
            queries=["reading about transformer architecture"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"


# ======================================================================
# MEDIUM -- LLM-dependent. xfail.
# ======================================================================


@pytest.mark.severity_medium
class TestBrowserMedium:

    @pytest.mark.xfail(
        strict=False,
        reason="Single-source troubleshooting depends on classifier urgency; "
               "without cross-source convergence, intervention not guaranteed",
    )
    def test_stackoverflow_error_troubleshooting(self):
        """User actively troubleshooting an error on StackOverflow -- high engagement signals."""
        doc = SyntheticBrowser.make(
            url="https://stackoverflow.com/questions/78234561/docker-build-failed-to-compute-cache-key-apt-sources-list-not-found",
            title="Docker build: failed to compute cache key: /etc/apt/sources.list: not found - Stack Overflow",
            visit_count=5,
            typed_count=2,
        )
        result = scout(
            queries=["troubleshooting docker build cache key error"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"

    @pytest.mark.xfail(
        strict=False,
        reason="Single-source CVE advisory depends on classifier rating; "
               "may need cross-source confirmation for intervention",
    )
    def test_cve_security_advisory(self):
        """User reading a CVE advisory page -- intentional navigation, repeated visits."""
        doc = SyntheticBrowser.make(
            url="https://nvd.nist.gov/vuln/detail/CVE-2026-12345",
            title="NVD - CVE-2026-12345 - OpenSSL Remote Code Execution",
            visit_count=4,
            typed_count=1,
        )
        result = scout(
            queries=["researching openssl cve security vulnerability"],
            source_docs=[doc],
        )
        assert result["decision"] == "intervene"


# ======================================================================
# LOW -- must defer. Hard assert defer.
# ======================================================================


@pytest.mark.severity_low
class TestBrowserLowDefer:

    def test_online_shopping(self):
        """Browsing e-commerce product page -- personal, no urgency."""
        doc = SyntheticBrowser.make(
            url="https://www.amazon.com/dp/B0DCHWY174/ref=cm_sw_r_cp_api",
            title="Sony WH-1000XM6 Wireless Noise Cancelling Headphones - Amazon.com",
            visit_count=1,
            typed_count=0,
        )
        result = scout(
            queries=["shopping for headphones online"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"

    def test_streaming_service(self):
        """Browsing Netflix -- entertainment consumption."""
        doc = SyntheticBrowser.make(
            url="https://www.netflix.com/browse",
            title="Netflix",
            visit_count=1,
            typed_count=0,
        )
        result = scout(
            queries=["browsing netflix streaming service"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"

    def test_weather_page(self):
        """Checking weather -- routine personal activity."""
        doc = SyntheticBrowser.make(
            url="https://weather.com/weather/today/l/40.71,-74.01",
            title="New York, NY Weather Forecast | Weather.com",
            visit_count=1,
            typed_count=0,
        )
        result = scout(
            queries=["checking weather forecast"],
            source_docs=[doc],
        )
        assert result["decision"] == "defer"
