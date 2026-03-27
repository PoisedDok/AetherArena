// Incoming: defaults.js, env-loader.js, resolvers.js, port-resolver.js --- {object, none}
// Processing: Resolve configuration precedence and expose getters --- {4 jobs: JOB_DELEGATE_TO_MODULE, JOB_GET_STATE, JOB_INITIALIZE, JOB_VALIDATE_SCHEMA}
// Outgoing: Modules consuming runtime configuration --- {object, none}

'use strict';

const DEFAULTS = require('./defaults');
const { envLoader } = require('./env-loader');
const {
  resolveUrl,
  resolveBoolean,
  resolveInt,
  resolveTimeout,
  resolveLogLevel,
  resolveSanitizerProfile,
  resolveStorageBackend,
  resolveString,
  resolveWsUrl,
  resolveFullUrl,
} = require('./resolvers');
const { isValidUrl, normalizeUrl } = require('./validators');
const { getBackendUrl: getDynamicBackendUrl, getServiceUrl, getBackendWsUrl } = require('./port-resolver');

// Initialize environment loader
envLoader.init();

// ============================================================================
// Configuration Object
// ============================================================================

const config = {
  // ========================================================================
  // Backend Configuration
  // ========================================================================
  backend: Object.freeze({
    // Main backend HTTP base URL (with dynamic discovery)
    get baseUrl() {
      const staticUrl = resolveUrl('GURU_API_URL', 'backend_url', DEFAULTS.backend.baseUrl);
      const resolved = getDynamicBackendUrl(staticUrl);
      if (!resolved || typeof resolved !== 'string' || resolved.trim().length === 0) {
        throw new Error('[Config] CONTRACT VIOLATION: Backend baseUrl is required. Configure GURU_API_URL/backend_url or ensure PortManager discovery is available.');
      }
      if (!isValidUrl(resolved)) {
        throw new Error(`[Config] CONTRACT VIOLATION: Backend baseUrl is not a valid URL: ${resolved}`);
      }
      return normalizeUrl(resolved);
    },

    // WebSocket URL (derived from baseUrl with dynamic discovery)
    get wsUrl() {
      return getBackendWsUrl(this.baseUrl);
    },

    // Whether to spawn backend on Electron startup
    get shouldSpawn() {
      return resolveBoolean('GURU_SPAWN_BACKEND', 'backend_spawn', DEFAULTS.backend.shouldSpawn);
    },

    // Backend directory path (for launching services)
    get backendDir() {
      return envLoader.getString('AETHER_BACKEND_DIR') || envLoader.getString('GURU_BACKEND_DIR') || null;
    },

    // Backend health check interval (ms)
    get healthCheckInterval() {
      return resolveTimeout('BACKEND_HEALTH_INTERVAL', 'backend_health_interval', DEFAULTS.backend.healthCheckInterval);
    },

    // Backend startup timeout (ms)
    get startupTimeout() {
      return resolveTimeout('BACKEND_STARTUP_TIMEOUT', 'backend_startup_timeout', DEFAULTS.backend.startupTimeout);
    },

    // Backend connection UX (renderer-friendly)
    get connectInitialDelay() {
      return resolveTimeout('BACKEND_CONNECT_INITIAL_DELAY', 'backend_connect_initial_delay', DEFAULTS.backend.connectInitialDelay);
    },

    get connectMaxDelay() {
      return resolveTimeout('BACKEND_CONNECT_MAX_DELAY', 'backend_connect_max_delay', DEFAULTS.backend.connectMaxDelay);
    },

    get connectMaxAttempts() {
      return resolveInt('BACKEND_CONNECT_MAX_ATTEMPTS', 'backend_connect_max_attempts', DEFAULTS.backend.connectMaxAttempts, 1, 50);
    },

    get connectSuccessHideDelay() {
      return resolveTimeout('BACKEND_CONNECT_SUCCESS_HIDE_DELAY', 'backend_connect_success_hide_delay', DEFAULTS.backend.connectSuccessHideDelay);
    },

    // Backend entry script (for integrated launcher)
    get entryScript() {
      const primary = envLoader.getString('AETHER_BACKEND_SCRIPT');
      if (primary) {
        return primary;
      }
      const legacy = envLoader.getString('GURU_BACKEND_SCRIPT');
      if (legacy) {
        return legacy;
      }
      return DEFAULTS.backend.entryScript;
    },
  }),

  // ========================================================================
  // Services/LLM - REMOVED
  // All service URLs and LLM configuration now come from backend via /v1/settings/
  // Frontend only needs backend.baseUrl to connect
  // ========================================================================

  // ========================================================================
  // UI Configuration
  // ========================================================================
  ui: Object.freeze({
    get widgetSize() {
      return resolveInt('WIDGET_SIZE', 'widget_size', DEFAULTS.ui.widgetSize, 100, 1000);
    },

    get normalWidth() {
      return resolveInt('NORMAL_WIDTH', 'normal_width', DEFAULTS.ui.normalWidth, 600, 3840);
    },

    get normalHeight() {
      return resolveInt('NORMAL_HEIGHT', 'normal_height', DEFAULTS.ui.normalHeight, 400, 2160);
    },

    get widgetMargin() {
      return resolveInt('WIDGET_MARGIN', 'widget_margin', DEFAULTS.ui.widgetMargin, 0, 100);
    },

    get updateInterval() {
      return resolveInt('UI_UPDATE_INTERVAL', 'ui_update_interval', DEFAULTS.ui.updateInterval, 16, 1000);
    },

    get animationDuration() {
      return resolveInt('UI_ANIMATION_DURATION', 'ui_animation_duration', DEFAULTS.ui.animationDuration, 100, 2000);
    },

    get mainWindowBackgroundColor() {
      return resolveString('MAIN_WINDOW_BG_COLOR', 'main_window_bg_color', DEFAULTS.ui.mainWindowBackgroundColor);
    },

    get chatWindowBackgroundColor() {
      return resolveString('CHAT_WINDOW_BG_COLOR', 'chat_window_bg_color', DEFAULTS.ui.chatWindowBackgroundColor);
    },

    get artifactsWindowBackgroundColor() {
      return resolveString('ARTIFACTS_WINDOW_BG_COLOR', 'artifacts_window_bg_color', DEFAULTS.ui.artifactsWindowBackgroundColor);
    },

    get enableNativeWindowEffects() {
      return resolveBoolean('ENABLE_NATIVE_WINDOW_EFFECTS', 'enable_native_window_effects', DEFAULTS.ui.enableNativeWindowEffects);
    },

    get macVibrancy() {
      return resolveString('MAC_VIBRANCY', 'mac_vibrancy', DEFAULTS.ui.macVibrancy);
    },

    get macVisualEffectState() {
      return resolveString('MAC_VISUAL_EFFECT_STATE', 'mac_visual_effect_state', DEFAULTS.ui.macVisualEffectState);
    },

    get windowsBackgroundMaterial() {
      return resolveString('WINDOWS_BACKGROUND_MATERIAL', 'windows_background_material', DEFAULTS.ui.windowsBackgroundMaterial);
    },

    get disableNativeWindowEffectsInWidgetMode() {
      return resolveBoolean(
        'DISABLE_NATIVE_WINDOW_EFFECTS_IN_WIDGET_MODE',
        'disable_native_window_effects_in_widget_mode',
        DEFAULTS.ui.disableNativeWindowEffectsInWidgetMode
      );
    },

    // Startup animation (renderer-friendly)
    get startupAnimationEnabled() {
      return resolveBoolean('UI_STARTUP_ANIMATION', 'ui_startup_animation', DEFAULTS.ui.startupAnimation.enabled);
    },

    get startupMinDurationMs() {
      return resolveTimeout('UI_STARTUP_MIN_DURATION_MS', 'ui_startup_min_duration_ms', DEFAULTS.ui.startupAnimation.minDurationMs);
    },

    get startupSeparationDelayMs() {
      return resolveTimeout('UI_STARTUP_SEPARATION_DELAY_MS', 'ui_startup_separation_delay_ms', DEFAULTS.ui.startupAnimation.separationDelayMs);
    },

    get startupExpandDelayMs() {
      return resolveTimeout('UI_STARTUP_EXPAND_DELAY_MS', 'ui_startup_expand_delay_ms', DEFAULTS.ui.startupAnimation.expandDelayMs);
    },

    get startupFadeOutDurationMs() {
      return resolveTimeout('UI_STARTUP_FADE_OUT_DURATION_MS', 'ui_startup_fade_out_duration_ms', DEFAULTS.ui.startupAnimation.fadeOutDurationMs);
    },

    get startupHoldAfterExpandMs() {
      return resolveTimeout('UI_STARTUP_HOLD_AFTER_EXPAND_MS', 'ui_startup_hold_after_expand_ms', DEFAULTS.ui.startupAnimation.holdAfterExpandMs);
    },
  }),

  // ========================================================================
  // Audio - REMOVED
  // Audio configuration now comes from backend via /v1/settings/
  // ========================================================================

  // ========================================================================
  // WebSocket Configuration
  // ========================================================================
  websocket: Object.freeze({
    get reconnectDelay() {
      return resolveTimeout('WS_RECONNECT_DELAY', 'ws_reconnect_delay', DEFAULTS.websocket.reconnectDelay);
    },

    get reconnectBackoffMax() {
      return resolveTimeout('WS_RECONNECT_BACKOFF_MAX', 'ws_reconnect_backoff_max', DEFAULTS.websocket.reconnectBackoffMax);
    },

    get pingInterval() {
      return resolveTimeout('WS_PING_INTERVAL', 'ws_ping_interval', DEFAULTS.websocket.pingInterval);
    },

    get pongTimeout() {
      return resolveTimeout('WS_PONG_TIMEOUT', 'ws_pong_timeout', DEFAULTS.websocket.pongTimeout);
    },
  }),

  // ========================================================================
  // API Configuration
  // ========================================================================
  api: Object.freeze({
    get timeout() {
      return resolveTimeout('API_TIMEOUT', 'api_timeout', DEFAULTS.api.timeout);
    },

    get retries() {
      return resolveInt('API_RETRIES', 'api_retries', DEFAULTS.api.retries, 0, 10);
    },

    get retryDelay() {
      return resolveTimeout('API_RETRY_DELAY', 'api_retry_delay', DEFAULTS.api.retryDelay);
    },

    get maxPayloadSize() {
      return resolveInt('API_MAX_PAYLOAD_SIZE', 'api_max_payload_size', DEFAULTS.api.maxPayloadSize, 1024, 104857600);
    },
  }),

  // ========================================================================
  // Security Configuration
  // ========================================================================
  security: Object.freeze({
    get maxMessageSize() {
      return resolveInt('MAX_MESSAGE_SIZE', 'max_message_size', DEFAULTS.security.maxMessageSize, 1000, 1000000);
    },

    get maxMessagesPerMinute() {
      return resolveInt('MAX_MESSAGES_PER_MINUTE', 'max_messages_per_minute', DEFAULTS.security.maxMessagesPerMinute, 1, 1000);
    },

    get ipcRateLimitWindow() {
      return resolveTimeout('IPC_RATE_LIMIT_WINDOW', 'ipc_rate_limit_window', DEFAULTS.security.ipcRateLimitWindow);
    },

    get ipcMaxCallsPerWindow() {
      return resolveInt('IPC_MAX_CALLS_PER_WINDOW', 'ipc_max_calls_per_window', DEFAULTS.security.ipcMaxCallsPerWindow, 1, 1000);
    },

    get maxFileSizeMB() {
      return resolveInt('MAX_FILE_SIZE_MB', 'max_file_size_mb', DEFAULTS.security.maxFileSizeMB, 1, 100);
    },

    get maxPayloadSizeMB() {
      return resolveInt('MAX_PAYLOAD_SIZE_MB', 'max_payload_size_mb', DEFAULTS.security.maxPayloadSizeMB, 1, 100);
    },

    get sanitizerProfile() {
      return resolveSanitizerProfile('SANITIZER_PROFILE', 'sanitizer_profile', DEFAULTS.security.sanitizerProfile);
    },
  }),

  // ========================================================================
  // Storage Configuration
  // ========================================================================
  storage: Object.freeze({
    get backend() {
      return resolveStorageBackend('STORAGE_BACKEND', 'storage_backend', DEFAULTS.storage.backend);
    },

    get maxDomMessages() {
      return resolveInt('MAX_DOM_MESSAGES', 'max_dom_messages', DEFAULTS.storage.maxDomMessages, 10, 1000);
    },

    get pruneBatchSize() {
      return resolveInt('PRUNE_BATCH_SIZE', 'prune_batch_size', DEFAULTS.storage.pruneBatchSize, 5, 100);
    },

    get gracePeriodMs() {
      return resolveTimeout('GRACE_PERIOD_MS', 'grace_period_ms', DEFAULTS.storage.gracePeriodMs);
    },

    get bufferSize() {
      return resolveInt('BUFFER_SIZE', 'buffer_size', DEFAULTS.storage.bufferSize, 100, 10000);
    },
  }),

  // ========================================================================
  // Artifacts Configuration
  // ========================================================================
  artifacts: Object.freeze({
    get fetchTimeout() {
      return resolveTimeout('ARTIFACT_FETCH_TIMEOUT', 'artifact_fetch_timeout', DEFAULTS.artifacts.fetchTimeout);
    },

    get saveTimeout() {
      return resolveTimeout('ARTIFACT_SAVE_TIMEOUT', 'artifact_save_timeout', DEFAULTS.artifacts.saveTimeout);
    },

    get maxArtifactSize() {
      return resolveInt('MAX_ARTIFACT_SIZE', 'max_artifact_size', DEFAULTS.artifacts.maxArtifactSize, 1024, 52428800);
    },
  }),

  // ========================================================================
  // Logging Configuration
  // ========================================================================
  logging: Object.freeze({
    get level() {
      return resolveLogLevel('LOG_LEVEL', 'log_level', DEFAULTS.logging.level);
    },

    get maxFileSize() {
      return resolveInt('LOG_MAX_FILE_SIZE', 'log_max_file_size', DEFAULTS.logging.maxFileSize, 1048576, 104857600);
    },

    get maxFiles() {
      return resolveInt('LOG_MAX_FILES', 'log_max_files', DEFAULTS.logging.maxFiles, 1, 100);
    },

    get console() {
      return resolveBoolean('LOG_CONSOLE', 'log_console', DEFAULTS.logging.console);
    },

    get file() {
      return resolveBoolean('LOG_FILE', 'log_file', DEFAULTS.logging.file);
    },
  }),

  // ========================================================================
  // Feature Flags
  // ========================================================================
  features: Object.freeze({
    get voiceInput() {
      return resolveBoolean('ENABLE_VOICE_INPUT', 'feature_voice_input', DEFAULTS.features.voiceInput);
    },

    get tts() {
      return resolveBoolean('ENABLE_TTS', 'feature_tts', DEFAULTS.features.tts);
    },

    get legalNews() {
      return resolveBoolean('FEATURE_LEGAL_NEWS', 'feature_legal_news', DEFAULTS.features.legalNews);
    },

    get artifactsStream() {
      return resolveBoolean('FEATURE_ARTIFACTS_STREAM', 'feature_artifacts_stream', DEFAULTS.features.artifactsStream);
    },

    get diagnostics() {
      return resolveBoolean('FEATURE_DIAGNOSTICS', 'feature_diagnostics', DEFAULTS.features.diagnostics);
    },

    get offlineMode() {
      return resolveBoolean('OFFLINE_MODE', 'offline_mode', DEFAULTS.features.offlineMode);
    },
  }),

  // ========================================================================
  // Development Flags
  // ========================================================================
  dev: Object.freeze({
    get debugMode() {
      return resolveBoolean('DEBUG_MODE', 'debug_mode', DEFAULTS.dev.debugMode);
    },

    get mockBackend() {
      return resolveBoolean('MOCK_BACKEND', 'mock_backend', DEFAULTS.dev.mockBackend);
    },

    get verboseLogging() {
      return resolveBoolean('VERBOSE_LOGGING', 'verbose_logging', DEFAULTS.dev.verboseLogging);
    },

    get skipHealthCheck() {
      // Explicit env/localStorage override takes priority
      const explicit = resolveBoolean('SKIP_HEALTH_CHECK', 'skip_health_check', null);
      if (explicit !== null) return explicit;
      // Auto-skip in dev mode when backend is not being spawned
      // (ELECTRON_DEV=true + GURU_SPAWN_BACKEND=false → no backend to wait for)
      const isElectronDev = resolveBoolean('ELECTRON_DEV', null, false);
      const willSpawn = resolveBoolean('GURU_SPAWN_BACKEND', 'backend_spawn', DEFAULTS.backend.shouldSpawn);
      if (isElectronDev && !willSpawn) return true;
      return DEFAULTS.dev.skipHealthCheck;
    },

    get openDevToolsMain() {
      return resolveBoolean('ELECTRON_DEVTOOLS_MAIN', 'devtools_main', DEFAULTS.dev.openDevToolsMain);
    },

    get openDevToolsAux() {
      return resolveBoolean('ELECTRON_DEVTOOLS_AUX', 'devtools_aux', DEFAULTS.dev.openDevToolsAux);
    },
  }),

  // ========================================================================
  // Endpoints (static - from defaults)
  // ========================================================================
  endpoints: Object.freeze(DEFAULTS.endpoints),

  // ========================================================================
  // Paths (static - from defaults)
  // ========================================================================
  paths: Object.freeze(DEFAULTS.paths),
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get full URL by combining backend base with endpoint path
 * @param {string} endpoint - Endpoint key from endpoints object
 * @returns {string} Full URL
 */
function getBackendUrl(endpoint) {
  const endpointPath = config.endpoints[endpoint];
  if (!endpointPath) {
    throw new Error(`Unknown endpoint: ${endpoint}`);
  }
  return resolveFullUrl(config.backend.baseUrl, endpointPath);
}

/**
 * Get configuration snapshot (for logging/debugging)
 * Excludes sensitive values
 * @returns {Object} Configuration snapshot
 */
function getConfigSnapshot() {
  return {
    backend: {
      baseUrl: config.backend.baseUrl,
      wsUrl: config.backend.wsUrl,
      shouldSpawn: config.backend.shouldSpawn,
    },
    // Services/LLM/Audio removed - get from backend via /v1/settings/
    ui: {
      widgetSize: config.ui.widgetSize,
      normalWidth: config.ui.normalWidth,
      normalHeight: config.ui.normalHeight,
      startupAnimation: {
        enabled: config.ui.startupAnimationEnabled,
        minDurationMs: config.ui.startupMinDurationMs,
        separationDelayMs: config.ui.startupSeparationDelayMs,
        expandDelayMs: config.ui.startupExpandDelayMs,
        fadeOutDurationMs: config.ui.startupFadeOutDurationMs,
        holdAfterExpandMs: config.ui.startupHoldAfterExpandMs,
      },
    },
    features: {
      voiceInput: config.features.voiceInput,
      tts: config.features.tts,
      offlineMode: config.features.offlineMode,
    },
    dev: {
      debugMode: config.dev.debugMode,
      mockBackend: config.dev.mockBackend,
      skipHealthCheck: config.dev.skipHealthCheck,
      openDevToolsMain: config.dev.openDevToolsMain,
      openDevToolsAux: config.dev.openDevToolsAux,
    },
  };
}

/**
 * Reload configuration (useful for hot reload)
 */
function reloadConfig() {
  envLoader.reload();
  console.log('[Config] Configuration reloaded');
}

// ============================================================================
// Logging (non-sensitive only)
// ============================================================================

if (config.dev.debugMode) {
  console.log('[Config] Runtime configuration loaded:', getConfigSnapshot());
}

// ============================================================================
// Exports
// ============================================================================

module.exports = Object.freeze({
  ...config,
  getBackendUrl,
  getConfigSnapshot,
  reloadConfig,
  
  // Export utilities for advanced use
  envLoader,
  isValidUrl,
  normalizeUrl,
});
