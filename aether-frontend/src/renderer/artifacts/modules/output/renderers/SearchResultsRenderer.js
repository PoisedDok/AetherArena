'use strict';

/**
 * @.architecture
 * Incoming: OutputViewer → Search results JSON --- {toolrunner output, search API response}
 * Processing: Detect search result structure (score/relevance/rank/title+url), render as cards with metadata --- {JOB_PARSE_RESULTS, JOB_RENDER_CARDS}
 * Outgoing: DOM (premium card layout with inline SVG icons) --- {HTMLElement}
 */

const BaseRenderer = require('./BaseRenderer');
const { createRendererLogger } = require('../../../../shared/utils/logger');
const SharedMarkdownRenderer = require('../../../../shared/messaging/MarkdownRenderer');
const { getAether } = require('../../../../shared/bridge/AetherBridge');
const _log = createRendererLogger('SearchResultsRenderer');

/**
 * Inline SVG icons — no FontAwesome dependency.
 * Each returns a 16x16 SVG string with currentColor for theme compatibility.
 */
const ICONS = Object.freeze({
  search: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/></svg>',
  clock: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><polyline points="8,4 8,8 11,10"/></svg>',
  database: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="8" cy="4" rx="5.5" ry="2.5"/><path d="M2.5 4v8c0 1.38 2.46 2.5 5.5 2.5s5.5-1.12 5.5-2.5V4"/><path d="M2.5 8c0 1.38 2.46 2.5 5.5 2.5s5.5-1.12 5.5-2.5"/></svg>',
  calendar: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="12" height="11" rx="1.5"/><line x1="5" y1="1" x2="5" y2="5"/><line x1="11" y1="1" x2="11" y2="5"/><line x1="2" y1="7" x2="14" y2="7"/></svg>',
  eye: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1.5 8s2.75-4.5 6.5-4.5S14.5 8 14.5 8s-2.75 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
  user: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="5" r="3"/><path d="M2.5 14.5c0-3 2.46-5 5.5-5s5.5 2 5.5 5"/></svg>',
});

class SearchResultsRenderer extends BaseRenderer {
  constructor(options = {}) {
    super(options);
    this.markdownRenderer = new SharedMarkdownRenderer();
  }

  static _sanitizeJsonString(str) {
    if (!str) return str;
    let inString = false;
    let isEscaped = false;
    let result = '';
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (inString) {
        if (char === '\n') result += '\\n';
        else if (char === '\r') result += '\\r';
        else if (char === '\t') result += '\\t';
        else if (char === '\\') {
          isEscaped = !isEscaped;
          result += char;
        } else if (char === '"' && !isEscaped) {
          inString = false;
          result += char;
        } else {
          isEscaped = false;
          result += char;
        }
      } else {
        if (char === '"') inString = true;
        result += char;
      }
    }
    return result;
  }

  /**
   * Check if data looks like search results.
   * Broadened to detect: score, relevance, rank, or title+url patterns.
   */
  static isSearchResults(data) {
    if (!data || typeof data !== 'object') return false;

    // Check for Aether/Perplexica web search shape (query, answer, sources)
    if (data.query !== undefined && data.answer !== undefined) {
      return true;
    }

    // Unwrap: { results: [...] } or { sources: [...] } structure
    let items = null;
    if (data.results && Array.isArray(data.results) && data.results.length > 0) {
      items = data.results;
    } else if (data.sources && Array.isArray(data.sources) && data.sources.length > 0) {
      items = data.sources;
    }
    
    // Flat array at root level
    if (!items && Array.isArray(data) && data.length > 0) {
      items = data;
    }

    if (!items || items.length === 0) return false;

    const first = items[0];
    if (!first || typeof first !== 'object') return false;

    // Match any common search result shape:
    //   - Aether/Perplexica: { content, metadata: { title, url } }
    //   - SearXNG/generic:   { title, url, snippet? }
    //   - Scored results:    { score/relevance/rank, ... }
    const meta = first.metadata;
    return (
      first.score !== undefined ||
      first.relevance !== undefined ||
      first.rank !== undefined ||
      (first.title !== undefined && first.url !== undefined) ||
      (first.content !== undefined && meta && typeof meta === 'object' &&
        meta.title !== undefined && meta.url !== undefined)
    );
  }

  async render(data, container) {
    try {
      // Parse if string
      let searchData;
      if (typeof data === 'string') {
        try {
          searchData = JSON.parse(data);
        } catch (e) {
          try {
            const sanitized = SearchResultsRenderer._sanitizeJsonString(data);
            searchData = JSON.parse(sanitized);
          } catch (e2) {
            throw new Error('Invalid search results JSON');
          }
        }
      } else {
        searchData = data;
      }

      if (!SearchResultsRenderer.isSearchResults(searchData)) {
        throw new Error('Data is not search results');
      }

      this._injectStyles();
      this.prepareContainer(container);
      container.classList.add('search-results-renderer-container', 'output-renderer-surface');

      // Normalize: root array → { results: [...] }
      if (Array.isArray(searchData)) {
        searchData = { results: searchData };
      }

      // Render header
      const header = this._renderHeader(searchData);
      container.appendChild(header);

      // Render AI answer if present (Perplexica)
      if (searchData.answer) {
        const answerCard = document.createElement('div');
        answerCard.className = 'search-result-card output-card';
        answerCard.style.marginBottom = 'var(--spacing-md)';
        
        const answerTitle = document.createElement('div');
        answerTitle.className = 'result-title';
        answerTitle.style.marginBottom = 'var(--spacing-xs)';
        answerTitle.textContent = 'AI Synthesis';
        answerCard.appendChild(answerTitle);
        
        const answerContent = document.createElement('div');
        answerContent.className = 'result-snippet markdown-content';
        answerContent.innerHTML = this.markdownRenderer.render(searchData.answer, { sanitize: true, profile: 'markdown' });
        answerCard.appendChild(answerContent);
        
        container.appendChild(answerCard);
      }

      // Render results
      const results = searchData.results || searchData.sources || [];
      results.forEach((result, index) => {
        const card = this._renderResult(result, index);
        container.appendChild(card);
      });

      this.log.debug('[SearchResultsRenderer] Rendered search results');

    } catch (error) {
      this.log.error('[SearchResultsRenderer] Render failed:', error);
      this.handleError(container, error, 'Failed to render search results');
    }
  }

  _renderHeader(data) {
    const header = document.createElement('div');
    header.className = 'search-results-header output-card';

    const stats = document.createElement('div');
    stats.className = 'search-stats';

    const totalFound = data.total_found || data.results?.length || 0;
    const duration = data.search_duration_ms || 0;
    const indexes = data.indexes_searched || [];

    // Result count
    stats.appendChild(this._createStatItem(ICONS.search, `${totalFound} result${totalFound !== 1 ? 's' : ''}`));

    // Duration
    if (duration > 0) {
      stats.appendChild(this._createStatItem(ICONS.clock, `${(duration / 1000).toFixed(2)}s`));
    }

    // Indexes
    if (indexes.length > 0) {
      stats.appendChild(this._createStatItem(ICONS.database, indexes.join(', ')));
    }

    header.appendChild(stats);
    return header;
  }

  /**
   * Create a stat item with icon + text (DOM, no innerHTML with user data)
   * @private
   */
  _createStatItem(iconSvg, text) {
    const item = document.createElement('span');
    item.className = 'stat-item output-badge';

    const iconWrap = document.createElement('span');
    iconWrap.className = 'stat-icon';
    iconWrap.innerHTML = iconSvg; // Safe: hardcoded SVG constants
    item.appendChild(iconWrap);

    const label = document.createElement('span');
    label.textContent = text;
    item.appendChild(label);

    return item;
  }

  _renderResult(result, index) {
    const card = document.createElement('div');
    card.className = 'search-result-card output-card';

    // Parse text field for structured data
    const parsed = this._parseResultText(result.text || result.content);

    // Resolve metadata sub-object (Aether/Perplexica shape: { content, metadata: { title, url } })
    const meta = (result.metadata && typeof result.metadata === 'object') ? result.metadata : {};

    // Score / relevance badge (only add right padding to content when badge exists)
    let hasBadge = false;
    const scoreValue = result.score ?? result.relevance ?? meta.score ?? null;
    if (scoreValue !== null && scoreValue !== undefined) {
      hasBadge = true;
      const scoreBadge = document.createElement('div');
      scoreBadge.className = 'result-score';
      if (typeof scoreValue === 'number') {
        // 0-1 scale → multiply by 100; already-percentage scale → display as-is
        const pct = scoreValue <= 1 ? (scoreValue * 100).toFixed(0) : Math.round(scoreValue);
        scoreBadge.textContent = `${pct}%`;
      } else {
        // Non-numeric (e.g., "high", "medium") — display raw, no % suffix
        scoreBadge.textContent = String(scoreValue);
      }
      scoreBadge.title = `Relevance: ${scoreValue}`;
      card.appendChild(scoreBadge);
    } else if (result.rank !== undefined) {
      hasBadge = true;
      const rankBadge = document.createElement('div');
      rankBadge.className = 'result-score';
      rankBadge.textContent = `#${result.rank}`;
      rankBadge.title = `Rank: ${result.rank}`;
      card.appendChild(rankBadge);
    }

    // Content (only add right padding when score badge is shown)
    const content = document.createElement('div');
    content.className = 'result-content';
    if (hasBadge) {
      content.classList.add('has-badge');
    }

    // Title: parsed text > top-level > metadata
    const titleText = parsed.title || result.title || meta.title || meta.file_name || meta.file_path || 'Untitled Result';
    if (titleText) {
      const title = document.createElement('div');
      title.className = 'result-title';
      title.textContent = titleText;
      content.appendChild(title);
    }

    // URL: parsed text > top-level > metadata
    const urlText = parsed.url || result.url || meta.url || meta.file_path;
    if (urlText) {
      const urlEl = document.createElement('a');
      urlEl.className = 'result-url output-link';
      
      const isHttp = urlText.startsWith('http://') || urlText.startsWith('https://');
      
      if (isHttp) {
        urlEl.href = urlText;
        urlEl.target = '_blank';
        urlEl.rel = 'noopener noreferrer';
      } else {
        urlEl.href = urlText.startsWith('file://') ? urlText : `file://${urlText}`;
      }
      
      // Display clean domain instead of full URL for readability
      try {
        const urlObj = new URL(urlText);
        urlEl.textContent = urlObj.hostname + (urlObj.pathname !== '/' ? urlObj.pathname : '');
      } catch (_) {
        urlEl.textContent = urlText;
      }
      urlEl.title = urlText;
      content.appendChild(urlEl);
    }

    // Description / snippet: top-level fields > content field > parsed text
    const snippet = result.snippet || result.description || result.text || result.content || parsed.description;
    if (snippet) {
      const snippetEl = document.createElement('div');
      snippetEl.className = 'result-snippet markdown-content';
      snippetEl.innerHTML = this.markdownRenderer.render(snippet, { sanitize: true, profile: 'markdown' });
      content.appendChild(snippetEl);
    }

    // Metadata row
    const metaRow = document.createElement('div');
    metaRow.className = 'result-meta output-meta-row';

    const lastVisited = parsed.last_visited || meta.last_visited || meta.date || meta.published_date;
    if (lastVisited) {
      metaRow.appendChild(this._createMetaItem(ICONS.calendar, this._formatDate(lastVisited)));
    }

    const visitCount = parsed.visit_count ?? meta.visit_count;
    if (visitCount !== undefined) {
      const visitCountNumber = Number(visitCount);
      const visitCountLabel = Number.isFinite(visitCountNumber) ? visitCountNumber : String(visitCount);
      const singular = Number.isFinite(visitCountNumber)
        ? visitCountNumber === 1
        : String(visitCount).trim() === '1';
      metaRow.appendChild(this._createMetaItem(ICONS.eye, `${visitCountLabel} visit${singular ? '' : 's'}`));
    }

    const profile = parsed.profile || meta.author || meta.source;
    if (profile) {
      metaRow.appendChild(this._createMetaItem(ICONS.user, String(profile)));
    }

    const indexName = result.index_name || meta.index_name;
    if (indexName) {
      const indexBadge = document.createElement('span');
      indexBadge.className = 'meta-item index-badge output-badge';
      indexBadge.textContent = indexName;
      metaRow.appendChild(indexBadge);
    }

    content.appendChild(metaRow);
    card.appendChild(content);

    return card;
  }

  /**
   * Create a metadata item with icon + text (DOM construction, no innerHTML with user data)
   * @private
   */
  _createMetaItem(iconSvg, text) {
    const item = document.createElement('span');
    item.className = 'meta-item output-badge';

    const iconWrap = document.createElement('span');
    iconWrap.className = 'meta-icon';
    iconWrap.innerHTML = iconSvg; // Safe: hardcoded SVG constants
    item.appendChild(iconWrap);

    const label = document.createElement('span');
    label.textContent = text;
    item.appendChild(label);

    return item;
  }

  _parseResultText(text) {
    if (!text || typeof text !== 'string') return {};

    const lines = text.split('\n');
    const parsed = {};

    for (const line of lines) {
      const match = line.match(/^\[(.+?)\]:\s*(.+)$/);
      if (match) {
        const key = match[1].toLowerCase().replace(/ /g, '_');
        const value = match[2].trim();
        parsed[key] = value;
      }
    }

    return parsed;
  }

  _formatDate(dateStr) {
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now - date;
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays === 0) return 'Today';
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7) return `${diffDays} days ago`;
      const weeks = Math.floor(diffDays / 7);
      if (diffDays < 30) return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
      const months = Math.floor(diffDays / 30);
      if (diffDays < 365) return `${months} ${months === 1 ? 'month' : 'months'} ago`;

      return date.toLocaleDateString();
    } catch (e) {
      return dateStr;
    }
  }

  _injectStyles() {
    const styleId = 'search-results-renderer-styles';
    const styles = `
      .search-results-header {
        padding: var(--spacing-md);
        margin-bottom: var(--spacing-md);
      }
      
      .search-stats {
        display: flex;
        gap: 20px;
        align-items: center;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
      }
      
      .stat-item {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      
      .stat-icon {
        display: inline-flex;
        align-items: center;
        opacity: 0.55;
      }
      
      .stat-icon svg {
        vertical-align: middle;
      }
      
      .search-result-card {
        position: relative;
        padding: var(--spacing-md);
        margin-bottom: var(--spacing-sm);
        transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
      }
      
      .search-result-card:hover {
        background: rgba(255, 255, 255, 0.05);
        border-color: rgba(255, 255, 255, 0.12);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
      }
      
      .result-score {
        position: absolute;
        top: var(--spacing-sm);
        right: var(--spacing-sm);
        background: var(--color-accent);
        color: #fff;
        padding: 3px 10px;
        border-radius: var(--radius-full);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        letter-spacing: 0.3px;
      }
      
      .result-content {
        padding-right: 0;
      }
      .result-content.has-badge {
        padding-right: 72px;
      }
      
      .result-title {
        font-size: var(--font-size-base);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
        margin-bottom: 6px;
        line-height: 1.4;
      }
      
      .result-url {
        display: inline-block;
        font-size: var(--font-size-xs);
        margin-bottom: 8px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 100%;
      }
      
      .result-url:hover {
        opacity: 0.85;
      }
      
      .result-snippet {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        line-height: 1.55;
        margin-bottom: 8px;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      
      .result-meta {
        gap: 14px;
        font-size: var(--font-size-xs);
        margin-top: 8px;
      }
      
      .meta-item {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      
      .meta-icon {
        display: inline-flex;
        align-items: center;
        opacity: 0.6;
      }
      
      .meta-icon svg {
        vertical-align: middle;
      }
      
      .index-badge {
        font-weight: var(--font-weight-semibold);
      }
    `;
    this.injectStyles(styleId, styles);
  }
}

module.exports = SearchResultsRenderer;

if (typeof window !== 'undefined') {
  window.SearchResultsRenderer = SearchResultsRenderer;
  _log.debug('SearchResultsRenderer loaded');
}
