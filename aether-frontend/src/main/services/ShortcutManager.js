'use strict';

/**
 * @.architecture
 * INCOMING: AppMain.initialize() --- {config_types.shortcut_config, object}
 * PROCESSING: Register global keyboard shortcuts, delegate window operations to WindowManager --- {5 jobs: JOB_DELEGATE_TO_MODULE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * OUTGOING: WindowManager.toggleWidgetMode/createChatWindow/createArtifactsWindow, ChatWindow/ArtifactsWindow (IPC: chat:ensure-visible, artifacts:ensure-visible) --- {void, function_call}
 */

/**
 * Shortcut Manager
 * ============================================================================
 * Manages global keyboard shortcuts for the application.
 * 
 * Default shortcuts:
 * - Alt+D / F11: Toggle widget mode
 * - Escape: Exit widget mode
 * - Alt+C: Toggle chat window
 * - Alt+A: Toggle artifacts window
 * 
 * @module main/services/ShortcutManager
 */

const { app, globalShortcut } = require('electron');
const { logger } = require('../../core/utils/logger');

// ============================================================================
// Default Shortcuts
// ============================================================================

const DEFAULT_SHORTCUTS = Object.freeze({
  TOGGLE_WIDGET: ['Alt+D', 'F11'],
  EXIT_WIDGET: ['Escape'],
  TOGGLE_CHAT: ['Alt+C'],
  TOGGLE_ARTIFACTS: ['Alt+A'],
});

// ============================================================================
// ShortcutManager Class
// ============================================================================

class ShortcutManager {
  constructor(windowManager, options = {}) {
    if (!windowManager) {
      throw new Error('WindowManager is required for ShortcutManager');
    }
    
    this.windowManager = windowManager;
    this.options = {
      enabled: options.enabled !== false, // Default true
      shortcuts: {
        ...DEFAULT_SHORTCUTS,
        ...options.shortcuts,
      },
      ...options,
    };
    
    this.logger = logger.child({ module: 'ShortcutManager' });
    this.registeredShortcuts = new Set();
    this.isInitialized = false;
  }

  /**
   * Initialize and register all shortcuts
   */
  async initialize() {
    if (this.isInitialized) {
      this.logger.warn('ShortcutManager already initialized');
      return;
    }
    
    if (!this.options.enabled) {
      this.logger.info('Shortcuts disabled by configuration');
      return;
    }
    
    // Wait for app to be ready
    await app.whenReady();
    
    this.logger.info('Initializing shortcut manager');
    
    try {
      // Register all default shortcuts
      this._registerToggleWidget();
      this._registerExitWidget();
      this._registerToggleChat();
      this._registerToggleArtifacts();
      
      this.isInitialized = true;
      this.logger.info('Shortcut manager initialized', {
        registered: Array.from(this.registeredShortcuts),
      });
    } catch (err) {
      this.logger.error('Failed to initialize shortcuts', {
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * Shutdown and unregister all shortcuts
   */
  shutdown() {
    this.logger.info('Shutting down shortcut manager');
    
    try {
      globalShortcut.unregisterAll();
      this.registeredShortcuts.clear();
      this.isInitialized = false;
      
      this.logger.info('Shortcut manager shutdown complete');
    } catch (err) {
      this.logger.error('Error during shortcut shutdown', {
        error: err.message,
      });
    }
  }

  /**
   * Register a single shortcut
   */
  _registerShortcut(accelerator, handler, description = '') {
    try {
      const success = globalShortcut.register(accelerator, () => {
        try {
          this.logger.debug('Shortcut triggered', { accelerator });
          handler();
        } catch (err) {
          this.logger.error('Shortcut handler error', {
            accelerator,
            error: err.message,
          });
        }
      });
      
      if (success) {
        this.registeredShortcuts.add(accelerator);
        this.logger.debug('Shortcut registered', {
          accelerator,
          description,
        });
        return true;
      } else {
        this.logger.warn('Failed to register shortcut', {
          accelerator,
          description,
        });
        return false;
      }
    } catch (err) {
      this.logger.error('Error registering shortcut', {
        accelerator,
        error: err.message,
      });
      return false;
    }
  }

  /**
   * Register multiple shortcuts for the same action
   */
  _registerShortcuts(accelerators, handler, description = '') {
    let successCount = 0;
    
    for (const accelerator of accelerators) {
      if (this._registerShortcut(accelerator, handler, description)) {
        successCount++;
      }
    }
    
    return successCount > 0;
  }

  /**
   * Unregister a single shortcut
   */
  _unregisterShortcut(accelerator) {
    try {
      globalShortcut.unregister(accelerator);
      this.registeredShortcuts.delete(accelerator);
      this.logger.debug('Shortcut unregistered', { accelerator });
      return true;
    } catch (err) {
      this.logger.error('Error unregistering shortcut', {
        accelerator,
        error: err.message,
      });
      return false;
    }
  }

  // ==========================================================================
  // Default Shortcut Handlers
  // ==========================================================================

  /**
   * Register toggle widget mode shortcuts
   */
  _registerToggleWidget() {
    this._registerShortcuts(
      this.options.shortcuts.TOGGLE_WIDGET,
      () => this.windowManager.toggleWidgetMode(),
      'Toggle widget mode'
    );
  }

  /**
   * Register exit widget mode shortcuts
   */
  _registerExitWidget() {
    this._registerShortcuts(
      this.options.shortcuts.EXIT_WIDGET,
      () => {
        if (this.windowManager.isWidgetMode) {
          this.windowManager.exitWidgetMode();
        }
      },
      'Exit widget mode'
    );
  }

  /**
   * Register toggle chat window shortcuts
   */
  _registerToggleChat() {
    this._registerShortcuts(
      this.options.shortcuts.TOGGLE_CHAT,
      () => {
        const chatWindow = this.windowManager.getChatWindow();
        
        if (!chatWindow || chatWindow.isDestroyed()) {
          this.windowManager.createChatWindow();
          return;
        }
        
        if (chatWindow.isVisible()) {
          chatWindow.hide();
        } else {
          chatWindow.show();
          chatWindow.focus();
          
          // Notify renderer
          try {
            chatWindow.webContents.send('chat:ensure-visible');
          } catch (err) {
            this.logger.error('Failed to notify chat window', {
              error: err.message,
            });
          }
        }
      },
      'Toggle chat window'
    );
  }

  /**
   * Register toggle artifacts window shortcuts
   */
  _registerToggleArtifacts() {
    this._registerShortcuts(
      this.options.shortcuts.TOGGLE_ARTIFACTS,
      () => {
        const artifactsWindow = this.windowManager.getArtifactsWindow();
        
        if (!artifactsWindow || artifactsWindow.isDestroyed()) {
          this.windowManager.createArtifactsWindow();
          return;
        }
        
        if (artifactsWindow.isVisible()) {
          artifactsWindow.hide();
        } else {
          artifactsWindow.show();
          artifactsWindow.focus();
          
          // Notify renderer
          try {
            artifactsWindow.webContents.send('artifacts:ensure-visible');
          } catch (err) {
            this.logger.error('Failed to notify artifacts window', {
              error: err.message,
            });
          }
        }
      },
      'Toggle artifacts window'
    );
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Register a custom shortcut
   */
  registerCustom(accelerator, handler, description = '') {
    if (!this.isInitialized) {
      this.logger.warn('Cannot register custom shortcut: not initialized');
      return false;
    }
    
    return this._registerShortcut(accelerator, handler, description);
  }

  /**
   * Unregister a custom shortcut
   */
  unregisterCustom(accelerator) {
    if (!this.isInitialized) {
      this.logger.warn('Cannot unregister custom shortcut: not initialized');
      return false;
    }
    
    return this._unregisterShortcut(accelerator);
  }

  /**
   * Check if shortcut is registered
   */
  isRegistered(accelerator) {
    return globalShortcut.isRegistered(accelerator);
  }

  /**
   * Get all registered shortcuts
   */
  getRegistered() {
    return Array.from(this.registeredShortcuts);
  }

  /**
   * Enable shortcuts
   */
  enable() {
    this.options.enabled = true;
    if (!this.isInitialized) {
      this.initialize().catch(err => {
        this.logger.error('Failed to enable shortcuts', {
          error: err.message,
        });
      });
    }
  }

  /**
   * Disable shortcuts
   */
  disable() {
    this.options.enabled = false;
    this.shutdown();
  }

  /**
   * Reload shortcuts (useful after config change)
   */
  async reload() {
    this.shutdown();
    this.isInitialized = false;
    await this.initialize();
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalManager = null;

/**
 * Get or create global manager instance
 */
function getManager(windowManager, options = {}) {
  if (!globalManager && windowManager) {
    globalManager = new ShortcutManager(windowManager, options);
  }
  return globalManager;
}

/**
 * Create a new manager instance
 */
function createManager(windowManager, options = {}) {
  return new ShortcutManager(windowManager, options);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  ShortcutManager,
  getManager,
  createManager,
  
  // Constants
  DEFAULT_SHORTCUTS,
};

