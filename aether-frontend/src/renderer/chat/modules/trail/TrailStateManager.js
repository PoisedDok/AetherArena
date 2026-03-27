'use strict';

// Incoming: Backend trail events via Orchestrator --- {group, subgroup, node, artifact metadata}
// Processing: Pure state management of trail hierarchy --- {1 job: JOB_STATE_MANAGEMENT}
// Outgoing: State queries, state change events --- {getters, events}

const { createRendererLogger } = require('../../../shared/utils/logger');

const stateLogger = createRendererLogger('TrailStateManager');

/**
 * TrailStateManager - Pure State Management for Trail Hierarchy
 * ==============================================================
 * 
 * SINGLE RESPONSIBILITY: Maintain in-memory state of trail hierarchy
 * 
 * ARCHITECTURE: Chat → Groups → Subgroups → Nodes → Artifacts
 * 
 * STATE STRUCTURE:
 * {
 *   chatId: Map<groupId, Group> where Group = {
 *     id: string,
 *     chatId: string,
 *     sequence_number: number,
 *     backend_id: string,
 *     subgroups: [Subgroup] where Subgroup = {
 *       id: string,
 *       nodes: [Node] where Node = {
 *         id: string,
 *         type: 'writing'|'executing'|'output',
 *         status: 'pending'|'active'|'completed'|'error',
 *         artifactId: string|null,
 *         clickable: boolean
 *       }
 *     }
 *   }
 * }
 * 
 * CONTRACTS:
 * - NO DOM manipulation
 * - NO rendering
 * - NO event emission (pure state)
 * - FAIL FAST on contract violations
 * 
 * @module renderer/chat/modules/trail/TrailStateManager
 */
class TrailStateManager {
  constructor(options = {}) {
    this.log = stateLogger.child({ scope: 'trail-state-manager' });
    
    // chatId → Map<groupId, Group>
    this.groups = new Map();
    
    // Current active context (transient)
    this._currentChatId = null;
    this._activeGroupId = null;
    this._activeSubgroupId = null;
    
    this.log.info('TrailStateManager initialized');
  }
  
  // =========================================================================
  // STATE MUTATIONS (Backend Event Handlers)
  // =========================================================================
  
  /**
   * Clear all state for a specific chat
   * Called before restoration to prevent duplicates
   * 
   * @param {string} chatId - Chat identifier
   */
  clearChatState(chatId) {
    if (this.groups.has(chatId)) {
      this.groups.delete(chatId);
      this.log.info('Cleared trail state for chat', { chatId: chatId.substring(0, 8) });
    }
  }
  
  /**
   * Create new group in state
   * Backend guarantees: group_id, chat_id, sequence_number, backend_id
   * 
   * @param {Object} payload - Backend-validated group payload
   * @throws {Error} If group already exists
   */
  createGroup(payload) {
    const { group_id, chat_id, sequence_number, backend_id, correlation_id } = payload;
    
    // FAIL FAST: Contract validation
    if (!group_id || !chat_id || typeof sequence_number !== 'number' || !backend_id) {
      throw new Error('[TrailStateManager] createGroup: Missing required fields');
    }
    
    // Initialize chat groups map if needed
    if (!this.groups.has(chat_id)) {
      this.groups.set(chat_id, new Map());
    }
    
    const chatGroups = this.groups.get(chat_id);
    
    // IDEMPOTENT: If group already exists (from previous restoration), return it
    if (chatGroups.has(group_id)) {
      this.log.debug('Group already exists in state (idempotent)', {
        groupId: group_id.substring(0, 8),
        chatId: chat_id.substring(0, 8)
      });
      return chatGroups.get(group_id);
    }
    
    // Create group state
    const group = {
      id: group_id,
      chatId: chat_id,
      sequence_number,
      backend_id,
      correlation_id, // Store correlation_id for accurate DOM anchoring
      subgroups: []
    };
    
    chatGroups.set(group_id, group);
    this._currentChatId = chat_id;
    this._activeGroupId = group_id;
    
    this.log.debug('Created group in state', {
      groupId: group_id.substring(0, 8),
      chatId: chat_id.substring(0, 8),
      sequenceNumber: sequence_number
    });
    
    return group;
  }
  
  /**
   * Create new subgroup within a group
   * Backend guarantees: subgroup_id, group_id, chat_id, nodes array
   * 
   * @param {Object} payload - Backend-validated subgroup payload
   * @throws {Error} If group not found or subgroup already exists
   */
  createSubgroup(payload) {
    const { subgroup_id, group_id, chat_id, nodes } = payload;
    
    
    // FAIL FAST: Contract validation
    if (!subgroup_id || !group_id || !chat_id) {
      throw new Error('[TrailStateManager] createSubgroup: Missing required fields');
    }
    
    if (!nodes || !Array.isArray(nodes) || nodes.length !== 3) {
      throw new Error('[TrailStateManager] createSubgroup: nodes array with 3 nodes is REQUIRED from backend');
    }
    
    const chatGroups = this.groups.get(chat_id);
    if (!chatGroups) {
      throw new Error(`[TrailStateManager] createSubgroup: Chat ${chat_id} not found`);
    }
    
    const group = chatGroups.get(group_id);
    if (!group) {
      throw new Error(`[TrailStateManager] createSubgroup: Group ${group_id} not found`);
    }
    
    // IDEMPOTENT: If subgroup already exists (from previous restoration), return it
    const existingSubgroup = group.subgroups.find(s => s.id === subgroup_id);
    if (existingSubgroup) {
      this.log.debug('Subgroup already exists in state (idempotent)', {
        subgroupId: subgroup_id.substring(0, 8),
        groupId: group_id.substring(0, 8)
      });
      return existingSubgroup;
    }
    
    // Create subgroup with backend's node data
    const subgroup = {
      id: subgroup_id,
      groupId: group_id,
      nodes: nodes.map(backendNode => ({
        id: backendNode.node_id,
        type: backendNode.type,
        status: backendNode.status || 'pending',
        artifactId: null,
        clickable: backendNode.clickable || false,
        duration_ms: backendNode.duration_ms, // TIMING DATA for restored trails
        started_at: backendNode.started_at,   // TIMING DATA for restored trails
        completed_at: backendNode.completed_at // TIMING DATA for restored trails
      }))
    };
    
    group.subgroups.push(subgroup);
    this._activeSubgroupId = subgroup_id;
    
    this.log.debug('Created subgroup in state', {
      subgroupId: subgroup_id.substring(0, 8),
      groupId: group_id.substring(0, 8),
      nodeCount: subgroup.nodes.length
    });
    
    return subgroup;
  }
  
  /**
   * Update node status in state
   * Backend guarantees: node_id, status, subgroup_id, group_id, chat_id
   * 
   * @param {Object} payload - Backend-validated node status payload
   * @throws {Error} If node not found
   */
  updateNodeStatus(payload) {
    const { node_id, status, subgroup_id, group_id, chat_id } = payload;
    
    // FAIL FAST: Contract validation
    if (!node_id || !status || !subgroup_id || !group_id || !chat_id) {
      throw new Error('[TrailStateManager] updateNodeStatus: Missing required fields');
    }
    
    const node = this._getNode(chat_id, group_id, subgroup_id, node_id);
    
    // Update status
    node.status = status;
    
    this.log.debug('Updated node status in state', {
      nodeId: node_id.substring(0, 8),
      status
    });
    
    return node;
  }
  
  /**
   * Link artifact to node
   * Backend guarantees: artifact_id, node_id, subgroup_id, group_id, chat_id
   * 
   * @param {Object} payload - Backend-validated artifact linkage payload
   * @throws {Error} If node not found
   */
  linkArtifact(payload) {
    const { artifact_id, node_id, subgroup_id, group_id, chat_id } = payload;
    
    // FAIL FAST: Contract validation
    if (!artifact_id || !node_id || !subgroup_id || !group_id || !chat_id) {
      throw new Error('[TrailStateManager] linkArtifact: Missing required fields');
    }
    
    const node = this._getNode(chat_id, group_id, subgroup_id, node_id);
    
    // Link artifact and make clickable
    node.artifactId = artifact_id;
    node.clickable = true;
    
    this.log.debug('Linked artifact to node in state', {
      nodeId: node_id.substring(0, 8),
      artifactId: artifact_id.substring(0, 40)
    });
    
    return node;
  }
  
  // =========================================================================
  // STATE QUERIES (Getters)
  // =========================================================================
  
  /**
   * Get all groups for a chat
   * @param {string} chatId - Chat identifier
   * @returns {Map<string, Group>|null}
   */
  getChatGroups(chatId) {
    return this.groups.get(chatId) || null;
  }
  
  /**
   * Get all groups for a chat as an array (sorted by sequence)
   * @param {string} chatId - Chat identifier
   * @returns {Map<string, Group>}
   */
  getAllGroupsForChat(chatId) {
    return this.groups.get(chatId) || new Map();
  }
  
  /**
   * Get specific group
   * @param {string} chatId - Chat identifier
   * @param {string} groupId - Group identifier
   * @returns {Group|null}
   */
  getGroup(chatId, groupId) {
    const chatGroups = this.groups.get(chatId);
    return chatGroups ? chatGroups.get(groupId) || null : null;
  }
  
  /**
   * Get specific subgroup
   * @param {string} chatId - Chat identifier
   * @param {string} groupId - Group identifier
   * @param {string} subgroupId - Subgroup identifier
   * @returns {Subgroup|null}
   */
  getSubgroup(chatId, groupId, subgroupId) {
    const group = this.getGroup(chatId, groupId);
    if (!group) return null;
    
    return group.subgroups.find(s => s.id === subgroupId) || null;
  }
  
  /**
   * Get specific node
   * @param {string} chatId - Chat identifier
   * @param {string} groupId - Group identifier
   * @param {string} subgroupId - Subgroup identifier
   * @param {string} nodeId - Node identifier
   * @returns {Node|null}
   */
  getNode(chatId, groupId, subgroupId, nodeId) {
    try {
      return this._getNode(chatId, groupId, subgroupId, nodeId);
    } catch (error) {
      return null;
    }
  }
  
  /**
   * Get current active context
   * @returns {Object} { chatId, groupId, subgroupId }
   */
  getActiveContext() {
    return {
      chatId: this._currentChatId,
      groupId: this._activeGroupId,
      subgroupId: this._activeSubgroupId
    };
  }
  
  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================
  
  /**
   * Get node (throws if not found)
   * @private
   */
  _getNode(chatId, groupId, subgroupId, nodeId) {
    const chatGroups = this.groups.get(chatId);
    if (!chatGroups) {
      throw new Error(`[TrailStateManager] Chat ${chatId} not found`);
    }
    
    const group = chatGroups.get(groupId);
    if (!group) {
      throw new Error(`[TrailStateManager] Group ${groupId} not found`);
    }
    
    const subgroup = group.subgroups.find(s => s.id === subgroupId);
    if (!subgroup) {
      throw new Error(`[TrailStateManager] Subgroup ${subgroupId} not found`);
    }
    
    const node = subgroup.nodes.find(n => n.id === nodeId);
    if (!node) {
      throw new Error(`[TrailStateManager] Node ${nodeId} not found`);
    }
    
    return node;
  }
  
  // =========================================================================
  // LIFECYCLE
  // =========================================================================
  
  /**
   * Dispose and cleanup all state
   */
  dispose() {
    this.groups.clear();
    this._currentChatId = null;
    this._activeGroupId = null;
    this._activeSubgroupId = null;
    this.log.info('TrailStateManager disposed');
  }
}

module.exports = TrailStateManager;
