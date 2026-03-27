'use strict';

const BaseComponent = require('./BaseComponent');
const IndexBrowserUtils = require('../IndexBrowserUtils');

class SidebarComponent extends BaseComponent {
  constructor(container, ctx, uiText, indexTypeIcons) {
    super(container, ctx);
    this.uiText = uiText;
    this.indexTypeIcons = indexTypeIcons;
    this.render();
  }

  render() {
    this.container.innerHTML = `
      <div class="se-sidebar-overlay ${this.ctx.sourcesExpanded ? 'is-active' : ''}"></div>
      <div class="se-sidebar ${this.ctx.sourcesExpanded ? 'is-open' : ''}">
        <div class="se-sidebar-header">
          <button class="se-sidebar-close-btn" type="button" title="Close">
            <i class="fas fa-times"></i>
          </button>
          <h3 class="se-sidebar-title">${this.uiText.FILTERS.settings}</h3>
        </div>
        <div class="se-sidebar-content">
          <div id="sidebar-source-manager"></div>
          <div id="sidebar-search-mode"></div>
          <div id="sidebar-sources-list"></div>
          <div id="sidebar-advanced-panel"></div>
        </div>
      </div>`;

    this._renderSourceManager();
    this._renderSearchMode();
    this._renderSourcesList();
    this._renderAdvancedPanel();
    
    this._attachListeners();
  }

  _renderSourceManager() {
    const container = this.container.querySelector('#sidebar-source-manager');
    if (!container) return;
    
    const panelHtml = this._buildSourceAddPanel();
    const notifHtml = this._buildIndexingNotifications();
    
    if (!panelHtml && !notifHtml) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = `
      <div class="se-source-manager">
        ${panelHtml}
        ${notifHtml}
      </div>`;
      
    this._attachSourceManagerListeners(container);
  }

  _buildSourceAddPanel() {
    const state = this.ctx.indexingService.sourceManagerState;
    if (state === 'idle') return '';

    if (state === 'selecting') {
      return `
        <div class="se-source-add-panel">
          <div class="se-source-add-header">
            <span class="se-source-add-title">${this.uiText.SOURCE_MANAGER.addTitle}</span>
            <button class="se-source-add-cancel" type="button" title="Cancel">
              <i class="fas fa-times"></i>
            </button>
          </div>
          <div class="se-source-add-actions">
            <button class="se-source-pick-files" type="button">
              <i class="fas fa-file-alt"></i>
              <span>${this.uiText.HERO.selectFiles}</span>
            </button>
            <button class="se-source-pick-folder" type="button">
              <i class="fas fa-folder-open"></i>
              <span>${this.uiText.HERO.selectFolder}</span>
            </button>
          </div>
          <p class="se-source-add-hint">
            ${this.uiText.SOURCE_MANAGER.supported}
          </p>
        </div>`;
    }

    if (state === 'configuring') {
      const { selectedFiles, newSourceName, newSourceIndexMode } = this.ctx.indexingService;
      const fileCount = selectedFiles.length;
      const names = selectedFiles.slice(0, 3).map((f) => f.name);
      const suffix = fileCount > 3 ? ` +${fileCount - 3} more` : '';
      const defaultName = newSourceName || this.ctx.indexingService.deriveSourceName();
      const mode = newSourceIndexMode;

      const isSemantic = mode.includes('semantic');
      const isBm25 = mode.includes('bm25');

      return `
        <div class="se-source-add-panel">
          <div class="se-source-add-header">
            <span class="se-source-add-title">${this.uiText.SOURCE_MANAGER.configTitle}</span>
            <button class="se-source-add-cancel" type="button" title="Cancel">
              <i class="fas fa-times"></i>
            </button>
          </div>
          <div class="se-source-file-list">
            <div class="se-source-file-summary">
              <i class="fas fa-paperclip"></i>
              <span>${fileCount} file${fileCount !== 1 ? 's' : ''} selected</span>
            </div>
            <div class="se-source-file-names">
              ${names.map((name) => `<span class="se-source-file-tag">${IndexBrowserUtils.escapeHtml(name)}</span>`).join('')}
              ${suffix ? `<span class="se-source-file-more">${suffix}</span>` : ''}
            </div>
            <button class="se-source-change-files" type="button">Change</button>
          </div>
          <div class="se-source-config">
            <div class="se-source-config-field">
              <label class="se-source-config-label">${this.uiText.SOURCE_MANAGER.sourceName}</label>
              <input type="text" class="se-source-name-input" placeholder="${this.uiText.SOURCE_MANAGER.sourceNamePlaceholder}" value="${IndexBrowserUtils.escapeAttr(defaultName)}" maxlength="100" />
            </div>
            <div class="se-source-config-field">
              <label class="se-source-config-label">${this.uiText.SOURCE_MANAGER.searchMode}</label>
              <div class="se-source-mode-cards">
                <button class="se-mode-card${isSemantic ? ' is-selected' : ''}" data-mode="semantic" type="button">
                  <i class="fas fa-brain"></i>
                  <span class="se-mode-card-label">${this.uiText.SOURCE_MANAGER.modeCards.semantic.label}</span>
                  <span class="se-mode-card-desc">${this.uiText.SOURCE_MANAGER.modeCards.semantic.desc}</span>
                </button>
                <button class="se-mode-card${isBm25 ? ' is-selected' : ''}" data-mode="bm25" type="button">
                  <i class="fas fa-keyboard"></i>
                  <span class="se-mode-card-label">${this.uiText.SOURCE_MANAGER.modeCards.bm25.label}</span>
                  <span class="se-mode-card-desc">${this.uiText.SOURCE_MANAGER.modeCards.bm25.desc}</span>
                </button>
              </div>
            </div>
            <div class="se-source-config-field" style="margin-top:16px;">
              <div style="cursor:pointer; color:var(--se-color-text-secondary); display:flex; align-items:center; justify-content:space-between; user-select:none;" class="se-source-advanced-toggle">
                <label class="se-source-config-label" style="margin-bottom:0; cursor:pointer;">Advanced Pipeline Config</label>
                <i class="fas fa-chevron-down se-source-advanced-icon" style="font-size:0.8em; transition: transform 0.2s;"></i>
              </div>
              <div class="se-source-advanced-content" style="display:none; margin-top:12px; padding:12px; background:var(--se-color-surface-hover); border-radius:6px; border: 1px solid var(--se-color-border);">
                <div class="se-source-config-field">
                  <label class="se-source-config-label" style="font-size:0.85em; margin-bottom:4px;">Chunk Size (chars)</label>
                  <input type="number" class="se-source-chunk-size-input se-advanced-input" value="${this.ctx.indexingService.chunkSize || 512}" min="128" max="2048" step="64" style="width:100%; box-sizing:border-box;" />
                </div>
                <div class="se-source-config-field" style="margin-top:10px;">
                  <label class="se-source-config-label" style="font-size:0.85em; margin-bottom:4px;">Chunk Overlap (chars)</label>
                  <input type="number" class="se-source-chunk-overlap-input se-advanced-input" value="${this.ctx.indexingService.chunkOverlap !== undefined ? this.ctx.indexingService.chunkOverlap : 50}" min="0" max="512" step="10" style="width:100%; box-sizing:border-box;" />
                </div>
              </div>
            </div>
          </div>
          <button class="se-source-index-btn" type="button">
            <i class="fas fa-bolt"></i>
            <span>${this.uiText.SOURCE_MANAGER.indexButton}</span>
          </button>
        </div>`;
    }

    return '';
  }

  _buildIndexingNotifications() {
    const { indexingJobs } = this.ctx.indexingService;
    if (!indexingJobs.size) return '';

    let html = '<div class="se-indexing-notifications">';
    for (const [indexName, job] of indexingJobs) {
      const isFailed = job.state === 'failed';
      const pct = job.progress_pct || 0;
      const filesInfo = job.files_total
        ? `${job.files_processed || 0}/${job.files_total} files`
        : '';
      
      let barClass = 'se-indexing-bar';
      if (isFailed) barClass += ' is-failed';

      html += `
        <div class="${barClass}" data-index-name="${IndexBrowserUtils.escapeAttr(indexName)}">
          <div class="se-indexing-bar-icon">
            ${isFailed ? '<i class="fas fa-exclamation-circle"></i>' : '<span class="se-indexing-spinner"></span>'}
          </div>
          <div class="se-indexing-bar-info">
            <span class="se-indexing-bar-name">${IndexBrowserUtils.escapeHtml(job.display_name || indexName)}</span>
            <span class="se-indexing-bar-detail">
              ${isFailed ? (job.error || 'Failed') : `${pct}% ${filesInfo}`}
            </span>
          </div>
          <div class="se-indexing-bar-actions">
            ${isFailed ? `
              <button class="se-indexing-dismiss" data-dismiss-index="${IndexBrowserUtils.escapeAttr(indexName)}" title="Dismiss" type="button">
                <i class="fas fa-times-circle"></i>
              </button>
            ` : `
              <button class="se-indexing-cancel" data-cancel-index="${IndexBrowserUtils.escapeAttr(indexName)}" title="Cancel indexing" type="button">
                <i class="fas fa-times-circle"></i>
              </button>
            `}
          </div>
          <div class="se-indexing-bar-track">
            <div class="se-indexing-bar-fill" style="width: ${pct}%"></div>
          </div>
        </div>`;
    }
    html += '</div>';
    return html;
  }

  _renderSearchMode() {
    const container = this.container.querySelector('#sidebar-search-mode');
    if (!container) return;

    const availModes = this.ctx._getAvailableSearchModes();
    let displayMode = this.ctx.searchService.searchMode;
    
    if (!availModes.has(displayMode)) {
      displayMode = availModes.has('hybrid') ? 'hybrid'
        : availModes.has('semantic') ? 'semantic'
        : [...availModes][0];
    }

    const modeOrder = ['hybrid', 'semantic', 'bm25'];
    const sortedModes = modeOrder.filter((mode) => availModes.has(mode));
    
    if (sortedModes.length === 0) {
        container.innerHTML = `
        <div class="se-sidebar-section">
          <h4 class="se-sidebar-section-title">Search Mode</h4>
          <div class="se-mode-select">
            <span class="se-mode-badge" style="background:var(--se-color-danger-bg);color:var(--se-color-danger-text);">Incompatible Sources</span>
          </div>
        </div>`;
        return;
    }

    container.innerHTML = `
      <div class="se-sidebar-section">
        <h4 class="se-sidebar-section-title">Search Mode</h4>
        <div class="se-mode-select">
          ${sortedModes.length > 1 ? `
          <select class="se-mode-dropdown">
            ${sortedModes.map((mode) => `<option value="${mode}" ${displayMode === mode ? 'selected' : ''}>${this.uiText.MODES.labels[mode] || mode}</option>`).join('')}
          </select>` : `
          <span class="se-mode-badge">${this.uiText.MODES.labels[displayMode] || displayMode}</span>`}
        </div>
      </div>`;

    const newSelect = container.querySelector('.se-mode-dropdown');
    if (newSelect) {
      this._trackListener(newSelect, 'change', () => {
        this.ctx.searchService.setSearchMode(newSelect.value);
      });
    }
  }

  _renderSourcesList() {
    const container = this.container.querySelector('#sidebar-sources-list');
    if (!container) return;

    const { indexes, selectedSources, indexingJobs } = this.ctx.indexingService;

    if (!indexes.length) {
      container.innerHTML = `
        <div class="se-sidebar-section">
          <h4 class="se-sidebar-section-title">Sources</h4>
          <div class="se-sources-empty">
            <i class="fas fa-inbox"></i>
            <span>${this.uiText.SOURCES.emptyHint}</span>
          </div>
        </div>`;
      return;
    }

    const grouped = this.ctx._groupIndexes(indexes);
    const allSelected = selectedSources.size === indexes.length;

    let html = `
        <div class="se-sidebar-section">
          <div class="se-sidebar-section-header">
            <h4 class="se-sidebar-section-title">Sources</h4>
            <button class="se-sidebar-action-btn se-source-toggle-all ${allSelected ? 'is-selected' : ''}" data-action="toggle-all" type="button">
              ${allSelected ? this.uiText.SOURCES.toggleDeselectAll : this.uiText.SOURCES.toggleSelectAll}
            </button>
          </div>
          <div class="se-sidebar-sources-list">`;

    for (const [group, idxList] of Object.entries(grouped)) {
      html += `<div class="se-source-group-title">${IndexBrowserUtils.escapeHtml(group)}</div>`;
      
      for (const idx of idxList) {
        const name = idx.index_name || idx.name || idx.id;
        const display = idx.display_name || name;
        const isSelected = selectedSources.has(name);
        const chunks = idx.chunk_count ?? '-';
        const typeIcon = this.indexTypeIcons[idx.index_type] || 'fas fa-database';
        const isCustom = idx.source_type === 'custom';
        const isIndexing = indexingJobs.has(name) &&
          !['completed', 'failed'].includes(indexingJobs.get(name).state);
        const isDeleteConfirm = this.ctx._deleteConfirm === name;
        
        const isInfoExpanded = this.ctx._expandedSourceInfo === name;

        const rowClass = ['se-source-row'];
        if (isSelected) rowClass.push('is-selected');
        if (isIndexing) rowClass.push('is-indexing');
        if (isDeleteConfirm) rowClass.push('is-confirming-delete');
        if (isInfoExpanded) rowClass.push('is-info-expanded');

        const chunkLabel = isIndexing
          ? this.uiText.SOURCES.chunkIndexing
          : (idx._unindexed 
              ? '<span style="color:#d97706; font-size:0.85em; font-weight:600;"><i class="fas fa-exclamation-triangle"></i> Requires Indexing</span>' 
              : (chunks === 0 ? this.uiText.SOURCES.emptyChunk : IndexBrowserUtils.escapeHtml(String(chunks)) + ' chunks'));

        html += `
            <div class="${rowClass.join(' ')}" data-source="${IndexBrowserUtils.escapeAttr(name)}">
              <div class="se-source-row-main">
                <div class="se-source-checkbox" data-source-toggle="${IndexBrowserUtils.escapeAttr(name)}">
                  <i class="fas fa-${isSelected ? 'check-square' : 'square'}"></i>
                </div>
                <div class="se-source-icon">
                  ${isIndexing ? '<span class="se-source-spinner"></span>' : `<i class="${typeIcon}"></i>`}
                </div>
                <div class="se-source-name-col">
                  <div class="se-source-name">${IndexBrowserUtils.escapeHtml(display)}</div>
                  <div class="se-source-meta-inline">${chunkLabel}</div>
                </div>
                <div class="se-source-actions">
                  <button class="se-source-info-btn ${isInfoExpanded ? 'is-active' : ''}" data-source-info="${IndexBrowserUtils.escapeAttr(name)}" type="button" title="View details">
                    <i class="fas fa-info-circle"></i>
                  </button>
                </div>
              </div>`;

        const path = idx.metadata?.file_path || idx.path || '';
        const modes = idx.supported_modes && idx.supported_modes.length ? idx.supported_modes.join(', ') : (idx._unindexed ? 'None' : 'semantic');
        
        html += `
            <div class="se-source-details-panel">
              <div class="se-source-detail-row">
                <span class="se-source-detail-label">Status:</span>
                <span class="se-source-detail-value">${isIndexing ? 'Indexing...' : (idx._unindexed ? 'Not Indexed' : 'Ready')}</span>
              </div>
              <div class="se-source-detail-row">
                <span class="se-source-detail-label">Items:</span>
                <span class="se-source-detail-value">${chunks}</span>
              </div>
              <div class="se-source-detail-row">
                <span class="se-source-detail-label">Modes:</span>
                <span class="se-source-detail-value" style="text-transform: capitalize;">${modes}</span>
              </div>
              ${path ? `
              <div class="se-source-detail-row se-source-detail-path-row">
                <span class="se-source-detail-label">Path:</span>
                <span class="se-source-detail-value" title="${IndexBrowserUtils.escapeAttr(path)}">${IndexBrowserUtils.escapeHtml(path)}</span>
              </div>
              ` : ''}
              
              <div class="se-source-details-actions">
                ${idx._unindexed ? `
                <button class="se-source-action-btn" onclick="window.aether.eventBus.emit('ui:settings:opened')" type="button">
                  <i class="fas fa-cog"></i> Go to Settings to Index
                </button>
                ` : ''}
                
                ${path ? `
                <button class="se-source-action-btn se-source-open-dir" data-open-path="${IndexBrowserUtils.escapeAttr(path)}" type="button">
                  <i class="fas fa-folder-open"></i> Open Location
                </button>
                ` : ''}
                
                ${isCustom && !isIndexing ? `
                <button class="se-source-action-btn se-source-delete-btn" data-delete-source="${IndexBrowserUtils.escapeAttr(name)}" type="button">
                  <i class="fas fa-trash-alt"></i> Delete
                </button>
                ` : ''}
              </div>
            </div>`;
        
        html += `
            <div class="se-source-delete-confirm" data-confirm-source="${IndexBrowserUtils.escapeAttr(name)}">
              <span>Delete "${IndexBrowserUtils.escapeHtml(display)}"?</span>
              <button class="se-source-confirm-yes" data-confirm-delete="${IndexBrowserUtils.escapeAttr(name)}" type="button">Yes</button>
              <button class="se-source-confirm-no" data-cancel-delete="${IndexBrowserUtils.escapeAttr(name)}" type="button">Cancel</button>
            </div>`;

        html += `</div>`;
      }
    }

    html += `
          </div>
        </div>`;
        
    container.innerHTML = html;
    this._attachSourcesListListeners(container);
  }

  _renderAdvancedPanel() {
    const container = this.container.querySelector('#sidebar-advanced-panel');
    if (!container) return;

    container.innerHTML = `
      <div class="se-sidebar-section">
        <h4 class="se-sidebar-section-title">${this.uiText.FILTERS.advanced}</h4>
        <div class="se-advanced-panel">
          <div class="se-advanced-field">
            <label class="se-advanced-label">${this.uiText.ADVANCED.topK}</label>
            <input type="number" class="se-advanced-input se-topk" min="1" max="2000" value="${this.ctx.searchService.topK}" />
          </div>
          <div class="se-advanced-field">
            <label class="se-advanced-label">${this.uiText.ADVANCED.minScore}</label>
            <div class="se-advanced-input-wrapper">
              <input type="number" class="se-advanced-input se-minscore" min="0" max="100" step="5" value="${Math.round(this.ctx.searchService.minScore * 100)}" />
              <span class="se-advanced-unit">%</span>
            </div>
          </div>
        </div>
      </div>`;

    const topKInput = container.querySelector('.se-topk');
    const minScoreInput = container.querySelector('.se-minscore');

    if (topKInput) {
      this._trackListener(topKInput, 'change', () => {
        let val = parseInt(topKInput.value, 10);
        if (Number.isNaN(val) || val < 1 || val > 2000) {
          topKInput.value = this.ctx.searchService.topK;
          return;
        }
        this.ctx.searchService.setTopK(val);
      });
    }

    if (minScoreInput) {
      this._trackListener(minScoreInput, 'change', () => {
        let pct = parseInt(minScoreInput.value, 10);
        if (Number.isNaN(pct) || pct < 0 || pct > 100) {
          minScoreInput.value = Math.round(this.ctx.searchService.minScore * 100);
          return;
        }
        this.ctx.searchService.setMinScore(pct / 100);
      });
    }
  }

  _attachListeners() {
    const sidebarCloseBtn = this.container.querySelector('.se-sidebar-close-btn');
    const sidebarOverlay = this.container.querySelector('.se-sidebar-overlay');

    if (sidebarCloseBtn) {
      this._trackListener(sidebarCloseBtn, 'click', () => {
        this.ctx.toggleSidebar(false);
      });
    }

    if (sidebarOverlay) {
      this._trackListener(sidebarOverlay, 'click', () => {
        this.ctx.toggleSidebar(false);
      });
    }
  }

  _attachSourceManagerListeners(container) {
    const cancelBtn = container.querySelector('.se-source-add-cancel');
    if (cancelBtn) {
      this._trackListener(cancelBtn, 'click', () => {
        this.ctx.indexingService.resetSourceManager();
      });
    }

    const pickFiles = container.querySelector('.se-source-pick-files');
    if (pickFiles) {
      this._trackListener(pickFiles, 'click', () => this.ctx.indexingService.handleAddFiles());
    }

    const pickFolder = container.querySelector('.se-source-pick-folder');
    if (pickFolder) {
      this._trackListener(pickFolder, 'click', () => this.ctx.indexingService.handleAddFolder());
    }

    const changeBtn = container.querySelector('.se-source-change-files');
    if (changeBtn) {
      this._trackListener(changeBtn, 'click', () => {
        this.ctx.indexingService.sourceManagerState = 'selecting';
        this.ctx.indexingService.selectedFiles = [];
        this.ctx.indexingService.dispatchEvent(new CustomEvent('change'));
      });
    }

    const nameInput = container.querySelector('.se-source-name-input');
    if (nameInput) {
      this._trackListener(nameInput, 'input', () => {
        this.ctx.indexingService.newSourceName = nameInput.value;
      });
    }

    const modeCards = container.querySelectorAll('.se-mode-card[data-mode]');
    modeCards.forEach((card) => {
      this._trackListener(card, 'click', () => {
        const mode = card.dataset.mode;
        const svc = this.ctx.indexingService;
        
        if (!Array.isArray(svc.newSourceIndexMode)) {
            svc.newSourceIndexMode = ['semantic', 'bm25'];
        }
        
        if (svc.newSourceIndexMode.includes(mode)) {
            if (svc.newSourceIndexMode.length > 1) {
                svc.newSourceIndexMode = svc.newSourceIndexMode.filter(m => m !== mode);
                card.classList.remove('is-selected');
            }
        } else {
            svc.newSourceIndexMode.push(mode);
            card.classList.add('is-selected');
        }
      });
    });

    const advToggle = container.querySelector('.se-source-advanced-toggle');
    const advContent = container.querySelector('.se-source-advanced-content');
    const advIcon = container.querySelector('.se-source-advanced-icon');
    if (advToggle && advContent) {
      this._trackListener(advToggle, 'click', () => {
        const isHidden = advContent.style.display === 'none';
        advContent.style.display = isHidden ? 'block' : 'none';
        if (advIcon) advIcon.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
      });
    }

    const chunkSizeInput = container.querySelector('.se-source-chunk-size-input');
    if (chunkSizeInput) {
      this._trackListener(chunkSizeInput, 'change', () => {
        const val = parseInt(chunkSizeInput.value, 10);
        if (!isNaN(val) && val >= 128 && val <= 2048) {
          this.ctx.indexingService.chunkSize = val;
        } else {
          chunkSizeInput.value = this.ctx.indexingService.chunkSize || 512;
        }
      });
    }

    const chunkOverlapInput = container.querySelector('.se-source-chunk-overlap-input');
    if (chunkOverlapInput) {
      this._trackListener(chunkOverlapInput, 'change', () => {
        const val = parseInt(chunkOverlapInput.value, 10);
        if (!isNaN(val) && val >= 0 && val <= 512) {
          this.ctx.indexingService.chunkOverlap = val;
        } else {
          chunkOverlapInput.value = this.ctx.indexingService.chunkOverlap !== undefined ? this.ctx.indexingService.chunkOverlap : 50;
        }
      });
    }

    const indexBtn = container.querySelector('.se-source-index-btn');
    if (indexBtn) {
      this._trackListener(indexBtn, 'click', () => this.ctx.indexingService.startIndexing());
    }

    const cancelIndexBtns = container.querySelectorAll('.se-indexing-cancel');
    cancelIndexBtns.forEach((btn) => {
      this._trackListener(btn, 'click', (e) => {
        e.stopPropagation();
        const name = btn.dataset.cancelIndex;
        if (name) {
          this.ctx.indexingService.cancelIndexing(name).catch((err) => {
            this.ctx.logger.error('Failed to cancel indexing:', err);
          });
        }
      });
    });

    const dismissBtns = container.querySelectorAll('.se-indexing-dismiss');
    dismissBtns.forEach((btn) => {
      this._trackListener(btn, 'click', (e) => {
        e.stopPropagation();
        const name = btn.dataset.dismissIndex;
        if (name) {
          this.ctx.indexingService.dismissIndexingJob(name);
        }
      });
    });
  }

  _attachSourcesListListeners(container) {
    const checkboxes = container.querySelectorAll('.se-source-checkbox');
    checkboxes.forEach((btn) => {
      this._trackListener(btn, 'click', (e) => {
        e.stopPropagation();
        const name = btn.dataset.sourceToggle;
        if (name) {
          // Toggle UI immediately without triggering full re-render
          const icon = btn.querySelector('i');
          const row = btn.closest('.se-source-row');
          if (icon) {
            const isChecked = icon.classList.contains('fa-check-square');
            if (isChecked) {
              icon.classList.remove('fa-check-square');
              icon.classList.add('fa-square');
              row?.classList.remove('is-selected');
            } else {
              icon.classList.remove('fa-square');
              icon.classList.add('fa-check-square');
              row?.classList.add('is-selected');
            }
          }
          this.ctx.indexingService.toggleSourceSelection(name, true);
        }
      });
    });

    const toggleAllBtn = container.querySelector('.se-source-toggle-all');
    if (toggleAllBtn) {
      this._trackListener(toggleAllBtn, 'click', () => {
        this.ctx.indexingService.toggleAllSources();
      });
    }

    const infoBtns = container.querySelectorAll('.se-source-info-btn');
    infoBtns.forEach((btn) => {
      this._trackListener(btn, 'click', (e) => {
        e.stopPropagation();
        const name = btn.dataset.sourceInfo;
        if (this.ctx._expandedSourceInfo === name) {
          this.ctx._expandedSourceInfo = null;
        } else {
          this.ctx._expandedSourceInfo = name;
        }
        this._renderSourcesList(); // Re-render just the list to show expanded info
      });
    });

    const sidebarDeleteBtns = container.querySelectorAll('.se-source-delete-btn');
    sidebarDeleteBtns.forEach((btn) => {
      this._trackListener(btn, 'click', (e) => {
        e.stopPropagation();
        const sourceName = btn.dataset.deleteSource;
        if (sourceName) {
          this.ctx._deleteConfirm = sourceName;
          this._renderSourcesList();
        }
      });
    });

    const confirmYesBtns = container.querySelectorAll('.se-source-confirm-yes');
    confirmYesBtns.forEach((btn) => {
      this._trackListener(btn, 'click', (e) => {
        e.stopPropagation();
        const name = btn.dataset.confirmDelete;
        if (name) this.ctx.indexingService.handleDeleteSource(name);
      });
    });

    const confirmNoBtns = container.querySelectorAll('.se-source-confirm-no');
    confirmNoBtns.forEach((btn) => {
      this._trackListener(btn, 'click', (e) => {
        e.stopPropagation();
        this.ctx._deleteConfirm = null;
        this._renderSourcesList();
      });
    });
  }

  update() {
    const overlay = this.container.querySelector('.se-sidebar-overlay');
    const sidebar = this.container.querySelector('.se-sidebar');

    if (this.ctx.sourcesExpanded) {
      overlay?.classList.add('is-active');
      sidebar?.classList.add('is-open');
    } else {
      overlay?.classList.remove('is-active');
      sidebar?.classList.remove('is-open');
    }

    // Since sidebar content can change significantly (e.g. indexing progress, new sources),
    // we do targeted re-renders of the sub-sections
    
    // Unbind listeners before re-rendering sections
    this.dispose(); 
    
    this._renderSourceManager();
    this._renderSearchMode();
    this._renderSourcesList();
    this._renderAdvancedPanel();
    
    this._attachListeners();
  }

  updateIndexingBar(indexName) {
    // Targeted update for just one progress bar
    const bar = this.container.querySelector(`.se-indexing-bar[data-index-name="${IndexBrowserUtils.escapeAttr(indexName)}"]`);
    if (!bar) return;
    
    const job = this.ctx.indexingService.indexingJobs.get(indexName);
    if (!job) return;

    const detail = bar.querySelector('.se-indexing-bar-detail');
    const fill = bar.querySelector('.se-indexing-bar-fill');
    if (detail) {
      const filesInfo = job.files_total ? `${job.files_processed}/${job.files_total} files` : '';
      detail.textContent = `${job.progress_pct}% ${filesInfo}`;
    }
    if (fill) {
      fill.style.width = `${job.progress_pct}%`;
    }

    const row = this.container.querySelector(`.se-source-row[data-source="${IndexBrowserUtils.escapeAttr(indexName)}"]`);
    if (row) {
      const metaEl = row.querySelector('.se-source-meta-inline');
      if (metaEl) {
        metaEl.textContent = job.state === 'completed' 
          ? `${job.chunk_count} chunks` 
          : this.uiText.SOURCES.chunkIndexing;
      }
    }
  }
}

module.exports = SidebarComponent;
