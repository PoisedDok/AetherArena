'use strict';

/**
 * @.architecture
 * Incoming: MainApp (user opens modal), Endpoint (HTTP API) --- {user_click, api_response}
 * Processing: Display MCP servers with status, enable/disable toggle, register, edit, delete --- {JOB_RENDER, JOB_QUERY_DB, JOB_TOGGLE_ENABLED, JOB_REGISTER, JOB_UPDATE, JOB_DELETE}
 * Outgoing: Endpoint (API calls), EventBus (status updates) --- {http_request, status_event}
 * 
 * @.security innerHTML audit: SAFE
 * innerHTML usages build static modal UI (server cards, status indicators, form fields, SVG icons).
 * Server names and tool names are set via textContent. Status colors are from internal switch/case constants.
 * 
 * @module renderer/main/modules/mcp-management/MCPManagementModal
 */

const BaseModal = require('../../../shared/modals/BaseModal');
const Toast = require('../../../shared/components/Toast');
const ConfirmDialog = require('../../../shared/components/ConfirmDialog');
const { getAether } = require('../../../shared/bridge/AetherBridge');
const { createRendererLogger } = require('../../../shared/utils/logger');

const McpStateController = require('./internal/McpStateController');
const McpRenderers = require('./internal/McpRenderers');
const McpUtils = require('./internal/McpUtils');

/**
 * MCP Management Modal - Coordinator Facade
 */
class MCPManagementModal extends BaseModal {
  constructor(options = {}) {
    const { eventBus, endpoint, ...baseOptions } = options;
    
    super({
      ...baseOptions,
      id: 'mcp-management-modal',
      title: 'MCP Servers',
      size: 'xl',
      heightPreset: 'default'
    });
    
    this.log = createRendererLogger('MCPManagementModal');
    const aether = getAether();
    this.endpoint = endpoint || aether?.endpoint || null;
    this.eventBus = eventBus || null;
    
    this._openSequence = 0;
    this._timers = [];
    
    this.stateController = new McpStateController(this.endpoint, this.log);
    
    this.renderers = new McpRenderers(this.bodyEl, this.stateController, {
      onToggleServer: this._handleToggleEnabled.bind(this),
      onInstallDiscover: this._handleDiscoverInstall.bind(this),
      onSubmitForm: this._handleSubmitForm.bind(this),
      onCancelForm: this._handleCancelForm.bind(this),
      onRegisterClick: this._handleRegisterClick.bind(this),
      onEditClick: this._handleEdit.bind(this),
      onSetupClick: this._handleSetupClick.bind(this),
      onDeleteClick: this._handleDelete.bind(this),
      onViewToolsClick: this._handleViewTools.bind(this),
      onDiscoverTabClick: this._handleDiscoverTabClick.bind(this),
      onMyServersTabClick: this._handleMyServersTabClick.bind(this),
      onRetryDiscoverClick: this._handleRetryDiscover.bind(this),
      onPrefillPrompt: () => {
        const id = setTimeout(() => {
          Toast.info('Auto-filled config. Please provide any required API keys or env vars.', 4000);
        }, 500);
        this._timers.push(id);
      }
    });
  }

  // --- BaseModal Overrides ---

  async _renderContent() {
    if (!this.endpoint) {
      this.bodyEl.innerHTML = '<div class="modal-empty-state"><p>Endpoint not initialized</p></div>';
      return;
    }
    
    if (this.renderers && typeof this.renderers._clearMainListeners === 'function') {
      this.renderers._clearMainListeners();
    }
    this.bodyEl.innerHTML = `
      <div class="skeleton-container">
        <div class="skeleton-row"><div class="skeleton-line skeleton-line--md skeleton-line--thick"></div></div>
        <div class="skeleton-card"><div class="skeleton-line skeleton-line--lg"></div><div class="skeleton-line skeleton-line--full"></div><div class="skeleton-line skeleton-line--sm"></div></div>
        <div class="skeleton-card"><div class="skeleton-line skeleton-line--md"></div><div class="skeleton-line skeleton-line--full"></div></div>
      </div>`;
    
    const seq = ++this._openSequence;
    try {
      await this.stateController.fetchServers();
      if (seq !== this._openSequence || !this.isOpen) return;
      this.renderers.render();
      this._checkAuthStatuses(seq);
    } catch (error) {
      if (seq !== this._openSequence || !this.isOpen) return;
      this.log.error('[MCPManagementModal] Failed to load MCP servers:', error);
      this.bodyEl.innerHTML = `
        <div class="modal-empty-state">
          <div class="modal-empty-title">Failed to Load MCP Servers</div>
          <div class="modal-empty-text">${McpUtils.escapeHtml(error?.message || 'Unknown error')}</div>
        </div>
      `;
    }
  }

  async _checkAuthStatuses(seq) {
    for (const server of this.stateController.servers) {
      if (!this.isOpen || seq !== this._openSequence) return;
      
      const isNative = ['slack_mcp', 'telegram_mcp', 'whatsapp_mcp'].includes(server.name);
      if (!isNative) continue;
      
      const isEnabled = server.enabled !== false;
      const isRunning = server.status === 'active' || server.status === 'running';
      if (!isEnabled || !isRunning) continue;
      
      const statusEl = this.bodyEl.querySelector(`#auth-status-${server.server_id || server.id}`);
      if (!statusEl) continue;
      
      try {
        let toolName = '';
        if (server.name === 'whatsapp_mcp') toolName = 'whatsapp_check_auth';
        else if (server.name === 'telegram_mcp') toolName = 'telegram_health_check';
        else if (server.name === 'slack_mcp') toolName = 'slack_health_check';
        
        const res = await this.stateController.executeTool(server.server_id || server.id, toolName);
        const text = this._extractToolText(res);
        
        if (!this.isOpen || seq !== this._openSequence) return;
        
        if (text.includes('Authenticated successfully') || text.includes('Connected successfully')) {
          statusEl.style.color = 'var(--color-success)';
          statusEl.innerHTML = '&bull; Connected';
        } else if (text.includes('Loading WhatsApp Web')) {
          statusEl.style.color = 'var(--color-warning)';
          statusEl.innerHTML = '&bull; Starting engine...';
        } else {
          statusEl.style.color = 'var(--color-error)';
          statusEl.innerHTML = '&bull; Needs Setup';
        }
      } catch (err) {
        if (!this.isOpen || seq !== this._openSequence) return;
        statusEl.style.color = 'var(--color-error)';
        statusEl.innerHTML = '&bull; Auth check failed';
      }
    }
  }

  _closeActiveSubDialog() {
    if (this._activeSubDialogCloseFn) {
      this._activeSubDialogCloseFn();
      this._activeSubDialogCloseFn = null;
    } else if (this._activeSubDialog && this._activeSubDialog.parentNode) {
      this._activeSubDialog.remove();
    }
    this._activeSubDialog = null;
  }

  _cleanup() {
    this._openSequence++;
    for (const id of this._timers) clearTimeout(id);
    this._timers = [];
    if (this.renderers) {
      this.renderers.dispose();
    }
    if (this.stateController) {
      this.stateController.reset();
    }
    this._closeActiveSubDialog();
  }

  // --- Fallback Accessors for Tests (Temporary Adapter) ---
  
  // Expose these for backwards compatibility with tests that haven't been updated yet
  get servers() { return this.stateController.servers; }
  set servers(val) { this.stateController.servers = val; }
  get discoverServers() { return this.stateController.discoverServers; }
  set discoverServers(val) { this.stateController.discoverServers = val; }
  get isDiscoverLoading() { return this.stateController.isDiscoverLoading; }
  set isDiscoverLoading(val) { this.stateController.isDiscoverLoading = val; }
  get discoverError() { return this.stateController.discoverError; }
  set discoverError(val) { this.stateController.discoverError = val; }
  get discoverSearchQuery() { return this.stateController.discoverSearchQuery; }
  set discoverSearchQuery(val) { this.stateController.discoverSearchQuery = val; }
  get discoverCategory() { return this.stateController.discoverCategory; }
  set discoverCategory(val) { this.stateController.discoverCategory = val; }
  get isRegistering() { return this.stateController.isRegistering; }
  set isRegistering(val) { this.stateController.isRegistering = val; }
  get editingServerId() { return this.stateController.editingServerId; }
  set editingServerId(val) { this.stateController.editingServerId = val; }
  get activeTab() { return this.stateController.activeTab; }
  set activeTab(val) { this.stateController.activeTab = val; }
  get _listeners() { return this.renderers._listeners; }
  set _listeners(val) { this.renderers._listeners = val; }
  get _subModalEl() { return this.renderers._subModalEl; }
  set _subModalEl(val) { this.renderers._subModalEl = val; }

  _renderUI() {
    this.renderers.containerEl = this.bodyEl;
    this.renderers.render();
  }
  
  _renderServerList() {
    this.renderers.containerEl = this.bodyEl;
    this.renderers.renderServerList();
  }

  _createServerCard(server) {
    this.renderers.containerEl = this.bodyEl;
    return this.renderers.createServerCard(server);
  }

  _renderRegistrationForm() {
    this.renderers.containerEl = this.bodyEl;
    this.renderers.renderRegistrationForm();
  }

  _collectFormData() {
    const res = this.renderers.collectFormData(!!this.stateController.editingServerId);
    if (!res.valid) {
      if (res.errorMsg) Toast.warning(res.errorMsg);
      return null;
    }
    return res.data;
  }
  
  _formatDate(d) { return McpUtils.formatDate(d); }
  _escapeHtml(s) { return McpUtils.escapeHtml(s); }
  _trackListener(el, ev, cb) { this.renderers._trackListener(el, ev, cb); }
  _clearListeners() { this.renderers._clearListeners(); }


  // --- Event Handlers ---

  async _handleToggleEnabled(serverId, originalNameArg, newEnabledState) {
    try {
      const server = this.stateController.servers.find(s => (s.server_id || s.id) === serverId);
      const displayName = server ? (server.display_name || server.name) : 'Server';
      const name = server ? server.name : originalNameArg;
      
      const toastId = Toast.info(`${newEnabledState ? 'Enabling' : 'Disabling'} ${displayName}...`, 0);

      await this.stateController.toggleServerEnabled(serverId, newEnabledState);
      if (!this.isOpen) {
        Toast.dismiss(toastId);
        return;
      }
      await this._renderContent();
      Toast.dismiss(toastId);
      
      // Auto-trigger setup if newly enabled and it's a native chat MCP
      if (newEnabledState && (name === 'whatsapp_mcp' || name === 'telegram_mcp' || name === 'slack_mcp')) {
        // Give it a brief moment to start up before triggering setup
        setTimeout(async () => {
          if (!this.isOpen) return;
          
          // Fetch latest status to ensure it didn't crash on startup (e.g. missing API keys)
          await this.stateController.loadServers();
          const updatedServer = this.stateController.servers.find(s => (s.server_id || s.id) === serverId);
          
          if (updatedServer && updatedServer.status === 'error') {
            // Auto-revert if it failed to start
            await this.stateController.toggleServerEnabled(serverId, false);
            await this._renderContent();
            
            // For Slack/Telegram, missing config is usually the cause
            if (name === 'slack_mcp' || name === 'telegram_mcp') {
              Toast.error(`Configuration missing for ${displayName}. Please add required keys.`, 5000);
              this._handleEdit(serverId, name);
            } else {
              Toast.error(`${displayName} failed to start. Please try again.`, 5000);
            }
            return;
          }
          
          this._handleSetupClick(serverId, name);
        }, 1500);
      }
    } catch (error) {
      this.log.error('[MCPManagementModal] Failed to toggle server:', error);
      if (!this.isOpen) return;
      Toast.error(`Failed to ${newEnabledState ? 'enable' : 'disable'} server: ${error.message || 'Unknown error'}`);
      await this._renderContent();
    }
  }

  async _handleDelete(serverId, serverName) {
    const confirmed = await ConfirmDialog.confirm({
      title: 'Delete MCP server',
      message: `Delete MCP server "${serverName}"? This cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      variant: 'danger'
    });
    
    if (confirmed && this.isOpen) {
      try {
        await this.stateController.deleteServer(serverId);
        if (!this.isOpen) return;
        await this._renderContent();
      } catch (error) {
        this.log.error('[MCPManagementModal] Failed to delete server:', error);
        if (!this.isOpen) return;
        Toast.error(`Failed to delete server: ${error.message || 'Unknown error'}`);
      }
    }
  }

  async _handleViewTools(serverId) {
    try {
      const tools = await this.stateController.getTools(serverId);
      if (!this.isOpen) return;
      const server = this.stateController.servers.find(s => (s.server_id || s.id) === serverId);
      const serverName = server ? (server.display_name || server.name) : 'Unknown Server';
      
      this.renderers.renderToolsModal(serverName, tools);
    } catch (error) {
      this.log.error('[MCPManagementModal] Failed to get tools:', error);
      if (!this.isOpen) return;
      Toast.error(`Failed to get tools: ${error.message || 'Unknown error'}`);
    }
  }

  _handleEdit(serverId) {
    this.stateController.editingServerId = serverId;
    this.stateController.isRegistering = false;
    this.renderers.render();
  }

  _handleRegisterClick() {
    this.stateController.isRegistering = true;
    this.stateController.editingServerId = null;
    this.renderers.render();
  }

  _extractToolText(res) {
    if (!res) return '';
    if (typeof res.result === 'string') return res.result;
    
    if (res.result && typeof res.result === 'object') {
      if (res.result.success === false && res.result.error) return res.result.error;
      if (typeof res.result.result === 'string') return res.result.result;
      if (Array.isArray(res.result.result) && res.result.result[0]?.text) return res.result.result[0].text;
    }
    
    if (Array.isArray(res.result) && res.result[0]?.text) return res.result[0].text;
    return String(res.result || '');
  }

  async _handleSetupClick(serverId, serverName) {
    if (this._isSettingUp) return;
    this._isSettingUp = true;
    
    try {
      const server = this.stateController.servers.find(s => (s.server_id || s.id) === serverId);
      if (!server || (server.status !== 'active' && server.status !== 'running')) {
        Toast.warning('Please enable and start the server first.');
        return;
      }

      if (serverName === 'whatsapp_mcp') {
        const loadingDialog = this._showLoadingDialog('Starting WhatsApp Engine. This can take 10-20s...');
        try {
          let authText = '';
          let retries = 0;
          
          // Wait for WhatsApp to finish loading (up to 60 seconds)
          while (retries < 30) {
            if (!this.isOpen) return;
            const authRes = await this.stateController.executeTool(serverId, 'whatsapp_check_auth');
            authText = this._extractToolText(authRes);
            
            if (!authText.includes('Loading WhatsApp Web')) {
              break; // Finished loading (either needs QR or is authenticated)
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
            retries++;
          }
          
          if (authText.includes('Loading WhatsApp Web')) {
            loadingDialog.close();
            loadingDialog.remove();
            await this.stateController.toggleServerEnabled(serverId, false);
            if (this.isOpen) await this._renderContent();
            Toast.warning('WhatsApp is taking too long to load. Please try again.');
            return;
          }
          
          if (authText.includes('Authenticated successfully')) {
            loadingDialog.close();
            loadingDialog.remove();
            this._showConnectedDialog(serverName, serverId, 'WhatsApp is connected successfully and the chat list is visible.');
            return;
          }

          const msgEl = loadingDialog.querySelector('#mcp-loading-msg');
          if (msgEl) msgEl.textContent = 'Fetching QR code...';
          
          const qrRes = await this.stateController.executeTool(serverId, 'whatsapp_get_qr');
          const qrText = this._extractToolText(qrRes);
          
          if (qrText.includes('QR_CODE_DATA:')) {
            loadingDialog.close();
            loadingDialog.remove();
            const base64Data = qrText.split('QR_CODE_DATA:')[1].trim();
            this._showQrCodeDialog(base64Data, serverId);
          } else {
            loadingDialog.close();
            loadingDialog.remove();
            this.log.error('[MCPManagementModal] WhatsApp get_qr returned unexpected text:', qrText);
            await this.stateController.toggleServerEnabled(serverId, false);
            if (this.isOpen) await this._renderContent();
            Toast.warning('Could not get QR code. Please try again. Server might still be loading.');
          }
        } catch (error) {
          loadingDialog.close();
          loadingDialog.remove();
          this.log.error('[MCPManagementModal] WhatsApp setup failed:', error);
          await this.stateController.toggleServerEnabled(serverId, false);
          if (this.isOpen) await this._renderContent();
          Toast.error(`Setup failed: ${error.message}`);
        }
      } else if (serverName === 'telegram_mcp') {
        const loadingDialog = this._showLoadingDialog('Checking Telegram status...');
        try {
          const authRes = await this.stateController.executeTool(serverId, 'telegram_health_check');
          const authText = this._extractToolText(authRes);
          loadingDialog.close();
          loadingDialog.remove();

          if (authText.includes('Connected successfully as')) {
            this._showConnectedDialog(serverName, serverId, authText);
            return;
          }
          
          if (authText.includes('TELEGRAM_API_ID') || authText.startsWith('Error:') || authText.toLowerCase().includes('required')) {
            await this.stateController.toggleServerEnabled(serverId, false);
            if (this.isOpen) await this._renderContent();
            Toast.warning('Missing configuration. Please enter your API ID and Hash.');
            this._handleEdit(serverId);
            return;
          }

          // Show phone input dialog
          this._showTelegramPhoneDialog(serverId);
        } catch (error) {
          loadingDialog.close();
          loadingDialog.remove();
          this.log.error('[MCPManagementModal] Telegram setup failed:', error);
          await this.stateController.toggleServerEnabled(serverId, false);
          if (this.isOpen) await this._renderContent();
          Toast.error(`Setup failed: ${error.message}`);
        }
      } else if (serverName === 'slack_mcp') {
        const loadingDialog = this._showLoadingDialog('Checking Slack status...');
        try {
          const authRes = await this.stateController.executeTool(serverId, 'slack_health_check');
          const authText = this._extractToolText(authRes);
          loadingDialog.close();
          loadingDialog.remove();

          if (authText.includes('Connected successfully as')) {
            this._showConnectedDialog(serverName, serverId, authText);
            return;
          }

          // Auto-open the edit config modal if not connected so they can enter the token
          await this.stateController.toggleServerEnabled(serverId, false);
          if (this.isOpen) await this._renderContent();
          this._handleEdit(serverId);
          setTimeout(() => Toast.info('Please configure your SLACK_BOT_TOKEN first.'), 500);
        } catch (error) {
          loadingDialog.close();
          loadingDialog.remove();
          await this.stateController.toggleServerEnabled(serverId, false);
          if (this.isOpen) await this._renderContent();
          this._handleEdit(serverId);
          setTimeout(() => Toast.info('Please configure your SLACK_BOT_TOKEN first.'), 500);
        }
      }
    } finally {
      this._isSettingUp = false;
    }
  }

  _showConnectedDialog(serverName, serverId, infoText) {
    const dialog = document.createElement('dialog');
    dialog.className = 'native-setup-dialog';
    dialog.style.maxWidth = '360px';
    
    const displayName = serverName.replace('_mcp', '').charAt(0).toUpperCase() + serverName.replace('_mcp', '').slice(1);
    
    dialog.innerHTML = `
      <div class="confirm-dialog-header" style="margin-bottom: 16px;">
        <h3 class="confirm-dialog-title">${displayName} Connection</h3>
      </div>
      <div class="confirm-dialog-body" style="display: flex; flex-direction: column;">
        <p style="margin-bottom: 16px; color: var(--color-success); font-size: 14px; font-weight: 500;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
          Currently Connected
        </p>
        <p style="margin-bottom: 16px; color: var(--text-secondary); font-size: 13px; line-height: 1.4; padding: 12px; background: var(--bg-surface); border-radius: 6px; border: 1px solid var(--border-color);">
          ${this._escapeHtml(infoText)}
        </p>
        <p style="font-size: 12px; color: var(--text-tertiary);">To use a different account, disable the server and enable it again to clear the session.</p>
      </div>
      <div class="confirm-dialog-footer" style="justify-content: flex-end; gap: 8px; margin-top: 20px;">
        <button class="btn-primary" id="conn-close-btn">Close</button>
      </div>
    `;

    document.body.appendChild(dialog);
    this._closeActiveSubDialog();
    this._activeSubDialog = dialog;
    
    const close = () => {
      dialog.close();
      setTimeout(() => dialog.remove(), 200);
      if (this._activeSubDialog === dialog) {
        this._activeSubDialog = null;
        this._activeSubDialogCloseFn = null;
      }
    };
    
    this._activeSubDialogCloseFn = close;
    dialog.querySelector('#conn-close-btn').addEventListener('click', close);
    
    dialog.showModal();
  }

  _showLoadingDialog(message) {
    const dialog = document.createElement('dialog');
    dialog.className = 'native-setup-dialog';
    dialog.style.maxWidth = '300px';
    dialog.style.textAlign = 'center';
    
    dialog.innerHTML = `
      <div class="confirm-dialog-body" style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px 0;">
        <svg class="spinner" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 16px; animation: mcp-spin 1s linear infinite;"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>
        <p style="color: var(--color-text-primary); font-size: 15px; font-weight: 500;" id="mcp-loading-msg">${message}</p>
        <style>@keyframes mcp-spin { 100% { transform: rotate(360deg); } }</style>
      </div>
    `;
    
    document.body.appendChild(dialog);
    this._closeActiveSubDialog();
    this._activeSubDialog = dialog;
    
    this._activeSubDialogCloseFn = () => {
      dialog.close();
      dialog.remove();
    };
    
    // Prevent escape key from closing loading dialog immediately if we are polling
    dialog.addEventListener('cancel', (e) => e.preventDefault());
    
    dialog.showModal();
    return dialog;
  }

  _showTelegramPhoneDialog(serverId) {
    const dialog = document.createElement('dialog');
    dialog.className = 'native-setup-dialog';
    dialog.style.maxWidth = '360px';
    dialog.innerHTML = `
      <div class="confirm-dialog-header" style="margin-bottom: 16px;">
        <h3 class="confirm-dialog-title">Telegram Login</h3>
      </div>
      <div class="confirm-dialog-body" style="display: flex; flex-direction: column;">
        <p style="margin-bottom: 16px; color: var(--text-secondary); font-size: 14px;">Enter your phone number with country code (e.g. +1234567890).</p>
        <input type="text" id="tg-phone-input" class="form-input" placeholder="+1234567890" style="margin-bottom: 16px;" />
      </div>
      <div class="confirm-dialog-footer" style="justify-content: flex-end; gap: 8px;">
        <button class="btn-secondary" id="tg-cancel-btn">Cancel</button>
        <button class="btn-primary" id="tg-next-btn">Next</button>
      </div>
    `;

    const close = async (success = false) => {
      dialog.close();
      setTimeout(() => dialog.remove(), 200);
      if (this._activeSubDialog === dialog) {
        this._activeSubDialog = null;
        this._activeSubDialogCloseFn = null;
      }
      if (!success) {
        try {
          await this.stateController.toggleServerEnabled(serverId, false);
          if (this.isOpen) await this._renderContent();
        } catch (e) {}
      }
    };

    document.body.appendChild(dialog);
    this._closeActiveSubDialog(); // Ensure any existing dialog is closed first
    this._activeSubDialog = dialog;
    this._activeSubDialogCloseFn = () => close(false);
    dialog.showModal();

    dialog.querySelector('#tg-cancel-btn').addEventListener('click', () => close(false));
    
    dialog.querySelector('#tg-next-btn').addEventListener('click', async () => {
      const phone = dialog.querySelector('#tg-phone-input').value.trim();
      if (!phone) return Toast.warning('Please enter a phone number');
      
      const btn = dialog.querySelector('#tg-next-btn');
      btn.disabled = true;
      btn.textContent = 'Sending...';

      try {
        const res = await this.stateController.executeTool(serverId, 'telegram_request_otp', { phone_number: phone });
        const text = this._extractToolText(res);
        
        if (text.includes('OTP code requested')) {
          close(true);
          this._showTelegramCodeDialog(serverId, phone);
        } else {
          close(false);
          Toast.error(text);
        }
      } catch (err) {
        Toast.error(`Failed to request OTP: ${err.message}`);
        btn.disabled = false;
        btn.textContent = 'Next';
      }
    });
  }

  _showTelegramCodeDialog(serverId, phone) {
    const dialog = document.createElement('dialog');
    dialog.className = 'native-setup-dialog';
    dialog.style.maxWidth = '360px';
    dialog.innerHTML = `
      <div class="confirm-dialog-header" style="margin-bottom: 16px;">
        <h3 class="confirm-dialog-title">Enter Code</h3>
      </div>
      <div class="confirm-dialog-body" style="display: flex; flex-direction: column;">
        <p style="margin-bottom: 16px; color: var(--text-secondary); font-size: 14px;">We've sent a code to the Telegram app on your other devices.</p>
        <input type="text" id="tg-code-input" class="form-input" placeholder="12345" style="margin-bottom: 16px;" />
        <p style="margin-bottom: 8px; color: var(--text-secondary); font-size: 14px;">2FA Password (only if enabled):</p>
        <input type="password" id="tg-password-input" class="form-input" placeholder="Leave blank if not set" style="margin-bottom: 16px;" />
      </div>
      <div class="confirm-dialog-footer" style="justify-content: flex-end; gap: 8px;">
        <button class="btn-secondary" id="tg-cancel-btn">Cancel</button>
        <button class="btn-primary" id="tg-submit-btn">Login</button>
      </div>
    `;

    const close = async (success = false) => {
      dialog.close();
      setTimeout(() => dialog.remove(), 200);
      if (this._activeSubDialog === dialog) {
        this._activeSubDialog = null;
        this._activeSubDialogCloseFn = null;
      }
      if (!success) {
        try {
          await this.stateController.toggleServerEnabled(serverId, false);
          if (this.isOpen) await this._renderContent();
        } catch (e) {}
      }
    };

    document.body.appendChild(dialog);
    this._closeActiveSubDialog(); // Ensure any existing dialog is closed first
    this._activeSubDialog = dialog;
    this._activeSubDialogCloseFn = () => close(false);
    dialog.showModal();

    dialog.querySelector('#tg-cancel-btn').addEventListener('click', () => close(false));
    
    dialog.querySelector('#tg-submit-btn').addEventListener('click', async () => {
      const code = dialog.querySelector('#tg-code-input').value.trim();
      const password = dialog.querySelector('#tg-password-input').value;
      if (!code) return Toast.warning('Please enter the code');
      
      const btn = dialog.querySelector('#tg-submit-btn');
      btn.disabled = true;
      btn.textContent = 'Verifying...';

      try {
        const payload = { phone_number: phone, code };
        if (password) payload.password = password;
        
        const res = await this.stateController.executeTool(serverId, 'telegram_submit_otp', payload);
        const text = this._extractToolText(res);
        
        if (text.includes('Successfully logged in')) {
          Toast.success(text);
          close(true);
        } else {
          close(false);
          Toast.error(text);
        }
      } catch (err) {
        Toast.error(`Failed to submit OTP: ${err.message}`);
        btn.disabled = false;
        btn.textContent = 'Login';
      }
    });
  }

  _showQrCodeDialog(base64Data, serverId) {
    // Create a simple custom dialog using the ConfirmDialog structure but with an image
    const dialog = document.createElement('dialog');
    dialog.className = 'native-setup-dialog';
    dialog.style.maxWidth = '360px';
    dialog.style.textAlign = 'center';
    dialog.innerHTML = `
      <div class="confirm-dialog-header" style="justify-content: center; margin-bottom: 16px;">
        <h3 class="confirm-dialog-title">WhatsApp Setup</h3>
      </div>
      <div class="confirm-dialog-body" style="display: flex; flex-direction: column; align-items: center;">
        <p style="margin-bottom: 16px; color: var(--text-secondary); font-size: 14px;">Open WhatsApp on your phone and scan this QR code to connect.</p>
        <div style="background: white; padding: 16px; border-radius: 8px; display: inline-block;">
          <img src="${base64Data}" alt="WhatsApp Login QR Code" style="width: 256px; height: 256px; display: block;" />
        </div>
        <p id="qr-status-msg" style="margin-top: 16px; font-size: 13px; color: var(--color-primary);">Waiting for scan...</p>
      </div>
      <div class="confirm-dialog-footer" style="justify-content: center; margin-top: 24px;">
        <button class="btn-primary" id="qr-close-btn">Cancel</button>
      </div>
    `;

    document.body.appendChild(dialog);
    this._closeActiveSubDialog(); // Ensure any existing dialog is closed first
    this._activeSubDialog = dialog;
    dialog.showModal();

    let isPolling = true;
    let pollTimer = null;

    const close = async (success = false) => {
      isPolling = false;
      if (pollTimer) clearTimeout(pollTimer);
      dialog.close();
      setTimeout(() => dialog.remove(), 200);
      if (this._activeSubDialog === dialog) {
        this._activeSubDialog = null;
        this._activeSubDialogCloseFn = null;
      }
      if (!success) {
        try {
          await this.stateController.toggleServerEnabled(serverId, false);
          if (this.isOpen) await this._renderContent();
        } catch (e) {}
      }
    };
    this._activeSubDialogCloseFn = () => close(false);

    const closeBtn = dialog.querySelector('#qr-close-btn');
    closeBtn.addEventListener('click', () => close(false));

    const pollStatus = async () => {
      if (!isPolling || !this.isOpen) return;
      try {
        const authRes = await this.stateController.executeTool(serverId, 'whatsapp_check_auth');
        const authText = this._extractToolText(authRes);
        
        if (authText.includes('Authenticated successfully')) {
          const statusEl = dialog.querySelector('#qr-status-msg');
          if (statusEl) {
            statusEl.textContent = 'Connected successfully!';
            statusEl.style.color = 'var(--color-success)';
          }
          Toast.success('WhatsApp connected!', 3000);
          setTimeout(() => close(true), 1500);
          return; // stop polling
        } else if (authText.includes('Not authenticated')) {
          // Fetch fresh QR code to prevent expiration
          const qrRes = await this.stateController.executeTool(serverId, 'whatsapp_get_qr');
          const qrText = this._extractToolText(qrRes);
          if (qrText.includes('QR_CODE_DATA:')) {
            const newBase64 = qrText.split('QR_CODE_DATA:')[1].trim();
            const imgEl = dialog.querySelector('img');
            if (imgEl && newBase64 && newBase64 !== imgEl.src) {
              imgEl.src = newBase64;
            }
          }
        }
      } catch (err) {
        // Ignore transient errors during polling
      }
      
      if (isPolling) {
        pollTimer = setTimeout(pollStatus, 3000);
      }
    };
    
    // Start polling after 3 seconds
    pollTimer = setTimeout(pollStatus, 3000);
  }

  async _handleDiscoverInstall(server) {
    const prefill = this.stateController.prepareDiscoverInstall(server);

    if (prefill.isKeyless && prefill.isLocal) {
      try {
        const confirmed = await ConfirmDialog.confirm({
          title: 'Install Keyless MCP Server',
          message: `Install and start ${prefill.display_name}? This runs locally without requiring API keys.`,
          confirmText: 'Install & Start'
        });
        
        if (confirmed && this.isOpen) {
          Toast.info(`Installing ${prefill.display_name}...`);
          // Extract just the valid API fields
          const { isKeyless, isLocal, ...formData } = prefill;
          const serverData = await this.stateController.registerServer(formData);
          if (!this.isOpen) return;
          
          if (formData.auto_start && serverData && serverData.status === 'error') {
            Toast.warning(`Installed, but failed to start: ${serverData.error_message || 'Unknown error'}`, 5000);
          } else {
            Toast.success(`Successfully installed ${prefill.display_name}`);
          }
          this.stateController.activeTab = 'my-servers';
          await this._renderContent();
        }
      } catch (err) {
        this.log.error('[MCPManagementModal] 1-Click Install Failed:', err);
        if (!this.isOpen) return;
        Toast.error(`Install failed: ${err.message || 'Unknown error'}`);
      }
    } else {
      this.stateController.isRegistering = true;
      this.stateController.editingServerId = null;
      this.stateController.setDiscoverPreFillData(prefill);
      this.stateController.activeTab = 'my-servers';
      this.renderers.render();
    }
  }

  _handleDiscoverTabClick() {
    this.stateController.activeTab = 'discover';
    this.renderers.render();
    if (this.stateController.discoverServers.length === 0) {
      this._handleRetryDiscover();
    }
  }

  _handleMyServersTabClick() {
    this.stateController.activeTab = 'my-servers';
    this.renderers.render();
  }

  async _handleRetryDiscover() {
    const fetchPromise = this.stateController.fetchDiscoverServers();
    this.renderers.render(); // Show loading state
    await fetchPromise;
    if (!this.isOpen) return;
    this.renderers.render(); // Render results
  }

  _handleCancelForm() {
    this.stateController.isRegistering = false;
    this.stateController.editingServerId = null;
    this.renderers.render();
  }

  async _handleSubmitForm() {
    if (this.stateController.editingServerId) {
      await this._handleUpdateSubmit();
    } else {
      await this._handleRegisterSubmit();
    }
  }

  async _handleRegisterSubmit() {
    const res = this.renderers.collectFormData(false);
    if (!res.valid) {
      if (res.errorMsg) Toast.warning(res.errorMsg);
      return;
    }
    
    try {
      const submitBtn = this.bodyEl.querySelector('#submit-btn');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Registering...';
      }
      
      const formData = res.data;
      const serverData = await this.stateController.registerServer(formData);
      if (!this.isOpen) return;
      
      if (formData.auto_start && serverData && serverData.status === 'error') {
        Toast.warning(`Registered, but failed to start: ${serverData.error_message || 'Unknown error'}`, 5000);
      }
      
      this.stateController.isRegistering = false;
      await this._renderContent();
    } catch (error) {
      this.log.error('[MCPManagementModal] Failed to register server:', error);
      if (!this.isOpen) return;
      Toast.error(`Failed to register server: ${error.message || 'Unknown error'}`);
      
      const submitBtn = this.bodyEl.querySelector('#submit-btn');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Register & Start';
      }
    }
  }

  async _handleUpdateSubmit() {
    const res = this.renderers.collectFormData(true);
    if (!res.valid) {
      if (res.errorMsg) Toast.warning(res.errorMsg);
      return;
    }
    
    try {
      const submitBtn = this.bodyEl.querySelector('#submit-btn');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Updating...';
      }
      
      const formData = res.data;
      const updatePayload = {
        display_name: formData.display_name,
        description: formData.description,
        config: formData.config,
        auto_start: formData.auto_start,
        enabled: formData.enabled,
        sandbox_enabled: formData.sandbox_enabled,
        resource_limits: formData.resource_limits
      };
      
      await this.stateController.updateServer(this.stateController.editingServerId, updatePayload);
      if (!this.isOpen) return;
      
      this.stateController.editingServerId = null;
      await this._renderContent();
    } catch (error) {
      this.log.error('[MCPManagementModal] Failed to update server:', error);
      if (!this.isOpen) return;
      Toast.error(`Failed to update server: ${error.message || 'Unknown error'}`);
      
      const submitBtn = this.bodyEl.querySelector('#submit-btn');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Update Server';
      }
    }
  }
}

module.exports = MCPManagementModal;
