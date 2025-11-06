'use strict';

/**
 * @.architecture
 * 
 * Incoming: MessageManager requests (getOrCreateActiveTrail(), addExecutionToTrail(), finalizeTrail()) --- {method_call, javascript_api}
 * Processing: Manage active trail state with atomic numbering, create trails via TrailDOMRenderer, finalize trails with race condition prevention, integrate with chat content DOM, emit lifecycle events, track execution nodes and phases --- {9 jobs: JOB_CLEAR_STATE, JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_TRACK_ENTITY, JOB_UPDATE_DOM_ELEMENT, JOB_UPDATE_STATE}
 * Outgoing: TrailDOMRenderer methods (createTrailContainer(), createExecutionNode()), EventBus.emit() (lifecycle events), DOM appendChild() (chat content integration) --- {method_calls | dom_types.trail_container_element | event_types.trail_lifecycle, javascript_api | html | json}
 * 
 * 
 * @module renderer/chat/modules/trail/TrailContainerManager
 * 
 * TrailContainerManager - Trail Lifecycle Management
 * ============================================================================
 * Manages trail container lifecycle, state, positioning, and finalization logic.
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
    
    this._log('Initialized');
  }
  
  /**
   * Get or create active trail container
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
      this._log('Execution already exists, updating:', execution.id);
      return this.updateExecution(execution);
    }
    
    // Create new execution node
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
      this._log('Creating NEW trail container');
      
      // Create trail with atomic numbering
      const trailNumber = this._nextTrailNumber++;
      const newTrail = this.renderer.createTrailContainer(trailNumber);
      
      // Append to chat content
      chatContent.appendChild(newTrail);
      this.activeTrailContainer = newTrail;
      
      // Clear execution tracking
      this.executions.clear();
      
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
      
      this._log('Created trail:', newTrail.dataset.trailId, '- number:', trailNumber);
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
      this._log('No active trail to finalize');
      return;
    }
    
    this.renderer.finalizeTrail(this.activeTrailContainer);
    
    this._emit('artifacts:trail:finalized', { 
      trail: this.activeTrailContainer 
    });
    
    this._log('Finalized trail:', this.activeTrailContainer.dataset.trailId);
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
   * Clear active trail state
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

