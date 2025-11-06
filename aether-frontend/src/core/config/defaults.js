'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, data_model}
 * Processing: Define frozen default configuration object (19 categories: backend, services, llm, ui, audio, websocket, api, security, storage, paths, artifacts, logging, features, dev, performance, endpoints, envPrefixes) --- {1 jobs: JOB_INITIALIZE}
 * Outgoing: Export frozen DEFAULTS object for import by resolvers.js, env-loader.js, all config consumers --- {config_types.defaults, frozen_object}
 * 
 * 
 * @module core/config/defaults
 */

const DEFAULTS = Object.freeze({
  // Backend Configuration
  backend: Object.freeze({
    baseUrl: 'http://localhost:8765',
    wsProtocol: 'ws',
    shouldSpawn: true,
    healthCheckInterval: 5000, // ms
    startupTimeout: 30000, // ms
  }),

  // External Services
  services: Object.freeze({
    perplexica: 'http://127.0.0.1:3000',
    searxng: 'http://127.0.0.1:4000',
    docling: 'http://127.0.0.1:8000',
    xlwings: 'http://127.0.0.1:8001',
  }),

  // LLM Provider (LM Studio, Ollama, etc.)
  llm: Object.freeze({
    baseUrl: 'http://localhost:1234/v1',
    chatEndpoint: '/chat/completions',
    abortEndpoint: '/chat/abort',
    timeout: 120000, // ms
  }),

  // UI Configuration
  ui: Object.freeze({
    widgetSize: 300,
    normalWidth: 1000,
    normalHeight: 800,
    widgetMargin: 24,
    updateInterval: 100, // ms
    animationDuration: 300, // ms
  }),

  // Audio Settings
  audio: Object.freeze({
    sampleRate: 16000,
    chunkSize: 4096,
    channels: 1,
    bitDepth: 16,
  }),

  // WebSocket Configuration
  websocket: Object.freeze({
    reconnectDelay: 2000, // ms
    reconnectBackoffMax: 30000, // ms
    pingInterval: 30000, // ms
    pongTimeout: 10000, // ms
  }),

  // API Configuration
  api: Object.freeze({
    timeout: 15000, // ms
    retries: 2,
    retryDelay: 1000, // ms
    maxPayloadSize: 10485760, // 10MB in bytes
  }),

  // Security Configuration
  security: Object.freeze({
    maxMessageSize: 100000, // characters
    maxMessagesPerMinute: 60,
    ipcRateLimitWindow: 1000, // ms
    ipcMaxCallsPerWindow: 50,
    maxFileSizeMB: 10,
    maxPayloadSizeMB: 10,
    sanitizerProfile: 'strict', // strict | default | permissive
  }),

  // Storage Configuration
  storage: Object.freeze({
    backend: 'postgresql', // postgresql | sqlite | memory
    maxDomMessages: 200,
    pruneBatchSize: 25,
    gracePeriodMs: 10000,
    bufferSize: 500,
  }),

  // Paths Configuration
  paths: Object.freeze({
    skillsDir: './skills',
    dataDir: './data',
    memoryDb: './data/memory.db',
    sqliteDb: './data/aether.db',
    profilesDir: './profiles',
  }),

  // Artifacts Configuration
  artifacts: Object.freeze({
    fetchTimeout: 12000, // ms
    saveTimeout: 15000, // ms
    maxArtifactSize: 5242880, // 5MB in bytes
  }),

  // Logging Configuration
  logging: Object.freeze({
    level: 'info', // silent | error | warn | info | debug | trace
    maxFileSize: 10485760, // 10MB in bytes
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

  // API Endpoints (relative paths)
  endpoints: Object.freeze({
    health: '/v1/health',
    settings: '/v1/settings',
    models: '/v1/models',
    modelCapabilities: '/v1/models/capabilities',
    modelsConfigSettings: '/v1/models-config/settings',
    modelsConfigModels: '/v1/models-config/models',
    profiles: '/v1/profiles',
    stopGeneration: '/v1/api/stop-generation',
    chatStorage: '/v1/api/chat',
    storageApi: '/v1/api/storage',
    perplexicaDiscover: '/v1/api/discover',
    doclingConvert: '/v1/convert',
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

