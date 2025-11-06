'use strict';

/**
 * @.architecture
 * 
 * Incoming: defaults.js, env-loader.js, resolvers.js, validators.js, port-resolver.js --- {config_object, javascript_object}
 * Processing: Merge localStorage overrides, env vars, defaults via precedence (localStorage > env > defaults), resolve URLs/booleans/ints/timeouts, provide getters for backend/services/llm/ui/audio/websocket/api/security/storage/artifacts/logging/features/dev configs with dynamic port discovery --- {12 jobs: JOB_DELEGATE_TO_MODULE, JOB_GET_STATE, JOB_GET_STATE, JOB_ROUTE_BY_TYPE, JOB_VALIDATE_SCHEMA, JOB_VALIDATE_SCHEMA, JOB_VALIDATE_SCHEMA, JOB_GET_STATE, JOB_INITIALIZE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_UPDATE_STATE}
 * Outgoing: All modules (config object with getters for runtime values) --- {config_object, javascript_object_frozen}
 * 
 * 
 * @module core/config/index
 * 
 * Unified Configuration Module
 * ============================================================================
 * Single source of truth for all application configuration.
 * 
 * Precedence (highest to lowest):
 * 1. localStorage override (user runtime config)
 * 2. Environment variable (.env or process.env)
 * 3. Defaults (from defaults.js)
 * 
 * Security:
 * - Validates all URLs before use
 * - Sanitizes user inputs from localStorage
 * - Never logs sensitive values
 * - Provides read-only access to renderer
 * 
 * Usage:
 *   const config = require('./core/config');
 *   config.backend.baseUrl  // http://localhost:8765
 *   config.services.perplexica // http://127.0.0.1:3000
 * 
 * @module core/config
 */

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
      return getDynamicBackendUrl(staticUrl);
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
  }),

  // ========================================================================
  // External Services
  // ========================================================================
  services: Object.freeze({
    get perplexica() {
      const staticUrl = resolveUrl('PERPLEXICA_URL', 'perplexica_url', DEFAULTS.services.perplexica);
      return getServiceUrl('perplexica', staticUrl);
    },

    get searxng() {
      const staticUrl = resolveUrl('SEARXNG_URL', 'searxng_url', DEFAULTS.services.searxng);
      return getServiceUrl('searxng', staticUrl);
    },

    get docling() {
      const staticUrl = resolveUrl('DOCLING_URL', 'docling_url', DEFAULTS.services.docling);
      return getServiceUrl('docling', staticUrl);
    },

    get xlwings() {
      const staticUrl = resolveUrl('XLWINGS_URL', 'xlwings_url', DEFAULTS.services.xlwings);
      return getServiceUrl('xlwings', staticUrl);
    },
  }),

  // ========================================================================
  // LLM Provider (LM Studio, Ollama, etc.)
  // ========================================================================
  llm: Object.freeze({
    // Base URL for LM Studio or OpenAI-compatible API (with dynamic discovery)
    get baseUrl() {
      const staticUrl = resolveUrl('LM_STUDIO_BASE_URL', 'lm_studio_url', DEFAULTS.llm.baseUrl);
      return getServiceUrl('llm', staticUrl);
    },

    // Chat completions endpoint (full URL)
    get chatUrl() {
      return resolveFullUrl(this.baseUrl, DEFAULTS.llm.chatEndpoint);
    },

    // Abort endpoint (full URL)
    get abortUrl() {
      const custom = envLoader.getString('LM_STUDIO_ABORT_URL');
      if (custom && isValidUrl(custom)) {
        return normalizeUrl(custom);
      }
      return resolveFullUrl(this.baseUrl, DEFAULTS.llm.abortEndpoint);
    },

    // Request timeout (ms)
    get timeout() {
      return resolveTimeout('LLM_TIMEOUT', 'llm_timeout', DEFAULTS.llm.timeout);
    },
  }),

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
  }),

  // ========================================================================
  // Audio Settings
  // ========================================================================
  audio: Object.freeze({
    get sampleRate() {
      return resolveInt('AUDIO_SAMPLE_RATE', 'audio_sample_rate', DEFAULTS.audio.sampleRate, 8000, 48000);
    },

    get chunkSize() {
      return resolveInt('AUDIO_CHUNK_SIZE', 'audio_chunk_size', DEFAULTS.audio.chunkSize, 1024, 16384);
    },

    get channels() {
      return resolveInt('AUDIO_CHANNELS', 'audio_channels', DEFAULTS.audio.channels, 1, 2);
    },

    get bitDepth() {
      return resolveInt('AUDIO_BIT_DEPTH', 'audio_bit_depth', DEFAULTS.audio.bitDepth, 8, 32);
    },
  }),

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
      return resolveBoolean('SKIP_HEALTH_CHECK', 'skip_health_check', DEFAULTS.dev.skipHealthCheck);
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
    services: {
      perplexica: config.services.perplexica,
      searxng: config.services.searxng,
      docling: config.services.docling,
      xlwings: config.services.xlwings,
    },
    features: {
      voiceInput: config.features.voiceInput,
      tts: config.features.tts,
      offlineMode: config.features.offlineMode,
    },
    dev: {
      debugMode: config.dev.debugMode,
      mockBackend: config.dev.mockBackend,
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

