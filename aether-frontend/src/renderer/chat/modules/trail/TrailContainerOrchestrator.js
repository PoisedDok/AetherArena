'use strict';

// Incoming: Backend trail events via TrailEventRouter --- {trail.group_created, trail.subgroup_created, trail.node_status_updated, trail.artifact_linked, trail.subgroup_completed}
// Processing: Thin coordination layer - delegates to specialized modules --- {1 job: JOB_COORDINATE}
// Outgoing: Module method calls, DOM updates --- {state mutations, time tracking, rendering, interactions}

const { createRendererLogger } = require('../../../shared/utils/logger');
const TrailStateManager = require('./TrailStateManager');
const TrailTimeManager = require('./TrailTimeManager');
const TrailInteractionManager = require('./TrailInteractionManager');
const TrailDOMRenderer = require('./TrailDOMRenderer');

const orchestratorLogger = createRendererLogger('TrailContainerOrchestrator');

/**
 * TrailContainerOrchestrator - Module Coordination Layer
 * =======================================================
 * 
 * SINGLE RESPONSIBILITY: Coordinate specialized trail modules
 * 
 * ARCHITECTURE PRINCIPLES:
 * - THIN: < 200 lines, pure delegation
 * - NO business logic
 * - NO state management (delegates to StateManager)
 * - NO rendering (delegates to DOMRenderer)
 * - NO time tracking (delegates to TimeManager)
 * - NO interactions (delegates to InteractionManager)
 * 
 * FLOW:
 * Backend Event → TrailEventRouter → Orchestrator → Module(s)
 * 
 * @module renderer/chat/modules/trail/TrailContainerOrchestrator
 */
class TrailContainerOrchestrator {
  constructor(options = {}) {
    this.container = options.container || null;
    this.eventBus = options.eventBus || null;
    this.enableLogging = options.enableLogging || false;
    this.log = orchestratorLogger.child({ scope: 'trail-orchestrator' });
    
    if (!this.container) {
      throw new Error('[TrailContainerOrchestrator] container is REQUIRED');
    }
    
    if (!this.eventBus) {
      throw new Error('[TrailContainerOrchestrator] eventBus is REQUIRED');
    }
    
    // Initialize all specialized modules
    this.stateManager = new TrailStateManager({ enableLogging: this.enableLogging });
    
    this.timeManager = new TrailTimeManager({
      container: this.container,
      enableLogging: this.enableLogging
    });
    
    this.renderer = new TrailDOMRenderer({ enableLogging: this.enableLogging });
    
    this.interactionManager = new TrailInteractionManager({
      eventBus: this.eventBus,
      renderer: this.renderer,
      enableLogging: this.enableLogging
    });
    
    this._isDisposed = false;

    this.log.info('TrailContainerOrchestrator initialized with all modules');
  }
  
  // =========================================================================
  // BACKEND EVENT HANDLERS (Delegation)
  // =========================================================================
  
  /**
   * Handle trail.group_created event
   * @param {Object} payload - Backend-validated group payload
   */
  handleGroupCreated(payload) {
    if (this._isDisposed) return;

    const { group_id, sequence_number } = payload;
    
    // 1. Update state
    this.stateManager.createGroup(payload);
    
    this.log.debug('Handled group_created', {
      groupId: group_id.substring(0, 8),
      sequenceNumber: sequence_number
    });
  }
  
  /**
   * Handle trail.subgroup_created event
   * @param {Object} payload - Backend-validated subgroup payload
   */
  handleSubgroupCreated(payload) {
    if (this._isDisposed) return;

    const { subgroup_id, group_id, chat_id, _restored, _timelineSequence, sequence_in_chat } = payload;
    
    // DEBUG: Comprehensive logging to find stub cause
    const callStack = new Error().stack.split('\n')[2]?.trim().substring(0, 100);
    this.log.warn(`🔵 [TrailOrchestrator] START subgroup=${subgroup_id.substring(0, 8)} group=${group_id.substring(0, 8)} restored=${_restored} nodes=${payload.nodes?.length} caller=${callStack}`);
    
    // IDEMPOTENT CHECK: If trail already exists in DOM, STOP
    if (this.container) {
      const existing = this.container.querySelector(`[data-subgroup-id="${subgroup_id}"]`);
      if (existing) {
        this.log.error(`🔴 [TrailOrchestrator] DUPLICATE PREVENTED: subgroup=${subgroup_id.substring(0, 8)} existingTrail=${existing.dataset.trailId} caller=${callStack}`);
        return; // CRITICAL: Skip duplicate
      }
    }
    
    // 1. Update state
    const subgroup = this.stateManager.createSubgroup(payload);
    
    this.log.warn(`🟢 [TrailOrchestrator] State created: nodes=${subgroup.nodes?.length}`);
    
    // 2. Render trail container + nodes
    // ARCHITECTURAL FIX: Use subgroup_sequence for trail numbering (not group sequence)
    const trailNumber = payload.subgroup_sequence_number || payload.subgroup_sequence || payload.sequence_number || 1;
    
    const trailElement = this.renderer.createTrailContainer(trailNumber);
    trailElement.dataset.groupId = group_id;
    trailElement.dataset.subgroupId = subgroup_id;
    trailElement.dataset.chatId = chat_id;
    trailElement.dataset.backendId = payload.backend_id; // ARCHITECTURAL FIX: Set backend_id for positioning/linkage
    
    // ARCHITECTURAL FIX: Set timeline sequence for DOM ordering
    // Use sequence_in_chat for LIVE trails, _timelineSequence for RESTORED trails
    const timelineSequence = _restored ? _timelineSequence : sequence_in_chat;
    if (timelineSequence !== undefined) {
      trailElement.dataset.sequence = timelineSequence;
    }
    
    // CRITICAL: For restored trails, start collapsed and mark as restored
    if (_restored) {
      trailElement.dataset.state = 'collapsed';
      trailElement.dataset.restored = 'true';
      // Fix chevron to match collapsed convention (> right)
      // createTrailContainer sets rotate-0 (V down = content visible) for live trails,
      // but restored trails start collapsed, so chevron must indicate collapsed state.
      const restoredChevron = trailElement.querySelector('.trail-chevron');
      if (restoredChevron) restoredChevron.className = 'trail-chevron rotate-90';
    }
    
    const timeline = trailElement.querySelector('.trail-timeline');
    
    this.log.warn(`🟡 [TrailOrchestrator] Pre-render: timeline=${!!timeline} nodeCount=${subgroup.nodes?.length}`);
    
    // Render 3 nodes
    let nodesRendered = 0;
    for (const node of subgroup.nodes) {
      const nodeElement = this.renderer.createTrailNode(node.type, node.status, node.clickable);
      nodeElement.dataset.nodeId = node.id;
      nodeElement.dataset.nodeType = node.type;
      nodeElement.dataset.subgroupId = subgroup_id;
      
      // ARCHITECTURAL FIX: For restored trails, display historical duration
      if (_restored && node.duration_ms) {
        const nodeTimeDisplay = nodeElement.querySelector('.node-time');
        if (nodeTimeDisplay) {
          const formattedTime = this._formatDuration(node.duration_ms);
          nodeTimeDisplay.textContent = formattedTime;
        }
      }
      
      // Set initial hidden state BEFORE DOM insertion for live trails.
      // Restored trails skip animation (they start collapsed/invisible anyway).
      if (!_restored) {
        nodeElement.style.opacity = '0';
        nodeElement.style.transform = 'translateY(-10px)';
      }
      
      timeline.appendChild(nodeElement);
      
      // Stagger entrance animation: each node slides in 100ms after the previous.
      // animateNodeAddition handles the transition and cleans up inline styles after.
      if (!_restored) {
        const staggerDelay = nodesRendered * 100;
        ((el, delay) => {
          setTimeout(() => {
            this.renderer.animateNodeAddition(el);
          }, delay);
        })(nodeElement, staggerDelay);
      }
      
      nodesRendered++;
    }
    
    this.log.warn(`🟢 [TrailOrchestrator] Rendered: count=${nodesRendered} timelineChildren=${timeline?.childNodes.length} trailId=${trailElement.dataset.trailId}`);
    
    // ARCHITECTURAL NOTE: No need to remove assistant message containers
    // ROOT CAUSE FIXED: StreamHandler now uses lazy container creation
    // Containers only created when first visible text arrives
    // If agent immediately executes code, no container is created in the first place
    
    const isRestored = !!_restored;
    
    // Insert into DOM with robust positioning
    if (this.container) {
      // ARCHITECTURAL FIX: Deterministic Sequence-Based Anchoring
      // Enforce rigorous sequence-based traversal for flawless interleaving.
      
      let insertAfter = null;
      let usedSequence = false;
      if (timelineSequence !== undefined) {
        const allEntries = Array.from(this.container.querySelectorAll('.chat-entry'));
        
        // Find the last element with a sequence strictly less than timelineSequence
        for (const element of allEntries) {
          const sequenceStr = element.dataset.sequence;
          if (sequenceStr) {
            const sequence = parseInt(sequenceStr, 10);
            if (Number.isFinite(sequence) && sequence < timelineSequence) {
              insertAfter = element;
              usedSequence = true;
            } else if (Number.isFinite(sequence) && sequence >= timelineSequence) {
              // We've hit an element with a higher or equal sequence, so we stop searching.
              // insertAfter is correctly pointing to the last valid preceding element.
              usedSequence = true;
              break;
            }
          }
        }
      }

      // If we didn't use sequence (no timelineSequence or no entries with sequence), fallback to correlation_id
      if (!usedSequence) {
        const group = this.stateManager.groups.get(chat_id)?.get(group_id);
        const correlationId = group ? group.correlation_id : payload.correlation_id;
        
        if (correlationId) {
          insertAfter = this.container.querySelector(`.chat-entry[data-message-id="${correlationId}"], .chat-entry[data-correlation-id="${correlationId}"]`);
          if (insertAfter) {
            this.log.debug('Found deterministic insertion anchor by correlationId', {
              correlationId,
              subgroupId: subgroup_id.substring(0, 8)
            });
          }
        }
        
        if (!insertAfter && group && group.backend_id) {
           // Fallback to backend_id (request_id) if correlationId not found
           insertAfter = this.container.querySelector(`.chat-entry[data-message-id="${group.backend_id}"], .chat-entry[data-backend-id="${group.backend_id}"]`);
        }

        if (insertAfter) {
          // We found the exact user message to anchor after.
          // Traverse down past any existing trails to ensure chronological ordering.
          let currentAnchor = insertAfter;
          let nextSibling = currentAnchor.nextElementSibling;
          
          while (nextSibling && nextSibling.classList.contains('artifact-execution-trail-container')) {
            currentAnchor = nextSibling;
            nextSibling = currentAnchor.nextElementSibling;
          }
          insertAfter = currentAnchor;
        } else {
           this.log.warn('Could not determine exact timeline position via sequence or correlationId, using fallback positioning', {
            correlationId,
            timelineSequence,
            subgroupId: subgroup_id.substring(0, 8),
          });
        }
      }
      
      // Fallback: If no valid insertion point found via sequence, append to end
      if (insertAfter) {
        insertAfter.insertAdjacentElement('afterend', trailElement);
      } else {
        const allEntries = this.container.querySelectorAll('.chat-entry');
        const lastEntry = allEntries[allEntries.length - 1];
        if (lastEntry) {
          lastEntry.insertAdjacentElement('afterend', trailElement);
        } else {
          this.container.appendChild(trailElement);
        }
      }
    }
    
    this.log.warn(`🟢 [TrailOrchestrator] DOM inserted: trailId=${trailElement.dataset.trailId} subgroup=${subgroup_id.substring(0, 8)} hasParent=${!!trailElement.parentElement}`);
    
    // 4. Attach header click handler
    this.interactionManager.attachHeaderClickHandler(trailElement);
    
    // 5. Time tracking: live vs restored
    const trailId = trailElement.dataset.trailId;
    const durationMs = payload._duration_ms;
    
    if (!_restored) {
      // LIVE TRAIL: Start timer with current time
      const startTime = parseInt(trailElement.dataset.startTime, 10);
      this.timeManager.startTrail(trailId, startTime);
    } else if (durationMs !== undefined && durationMs !== null) {
      // RESTORED TRAIL: Set final elapsed time immediately
      const seconds = Math.round(durationMs / 1000);
      const timeText = seconds >= 60 
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${seconds}s`;
      
      const titleTextEl = trailElement.querySelector('.trail-title-text');
      if (titleTextEl) {
        titleTextEl.textContent = `Trail ${trailNumber} (${timeText})`;
      }
      
      // Set .trail-time text for when user expands the restored trail.
      // CSS hides .trail-time in collapsed state — no inline style override needed.
      // Previous bug: inline style.display='none' persisted across state changes,
      // permanently hiding time info when user expanded restored trails.
      const timeDisplay = trailElement.querySelector('.trail-time');
      if (timeDisplay) {
        timeDisplay.textContent = timeText;
      }
      
      // Set endTime dataset for correct elapsed recalculation on re-collapse.
      // Previous bug: missing endTime caused _formatElapsed(startTime, null) to use
      // Date.now(), showing wildly wrong elapsed time (hours instead of seconds).
      const startTime = parseInt(trailElement.dataset.startTime, 10);
      trailElement.dataset.endTime = (startTime + durationMs).toString();
      
      // Show checkmark for completed restored trails
      const statusIcon = trailElement.querySelector('.trail-status-icon');
      if (statusIcon) {
        statusIcon.innerHTML = '<span class="trail-status-badge trail-status-badge--ok">OK</span>';
      }
    } else {
      // RESTORED TRAIL WITHOUT DURATION: Show em-dash instead of hiding.
      // Previous bug: inline style.display='none' permanently hid time info.
      const timeDisplay = trailElement.querySelector('.trail-time');
      if (timeDisplay) {
        timeDisplay.textContent = '\u2014';
      }
    }
    
    this.log.debug('Handled subgroup_created', {
      subgroupId: subgroup_id.substring(0, 8),
      groupId: group_id.substring(0, 8),
      trailNumber,
      timelineSequence: _timelineSequence,
      isRestored
    });
    
    this.log.warn(`✅ [TrailOrchestrator] COMPLETE: subgroup=${subgroup_id.substring(0, 8)} trailId=${trailElement.dataset.trailId} nodesInTimeline=${timeline?.childNodes.length} inDOM=${!!trailElement.parentElement}`);
  }
  
  /**
   * Handle trail.node_status_updated event
   * @param {Object} payload - Backend-validated node status payload
   */
  handleNodeStatusUpdated(payload) {
    if (this._isDisposed) return;

    const { node_id, status, subgroup_id, group_id, chat_id } = payload;
    
    try {
      
      // 1. Update state
      const node = this.stateManager.updateNodeStatus(payload);
      
      
      // 2. Update DOM status classes
      const nodeElement = this.container.querySelector(
        `[data-subgroup-id="${subgroup_id}"][data-node-id="${node_id}"]`
      );
      
      if (nodeElement) {
        const nodeType = nodeElement.dataset.nodeType;
        
        // Update status class
        nodeElement.classList.remove('pending', 'active', 'completed', 'error');
        nodeElement.classList.add(status);
        
        // 3. Track time
        if (status === 'active') {
          this.timeManager.startNode(node_id, subgroup_id);
        } else if (status === 'completed') {
          this.timeManager.completeNode(node_id, subgroup_id);
        }
                    } else {
                      // Log warning if DOM element missing, but state is already updated 
                      // so it will render correctly if re-attached.
                      this.log.warn('Node element not found for status update, state updated but DOM skipped', {
                        nodeId: node_id ? node_id.substring(0, 8) : 'null',
                        status
                      });
                    }
      
      this.log.debug('Handled node_status_updated', {
        nodeId: node_id.substring(0, 8),
        status
      });
    } catch (error) {
      this.log.error('Failed to handle node_status_updated', { error: error.message });
    }
  }
  
  /**
   * Handle trail.artifact_linked event
   * @param {Object} payload - Backend-validated artifact linkage payload
   */
  handleArtifactLinked(payload) {
    if (this._isDisposed) return;

    const { artifact_id, node_id, subgroup_id, group_id, chat_id } = payload;
    
    // 1. Update state
    const node = this.stateManager.linkArtifact(payload);
    
    // 2. Find node element
    const nodeElement = this.container.querySelector(
      `[data-subgroup-id="${subgroup_id}"][data-node-id="${node_id}"]`
    );
    
    if (nodeElement) {
      // 3. Set artifact ID
      nodeElement.dataset.artifactId = artifact_id;
      
      // 4. Attach click handler
      const nodeType = nodeElement.dataset.nodeType;
      this.interactionManager.attachNodeClickHandler(
        nodeElement,
        artifact_id,
        node_id,
        subgroup_id,
        nodeType
      );
    }
    
    this.log.debug('Handled artifact_linked', {
      nodeId: node_id.substring(0, 8),
      artifactId: artifact_id.substring(0, 40)
    });
  }
  
  /**
   * Handle trail.subgroup_completed event
   * @param {Object} payload - Backend-validated subgroup completion payload
   */
  handleSubgroupCompleted(payload) {
    if (this._isDisposed) return;

    const { subgroup_id, group_id } = payload;
    
    // Find trail element
    const trailElement = this.container.querySelector(
      `[data-group-id="${group_id}"][data-subgroup-id="${subgroup_id}"]`
    );
    
    if (!trailElement) {
      this.log.warn('Trail element not found for completion', { subgroupId: subgroup_id.substring(0, 8) });
      return;
    }
    
    // 1. Complete trail time tracking (only if it was actually started)
    // During restoration, trails are created but never started in time manager
    const trailId = trailElement.dataset.trailId;
    const isRestored = trailElement.dataset.restored === 'true';
    
    if (!isRestored && this.timeManager.trailTimes.has(trailId)) {
      this.timeManager.completeTrail(trailId);
    }
    
    // 2. Stop spinner, show checkmark
    const statusIcon = trailElement.querySelector('.trail-status-icon');
    if (statusIcon) {
      statusIcon.innerHTML = '<span class="trail-status-badge trail-status-badge--ok">OK</span>';
    }
    
    // ARCHITECTURAL FIX: Proactively complete all nodes in this subgroup
    // This ensures no node stays in "active" (spinning) state if backend missed a status update
    // AND clears any live node timer intervals that were left running.
    const nodes = trailElement.querySelectorAll('.execution-node');
    nodes.forEach(node => {
      node.classList.remove('pending', 'active', 'error');
      node.classList.add('completed');
      
      // Stop node timer interval — without this, node timers tick forever
      const nodeId = node.dataset.nodeId;
      const nodeSubgroupId = node.dataset.subgroupId;
      if (nodeId && nodeSubgroupId && this.timeManager.nodeTimes.has(nodeId)) {
        this.timeManager.completeNode(nodeId, nodeSubgroupId);
      }
    });
    
    // 3. Collapse trail
    this.renderer.toggleTrailState(trailElement, 'collapsed');
    
    this.log.debug('Handled subgroup_completed', {
      subgroupId: subgroup_id.substring(0, 8),
      groupId: group_id.substring(0, 8)
    });
  }
  
  // =========================================================================
  // CLEANUP
  // =========================================================================
  
  /**
   * Format duration in milliseconds to human-readable string
   * @private
   * @param {number} durationMs - Duration in milliseconds
   * @returns {string} Formatted duration (e.g., "2s", "1m 5s")
   */
  _formatDuration(durationMs) {
    if (!durationMs || durationMs < 0) return '0s';
    
    const totalSeconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    
    if (minutes > 0) {
      return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
    }
    return `${seconds}s`;
  }
  
  /**
   * Destroy all modules
   */
  destroy() {
    if (this._isDisposed) return;

    this._isDisposed = true;

    this.timeManager.destroy();
    this.interactionManager.destroy();
    this.stateManager.dispose();
    this.renderer.dispose();

    this.container = null;
    this.eventBus = null;
    this.stateManager = null;
    this.timeManager = null;
    this.renderer = null;
    this.interactionManager = null;

    this.log.info('TrailContainerOrchestrator destroyed');
  }
}

module.exports = TrailContainerOrchestrator;
