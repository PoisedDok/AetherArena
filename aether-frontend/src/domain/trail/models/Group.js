/**
 * Group Domain Model
 * 
 * Represents ONE user-agent turn ONLY IF artifacts are used.
 * 
 * @.architecture
 * Incoming: trail_schema_architecture.yaml, WebSocket trail.group_created events --- {Dict, json}
 * Processing: Validate group schema, normalize group fields --- {2 jobs: JOB_FILTER_DATA, JOB_VALIDATE_SCHEMA}
 * Outgoing: GroupRepository, TrailContainerManager --- {Group, Object}
 * 
 * CRITICAL INVARIANTS:
 * - Groups created ONLY when artifacts used in turn
 * - One group contains one or many subgroups
 * - sequence_number maintains turn order within chat
 */

'use strict';

class Group {
    /**
     * Create a Group instance
     * @param {Object} data - Group data
     * @param {string} data.groupId - Group UUID
     * @param {string} data.chatId - Parent chat UUID
     * @param {string} data.userMessage - User's message text
     * @param {string} data.agentMessage - Agent's response text
     * @param {number} data.sequenceNumber - Turn order within chat (1-indexed)
     * @param {string} [data.frontendId] - Frontend identifier
     * @param {string} [data.backendId] - Backend identifier
     * @param {string} [data.correlationId] - Correlation identifier
     * @param {string} [data.createdAt] - Creation timestamp
     * @param {string} [data.updatedAt] - Update timestamp
     * @param {Array} [data.subgroups] - Child subgroups
     */
    constructor(data) {
        // Required fields
        this.groupId = data.groupId || data.group_id;
        this.chatId = data.chatId || data.chat_id;
        this.userMessage = data.userMessage || data.user_message || '';
        this.agentMessage = data.agentMessage || data.agent_message || '';
        this.sequenceNumber = data.sequenceNumber || data.sequence_number;
        
        // Optional fields
        this.frontendId = data.frontendId || data.frontend_id || null;
        this.backendId = data.backendId || data.backend_id || null;
        this.correlationId = data.correlationId || data.correlation_id || null;
        this.createdAt = data.createdAt || data.created_at || new Date().toISOString();
        this.updatedAt = data.updatedAt || data.updated_at || new Date().toISOString();
        
        // Child entities
        this.subgroups = data.subgroups || [];
        
        // Validate
        this.validate();
    }
    
    /**
     * Validate group data
     * @throws {Error} If validation fails
     */
    validate() {
        if (!this.groupId) {
            throw new Error('Group must have groupId');
        }
        if (!this.chatId) {
            throw new Error('Group must have chatId');
        }
        if (typeof this.sequenceNumber !== 'number' || this.sequenceNumber < 1) {
            throw new Error('Group sequenceNumber must be a positive integer');
        }
    }
    
    /**
     * Add a subgroup to this group
     * @param {Subgroup} subgroup - Subgroup to add
     */
    addSubgroup(subgroup) {
        if (!subgroup || !subgroup.subgroupId) {
            throw new Error('Invalid subgroup');
        }
        this.subgroups.push(subgroup);
        this.subgroups.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    }
    
    /**
     * Get subgroup by ID
     * @param {string} subgroupId - Subgroup UUID
     * @returns {Subgroup|null}
     */
    getSubgroup(subgroupId) {
        return this.subgroups.find(s => s.subgroupId === subgroupId) || null;
    }
    
    /**
     * Get all subgroups ordered by sequence
     * @returns {Array<Subgroup>}
     */
    getSubgroups() {
        return [...this.subgroups].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    }
    
    /**
     * Convert to JSON for persistence
     * @returns {Object}
     */
    toJSON() {
        return {
            groupId: this.groupId,
            chatId: this.chatId,
            userMessage: this.userMessage,
            agentMessage: this.agentMessage,
            sequenceNumber: this.sequenceNumber,
            frontendId: this.frontendId,
            backendId: this.backendId,
            correlationId: this.correlationId,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            subgroups: this.subgroups.map(s => s.toJSON ? s.toJSON() : s)
        };
    }
    
    /**
     * Create Group from backend response
     * @param {Object} data - Backend data
     * @returns {Group}
     */
    static fromBackend(data) {
        return new Group({
            groupId: data.id || data.group_id,
            chatId: data.chat_id,
            userMessage: data.user_message,
            agentMessage: data.agent_message,
            sequenceNumber: data.sequence_number,
            frontendId: data.frontend_id,
            backendId: data.backend_id,
            correlationId: data.correlation_id,
            createdAt: data.created_at,
            updatedAt: data.updated_at,
            subgroups: []
        });
    }
    
    /**
     * Create Group from WebSocket event
     * @param {Object} event - WebSocket trail.group_created event
     * @returns {Group}
     */
    static fromWebSocketEvent(event) {
        return new Group({
            groupId: event.group_id,
            chatId: event.chat_id,
            sequenceNumber: event.sequence_number,
            userMessage: event.user_message || '[User message]',
            agentMessage: event.agent_message || '[Agent response]',
            frontendId: event.frontend_id,
            backendId: event.backend_id,
            correlationId: event.correlation_id,
            createdAt: event.timestamp || new Date().toISOString(),
            subgroups: []
        });
    }
}

module.exports = { Group };
