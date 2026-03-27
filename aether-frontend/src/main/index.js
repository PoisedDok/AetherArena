// Incoming: Electron lifecycle events, core/config/index.js --- {object, none}
// Processing: Initialize managers, orchestrate services/windows, route IPC --- {4 jobs: JOB_INITIALIZE, JOB_ORCHESTRATE, JOB_ROUTE, JOB_START_SERVICE}
// Outgoing: Windows, backend child processes, IPC channels --- {object, none}

'use strict';

const { app } = require('electron');
const { spawn } = require('child_process');

// Only load .env in development — production uses OS environment + packaged config.
// dotenv.config() searches process.cwd() for .env files; in a packaged app launched
// from Finder, cwd is '/' — loading a stray .env there would inject uncontrolled values.
if (!app.isPackaged) {
  require('dotenv').config();
}
const fs = require('fs');
const path = require('path');
const { logger } = require('../core/utils/logger');
const config = require('../core/config');

// Services
const { getManager: getWindowManager } = require('./windows/WindowManager');
const { getRouter: getIpcRouter } = require('./services/IpcRouter');
const { getManager: getShortcutManager } = require('./services/ShortcutManager');
const { getLauncher: getServiceLauncher } = require('./services/ServiceLauncher');
const { getManager: getPortManager } = require('./services/PortManager');
const { getManager: getSecurityManager } = require('./security/SecurityManager');
const SystemMonitor = require('./services/SystemMonitor');
const { getStorageHandler } = require('./services/StorageIpcHandler');
const { getMemoryHandler } = require('./services/MemoryIpcHandler');
const { getSessionHandler } = require('./services/SessionIpcHandler');

// ============================================================================
// Global State
// ============================================================================

let windowManager = null;
let ipcRouter = null;
let shortcutManager = null;
let serviceLauncher = null;
let portManager = null;
let securityManager = null;
let systemMonitor = null;
let storageHandler = null;
let memoryHandler = null;
let sessionHandler = null;
let backendProcess = null;
let healthMonitoringStop = null;
let backgroundHealthMonitoringTimer = null;

// ============================================================================
// Application Lifecycle
// ============================================================================

function resolveStopBackendScriptPath() {
  const candidates = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'bin', 'stop_backend.sh'));
  }

  if (config?.backend?.backendDir) {
    candidates.push(path.resolve(config.backend.backendDir, 'stop_backend.sh'));
  }

  candidates.push(path.resolve(process.cwd(), 'aether-backend', 'stop_backend.sh'));

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (_) {
      // Continue searching.
    }
  }

  return null;
}

async function runStopBackendScriptFallback(timeoutMs = 30000) {
  const scriptPath = resolveStopBackendScriptPath();
  if (!scriptPath) {
    logger.warn('Fallback mesh teardown skipped: stop_backend.sh not found');
    return;
  }

  logger.warn('Running fallback mesh teardown via stop_backend.sh', {
    scriptPath,
    timeoutMs,
  });

  await new Promise((resolve) => {
    let finished = false;
    let timer = null;

    try {
      const stopProcess = spawn('bash', [scriptPath, '--stop-supabase'], {
        cwd: path.dirname(scriptPath),
        detached: false,
        stdio: 'ignore',
        env: { ...process.env },
      });

      timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        logger.warn('Fallback stop script timed out, force killing', { timeoutMs });
        try { stopProcess.kill('SIGKILL'); } catch (_) { /* ignore */ }
        resolve();
      }, timeoutMs);

      stopProcess.once('error', (err) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        logger.warn('Fallback stop script failed to start', { error: err.message });
        resolve();
      });

      stopProcess.once('exit', (code, signal) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        logger.info('Fallback stop script completed', { code, signal });
        resolve();
      });
    } catch (err) {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      logger.warn('Fallback stop script threw synchronously', { error: err.message });
      resolve();
    }
  });
}

/**
 * Initialize application
 */
async function initialize() {
  logger.info('='.repeat(80));
  logger.info('AetherArena Application Starting');
  logger.info('='.repeat(80));
  // IMPORTANT: Do not touch `config.backend.baseUrl` before PortManager discovery runs.
  // baseUrl is fail-fast by design and requires either env config or a discovered healthy backend.
  logger.info('Configuration (pre-discovery)', {
    shouldSpawnBackend: config.backend.shouldSpawn,
    dev: config.dev,
    nodeEnv: process.env.NODE_ENV,
    electronDev: process.env.ELECTRON_DEV,
  });
  
  try {
    // 1. Initialize security manager
    securityManager = getSecurityManager({
      mode: process.env.NODE_ENV === 'production' ? 'strict' : 'default',
      enableAuditing: config.dev.debugMode,
    });
    await securityManager.initialize();
    logger.info('Security manager initialized');
    
    // 2. Initialize port manager
    portManager = getPortManager();
    logger.info('Port manager initialized');
    
    // 3. Discover backend service (bootstrap only)
    // Hoisted for use after discovery — determines if IPC handlers should be gated
    let hasHealthyBackend = false;
    try {
      logger.info('Discovering backend service...');
      const discovered = await portManager.discoverService('backend');
      if (discovered && discovered.port) {
        // CRITICAL: discoverService() does not mutate registry; we must register it
        // so core/config/port-resolver sees a healthy backend and fail-fast doesn't trigger.
        portManager.registerService('backend', discovered.port, Boolean(discovered.healthy));
      }
      
      const healthyServices = portManager.getHealthyServices();
      logger.info('Service discovery complete', {
        healthy: healthyServices.length,
        services: healthyServices.map(s => ({ name: s.name, url: s.url })),
      });
      
      // Now that discovery ran, it is safe to read backend URL (fail-fast if still missing).
      logger.info('Configuration (post-discovery)', {
        backend: config.backend.baseUrl,
        wsUrl: config.backend.wsUrl,
      });
      
      // Start backend-only health monitoring (skip when dev.skipHealthCheck=true
      // and no healthy backend was discovered — prevents background HTTP polling)
      hasHealthyBackend = portManager.getHealthyServices().some(s => s.name === 'backend');
      if (config.dev.skipHealthCheck && !hasHealthyBackend) {
        logger.info('Skipping health monitoring (dev.skipHealthCheck=true, no backend discovered)');
      } else {
        healthMonitoringStop = portManager.startHealthMonitoring(config.backend.healthCheckInterval);
      }
    } catch (err) {
      // FAIL-FAST: if we are not spawning backend and no static URL is configured,
      // the app cannot function. Do not continue into Storage/Memory IPC init.
      const hasStaticUrl = Boolean(process.env.GURU_API_URL || process.env.backend_url || process.env.BACKEND_URL);
      if (!config.backend.shouldSpawn && !hasStaticUrl) {
        throw err;
      }
      logger.warn('Service discovery failed; falling back to configured backend URL', {
        error: err.message,
      });
    }
    
    // 4. Initialize service launcher
    serviceLauncher = getServiceLauncher({
      backendDir: config.backend.backendDir,
      backendScript: config.backend.entryScript,
    });
    
    // 5. Spawn backend services if configured (non-blocking)
    // ARCHITECTURAL FIX: Do NOT block window creation waiting for backend health.
    // The renderer's OnboardingModal handles backend readiness UX with proper
    // visual feedback during the 10-30min first-run setup.
    if (config.backend.shouldSpawn) {
      const backendService = portManager.getService('backend');
      
      if (backendService && backendService.healthy) {
        logger.info('Backend already running, skipping spawn', {
          url: backendService.url,
        });
      } else {
        await spawnBackend();
        logger.info('Backend spawned (health monitoring deferred to renderer onboarding)');
        
        // Start background health monitoring (non-blocking)
        // This will register the backend once it becomes healthy
        startBackgroundHealthMonitoring();
      }
    } else {
      logger.info('Backend spawning disabled, expecting external backend');
    }
    
    // 6. Initialize window manager
    windowManager = getWindowManager({
      mainWindow: {
        width: config.ui.normalWidth,
        height: config.ui.normalHeight,
        widgetSize: config.ui.widgetSize,
      },
      chatWindow: {
        width: 520,
        height: 640,
      },
      artifactsWindow: {
        width: 560,
        height: 640,
      },
    });
    
    await windowManager.initialize();
    
    // 7. Initialize system monitor
    systemMonitor = new SystemMonitor({
      pollInterval: 250,
      enableLogging: config.dev.debugMode,
    });
    
    systemMonitor.start();
    logger.info('System monitor initialized');
    
    // 8. Initialize storage IPC handler (proxies to backend HTTP API)
    storageHandler = getStorageHandler({
      baseUrl: config.backend.baseUrl,
      timeout: 10000,
      windowManager,
    });
    
    storageHandler.initialize();
    logger.info('Storage IPC handler initialized');

    // 8b. Initialize memory IPC handler (Phase 9B, ticket #135)
    memoryHandler = getMemoryHandler({
      baseUrl: config.backend.baseUrl,
      timeout: 10000,
      windowManager,
    });
    
    memoryHandler.initialize();
    logger.info('Memory IPC handler initialized');

    // 8c. Backend availability gate for main-process IPC handlers
    // When skipHealthCheck=true and no healthy backend, disable HTTP calls
    // in StorageIpcHandler and MemoryIpcHandler to prevent error spam.
    if (config.dev.skipHealthCheck && !hasHealthyBackend) {
      storageHandler.setBackendAvailable(false);
      memoryHandler.setBackendAvailable(false);
      logger.info('IPC handlers set to backend-unavailable mode (dev.skipHealthCheck=true)');
    }

    // 9. Initialize session IPC handler (depends on SessionManager core)
    sessionHandler = getSessionHandler({ windowManager });
    sessionHandler.initialize();
    logger.info('Session IPC handler initialized');
    
    // 10. Initialize IPC router (needs systemMonitor)
    ipcRouter = getIpcRouter(windowManager, {
      systemMonitor,
      validateSource: true,
      logMessages: config.dev.debugMode,
      logErrors: true,
    });
    
    ipcRouter.initialize();
    
    // 11. Initialize shortcut manager
    shortcutManager = getShortcutManager(windowManager, {
      enabled: true,
    });
    
    await shortcutManager.initialize();
    
    logger.info('Application initialization complete');
  } catch (err) {
    logger.error('Application initialization failed', {
      error: err.message,
      stack: err.stack,
    });
    throw err;
  }
}

/**
 * Spawn backend services
 */
async function spawnBackend() {
  if (backendProcess && !backendProcess.killed) {
    logger.warn('Backend already running');
    return;
  }
  
  try {
    logger.info('Starting integrated backend services');
    
    backendProcess = serviceLauncher.launchIntegratedBackend();
    
    logger.info('Integrated backend started', {
      pid: backendProcess.pid,
    });
    
    // Log available services
    const availableServices = serviceLauncher.getAvailableServices();
    logger.info('Available services', { services: availableServices });
  } catch (err) {
    logger.error('Failed to launch backend', {
      error: err.message,
      stack: err.stack,
    });
    
    // Non-fatal: continue without backend
    logger.warn('Continuing without backend');
  }
}

/**
 * Start background health monitoring for the backend
 * Polls until healthy and registers with port manager
 * Does NOT block initialization
 */
function startBackgroundHealthMonitoring() {
  const maxRetries = Math.floor(config.backend.startupTimeout / 1000);
  const retryDelay = 2000; // 2 seconds between retries
  let retries = 0;
  
  const poll = async () => {
    if (!backgroundHealthMonitoringTimer) return; // Aborted by shutdown
    if (retries >= maxRetries) {
      logger.error('Backend failed to become healthy within timeout', {
        timeout: config.backend.startupTimeout,
        retries
      });
      backgroundHealthMonitoringTimer = null;
      return;
    }
    
    try {
      const discovered = await portManager.discoverService('backend');
      if (!backgroundHealthMonitoringTimer) return; // Aborted during await
      if (discovered && discovered.healthy) {
        portManager.registerService('backend', discovered.port, true);
        logger.info('Backend is now healthy (background monitoring)', {
          url: discovered.url,
          port: discovered.port,
          elapsed: retries * retryDelay
        });
        backgroundHealthMonitoringTimer = null;
        return; // Stop polling
      }
    } catch (e) {
      // Keep retrying silently
    }
    
    if (!backgroundHealthMonitoringTimer) return; // Aborted during await
    retries++;
    backgroundHealthMonitoringTimer = setTimeout(poll, retryDelay);
  };
  
  if (backgroundHealthMonitoringTimer) clearTimeout(backgroundHealthMonitoringTimer);
  backgroundHealthMonitoringTimer = setTimeout(poll, retryDelay); // Start first poll after 2s
}

/**
 * Shutdown application
 */
async function shutdown() {
  logger.info('Application shutting down');
  
  try {
    // 0. Instantly hide UI for premium feel (unless relaunching)
    if (!global.isRelaunching) {
      if (windowManager) {
        windowManager.shutdown();
      }
      if (process.platform === 'darwin' && app.dock) {
        app.dock.hide();
      }
    }

    // 1. Stop health monitoring
    if (healthMonitoringStop) {
      healthMonitoringStop();
      healthMonitoringStop = null;
    }
    if (backgroundHealthMonitoringTimer) {
      clearTimeout(backgroundHealthMonitoringTimer);
      backgroundHealthMonitoringTimer = null;
    }
    
    // 1.5 Stop system monitor
    if (systemMonitor) {
      systemMonitor.stop();
      systemMonitor = null;
    }
    
    // 2. Set quitting flag
    if (windowManager) {
      windowManager.setQuitting(true);
    }
    
    // 3. Shutdown storage IPC handler
    if (storageHandler) {
      storageHandler.shutdown();
      storageHandler = null;
    }

    // 3.25 Shutdown memory IPC handler
    if (memoryHandler) {
      memoryHandler.shutdown();
      memoryHandler = null;
    }

    // 3.5 Shutdown session IPC handler
    if (sessionHandler) {
      sessionHandler.shutdown();
      sessionHandler = null;
    }
    
    // 4. Shutdown IPC router
    if (ipcRouter) {
      ipcRouter.shutdown();
    }
    
    // 5. Shutdown shortcut manager
    if (shortcutManager) {
      shortcutManager.shutdown();
    }
    
    // 6. Shutdown security manager
    if (securityManager) {
      securityManager.shutdown();
    }
    
    // 7. Shutdown backend services
    // Backend is spawned detached (own process group) to survive Electron crashes.
    // On normal quit, we must explicitly kill the entire process group.
    // CRITICAL: start_production.sh's graceful_shutdown() runs docker_mesh_down
    // and can require much longer than 15s on larger meshes.
    if (backendProcess && !backendProcess.killed) {
      logger.info('Terminating backend services (detached process group)');
      try {
        // Kill the process group (negative PID) so start_production.sh AND
        // the backend binary both receive SIGTERM for orderly shutdown.
        process.kill(-backendProcess.pid, 'SIGTERM');
      } catch (err) {
        logger.warn('Process group kill failed, trying direct PID', { error: err.message });
        try { process.kill(backendProcess.pid, 'SIGTERM'); } catch (e) { /* already dead */ }
      }

      // Wait up to 60s for graceful shutdown. This allows Docker mesh teardown
      // to finish instead of leaving containers/network alive after app close.
      const gracefulWaitMs = 60000;
      const pollMs = 500;
      const gracefulDeadline = Date.now() + gracefulWaitMs;
      let backendStillAlive = true;

      while (Date.now() < gracefulDeadline) {
        try {
          process.kill(-backendProcess.pid, 0); // check alive
          await new Promise(resolve => setTimeout(resolve, pollMs));
        } catch (_) {
          backendStillAlive = false;
          break;
        }
      }

      if (backendStillAlive) {
        logger.warn('Backend still alive after graceful wait, invoking fallback stop script', {
          gracefulWaitMs,
        });
        await runStopBackendScriptFallback(30000);

        try {
          process.kill(-backendProcess.pid, 0); // check alive
          logger.warn('Backend still alive after fallback, force killing');
          process.kill(-backendProcess.pid, 'SIGKILL');
        } catch (_) {
          // Process group already dead - good.
        }
      }
      logger.info('Backend services terminated');
    }
    
    // 8. Clear port manager registry
    if (portManager) {
      portManager.clearRegistry();
    }
    
    // 9. Shutdown windows (if not already done)
    if (global.isRelaunching && windowManager) {
      windowManager.shutdown();
    }
    
    // 10. Flush logs
    await logger.flush();
    
    logger.info('Application shutdown complete');
  } catch (err) {
    logger.error('Error during shutdown', {
      error: err.message,
      stack: err.stack,
    });
  }
}

// ============================================================================
// Electron Lifecycle Events
// ============================================================================

/**
 * App ready event
 */
app.whenReady().then(async () => {
  try {
    await initialize();
  } catch (err) {
    logger.error('Fatal initialization error', {
      error: err.message,
      stack: err.stack,
    });
    app.quit();
  }
  
  // Activate event (macOS)
  app.on('activate', () => {
    // On macOS, re-create window if all are closed
    if (!windowManager || !windowManager.getMainWindow()) {
      windowManager.initialize().catch(err => {
        logger.error('Failed to recreate windows', {
          error: err.message,
        });
      });
    }
  });
});

/**
 * Quit flag to ensure shutdown only runs once
 */
let isQuitting = false;

/**
 * Before quit event
 */
app.on('before-quit', async (event) => {
  if (!isQuitting) {
    event.preventDefault();
    isQuitting = true;
    
    logger.info('App quit requested, cleaning up...');
    
    // Timeout for shutdown (force quit after 90s).
    // Mesh teardown + fallback stop script can exceed earlier 25s budgets.
    const timeoutId = setTimeout(() => {
      logger.error('Shutdown timeout - force quitting');
      app.exit(1);
    }, 90000);
    
    try {
      await shutdown();
      clearTimeout(timeoutId);
      logger.info('Shutdown complete, exiting...');
      await logger.flush(); // ensure last logs are written
      
      // If relaunch was requested, app.quit() might not trigger it properly
      // after a preventDefault(). Use app.exit() to ensure immediate termination
      // and let the OS handle the queued relaunch.
      app.exit(0);
    } catch (error) {
      logger.error('Shutdown error', { error: error.message });
      clearTimeout(timeoutId);
      app.exit(1);
    }
  }
});

/**
 * Window all closed event
 */
app.on('window-all-closed', () => {
  // Quit on all platforms (including macOS)
  // User expects app to quit when they close all windows or right-click quit
  if (!isQuitting) {
    app.quit();
  }
});

// ============================================================================
// Uncaught Exception Handlers
// ============================================================================

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', {
    error: err.message,
    stack: err.stack,
  });
  
  // Try graceful shutdown
  shutdown().finally(() => {
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// ============================================================================
// Exports (for testing)
// ============================================================================

module.exports = {
  initialize,
  shutdown,
  getWindowManager: () => windowManager,
  getIpcRouter: () => ipcRouter,
  getShortcutManager: () => shortcutManager,
  getServiceLauncher: () => serviceLauncher,
  getPortManager: () => portManager,
  getSecurityManager: () => securityManager,
};
