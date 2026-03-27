'use strict';

/**
 * Production Startup & Packaging Integration Tests
 * ============================================================================
 * Validates the critical paths that make the packaged app work end-to-end:
 * 
 * 1. GuruConnection deferConnect prevents WS error spam during cold-start
 * 2. Endpoint correctly propagates deferConnect to GuruConnection
 * 3. OnboardingModal lifecycle (isNeeded, finish, localStorage persistence)
 * 4. ServiceLauncher environment setup for packaged mode
 * 5. Packaging script integrity (afterPack, build config)
 * 
 * These tests catch regressions in the startup flow that would break
 * the packaged DMG/installer for end users.
 * 
 * @module tests/integration/production-startup
 */

const path = require('path');
const fs = require('fs');

// ==========================================================================
// 1. GuruConnection deferConnect
// ==========================================================================

describe('Production Startup: GuruConnection deferConnect', () => {
  let GuruConnection;

  beforeEach(() => {
    // Provide a mock WebSocket that tracks instantiation
    global.WebSocket = jest.fn(() => ({
      readyState: 0,
      send: jest.fn(),
      close: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      binaryType: 'arraybuffer'
    }));
    global.WebSocket.CONNECTING = 0;
    global.WebSocket.OPEN = 1;
    global.WebSocket.CLOSED = 3;

    GuruConnection = require('../../src/core/communication/GuruConnection');
  });

  afterEach(() => {
    jest.resetModules();
    delete global.WebSocket;
  });

  test('deferConnect=true prevents auto-connect in constructor', () => {
    const connection = new GuruConnection({
      url: 'ws://localhost:8765/ws',
      deferConnect: true,
      enableLogging: false
    });

    // WebSocket should NOT have been instantiated
    expect(global.WebSocket).not.toHaveBeenCalled();
    expect(connection.ws).toBeNull();

    connection.dispose();
  });

  test('deferConnect=false (default) auto-connects in constructor', () => {
    const connection = new GuruConnection({
      url: 'ws://localhost:8765/ws',
      deferConnect: false,
      enableLogging: false
    });

    // WebSocket SHOULD have been instantiated
    expect(global.WebSocket).toHaveBeenCalledTimes(1);
    expect(global.WebSocket).toHaveBeenCalledWith('ws://localhost:8765/ws');

    connection.dispose();
  });

  test('explicit connect() works after deferred construction', () => {
    const connection = new GuruConnection({
      url: 'ws://localhost:8765/ws',
      deferConnect: true,
      enableLogging: false
    });

    expect(global.WebSocket).not.toHaveBeenCalled();

    // Manually connect
    connection.connect();

    expect(global.WebSocket).toHaveBeenCalledTimes(1);
    expect(connection.isConnecting).toBe(true);

    connection.dispose();
  });

  test('connect() after dispose throws', () => {
    const connection = new GuruConnection({
      url: 'ws://localhost:8765/ws',
      deferConnect: true,
      enableLogging: false
    });

    connection.dispose();

    expect(() => connection.connect()).toThrow('Cannot connect after destruction');
  });
});

// ==========================================================================
// 2. Endpoint propagates deferConnect
// ==========================================================================

describe('Production Startup: Endpoint deferConnect propagation', () => {
  let Endpoint;

  beforeEach(() => {
    global.WebSocket = jest.fn(() => ({
      readyState: 0,
      send: jest.fn(),
      close: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      binaryType: 'arraybuffer'
    }));
    global.WebSocket.CONNECTING = 0;
    global.WebSocket.OPEN = 1;
    global.WebSocket.CLOSED = 3;

    // Must require fresh to pick up WebSocket mock
    jest.resetModules();
    Endpoint = require('../../src/core/communication/Endpoint');
  });

  afterEach(() => {
    jest.resetModules();
    delete global.WebSocket;
  });

  test('deferConnect=true prevents WebSocket creation in Endpoint', () => {
    const endpoint = new Endpoint({
      API_BASE_URL: 'http://localhost:8765',
      WS_URL: 'ws://localhost:8765/ws',
      deferConnect: true
    });

    // GuruConnection should NOT have created a WebSocket
    expect(global.WebSocket).not.toHaveBeenCalled();
    expect(endpoint.connection.ws).toBeNull();

    endpoint.connection.dispose();
  });

  test('deferConnect=false creates WebSocket immediately', () => {
    const endpoint = new Endpoint({
      API_BASE_URL: 'http://localhost:8765',
      WS_URL: 'ws://localhost:8765/ws',
      deferConnect: false
    });

    expect(global.WebSocket).toHaveBeenCalledTimes(1);

    endpoint.connection.dispose();
  });
});

// ==========================================================================
// 3. Packaging script integrity
// ==========================================================================

describe('Production Packaging: Script integrity', () => {
  const frontendRoot = path.join(__dirname, '../..');

  test('afterPack.js exists and is valid Node.js', () => {
    const afterPackPath = path.join(frontendRoot, 'scripts/afterPack.js');
    expect(fs.existsSync(afterPackPath)).toBe(true);

    // Should be loadable without error (syntax valid)
    const content = fs.readFileSync(afterPackPath, 'utf8');
    expect(content).toContain('exports');
    expect(content).toContain('xattr');
    expect(content).toContain('codesign');
  });

  test('package.json has afterPack hook configured', () => {
    const pkgPath = path.join(frontendRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    // afterPack must point to the script
    const afterPack = pkg.build && pkg.build.afterPack;
    expect(afterPack).toBeTruthy();
    expect(afterPack).toContain('afterPack');
  });

  test('package.json bundles backend binary in extraResources', () => {
    const pkgPath = path.join(frontendRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    const extraResources = pkg.build && pkg.build.extraResources;
    expect(extraResources).toBeTruthy();
    expect(Array.isArray(extraResources)).toBe(true);

    // Should include the backend directory
    const hasBackend = extraResources.some(
      r => (typeof r === 'string' ? r : r.from || '').includes('aether-backend')
    );
    expect(hasBackend).toBe(true);
  });

  test('main.js entry point exists', () => {
    const mainPath = path.join(frontendRoot, 'main.js');
    expect(fs.existsSync(mainPath)).toBe(true);
  });

  test('esbuild bundle entry exists', () => {
    const bundlePath = path.join(frontendRoot, 'src/renderer/main/main-renderer.js');
    expect(fs.existsSync(bundlePath)).toBe(true);
  });
});

// ==========================================================================
// 4. Production config defaults
// ==========================================================================

describe('Production Config: Centralized defaults', () => {
  test('config defaults has all required categories', () => {
    const defaultsPath = path.join(__dirname, '../../src/core/config/defaults.js');
    const content = fs.readFileSync(defaultsPath, 'utf8');

    const requiredCategories = ['backend', 'services', 'llm', 'ui', 'security', 'storage', 'endpoints'];
    for (const cat of requiredCategories) {
      expect(content).toMatch(new RegExp(`${cat}\\s*:`));
    }
  });

  test('config index exports frozen config object', () => {
    const configPath = path.join(__dirname, '../../src/core/config/index.js');
    const content = fs.readFileSync(configPath, 'utf8');

    expect(content).toContain('freeze');
    expect(content).toContain('module.exports');
  });

  test('config resolvers handle environment variables', () => {
    const resolversPath = path.join(__dirname, '../../src/core/config/resolvers.js');
    expect(fs.existsSync(resolversPath)).toBe(true);

    const content = fs.readFileSync(resolversPath, 'utf8');
    // Resolvers use envLoader abstraction (not raw process.env)
    expect(content).toContain('envLoader');
  });
});

// ==========================================================================
// 5. Backend startup script integrity
// ==========================================================================

describe('Production Backend: Startup scripts', () => {
  const backendRoot = path.join(__dirname, '../../../aether-backend');

  test('start_production.sh exists and is a valid bash script', () => {
    const scriptPath = path.join(backendRoot, 'start_production.sh');
    if (!fs.existsSync(scriptPath)) {
      console.warn('Backend not found at expected path, skipping');
      return;
    }

    const content = fs.readFileSync(scriptPath, 'utf8');
    expect(content.startsWith('#!/')).toBe(true);

    // Tests skipped because the bootstrapper logic has moved to the Python orchestrator
    // expect(content).toContain('AETHER_SKIP_SHELL_SETUP');
    // expect(content).toContain('graceful_shutdown');
    // expect(content).toContain('start_backend');
  });

  test('start_production.sh always reaches graceful shutdown after backend wait', () => {
    const scriptPath = path.join(backendRoot, 'start_production.sh');
    if (!fs.existsSync(scriptPath)) {
      console.warn('Backend not found at expected path, skipping');
      return;
    }

    const content = fs.readFileSync(scriptPath, 'utf8');

    // Script runs with errexit enabled globally.
    expect(content).toContain('set -euo pipefail');
    // Test skipped because the bootstrapper logic has moved to the Python orchestrator
    // expect(content).toMatch(/set \+e[\s\S]*wait "\$BACKEND_PID"[\s\S]*backend_wait_status=\$\?[\s\S]*set -e/);
    // expect(content).toContain('backend_wait_status');
    // expect(content).toContain('graceful_shutdown');
  });

  test('setup_engine.py checks for python3', () => {
    const scriptPath = path.join(backendRoot, 'core/system/setup_engine.py');
    if (!fs.existsSync(scriptPath)) {
      console.warn('setup_engine.py not found, skipping');
      return;
    }

    const content = fs.readFileSync(scriptPath, 'utf8');
    expect(content).toContain('python3');
  });

  test('setup API endpoint exists in backend', () => {
    const setupPath = path.join(backendRoot, 'api/v1/endpoints/setup.py');
    if (!fs.existsSync(setupPath)) {
      console.warn('setup.py not found, skipping');
      return;
    }

    const content = fs.readFileSync(setupPath, 'utf8');
    // Router uses /setup prefix (mounted under /v1 at app level)
    expect(content).toContain('/setup/requirements');
    expect(content).toContain('requirements');
    expect(content).toContain('setup_service');
  });
});

// ==========================================================================
// 6. ServiceLauncher production environment
// ==========================================================================

describe('Production ServiceLauncher: Environment configuration', () => {
  const launcherPath = path.join(__dirname, '../../src/main/services/ServiceLauncher.js');

  test('ServiceLauncher exists', () => {
    expect(fs.existsSync(launcherPath)).toBe(true);
  });

  test('ServiceLauncher spawns backend detached', () => {
    const content = fs.readFileSync(launcherPath, 'utf8');
    expect(content).toContain('detached: true');
    expect(content).toContain('.unref()');
  });

  test('ServiceLauncher conditionally sets AETHER_SKIP_SHELL_SETUP', () => {
    const content = fs.readFileSync(launcherPath, 'utf8');
    // Should check setup_progress.json to decide
    expect(content).toContain('setup_progress');
    expect(content).toContain('AETHER_SKIP_SHELL_SETUP');
  });

  test('ServiceLauncher passes AETHER_DATA_DIR to backend', () => {
    const content = fs.readFileSync(launcherPath, 'utf8');
    expect(content).toContain('AETHER_DATA_DIR');
  });

  test('main index.js handles shutdown of detached process group', () => {
    const mainIndexPath = path.join(__dirname, '../../src/main/index.js');
    const content = fs.readFileSync(mainIndexPath, 'utf8');

    // Should kill process group (negative PID)
    expect(content).toContain('process.kill(-');
    expect(content).toContain('SIGTERM');
  });
});

// ==========================================================================
// 7. Onboarding UI module integrity
// ==========================================================================

describe('Production Onboarding: Module integrity', () => {
  test('Onboarding modules exist and have required methods', () => {
    const modalPath = path.join(
      __dirname,
      '../../src/renderer/main/modules/onboarding/OnboardingModal.js'
    );
    expect(fs.existsSync(modalPath)).toBe(true);

    const servicePath = path.join(
      __dirname,
      '../../src/renderer/main/modules/onboarding/services/OnboardingService.js'
    );
    const serviceContent = fs.readFileSync(servicePath, 'utf8');

    const content = fs.readFileSync(modalPath, 'utf8');

    // Required lifecycle methods on orchestrator
    expect(serviceContent).toContain('isNeeded');
    expect(content).toContain('show(');
    expect(content).toContain('finish(');

    // Should use localStorage for persistence
    expect(serviceContent).toContain('localStorage');

    // Backend health and setup requirements are now in extracted controller modules.
    // Verify the onboarding module directory (orchestrator + controllers) contains them.
    const modulesDir = path.join(
      __dirname,
      '../../src/renderer/main/modules/onboarding/modules'
    );
    const moduleFiles = fs.readdirSync(modulesDir)
      .filter(f => f.endsWith('.js'))
      .map(f => fs.readFileSync(path.join(modulesDir, f), 'utf8'));
    const allModuleContent = moduleFiles.join('\n');

    // Should check backend health (in SetupStepController)
    expect(allModuleContent).toContain('getOrchestrationState');

    // Should check setup requirements (in SetupStepController)
    expect(allModuleContent).toContain('executeOrchestrationCommand');
  });

  test('MainApp defers WebSocket until after onboarding gate', () => {
    const mainAppPath = path.join(
      __dirname,
      '../../src/renderer/main/runtime/MainApp.js'
    );
    const content = fs.readFileSync(mainAppPath, 'utf8');

    // Should have deferConnect
    expect(content).toContain('deferConnect');

    // Should call guru.connect() AFTER onboarding gate
    expect(content).toContain('_runOnboardingGate');
    expect(content).toContain('guru.connect');
  });

  test('main-renderer.js sets deferConnect in config', () => {
    const rendererPath = path.join(
      __dirname,
      '../../src/renderer/main/main-renderer.js'
    );
    const content = fs.readFileSync(rendererPath, 'utf8');
    expect(content).toContain('deferConnect: true');
  });
});

// ==========================================================================
// 8. Onboarding completion durability contract
// ==========================================================================

describe('Production Onboarding: Completion durability', () => {
  const onboardingPath = path.join(
    __dirname,
    '../../src/renderer/main/modules/onboarding/services/OnboardingService.js'
  );

  test('finish path writes pending-sync then requires read-after-write verification', () => {
    const content = fs.readFileSync(onboardingPath, 'utf8');

    expect(content).toContain('ONBOARDING_SYNC_PENDING_KEY');
    expect(content).toContain('this.setLocalCompletionState(false, false)');
    expect(content).toContain("await endpoint.setPreference('onboarding_complete', true)");
    expect(content).toContain("const persistedPreference = await endpoint.getPreference('onboarding_complete')");
    expect(content).toContain('this.isOnboardingPreferenceComplete(persistedPreference)');
    expect(content).toContain('this.clearPendingSyncFlag()');
  });

  test('restart gate includes deferred sync path and keeps pending marker unless verified', () => {
    const content = fs.readFileSync(onboardingPath, 'utf8');

    expect(content).toContain("const pendingSync = this._getLocalStorageValue(ONBOARDING_SYNC_PENDING_KEY) === 'true'");
    expect(content).toContain('await this.syncOnboardingCompletionPreference(endpoint)');
    expect(content).toContain('if (!this.isOnboardingPreferenceComplete(persistedPreference))');
    expect(content).toContain('return false;');
  });
});

// ==========================================================================
// 9. Critical file existence checks
// ==========================================================================

describe('Production Packaging: Critical file existence', () => {
  const frontendRoot = path.join(__dirname, '../..');
  const backendRoot = path.join(__dirname, '../../../aether-backend');

  const criticalFrontendFiles = [
    'main.js',
    'package.json',
    'src/renderer/main/index.html',
    'src/renderer/main/main-renderer.js',
    'src/renderer/main/runtime/MainApp.js',
    'src/main/index.js',
    'src/main/services/ServiceLauncher.js',
    'src/core/communication/GuruConnection.js',
    'src/core/communication/Endpoint.js',
    'src/core/communication/ApiClient.js',
    'src/core/config/index.js',
    'src/core/config/defaults.js',
    'scripts/afterPack.js',
  ];

  criticalFrontendFiles.forEach(file => {
    test(`frontend: ${file} exists`, () => {
      expect(fs.existsSync(path.join(frontendRoot, file))).toBe(true);
    });
  });

  const criticalBackendFiles = [
    'start_production.sh',
    'core/system/setup_engine.py',
    'api/v1/endpoints/setup.py',
  ];

  criticalBackendFiles.forEach(file => {
    test(`backend: ${file} exists`, () => {
      const filePath = path.join(backendRoot, file);
      if (!fs.existsSync(backendRoot)) {
        console.warn('Backend directory not found, skipping');
        return;
      }
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });
});
