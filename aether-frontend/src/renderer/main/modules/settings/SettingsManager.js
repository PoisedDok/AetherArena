'use strict';

/**
 * @.architecture
 * 
 * Incoming: main-renderer.js, Endpoint.getSettings()/setSettings()/getProfiles()/getModels()/getServicesStatus() --- {Settings objects: llm/interpreter/security/database/monitoring/memory/storage/integrations, Profile arrays, Model arrays, Service status}
 * Processing: Load/validate/populate/save full settings stack (LLM, Interpreter, Security, Database, Monitoring, Memory, Storage, Integrations, Advanced), manage form state across 8 tabs, handle errors, security validation, service status display --- {11 jobs: data_validation, error_handling, form_population, form_collection, security_validation, state_management, dropdown_management, backend_communication, service_monitoring, settings_application, immediate_reload}
 * Outgoing: DOM updates (form elements across 8 tabs), Endpoint API calls (GET /v1/settings, PATCH /v1/settings, GET /v1/services/status), settings-updated events, model indicator refresh --- {HTMLElements, HTTP requests, CustomEvent}
 */

class SettingsManager {
  constructor(endpoint) {
    if (!endpoint) {
      throw new Error('[SettingsManager] Endpoint required');
    }
    
    this.endpoint = endpoint;
    this.currentSettings = null;
    this.isLoading = false;
    this.formElements = {};
    this.validators = {
      url: /^https?:\/\/.+/,
      temperature: /^0(\.\d+)?$|^1(\.0+)?$/,
      maxTokens: /^\d+$/
    };
    
    this._cacheElements();
  }
  
  _cacheElements() {
    this.formElements = {
      status: document.getElementById('settings-status'),
      profile: document.getElementById('oi-profile'),
      profileHelp: document.getElementById('oi-profile-help'),
      provider: document.getElementById('llm-provider'),
      apiBase: document.getElementById('llm-api-base'),
      model: document.getElementById('llm-model'),
      modelHelp: document.getElementById('llm-model-help'),
      temperature: document.getElementById('llm-temperature'),
      maxTokens: document.getElementById('llm-max-tokens'),
      contextWindow: document.getElementById('llm-context-window'),
      autoRun: document.getElementById('interpreter-auto-run'),
      loop: document.getElementById('interpreter-loop'),
      safeMode: document.getElementById('interpreter-safe-mode'),
      offline: document.getElementById('interpreter-offline'),
      authEnabled: document.getElementById('security-auth-enabled'),
      rateLimitEnabled: document.getElementById('security-rate-limit'),
      corsEnabled: document.getElementById('security-cors-enabled')
    };
  }
  
  async loadSettings() {
    if (this.isLoading) return null;
    
    this.isLoading = true;
    this._setStatus('Loading...', 'info');
    
    try {
      const settings = await this.endpoint.getSettings();
      if (!settings) throw new Error('No settings returned from backend');
      
      console.log('[SettingsManager] Settings loaded');
      this.currentSettings = settings;
      await this.populateForm(settings);
      
      this._setStatus('Loaded successfully', 'success');
      setTimeout(() => this._clearStatus(), 2000);
      return settings;
      
    } catch (error) {
      console.error('[SettingsManager] Failed to load settings:', error);
      this._setStatus('Failed to load', 'error');
      setTimeout(() => this._clearStatus(), 3000);
      throw error;
    } finally {
      this.isLoading = false;
    }
  }
  
  /**
   * Populate form with settings
   * @param {Object} settings - Settings object
   */
  async populateForm(settings) {
    try {
      console.log('[SettingsManager] Populating form');
      
      if (settings.llm) await this._populateLLMSettings(settings.llm);
      if (settings.interpreter) await this._populateInterpreterSettings(settings.interpreter);
      if (settings.security) this._populateSecuritySettings(settings.security);
      if (settings.integrations) this._populateIntegrationSettings(settings.integrations);
      if (settings.database) this._populateDatabaseSettings(settings.database);
      if (settings.monitoring) this._populateMonitoringSettings(settings.monitoring);
      if (settings.memory) this._populateMemorySettings(settings.memory);
      if (settings.storage) this._populateStorageSettings(settings.storage);
      if (settings.llm && settings.interpreter) this._populateAdvancedSettings(settings.llm, settings.interpreter);
      
      console.log('[SettingsManager] Form populated');
    } catch (error) {
      console.error('[SettingsManager] Failed to populate form:', error);
      throw error;
    }
  }
  
  /**
   * Populate LLM settings section
   * @private
   */
  async _populateLLMSettings(llm) {
    // Provider
    if (this.formElements.provider && llm.provider) {
      this.formElements.provider.value = llm.provider;
    }
    
    // API Base
    if (this.formElements.apiBase && llm.api_base) {
      this.formElements.apiBase.value = llm.api_base;
    }
    
    // Temperature
    if (this.formElements.temperature && llm.temperature !== undefined) {
      this.formElements.temperature.value = llm.temperature;
    }
    
    // Max Tokens
    if (this.formElements.maxTokens && llm.max_tokens) {
      this.formElements.maxTokens.value = llm.max_tokens;
    }
    
    // Context Window
    if (this.formElements.contextWindow && llm.context_window) {
      this.formElements.contextWindow.value = llm.context_window;
    }
    
    // Load models dropdown
    await this._loadModels(llm.api_base, llm.model);
  }
  
  /**
   * Load models from API base
   * @private
   */
  async _loadModels(apiBase, currentModel) {
    const modelEl = this.formElements.model;
    const modelHelp = this.formElements.modelHelp;
    
    if (!modelEl) return;
    
    try {
      if (!apiBase) {
        modelEl.innerHTML = '<option value="">Select a model...</option>';
        if (modelHelp) modelHelp.textContent = 'Configure API base first';
        return;
      }
      
      // Show loading state
      modelEl.innerHTML = '<option value="">Loading models...</option>';
      modelEl.disabled = true;
      if (modelHelp) modelHelp.textContent = 'Loading...';
      
      console.log('[SettingsManager] Loading models from:', apiBase);
      
      // Get models from backend
      const response = await this.endpoint.getModels(apiBase);
      
      // Parse response - backend returns {models: [...], count: ...}
      const models = Array.isArray(response) ? response : (response.models || []);
      
      console.log('[SettingsManager] Loaded models:', models.length);
      
      // Populate dropdown
      modelEl.innerHTML = '<option value="">Select a model...</option>';
      
      if (models.length > 0) {
        models.forEach(model => {
          const option = document.createElement('option');
          option.value = model;
          option.textContent = model;
          modelEl.appendChild(option);
        });
        
        // Select current model if available
        if (currentModel && models.includes(currentModel)) {
          modelEl.value = currentModel;
        }
        
        if (modelHelp) {
          modelHelp.textContent = `${models.length} models available`;
          modelHelp.style.color = '';
        }
      } else {
        if (modelHelp) {
          modelHelp.textContent = 'No models found';
          modelHelp.style.color = '#fbbf24';
        }
      }
      
      modelEl.disabled = false;
      
    } catch (error) {
      console.error('[SettingsManager] Failed to load models:', error);
      
      modelEl.innerHTML = '<option value="">Failed to load models</option>';
      modelEl.disabled = false;
      
      if (modelHelp) {
        modelHelp.textContent = 'Failed to load models';
        modelHelp.style.color = '#ef4444';
      }
    }
  }
  
  /**
   * Populate interpreter settings section
   * @private
   */
  async _populateInterpreterSettings(interpreter) {
    // Boolean settings
    if (this.formElements.autoRun) {
      this.formElements.autoRun.checked = interpreter.auto_run || false;
    }
    
    if (this.formElements.loop) {
      this.formElements.loop.checked = interpreter.loop || false;
    }
    
    if (this.formElements.safeMode) {
      this.formElements.safeMode.checked = interpreter.safe_mode || false;
    }
    
    if (this.formElements.offline) {
      this.formElements.offline.checked = interpreter.offline || false;
    }
    
    // Load profiles dropdown
    await this._loadProfiles(interpreter.profile);
  }
  
  /**
   * Load profiles from backend
   * @private
   */
  async _loadProfiles(currentProfile) {
    const profileEl = this.formElements.profile;
    const profileHelp = this.formElements.profileHelp;
    
    if (!profileEl) return;
    
    try {
      // Show loading state
      profileEl.innerHTML = '<option value="">Loading profiles...</option>';
      profileEl.disabled = true;
      if (profileHelp) profileHelp.textContent = 'Loading...';
      
      console.log('[SettingsManager] Loading profiles...');
      
      // Get profiles from backend
      const response = await this.endpoint.getProfiles();
      
      // Parse response - backend returns {profiles: [{name, path, type, size_bytes}, ...], count: ...}
      let profiles = [];
      
      if (Array.isArray(response)) {
        // If response is already an array
        profiles = response;
      } else if (response.profiles && Array.isArray(response.profiles)) {
        // Extract profile names from objects
        profiles = response.profiles.map(p => p.name || p);
      }
      
      console.log('[SettingsManager] Loaded profiles:', profiles.length);
      
      // Populate dropdown
      profileEl.innerHTML = '<option value="">Select a profile...</option>';
      
      if (profiles.length > 0) {
        profiles.forEach(profile => {
          const option = document.createElement('option');
          option.value = profile;
          option.textContent = profile;
          profileEl.appendChild(option);
        });
        
        // Select current profile if available
        if (currentProfile) {
          profileEl.value = currentProfile;
        }
        
        if (profileHelp) {
          profileHelp.textContent = `${profiles.length} profiles available`;
          profileHelp.style.color = '';
        }
      } else {
        if (profileHelp) {
          profileHelp.textContent = 'No profiles found';
          profileHelp.style.color = '#fbbf24';
        }
      }
      
      profileEl.disabled = false;
      
    } catch (error) {
      console.error('[SettingsManager] Failed to load profiles:', error);
      
      profileEl.innerHTML = '<option value="">Failed to load profiles</option>';
      profileEl.disabled = false;
      
      if (profileHelp) {
        profileHelp.textContent = 'Failed to load profiles';
        profileHelp.style.color = '#ef4444';
      }
    }
  }
  
  /**
   * Populate security settings section
   * @private
   */
  _populateSecuritySettings(security) {
    if (this.formElements.authEnabled) {
      this.formElements.authEnabled.checked = security.auth_enabled || false;
    }
    
    if (this.formElements.rateLimitEnabled) {
      this.formElements.rateLimitEnabled.checked = security.rate_limit_enabled || false;
    }
    
    if (this.formElements.corsEnabled) {
      this.formElements.corsEnabled.checked = security.cors_allow_credentials || false;
    }
  }
  
  /**
   * Populate integration settings section
   * @private
   */
  _populateIntegrationSettings(integrations) {
    console.log('[SettingsManager] Integration settings:', integrations);

    const perplexicaEl = document.getElementById('integration-perplexica');
    const searxngEl = document.getElementById('integration-searxng');
    const doclingEl = document.getElementById('integration-docling');
    const xlwingsEl = document.getElementById('integration-xlwings');
    const mcpEl = document.getElementById('integration-mcp');

    if (perplexicaEl) perplexicaEl.checked = integrations.perplexica_enabled || false;
    if (searxngEl) searxngEl.checked = integrations.searxng_enabled || false;
    if (doclingEl) doclingEl.checked = integrations.docling_enabled || false;
    if (xlwingsEl) xlwingsEl.checked = integrations.xlwings_enabled || false;
    if (mcpEl) mcpEl.checked = integrations.mcp_enabled || false;

    const perplexicaUrlEl = document.getElementById('integration-perplexica-url');
    const searxngUrlEl = document.getElementById('integration-searxng-url');
    const doclingUrlEl = document.getElementById('integration-docling-url');
    const xlwingsUrlEl = document.getElementById('integration-xlwings-url');

    if (perplexicaUrlEl) perplexicaUrlEl.value = integrations.perplexica_url || '';
    if (searxngUrlEl) searxngUrlEl.value = integrations.searxng_url || '';
    if (doclingUrlEl) doclingUrlEl.value = integrations.docling_url || '';
    if (xlwingsUrlEl) xlwingsUrlEl.value = integrations.xlwings_url || '';
  }

  _populateDatabaseSettings(database) {
    const poolSizeEl = document.getElementById('db-pool-size');
    const maxOverflowEl = document.getElementById('db-max-overflow');
    const poolTimeoutEl = document.getElementById('db-pool-timeout');
    const echoSqlEl = document.getElementById('db-echo-sql');

    if (poolSizeEl) poolSizeEl.value = database.pool_size || 10;
    if (maxOverflowEl) maxOverflowEl.value = database.max_overflow || 20;
    if (poolTimeoutEl) poolTimeoutEl.value = database.pool_timeout || 30;
    if (echoSqlEl) echoSqlEl.checked = database.echo_sql || false;
  }

  _populateMonitoringSettings(monitoring) {
    const logLevelEl = document.getElementById('monitoring-log-level');
    const logFormatEl = document.getElementById('monitoring-log-format');
    const metricsEl = document.getElementById('monitoring-metrics-enabled');
    const tracingEl = document.getElementById('monitoring-tracing-enabled');
    const healthIntervalEl = document.getElementById('monitoring-health-check-interval');

    if (logLevelEl) logLevelEl.value = monitoring.log_level || 'INFO';
    if (logFormatEl) logFormatEl.value = monitoring.log_format || 'json';
    if (metricsEl) metricsEl.checked = monitoring.metrics_enabled !== false;
    if (tracingEl) tracingEl.checked = monitoring.tracing_enabled !== false;
    if (healthIntervalEl) healthIntervalEl.value = monitoring.health_check_interval || 30;
  }

  _populateMemorySettings(memory) {
    const enabledEl = document.getElementById('memory-enabled');
    const typeEl = document.getElementById('memory-type');
    const embedderEl = document.getElementById('memory-embedder');
    const topKEl = document.getElementById('memory-top-k');

    if (enabledEl) enabledEl.checked = memory.enabled !== false;
    if (typeEl) typeEl.value = memory.type || 'sqlite';
    if (embedderEl) embedderEl.value = memory.embedder || 'local-minilm';
    if (topKEl) topKEl.value = memory.top_k || 5;
  }

  _populateStorageSettings(storage) {
    const maxUploadEl = document.getElementById('storage-max-upload-size');
    if (maxUploadEl) maxUploadEl.value = storage.max_upload_size_mb || 100;
  }

  _populateAdvancedSettings(llm, interpreter) {
    const tempEl = document.getElementById('llm-temperature-adv');
    const maxTokensEl = document.getElementById('llm-max-tokens-adv');
    const contextWindowEl = document.getElementById('llm-context-window-adv');
    const supportsVisionEl = document.getElementById('llm-supports-vision');
    const systemMessageEl = document.getElementById('interpreter-system-message');

    if (tempEl) tempEl.value = llm.temperature || 0.7;
    if (maxTokensEl) maxTokensEl.value = llm.max_tokens || 4096;
    if (contextWindowEl) contextWindowEl.value = llm.context_window || 100000;
    if (supportsVisionEl) supportsVisionEl.checked = llm.supports_vision || false;
    if (systemMessageEl) systemMessageEl.value = interpreter.system_message || '';
  }

  /**
   * Load and populate services status
   * @returns {Promise<void>}
   */
  async loadServicesStatus() {
    const gridEl = document.getElementById('service-status-grid');
    if (!gridEl) return;

    try {
      gridEl.innerHTML = '<div style="color: rgba(255,255,255,0.5); text-align: center; padding: 20px;">Loading services...</div>';

      const response = await this.endpoint.getServicesStatus();
      
      if (!response || !response.services) {
        gridEl.innerHTML = '<div style="color: rgba(255,100,100,0.7); text-align: center; padding: 20px;">Failed to load services</div>';
        return;
      }

      gridEl.innerHTML = '';

      response.services.forEach(service => {
        const card = document.createElement('div');
        card.className = 'service-card';

        const statusClass = {
          'online': 'ok',
          'offline': 'err',
          'timeout': 'warn',
          'degraded': 'warn',
          'library': 'ok',
          'unknown': 'warn'
        }[service.status] || 'warn';

        const statusText = service.status.toUpperCase();

        let portInfo = '';
        if (service.port) {
          portInfo = `<div class="service-meta">Port: ${service.port}</div>`;
        }

        let responseTime = '';
        if (service.response_time_ms) {
          responseTime = `<div class="service-meta">Response: ${Math.round(service.response_time_ms)}ms</div>`;
        }

        let errorInfo = '';
        if (service.error) {
          errorInfo = `<div class="service-meta" style="color: rgba(255,100,100,0.7);">${service.error}</div>`;
        }

        let statusCodeInfo = '';
        if (service.status_code) {
          statusCodeInfo = `<div class="service-meta">Status Code: ${service.status_code}</div>`;
        }

        card.innerHTML = `
          <div class="service-name">${service.name}</div>
          <div class="service-pill ${statusClass}">${statusText}</div>
          <div class="service-meta">${service.description || ''}</div>
          ${portInfo}
          ${responseTime}
          ${statusCodeInfo}
          ${errorInfo}
        `;

        gridEl.appendChild(card);
      });

      console.log('[SettingsManager] Loaded services:', response.services.length);

    } catch (error) {
      console.error('[SettingsManager] Failed to load services:', error);
      gridEl.innerHTML = '<div style="color: rgba(255,100,100,0.7); text-align: center; padding: 20px;">Error loading services</div>';
    }
  }
  
  /**
   * Collect settings from form
   * @returns {Object} Settings object
   */
  collectSettings() {
    try {
      const llmBasic = this._collectLLMSettings();
      const llmAdvanced = this._collectAdvancedLLMSettings();
      const interpreterBasic = this._collectInterpreterSettings();
      const interpreterAdvanced = this._collectAdvancedInterpreterSettings();

      const settings = {
        llm: { ...llmBasic, ...llmAdvanced },
        interpreter: { ...interpreterBasic, ...interpreterAdvanced },
        security: this._collectSecuritySettings(),
        database: this._collectDatabaseSettings(),
        monitoring: this._collectMonitoringSettings(),
        memory: this._collectMemorySettings(),
        storage: this._collectStorageSettings(),
        integrations: this._collectIntegrationSettings()
      };
      
      this._validateSettings(settings);
      return settings;
      
    } catch (error) {
      console.error('[SettingsManager] Failed to collect settings:', error);
      throw error;
    }
  }
  
  /**
   * Collect LLM settings from form
   * @private
   */
  _collectLLMSettings() {
    const llm = {};
    
    if (this.formElements.provider) {
      llm.provider = this.formElements.provider.value;
    }
    
    if (this.formElements.apiBase) {
      llm.api_base = this.formElements.apiBase.value;
    }
    
    if (this.formElements.model) {
      llm.model = this.formElements.model.value;
    }
    
    if (this.formElements.temperature) {
      llm.temperature = parseFloat(this.formElements.temperature.value) || 0.7;
    }
    
    if (this.formElements.maxTokens) {
      llm.max_tokens = parseInt(this.formElements.maxTokens.value) || 4096;
    }
    
    if (this.formElements.contextWindow) {
      llm.context_window = parseInt(this.formElements.contextWindow.value) || 100000;
    }
    
    return llm;
  }
  
  /**
   * Collect interpreter settings from form
   * @private
   */
  _collectInterpreterSettings() {
    const interpreter = {};
    
    if (this.formElements.profile) {
      interpreter.profile = this.formElements.profile.value;
    }
    
    if (this.formElements.autoRun) {
      interpreter.auto_run = this.formElements.autoRun.checked;
    }
    
    if (this.formElements.loop) {
      interpreter.loop = this.formElements.loop.checked;
    }
    
    if (this.formElements.safeMode) {
      interpreter.safe_mode = this.formElements.safeMode.checked;
    }
    
    if (this.formElements.offline) {
      interpreter.offline = this.formElements.offline.checked;
    }
    
    return interpreter;
  }
  
  /**
   * Collect security settings from form
   * @private
   */
  _collectSecuritySettings() {
    const security = {};
    
    if (this.formElements.authEnabled) {
      security.auth_enabled = this.formElements.authEnabled.checked;
    }
    
    if (this.formElements.rateLimitEnabled) {
      security.rate_limit_enabled = this.formElements.rateLimitEnabled.checked;
    }
    
    if (this.formElements.corsEnabled) {
      security.cors_allow_credentials = this.formElements.corsEnabled.checked;
    }
    
    return security;
  }

  /**
   * Collect integration settings from form
   * @private
   */
  _collectIntegrationSettings() {
    const integrations = {};

    const perplexicaEl = document.getElementById('integration-perplexica');
    const searxngEl = document.getElementById('integration-searxng');
    const doclingEl = document.getElementById('integration-docling');
    const xlwingsEl = document.getElementById('integration-xlwings');
    const mcpEl = document.getElementById('integration-mcp');

    const perplexicaUrlEl = document.getElementById('integration-perplexica-url');
    const searxngUrlEl = document.getElementById('integration-searxng-url');
    const doclingUrlEl = document.getElementById('integration-docling-url');
    const xlwingsUrlEl = document.getElementById('integration-xlwings-url');

    if (perplexicaEl) integrations.perplexica_enabled = perplexicaEl.checked;
    if (searxngEl) integrations.searxng_enabled = searxngEl.checked;
    if (doclingEl) integrations.docling_enabled = doclingEl.checked;
    if (xlwingsEl) integrations.xlwings_enabled = xlwingsEl.checked;
    if (mcpEl) integrations.mcp_enabled = mcpEl.checked;

    if (perplexicaUrlEl && perplexicaUrlEl.value) integrations.perplexica_url = perplexicaUrlEl.value;
    if (searxngUrlEl && searxngUrlEl.value) integrations.searxng_url = searxngUrlEl.value;
    if (doclingUrlEl && doclingUrlEl.value) integrations.docling_url = doclingUrlEl.value;
    if (xlwingsUrlEl && xlwingsUrlEl.value) integrations.xlwings_url = xlwingsUrlEl.value;

    return integrations;
  }

  _collectDatabaseSettings() {
    const database = {};
    const poolSizeEl = document.getElementById('db-pool-size');
    const maxOverflowEl = document.getElementById('db-max-overflow');
    const poolTimeoutEl = document.getElementById('db-pool-timeout');
    const echoSqlEl = document.getElementById('db-echo-sql');

    if (poolSizeEl) database.pool_size = parseInt(poolSizeEl.value) || 10;
    if (maxOverflowEl) database.max_overflow = parseInt(maxOverflowEl.value) || 20;
    if (poolTimeoutEl) database.pool_timeout = parseInt(poolTimeoutEl.value) || 30;
    if (echoSqlEl) database.echo_sql = echoSqlEl.checked;

    return database;
  }

  _collectMonitoringSettings() {
    const monitoring = {};
    const logLevelEl = document.getElementById('monitoring-log-level');
    const logFormatEl = document.getElementById('monitoring-log-format');
    const metricsEl = document.getElementById('monitoring-metrics-enabled');
    const tracingEl = document.getElementById('monitoring-tracing-enabled');
    const healthIntervalEl = document.getElementById('monitoring-health-check-interval');

    if (logLevelEl) monitoring.log_level = logLevelEl.value;
    if (logFormatEl) monitoring.log_format = logFormatEl.value;
    if (metricsEl) monitoring.metrics_enabled = metricsEl.checked;
    if (tracingEl) monitoring.tracing_enabled = tracingEl.checked;
    if (healthIntervalEl) monitoring.health_check_interval = parseInt(healthIntervalEl.value) || 30;

    return monitoring;
  }

  _collectMemorySettings() {
    const memory = {};
    const enabledEl = document.getElementById('memory-enabled');
    const typeEl = document.getElementById('memory-type');
    const embedderEl = document.getElementById('memory-embedder');
    const topKEl = document.getElementById('memory-top-k');

    if (enabledEl) memory.enabled = enabledEl.checked;
    if (typeEl) memory.type = typeEl.value;
    if (embedderEl) memory.embedder = embedderEl.value;
    if (topKEl) memory.top_k = parseInt(topKEl.value) || 5;

    return memory;
  }

  _collectStorageSettings() {
    const storage = {};
    const maxUploadEl = document.getElementById('storage-max-upload-size');
    if (maxUploadEl) storage.max_upload_size_mb = parseInt(maxUploadEl.value) || 100;
    return storage;
  }

  _collectAdvancedLLMSettings() {
    const llm = {};
    const tempEl = document.getElementById('llm-temperature-adv');
    const maxTokensEl = document.getElementById('llm-max-tokens-adv');
    const contextWindowEl = document.getElementById('llm-context-window-adv');
    const supportsVisionEl = document.getElementById('llm-supports-vision');

    if (tempEl && tempEl.value) llm.temperature = parseFloat(tempEl.value) || 0.7;
    if (maxTokensEl && maxTokensEl.value) llm.max_tokens = parseInt(maxTokensEl.value) || 4096;
    if (contextWindowEl && contextWindowEl.value) llm.context_window = parseInt(contextWindowEl.value) || 100000;
    if (supportsVisionEl) llm.supports_vision = supportsVisionEl.checked;

    return llm;
  }

  _collectAdvancedInterpreterSettings() {
    const interpreter = {};
    const systemMessageEl = document.getElementById('interpreter-system-message');
    if (systemMessageEl && systemMessageEl.value) interpreter.system_message = systemMessageEl.value;
    return interpreter;
  }
  
  /**
   * Validate settings before saving
   * @private
   */
  _validateSettings(settings) {
    // Validate API Base URL
    if (settings.llm && settings.llm.api_base) {
      if (!this.validators.url.test(settings.llm.api_base)) {
        throw new Error('Invalid API base URL');
      }
    }
    
    // Validate temperature (0.0 - 1.0)
    if (settings.llm && settings.llm.temperature !== undefined) {
      const temp = parseFloat(settings.llm.temperature);
      if (isNaN(temp) || temp < 0 || temp > 1) {
        throw new Error('Temperature must be between 0.0 and 1.0');
      }
    }
    
    // Validate max_tokens (positive integer)
    if (settings.llm && settings.llm.max_tokens !== undefined) {
      const tokens = parseInt(settings.llm.max_tokens);
      if (isNaN(tokens) || tokens <= 0) {
        throw new Error('Max tokens must be a positive integer');
      }
    }
    
    // Security: Sanitize inputs
    this._sanitizeSettings(settings);
  }
  
  /**
   * Sanitize settings to prevent XSS
   * @private
   */
  _sanitizeSettings(settings) {
    // Remove any script tags or dangerous content
    const sanitize = (str) => {
      if (typeof str !== 'string') return str;
      return str.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    };
    
    if (settings.llm) {
      if (settings.llm.api_base) settings.llm.api_base = sanitize(settings.llm.api_base);
      if (settings.llm.model) settings.llm.model = sanitize(settings.llm.model);
    }
    
    if (settings.interpreter) {
      if (settings.interpreter.profile) settings.interpreter.profile = sanitize(settings.interpreter.profile);
    }
  }
  
  /**
   * Save settings to backend
   * @returns {Promise<Object>} Saved settings
   */
  async saveSettings() {
    try {
      this._setStatus('Saving...', 'info');
      
      console.log('[SettingsManager] 💾 Saving settings...');
      
      // Collect settings from form
      const settings = this.collectSettings();
      
      console.log('[SettingsManager] Collected settings:', settings);
      
      // Save to backend
      const savedSettings = await this.endpoint.setSettings(settings);
      
      console.log('[SettingsManager] ✅ Settings saved:', savedSettings);
      
      this.currentSettings = savedSettings;
      this._setStatus('Saved successfully - Applying changes...', 'success');
      
      // Apply settings immediately
      await this._applySettings(savedSettings);
      
      this._setStatus('Settings applied successfully', 'success');
      setTimeout(() => this._clearStatus(), 2000);
      
      return savedSettings;
      
    } catch (error) {
      console.error('[SettingsManager] ❌ Failed to save settings:', error);
      this._setStatus(error.message || 'Failed to save', 'error');
      setTimeout(() => this._clearStatus(), 3000);
      throw error;
    }
  }

  /**
   * Apply settings changes immediately
   * @private
   */
  async _applySettings(settings) {
    try {
      // Notify the application of settings changes
      if (window.guru) {
        console.log('[SettingsManager] Notifying application of settings changes');
        // Update connection if LLM settings changed
        if (settings.llm) {
          console.log('[SettingsManager] LLM settings updated');
        }
      }

      // Reload model indicator
      if (window.__mainApp && window.__mainApp.updateModelIndicator) {
        await window.__mainApp.updateModelIndicator();
      }

      // Dispatch custom event for other components
      window.dispatchEvent(new CustomEvent('settings-updated', { 
        detail: settings 
      }));

    } catch (error) {
      console.error('[SettingsManager] Failed to apply settings:', error);
    }
  }
  
  /**
   * Reload models when API base changes
   */
  async onApiBaseChange() {
    const apiBase = this.formElements.apiBase?.value;
    if (apiBase) {
      await this._loadModels(apiBase, null);
    }
  }
  
  /**
   * Set status message
   * @private
   */
  _setStatus(message, type = 'info') {
    if (!this.formElements.status) return;
    
    this.formElements.status.textContent = message;
    this.formElements.status.style.color = {
      info: '#93c5fd',
      success: '#86efac',
      error: '#fca5a5',
      warning: '#fde047'
    }[type] || '#93c5fd';
  }
  
  /**
   * Clear status message
   * @private
   */
  _clearStatus() {
    if (this.formElements.status) {
      this.formElements.status.textContent = '';
      this.formElements.status.style.color = '';
    }
  }
  
  /**
   * Dispose manager
   */
  dispose() {
    this.currentSettings = null;
    this.formElements = {};
  }
}

module.exports = SettingsManager;

if (typeof window !== 'undefined') {
  window.SettingsManager = SettingsManager;
}

