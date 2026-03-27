'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');
const DateUtils = require('../../../shared/utils/date-utils');

const trailRendererLogger = createRendererLogger('TrailDOMRenderer');

/**
 * @.architecture
 * Incoming: TrailContainerOrchestrator (method calls) --- {dom_types.trail_render_request, javascript_api}
 * Processing: Build and update trail DOM nodes, format time strings --- {2 jobs: JOB_CREATE_DOM_ELEMENT, JOB_UPDATE_DOM_ELEMENT}
 * Outgoing: HTMLElement updates --- {dom_types.trail_container_element, html}
 *
 * Note: Click handling is owned by TrailInteractionManager (separate SRP module).
 * This renderer is pure DOM construction — no event emission, no click handlers.
 */

class TrailDOMRenderer {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging || false;
    this.log = trailRendererLogger.child({ scope: 'trail-dom-renderer' });
    this._isDisposed = false;
  }
  
  /**
   * Create trail container element
   * @param {number} trailNumber - Trail sequence number
   * @returns {HTMLElement}
   */
  createTrailContainer(trailNumber) {
    // Outer container with flexbox layout (role indicator + wrapper)
    const trail = document.createElement('div');
    trail.className = 'chat-entry artifact-execution-trail-container';
    trail.dataset.state = 'partial';
    trail.dataset.finalized = 'false';
    const timestamp = DateUtils.getTimestamp();
    trail.dataset.trailId = `trail_${timestamp}_${Math.random().toString(36).substr(2, 9)}`;
    trail.dataset.trailNumber = trailNumber;
    trail.dataset.startTime = timestamp;
    
    // Role indicator (G for Guru/Agent)
    const roleIndicator = document.createElement('div');
    roleIndicator.className = 'chat-role-indicator';
    roleIndicator.textContent = 'G';
    
    // Content wrapper (timestamp + actual trail content)
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'trail-content-wrapper';
    
    // Timestamp
    const timestampEl = document.createElement('div');
    timestampEl.className = 'chat-timestamp';
    timestampEl.textContent = new Date().toLocaleTimeString();
    
    // Inner trail wrapper with glassmorphism styling
    const trailWrapper = document.createElement('div');
    trailWrapper.className = 'artifact-execution-trail-wrapper';
    
    const header = this._createTrailHeader(trailNumber);
    const innerContent = this._createTrailInnerContent();
    
    trailWrapper.appendChild(header);
    trailWrapper.appendChild(innerContent);
    
    contentWrapper.appendChild(timestampEl);
    contentWrapper.appendChild(trailWrapper);
    
    trail.appendChild(roleIndicator);
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
    chevron.className = 'trail-chevron rotate-0';
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
   * Create trail inner content with timeline
   * @private
   */
  _createTrailInnerContent() {
    const innerContent = document.createElement('div');
    innerContent.className = 'trail-inner-content';
    
    const timeline = document.createElement('div');
    timeline.className = 'trail-timeline';
    
    innerContent.appendChild(timeline);
    return innerContent;
  }
  
  /**
   * Create trail node (simplified for event-driven architecture)
   * @param {string} type - Node type (writing, executing, output)
   * @param {string} status - Node status (pending, active, completed, error)
   * @param {boolean} clickable - Whether node should be clickable
   * @returns {HTMLElement}
   */
  createTrailNode(type, status = 'pending', clickable = false) {
    const node = document.createElement('div');
    node.className = 'execution-node';
    node.dataset.phaseKind = type;
    node.dataset.phaseType = type;
    node.dataset.status = status;
    
    const statusClass = this._getStatusClass(status);
    node.classList.add(statusClass);
    
    const label = this._getLabelForKind(type);
    
    node.innerHTML = `
      <div class="node-header">
        <div class="node-title">
          <span>${label}</span>
        </div>
        <span class="node-time">0s</span>
      </div>
    `;
    
    if (clickable) {
      node.classList.add('clickable');
      node.title = 'Click to view';
    }
    
    return node;
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
      statusIcon.innerHTML = '<span class="trail-status-badge trail-status-badge--error">ERR</span>';
    } else {
      statusIcon.innerHTML = '<span class="trail-status-badge trail-status-badge--ok">OK</span>';
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
    const startTime = parseInt(trail.dataset.startTime, 10);
    const endTime = DateUtils.getTimestamp();
    trail.dataset.endTime = endTime;
    trail.dataset.finalized = 'true';
    trail.dataset.state = 'collapsed';
    
    // Update chevron — rotate-90 = > right = collapsed convention
    const chevron = trail.querySelector('.trail-chevron');
    if (chevron) {
      chevron.className = 'trail-chevron rotate-90';
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
      statusIcon.innerHTML = '<span class="trail-status-badge trail-status-badge--ok">OK</span>';
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
      // 2-state toggle: collapsed ↔ expanded
      // With exactly 3 nodes per subgroup (backend constraint), partial and expanded
      // are visually identical. A 3-state cycle forces 2 clicks to close — pure friction.
      nextState = (currentState === 'collapsed') ? 'expanded' : 'collapsed';
    }
    
    // Update chevron + title
    // Convention: rotate-90 (> right) = collapsed, rotate-0 (V down) = content visible
    // Matches macOS Finder / VS Code tree disclosure pattern.
    switch (nextState) {
      case 'collapsed':
        if (chevron) chevron.className = 'trail-chevron rotate-90';
        if (titleText) {
          const startTime = parseInt(trail.dataset.startTime, 10);
          const endTime = trail.dataset.endTime ? parseInt(trail.dataset.endTime, 10) : null;
          const elapsed = this._formatElapsed(startTime, endTime);
          titleText.textContent = `Trail ${trailNumber} (${elapsed})`;
        }
        break;
      case 'partial':
      case 'expanded':
        if (chevron) chevron.className = 'trail-chevron rotate-0';
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
   * Clears residual inline styles after transition so CSS classes
   * (e.g. .pending { opacity: 0.75 }) are not permanently overridden.
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
        
        // Clear residual inline styles after transition completes
        // Without this, inline opacity:'1' permanently overrides CSS class rules
        setTimeout(() => {
          node.style.removeProperty('opacity');
          node.style.removeProperty('transform');
          node.style.removeProperty('transition');
        }, 350); // 300ms transition + 50ms buffer
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
   * Format elapsed time
   * @private
   */
  _formatElapsed(startTime, endTime = null) {
    if (!startTime) {
      return '0s';
    }
    const normalizedStart = typeof startTime === 'number' ? startTime : parseInt(startTime, 10);
    const normalizedEnd = endTime != null
      ? (typeof endTime === 'number' ? endTime : parseInt(endTime, 10))
      : DateUtils.getTimestamp();
    return DateUtils.formatElapsedTime(normalizedStart, normalizedEnd);
  }
  
  /**
   * Logging utility
   * @private
   */
  _log(...args) {
    if (this.enableLogging) {
      this.log.trace(args.map(String).join(' '));
    }
  }
  
  /**
   * Dispose — mark renderer as disposed to prevent post-teardown operations.
   * Click handling is owned by TrailInteractionManager; this renderer is pure DOM.
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this._log('Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TrailDOMRenderer;
}

if (typeof window !== 'undefined') {
  window.TrailDOMRenderer = TrailDOMRenderer;
  trailRendererLogger.debug('TrailDOMRenderer module loaded');
}
