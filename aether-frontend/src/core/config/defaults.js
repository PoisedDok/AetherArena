// Incoming: none --- {none, none}
// Processing: Define frozen default configuration object --- {1 job: JOB_INITIALIZE}
// Outgoing: Config consumers --- {object, none}

'use strict';

const DEFAULTS = Object.freeze({
  // Backend Configuration
  backend: Object.freeze({
    // CONTRACT: Backend base URL is the well-known default (127.0.0.1:8765 = PortManager.PORT_RANGES.backend.start).
    // Override via env (GURU_API_URL) or localStorage (backend_url). PortManager discovery may override host/port later.
    // CRITICAL: This MUST NOT be empty. During packaged-app cold start the backend takes 30-60s to
    // bind. PortManager discovery finds nothing, and config.backend.baseUrl is accessed by main/index.js
    // (StorageHandler, MemoryHandler) BEFORE the backend is healthy. An empty default causes a fatal
    // CONTRACT VIOLATION throw that crashes the entire Electron app and kills the backend it just spawned.
    baseUrl: 'http://127.0.0.1:8765',
    wsProtocol: 'ws',
    shouldSpawn: true,
    healthCheckInterval: 30000, // ms (increased from 5s to reduce constant calls)
    startupTimeout: 300000, // ms (5 minutes - covers Docker mesh startup + first-run setup)
    entryScript: 'start_production.sh',
    // Frontend-only connection UX (bootstrap defaults; can be overridden via env/localStorage)
    connectInitialDelay: 1000, // ms
    connectMaxDelay: 30000, // ms
    connectMaxAttempts: 8,
    connectSuccessHideDelay: 1500, // ms
  }),

  // External Services
  // Services and LLM configuration are loaded from backend via /v1/settings/.
  // Defaults remain present to satisfy config shape contracts.
  services: Object.freeze({}),

  // LLM Configuration
  // Runtime values are sourced from backend settings.
  llm: Object.freeze({}),

  // UI Configuration
  ui: Object.freeze({
    widgetSize: 300,
    normalWidth: 1000,
    normalHeight: 800,
    widgetMargin: 24,
    updateInterval: 100, // ms
    animationDuration: 300, // ms
    mainWindowBackgroundColor: '#00000000',
    chatWindowBackgroundColor: '#00000000',
    artifactsWindowBackgroundColor: '#00000000',
    // Startup animation (renderer-only, offline-safe)
    startupAnimation: Object.freeze({
      enabled: true,
      // How long we keep the splash up before allowing renderer init to continue.
      minDurationMs: 3200,
      // When to visually separate A and I (before expansion).
      separationDelayMs: 1200,
      // When to expand AI -> Aether / Inc.
      expandDelayMs: 2000,
      // Fade out duration.
      fadeOutDurationMs: 400,
      // Small hold after expansion before fade.
      holdAfterExpandMs: 500,
    }),
    // Native window effects (OS compositor) - opt-in, renderer CSS still provides consistent look
    enableNativeWindowEffects: true,
    macVibrancy: 'under-window',
    macVisualEffectState: 'active',
    windowsBackgroundMaterial: 'acrylic',
    // Widget mode: disable OS-level window materials so only the visualizer is visible (no tinted rectangle background)
    disableNativeWindowEffectsInWidgetMode: true,
    // Visualizer style: 'cosmos' (golden-ratio galaxy orb — default)
    // or 'neural' (techy node mesh)
    visualizerMode: 'cosmos',
  }),

  // Audio Settings
  // Audio configuration REMOVED
  // Audio settings now come from backend via /v1/settings/

  // WebSocket Configuration
  websocket: Object.freeze({
    reconnectDelay: 2000, // ms
    reconnectBackoffMax: 30000, // ms
    pingInterval: 30000, // ms
    pongTimeout: 10000, // ms
  }),

  // API Configuration
  api: Object.freeze({
    timeout: 60000, // ms (increased from 15s)
    retries: 2,
    retryDelay: 1000, // ms
    maxPayloadSize: 52428800, // 50MB in bytes
  }),

  // Security Configuration
  security: Object.freeze({
    maxMessageSize: 100000, // characters
    maxMessagesPerMinute: 60,
    ipcRateLimitWindow: 1000, // ms
    ipcMaxCallsPerWindow: 50,
    maxFileSizeMB: 50,
    maxPayloadSizeMB: 50,
    sanitizerProfile: 'strict', // strict | default | permissive
  }),

  // Storage Configuration
  storage: Object.freeze({
    backend: 'supabase', // ONLY option - all database operations via Supabase
    maxDomMessages: 200,
    pruneBatchSize: 25,
    gracePeriodMs: 10000,
    bufferSize: 500,
  }),

  // Paths Configuration
  paths: Object.freeze({
    skillsDir: './skills',
    dataDir: './data',
    profilesDir: './profiles',
  }),

    // Artifacts Configuration
    artifacts: Object.freeze({
      fetchTimeout: 60000, // ms (increased from 12s)
      saveTimeout: 60000, // ms (increased from 15s)
      maxArtifactSize: 52428800, // 50MB in bytes
    }),

  // Logging Configuration
  logging: Object.freeze({
    level: 'info', // silent | error | warn | info | debug | trace
    maxFileSize: 52428800, // 50MB in bytes
    maxFiles: 5,
    console: true,
    file: true,
  }),

  // Feature Flags
  features: Object.freeze({
    voiceInput: true,
    tts: true,
    legalNews: true,
    artifactsStream: true,
    diagnostics: false,
    offlineMode: false,
  }),

  // Development Flags
  dev: Object.freeze({
    debugMode: false,
    mockBackend: false,
    verboseLogging: false,
    skipHealthCheck: false,
    // DevTools auto-open behavior (main vs auxiliary windows)
    openDevToolsMain: true,
    openDevToolsAux: false,
  }),

  // Performance Configuration (Phase 10)
  performance: Object.freeze({
    // Monitoring
    enableMonitoring: true,
    enableBudgets: true,
    enableMemoryMonitoring: true,
    enableStartupProfiling: true,
    enableRendererOptimization: true,
    
    // Budgets
    startupBudget: 2000,            // 2s total startup
    memoryBudget: 400 * 1024 * 1024, // 400MB
    fpsBudget: 30,                  // Minimum 30fps
    latencyBudget: 300,             // 300ms max latency
    
    // Monitoring intervals
    metricsInterval: 30000,         // 30s metrics collection
    memoryInterval: 5000,           // 5s memory sampling
    
    // Lighthouse targets
    lighthousePerformance: 90,
    lighthouseAccessibility: 90,
    lighthouseBestPractices: 90,
    lighthouseSEO: 80,
    
    // Optimization flags
    lazyLoadModules: true,
    optimizeImages: true,
    optimizeFonts: true,
    optimizeCSS: true,
    deferNonCriticalScripts: true,
  }),

  // API Endpoints (relative paths - OpenAI-compatible format)
  endpoints: Object.freeze({
    health: '/v1/health',
    settings: '/v1/settings/',
    models: '/v1/models',
    modelCapabilities: '/v1/models/capabilities',
    modelsConfigSettings: '/v1/models-config/settings',
    modelsConfigModels: '/v1/models-config/models',
    profiles: '/v1/profiles',
    stopGeneration: '/v1/stop-generation',
    chatStorage: '/v1/storage',
    storageApi: '/v1/storage',
    storageHealth: '/health',
    perplexicaDiscover: '/v1/discover',
    doclingConvert: '/v1/convert',
    // Additional OpenAI-format endpoints
    mcp: '/v1/mcp',
    memories: '/v1/memory',
    files: '/v1/file',
    preferences: '/v1/preferences',
    context: '/v1/context',
    docs: '/v1/docs',
  }),

  // Environment Variable Prefixes
  envPrefixes: Object.freeze([
    'AETHER_',
    'GURU_',
    'LM_STUDIO_',
    'ELECTRON_',
  ]),
});

module.exports = DEFAULTS;
