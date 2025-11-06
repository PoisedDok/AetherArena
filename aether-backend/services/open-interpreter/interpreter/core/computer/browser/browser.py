"""Production-ready browser and web search for Open Interpreter."""

import os
import time
import requests
from typing import Dict, Optional, List
from bs4 import BeautifulSoup
import urllib.parse


class Browser:
    def __init__(self, computer):
        self.computer = computer
        self._driver = None
        self._search_cache = {}
        
    def _get_searxng_url(self):
        """Get SearXNG URL from configuration."""
        try:
            import toml
            from pathlib import Path
            backend_path = Path(__file__).parent.parent.parent.parent.parent.parent / "backend"
            config_file = backend_path / "models_config.toml"
            with open(config_file, 'r') as f:
                config = toml.load(f)
            return config["PROVIDERS"]["searxng_url"]
        except Exception:
            return "http://127.0.0.1:4000"

    def fast_search(self, query, max_results=8, engines=None, timeout=10, language="en", pageno=1):
        """
        Production-ready web search with robust error handling and fallbacks.
        
        Args:
            query: Search query string
            max_results: Maximum number of results to return (default: 8)
            engines: Comma-separated engine list or None for default (ignored, uses DDG)
            timeout: Request timeout in seconds (default: 10)
            language: Language code for results (default: "en")
            pageno: Page number for pagination (default: 1)
        
        Returns:
            Formatted search results string
        """
        return self.free_search(
            query, 
            max_results=max_results, 
            engines=engines, 
            timeout=timeout,
            language=language,
            pageno=pageno
        )

    def free_search(self, query, max_results=8, engines=None, language="en", timeout=10, pageno=1):
        """
        Production-ready web search using DuckDuckGo HTML (most reliable).
        Falls back to SearXNG only if DDG fails.
        
        Args:
            query: Search query string
            max_results: Maximum number of results to return (default: 8)
            engines: Engine selection (ignored for now, DDG is most reliable)
            language: Language code for results (default: "en")
            timeout: Request timeout in seconds (default: 10)
            pageno: Page number for pagination (default: 1)
            
        Returns:
            Formatted search results string or error message
        """
        # Check cache first (5 minute TTL)
        cache_key = f"search:{query.lower()}:{max_results}:{pageno}"
        if cache_key in self._search_cache:
            cached_time, cached_result = self._search_cache[cache_key]
            if time.time() - cached_time < 300:  # 5 minutes
                return cached_result
        
        # Clear old cache entries if too many
        if len(self._search_cache) > 100:
            cutoff = time.time() - 300
            self._search_cache = {
                k: v for k, v in self._search_cache.items() 
                if v[0] > cutoff
            }
        
        # PRIMARY: DuckDuckGo HTML (most reliable, no API key needed)
        try:
            result = self._search_duckduckgo(query, max_results, pageno, timeout)
            if result:
                self._search_cache[cache_key] = (time.time(), result)
                return result
        except Exception as e:
            print(f"DDG search failed: {e}, trying SearXNG fallback...")
        
        # FALLBACK: Try SearXNG
        try:
            result = self._search_searxng(query, max_results, engines, language, pageno, timeout)
            if result:
                self._search_cache[cache_key] = (time.time(), result)
                return result
        except Exception as e:
            print(f"SearXNG search failed: {e}")
        
        return f"All search backends failed for query: {query}\n\nPlease check your internet connection and ensure search services are accessible."

    def _search_duckduckgo(self, query, max_results=8, pageno=1, timeout=10, retry=True):
        """
        Direct DuckDuckGo HTML search - most reliable method.
        No API key required, returns clean results.
        """
        # DuckDuckGo HTML endpoint
        encoded_query = urllib.parse.quote_plus(query)
        
        # Calculate offset for pagination
        offset = (pageno - 1) * max_results
        
        url = f"https://html.duckduckgo.com/html/?q={encoded_query}"
        if offset > 0:
            url += f"&s={offset}"
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        }
        
        try:
            resp = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
            resp.raise_for_status()
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            if retry:
                # Retry once with longer timeout
                time.sleep(1)
                return self._search_duckduckgo(query, max_results, pageno, timeout + 5, retry=False)
            raise e
        
        soup = BeautifulSoup(resp.text, 'html.parser')
        results = soup.select('.result')
        
        # Check if we got blocked or rate limited
        if not results and "nojs" in resp.text.lower():
            # DDG is requiring JS - this means we might be rate limited
            if retry:
                time.sleep(2)
                return self._search_duckduckgo(query, max_results, pageno, timeout, retry=False)
        
        if not results:
            return None
        
        formatted = f"Search results for '{query}' (DuckDuckGo):\n\n"
        
        seen_urls = set()
        result_count = 0
        
        for result in results:
            if result_count >= max_results:
                break
            
            # Extract title
            title_elem = result.select_one('.result__title')
            if not title_elem:
                continue
            title = title_elem.get_text(strip=True)
            
            # Extract URL
            link_elem = result.select_one('.result__url')
            if not link_elem:
                continue
            url_text = link_elem.get_text(strip=True)
            
            # Build full URL
            if not url_text.startswith('http'):
                url_text = 'https://' + url_text
            
            if url_text in seen_urls:
                continue
            seen_urls.add(url_text)
            
            # Extract snippet
            snippet_elem = result.select_one('.result__snippet')
            snippet = snippet_elem.get_text(strip=True) if snippet_elem else ""
            
            result_count += 1
            formatted += f"{result_count}. {title}\n"
            if snippet:
                if len(snippet) > 200:
                    snippet = snippet[:197] + "..."
                formatted += f"   {snippet}\n"
            formatted += f"   URL: {url_text}\n\n"
        
        if result_count == 0:
            return None
            
        return formatted.rstrip()

    def _search_searxng(self, query, max_results=8, engines=None, language="en", pageno=1, timeout=10):
        """
        Fallback search using SearXNG.
        """
        searxng_url = self._get_searxng_url()
        search_url = f"{searxng_url}/search?format=json"
        
        if engines is None:
            engines = "duckduckgo"  # Use DDG engine in SearXNG as most reliable
        
        params = {
            "q": query,
            "engines": engines,
            "language": language,
            "pageno": pageno,
            "safesearch": 0,
        }
        
        try:
            resp = requests.get(
                search_url,
                params=params,
                timeout=timeout,
                headers={'User-Agent': 'Aether/1.0'}
            )
            
            if resp.status_code == 200:
                data = resp.json()
                results = data.get("results", [])
                
                if results and len(results) > 0:
                    return self._format_search_results(
                        query, results, 
                        max_results=max_results,
                        source=f"SearXNG ({engines})"
                    )
        except Exception:
            pass
        
        return None

    def _format_search_results(self, query, results: List[Dict], max_results: int = 8, source: str = "Web"):
        """Format search results into readable text."""
        formatted = f"Search results for '{query}' ({source}):\n\n"
        
        seen_urls = set()
        result_count = 0
        
        for r in results:
            if result_count >= max_results:
                break
                
            url = r.get("url", "")
            if not url or url in seen_urls:
                continue
                
            seen_urls.add(url)
            result_count += 1
            
            title = r.get("title", "").strip()
            snippet = (r.get("content") or r.get("description") or "").strip()
            
            formatted += f"{result_count}. {title}\n"
            if snippet:
                if len(snippet) > 200:
                    snippet = snippet[:197] + "..."
                formatted += f"   {snippet}\n"
            formatted += f"   URL: {url}\n\n"
        
        if result_count == 0:
            return None
            
        return formatted.rstrip()

    def extract_page(self, url, max_chars=4000):
        """
        Extract text content from a web page.
        """
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
            
            resp = requests.get(url, headers=headers, timeout=10)
            resp.raise_for_status()
            
            soup = BeautifulSoup(resp.text, 'html.parser')
            
            # Remove script and style tags
            for script in soup(["script", "style"]):
                script.decompose()
            
            # Get text
            text = soup.get_text()
            
            # Clean up whitespace
            lines = (line.strip() for line in text.splitlines())
            chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
            text = ' '.join(chunk for chunk in chunks if chunk)
            
            # Limit length
            if len(text) > max_chars:
                text = text[:max_chars] + "..."
            
            return f"Content from {url}:\n\n{text}"
            
        except Exception as e:
            return f"Failed to extract content from {url}: {str(e)}"

    def screenshot(self, url, save_path=None):
        """Take a screenshot of a web page (requires selenium)."""
        return "Screenshot functionality not yet implemented. Use extract_page() for content."
        
    def navigate(self, url):
        """Navigate to a URL (requires selenium)."""
        return "Browser navigation not yet implemented. Use extract_page() for content."
