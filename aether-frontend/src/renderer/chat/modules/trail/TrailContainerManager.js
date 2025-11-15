'use strict';

/**
 * @.architecture
 * 
 * Incoming: MessageManager requests (getOrCreateActiveTrail(), addExecutionToTrail(), finalizeTrail(), saveTrailState(), restoreTrailState()), window.storageAPI (database persistence) --- {method_call, javascript_api}
 * Processing: Manage active trail state with atomic numbering, create trails via TrailDOMRenderer, finalize trails with race condition prevention, integrate with chat content DOM, emit lifecycle events, track execution nodes and phases, persist trail state to PostgreSQL database via storageAPI, restore trail state from database on chat load, serialize trail DOM to JSON for database storage --- {14 jobs: JOB_CLEAR_STATE, JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_LOAD_FROM_DB, JOB_ROUTE_BY_TYPE, JOB_SAVE_TO_DB, JOB_SEND_IPC, JOB_SERIALIZE, JOB_TRACK_ENTITY, JOB_UPDATE_DOM_ELEMENT, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: TrailDOMRenderer methods (createTrailContainer(), createExecutionNode()), EventBus.emit() (lifecycle events), DOM appendChild() (chat content integration), storageAPI.saveTrailState/loadTrailState/deleteTrailState (database persistence via IPC → backend → PostgreSQL) --- {method_calls | dom_types.trail_container_element | event_types.trail_lifecycle | database_types.trail_state_json, javascript_api | html | json}
 * 
 * 
 * @module renderer/chat/modules/trail/TrailContainerManager
 * 
 * TrailContainerManager - Trail Lifecycle Management
 * ============================================================================
 * Manages trail container lifecycle, state, positioning, and finalization logic.
 * 
 * Database Persistence:
 * - Trail state (DOM snapshots + metadata) saved to PostgreSQL on chat switch
 * - Trails persist across frontend restarts
 * - Falls back to in-memory storage if database unavailable
 */

class TrailContainerManager {
  constructor(options = {}) {
    this.container = options.container || null;
    this.renderer = options.renderer || null;
    this.eventBus = options.eventBus || null;
    this.enableLogging = options.enableLogging || false;
    
    // Active trail tracking
    this.activeTrailContainer = null;
    this.currentResponseId = null;
    
    // Trail numbering (atomic to prevent races)
    this._trailCreationLock = false;
    this._nextTrailNumber = 1;
    
    // Execution tracking for phase updates
    this.executions = new Map(); // executionId -> { phases: [], element: HTMLElement }
    
    // Trail state persistence per chat (chatId -> saved trail HTML and state)
    // LEGACY: In-memory fallback for when database is unavailable
    this._savedTrailStates = new Map();
    this._currentChatId = null;
    
    // Database persistence via storageAPI
    this.storageAPI = null;
    this._initializeStorageAPI();
    
    this._log('Initialized');
  }
  
  /**
   * Initialize storage API for database persistence
   * @private
   */
  _initializeStorageAPI() {
    if (typeof window !== 'undefined' && window.storageAPI) {
      this.storageAPI = window.storageAPI;
      console.log('[TrailContainerManager] 💾 Database persistence enabled via storageAPI');
    } else {
      console.warn('[TrailContainerManager] ⚠️  storageAPI not available - using in-memory fallback');
    }
  }
  
  /**
   * Get or create active trail container
   * Ensures current chat ID is tracked for proper persistence
   * @returns {HTMLElement|null}
   */
  getOrCreateActiveTrail() {
    const chatContent = this._getChatContent();
    if (!chatContent) {
      console.warn('[TrailContainerManager] No chat content found');
      return null;
    }
    
    const needsNewTrail = !this.activeTrailContainer || 
                         !this.activeTrailContainer.parentElement ||
                         this.activeTrailContainer.dataset.finalized === 'true';
    
    if (needsNewTrail) {
      return this._createNewTrail(chatContent);
    }
    
    return this.activeTrailContainer;
  }
  
  /**
   * Set current chat ID for persistence tracking
   * CRITICAL: Must be called when chat is loaded/created
   * @param {string} chatId - Chat ID
   */
  setCurrentChat(chatId) {
    if (this._currentChatId !== chatId) {
      console.log(`[TrailContainerManager] Setting current chat: ${chatId?.slice(0,8)}`);
      this._currentChatId = chatId;
    }
  }
  
  /**
   * Add execution to active trail
   * @param {Object} execution - Execution data
   * @param {string} execution.id - Execution ID
   * @param {Array} execution.phases - Array of phase objects
   * @returns {HTMLElement|null} Execution node element
   */
  addExecutionToTrail(execution) {
    const trail = this.getOrCreateActiveTrail();
    if (!trail) return null;
    
    const timeline = trail.querySelector('.trail-timeline');
    if (!timeline) return null;
    
    // Check if execution already exists
    if (this.executions.has(execution.id)) {
      console.log(`[TrailContainerManager] 🔄 Execution ${execution.id.slice(0,8)} exists - UPDATING phases in SAME trail`);
      return this.updateExecution(execution);
    }
    
    // Create new execution node
    console.log(`[TrailContainerManager] ➕ Adding NEW execution ${execution.id.slice(0,8)} to trail #${trail.dataset.trailNumber}`);
    const executionNode = this.renderer.createExecutionNode(execution);
    timeline.appendChild(executionNode);
    
    // Track execution
    this.executions.set(execution.id, {
      phases: execution.phases || [],
      element: executionNode
    });
    
    // Animate addition
    this.renderer.animateNodeAddition(executionNode);
    
    this._emit('artifacts:execution:added', { 
      trail, 
      execution,
      executionNode 
    });
    
    this._log('Added execution to trail:', execution.id);
    return executionNode;
  }
  
  /**
   * Update execution phases
   * @param {Object} execution - Updated execution data
   * @returns {HTMLElement|null}
   */
  updateExecution(execution) {
    const tracked = this.executions.get(execution.id);
    if (!tracked) {
      this._log('Execution not found for update:', execution.id);
      return this.addExecutionToTrail(execution);
    }
    
    // Update phases
    tracked.phases = execution.phases || [];
    
    // Update DOM nodes
    const phaseNodes = tracked.element.querySelectorAll('.execution-node');
    execution.phases.forEach((phase, index) => {
      const node = phaseNodes[index];
      if (node) {
        this.renderer.updatePhaseNode(node, execution, phase);
      }
    });
    
    // Update trail status
    this._updateTrailStatus();
    
    this._log('Updated execution:', execution.id);
    return tracked.element;
  }
  
  /**
   * Update phase status
   * @param {string} executionId - Execution ID
   * @param {number} phaseIndex - Phase index
   * @param {string} status - New status
   * @param {Object} updates - Additional updates
   */
  updatePhaseStatus(executionId, phaseIndex, status, updates = {}) {
    const tracked = this.executions.get(executionId);
    if (!tracked || !tracked.phases[phaseIndex]) {
      this._log('Phase not found for update:', executionId, phaseIndex);
      return;
    }
    
    // Update phase data
    const phase = tracked.phases[phaseIndex];
    phase.status = status;
    Object.assign(phase, updates);
    
    if (status === 'completed' && !phase.endTime) {
      phase.endTime = Date.now();
    }
    
    // Update DOM
    const phaseNode = tracked.element.querySelector(`.execution-node[data-phase-index="${phaseIndex}"]`);
    if (phaseNode) {
      this.renderer.updatePhaseNode(phaseNode, { id: executionId }, phase);
    }
    
    // Update trail status
    this._updateTrailStatus();
    
    this._log('Updated phase status:', executionId, phaseIndex, status);
  }
  
  /**
   * Create new trail with race condition protection
   * @private
   */
  _createNewTrail(chatContent) {
    // Prevent concurrent trail creation
    if (this._trailCreationLock) {
      this._log('Trail creation blocked by lock, returning existing');
      return this.activeTrailContainer;
    }
    
    this._trailCreationLock = true;
    
    try {
      console.log('[TrailContainerManager] 🆕 Creating NEW trail container');
      
      // Create trail with atomic numbering
      const trailNumber = this._nextTrailNumber++;
      const newTrail = this.renderer.createTrailContainer(trailNumber);
      
      // Append to chat content
      chatContent.appendChild(newTrail);
      this.activeTrailContainer = newTrail;
      
      // Clear execution tracking
      this.executions.clear();
      console.log(`[TrailContainerManager] 🧹 Cleared execution tracking (${this.executions.size} executions)`);
      
      // Setup header click handler
      const header = newTrail.querySelector('.trail-header');
      if (header) {
        header.addEventListener('click', () => {
          this.toggleTrailState(newTrail);
        });
      }
      
      // Emit event
      this._emit('artifacts:trail:created', { 
        trail: newTrail, 
        trailNumber 
      });
      
      console.log(`[TrailContainerManager] ✅ Created Trail #${trailNumber} - ID: ${newTrail.dataset.trailId}`);
      return newTrail;
    } finally {
      this._trailCreationLock = false;
    }
  }
  
  /**
   * Finalize current active trail
   */
  finalizeCurrentTrail() {
    if (!this.activeTrailContainer) {
      console.log('[TrailContainerManager] ⚠️  No active trail to finalize');
      return;
    }
    
    const trailNum = this.activeTrailContainer.dataset.trailNumber;
    const execCount = this.executions.size;
    
    console.log(`[TrailContainerManager] 🏁 Finalizing Trail #${trailNum} with ${execCount} execution(s)`);
    
    this.renderer.finalizeTrail(this.activeTrailContainer);
    
    // CRITICAL FIX: Mark trail as finalized so new trails are created for next execution
    this.activeTrailContainer.dataset.finalized = 'true';
    
    // CRITICAL FIX: Save trail state immediately after finalization
    // This ensures trails persist even if user refreshes before switching chats
    if (this._currentChatId) {
      // Use setTimeout to avoid blocking UI, but don't wait too long
      setTimeout(() => {
        this.saveTrailState(this._currentChatId);
      }, 100);
    }
    
    this._emit('artifacts:trail:finalized', { 
      trail: this.activeTrailContainer 
    });
    
    console.log(`[TrailContainerManager] ✅ Trail #${trailNum} finalized - ID: ${this.activeTrailContainer.dataset.trailId}`);
  }
  
  /**
   * Toggle trail state
   * @param {HTMLElement} trail - Trail container
   * @param {string} targetState - Target state (optional)
   * @returns {string} New state
   */
  toggleTrailState(trail, targetState = null) {
    const previousState = trail.dataset.state;
    const newState = this.renderer.toggleTrailState(trail, targetState);
    
    const eventType = newState === 'collapsed' ? 
      'artifacts:trail:collapsed' : 'artifacts:trail:expanded';
    
    this._emit(eventType, { 
      trail, 
      previousState, 
      newState 
    });
    
    return newState;
  }
  
  /**
   * Update trail status icon and time
   * @private
   */
  _updateTrailStatus() {
    if (!this.activeTrailContainer) return;
    
    let hasActive = false;
    let hasError = false;
    
    for (const [_, tracked] of this.executions) {
      for (const phase of tracked.phases) {
        if (phase.status === 'active') hasActive = true;
        if (phase.status === 'error') hasError = true;
      }
    }
    
    this.renderer.updateTrailStatusIcon(this.activeTrailContainer, hasActive, hasError);
    
    // Update time
    const startTime = parseInt(this.activeTrailContainer.dataset.startTime);
    const elapsed = this.renderer._formatElapsed(startTime);
    this.renderer.updateTrailTime(this.activeTrailContainer, elapsed);
  }
  
  /**
   * Check if all executions in current trail are complete
   * @returns {boolean}
   */
  checkAllExecutionsComplete() {
    if (!this.activeTrailContainer) return false;
    
    for (const [_, tracked] of this.executions) {
      for (const phase of tracked.phases) {
        if (phase.status !== 'completed' && phase.status !== 'error') {
          return false;
        }
      }
    }
    
    return this.executions.size > 0;
  }
  
  /**
   * Get chat content container
   * @private
   */
  _getChatContent() {
    if (!this.container) return null;
    
    // Try multiple selectors
    return this.container.querySelector('#chat-content') || 
           this.container.querySelector('.chat-content') ||
           this.container;
  }
  
  /**
   * Reset trail numbering for new chat
   */
  resetNumbering() {
    this._nextTrailNumber = 1;
    this._log('Trail numbering reset');
  }
  
  /**
   * Save trail state for current chat
   * @param {string} chatId - Chat ID to save state for
   */
  async saveTrailState(chatId) {
    if (!chatId || !this.container) {
      console.warn('[TrailContainerManager] Cannot save trail state - no chatId or container');
      return;
    }
    
    console.log(`[TrailContainerManager] 💾 Saving trail state for chat ${chatId.slice(0,8)}`);
    
    // Get chat content where trails are actually appended
    const chatContent = this._getChatContent();
    if (!chatContent) {
      console.warn('[TrailContainerManager] Cannot find chat content for saving trails');
      return;
    }
    
    // Get all trail containers in the chat content
    const trailContainers = chatContent.querySelectorAll('.artifact-execution-trail-container');
    
    console.log(`[TrailContainerManager] Found ${trailContainers.length} trail(s) in chat content for chat ${chatId.slice(0,8)}`);
    
    if (trailContainers.length === 0) {
      console.log(`[TrailContainerManager] No trails to save for chat ${chatId.slice(0,8)}`);
      
      // Delete from database if no trails exist
      if (this.storageAPI && typeof this.storageAPI.deleteTrailState === 'function') {
        try {
          await this.storageAPI.deleteTrailState(chatId);
          console.log(`[TrailContainerManager] 🗑️  Deleted trail state from database (no trails)`);
        } catch (error) {
          console.warn('[TrailContainerManager] Failed to delete trail state (non-critical):', error);
        }
      }
      
      return;
    }
    
    // Save trail HTML and metadata
    const savedTrails = Array.from(trailContainers).map(trail => {
      // Find the actual message element that this trail should be positioned after
      let parentMessageId = null;
      
      // Get the trail's position in the DOM to find its preceding message
      const trailPosition = Array.from(chatContent.children).indexOf(trail);
      
      // Look backwards from trail position to find the last message element
      for (let i = trailPosition - 1; i >= 0; i--) {
        const element = chatContent.children[i];
        if (element.dataset && element.dataset.messageId) {
          parentMessageId = element.dataset.messageId;
          break;
        }
      }
      
      return {
        html: trail.outerHTML,
        trailId: trail.dataset.trailId,
        trailNumber: trail.dataset.trailNumber,
        state: trail.dataset.state,
        finalized: trail.dataset.finalized,
        parentMessageId: parentMessageId // Use actual DOM message ID for positioning
      };
    });
    
    const trailState = {
      trails: savedTrails,
      nextTrailNumber: this._nextTrailNumber,
      savedAt: Date.now()
    };
    
    // Save to in-memory cache (fallback)
    this._savedTrailStates.set(chatId, trailState);
    
    // Save to database via storageAPI
    if (this.storageAPI && typeof this.storageAPI.saveTrailState === 'function') {
      try {
        await this.storageAPI.saveTrailState(chatId, trailState);
        console.log(`[TrailContainerManager] ✅ Saved ${savedTrails.length} trails to database for chat ${chatId.slice(0,8)}`);
      } catch (error) {
        console.warn('[TrailContainerManager] Failed to save trail state to database (using in-memory fallback):', error);
      }
    } else {
      console.log(`[TrailContainerManager] ✅ Saved ${savedTrails.length} trails in-memory for chat ${chatId.slice(0,8)}`);
    }
  }
  
  /**
   * Restore trail state for a chat
   * @param {string} chatId - Chat ID to restore state for
   */
  async restoreTrailState(chatId) {
    if (!chatId || !this.container) {
      console.warn('[TrailContainerManager] Cannot restore trail state - no chatId or container');
      return;
    }
    
    // Try to load from database first
    let savedState = null;
    
    if (this.storageAPI && typeof this.storageAPI.loadTrailState === 'function') {
      try {
        savedState = await this.storageAPI.loadTrailState(chatId);
        if (savedState && savedState.trails && savedState.trails.length > 0) {
          console.log(`[TrailContainerManager] 📂 Loaded ${savedState.trails.length} trails from database for chat ${chatId.slice(0,8)}`);
          // Cache in memory for faster subsequent access
          this._savedTrailStates.set(chatId, savedState);
        }
      } catch (error) {
        console.warn('[TrailContainerManager] Failed to load trail state from database, trying in-memory:', error);
      }
    }
    
    // Fallback to in-memory if database didn't return trails
    if (!savedState || !savedState.trails || savedState.trails.length === 0) {
      savedState = this._savedTrailStates.get(chatId);
    }
    
    if (!savedState || !savedState.trails || savedState.trails.length === 0) {
      console.log(`[TrailContainerManager] No saved trails for chat ${chatId.slice(0,8)}`);
      return;
    }
    
    console.log(`[TrailContainerManager] 📂 Restoring ${savedState.trails.length} trails for chat ${chatId.slice(0,8)}`);
    
    // Get chat content where trails should be restored
    const chatContent = this._getChatContent();
    if (!chatContent) {
      console.warn('[TrailContainerManager] Cannot find chat content for restoring trails');
      return;
    }
    
    // Remove existing trail containers
    const existingTrails = chatContent.querySelectorAll('.artifact-execution-trail-container');
    existingTrails.forEach(trail => trail.remove());
    
    // Restore saved trails in correct positions
    savedState.trails.forEach(trailData => {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = trailData.html;
      const trailElement = tempDiv.firstChild;
      
      if (trailElement) {
        // Find insertion point: right after the message that triggered this trail
        let insertionPoint = null;
        
        if (trailData.parentMessageId) {
          // Find the message element with matching ID
          const messageElements = chatContent.querySelectorAll('[data-message-id]');
          
          for (const msgElement of messageElements) {
            if (msgElement.dataset.messageId === trailData.parentMessageId) {
              insertionPoint = msgElement;
              break;
            }
          }
        }
        
        // Insert trail right after its parent message, or append if not found
        if (insertionPoint && insertionPoint.nextSibling) {
          insertionPoint.parentNode.insertBefore(trailElement, insertionPoint.nextSibling);
          console.log(`[TrailContainerManager] 📍 Inserted trail after message: ${trailData.parentMessageId?.slice(0,20)}...`);
        } else if (insertionPoint) {
          insertionPoint.parentNode.appendChild(trailElement);
          console.log(`[TrailContainerManager] 📍 Appended trail after message (last): ${trailData.parentMessageId?.slice(0,20)}...`);
        } else {
          chatContent.appendChild(trailElement);
          console.warn(`[TrailContainerManager] ⚠️ No parent message found for trail (ID: ${trailData.parentMessageId}), appending to end`);
        }
        
        // Re-attach header click handler
        const header = trailElement.querySelector('.trail-header');
        if (header) {
          header.addEventListener('click', () => {
            this.toggleTrailState(trailElement);
          });
        }
        
        // Re-attach phase node click handlers
        const phaseNodes = trailElement.querySelectorAll('.execution-node:not(.non-clickable)');
        phaseNodes.forEach(node => {
          const phaseType = node.dataset.phaseType;
          const artifactId = node.dataset.artifactId;
          
          if (artifactId) {
            node.addEventListener('click', () => {
              console.log(`[TrailDOMRenderer] 🖱️  Node clicked: ${phaseType} - artifact: ${artifactId.slice(0,8)}`);
              
              // Determine which artifacts tab to open based on phase type
              let targetTab = 'code';
              if (phaseType === 'output') {
                targetTab = 'output';
              } else if (phaseType === 'execute') {
                targetTab = 'console';
              }
              
              console.log(`[TrailDOMRenderer] 📤 Sending IPC to artifacts window - tab: ${targetTab}, artifact: ${artifactId.slice(0,8)}`);
              
              // Send to artifacts window via IPC
              if (window.ipcBridge) {
                window.ipcBridge.send('artifacts:show-artifact', {
                  artifactId: artifactId,
                  tab: targetTab
                });
                window.ipcBridge.send('artifacts:show-window');
                console.log(`[TrailDOMRenderer] ✅ IPC messages sent to artifacts window`);
              }
            });
          }
        });
      }
    });
    
    // Restore trail numbering
    this._nextTrailNumber = savedState.nextTrailNumber;
    
    console.log(`[TrailContainerManager] ✅ Restored trails for chat ${chatId.slice(0,8)}, next trail number: ${this._nextTrailNumber}`);
  }
  
  /**
   * Switch to a different chat (save current, prepare for new)
   * NOTE: Does NOT restore trails - call restoreTrailState() after view is ready
   * @param {string} newChatId - New chat ID
   */
  switchChat(newChatId) {
    // Save current chat's trail state BEFORE any DOM clearing
    if (this._currentChatId && this._currentChatId !== newChatId) {
      this.saveTrailState(this._currentChatId);
    }
    
    // Clear active state
    this.clearActive();
    
    // Update current chat ID (restoration happens later after view is ready)
    this._currentChatId = newChatId;
    
    console.log(`[TrailContainerManager] 🔄 Switched to chat ${newChatId?.slice(0,8)} (trails will restore after view ready)`);
  }
  
  /**
   * Clear active trail state (without saving)
   */
  clearActive() {
    this.activeTrailContainer = null;
    this.currentResponseId = null;
    this._trailCreationLock = false;
    this.executions.clear();
    this._log('Active trail state cleared');
  }
  
  /**
   * Emit event through EventBus if available
   * @private
   */
  _emit(eventName, data) {
    if (this.eventBus) {
      this.eventBus.emit(eventName, data);
    }
  }
  
  /**
   * Logging utility
   * @private
   */
  _log(...args) {
    if (this.enableLogging) {
      console.log('[TrailContainerManager]', ...args);
    }
  }
  
  /**
   * Cleanup
   */
  dispose() {
    this.clearActive();
    this.resetNumbering();
    this._log('Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TrailContainerManager;
}

if (typeof window !== 'undefined') {
  window.TrailContainerManager = TrailContainerManager;
  console.log('📦 TrailContainerManager loaded');
}

