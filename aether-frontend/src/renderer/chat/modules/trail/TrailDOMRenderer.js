'use strict';

/**
 * @.architecture
 * 
 * Incoming: TrailContainerManager requests (method calls) --- {trail_types.render_request, javascript_api}
 * Processing: Create trail container DOM elements, create execution node elements, create phase node elements with status classes, calculate elapsed time display, animate DOM updates, format time strings --- {6 jobs: JOB_ACCUMULATE_TEXT, JOB_CALCULATE_TIME, JOB_GENERATE_SESSION_ID, JOB_RENDER_MARKDOWN, JOB_UPDATE_DOM_ELEMENT, JOB_UPDATE_STATE}
 * Outgoing: Return DOM elements (div.artifact-execution-trail-container with nested structure) --- {dom_types.trail_container_element, html}
 * 
 * 
 * @module renderer/chat/modules/trail/TrailDOMRenderer
 * 
 * TrailDOMRenderer - Pure DOM Rendering for Trail Containers
 * ============================================================================
 * Separates presentation logic from business logic for artifact execution trails.
 */

class TrailDOMRenderer {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging || false;
  }
  
  /**
   * Create trail container element
   * @param {number} trailNumber - Trail sequence number
   * @returns {HTMLElement}
   */
  createTrailContainer(trailNumber) {
    const trail = document.createElement('div');
    trail.className = 'artifact-execution-trail-container';
    trail.dataset.state = 'partial';
    trail.dataset.finalized = 'false';
    trail.dataset.trailId = `trail_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    trail.dataset.trailNumber = trailNumber;
    trail.dataset.startTime = Date.now();
    
    const header = this._createTrailHeader(trailNumber);
    const contentWrapper = this._createTrailContentWrapper();
    
    trail.appendChild(header);
    trail.appendChild(contentWrapper);
    
    this._log('Created trail container:', trail.dataset.trailId);
    return trail;
  }
  
  /**
   * Create trail header with title, status icon, time, and chevron
   * @private
   */
  _createTrailHeader(trailNumber) {
    const header = document.createElement('div');
    header.className = 'trail-header';
    
    const title = document.createElement('div');
    title.className = 'trail-title';
    title.innerHTML = `
      <div class="trail-status-icon">
        <div class="trail-status-spinner"></div>
      </div>
      <span class="trail-title-text">Trail ${trailNumber}</span>
    `;
    
    const timeDisplay = document.createElement('div');
    timeDisplay.className = 'trail-time';
    timeDisplay.textContent = '0s';
    
    const chevron = document.createElement('div');
    chevron.className = 'trail-chevron rotate-90';
    chevron.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    `;
    
    header.appendChild(title);
    header.appendChild(timeDisplay);
    header.appendChild(chevron);
    
    return header;
  }
  
  /**
   * Create trail content wrapper with timeline
   * @private
   */
  _createTrailContentWrapper() {
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'trail-content-wrapper';
    
    const timeline = document.createElement('div');
    timeline.className = 'trail-timeline';
    
    contentWrapper.appendChild(timeline);
    return contentWrapper;
  }
  
  /**
   * Create execution node container with phase nodes
   * @param {Object} execution - Execution data
   * @param {string} execution.id - Execution ID
   * @param {Array} execution.phases - Array of phase objects
   * @returns {HTMLElement}
   */
  createExecutionNode(execution) {
    const container = document.createElement('div');
    container.className = 'execution-node-container';
    container.dataset.executionId = execution.id;
    
    if (execution.phases && Array.isArray(execution.phases)) {
      execution.phases.forEach((phase, index) => {
        const node = this.createPhaseNode(execution, phase, index);
        container.appendChild(node);
      });
    }
    
    this._log('Created execution node:', execution.id, '- phases:', execution.phases?.length || 0);
    return container;
  }
  
  /**
   * Create phase node (write, process, execute, output)
   * @param {Object} execution - Parent execution
   * @param {Object} phase - Phase data
   * @param {number} index - Phase index
   * @returns {HTMLElement}
   */
  createPhaseNode(execution, phase, index) {
    const node = document.createElement('div');
    node.className = 'execution-node';
    node.dataset.phaseKind = phase.kind || 'output';
    node.dataset.phaseIndex = index;
    node.dataset.status = phase.status || 'pending';
    node.dataset.artifactId = phase.artifactId || '';
    
    const statusClass = this._getStatusClass(phase.status);
    node.classList.add(statusClass);
    
    const elapsed = this._calculateElapsed(phase);
    const label = phase.label || this._getLabelForKind(phase.kind);
    
    node.innerHTML = `
      <div class="node-header">
        <div class="node-title">
          <span>${label}</span>
        </div>
        <span class="node-time">${elapsed}</span>
      </div>
    `;
    
    // Handle non-clickable nodes (execution in progress)
    if (phase.status === 'active' && phase.kind === 'execute') {
      node.classList.add('non-clickable');
      node.title = 'Execution in progress...';
    } else if (phase.artifactId) {
      // Make node clickable if it has an artifact
      node.classList.add('clickable');
      node.title = `Click to view ${label} in artifacts window`;
      node.style.cursor = 'pointer';
      
      // Add click handler to open artifact
      node.addEventListener('click', () => {
        this._handleNodeClick(phase, execution);
      });
    } else {
      node.title = `${label} - No artifact`;
    }
    
    this._log('Created phase node:', phase.kind, '- status:', phase.status);
    return node;
  }
  
  /**
   * Update phase node status and display
   * @param {HTMLElement} node - Phase node element
   * @param {Object} execution - Parent execution
   * @param {Object} phase - Updated phase data
   */
  updatePhaseNode(node, execution, phase) {
    const statusClass = this._getStatusClass(phase.status);
    node.className = `execution-node ${statusClass}`;
    node.dataset.status = phase.status || 'pending';
    
    // Update clickability
    if (phase.status === 'active' && phase.kind === 'execute') {
      node.classList.add('non-clickable');
      node.title = 'Execution in progress...';
    } else {
      node.classList.remove('non-clickable');
      const label = phase.label || this._getLabelForKind(phase.kind);
      node.title = `Click to view ${label} in artifacts window`;
    }
    
    // Update time
    const nodeTime = node.querySelector('.node-time');
    if (nodeTime) {
      const elapsed = this._calculateElapsed(phase);
      nodeTime.textContent = elapsed;
    }
    
    this._log('Updated phase node:', phase.kind, '- status:', phase.status);
  }
  
  /**
   * Update trail status icon (spinner, checkmark, or error)
   * @param {HTMLElement} trail - Trail container
   * @param {boolean} hasActive - Has active executions
   * @param {boolean} hasError - Has error status
   */
  updateTrailStatusIcon(trail, hasActive, hasError) {
    const statusIcon = trail.querySelector('.trail-status-icon');
    if (!statusIcon) return;
    
    if (hasActive) {
      statusIcon.innerHTML = '<div class="trail-status-spinner"></div>';
    } else if (hasError) {
      statusIcon.innerHTML = '<div style="color: #ef4444; font-size: 16px; font-weight: bold;">✕</div>';
    } else {
      statusIcon.innerHTML = '<div style="color: #10b981; font-size: 16px; font-weight: bold;">✓</div>';
    }
  }
  
  /**
   * Update trail time display
   * @param {HTMLElement} trail - Trail container
   * @param {string} elapsed - Formatted elapsed time
   */
  updateTrailTime(trail, elapsed) {
    const timeDisplay = trail.querySelector('.trail-time');
    if (timeDisplay) {
      timeDisplay.textContent = elapsed;
    }
    
    // Update collapsed state title
    if (trail.dataset.state === 'collapsed') {
      const titleText = trail.querySelector('.trail-title-text');
      const trailNumber = trail.dataset.trailNumber;
      if (titleText) {
        titleText.textContent = `Trail ${trailNumber} (${elapsed})`;
      }
    }
  }
  
  /**
   * Finalize trail display
   * @param {HTMLElement} trail - Trail container
   */
  finalizeTrail(trail) {
    const startTime = parseInt(trail.dataset.startTime);
    const endTime = Date.now();
    trail.dataset.endTime = endTime;
    trail.dataset.finalized = 'true';
    trail.dataset.state = 'collapsed';
    
    // Update chevron
    const chevron = trail.querySelector('.trail-chevron');
    if (chevron) {
      chevron.className = 'trail-chevron rotate-0';
    }
    
    // Update title with final time
    const elapsed = this._formatElapsed(startTime, endTime);
    const titleText = trail.querySelector('.trail-title-text');
    const trailNumber = trail.dataset.trailNumber;
    if (titleText) {
      titleText.textContent = `Trail ${trailNumber} (${elapsed})`;
    }
    
    // Update status icon to completed
    const statusIcon = trail.querySelector('.trail-status-icon');
    if (statusIcon) {
      statusIcon.innerHTML = '<div style="color: #10b981; font-size: 16px; font-weight: bold;">✓</div>';
    }
    
    this._log('Finalized trail:', trail.dataset.trailId, '- time:', elapsed);
  }
  
  /**
   * Toggle trail state with animation
   * @param {HTMLElement} trail - Trail container
   * @param {string} targetState - Target state (collapsed/partial/expanded)
   * @returns {string} New state
   */
  toggleTrailState(trail, targetState = null) {
    const currentState = trail.dataset.state;
    const chevron = trail.querySelector('.trail-chevron');
    const titleText = trail.querySelector('.trail-title-text');
    const trailNumber = trail.dataset.trailNumber;
    
    let nextState = targetState;
    if (!nextState) {
      // Cycle through states
      switch (currentState) {
        case 'collapsed':
          nextState = 'partial';
          break;
        case 'partial':
          nextState = 'expanded';
          break;
        case 'expanded':
          nextState = 'collapsed';
          break;
        default:
          nextState = 'partial';
      }
    }
    
    // Update chevron
    switch (nextState) {
      case 'collapsed':
        if (chevron) chevron.className = 'trail-chevron rotate-0';
        if (titleText) {
          const startTime = parseInt(trail.dataset.startTime);
          const endTime = trail.dataset.endTime ? parseInt(trail.dataset.endTime) : null;
          const elapsed = this._formatElapsed(startTime, endTime);
          titleText.textContent = `Trail ${trailNumber} (${elapsed})`;
        }
        break;
      case 'partial':
        if (chevron) chevron.className = 'trail-chevron rotate-90';
        if (titleText) titleText.textContent = `Trail ${trailNumber}`;
        break;
      case 'expanded':
        if (chevron) chevron.className = 'trail-chevron rotate-180';
        if (titleText) titleText.textContent = `Trail ${trailNumber}`;
        break;
    }
    
    // Animate
    trail.classList.add('animating');
    trail.dataset.state = nextState;
    
    setTimeout(() => {
      trail.classList.remove('animating');
    }, 500);
    
    this._log('Toggled trail state:', currentState, '→', nextState);
    return nextState;
  }
  
  /**
   * Animate node addition
   * @param {HTMLElement} node - Node element
   */
  animateNodeAddition(node) {
    node.style.opacity = '0';
    node.style.transform = 'translateY(-10px)';
    
    requestAnimationFrame(() => {
      node.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      requestAnimationFrame(() => {
        node.style.opacity = '1';
        node.style.transform = 'translateY(0)';
      });
    });
  }
  
  /**
   * Get status CSS class
   * @private
   */
  _getStatusClass(status) {
    switch (status) {
      case 'completed': return 'completed';
      case 'error': return 'error';
      case 'active': return 'active';
      case 'pending': return 'pending';
      default: return 'pending';
    }
  }
  
  /**
   * Get label for phase kind
   * @private
   */
  _getLabelForKind(kind) {
    switch (kind) {
      case 'write': return 'Writing Code';
      case 'process': return 'Processing';
      case 'execute': return 'Executing';
      case 'output': return 'Output';
      default: return kind || 'Phase';
    }
  }
  
  /**
   * Calculate elapsed time for phase
   * @private
   */
  _calculateElapsed(phase) {
    if (!phase.startTime) return '0s';
    return this._formatElapsed(phase.startTime, phase.endTime);
  }
  
  /**
   * Format elapsed time
   * @private
   */
  _formatElapsed(startTime, endTime = null) {
    const end = endTime || Date.now();
    const elapsed = Math.floor((end - startTime) / 1000);
    
    if (elapsed < 60) {
      return `${elapsed}s`;
    }
    
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    return `${minutes}m ${seconds}s`;
  }
  
  /**
   * Handle node click - open artifact in artifacts window
   * @private
   */
  _handleNodeClick(phase, execution) {
    if (!phase.artifactId) {
      this._log('Node click ignored - no artifact');
      return;
    }
    
    this._log('Node clicked:', phase.kind, '- artifact:', phase.artifactId);
    
    // Emit event to open artifact
    if (this.eventBus) {
      this.eventBus.emit('trail:node-clicked', {
        phase: phase.kind,
        artifactId: phase.artifactId,
        artifactType: phase.artifactType,
        executionId: execution.id
      });
    }
    
    // Directly open artifacts window and show the artifact
    if (window.aether && window.aether.artifacts) {
      // Determine which tab based on phase kind
      const tabMap = {
        'write': 'code',    // Code written by assistant
        'execute': 'output', // Console output
        'output': 'output'   // HTML/final output
      };
      
      const tab = tabMap[phase.kind] || 'code';
      
      this._log('Opening artifacts window - tab:', tab, 'artifact:', phase.artifactId);
      
      // Switch to artifacts window and tab
      window.aether.artifacts.switchTab(tab);
      window.aether.artifacts.showArtifact(phase.artifactId);
    }
  }
  
  /**
   * Logging utility
   * @private
   */
  _log(...args) {
    if (this.enableLogging) {
      console.log('[TrailDOMRenderer]', ...args);
    }
  }
  
  /**
   * Dispose
   */
  dispose() {
    this._log('Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TrailDOMRenderer;
}

if (typeof window !== 'undefined') {
  window.TrailDOMRenderer = TrailDOMRenderer;
  console.log('📦 TrailDOMRenderer loaded');
}

