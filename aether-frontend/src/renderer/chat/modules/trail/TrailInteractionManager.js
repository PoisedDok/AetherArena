'use strict';

// Incoming: User interactions from DOM (clicks) --- {click events}
// Processing: Attach/manage event handlers, emit interaction events --- {2 jobs: JOB_ATTACH_HANDLERS, JOB_EMIT_EVENTS}
// Outgoing: EventBus events for artifact display --- {EventTypes.TRAIL.NODE_CLICKED, trail header toggle}

const { createRendererLogger } = require('../../../shared/utils/logger');

const interactionLogger = createRendererLogger('TrailInteractionManager');

/**
 * TrailInteractionManager - User Interaction Handling
 * ====================================================
 * 
 * SINGLE RESPONSIBILITY: Manage all trail-related user interactions
 * 
 * INTERACTIONS:
 * - Trail header clicks (expand/collapse)
 * - Node clicks (open artifact)
 * - Event delegation
 * 
 * CONTRACTS:
 * - Attaches click handlers to DOM elements
 * - Emits events via EventBus
 * - NO state management
 * - NO rendering
 * - FAIL FAST on contract violations
 * 
 * @module renderer/chat/modules/trail/TrailInteractionManager
 */
class TrailInteractionManager {
  constructor(options = {}) {
    this.eventBus = options.eventBus || null;
    this.renderer = options.renderer || null;
    this.log = interactionLogger.child({ scope: 'trail-interaction-manager' });
    
    if (!this.eventBus) {
      throw new Error('[TrailInteractionManager] eventBus is REQUIRED');
    }
    
    this._isDisposed = false;
    this.log.info('TrailInteractionManager initialized');
  }
  
  // =========================================================================
  // CLICK HANDLER ATTACHMENT
  // =========================================================================
  
  /**
   * Attach click handler to trail header for expand/collapse
   * @param {HTMLElement} trailElement - Trail container element
   * @throws {Error} If trailElement is invalid
   */
  attachHeaderClickHandler(trailElement) {
    if (!trailElement || !trailElement.querySelector) {
      throw new Error('[TrailInteractionManager] attachHeaderClickHandler: Invalid trailElement');
    }
    
    const trailHeader = trailElement.querySelector('.trail-header');
    if (!trailHeader) {
      this.log.warn('Trail header not found', { trailId: trailElement.dataset.trailId });
      return;
    }
    
    // Remove existing handler if present
    if (trailHeader._clickHandler) {
      trailHeader.removeEventListener('click', trailHeader._clickHandler);
    }
    
    // Create and attach new handler
    const clickHandler = (e) => {
      // Don't toggle if clicking inside execution node
      if (e.target.closest('.execution-node')) return;
      
      // Toggle trail state using renderer
      if (this.renderer && typeof this.renderer.toggleTrailState === 'function') {
        const newState = this.renderer.toggleTrailState(trailElement);
        
        this.log.debug('Trail header clicked', {
          trailId: trailElement.dataset.trailId?.substring(0, 20),
          newState
        });
      }
    };
    
    trailHeader._clickHandler = clickHandler;
    trailHeader.addEventListener('click', clickHandler);
    
    this.log.trace('Attached header click handler', {
      trailId: trailElement.dataset.trailId?.substring(0, 20)
    });
  }
  
  /**
   * Attach click handler to trail node for artifact display
   * @param {HTMLElement} nodeElement - Node element
   * @param {string} artifactId - Artifact identifier
   * @param {string} nodeId - Node identifier
   * @param {string} subgroupId - Subgroup identifier
   * @param {string} nodeType - Node type (writing, executing, output)
   * @throws {Error} If required parameters missing
   */
  attachNodeClickHandler(nodeElement, artifactId, nodeId, subgroupId, nodeType) {
    if (!nodeElement || !artifactId || !nodeId || !subgroupId || !nodeType) {
      throw new Error('[TrailInteractionManager] attachNodeClickHandler: Missing required parameters');
    }
    
    // Make node visually clickable — cursor handled by CSS .clickable rule
    nodeElement.classList.add('clickable');
    nodeElement.title = 'Click to view artifact';
    
    // Remove existing handler if present
    if (nodeElement._clickHandler) {
      nodeElement.removeEventListener('click', nodeElement._clickHandler);
    }
    
    // Create and attach new handler
    const clickHandler = (e) => {
      e.stopPropagation();
      
      // Emit event for ChatController to handle
      // CRITICAL: Must match EventTypes.TRAIL.NODE_CLICKED = 'trail:node:clicked' (with colons)
      const { EventTypes } = require('../../../../core/events/EventTypes');
      this.eventBus.emit(EventTypes.TRAIL.NODE_CLICKED, {
        artifactId: artifactId,
        artifactType: nodeType === 'writing' ? 'code' : 'output',
        nodeId: nodeId,
        subgroupId: subgroupId
      });
      
      this.log.debug('Trail node clicked', {
        artifactId: artifactId.substring(0, 40),
        nodeType
      });
    };
    
    nodeElement._clickHandler = clickHandler;
    nodeElement.addEventListener('click', clickHandler);
    
    this.log.trace('Attached node click handler', {
      nodeId: nodeId.substring(0, 8),
      artifactId: artifactId.substring(0, 40)
    });
  }
  
  /**
   * Remove click handler from node (e.g., when node becomes non-clickable)
   * @param {HTMLElement} nodeElement - Node element
   */
  detachNodeClickHandler(nodeElement) {
    if (!nodeElement) return;
    
    if (nodeElement._clickHandler) {
      nodeElement.removeEventListener('click', nodeElement._clickHandler);
      nodeElement._clickHandler = null;
    }
    
    nodeElement.classList.remove('clickable');
    nodeElement.title = '';
  }
  
  // =========================================================================
  // CLEANUP
  // =========================================================================
  
  /**
   * Remove all attached handlers (for cleanup)
   */
  destroy() {
    if (this._isDisposed) return;

    this._isDisposed = true;
    this.eventBus = null;
    this.renderer = null;
    // Note: Individual handlers are cleaned up via removeEventListener
    // when elements are removed from DOM by parent teardown.
    this.log.info('TrailInteractionManager destroyed');
  }
}

module.exports = TrailInteractionManager;
