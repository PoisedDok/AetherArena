/**
 * LLM Provider Settings Module
 * 
 * Smart LLM provider configuration with auto-detection and model discovery.
 * 
 * @.architecture
 * Incoming: main-renderer.js, UIManager --- {User interactions, settings modal open}
 * Processing: Auto-detect providers (LM Studio, Ollama), fetch models, save config --- {JOB_AUTO_DETECT, JOB_FETCH_MODELS, JOB_SAVE_CONFIG}
 * Outgoing: Backend API (/v1/llm-providers/*), DOM (settings panel), Toast notifications --- {HTTP requests, UI updates, notifications}
 */

const Toast = require('../../../shared/components/Toast');
const { createRendererLogger } = require('../../../shared/utils/logger');

class LLMProviderSettings {
    constructor(options = {}) {
        this.log = createRendererLogger('LLMProviderSettings');
        this.endpoint = options.endpoint || null;
        // State
        this._providers = [];
        this._currentConfig = null;
        this._availableModels = [];
        this._isLoading = false;
        
        // DOM elements
        this._providerSelect = null;
        this._urlInput = null;
        this._modelSelect = null;
        this._modelHelp = null;
        this._refreshBtn = null;
        
        // Lifecycle flags
        this._isInitialized = false;
        this._isDisposed = false;
        
        // Resource tracking
        this._listeners = [];
        this._timers = [];
        this._abortControllers = [];
        
        // Inference panel state
        this._inferenceListenersAttached = false;
        this._inferenceTimer = null;
        this._inferenceStatus = null;
        
        this.log.debug('[LLMProviderSettings] Instance created');
    }
    
    /**
     * Initialize the LLM provider settings module
     */
    async initialize() {
        if (this._isInitialized || this._isDisposed) return;
        
        try {
            this._gatherElements();
            this._setupEventListeners();
            
            // Auto-discover providers on init
            await this.discoverProviders();
            
            // Load current config
            await this.loadCurrentConfig();
            
            this._isInitialized = true;
            this.log.debug('[LLMProviderSettings] Initialized successfully');
        } catch (error) {
            this.log.error('[LLMProviderSettings] Initialization failed:', error);
            Toast.error('Failed to initialize LLM provider settings');
        }
    }
    
    /**
     * Gather DOM elements
     * @private
     */
    _gatherElements() {
        this._providerSelect = document.getElementById('llm-provider');
        this._urlInput = document.getElementById('llm-api-base');
        this._modelSelect = document.getElementById('llm-model');
        this._modelHelp = document.getElementById('llm-model-help');
        
        if (!this._providerSelect || !this._urlInput || !this._modelSelect) {
            throw new Error('Required DOM elements not found');
        }
        
        this.log.debug('[LLMProviderSettings] DOM elements gathered');
    }
    
    /**
     * Setup event listeners
     * @private
     */
    _setupEventListeners() {
        // Provider selection change
        const providerHandler = async (e) => {
            const selectedKey = e.target.value;
            const provider = this._providers.find(p => p.key === selectedKey);
            
            if (provider) {
                // Update URL input with provider's URL
                this._urlInput.value = provider.url;
                
                // If provider is available and has models, populate them
                if (provider.available && provider.models.length > 0) {
                    this._populateModels(provider.models);
                } else {
                    // Fetch models for this provider
                    await this.fetchModels(provider.url, provider.key);
                }
            }
            
            // Show/hide inference inline panel
            this._toggleInferencePanel(selectedKey === 'aether_inference');
        };
        this._providerSelect.addEventListener('change', providerHandler);
        
        // URL input change (debounced)
        this._urlDebounceTimer = null;
        const urlHandler = () => {
            if (this._urlDebounceTimer) {
                clearTimeout(this._urlDebounceTimer);
            }
            
            this._urlDebounceTimer = setTimeout(async () => {
                const url = this._urlInput.value.trim();
                const providerKey = this._providerSelect.value || 'custom_openai';
                
                if (url) {
                    await this.fetchModels(url, providerKey);
                }
            }, 800);
        };
        this._urlInput.addEventListener('input', urlHandler);
        
        // Model selection change
        const modelHandler = () => {
            const selectedModel = this._modelSelect.value;
            if (selectedModel) {
                this._modelHelp.textContent = `Selected: ${selectedModel}`;
                this._modelHelp.className = 'form-help form-help--success';
            }
        };
        this._modelSelect.addEventListener('change', modelHandler);
        
        // Track listeners for cleanup
        this._listeners.push(
            { element: this._providerSelect, event: 'change', handler: providerHandler },
            { element: this._urlInput, event: 'input', handler: urlHandler },
            { element: this._modelSelect, event: 'change', handler: modelHandler }
        );
        
        this.log.debug('[LLMProviderSettings] Event listeners attached');
    }
    
    /**
     * Discover available LLM providers via backend API
     */
    async discoverProviders() {
        if (this._isLoading) return;
        
        this._isLoading = true;
        this._updateProviderDropdown([], true);
        
        let controller;
        try {
            controller = new AbortController();
            this._abortControllers.push(controller);
            
            if (!this.endpoint) throw new Error('Endpoint not initialized');
            
            const providers = await this.endpoint.api.get('/v1/llm-providers/discover', {
                signal: controller.signal
            });
            
            this._providers = providers;
            
            this.log.debug('[LLMProviderSettings] Discovered providers:', providers);
            
            // Update UI with discovered providers
            this._updateProviderDropdown(providers);
            
            // Show notification for available providers
            const availableCount = providers.filter(p => p.available).length;
            if (availableCount > 0) {
                Toast.success(`Found ${availableCount} available LLM provider${availableCount > 1 ? 's' : ''}`);
            } else {
                Toast.info('No local LLM providers detected. Configure a custom provider below.');
            }
            
        } catch (error) {
            if (error.name === 'AbortError' || error.isAbortError) return;
            
            this.log.error('[LLMProviderSettings] Provider discovery failed:', error);
            Toast.error('Failed to discover LLM providers');
            
            // Fallback to basic provider list
            this._updateProviderDropdown([]);
            
        } finally {
            this._isLoading = false;
            // Prevent unbounded accumulator leak
            this._abortControllers = this._abortControllers.filter(c => c !== controller);
        }
    }
    
    /**
     * Update provider dropdown with discovered providers.
     * Preserves the currently selected provider when it exists in the new
     * list, so that AdvancedSettingsBinder's selection from llm.provider
     * is not lost when this module re-discovers providers.
     * @private
     */
    _updateProviderDropdown(providers, showLoading = false) {
        if (!this._providerSelect) return;
        
        // Capture current selection BEFORE clearing (AdvancedSettingsBinder
        // or loadCurrentConfig may have already set this).
        const previousValue = this._providerSelect.value;
        
        // Clear existing options
        this._providerSelect.innerHTML = '';
        
        if (showLoading) {
            const loadingOption = document.createElement('option');
            loadingOption.value = '';
            loadingOption.textContent = 'Discovering providers...';
            loadingOption.disabled = true;
            loadingOption.selected = true;
            this._providerSelect.appendChild(loadingOption);
            return;
        }
        
        if (providers.length === 0) {
            // Fallback to known providers
            const fallbackProviders = [
                { key: 'aether_inference', displayName: 'Aether Inference (Built-in)', url: 'http://127.0.0.1:7090/v1', available: false },
                { key: 'lmstudio', displayName: 'LM Studio', url: 'http://localhost:1234/v1', available: false },
                { key: 'ollama', displayName: 'Ollama', url: 'http://127.0.0.1:11434', available: false },
                { key: 'custom_openai', displayName: 'Custom OpenAI-Compatible', url: '', available: false }
            ];
            providers = fallbackProviders;
        }
        
        // Sort: available first, then alphabetically
        const sortedProviders = [...providers].sort((a, b) => {
            if (a.available !== b.available) return a.available ? -1 : 1;
            return a.displayName.localeCompare(b.displayName);
        });
        
        // Collect keys for restore check
        const providerKeys = sortedProviders.map(p => p.key);
        
        // Add providers to dropdown
        sortedProviders.forEach(provider => {
            const option = document.createElement('option');
            option.value = provider.key;
            
            // Highlight available providers
            if (provider.available) {
                option.textContent = `✓ ${provider.displayName} (Available)`;
                option.style.fontWeight = 'var(--font-weight-semibold)';
                option.style.color = 'var(--color-success)';
            } else {
                option.textContent = provider.displayName;
            }
            
            option.dataset.url = provider.url;
            option.dataset.available = provider.available;
            
            this._providerSelect.appendChild(option);
        });
        
        // Restore previous selection if it exists in the new provider list
        if (previousValue && providerKeys.includes(previousValue)) {
            this._providerSelect.value = previousValue;
        }
        
        this.log.debug('[LLMProviderSettings] Provider dropdown updated with', sortedProviders.length, 'providers');
    }
    
    /**
     * Fetch models from a specific provider URL
     */
    async fetchModels(providerUrl, providerKey) {
        if (!providerUrl) return;
        
        this._modelHelp.textContent = 'Fetching models...';
        this._modelHelp.className = 'form-help form-help--muted';
        this._modelSelect.disabled = true;
        
        let controller;
        try {
            controller = new AbortController();
            this._abortControllers.push(controller);
            
            if (!this.endpoint) throw new Error('Endpoint not initialized');
            
            const params = new URLSearchParams();
            params.set('provider_url', providerUrl);
            params.set('provider_key', providerKey);
            
            const data = await this.endpoint.api.get(`/v1/llm-providers/models?${params.toString()}`, {
                signal: controller.signal
            });
            
            this._availableModels = data.models || [];
            
            this.log.debug('[LLMProviderSettings] Fetched', this._availableModels.length, 'models from', providerUrl);
            
            this._populateModels(this._availableModels);
            
            if (this._availableModels.length > 0) {
                this._modelHelp.textContent = `Found ${this._availableModels.length} model${this._availableModels.length > 1 ? 's' : ''}`;
                this._modelHelp.className = 'form-help form-help--success';
            } else {
                this._modelHelp.textContent = 'No models found. Check provider URL.';
                this._modelHelp.className = 'form-help form-help--warning';
            }
            
        } catch (error) {
            if (error.name === 'AbortError' || error.isAbortError) return;
            
            this.log.error('[LLMProviderSettings] Model fetch failed:', error);
            this._modelHelp.textContent = 'Failed to fetch models. Check provider connection.';
            this._modelHelp.className = 'form-help form-help--error';
            
            this._populateModels([]);
            
        } finally {
            this._modelSelect.disabled = false;
            // Prevent unbounded accumulator leak
            this._abortControllers = this._abortControllers.filter(c => c !== controller);
        }
    }
    
    /**
     * Populate model dropdown.
     * Preserves the currently selected model when it exists in the new list,
     * so that AdvancedSettingsBinder's selection is not lost when this module
     * re-fetches models from a provider-specific endpoint.
     * @private
     */
    _populateModels(models) {
        if (!this._modelSelect) return;
        
        // Capture currently selected model BEFORE clearing the select.
        // AdvancedSettingsBinder may have already set this from llm.model.
        const previousValue = this._modelSelect.value;
        
        // Clear existing options
        this._modelSelect.innerHTML = '';
        
        if (models.length === 0) {
            const emptyOption = document.createElement('option');
            emptyOption.value = '';
            emptyOption.textContent = 'No models available';
            emptyOption.disabled = true;
            emptyOption.selected = true;
            this._modelSelect.appendChild(emptyOption);
            return;
        }
        
        // Add placeholder (not force-selected — previous value takes priority)
        const placeholderOption = document.createElement('option');
        placeholderOption.value = '';
        placeholderOption.textContent = 'Select a model...';
        placeholderOption.disabled = true;
        this._modelSelect.appendChild(placeholderOption);
        
        // Add models
        models.forEach(modelName => {
            const option = document.createElement('option');
            option.value = modelName;
            option.textContent = modelName;
            this._modelSelect.appendChild(option);
        });
        
        // Restore previous selection if it exists in the new model list.
        // This prevents AdvancedSettingsBinder's value from being lost.
        if (previousValue && models.includes(previousValue)) {
            this._modelSelect.value = previousValue;
        }
        
        this.log.debug('[LLMProviderSettings] Model dropdown populated with', models.length, 'models');
    }
    
    /**
     * Load current configuration from backend
     */
    async loadCurrentConfig() {
        let controller;
        try {
            controller = new AbortController();
            this._abortControllers.push(controller);
            
            if (!this.endpoint) throw new Error('Endpoint not initialized');
            
            const config = await this.endpoint.api.get('/v1/llm-providers/config', {
                signal: controller.signal
            });
            
            this._currentConfig = config;
            
            this.log.debug('[LLMProviderSettings] Loaded current config:', config);
            
            // Apply config to UI
            if (this._providerSelect) {
                this._providerSelect.value = config.provider_key || 'aether_inference';
            }
            
            if (this._urlInput) {
                this._urlInput.value = config.provider_url || 'http://127.0.0.1:7090/v1';
            }
            
            // Show/hide inference panel if aether_inference is the active provider
            this._toggleInferencePanel(config.provider_key === 'aether_inference');
            
            // If model is configured, fetch models and select it.
            // Capture the current model select value first — AdvancedSettingsBinder
            // may have already set it from llm.model during loadSettings().
            const previousModel = this._modelSelect ? this._modelSelect.value : '';
            if (config.model_name) {
                await this.fetchModels(config.provider_url, config.provider_key);
                if (this._modelSelect) {
                    this._modelSelect.value = config.model_name;
                    // If config.model_name didn't match any option (value reset to ''),
                    // fall back to the model that AdvancedSettingsBinder already selected.
                    if (!this._modelSelect.value && previousModel) {
                        this._modelSelect.value = previousModel;
                    }
                }
            }
            
        } catch (error) {
            if (error.name === 'AbortError' || error.isAbortError) return;
            
            this.log.error('[LLMProviderSettings] Failed to load config:', error);
            // Don't show error notification - just use defaults
        } finally {
            // Prevent unbounded accumulator leak
            this._abortControllers = this._abortControllers.filter(c => c !== controller);
        }
    }
    
    /**
     * Save configuration to backend
     */
    async saveConfiguration() {
        const providerKey = this._providerSelect?.value;
        const providerUrl = this._urlInput?.value?.trim();
        const modelName = this._modelSelect?.value;
        
        if (!providerKey || !providerUrl) {
            Toast.warning('Please select a provider and enter a URL');
            return false;
        }
        
        let controller;
        try {
            controller = new AbortController();
            this._abortControllers.push(controller);
            
            if (!this.endpoint) throw new Error('Endpoint not initialized');
            
            const savedConfig = await this.endpoint.api.post('/v1/llm-providers/config', {
                provider_key: providerKey,
                provider_url: providerUrl,
                model_name: modelName || null
            }, {
                signal: controller.signal
            });
            
            this._currentConfig = savedConfig;
            
            this.log.debug('[LLMProviderSettings] Configuration saved:', savedConfig);
            Toast.success('LLM provider configuration saved');
            
            return true;
            
        } catch (error) {
            if (error.name === 'AbortError' || error.isAbortError) return false;
            
            this.log.error('[LLMProviderSettings] Failed to save config:', error);
            Toast.error('Failed to save LLM provider configuration');
            return false;
        } finally {
            // Prevent unbounded accumulator leak
            this._abortControllers = this._abortControllers.filter(c => c !== controller);
        }
    }
    
    /**
     * Get current configuration data (for SettingsManager integration)
     */
    getCurrentConfiguration() {
        return {
            provider_key: this._providerSelect?.value || '',
            provider_url: this._urlInput?.value?.trim() || '',
            model_name: this._modelSelect?.value || null
        };
    }
    
    // =========================================================================
    // Aether Inference inline panel (shown when aether_inference provider selected)
    // =========================================================================
    
    /**
     * Show/hide the inference management panel
     * @private
     */
    _toggleInferencePanel(show) {
        const panel = document.getElementById('inference-inline-panel');
        if (!panel) return;
        
        panel.style.display = show ? '' : 'none';
        
        if (show) {
            this._setupInferenceListeners();
            this._refreshInferenceStatus();
        } else {
            this._clearInferencePolling();
        }
    }
    
    /**
     * Setup inference panel event listeners (idempotent)
     * @private
     */
    _setupInferenceListeners() {
        if (this._inferenceListenersAttached) return;
        this._inferenceListenersAttached = true;
        
        const enabledToggle = document.getElementById('inference-enabled-toggle');
        const startStopBtn = document.getElementById('inference-start-stop-btn');
        const refreshBtn = document.getElementById('inference-refresh-btn');
        const pullBtn = document.getElementById('inference-pull-btn');
        
        // Enable/disable toggle (persists preference + starts/stops server)
        if (enabledToggle) {
            const handler = (e) => this._inferenceHandleEnabledToggle(e.target.checked);
            enabledToggle.addEventListener('change', handler);
            this._listeners.push({ element: enabledToggle, event: 'change', handler });
        }
        if (startStopBtn) {
            const handler = () => this._inferenceToggleStartStop();
            startStopBtn.addEventListener('click', handler);
            this._listeners.push({ element: startStopBtn, event: 'click', handler });
        }
        if (refreshBtn) {
            const handler = () => this._refreshInferenceStatus();
            refreshBtn.addEventListener('click', handler);
            this._listeners.push({ element: refreshBtn, event: 'click', handler });
        }
        if (pullBtn) {
            const handler = () => this._inferencePullModel();
            pullBtn.addEventListener('click', handler);
            this._listeners.push({ element: pullBtn, event: 'click', handler });
        }
        
        // Poll status every 15s while panel is visible
        this._inferenceTimer = setInterval(() => {
            const panel = document.getElementById('inference-inline-panel');
            if (panel && panel.style.display !== 'none') {
                this._refreshInferenceStatus();
            }
        }, 15000);
        this._timers.push({ id: this._inferenceTimer, type: 'interval' });
    }
    
    /**
     * Clear inference polling timer
     * @private
     */
    _clearInferencePolling() {
        if (this._inferenceTimer) {
            clearInterval(this._inferenceTimer);
            this._timers = this._timers.filter(t => t.id !== this._inferenceTimer);
            this._inferenceTimer = null;
        }
    }
    
    /**
     * Refresh inference server status and update inline panel
     * @private
     */
    async _refreshInferenceStatus() {
        try {
            if (!this.endpoint) return;
            const status = await this.endpoint.api.get('/v1/inference/status');
            
            this._inferenceStatus = status;
            this._updateInferencePanel(status);
        } catch (e) {
            this.log.warn('[LLMProviderSettings] Inference status fetch failed:', e);
            const badge = document.getElementById('inference-status-badge');
            if (badge) {
                badge.textContent = 'Unavailable';
                badge.className = 'inference-badge badge-error';
            }
        }
    }
    
    /**
     * Update inference inline panel DOM from status data
     * @private
     */
    _updateInferencePanel(s) {
        const badge = document.getElementById('inference-status-badge');
        const engineLabel = document.getElementById('inference-engine-label');
        const gpuLabel = document.getElementById('inference-gpu-label');
        const startStopBtn = document.getElementById('inference-start-stop-btn');
        const pullSection = document.getElementById('inference-pull-section');
        const enabledToggle = document.getElementById('inference-enabled-toggle');
        const controlsSection = document.getElementById('inference-controls-section');
        const disabledMsg = document.getElementById('inference-disabled-msg');
        
        const isRunning = s.healthy || s.status === 'running';
        // user_enabled comes from backend status (persisted preference)
        const userEnabled = s.user_enabled !== undefined ? s.user_enabled : true;
        
        // Update toggle state (without triggering change event)
        if (enabledToggle && enabledToggle.checked !== userEnabled) {
            enabledToggle.checked = userEnabled;
        }
        
        // Controls section: ALWAYS visible if server is running (user needs Stop button),
        // or if toggle is enabled. Only hidden when disabled AND server is stopped.
        const showControls = userEnabled || isRunning;
        if (controlsSection) {
            controlsSection.style.display = showControls ? '' : 'none';
        }
        if (disabledMsg) {
            // Show disabled message only when toggle OFF and server NOT running
            disabledMsg.style.display = (!userEnabled && !isRunning) ? '' : 'none';
        }
        
        // Badge: reflects both toggle state and server state.
        // CRITICAL: preserve 'inference-badge' base class for styling.
        if (badge) {
            if (!userEnabled && isRunning) {
                badge.textContent = 'Running (auto-start off)';
                badge.className = 'inference-badge badge-warning';
            } else if (isRunning) {
                badge.textContent = 'Running';
                badge.className = 'inference-badge badge-running';
            } else if (!userEnabled) {
                badge.textContent = 'Disabled';
                badge.className = 'inference-badge badge-disabled';
            } else {
                badge.textContent = 'Stopped';
                badge.className = 'inference-badge badge-stopped';
            }
        }
        // Card accent: green left border when server is running
        const inferenceCard = document.getElementById('inference-inline-panel');
        if (inferenceCard) {
            inferenceCard.classList.toggle('is-running', isRunning);
        }
        if (engineLabel) {
            engineLabel.textContent = s.engine_display || s.engine || '\u2014';
        }
        if (gpuLabel && s.platform) {
            const gpu = s.platform.gpu_name || s.platform.gpu || '\u2014';
            const mem = s.platform.gpu_memory_gb ? ` (${Math.round(s.platform.gpu_memory_gb)}GB)` : '';
            gpuLabel.textContent = `${gpu}${mem}`;
        }
        if (startStopBtn) {
            // Show Stop when running (always, regardless of toggle).
            // Show Start only when toggle is enabled and server is stopped.
            if (isRunning) {
                startStopBtn.textContent = 'Stop';
                startStopBtn.className = 'btn btn-danger';
                startStopBtn.style.display = '';
            } else if (userEnabled) {
                startStopBtn.textContent = 'Start';
                startStopBtn.className = 'btn btn-success';
                startStopBtn.style.display = '';
            } else {
                // Disabled + stopped: hide start button
                startStopBtn.style.display = 'none';
            }
        }
        if (pullSection) {
            // Download only when running AND enabled
            pullSection.style.display = (isRunning && userEnabled) ? '' : 'none';
        }
    }
    
    /**
     * Toggle inference server start/stop
     * @private
     */
    async _inferenceToggleStartStop() {
        const isRunning = this._inferenceStatus && (this._inferenceStatus.healthy || this._inferenceStatus.status === 'running');
        const path = isRunning ? '/v1/inference/stop' : '/v1/inference/start';
        const btn = document.getElementById('inference-start-stop-btn');
        
        let controller;
        try {
            controller = new AbortController();
            this._abortControllers.push(controller);
            
            if (btn) {
                btn.disabled = true;
                btn.textContent = isRunning ? 'Stopping...' : 'Starting...';
            }
            
            if (!this.endpoint) throw new Error('Endpoint not initialized');
            
            await this.endpoint.api.post(path, undefined, { signal: controller.signal });
            if (this._isDisposed) return;
            
            Toast.success(isRunning ? 'Inference server stopped' : 'Inference server started');
        } catch (e) {
            if (e.name === 'AbortError' || e.isAbortError) return;
            if (this._isDisposed) return;
            Toast.error(e.body?.detail || 'Action failed');
        } finally {
            if (this._isDisposed) return;
            if (btn) btn.disabled = false;
            await this._refreshInferenceStatus();
            this._abortControllers = this._abortControllers.filter(c => c !== controller);
        }
    }
    
    /**
     * Handle the enable/disable toggle for inference server.
     * Persists preference via /v1/preferences/inference_enabled + starts or stops server.
     * @private
     */
    async _inferenceHandleEnabledToggle(enabled) {
        const toggle = document.getElementById('inference-enabled-toggle');
        
        let controller;
        try {
            controller = new AbortController();
            this._abortControllers.push(controller);
            
            if (!this.endpoint) throw new Error('Endpoint not initialized');
            
            // 1. Persist the preference
            await this.endpoint.api.post('/v1/preferences/inference_enabled', { value: enabled }, { signal: controller.signal });
            if (this._isDisposed) return;
            
            // 2. Start or stop the server immediately
            if (enabled) {
                try {
                    await this.endpoint.api.post('/v1/inference/start', undefined, { signal: controller.signal });
                    if (this._isDisposed) return;
                    Toast.success('Inference server enabled and starting');
                } catch (err) {
                    if (err.name === 'AbortError' || err.isAbortError) throw err;
                    if (this._isDisposed) return;
                    Toast.warning(err.body?.detail || 'Server enabled but failed to start — check venv setup');
                }
            } else {
                try {
                    await this.endpoint.api.post('/v1/inference/stop', undefined, { signal: controller.signal });
                    if (this._isDisposed) return;
                    Toast.success('Inference server disabled and stopped');
                } catch (err) {
                    if (err.name === 'AbortError' || err.isAbortError) throw err;
                    if (this._isDisposed) return;
                    Toast.info('Inference server disabled (was not running)');
                }
            }
        } catch (e) {
            if (e.name === 'AbortError' || e.isAbortError) return;
            if (this._isDisposed) return;
            this.log.error('[LLMProviderSettings] Inference toggle failed:', e);
            Toast.error('Failed to toggle inference server');
            // Revert toggle on failure
            if (toggle) toggle.checked = !enabled;
            // Force a full UI refresh to sync dependent elements on failure
            if (this._inferenceStatus) {
                this._updateInferencePanel(this._inferenceStatus);
            }
        } finally {
            if (this._isDisposed) return;
            // 3. Refresh status to update panel
            await this._refreshInferenceStatus();
            this._abortControllers = this._abortControllers.filter(c => c !== controller);
        }
    }
    
    /**
     * Pull/download a model via inference API
     * @private
     */
    async _inferencePullModel() {
        const input = document.getElementById('inference-pull-input');
        const model = input?.value?.trim();
        if (!model) {
            Toast.warning('Enter a model name');
            return;
        }
        
        const btn = document.getElementById('inference-pull-btn');
        let controller;
        try {
            controller = new AbortController();
            this._abortControllers.push(controller);
            
            if (btn) {
                btn.disabled = true;
                btn.textContent = 'Downloading...';
            }
            
            if (!this.endpoint) throw new Error('Endpoint not initialized');
            
            const result = await this.endpoint.api.post('/v1/inference/models/pull', { model }, { signal: controller.signal });
            if (this._isDisposed) return;
            
            if (result.status === 'complete') {
                Toast.success(`Model "${model}" downloaded`);
                // Refresh models list
                const provider = this._providers.find(p => p.key === 'aether_inference');
                if (provider) await this.fetchModels(provider.url, provider.key);
            } else if (result.status === 'error') {
                Toast.error(`Download failed: ${result.error}`);
            } else {
                Toast.info('Download started — check back shortly');
            }
        } catch (e) {
            if (e.name === 'AbortError' || e.isAbortError) return;
            if (this._isDisposed) return;
            Toast.error('Download failed');
        } finally {
            if (this._isDisposed) return;
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Download';
            }
            await this._refreshInferenceStatus();
            this._abortControllers = this._abortControllers.filter(c => c !== controller);
        }
    }
    
    /**
     * Dispose and cleanup resources
     */
    dispose() {
        if (this._isDisposed) return;
        this._clearInferencePolling();
        
        if (this._urlDebounceTimer) {
            clearTimeout(this._urlDebounceTimer);
            this._urlDebounceTimer = null;
        }
        
        // Abort all ongoing requests
        for (const controller of this._abortControllers) {
            try {
                controller.abort();
            } catch (e) {
                // Ignore abort errors
            }
        }
        this._abortControllers = [];
        
        // Clear timers
        for (const { id, type } of this._timers) {
            if (type === 'interval') clearInterval(id);
            else clearTimeout(id);
        }
        this._timers = [];
        
        // Remove event listeners
        for (const { element, event, handler } of this._listeners) {
            element?.removeEventListener(event, handler);
        }
        this._listeners = [];
        
        // Clear references
        this._providers = [];
        this._availableModels = [];
        this._currentConfig = null;
        this._providerSelect = null;
        this._urlInput = null;
        this._modelSelect = null;
        this._modelHelp = null;
        
        // Reset inference state
        this._inferenceListenersAttached = false;
        this._inferenceStatus = null;
        this._inferenceTimer = null;
        
        // Reset flags
        this._isInitialized = false;
        this._isDisposed = true;
        
        this.log.debug('[LLMProviderSettings] Disposed');
    }
}

// Export class
module.exports = LLMProviderSettings;
