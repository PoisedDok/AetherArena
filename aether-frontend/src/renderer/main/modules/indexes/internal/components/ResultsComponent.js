'use strict';

const BaseComponent = require('./BaseComponent');
const IndexBrowserUtils = require('../IndexBrowserUtils');

class ResultsComponent extends BaseComponent {
  constructor(container, ctx, uiText, uiConfig, resultsPerPage) {
    super(container, ctx);
    this.uiText = uiText;
    this.uiConfig = uiConfig;
    this.resultsPerPage = resultsPerPage;
    this.render();
  }

  render() {
    this.container.innerHTML = this._buildContent();
    try {
      this._attachListeners();
    } catch (e) {
      console.error('[ResultsComponent] Error attaching listeners:', e);
    }
  }

  _buildContent() {
    try {
      const { searchService, previewResult, _visibleCount, expandedResults } = this.ctx;
      
      if (!searchService.hasSearched) {
        return '<div class="se-content"></div>';
      }

      if (searchService.isSearching) {
        return `
          <div class="se-content">
            ${this._buildLoadingState()}
          </div>`;
      }

      if (previewResult) {
        return `
          <div class="se-content">
            ${this._buildPreview()}
          </div>`;
      }

      if (!searchService.searchResults || !searchService.searchResults.length) {
        return `
          <div class="se-content">
            ${this._buildNoResults()}
          </div>`;
      }

      const visible = searchService.searchResults.slice(0, _visibleCount);
      return `
        <div class="se-content">
          ${this._buildStats()}
          <div class="se-results-list">
            ${visible.map((result, index) => this._buildResultCard(result, index, expandedResults)).join('')}
          </div>
          ${this._buildLoadMore()}
        </div>`;
    } catch(e) {
      console.error('[ResultsComponent] Render Error:', e);
      return `<div class="se-content" style="color: #ff6b6b; padding: 2rem; text-align: center; background: rgba(255,0,0,0.1); border-radius: 8px;">
        <i class="fas fa-exclamation-triangle" style="font-size: 2rem; margin-bottom: 1rem;"></i>
        <h3 style="margin-bottom: 0.5rem;">Render Error</h3>
        <p style="font-family: monospace; font-size: 0.85em; opacity: 0.8; word-break: break-all;">${e.message}</p>
        <p style="font-family: monospace; font-size: 0.7em; opacity: 0.5; white-space: pre-wrap; text-align: left; margin-top: 1rem;">${e.stack}</p>
      </div>`;
    }
  }

  _buildLoadingState() {
    return `
      <div class="se-loading">
        <div class="se-loading-spinner"></div>
        <div class="se-loading-text">${this.uiText.SEARCH.loading(this.ctx.indexingService.selectedSources.size)}</div>
        <button class="se-search-cancel" id="search-cancel-btn" type="button">${this.uiText.SEARCH.cancel}</button>
      </div>`;
  }

  _buildNoResults() {
    return `
      <div class="se-empty">
        <div class="se-empty-icon"><i class="fas fa-search"></i></div>
        <div class="se-empty-title">${this.uiText.RESULTS.noResultsTitle}</div>
        <div class="se-empty-text">
          No matches for "<strong>${IndexBrowserUtils.escapeHtml(this.ctx.searchService.searchQuery)}</strong>"
        </div>
        <div class="se-empty-suggestions">
          <span>Try:</span>
          <ul>
            <li>Using different keywords</li>
            <li>Searching across all sources</li>
            <li>Reducing the minimum score threshold</li>
          </ul>
        </div>
      </div>`;
  }

  _buildStats() {
    const { searchService } = this.ctx;
    const stats = this.uiText.RESULTS.stats(
      searchService.searchResults.length,
      IndexBrowserUtils.formatDuration(searchService.searchDuration),
      searchService.indexesSearched.length
    );
    return `
      <div class="se-stats">
        <span>${stats.count}</span>
        <span class="se-stats-sep">&middot;</span>
        <span>${stats.duration}</span>
        <span class="se-stats-sep">&middot;</span>
        <span>${stats.indexes}</span>
      </div>`;
  }

  _buildResultCard(result, rank, expandedResults) {
    const title = this.ctx._getResultTitle(result);
    const breadcrumb = this.ctx._getResultBreadcrumb(result);
    const icon = this.ctx._getResultIcon(result);
    const score = IndexBrowserUtils.formatScore(result.score);
    const scoreNum = typeof result.score === 'number' ? result.score : 0;
    const scoreClass = scoreNum >= this.uiConfig.SCORE_THRESHOLDS.HIGH ? 'se-score-high' : scoreNum >= this.uiConfig.SCORE_THRESHOLDS.MID ? 'se-score-mid' : '';
    const snippet = result.text || result.content || result.snippet || '';
    const highlighted = this.ctx._highlightQuery(snippet, this.ctx.searchService.searchQuery);
    const resultId = `result-${rank}`;
    const isExpanded = expandedResults.has(resultId);
    const openTarget = this.ctx._getOpenTarget(result);
    const canOpen = !!openTarget;

    return `
      <div class="se-result" data-result-id="${resultId}">
        <div class="se-result-main" data-result-idx="${rank}">
          <div class="se-result-icon"><i class="${icon}"></i></div>
          <div class="se-result-body">
            <div class="se-result-title-row">
              <span class="se-result-title">${IndexBrowserUtils.escapeHtml(title)}</span>
              <span class="se-result-score ${scoreClass}">${score}</span>
            </div>
            <div class="se-result-breadcrumb">${IndexBrowserUtils.escapeHtml(breadcrumb)}</div>
            <div class="se-result-snippet ${isExpanded ? 'is-expanded' : ''}">${highlighted}</div>
          </div>
        </div>
        <div class="se-result-actions">
          ${canOpen ? `
            <button class="se-action-btn se-action-open" data-result-idx="${rank}" type="button" title="Open ${openTarget.type === 'url' ? 'URL' : 'file'}">
              <i class="fas fa-${openTarget.type === 'url' ? 'external-link-alt' : 'folder-open'}"></i>
              <span>Open</span>
            </button>` : ''}
          <button class="se-action-btn se-action-expand" data-expand-id="${resultId}" type="button" title="${isExpanded ? 'Collapse' : 'Show more'}">
            <i class="fas fa-${isExpanded ? 'compress-alt' : 'expand-alt'}"></i>
            <span>${isExpanded ? 'Less' : 'More'}</span>
          </button>
          <button class="se-action-btn se-action-copy" data-result-idx="${rank}" type="button" title="Copy text">
            <i class="fas fa-copy"></i>
          </button>
        </div>
      </div>`;
  }

  _buildLoadMore() {
    const total = this.ctx.searchService.searchResults.length;
    const showing = Math.min(this.ctx._visibleCount, total);
    if (showing >= total) return '';
    const remaining = total - showing;
    const nextBatch = Math.min(remaining, this.resultsPerPage);
    return `
      <div class="se-load-more-wrapper">
        <button class="se-load-more" id="load-more-btn" type="button">
          ${this.uiText.RESULTS.loadMore(nextBatch)}
          <span class="se-load-more-count">${this.uiText.RESULTS.loadMoreCount(showing, total)}</span>
        </button>
      </div>`;
  }

  _buildPreview() {
    const result = this.ctx.previewResult;
    if (!result) return '';

    const title = this.ctx._getResultTitle(result);
    const score = IndexBrowserUtils.formatScore(result.score);
    const scoreNum = typeof result.score === 'number' ? result.score : 0;
    const scoreClass = scoreNum >= this.uiConfig.SCORE_THRESHOLDS.HIGH ? 'se-score-high' : scoreNum >= this.uiConfig.SCORE_THRESHOLDS.MID ? 'se-score-mid' : '';
    const text = result.text || result.content || result.snippet || '';
    const openTarget = this.ctx._getOpenTarget(result);
    const canOpen = !!openTarget;
    const meta = result.metadata || {};

    const indexInfo = this.ctx.indexingService.indexMap.get(result.index_name);
    const sourceName = indexInfo?.display_name || result.index_name || '';

    let metaHtml = '';
    const metaEntries = Object.entries(meta);
    if (metaEntries.length) {
      metaHtml = '<div class="se-preview-meta">';
      for (const [key, value] of metaEntries) {
        if (value == null || value === '') continue;
        metaHtml += `
          <div class="se-preview-meta-row">
            <span class="se-preview-meta-key">${IndexBrowserUtils.escapeHtml(key)}</span>
            <span class="se-preview-meta-value">${IndexBrowserUtils.escapeHtml(String(value))}</span>
          </div>`;
      }
      metaHtml += '</div>';
    }

    return `
      <div class="se-preview">
        <div class="se-preview-header">
          <button class="se-preview-back" id="preview-back-btn" type="button">
            <i class="fas fa-arrow-left"></i>
            <span>Back to results</span>
          </button>
        </div>
        <div class="se-preview-title-row">
          <h3 class="se-preview-title">${IndexBrowserUtils.escapeHtml(title)}</h3>
          <span class="se-result-score ${scoreClass}">${score}</span>
        </div>
        ${sourceName ? `<div class="se-preview-source">${IndexBrowserUtils.escapeHtml(sourceName)}</div>` : ''}
        ${metaHtml}
        <div class="se-preview-text">${this.ctx._highlightQuery(text, this.ctx.searchService.searchQuery)}</div>
        <div class="se-preview-actions">
          ${canOpen ? `
            <button class="se-action-btn se-action-open se-preview-open" id="preview-open-btn" type="button">
              <i class="fas fa-${openTarget.type === 'url' ? 'external-link-alt' : 'folder-open'}"></i>
              <span>Open ${openTarget.type === 'url' ? 'URL' : 'File'}</span>
            </button>` : ''}
          <button class="se-action-btn se-preview-copy" id="preview-copy-btn" type="button">
            <i class="fas fa-copy"></i>
            <span>Copy Text</span>
          </button>
        </div>
      </div>`;
  }

  _attachListeners() {
    const cancelBtn = this.container.querySelector('#search-cancel-btn');
    if (cancelBtn) {
      this._trackListener(cancelBtn, 'click', () => {
        this.ctx.searchService.cancelSearch();
      });
    }

    const openBtns = this.container.querySelectorAll('.se-action-open:not(#preview-open-btn)');
    openBtns.forEach((btn) => {
      this._trackListener(btn, 'click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.resultIdx, 10);
        const result = this.ctx.searchService.searchResults[idx];
        if (!result) return;
        const target = this.ctx._getOpenTarget(result);
        if (target) {
          this.ctx._openDocument(target.type, target.path);
        }
      });
    });

    const expandBtns = this.container.querySelectorAll('.se-action-expand');
    expandBtns.forEach((btn) => {
      this._trackListener(btn, 'click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.expandId;
        this.ctx._toggleResultExpansion(id);
      });
    });

    const copyBtns = this.container.querySelectorAll('.se-action-copy:not(#preview-copy-btn)');
    copyBtns.forEach((btn) => {
      this._trackListener(btn, 'click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.resultIdx, 10);
        const result = this.ctx.searchService.searchResults[idx];
        if (!result) return;
        const text = result.text || result.content || result.snippet || '';
        this.ctx._copyText(text);
      });
    });

    const loadMoreBtn = this.container.querySelector('#load-more-btn');
    if (loadMoreBtn) {
      this._trackListener(loadMoreBtn, 'click', () => {
        this.ctx._visibleCount += this.resultsPerPage;
        this.update();
      });
    }

    const resultMains = this.container.querySelectorAll('.se-result-main[data-result-idx]');
    resultMains.forEach((el) => {
      this._trackListener(el, 'click', () => {
        const idx = parseInt(el.dataset.resultIdx, 10);
        const result = this.ctx.searchService.searchResults[idx];
        if (result) {
          this.ctx.previewResult = result;
          this.update();
          
          // Log activity for Proactive Agent
          const indexName = result.index_name || 'unknown';
          const docId = result.doc_id || 'unknown';
          const title = this.ctx._getResultTitle(result) || 'Document';
          
          if (this.ctx.endpoint && typeof this.ctx.endpoint.logActivity === 'function') {
            this.ctx.endpoint.logActivity({
              url: `aether://index/${encodeURIComponent(indexName)}/${encodeURIComponent(docId)}`,
              title: title,
              text_content: ''
            }).catch(err => {
              console.warn('[ResultsComponent] Failed to log activity:', err);
            });
          }
        }
      });
    });

    const backBtn = this.container.querySelector('#preview-back-btn');
    if (backBtn) {
      this._trackListener(backBtn, 'click', () => {
        this.ctx.previewResult = null;
        this.update();
      });
    }

    const previewOpenBtn = this.container.querySelector('#preview-open-btn');
    if (previewOpenBtn) {
      this._trackListener(previewOpenBtn, 'click', () => {
        if (!this.ctx.previewResult) return;
        const target = this.ctx._getOpenTarget(this.ctx.previewResult);
        if (target) {
          this.ctx._openDocument(target.type, target.path);
        }
      });
    }

    const previewCopyBtn = this.container.querySelector('#preview-copy-btn');
    if (previewCopyBtn) {
      this._trackListener(previewCopyBtn, 'click', () => {
        if (!this.ctx.previewResult) return;
        const text = this.ctx.previewResult.text || this.ctx.previewResult.content || this.ctx.previewResult.snippet || '';
        this.ctx._copyText(text);
      });
    }
  }

  update() {
    // For structural changes (searching -> results, preview -> results), we need to re-render
    // For minor diffs, this could be optimized, but full render is safest for complex structural changes
    this.dispose();
    this.render();
  }
}

module.exports = ResultsComponent;
