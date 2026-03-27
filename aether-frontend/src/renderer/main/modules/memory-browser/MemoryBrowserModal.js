'use strict';

/**
 * @.architecture
 * Incoming: MainApp (user opens modal), memories bridge (IPC API) --- {user_click, ipc_response}
 * Processing: Display memory browser with scope-based tabs (Global/Chat-specific), search, CRUD operations including edit --- {7 jobs: JOB_CREATE_DOM_ELEMENT, JOB_HTTP_REQUEST, JOB_FILTER_DATA, JOB_UPDATE_DOM_ELEMENT, JOB_DELETE, JOB_UPDATE, JOB_EMIT_EVENT}
 * Outgoing: IPC (memories:*), DOM (modal overlay) --- {ipc_request, HTMLElement}
 * 
 * @.security innerHTML audit: SAFE
 * User data (memory content, types, dates, scores) set via textContent. innerHTML only for static UI templates
 * (tabs, badges, empty states, SVG icons, form layouts). escapeHtml() helper exists for any edge cases.
 * 
 * @module renderer/main/modules/memory-browser/MemoryBrowserModal
 */

const BaseModal = require('../../../shared/modals/BaseModal');
const { getAether } = require('../../../shared/bridge/AetherBridge');
const { createRendererLogger } = require('../../../shared/utils/logger');
const Renderers = require('./internal/MemoryBrowserRenderers');
const Controller = require('./internal/MemoryBrowserController');

/**
 * Memory Browser Modal with Professional Tab-Based Interface
 * 
 * All styling is in memory-browser.css via CSS classes.
 * Tone-based coloring uses data-tone attributes.
 */
class MemoryBrowserModal extends BaseModal {
  constructor(options = {}) {
    // Extract non-serializable objects before passing to super
    const { eventBus, ...baseOptions } = options;
    
    super({
      ...baseOptions,
      id: 'memory-browser-modal',
      title: 'Memory Browser',
      size: 'xl',
      heightPreset: 'default'
    });
    
    this.eventBus = eventBus || null;
    this.aether = options.aether || getAether();
    this.onConfigureAgent = options.onConfigureAgent || (() => {});
    
    // State
    this.memories = [];
    this.activeTab = 'all';
    this.searchQuery = '';
    this.searchInput = null;
    this.statsEl = null;
    this.editingMemoryId = null;
    this.isCreatingMemory = false;
    this.isSubmitting = false;
    this.currentChatId = options.currentChatId || null;
    
    // Lifecycle tracking
    this._listeners = [];
    this._timers = [];
    this._openSequence = 0;
    
    this.log = createRendererLogger('MemoryBrowserModal');
    
    // Bind methods
    this._handleSearch = (query) => Controller.handleSearch(this, query);
    this._handleSaveMemory = (memoryId, content) => Controller.handleSaveMemory(this, memoryId, content);
    this._handlePromoteMemory = (memory) => Controller.handlePromoteMemory(this, memory);
    this._handleDemoteMemory = (memory) => Controller.handleDemoteMemory(this, memory);
    this._handleDeleteMemory = (memory) => Controller.handleDeleteMemory(this, memory);
    this._handleCreateMemory = (content, memoryType, scope) => Controller.handleCreateMemory(this, content, memoryType, scope);
    this._handleTabSwitch = this._handleTabSwitch.bind(this);
  }

  async _renderContent() {
    if (!this.isOpen) return;
    
    // Clear any existing DOM listeners before overwriting innerHTML
    this._clearListeners();
    
    this.bodyEl.innerHTML = `
      <div class="skeleton-container">
        <div class="skeleton-row"><div class="skeleton-line skeleton-line--md skeleton-line--thick"></div></div>
        <div class="skeleton-card"><div class="skeleton-line skeleton-line--lg"></div><div class="skeleton-line skeleton-line--full"></div><div class="skeleton-line skeleton-line--sm"></div></div>
        <div class="skeleton-card"><div class="skeleton-line skeleton-line--md"></div><div class="skeleton-line skeleton-line--full"></div><div class="skeleton-line skeleton-line--sm"></div></div>
        <div class="skeleton-card"><div class="skeleton-line skeleton-line--lg"></div><div class="skeleton-line skeleton-line--full"></div></div>
      </div>`;
    
    const seq = ++this._openSequence;
    try {
      this.log.debug('Fetching memories...');
      const memories = await this.aether?.memories?.list({ source_chat_id: 'all' });
      if (seq !== this._openSequence || !this.isOpen) return;
      this.log.debug('Memories fetched:', memories?.length || 0);
      this.memories = memories || [];
      this._renderUI();
    } catch (error) {
      if (seq !== this._openSequence || !this.isOpen) return;
      this.log.error('Failed to load memories:', error);
      
      const Utils = require('./internal/MemoryBrowserUtils');
      
      this.bodyEl.innerHTML = `
        <div class="modal-empty-state">
          <div class="modal-empty-title">Failed to Load Memories</div>
          <div class="modal-empty-text">${Utils.escapeHtml(error.message || 'Unknown error')}</div>
          <button class="btn-primary" type="button" data-action="retry-memories" style="margin-top: 16px;">
            Retry
          </button>
        </div>
      `;

      const retryBtn = this.bodyEl.querySelector('[data-action="retry-memories"]');
      this._trackListener(retryBtn, 'click', () => {
        this._renderContent();
      });
    }
  }

  _renderUI() {
    Renderers.renderUI(this);
  }

  _refreshSearchState() {
    const contentContainer = this.bodyEl.querySelector('.memory-content');
    if (contentContainer) {
      Renderers.renderTabContent(this, contentContainer);
    }
    Renderers.updateStats(this);
  }

  _handleTabSwitch(typeId) {
    this.activeTab = typeId;
    this.searchQuery = '';
    if (this.searchInput) this.searchInput.value = '';
    this._renderUI();
  }

  /**
   * Cleanup on modal close (called by BaseModal)
   * @private
   */
  _cleanup() {
    this._openSequence++;
    this._clearListeners();

    for (const id of this._timers) {
      clearTimeout(id);
    }
    this._timers = [];

    this.memories = [];
    this.searchQuery = '';
    this.editingMemoryId = null;
    this.isCreatingMemory = false;
    this.isSubmitting = false;
    this.searchInput = null;
    this.statsEl = null;
    this._searchResults = null;
  }

  /** @private Remove all tracked DOM listeners */
  _clearListeners() {
    for (const { element, event, handler, options } of this._listeners) {
      element?.removeEventListener(event, handler, options);
    }
    this._listeners = [];
  }

  /**
   * @private
   * Remove tracked DOM listeners for elements inside a specific container
   */
  _clearListenersFor(container) {
    if (!container) return;
    this._listeners = this._listeners.filter(listener => {
      if (listener.element && container.contains(listener.element)) {
        listener.element.removeEventListener(listener.event, listener.handler, listener.options);
        return false;
      }
      return true;
    });
  }

  /** @private */
  _trackListener(element, event, handler, options) {
    if (!element) return;
    element.addEventListener(event, handler, options);
    this._listeners.push({ element, event, handler, options });
  }

  /** @private */
  _clearTimer(id) {
    if (!id) return;
    clearTimeout(id);
    this._timers = this._timers.filter(t => t !== id);
  }

  /** @private */
  _trackTimer(fn, ms) {
    const id = setTimeout(fn, ms);
    this._timers.push(id);
    return id;
  }
}

module.exports = MemoryBrowserModal;
