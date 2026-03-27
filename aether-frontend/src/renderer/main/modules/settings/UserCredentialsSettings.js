/**
 * User Credentials Settings Module
 * 
 * Manages user-provided API keys and OAuth tokens (Google, Gmail, Outlook, Weather, etc.)
 * 
 * @.architecture
 * Incoming: main-renderer.js, UIManager, SettingsManager --- {User interactions, settings modal open}
 * Processing: Load credentials list, save/delete credentials, mask values --- {JOB_LOAD_CREDENTIALS, JOB_SAVE_CREDENTIAL, JOB_DELETE_CREDENTIAL}
 * Outgoing: Backend API (/v1/user-credentials/*), DOM (settings panel), Toast notifications --- {HTTP requests, UI updates, notifications}
 */

const Toast = require('../../../shared/components/Toast');
const { createRendererLogger } = require('../../../shared/utils/logger');

class UserCredentialsSettings {
    constructor() {
        this.log = createRendererLogger('UserCredentialsSettings');
        // State
        this._credentials = [];
        this._isLoading = false;
        
        // DOM elements
        this._containerEl = null;
        
        // Lifecycle flags
        this._isInitialized = false;
        this._isDisposed = false;
        
        // Resource tracking
        this._listeners = [];
        this._abortControllers = [];
        
        this.log.debug('[UserCredentialsSettings] Instance created');
    }

    /**
     * Initialize the user credentials settings module
     * @param {HTMLElement} container - Container element to render credentials UI
     * @param {Object} [apiClient] - Optional API client for making requests
     */
    async initialize(container, apiClient = null) {
        if (this._isInitialized || this._isDisposed) return;
        
        if (!container) {
            throw new Error('[UserCredentialsSettings] Container element is required');
        }
        
        if (apiClient) {
            this._apiClient = apiClient;
        }
        
        try {
            this._containerEl = container;
            this._containerEl.className = 'user-credentials-wrapper';
            
            // Load and render
            await this.loadCredentials();
            this._renderCredentialsUI();
            
            this._isInitialized = true;
            this.log.debug('[UserCredentialsSettings] Initialized');
        } catch (error) {
            this.log.error('[UserCredentialsSettings] Initialization failed:', error);
            Toast.error('Failed to load credentials');
        }
    }

    /**
     * Load credentials metadata from backend

     */
    async loadCredentials() {
        if (this._isLoading) return;
        this._isLoading = true;
        
        try {
            const controller = new AbortController();
            this._abortControllers.push(controller);
            
            const data = await this._apiClient.get('/v1/user-credentials/list', {
                signal: controller.signal
            });
            
            this._credentials = data.credentials || [];
        } catch (error) {
            if (error.name === 'AbortError' || error.isAbortError) return;
            this.log.error('[UserCredentialsSettings] Load failed:', error);
            throw error;
        } finally {
            this._isLoading = false;
        }
    }
    
    /**
     * Render credentials UI
     * @private
     */
    _renderCredentialsUI() {
        if (!this._containerEl) return;
        
        // Cleanup existing listeners before re-rendering
        this._cleanupListeners();
        
        // Proper disposal of DOM nodes without unsafe innerHTML wiping
        while (this._containerEl.firstChild) {
            this._containerEl.removeChild(this._containerEl.firstChild);
        }
        
        // Grouping logic
        const categories = {
            'LLM Providers': ['openai_api_key', 'anthropic_api_key'],
            'Email': ['google_oauth_token', 'gmail_api_key', 'outlook_oauth_token', 'outlook_api_key'],
            'Other Services': ['weather_api_key']
        };
        
        for (const [name, keys] of Object.entries(categories)) {
            const items = this._credentials.filter(c => keys.includes(c.credential_key));
            if (items.length === 0) continue;
            
            const section = document.createElement('div');
            section.className = 'credential-category';
            section.innerHTML = `<div class="category-title">${name}</div>`;
            
            items.forEach(credential => {
                const card = this._createCredentialCard(credential);
                section.appendChild(card);
            });
            
            this._containerEl.appendChild(section);
        }
    }
    
    /**
     * Create a credential card element
     * @private
     */
    _createCredentialCard(credential) {
        const card = document.createElement('div');
        card.className = `credential-card ${credential.is_configured ? 'configured' : ''}`;
        
        const badgeClass = credential.is_configured ? 'badge-success' : 'badge-info';
        const badgeText = credential.is_configured ? 'Configured' : 'Not Set';
        const name = this._formatCredentialName(credential.credential_key);
        const safeName = this._escapeHtml(name);
        const safeDescription = this._escapeHtml(credential.description || 'Secure encrypted storage.');
        const safeCredentialKey = this._escapeHtml(credential.credential_key || '');
        
        card.innerHTML = `
            <div class="credential-info">
                <div class="credential-header">
                    <span class="credential-name">${safeName}</span>
                    <span class="badge ${badgeClass}">${badgeText}</span>
                </div>
                <div class="credential-desc">${safeDescription}</div>
            </div>
            <div class="credential-actions">
                ${credential.is_configured ? 
                    `<button class="btn-premium-link danger btn-delete" data-key="${safeCredentialKey}" aria-label="Delete ${safeName}">Delete</button>` : ''
                }
                <button class="btn-premium-link btn-set" data-key="${safeCredentialKey}" aria-label="${credential.is_configured ? 'Update' : 'Set'} ${safeName}">
                    ${credential.is_configured ? 'Update' : 'Set'}
                </button>
            </div>
        `;
        
        // Attach functional listeners
        const setBtn = card.querySelector('.btn-set');
        if (setBtn) {
            const handler = () => this._showCredentialModal(credential);
            setBtn.addEventListener('click', handler);
            this._listeners.push({ element: setBtn, event: 'click', handler });
        }
        
        const delBtn = card.querySelector('.btn-delete');
        if (delBtn) {
            const handler = () => this._deleteCredential(credential.credential_key);
            delBtn.addEventListener('click', handler);
            this._listeners.push({ element: delBtn, event: 'click', handler });
        }
        
        return card;
    }
    
    /**
     * Show modal to configure a credential
     * @private
     */
    _showCredentialModal(credential) {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        
        const name = this._formatCredentialName(credential.credential_key);
        const safeName = this._escapeHtml(name);
        const safeDescription = this._escapeHtml(credential.description || 'Enter your value below. It will be encrypted at rest.');
        const inputType = credential.credential_key.includes('token') ? 'Token' : 'API Key';
        
        modal.innerHTML = `
            <div class="modal-panel modal-panel--sm modal-panel--h-auto">
                <div class="modal-header">
                    <h3 class="modal-title">Configure ${safeName}</h3>
                    <button class="modal-close" id="btn-modal-close">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                </div>
                <div class="modal-body">
                    <p class="credential-modal-desc">${safeDescription}</p>
                    <div class="credential-modal-field">
                        <label class="credential-modal-label">${inputType}</label>
                        <input type="password" class="input" id="credential-input" placeholder="Paste value here..." autofocus>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn-premium-link danger" id="btn-modal-cancel">Cancel</button>
                    <button class="btn-premium-link" id="btn-modal-save">Save ${inputType}</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        const input = modal.querySelector('#credential-input');
        const saveBtn = modal.querySelector('#btn-modal-save');
        const cancelBtn = modal.querySelector('#btn-modal-cancel');
        const closeBtn = modal.querySelector('#btn-modal-close');
        
        const close = () => {
            modal.classList.add('hidden');
            setTimeout(() => modal.remove(), 300);
        };
        
        cancelBtn.onclick = close;
        closeBtn.onclick = close;
        modal.onclick = (e) => { if (e.target === modal) close(); };
        
        saveBtn.onclick = async () => {
            const val = input.value.trim();
            if (!val) {
                Toast.warning('Value is required');
                return;
            }
            
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
            
            try {
                await this._saveCredential(credential.credential_key, val);
                close();
                await this.loadCredentials();
                this._renderCredentialsUI();
            } catch (e) {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
            }
        };
        
        input.onkeydown = (e) => {
            if (e.key === 'Enter') saveBtn.click();
            if (e.key === 'Escape') close();
        };
        
        setTimeout(() => input.focus(), 50);
    }
    
    /**
     * Save a credential to backend
     * @private
     */
    async _saveCredential(key, value) {
        await this._apiClient.post('/v1/user-credentials/save', {
            credential_key: key,
            credential_value: value
        });
        
        Toast.success('Credential encrypted and saved');
    }
    
    /**
     * Delete a credential
     * @private
     */
    async _deleteCredential(key) {
        if (!confirm(`Permanently delete ${this._formatCredentialName(key)}?`)) return;
        
        try {
            await this._apiClient.delete(`/v1/user-credentials/${key}`);
            
            Toast.success('Credential removed');
            await this.loadCredentials();
            this._renderCredentialsUI();
        } catch (e) {
            Toast.error('Failed to delete');
        }
    }
    
    _formatCredentialName(key) {
        return key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }
    
    _cleanupListeners() {
        this._listeners.forEach(({ element, event, handler }) => {
            element?.removeEventListener(event, handler);
        });
        this._listeners = [];
    }
    
    dispose() {
        if (this._isDisposed) return;
        this._cleanupListeners();
        this._abortControllers.forEach(c => c.abort());
        this._containerEl = null;
        this._isDisposed = true;
    }
}

module.exports = new UserCredentialsSettings();
