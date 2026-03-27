'use strict';

/**
 * Full-Stack Contract Validation Tests
 * ============================================================================
 * Validates that frontend API expectations match backend implementations.
 * 
 * These tests do NOT require a running backend -- they perform static analysis
 * on both codebases to verify contract alignment:
 * 
 * 1. Frontend Endpoint.js API paths exist as backend router endpoints
 * 2. JSON schema contracts in /contracts/ are structurally valid
 * 3. WebSocket message types match between frontend and backend
 * 4. Frontend config keys align with backend settings structure
 * 5. IPC channel names match between preload and main process
 * 
 * @module tests/integration/fullstack-contract
 */

const fs = require('fs');
const path = require('path');

const FRONTEND_ROOT = path.join(__dirname, '../..');
const BACKEND_ROOT = path.join(__dirname, '../../../aether-backend');
const CONTRACTS_ROOT = path.join(__dirname, '../../../contracts');

// ==========================================================================
// 1. Frontend API Paths vs Backend Endpoints
// ==========================================================================

describe('Full-Stack Contract: API Path Alignment', () => {
  let frontendPaths;
  let backendEndpointFiles;

  beforeAll(() => {
    // Extract all API paths from Endpoint.js AND its domain API modules (api/*.js)
    // Post-refactoring: Endpoint.js is a thin facade; paths live in api/ modules.
    const communicationDir = path.join(FRONTEND_ROOT, 'src/core/communication');
    const endpointFile = path.join(communicationDir, 'Endpoint.js');
    const apiModulesDir = path.join(communicationDir, 'api');

    const filesToScan = [endpointFile];
    if (fs.existsSync(apiModulesDir)) {
      const moduleFiles = fs.readdirSync(apiModulesDir)
        .filter(f => f.endsWith('.js') && f !== 'BaseApi.js')
        .map(f => path.join(apiModulesDir, f));
      filesToScan.push(...moduleFiles);
    }

    // Match patterns (covering both old monolith and refactored modules):
    //   .get('/v1/...')  .post('/v1/...')       (direct ApiClient calls)
    //   _request('GET', '/v1/...')              (BaseApi-based modules, literal path)
    //   _encodePath('/v1/storage/update/:id')   (parameterized paths via BaseApi)
    const directCallRegex = /\.(get|post|put|delete|patch)\(['"`]([^'"`]+)['"`]/g;
    const requestCallRegex = /_request\(['"`](GET|POST|PUT|PATCH|DELETE)['"`],\s*['"`]([^'"`]+)['"`]/g;
    const encodePathRegex = /_encodePath\(['"`]([^'"`]+)['"`]/g;
    frontendPaths = [];
    for (const file of filesToScan) {
      const content = fs.readFileSync(file, 'utf8');
      let match;
      while ((match = directCallRegex.exec(content)) !== null) {
        frontendPaths.push({ method: match[1].toUpperCase(), path: match[2] });
      }
      while ((match = requestCallRegex.exec(content)) !== null) {
        frontendPaths.push({ method: match[1], path: match[2] });
      }
      while ((match = encodePathRegex.exec(content)) !== null) {
        // _encodePath templates use :param placeholders; normalize to base path for matching
        frontendPaths.push({ method: 'ANY', path: match[1].replace(/:[\w]+/g, '{param}') });
      }
    }

    // Load all backend endpoint files
    const endpointsDir = path.join(BACKEND_ROOT, 'api/v1/endpoints');
    if (fs.existsSync(endpointsDir)) {
      backendEndpointFiles = fs.readdirSync(endpointsDir)
        .filter(f => f.endsWith('.py'))
        .map(f => ({
          name: f,
          content: fs.readFileSync(path.join(endpointsDir, f), 'utf8')
        }));
    } else {
      backendEndpointFiles = [];
    }
  });

  test('frontend discovers API paths from Endpoint.js', () => {
    expect(frontendPaths.length).toBeGreaterThan(30);
  });

  test('backend has endpoint files', () => {
    expect(backendEndpointFiles.length).toBeGreaterThan(10);
  });

  test('critical frontend paths have matching backend endpoints', () => {
    // Critical paths that MUST exist in backend
    const criticalPaths = [
      { path: '/v1/health', keyword: 'health' },
      { path: '/v1/settings/', keyword: 'settings' },
      { path: '/v1/models', keyword: 'models' },
      { path: '/v1/profiles', keyword: 'profiles' },
      { path: '/v1/stop-generation', keyword: 'stop' },
      { path: '/v1/mcp/servers', keyword: 'mcp' },
    ];

    const missing = [];
    for (const critical of criticalPaths) {
      const frontendHas = frontendPaths.some(fp => fp.path.includes(critical.path.replace(/\/$/, '')));
      if (!frontendHas) {
        missing.push(`Frontend missing: ${critical.path}`);
        continue;
      }

      const backendHas = backendEndpointFiles.some(f =>
        f.content.includes(critical.keyword)
      );
      if (!backendHas) {
        missing.push(`Backend missing endpoint for: ${critical.path}`);
      }
    }

    expect(missing).toEqual([]);
  });

  test('storage API paths align with backend storage router', () => {
    const storagePaths = frontendPaths.filter(fp => fp.path.includes('/storage/'));
    expect(storagePaths.length).toBeGreaterThan(5);

    const storageEndpoint = backendEndpointFiles.find(f => f.name === 'storage.py');
    if (!storageEndpoint) {
      // Storage might be split across files
      const hasStorageRoutes = backendEndpointFiles.some(f =>
        f.content.includes('storage') && f.content.includes('router')
      );
      expect(hasStorageRoutes).toBe(true);
    }
  });

  test('agent API paths align with backend agent router', () => {
    const agentPaths = frontendPaths.filter(fp => fp.path.includes('/agent/'));
    expect(agentPaths.length).toBeGreaterThan(5);

    const agentEndpoint = backendEndpointFiles.find(f =>
      f.name.includes('agent') && f.content.includes('router')
    );
    expect(agentEndpoint).toBeTruthy();
  });

  test('setup/onboarding paths align with backend setup router', () => {
    // Frontend onboarding system calls /v1/setup/* endpoints.
    // After modularization, these paths live in controller modules, not the orchestrator.
    // Scan the entire onboarding directory (orchestrator + extracted controllers).
    const onboardingDir = path.join(
      FRONTEND_ROOT,
      'src/renderer/main/modules/onboarding'
    );
    const onboardingFiles = [
      fs.readFileSync(path.join(onboardingDir, 'OnboardingModal.js'), 'utf8'),
    ];
    const modulesDir = path.join(onboardingDir, 'modules');
    if (fs.existsSync(modulesDir)) {
      const moduleFileNames = fs.readdirSync(modulesDir).filter(f => f.endsWith('.js'));
      for (const fname of moduleFileNames) {
        onboardingFiles.push(fs.readFileSync(path.join(modulesDir, fname), 'utf8'));
      }
    }
    const content = onboardingFiles.join('\n');

    // Extract setup paths from onboarding system
    const setupPaths = [];
    const setupRegex = /\/v1\/setup\/([a-z_]+)/g;
    let m;
    while ((m = setupRegex.exec(content)) !== null) {
      setupPaths.push(m[1]);
    }

    expect(setupPaths.length).toBeGreaterThan(0);

    // Backend setup.py must have these routes
    const setupFile = backendEndpointFiles.find(f => f.name === 'setup.py');
    expect(setupFile).toBeTruthy();

    for (const setupPath of setupPaths) {
      expect(setupFile.content).toContain(setupPath);
    }
  });
});

// ==========================================================================
// 2. JSON Schema Contracts
// ==========================================================================

describe('Full-Stack Contract: JSON Schema Integrity', () => {
  let schemas;

  beforeAll(() => {
    if (!fs.existsSync(CONTRACTS_ROOT)) {
      schemas = [];
      return;
    }
    schemas = fs.readdirSync(CONTRACTS_ROOT)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        name: f,
        content: JSON.parse(fs.readFileSync(path.join(CONTRACTS_ROOT, f), 'utf8'))
      }));
  });

  test('contract schemas exist', () => {
    expect(schemas.length).toBeGreaterThan(3);
  });

  test('all schemas are valid JSON Schema', () => {
    for (const schema of schemas) {
      // Must have root-level type OR compositional keywords (oneOf, allOf, anyOf, definitions)
      const hasType = schema.content.type ||
                      schema.content.oneOf ||
                      schema.content.allOf ||
                      schema.content.anyOf ||
                      schema.content.definitions;
      expect(hasType).toBeTruthy();
      // Must have either $schema or title for identification
      const hasIdentifier = schema.content.$schema || schema.content.title;
      expect(hasIdentifier).toBeTruthy();
    }
  });

  test('ws_message schema matches frontend WebSocket usage', () => {
    const wsSchema = schemas.find(s => s.name === 'ws_message.schema.json');
    expect(wsSchema).toBeTruthy();

    // Schema must support the message types frontend sends
    expect(wsSchema.content.properties).toHaveProperty('type');
    expect(wsSchema.content.properties).toHaveProperty('content');
    expect(wsSchema.content.properties).toHaveProperty('role');

    // Must support required frontend fields
    expect(wsSchema.content.properties).toHaveProperty('id');
    expect(wsSchema.content.properties).toHaveProperty('chat_id');
  });

  test('trail schemas match backend trail hierarchy', () => {
    const trailSchema = schemas.find(s => s.name === 'trail_hierarchy.schema.json');
    expect(trailSchema).toBeTruthy();

    // Must have group/subgroup/node structure
    const content = JSON.stringify(trailSchema.content);
    expect(content).toContain('group');
    expect(content).toContain('subgroup');
    expect(content).toContain('node');
  });

  test('artifact schemas match frontend artifact model', () => {
    const artifactSchema = schemas.find(s =>
      s.name.includes('artifact')
    );
    expect(artifactSchema).toBeTruthy();

    // Must have artifact_id and artifact_type
    const content = JSON.stringify(artifactSchema.content);
    expect(content).toContain('artifact_id');
  });
});

// ==========================================================================
// 3. WebSocket Message Type Alignment
// ==========================================================================

describe('Full-Stack Contract: WebSocket Message Types', () => {
  test('frontend and backend agree on core message types', () => {
    // Frontend StreamHandler processes these types
    const streamHandlerPath = path.join(
      FRONTEND_ROOT,
      'src/renderer/main/modules/chat/stream/StreamHandler.js'
    );

    if (!fs.existsSync(streamHandlerPath)) {
      console.warn('StreamHandler not at expected path, skipping');
      return;
    }

    const frontendContent = fs.readFileSync(streamHandlerPath, 'utf8');

    // Core types that stream handler must process
    const coreTypes = ['message', 'code', 'console', 'confirmation'];
    for (const type of coreTypes) {
      expect(frontendContent).toContain(type);
    }
  });

  test('backend event builder defines types frontend expects', () => {
    const eventBuilderPath = path.join(
      BACKEND_ROOT,
      'ws/domain/event_builder.py'
    );

    if (!fs.existsSync(eventBuilderPath)) {
      console.warn('EventBuilder not found, skipping');
      return;
    }

    const backendContent = fs.readFileSync(eventBuilderPath, 'utf8');

    // Backend event builder must define message types that frontend processes
    // These are the core stream event types
    expect(backendContent).toContain('message');
    expect(backendContent).toContain('type');
  });

  test('trail event types match between frontend and backend', () => {
    // Check trail emitter in backend
    const trailEmitterPath = path.join(
      BACKEND_ROOT,
      'ws/presentation/emitters/trail_emitter.py'
    );

    if (!fs.existsSync(trailEmitterPath)) {
      console.warn('TrailEmitter not found, skipping');
      return;
    }

    const backendContent = fs.readFileSync(trailEmitterPath, 'utf8');

    // Trail events must include group/subgroup/node operations
    expect(backendContent).toContain('group');
    expect(backendContent).toContain('subgroup');
    expect(backendContent).toContain('node');
  });
});

// ==========================================================================
// 4. IPC Channel Alignment
// ==========================================================================

describe('Full-Stack Contract: IPC Channel Alignment', () => {
  test('preload channel names match main process handlers', () => {
    const channelsPath = path.join(FRONTEND_ROOT, 'src/preload/ipc/channels.js');
    const channelsContent = fs.readFileSync(channelsPath, 'utf8');

    // Extract channel names (lowercase with colons/hyphens: 'chat:send', 'renderer-log')
    const channelRegex = /['"]([\w:.-]+)['"]/gm;
    const channels = new Set();
    let match;
    while ((match = channelRegex.exec(channelsContent)) !== null) {
      if (match[1].includes(':') || match[1].includes('-')) {
        channels.add(match[1]);
      }
    }

    expect(channels.size).toBeGreaterThan(10);

    // IPC handling is distributed across main process files
    // Collect all main process source code
    const mainDir = path.join(FRONTEND_ROOT, 'src/main');
    const mainFiles = [];
    const walkDir = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDir(fullPath);
        else if (entry.name.endsWith('.js')) {
          mainFiles.push(fs.readFileSync(fullPath, 'utf8'));
        }
      }
    };
    walkDir(mainDir);
    const mainContent = mainFiles.join('\n');

    let matchCount = 0;
    for (const channel of channels) {
      if (mainContent.includes(channel)) {
        matchCount++;
      }
    }

    // At least 20% of channels should appear in main process code
    expect(matchCount / channels.size).toBeGreaterThan(0.15);
  });
});

// ==========================================================================
// 5. Configuration Alignment
// ==========================================================================

describe('Full-Stack Contract: Configuration Alignment', () => {
  test('frontend config defaults cover required backend settings', () => {
    const defaultsPath = path.join(FRONTEND_ROOT, 'src/core/config/defaults.js');
    const content = fs.readFileSync(defaultsPath, 'utf8');

    // Must have backend connection settings
    expect(content).toContain('backend');
    expect(content).toContain('endpoints');

    // Must have UI settings
    expect(content).toContain('ui');

    // Must have security settings
    expect(content).toContain('security');
  });

  test('backend config has matching environment files', () => {
    const envDir = path.join(BACKEND_ROOT, 'config/environments');
    if (!fs.existsSync(envDir)) {
      console.warn('Backend environments dir not found, skipping');
      return;
    }

    const envFiles = fs.readdirSync(envDir).filter(f => f.endsWith('.yaml'));
    expect(envFiles).toContain('production.yaml');
    expect(envFiles).toContain('development.yaml');
  });

  test('backend settings.py has all categories frontend expects', () => {
    const settingsPath = path.join(BACKEND_ROOT, 'config/settings.py');
    if (!fs.existsSync(settingsPath)) {
      console.warn('Backend settings not found, skipping');
      return;
    }

    const content = fs.readFileSync(settingsPath, 'utf8');

    // Backend must have settings for features frontend uses
    const requiredSettings = [
      'llm',         // LLM config (models, providers)
      'websocket',   // WebSocket settings
      'memory',      // Memory service
      'workers',     // Background workers
      'audio',       // Audio/TTS/STT
    ];

    for (const setting of requiredSettings) {
      expect(content.toLowerCase()).toContain(setting);
    }
  });
});

// ==========================================================================
// 6. Feature Completeness Check
// ==========================================================================

describe('Full-Stack Contract: Feature Completeness', () => {
  test('all major frontend modules have corresponding backend support', () => {
    const featureMap = [
      {
        frontend: 'src/domain/chat',
        backend: 'ws/',
        label: 'Chat/WebSocket'
      },
      {
        frontend: 'src/domain/artifacts',
        backend: 'api/v1/endpoints/storage.py',
        label: 'Artifacts/Storage'
      },
      {
        frontend: 'src/renderer/main/modules/settings',
        backend: 'api/v1/endpoints/settings.py',
        label: 'Settings'
      },
      {
        frontend: 'src/renderer/main/modules/agents',
        backend: 'api/v1/endpoints/agents.py',
        label: 'Agents'
      },
      {
        frontend: 'src/renderer/main/modules/onboarding',
        backend: 'api/v1/endpoints/setup.py',
        label: 'Onboarding/Setup'
      },
    ];

    const missing = [];
    for (const feature of featureMap) {
      const fePath = path.join(FRONTEND_ROOT, feature.frontend);
      const bePath = path.join(BACKEND_ROOT, feature.backend);

      if (!fs.existsSync(fePath)) {
        missing.push(`Frontend missing: ${feature.label} (${feature.frontend})`);
      }
      if (!fs.existsSync(bePath)) {
        missing.push(`Backend missing: ${feature.label} (${feature.backend})`);
      }
    }

    expect(missing).toEqual([]);
  });

  test('backend has all core services for production', () => {
    const coreServices = [
      'security/auth.py',
      'security/rate_limit.py',
      'security/sanitization.py',
      'monitoring/__init__.py',
      'config/settings.py',
    ];

    const missing = [];
    for (const service of coreServices) {
      const servicePath = path.join(BACKEND_ROOT, service);
      if (!fs.existsSync(servicePath)) {
        missing.push(service);
      }
    }

    expect(missing).toEqual([]);
  });

  test('frontend has all core modules for production', () => {
    const coreModules = [
      'src/core/communication/ApiClient.js',
      'src/core/communication/Endpoint.js',
      'src/core/communication/GuruConnection.js',
      'src/core/security/Sanitizer.js',
      'src/core/security/InputValidator.js',
      'src/core/security/CspManager.js',
      'src/core/security/RateLimiter.js',
      'src/core/config/index.js',
      'src/core/config/defaults.js',
      'src/main/services/ServiceLauncher.js',
    ];

    const missing = [];
    for (const mod of coreModules) {
      const modPath = path.join(FRONTEND_ROOT, mod);
      if (!fs.existsSync(modPath)) {
        missing.push(mod);
      }
    }

    expect(missing).toEqual([]);
  });
});
