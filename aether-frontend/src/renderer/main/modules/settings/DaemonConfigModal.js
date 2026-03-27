'use strict';

/**
 * @.architecture
 * Incoming: ProactiveDaemonManager (settings button click) --- {constructor_call, daemon_config_object}
 * Processing: Full per-daemon configuration modal with form rendering, validation, save --- {5 jobs: JOB_RENDER_FORM, JOB_VALIDATE, JOB_SAVE_CONFIG, JOB_LOAD_CONFIG, JOB_BROWSER_INDEX_MGMT}
 * Outgoing: Endpoint API (POST /v1/file/daemon/config), BrowserHistoryManager (embedded), DOM --- {http_request, component_init, dom_types.modal_element}
 *
 * @module renderer/main/modules/settings/DaemonConfigModal
 */

const BaseModal = require('../../../shared/modals/BaseModal');
const Toast = require('../../../shared/components/Toast');
const ComponentFactory = require('../../../shared/utils/ComponentFactory');

// =============================================================================
// Constants
// =============================================================================

const DAEMON_DISPLAY_NAMES = {
  browser: 'Browser History',
  email: 'Email Monitor',
  filesystem: 'Filesystem Watcher',
  file_indexing: 'File Indexing',
  query_generation: 'Query Generation'
};

const DAEMON_ICONS = {
  browser: 'fa-globe',
  email: 'fa-envelope',
  filesystem: 'fa-folder-open',
  file_indexing: 'fa-search',
  query_generation: 'fa-brain'
};

const LOG_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR'];

/**
 * Field definitions per daemon. Each field maps directly to a backend config key.
 * type: 'number' | 'text' | 'toggle' | 'readonly' | 'log_level' | 'browser_select'
 */
const DAEMON_FIELDS = {
  browser: {
    sections: [
      {
        title: 'Daemon Settings',
        icon: 'fa-cog',
        fields: [
          { key: 'scan_interval_seconds', label: 'Scan Interval', type: 'number', min: 1, max: 3600, default: 2, unit: 'seconds', hint: 'How often to check for new browser history' },
          { key: 'retention_days', label: 'Retention', type: 'number', min: 1, max: 365, default: 1, unit: 'days', hint: 'How long to keep browser history data' },
          { key: 'bm25_index_interval_seconds', label: 'Keyword Index Refresh', type: 'number', min: 10, max: 600, default: 30, unit: 'seconds', hint: 'How often keyword search index is rebuilt for faster text matching' },
          { key: 'browser', label: 'Target Browser', type: 'browser_select', default: 'edge' },
          { key: 'auto_detect_profiles', label: 'Auto-Detect Profiles', type: 'toggle', default: true },
          { key: 'excluded_profiles', label: 'Excluded Profiles', type: 'text', default: '', hint: 'Comma-separated profile names to skip' },
          { key: 'log_level', label: 'Log Level', type: 'log_level', default: 'INFO' }
        ]
      }
    ]
  },
  email: {
    sections: [
      {
        title: 'Daemon Settings',
        icon: 'fa-cog',
        fields: [
          { key: 'scan_interval_seconds', label: 'Scan Interval', type: 'number', min: 1, max: 3600, default: 2, unit: 'seconds', hint: 'How often to check for new emails' },
          { key: 'retention_days', label: 'Retention', type: 'number', min: 1, max: 365, default: 1, unit: 'days', hint: 'How long to keep email data' },
          { key: 'bm25_index_interval_seconds', label: 'Keyword Index Refresh', type: 'number', min: 10, max: 600, default: 30, unit: 'seconds', hint: 'How often keyword search index is rebuilt for faster text matching' },
          { key: 'max_emails_per_scan', label: 'Max Emails per Scan', type: 'number', min: 1, max: 500, default: 50, hint: 'Maximum emails to process in one scan cycle' },
          { key: 'log_level', label: 'Log Level', type: 'log_level', default: 'INFO' }
        ]
      }
    ]
  },
  filesystem: {
    sections: [
      {
        title: 'Daemon Settings',
        icon: 'fa-cog',
        fields: [
          { key: 'retention_days', label: 'Retention', type: 'number', min: 1, max: 365, default: 1, unit: 'days', hint: 'How long to keep filesystem event data' },
          { key: 'bm25_index_interval_seconds', label: 'Keyword Index Refresh', type: 'number', min: 10, max: 600, default: 30, unit: 'seconds', hint: 'How often keyword search index is rebuilt for faster text matching' },
          { key: 'debounce_seconds', label: 'Debounce', type: 'number', min: 1, max: 30, default: 2, unit: 'seconds', hint: 'Wait time after file changes before processing' },
          { key: 'log_level', label: 'Log Level', type: 'log_level', default: 'INFO' }
        ]
      },
      {
        title: 'Event Tracking',
        icon: 'fa-eye',
        fields: [
          { key: 'track_created', label: 'Track File Created', type: 'toggle', default: true },
          { key: 'track_modified', label: 'Track File Modified', type: 'toggle', default: true },
          { key: 'track_deleted', label: 'Track File Deleted', type: 'toggle', default: true },
          { key: 'track_moved', label: 'Track File Moved', type: 'toggle', default: true }
        ]
      }
    ]
  },
  file_indexing: {
    sections: [
      {
        title: 'Service Configuration',
        icon: 'fa-cog',
        fields: [
          { key: 'heartbeat_interval_seconds', label: 'Heartbeat Interval', type: 'number', min: 10, max: 300, default: 30, unit: 'seconds', hint: 'Service health check frequency' },
          { key: 'scan_check_interval_seconds', label: 'Scan Check Interval', type: 'number', min: 10, max: 600, default: 60, unit: 'seconds', hint: 'How often to check for pending index scans' },
          { key: 'max_concurrent_scans', label: 'Max Concurrent Scans', type: 'number', min: 1, max: 5, default: 1, hint: 'Maximum parallel indexing operations' },
          { key: 'aether_rag_embedding_model', label: 'Embedding Model', type: 'readonly', default: '' },
          { key: 'log_level', label: 'Log Level', type: 'log_level', default: 'INFO' }
        ]
      }
    ]
  },
  query_generation: {
    sections: [
      {
        title: 'Generation Configuration',
        icon: 'fa-cog',
        fields: [
          { key: 'check_interval_seconds', label: 'Check Interval', type: 'number', min: 10, max: 600, default: 60, unit: 'seconds', hint: 'How often to check for new logs to process' },
          { key: 'batch_size', label: 'Batch Size', type: 'number', min: 1, max: 500, default: 100, hint: 'Logs to process per batch' },
          { key: 'context_size', label: 'Context Size', type: 'number', min: 1, max: 20, default: 5, hint: 'Documents used as context for generation' },
          { key: 'max_query_terms', label: 'Max Query Terms', type: 'number', min: 1, max: 50, default: 10, hint: 'Maximum terms in generated queries' },
          { key: 'llm_model', label: 'LLM Model', type: 'readonly', default: '' },
          { key: 'log_level', label: 'Log Level', type: 'log_level', default: 'INFO' }
        ]
      }
    ]
  }
};

const LoadingSkeletonTemplate = ComponentFactory.define(`
  <div class="dcm-loading">
    <div class="dcm-skeleton dcm-skeleton--header"></div>
    <div class="dcm-skeleton dcm-skeleton--field"></div>
    <div class="dcm-skeleton dcm-skeleton--field"></div>
    <div class="dcm-skeleton dcm-skeleton--field"></div>
    <div class="dcm-skeleton dcm-skeleton--field-short"></div>
  </div>
`);

// =============================================================================
// DaemonConfigModal
// =============================================================================

class DaemonConfigModal extends BaseModal {
  /**
   * @param {Object} options
   * @param {string} options.daemonName - Daemon key (browser, email, filesystem, file_indexing, query_generation)
   * @param {Object} options.daemonConfig - Current daemon config object
   * @param {Object} options.endpoint - Endpoint facade instance
   * @param {Function} options.onSave - Callback invoked after successful save
   */
  constructor(options = {}) {
    const daemonName = options.daemonName;
    const displayName = DAEMON_DISPLAY_NAMES[daemonName] || daemonName;

    super({
      title: `${displayName} Settings`,
      id: `daemon-config-${daemonName}`,
      size: 'md',
      heightPreset: 'auto',
      showFooter: true
    });

    this.daemonName = daemonName;
    this.daemonConfig = options.daemonConfig || {};
    this.endpoint = options.endpoint;
    this.onSave = options.onSave || null;

    // Browser-specific: embedded BrowserHistoryManager
    this._browserHistoryManager = null;
    this._browserTypes = null;

    // File indexing-specific: daemon status
    this._daemonStatus = null;

    // Lifecycle — deterministic cleanup tracking
    this._cleanups = [];
    this._openSequence = 0;
    this._isSaving = false;
    this._isDisposed = false;
  }

  /**
   * Track a listener for cleanup on modal close.
   * @param {Element} element
   * @param {string} event
   * @param {Function} handler
   */
  _trackModalListener(element, event, handler) {
    if (!element) return;
    element.addEventListener(event, handler);
    this._cleanups.push(() => element.removeEventListener(event, handler));
  }

  /**
   * Set button content: icon + text, XSS-safe via DOM API.
   * @param {HTMLElement} btn - Button element
   * @param {string} iconClass - FontAwesome class
   * @param {string} text - Button text
   */
  _setButtonContent(btn, iconClass, text) {
    if (!btn) return;
    btn.replaceChildren();
    const icon = document.createElement('i');
    icon.className = iconClass;
    btn.appendChild(icon);
    btn.append(` ${text}`);
  }

  // ===========================================================================
  // Render
  // ===========================================================================

  async _renderContent() {
    const { root: skeletonRoot } = LoadingSkeletonTemplate.stamp();
    this.bodyEl.replaceChildren(skeletonRoot);

    const seq = ++this._openSequence;

    try {
      const fullConfig = await this.endpoint.getFileIndexingDaemonConfig();
      if (seq !== this._openSequence || !this.isOpen) return;
      if (fullConfig && fullConfig[this.daemonName]) {
        this.daemonConfig = fullConfig[this.daemonName];
      }
    } catch (err) {
      if (seq !== this._openSequence || !this.isOpen) return;
      console.warn('[DaemonConfigModal] Failed to fetch fresh config, using cached:', err);
    }

    if (this.daemonName === 'browser') {
      await this._fetchBrowserTypes();
      if (seq !== this._openSequence || !this.isOpen) return;
    }

    if (this.daemonName === 'file_indexing') {
      await this._fetchDaemonStatus();
      if (seq !== this._openSequence || !this.isOpen) return;
    }

    this.bodyEl.innerHTML = this._renderFormHTML();
    this._renderFooter();
  }

  _setupEventListeners() {
    // Footer: Cancel button
    const cancelBtn = this.footerEl?.querySelector('[data-action="cancel"]');
    this._trackModalListener(cancelBtn, 'click', () => this.close());

    // Footer: Save button
    const saveBtn = this.footerEl?.querySelector('[data-action="save"]');
    this._trackModalListener(saveBtn, 'click', () => this._handleSave());

    // File indexing: Restart daemon button
    if (this.daemonName === 'file_indexing') {
      const restartBtn = this.bodyEl?.querySelector('[data-action="restart-daemon"]');
      this._trackModalListener(restartBtn, 'click', () => this._handleRestartDaemon());
    }

    // Browser daemon: Initialize BrowserHistoryManager in container
    if (this.daemonName === 'browser') {
      this._initBrowserHistorySection();
    }

    // Email daemon: Initialize EmailManager in container
    if (this.daemonName === 'email') {
      this._initEmailSection();
    }
  }

  // ===========================================================================
  // Form Rendering
  // ===========================================================================

  _renderFormHTML() {
    const definition = DAEMON_FIELDS[this.daemonName];
    if (!definition) {
      return `<div class="dcm-error"><i class="fas fa-exclamation-triangle"></i> Unknown daemon: ${this._escapeHtml(this.daemonName)}</div>`;
    }

    const icon = DAEMON_ICONS[this.daemonName] || 'fa-cog';
    let html = `<div class="dcm-form" data-daemon="${this._escapeHtml(this.daemonName)}">`;

    // Render each section
    for (const section of definition.sections) {
      html += this._renderSection(section);
    }

    // Browser daemon: Index Management section (container for BrowserHistoryManager)
    if (this.daemonName === 'browser') {
      html += this._renderBrowserIndexSection();
    }

    // Email daemon: Index Management section (container for EmailManager)
    if (this.daemonName === 'email') {
      html += this._renderEmailIndexSection();
    }

    // File Indexing daemon: Service Status section
    if (this.daemonName === 'file_indexing') {
      html += this._renderFileIndexingStatusSection();
    }

    html += '</div>';
    return html;
  }

  _renderSection(section) {
    let html = `
      <div class="dcm-section">
        <div class="dcm-section-header">
          <i class="fas ${section.icon || 'fa-cog'}"></i>
          <span>${this._escapeHtml(section.title)}</span>
        </div>
        <div class="dcm-section-body">
    `;

    for (const field of section.fields) {
      html += this._renderField(field);
    }

    html += `
        </div>
      </div>
    `;
    return html;
  }

  _renderField(field) {
    const value = this.daemonConfig[field.key] !== undefined
      ? this.daemonConfig[field.key]
      : field.default;

    switch (field.type) {
      case 'number':
        return this._renderNumberField(field, value);
      case 'text':
        return this._renderTextField(field, value);
      case 'toggle':
        return this._renderToggleField(field, value);
      case 'readonly':
        return this._renderReadonlyField(field, value);
      case 'log_level':
        return this._renderLogLevelField(field, value);
      case 'browser_select':
        return this._renderBrowserSelectField(field, value);
      default:
        return '';
    }
  }

  _renderNumberField(field, value) {
    const unitLabel = field.unit ? `<span class="dcm-field-unit">${this._escapeHtml(field.unit)}</span>` : '';
    return `
      <div class="dcm-field">
        <label class="dcm-field-label" for="dcm-${field.key}">${this._escapeHtml(field.label)}</label>
        <div class="dcm-field-input-row">
          <input type="number"
                 id="dcm-${field.key}"
                 class="dcm-input"
                 data-field="${field.key}"
                 data-type="number"
                 value="${Number(value) || field.default}"
                 min="${field.min}"
                 max="${field.max}"
                 step="1" />
          ${unitLabel}
        </div>
        ${field.hint ? `<div class="dcm-field-hint">${this._escapeHtml(field.hint)}</div>` : ''}
        <div class="dcm-field-error" id="dcm-error-${field.key}"></div>
      </div>
    `;
  }

  _renderTextField(field, value) {
    // Handle array values (e.g., excluded_profiles)
    const displayValue = Array.isArray(value) ? value.join(', ') : (value || '');
    return `
      <div class="dcm-field">
        <label class="dcm-field-label" for="dcm-${field.key}">${this._escapeHtml(field.label)}</label>
        <input type="text"
               id="dcm-${field.key}"
               class="dcm-input"
               data-field="${field.key}"
               data-type="text"
               value="${this._escapeHtml(String(displayValue))}"
               placeholder="${field.hint || ''}" />
        ${field.hint ? `<div class="dcm-field-hint">${this._escapeHtml(field.hint)}</div>` : ''}
        <div class="dcm-field-error" id="dcm-error-${field.key}"></div>
      </div>
    `;
  }

  _renderToggleField(field, value) {
    const checked = value ? 'checked' : '';
    return `
      <div class="dcm-field dcm-field--toggle">
        <label class="aether-switch">
          <input type="checkbox"
                 id="dcm-${field.key}"
                 data-field="${field.key}"
                 data-type="toggle"
                 ${checked} />
          <span class="aether-switch-track">
            <span class="aether-switch-thumb"></span>
          </span>
        </label>
        <label class="dcm-toggle-label" for="dcm-${field.key}">${this._escapeHtml(field.label)}</label>
      </div>
    `;
  }

  _renderReadonlyField(field, value) {
    const displayValue = value || 'Not configured';
    return `
      <div class="dcm-field">
        <label class="dcm-field-label">${this._escapeHtml(field.label)}</label>
        <div class="dcm-readonly-value">
          <i class="fas fa-lock"></i>
          <span>${this._escapeHtml(String(displayValue))}</span>
        </div>
      </div>
    `;
  }

  _renderLogLevelField(field, value) {
    const options = LOG_LEVELS.map(level =>
      `<option value="${level}" ${value === level ? 'selected' : ''}>${level}</option>`
    ).join('');

    return `
      <div class="dcm-field">
        <label class="dcm-field-label" for="dcm-${field.key}">${this._escapeHtml(field.label)}</label>
        <select id="dcm-${field.key}"
                class="dcm-select"
                data-field="${field.key}"
                data-type="log_level">
          ${options}
        </select>
      </div>
    `;
  }

  _renderBrowserSelectField(field, value) {
    let options = '';
    if (this._browserTypes && this._browserTypes.length > 0) {
      options = this._browserTypes.map(browser =>
        `<option value="${this._escapeHtml(browser)}" ${value === browser ? 'selected' : ''}>${this._escapeHtml(browser.charAt(0).toUpperCase() + browser.slice(1))}</option>`
      ).join('');
    } else {
      // Fallback: hardcoded defaults
      const defaults = ['edge', 'chrome', 'firefox', 'brave', 'opera', 'vivaldi'];
      options = defaults.map(browser =>
        `<option value="${browser}" ${value === browser ? 'selected' : ''}>${browser.charAt(0).toUpperCase() + browser.slice(1)}</option>`
      ).join('');
    }

    return `
      <div class="dcm-field">
        <label class="dcm-field-label" for="dcm-${field.key}">${this._escapeHtml(field.label)}</label>
        <select id="dcm-${field.key}"
                class="dcm-select"
                data-field="${field.key}"
                data-type="browser_select">
          ${options}
        </select>
      </div>
    `;
  }

  // ===========================================================================
  // Browser-Specific: Index Management Section
  // ===========================================================================

  _renderBrowserIndexSection() {
    return `
      <div class="dcm-section">
        <div class="dcm-section-header">
          <i class="fas fa-database"></i>
          <span>Index Management</span>
        </div>
        <div class="dcm-section-body">
          <div id="dcm-browser-index-container" class="dcm-browser-index-container">
            <div class="dcm-index-placeholder">
              <i class="fas fa-spinner fa-spin"></i>
              <span>Loading index management...</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Initialize BrowserHistoryManager inside the modal.
   * Creates the required DOM structure, then delegates to BrowserHistoryManager.
   */
  _initBrowserHistorySection() {
    const container = this.bodyEl?.querySelector('#dcm-browser-index-container');
    if (!container) return;

    try {
      const BrowserHistoryManager = require('./BrowserHistoryManager');

      // Create the DOM structure BrowserHistoryManager expects
      container.innerHTML = `
        <div class="dcm-browser-index-ui">
          <div class="form-field">
            <label for="aether-rag-sources-browser-kind">Browser</label>
            <select id="aether-rag-sources-browser-kind" class="dcm-select">
              ${this._getBrowserOptions()}
            </select>
          </div>
          <button id="aether-rag-sources-browser-discover" class="btn-secondary dcm-btn-full">
            <i class="fas fa-search"></i> Discover Profiles
          </button>
          <div id="aether-rag-sources-browser-profiles-list"></div>
          <div class="form-field" style="display:none;">
            <label for="aether-rag-sources-browser-profile">Profile</label>
            <select id="aether-rag-sources-browser-profile" class="dcm-select">
              <option value="">Select a profile...</option>
            </select>
          </div>
          <div id="aether-rag-sources-browser-index-status" class="browser-index-status"></div>
          <div id="aether-rag-sources-browser-progress" class="browser-progress" style="display:none;"></div>
          <div class="dcm-browser-actions-row">
            <button id="aether-rag-sources-browser-build" class="btn-primary dcm-btn-half">
              <i class="fas fa-hammer"></i> Build Index
            </button>
            <button id="aether-rag-sources-browser-view" class="btn-secondary dcm-btn-half">
              <i class="fas fa-eye"></i> View Index
            </button>
          </div>
        </div>
      `;

      // Create and initialize BrowserHistoryManager
      this._browserHistoryManager = new BrowserHistoryManager({
        endpoint: this.endpoint
      });

      // Set the selected browser from daemon config
      if (this.daemonConfig.browser) {
        this._browserHistoryManager.selectedBrowser = this.daemonConfig.browser;
      }

      this._browserHistoryManager.initialize().catch(err => {
        console.error('[DaemonConfigModal] BrowserHistoryManager init failed:', err);
        container.replaceChildren();
        const errorDiv = this._createErrorElement(
          `Failed to load index management: ${err.message}`
        );
        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn-secondary dcm-retry-btn';
        retryBtn.dataset.action = 'retry-browser';
        retryBtn.textContent = 'Retry';
        errorDiv.appendChild(retryBtn);
        container.appendChild(errorDiv);
        this._trackModalListener(retryBtn, 'click', () => this._initBrowserHistorySection());
      });
    } catch (err) {
      console.error('[DaemonConfigModal] Failed to load BrowserHistoryManager:', err);
      container.replaceChildren();
      container.appendChild(this._createErrorElement('Index management unavailable'));
    }
  }

  // ===========================================================================
  // Email-Specific: Index Management Section
  // ===========================================================================

  _renderEmailIndexSection() {
    return `
      <div class="dcm-section">
        <div class="dcm-section-header">
          <i class="fas fa-database"></i>
          <span>Index Management</span>
        </div>
        <div class="dcm-section-body">
          <div id="dcm-email-index-container" class="dcm-email-index-container">
            <div class="dcm-index-placeholder">
              <i class="fas fa-spinner fa-spin"></i>
              <span>Loading index management...</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Initialize EmailManager inside the modal.
   * Creates the required DOM structure, then delegates to EmailManager.
   */
  _initEmailSection() {
    const container = this.bodyEl?.querySelector('#dcm-email-index-container');
    if (!container) return;

    try {
      const EmailManager = require('./EmailManager');

      // Create the DOM structure EmailManager expects
      container.innerHTML = `
        <div class="dcm-email-index-ui">
          <div class="form-field">
            <label for="aether-rag-sources-email-source-path">Mailbox Path (.mbox / .eml folder)</label>
            <input type="text" id="aether-rag-sources-email-source-path" class="dcm-input" placeholder="Leave empty for Apple Mail (macOS) default">
            <div class="form-help">Optionally index a specific folder of .eml or .mbox files. Leave empty to use system default email.</div>
          </div>
          <div class="form-field">
            <label for="aether-rag-sources-email-max-items">Max Emails to Index</label>
            <input type="number" id="aether-rag-sources-email-max-items" class="dcm-input" min="1" max="100000" value="1000">
            <div class="form-help">Maximum number of recent emails to process for indexing.</div>
          </div>
          <div id="aether-rag-sources-email-index-status" class="email-index-status"></div>
          <div id="aether-rag-sources-email-progress" class="email-progress" style="display:none;"></div>
          <div class="dcm-browser-actions-row">
            <button id="aether-rag-sources-email-build" class="btn-primary dcm-btn-half">
              <i class="fas fa-hammer"></i> Build Index
            </button>
            <button id="aether-rag-sources-email-view" class="btn-secondary dcm-btn-half">
              <i class="fas fa-eye"></i> View Index
            </button>
          </div>
        </div>
      `;

      // Create and initialize EmailManager
      this._emailManager = new EmailManager({
        endpoint: this.endpoint
      });

      this._emailManager.initialize().catch(err => {
        console.error('[DaemonConfigModal] EmailManager init failed:', err);
        container.replaceChildren();
        const errorDiv = this._createErrorElement(
          `Failed to load index management: ${err.message}`
        );
        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn-secondary dcm-retry-btn';
        retryBtn.dataset.action = 'retry-email';
        retryBtn.textContent = 'Retry';
        errorDiv.appendChild(retryBtn);
        container.appendChild(errorDiv);
        this._trackModalListener(retryBtn, 'click', () => this._initEmailSection());
      });
    } catch (err) {
      console.error('[DaemonConfigModal] Failed to load EmailManager:', err);
      container.replaceChildren();
      container.appendChild(this._createErrorElement('Index management unavailable'));
    }
  }

  _getBrowserOptions() {
    const currentBrowser = this.daemonConfig.browser || 'edge';
    const browsers = this._browserTypes && this._browserTypes.length > 0
      ? this._browserTypes
      : ['edge', 'chrome', 'firefox', 'brave', 'opera', 'vivaldi'];

    return browsers.map(b =>
      `<option value="${this._escapeHtml(b)}" ${b === currentBrowser ? 'selected' : ''}>${this._escapeHtml(b.charAt(0).toUpperCase() + b.slice(1))}</option>`
    ).join('');
  }

  // ===========================================================================
  // File Indexing-Specific: Status Section
  // ===========================================================================

  _renderFileIndexingStatusSection() {
    const status = this._daemonStatus;
    let statusHTML;

    if (!status) {
      statusHTML = `
        <div class="dcm-status-item">
          <span class="dcm-status-label">Status</span>
          <span class="dcm-status-value dcm-status--unknown"><i class="fas fa-question-circle"></i> Unknown</span>
        </div>
      `;
    } else {
      const isRunning = status.status === 'running' || status.running === true;
      const statusIcon = isRunning ? 'fa-circle-check' : 'fa-circle-stop';
      const statusClass = isRunning ? 'dcm-status--running' : 'dcm-status--stopped';
      const statusText = isRunning ? 'Running' : 'Stopped';

      statusHTML = `
        <div class="dcm-status-item">
          <span class="dcm-status-label">Status</span>
          <span class="dcm-status-value ${statusClass}"><i class="fas ${statusIcon}"></i> ${statusText}</span>
        </div>
        ${status.uptime ? `
          <div class="dcm-status-item">
            <span class="dcm-status-label">Uptime</span>
            <span class="dcm-status-value">${this._formatUptime(status.uptime)}</span>
          </div>
        ` : ''}
        ${status.last_scan ? `
          <div class="dcm-status-item">
            <span class="dcm-status-label">Last Scan</span>
            <span class="dcm-status-value">${this._formatDate(status.last_scan)}</span>
          </div>
        ` : ''}
      `;
    }

    return `
      <div class="dcm-section">
        <div class="dcm-section-header">
          <i class="fas fa-heartbeat"></i>
          <span>Service Status</span>
        </div>
        <div class="dcm-section-body">
          <div class="dcm-status-grid">
            ${statusHTML}
          </div>
          <button class="btn-secondary dcm-restart-btn" data-action="restart-daemon">
            <i class="fas fa-redo"></i> Restart Service
          </button>
        </div>
      </div>
    `;
  }

  // ===========================================================================
  // Footer
  // ===========================================================================

  _renderFooter() {
    if (!this.footerEl) return;

    this.footerEl.replaceChildren();

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary dcm-footer-btn';
    cancelBtn.dataset.action = 'cancel';
    cancelBtn.textContent = 'Cancel';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-primary dcm-footer-btn';
    saveBtn.dataset.action = 'save';
    this._setButtonContent(saveBtn, 'fas fa-save', 'Save Changes');

    this.footerEl.appendChild(cancelBtn);
    this.footerEl.appendChild(saveBtn);
  }

  // ===========================================================================
  // Data Fetching
  // ===========================================================================

  async _fetchBrowserTypes() {
    try {
      const sourcesData = await this.endpoint.getSources();
      if (sourcesData && sourcesData.sources && sourcesData.sources.browsers) {
        this._browserTypes = sourcesData.sources.browsers;
      } else if (sourcesData && Array.isArray(sourcesData.browsers)) {
        this._browserTypes = sourcesData.browsers;
      }
    } catch (err) {
      console.warn('[DaemonConfigModal] Failed to fetch browser types:', err);
      // Fallback handled in _renderBrowserSelectField
    }
  }

  async _fetchDaemonStatus() {
    try {
      this._daemonStatus = await this.endpoint.getFileIndexingDaemonStatus();
    } catch (err) {
      console.warn('[DaemonConfigModal] Failed to fetch daemon status:', err);
      this._daemonStatus = null;
    }
  }

  // ===========================================================================
  // Save
  // ===========================================================================

  async _handleSave() {
    if (this._isSaving || this._isDisposed) return;

    // Collect form data
    const formData = this._collectFormData();
    if (!formData) return; // Validation failed

    this._isSaving = true;
    const saveBtn = this.footerEl?.querySelector('[data-action="save"]');
    if (saveBtn) {
      saveBtn.disabled = true;
      this._setButtonContent(saveBtn, 'fas fa-spinner fa-spin', 'Saving...');
    }

    try {
      // Build the full config update payload
      // Backend expects the entire config object with this daemon's section updated
      const fullConfig = await this.endpoint.getFileIndexingDaemonConfig();
      fullConfig[this.daemonName] = { ...fullConfig[this.daemonName], ...formData };

      await this.endpoint.updateFileIndexingDaemonConfig(fullConfig);

      Toast.success(`${DAEMON_DISPLAY_NAMES[this.daemonName]} settings saved`);

      // Callback to refresh parent UI
      if (typeof this.onSave === 'function') {
        this.onSave();
      }

      this.close();
    } catch (err) {
      console.error('[DaemonConfigModal] Save failed:', err);
      Toast.error(`Failed to save: ${err.message}`);

      // Show inline error
      const errorContainer = this.bodyEl?.querySelector('.dcm-save-error');
      if (errorContainer) {
        errorContainer.textContent = `Save failed: ${err.message}`;
        errorContainer.style.display = 'block';
      }
    } finally {
      this._isSaving = false;
      if (saveBtn) {
        saveBtn.disabled = false;
        this._setButtonContent(saveBtn, 'fas fa-save', 'Save Changes');
      }
    }
  }

  /**
   * Collect and validate all form fields.
   * @returns {Object|null} Collected data, or null if validation failed.
   */
  _collectFormData() {
    const definition = DAEMON_FIELDS[this.daemonName];
    if (!definition) return null;

    const data = {};
    let hasErrors = false;

    // Clear previous errors
    const errorEls = this.bodyEl?.querySelectorAll('.dcm-field-error');
    if (errorEls) {
      errorEls.forEach(el => {
        el.textContent = '';
        el.style.display = 'none';
      });
    }

    for (const section of definition.sections) {
      for (const field of section.fields) {
        const el = this.bodyEl?.querySelector(`[data-field="${field.key}"]`);
        if (!el) continue;

        const type = el.dataset.type;
        let value;

        switch (type) {
          case 'number': {
            value = parseInt(el.value, 10);
            if (isNaN(value)) {
              this._showFieldError(field.key, `${field.label} must be a number`);
              hasErrors = true;
              continue;
            }
            if (field.min !== undefined && value < field.min) {
              this._showFieldError(field.key, `${field.label} must be at least ${field.min}`);
              hasErrors = true;
              continue;
            }
            if (field.max !== undefined && value > field.max) {
              this._showFieldError(field.key, `${field.label} must be at most ${field.max}`);
              hasErrors = true;
              continue;
            }
            break;
          }
          case 'text': {
            value = el.value.trim();
            // For excluded_profiles: convert comma-separated to array
            if (field.key === 'excluded_profiles' && value) {
              value = value.split(',').map(s => s.trim()).filter(Boolean);
            }
            break;
          }
          case 'toggle': {
            value = el.checked;
            break;
          }
          case 'log_level':
          case 'browser_select': {
            value = el.value;
            break;
          }
          case 'readonly':
            // Don't collect readonly fields
            continue;
          default:
            value = el.value;
        }

        data[field.key] = value;
      }
    }

    if (hasErrors) return null;
    return data;
  }

  _showFieldError(fieldKey, message) {
    const errorEl = this.bodyEl?.querySelector(`#dcm-error-${fieldKey}`);
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }
  }

  // ===========================================================================
  // File Indexing: Restart Daemon
  // ===========================================================================

  async _handleRestartDaemon() {
    if (this._isDisposed) return;
    const restartBtn = this.bodyEl?.querySelector('[data-action="restart-daemon"]');
    if (!restartBtn) return;

    restartBtn.disabled = true;
    this._setButtonContent(restartBtn, 'fas fa-spinner fa-spin', 'Restarting...');

    try {
      await this.endpoint.restartFileIndexingDaemon();
      Toast.success('File indexing service restarted');

      // Refresh status
      await this._fetchDaemonStatus();
      const statusGrid = this.bodyEl?.querySelector('.dcm-status-grid');
      if (statusGrid && this._daemonStatus) {
        const isRunning = this._daemonStatus.status === 'running' || this._daemonStatus.running === true;
        const statusIcon = isRunning ? 'fa-circle-check' : 'fa-circle-stop';
        const statusClass = isRunning ? 'dcm-status--running' : 'dcm-status--stopped';
        const statusText = isRunning ? 'Running' : 'Stopped';

        statusGrid.replaceChildren();
        const item = document.createElement('div');
        item.className = 'dcm-status-item';
        const label = document.createElement('span');
        label.className = 'dcm-status-label';
        label.textContent = 'Status';
        const value = document.createElement('span');
        value.className = `dcm-status-value ${statusClass}`;
        const icon = document.createElement('i');
        icon.className = `fas ${statusIcon}`;
        value.appendChild(icon);
        value.append(` ${statusText}`);
        item.appendChild(label);
        item.appendChild(value);
        statusGrid.appendChild(item);
      }
    } catch (err) {
      console.error('[DaemonConfigModal] Restart failed:', err);
      Toast.error(`Restart failed: ${err.message}`);
    } finally {
      if (restartBtn) {
        restartBtn.disabled = false;
        this._setButtonContent(restartBtn, 'fas fa-redo', 'Restart Service');
      }
    }
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  _cleanup() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this._openSequence++;

    if (this._browserHistoryManager) {
      try {
        this._browserHistoryManager.destroy();
      } catch (e) {
        console.warn('[DaemonConfigModal] BrowserHistoryManager destroy error:', e);
      }
      this._browserHistoryManager = null;
    }

    if (this._emailManager) {
      try {
        this._emailManager.destroy();
      } catch (e) {
        console.warn('[DaemonConfigModal] EmailManager destroy error:', e);
      }
      this._emailManager = null;
    }

    // Run all tracked cleanup functions
    for (const cleanup of this._cleanups) {
      try {
        cleanup();
      } catch (_) { /* element may be removed */ }
    }
    this._cleanups = [];

    // Clear state
    this._isSaving = false;
    this._daemonStatus = null;
    this._browserTypes = null;
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  /**
   * Create a standard error element: icon + message text, XSS-safe via textContent.
   * @param {string} message - Error message
   * @returns {HTMLElement}
   */
  _createErrorElement(message) {
    const div = document.createElement('div');
    div.className = 'dcm-error';
    const icon = document.createElement('i');
    icon.className = 'fas fa-exclamation-triangle';
    const span = document.createElement('span');
    span.textContent = message;
    div.appendChild(icon);
    div.appendChild(span);
    return div;
  }

  _escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  _formatDate(isoString) {
    if (!isoString) return 'Unknown';
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
    } catch {
      return String(isoString);
    }
  }

  _formatUptime(seconds) {
    if (!seconds || seconds < 0) return 'Unknown';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }
}

module.exports = DaemonConfigModal;
