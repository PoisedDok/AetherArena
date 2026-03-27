"""
Unit tests for extract_search_query() — URL query parameter extraction.

Pure function tests. No mocks, no I/O, no network.
Covers all engines in SEARCH_PARAMS plus edge cases.
"""

from application.sources.chromium_history import extract_search_query


class TestExtractSearchQuery:
    """Tests for extract_search_query(url) → Optional[str]."""

    # ==========================================================================
    # GOOGLE VARIANTS
    # ==========================================================================

    def test_google_standard(self):
        url = "https://www.google.com/search?q=machine+learning&hl=en"
        assert extract_search_query(url) == "machine learning"

    def test_google_subdomain(self):
        url = "https://scholar.google.com/scholar?q=attention+mechanisms"
        assert extract_search_query(url) == "attention mechanisms"

    def test_google_country_tld(self):
        url = "https://www.google.co.uk/search?q=neural+networks"
        assert extract_search_query(url) == "neural networks"

    # ==========================================================================
    # OTHER SEARCH ENGINES
    # ==========================================================================

    def test_youtube(self):
        url = "https://www.youtube.com/results?search_query=python+tutorial"
        assert extract_search_query(url) == "python tutorial"

    def test_duckduckgo(self):
        url = "https://duckduckgo.com/?q=privacy+search+engine&t=h_&ia=web"
        assert extract_search_query(url) == "privacy search engine"

    def test_bing(self):
        url = "https://www.bing.com/search?q=fastapi+tutorial"
        assert extract_search_query(url) == "fastapi tutorial"

    def test_arxiv(self):
        url = "https://arxiv.org/search/?query=transformer+architecture&searchtype=all"
        assert extract_search_query(url) == "transformer architecture"

    def test_semantic_scholar(self):
        url = "https://www.semanticscholar.org/search?q=BERT+NLP&sort=relevance"
        assert extract_search_query(url) == "BERT NLP"

    def test_pubmed(self):
        url = "https://pubmed.ncbi.nlm.nih.gov/?term=covid+vaccine+efficacy"
        assert extract_search_query(url) == "covid vaccine efficacy"

    def test_amazon(self):
        url = "https://www.amazon.com/s?k=mechanical+keyboard"
        assert extract_search_query(url) == "mechanical keyboard"

    def test_reddit(self):
        url = "https://www.reddit.com/search/?q=python+vs+rust"
        assert extract_search_query(url) == "python vs rust"

    def test_baidu(self):
        url = "https://www.baidu.com/s?wd=deep+learning"
        assert extract_search_query(url) == "deep learning"

    def test_yandex(self):
        url = "https://yandex.com/search/?text=kubernetes+deployment"
        assert extract_search_query(url) == "kubernetes deployment"

    def test_brave(self):
        url = "https://search.brave.com/search?q=privacy+browser"
        assert extract_search_query(url) == "privacy browser"

    def test_ecosia(self):
        url = "https://www.ecosia.org/search?q=plant+trees"
        assert extract_search_query(url) == "plant trees"

    def test_wikipedia(self):
        url = "https://en.wikipedia.org/w/index.php?search=quantum+computing"
        assert extract_search_query(url) == "quantum computing"

    # ==========================================================================
    # EDGE CASES: RETURNS NONE
    # ==========================================================================

    def test_non_search_engine_url(self):
        url = "https://github.com/user/repo"
        assert extract_search_query(url) is None

    def test_empty_string(self):
        assert extract_search_query("") is None

    def test_none_input(self):
        assert extract_search_query(None) is None

    def test_malformed_url(self):
        assert extract_search_query("not_a_url_at_all") is None

    def test_google_without_query_param(self):
        url = "https://www.google.com/maps"
        assert extract_search_query(url) is None

    def test_google_empty_query_param(self):
        url = "https://www.google.com/search?q=&hl=en"
        assert extract_search_query(url) is None

    def test_file_protocol_url(self):
        url = "file:///home/user/papers/bert.pdf"
        assert extract_search_query(url) is None

    def test_localhost_url(self):
        url = "http://localhost:8080/dashboard"
        assert extract_search_query(url) is None

    # ==========================================================================
    # SUBDOMAIN MATCHING
    # ==========================================================================

    def test_www_subdomain_match(self):
        url = "https://www.duckduckgo.com/?q=test+query"
        assert extract_search_query(url) == "test query"

    def test_nested_subdomain(self):
        url = "https://search.yahoo.com/?q=something"
        # yahoo is not in SEARCH_PARAMS — returns None
        assert extract_search_query(url) is None

    # ==========================================================================
    # MULTIPLE QUERY PARAMS (FIRST VALUE USED)
    # ==========================================================================

    def test_multiple_q_params(self):
        url = "https://www.google.com/search?q=first+query&q=second+query"
        assert extract_search_query(url) == "first query"

    # ==========================================================================
    # URL ENCODING
    # ==========================================================================

    def test_percent_encoded_query(self):
        url = "https://www.google.com/search?q=caf%C3%A9+latte"
        result = extract_search_query(url)
        assert result is not None
        assert "caf" in result

    def test_plus_encoded_spaces(self):
        url = "https://www.google.com/search?q=hello+world"
        assert extract_search_query(url) == "hello world"
