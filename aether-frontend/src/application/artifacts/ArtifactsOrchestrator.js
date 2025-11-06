'use strict';

/**
 * @.architecture
 * 
 * Incoming: IpcBridge.on('artifacts:*') (artifact data from chat window, IPC commands), storageAPI methods (PostgreSQL), container.resolve() (DI injections) --- {artifact_types.* | ipc_message | database_types.artifact_record | method_calls, json}
 * Processing: Initialize RequestLifecycleManager and domain services, receive/store artifacts, route by type (code→CodeViewer/output→OutputViewer/file→FileManager), execute code in SafeCodeExecutor, manage tab switching, sync with chat switches, persist to PostgreSQL, cleanup resources --- {11 jobs: JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_ROUTE_BY_TYPE, JOB_SAVE_TO_DB, JOB_SEND_IPC, JOB_TRACK_ENTITY, JOB_UPDATE_STATE}
 * Outgoing: CodeViewer.displayCode() → DOM, OutputViewer.renderResult() → DOM, FileManager.exportArtifact() → filesystem, storageAPI methods → PostgreSQL, EventBus.emit() → internal subscribers --- {dom_types.* | database_types.artifact_record | custom_event, HTMLElement | json}
 * 
 * 
 * @module application/artifacts/ArtifactsOrchestrator
 * 
 * ArtifactsOrchestrator - Artifacts window application orchestrator
 * ============================================================================
 * Coordinates all artifacts window services and modules:
 * - TabManager (code/output/files tabs)
 * - CodeViewer (code display and syntax highlighting)
 * - OutputViewer (output rendering with format-specific renderers)
 * - FileManager (file management and export)
 * - SafeCodeExecutor (sandboxed code execution)
 * - ArtifactsStreamHandler (artifact streaming from chat)
 * 
 * Orchestrates:
 * - Artifact lifecycle (receive → render → execute → display output)
 * - Tab coordination (code vs output vs files)
 * - Execution flow (code → safe executor → output viewer)
 * - Chat synchronization (load artifacts when chat switches)
 * - Two-stage artifact routing (chat window → artifacts window)
 * - Traceability (artifact ↔ message linking)
 * 
 * Architecture: Application layer tying domain services to the artifacts renderer.
 */

const { freeze } = Object;

class ArtifactsOrchestrator {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging || false;
    
    // Core dependencies
    this.container = options.container || null; // DI container
    this.eventBus = options.eventBus || null;
    this.config = options.config || {};
    
    // Communication layer
    this.ipcBridge = options.ipcBridge || null;
    this.storageAPI = options.storageAPI || null;
    
    // Infrastructure services
    this.performanceMonitor = options.performanceMonitor || null;
    this.metricsCollector = options.metricsCollector || null;
    this.errorTracker = options.errorTracker || null;
    
    // Domain services
    this.artifactService = null;
    this.executionService = null;
    this.traceabilityService = null;
    
    // UI modules (renderer layer - injected)
    this.tabManager = options.tabManager || null;
    this.codeViewer = options.codeViewer || null;
    this.outputViewer = options.outputViewer || null;
    this.fileManager = options.fileManager || null;
    this.codeExecutor = options.codeExecutor || null;
    this.streamHandler = options.streamHandler || null;
    
    // Lifecycle management
    this.requestLifecycle = null;
    this.isInitialized = false;
    this.isDestroyed = false;
    
    // State
    this.state = {
      currentChatId: null,
      currentArtifactId: null,
      activeTab: 'code',
      artifacts: new Map(), // artifactId -> artifact data
      executionResults: new Map(), // artifactId -> execution result
      isExecuting: false
    };
    
    if (this.enableLogging) {
      console.log('[ArtifactsOrchestrator] Created');
    }
  }

  /**
   * Initialize orchestrator and all services
   * @returns {Promise<void>}
   */
  async init() {
    if (this.isInitialized) {
      console.warn('[ArtifactsOrchestrator] Already initialized');
      return;
    }
    
    if (this.enableLogging) {
      console.log('[ArtifactsOrchestrator] Initializing...');
    }
    
    try {
      // Initialize in dependency order
      await this._initializeRequestLifecycle();
      await this._initializeServices();
      await this._setupEventListeners();
      
      this.isInitialized = true;
      
      if (this.enableLogging) {
        console.log('[ArtifactsOrchestrator] Initialized successfully');
      }
      
      // Emit initialization event
      if (this.eventBus) {
        this.eventBus.emit('artifacts:orchestrator:initialized');
      }
    } catch (error) {
      console.error('[ArtifactsOrchestrator] Initialization failed:', error);
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ArtifactsOrchestrator.init');
      }
      
      throw error;
    }
  }

  /**
   * Receive artifact from chat window
   * @param {Object} artifact - Artifact data
   * @returns {Promise<void>}
   */
  async receiveArtifact(artifact) {
    this._ensureInitialized();
    
    if (!artifact || !artifact.id) {
      throw new Error('Invalid artifact');
    }
    
    try {
      // Track with performance monitor
      if (this.performanceMonitor) {
        this.performanceMonitor.start(`receiveArtifact:${artifact.id}`);
      }
      
      // Store artifact
      this.state.artifacts.set(artifact.id, artifact);
      this.state.currentArtifactId = artifact.id;
      
      // Save to PostgreSQL
      if (this.state.currentChatId && this.storageAPI) {
        await this.storageAPI.saveArtifact(this.state.currentChatId, artifact);
      }
      
      // Route to appropriate renderer based on type
      await this._routeArtifact(artifact);
      
      if (this.enableLogging) {
        console.log('[ArtifactsOrchestrator] Received artifact:', artifact.id, artifact.type);
      }
      
      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('artifacts:received', { artifactId: artifact.id, type: artifact.type });
      }
    } catch (error) {
      console.error('[ArtifactsOrchestrator] Failed to receive artifact:', error);
      throw error;
    } finally {
      if (this.performanceMonitor) {
        this.performanceMonitor.end(`receiveArtifact:${artifact.id}`);
      }
    }
  }

  /**
   * Execute code artifact
   * @param {string} artifactId - Artifact ID
   * @returns {Promise<Object>} Execution result
   */
  async executeArtifact(artifactId) {
    this._ensureInitialized();
    
    const artifact = this.state.artifacts.get(artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    
    if (artifact.type !== 'code') {
      throw new Error(`Cannot execute non-code artifact: ${artifact.type}`);
    }
    
    // Start request lifecycle
    const request = this.requestLifecycle.startRequest({
      type: 'code-execution',
      timeout: 30000, // 30 seconds
      metadata: {
        artifactId,
        language: artifact.language
      }
    });
    
    try {
      this.state.isExecuting = true;
      
      // Track with performance monitor
      if (this.performanceMonitor) {
        this.performanceMonitor.start(`executeArtifact:${artifactId}`);
      }
      
      // Execute via SafeCodeExecutor
      if (!this.codeExecutor) {
        throw new Error('CodeExecutor not available');
      }
      
      const result = await this.codeExecutor.execute(artifact.content, {
        language: artifact.language,
        timeout: 30000
      });
      
      // Store result
      this.state.executionResults.set(artifactId, result);
      
      // Display result in OutputViewer
      if (this.outputViewer) {
        await this.outputViewer.renderResult(result);
      }
      
      // Switch to output tab
      if (this.tabManager) {
        this.tabManager.setActiveTab('output');
        this.state.activeTab = 'output';
      }
      
      // Complete request
      request.complete(result);
      
      if (this.enableLogging) {
        console.log('[ArtifactsOrchestrator] Executed artifact:', artifactId);
      }
      
      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('artifacts:executed', { artifactId, success: result.success });
      }
      
      return result;
    } catch (error) {
      request.fail(error);
      console.error('[ArtifactsOrchestrator] Execution failed:', error);
      throw error;
    } finally {
      this.state.isExecuting = false;
      
      if (this.performanceMonitor) {
        this.performanceMonitor.end(`executeArtifact:${artifactId}`);
      }
    }
  }

  /**
   * Switch active tab
   * @param {string} tabName - Tab name ('code', 'output', 'files')
   */
  switchTab(tabName) {
    this._ensureInitialized();
    
    if (!['code', 'output', 'files'].includes(tabName)) {
      throw new Error(`Invalid tab name: ${tabName}`);
    }
    
    if (this.tabManager) {
      this.tabManager.setActiveTab(tabName);
    }
    
    this.state.activeTab = tabName;
    
    if (this.enableLogging) {
      console.log('[ArtifactsOrchestrator] Switched to tab:', tabName);
    }
    
    // Emit event
    if (this.eventBus) {
      this.eventBus.emit('artifacts:tab:switched', { tabName });
    }
  }

  /**
   * Handle chat switch - load artifacts for new chat
   * @param {string} chatId - New chat ID
   * @returns {Promise<void>}
   */
  async handleChatSwitch(chatId) {
    this._ensureInitialized();
    
    if (this.state.currentChatId === chatId) {
      return;
    }
    
    try {
      // Clear current artifacts
      this.state.artifacts.clear();
      this.state.executionResults.clear();
      this.state.currentArtifactId = null;
      
      // Update chat ID
      this.state.currentChatId = chatId;
      
      // Load artifacts for this chat from PostgreSQL
      if (this.storageAPI) {
        const artifacts = await this.storageAPI.loadArtifacts(chatId);
        
        // Store artifacts
        for (const artifact of artifacts) {
          this.state.artifacts.set(artifact.id, artifact);
        }
        
        // Display most recent artifact
        if (artifacts.length > 0) {
          const latestArtifact = artifacts[artifacts.length - 1];
          await this._routeArtifact(latestArtifact);
          this.state.currentArtifactId = latestArtifact.id;
        }
        
        if (this.enableLogging) {
          console.log('[ArtifactsOrchestrator] Loaded', artifacts.length, 'artifacts for chat:', chatId);
        }
      }
      
      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('artifacts:chat:switched', { chatId, artifactCount: this.state.artifacts.size });
      }
    } catch (error) {
      console.error('[ArtifactsOrchestrator] Failed to handle chat switch:', error);
      throw error;
    }
  }

  /**
   * Focus on specific artifacts
   * @param {Object} data - Focus data (artifactId or requestId)
   * @returns {Promise<void>}
   */
  async focusArtifacts(data) {
    this._ensureInitialized();
    
    try {
      // Find artifact by ID or requestId
      let artifact = null;
      
      if (data.artifactId) {
        artifact = this.state.artifacts.get(data.artifactId);
      } else if (data.requestId) {
        // Find artifact by correlation
        for (const [, art] of this.state.artifacts) {
          if (art.requestId === data.requestId) {
            artifact = art;
            break;
          }
        }
      }
      
      if (!artifact) {
        console.warn('[ArtifactsOrchestrator] Artifact not found for focus request:', data);
        return;
      }
      
      // Route artifact
      await this._routeArtifact(artifact);
      this.state.currentArtifactId = artifact.id;
      
      if (this.enableLogging) {
        console.log('[ArtifactsOrchestrator] Focused on artifact:', artifact.id);
      }
      
      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('artifacts:focused', { artifactId: artifact.id });
      }
    } catch (error) {
      console.error('[ArtifactsOrchestrator] Failed to focus artifacts:', error);
    }
  }

  /**
   * Export artifact
   * @param {string} artifactId - Artifact ID
   * @param {string} format - Export format
   * @returns {Promise<void>}
   */
  async exportArtifact(artifactId, format = 'file') {
    this._ensureInitialized();
    
    const artifact = this.state.artifacts.get(artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    
    if (!this.fileManager) {
      throw new Error('FileManager not available');
    }
    
    try {
      await this.fileManager.exportArtifact(artifact, format);
      
      if (this.enableLogging) {
        console.log('[ArtifactsOrchestrator] Exported artifact:', artifactId, format);
      }
      
      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('artifacts:exported', { artifactId, format });
      }
    } catch (error) {
      console.error('[ArtifactsOrchestrator] Failed to export artifact:', error);
      throw error;
    }
  }

  /**
   * Get current state
   * @returns {Object}
   */
  getState() {
    return freeze({
      currentChatId: this.state.currentChatId,
      currentArtifactId: this.state.currentArtifactId,
      activeTab: this.state.activeTab,
      artifactCount: this.state.artifacts.size,
      isExecuting: this.state.isExecuting
    });
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return freeze({
      initialized: this.isInitialized,
      currentChatId: this.state.currentChatId,
      currentArtifactId: this.state.currentArtifactId,
      activeTab: this.state.activeTab,
      artifactCount: this.state.artifacts.size,
      executionResultCount: this.state.executionResults.size,
      isExecuting: this.state.isExecuting,
      activeRequests: this.requestLifecycle ? this.requestLifecycle.getStats().active : 0
    });
  }

  /**
   * Cleanup and destroy
   */
  destroy() {
    if (this.isDestroyed) return;
    
    if (this.enableLogging) {
      console.log('[ArtifactsOrchestrator] Destroying...');
    }
    
    // Cancel all requests
    if (this.requestLifecycle) {
      this.requestLifecycle.destroy();
    }
    
    // Clear artifacts
    this.state.artifacts.clear();
    this.state.executionResults.clear();
    
    // Cleanup event listeners
    if (this.eventBus) {
      this.eventBus.removeAllListeners('artifacts:*');
    }
    
    // Cleanup IPC
    if (this.ipcBridge) {
      this.ipcBridge.removeAllListeners('artifacts:*');
    }
    
    this.isDestroyed = true;
    this.isInitialized = false;
    
    if (this.enableLogging) {
      console.log('[ArtifactsOrchestrator] Destroyed');
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Initialize request lifecycle manager
   * @private
   */
  async _initializeRequestLifecycle() {
    const { RequestLifecycleManager } = require('../shared/RequestLifecycleManager');
    
    this.requestLifecycle = new RequestLifecycleManager({
      name: 'ArtifactsOrchestrator',
      enableLogging: this.enableLogging,
      defaultTimeout: 30000,
      maxConcurrentRequests: 5,
      performanceMonitor: this.performanceMonitor
    });
  }

  /**
   * Initialize domain services
   * @private
   */
  async _initializeServices() {
    if (!this.container) return;
    
    try {
      // Domain services from src/domain
      this.artifactService = this.container.resolve('ArtifactService');
      this.executionService = this.container.resolve('ExecutionService');
      this.traceabilityService = this.container.resolve('TraceabilityService');
      
      if (this.enableLogging) {
        console.log('[ArtifactsOrchestrator] Domain services initialized');
      }
    } catch (error) {
      console.warn('[ArtifactsOrchestrator] Some domain services not available:', error);
    }
  }

  /**
   * Setup event listeners
   * @private
   */
  async _setupEventListeners() {
    // EventBus listeners
    if (this.eventBus) {
      this.eventBus.on('artifacts:artifact-received', (artifact) => {
        this.receiveArtifact(artifact).catch(error => {
          console.error('[ArtifactsOrchestrator] Failed to receive artifact:', error);
        });
      });
    }
    
    // IPC listeners
    if (this.ipcBridge) {
      this.ipcBridge.on('artifacts:focus-artifacts', (data) => {
        this.focusArtifacts(data).catch(error => {
          console.error('[ArtifactsOrchestrator] Failed to focus artifacts:', error);
        });
      });
      
      this.ipcBridge.on('artifacts:switch-tab', (tabName) => {
        this.switchTab(tabName);
      });
      
      this.ipcBridge.on('artifacts:chat-switched', (data) => {
        this.handleChatSwitch(data.chatId).catch(error => {
          console.error('[ArtifactsOrchestrator] Failed to handle chat switch:', error);
        });
      });
      
      this.ipcBridge.on('artifacts:execute', (artifactId) => {
        this.executeArtifact(artifactId).catch(error => {
          console.error('[ArtifactsOrchestrator] Failed to execute artifact:', error);
        });
      });
      
      this.ipcBridge.on('artifacts:export', (data) => {
        this.exportArtifact(data.artifactId, data.format).catch(error => {
          console.error('[ArtifactsOrchestrator] Failed to export artifact:', error);
        });
      });
    }
    
    if (this.enableLogging) {
      console.log('[ArtifactsOrchestrator] Event listeners setup');
    }
  }

  /**
   * Route artifact to appropriate renderer
   * @private
   */
  async _routeArtifact(artifact) {
    switch (artifact.type) {
      case 'code':
        // Display in code viewer
        if (this.codeViewer) {
          await this.codeViewer.displayCode(artifact);
        }
        
        // Switch to code tab
        if (this.tabManager) {
          this.tabManager.setActiveTab('code');
          this.state.activeTab = 'code';
        }
        break;
        
      case 'output':
      case 'html':
      case 'markdown':
      case 'json':
      case 'media':
        // Display in output viewer
        if (this.outputViewer) {
          await this.outputViewer.renderArtifact(artifact);
        }
        
        // Switch to output tab
        if (this.tabManager) {
          this.tabManager.setActiveTab('output');
          this.state.activeTab = 'output';
        }
        break;
        
      case 'file':
        // Display in file manager
        if (this.fileManager) {
          await this.fileManager.addFile(artifact);
        }
        
        // Switch to files tab
        if (this.tabManager) {
          this.tabManager.setActiveTab('files');
          this.state.activeTab = 'files';
        }
        break;
        
      default:
        console.warn('[ArtifactsOrchestrator] Unknown artifact type:', artifact.type);
        
        // Default to code viewer
        if (this.codeViewer) {
          await this.codeViewer.displayCode(artifact);
        }
    }
  }

  /**
   * Ensure orchestrator is initialized
   * @private
   */
  _ensureInitialized() {
    if (!this.isInitialized) {
      throw new Error('ArtifactsOrchestrator not initialized. Call init() first.');
    }
    
    if (this.isDestroyed) {
      throw new Error('ArtifactsOrchestrator has been destroyed');
    }
  }
}

// Export
module.exports = { ArtifactsOrchestrator };

if (typeof window !== 'undefined') {
  window.ArtifactsOrchestrator = ArtifactsOrchestrator;
  console.log('📦 ArtifactsOrchestrator loaded');
}

