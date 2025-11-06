'use strict';

/**
 * @.architecture
 * 
 * Incoming: Electron app lifecycle events (ready, before-quit, window-all-closed, will-quit, activate), uncaughtException, unhandledRejection --- {electron_event, Event}
 * Processing: Initialize SecurityManager, PortManager (service discovery + health monitoring), ServiceLauncher (spawn backend if configured), WindowManager (3 windows), IpcRouter, ShortcutManager, orchestrate startup/shutdown, handle lifecycle events, flush logs --- {8 jobs: JOB_INITIALIZE, JOB_INITIALIZE, JOB_GET_STATE, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_ROUTE_BY_TYPE, JOB_WRITE_FILE, JOB_DELEGATE_TO_MODULE}
 * Outgoing: All windows, backend child process, IPC channels --- {electron_app, Application}
 * 
 * 
 * @module main/index
 * 
 * Main Process Entry Point
 * ============================================================================
 * Electron main process entry point.
 * Orchestrates application lifecycle, windows, services, and IPC.
 * 
 * @module main/index
 */

require('dotenv').config();

const { app } = require('electron');
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

// ============================================================================
// Global State
// ============================================================================

let windowManager = null;
let ipcRouter = null;
let shortcutManager = null;
let serviceLauncher = null;
let portManager = null;
let securityManager = null;
let backendProcess = null;
let healthMonitoringStop = null;

// ============================================================================
// Application Lifecycle
// ============================================================================

/**
 * Initialize application
 */
async function initialize() {
  logger.info('='.repeat(80));
  logger.info('Aether Desktop Application Starting');
  logger.info('='.repeat(80));
  logger.info('Configuration', {
    backend: config.backend.baseUrl,
    wsUrl: config.backend.wsUrl,
    shouldSpawnBackend: config.backend.shouldSpawn,
    dev: config.dev,
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
    
    // 3. Discover existing services
    try {
      logger.info('Discovering existing services...');
      await portManager.discoverAllServices();
      
      const healthyServices = portManager.getHealthyServices();
      logger.info('Service discovery complete', {
        healthy: healthyServices.length,
        services: healthyServices.map(s => ({ name: s.name, url: s.url })),
      });
      
      // Start health monitoring
      healthMonitoringStop = portManager.startHealthMonitoring(30000);
    } catch (err) {
      logger.warn('Service discovery failed, will use default URLs', {
        error: err.message,
      });
    }
    
    // 4. Initialize service launcher
    serviceLauncher = getServiceLauncher({
      backendDir: config.backend.backendDir,
      backendScript: 'start_integrated_backend.py',
    });
    
    // 5. Spawn backend services if configured and not already running
    if (config.backend.shouldSpawn) {
      const backendService = portManager.getService('backend');
      
      if (backendService && backendService.healthy) {
        logger.info('Backend already running, skipping spawn', {
          url: backendService.url,
        });
      } else {
      await spawnBackend();
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
    
    // 7. Initialize IPC router
    ipcRouter = getIpcRouter(windowManager, {
      validateSource: true,
      logMessages: config.dev.debugMode,
      logErrors: true,
    });
    
    ipcRouter.initialize();
    
    // 8. Initialize shortcut manager
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
 * Shutdown application
 */
async function shutdown() {
  logger.info('Application shutting down');
  
  try {
    // 1. Stop health monitoring
    if (healthMonitoringStop) {
      healthMonitoringStop();
      healthMonitoringStop = null;
    }
    
    // 2. Set quitting flag
    if (windowManager) {
      windowManager.setQuitting(true);
    }
    
    // 3. Shutdown IPC router
    if (ipcRouter) {
      ipcRouter.shutdown();
    }
    
    // 4. Shutdown shortcut manager
    if (shortcutManager) {
      shortcutManager.shutdown();
    }
    
    // 5. Shutdown security manager
    if (securityManager) {
      securityManager.shutdown();
    }
    
    // 6. Shutdown backend services
    if (backendProcess && !backendProcess.killed) {
      logger.info('Terminating backend services');
      await serviceLauncher.killProcess(backendProcess, 15000);
      logger.info('Backend services terminated');
    }
    
    // 7. Clear port manager registry
    if (portManager) {
      portManager.clearRegistry();
    }
    
    // 8. Shutdown windows
    if (windowManager) {
      windowManager.shutdown();
    }
    
    // 9. Flush logs
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
 * Before quit event
 */
app.on('before-quit', async () => {
  await shutdown();
});

/**
 * Window all closed event
 */
app.on('window-all-closed', () => {
  // On macOS, don't quit when all windows closed (keep in dock)
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Will quit event
 */
app.on('will-quit', async (event) => {
  // Prevent default quit to perform cleanup
  event.preventDefault();
  
  await shutdown();
  
  // Now actually quit
  app.exit(0);
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

