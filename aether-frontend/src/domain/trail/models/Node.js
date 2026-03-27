/**
 * Node Domain Model
 * 
 * Represents a STATE in the trail container (writing, executing, output).
 * 
 * @.architecture
 * Incoming: trail_schema_architecture.yaml, WebSocket trail.node_status_updated events --- {Dict, json}
 * Processing: Validate node schema, normalize node fields --- {2 jobs: JOB_FILTER_DATA, JOB_VALIDATE_SCHEMA}
 * Outgoing: NodeRepository, TrailDOMRenderer --- {Node, Object}
 * 
 * CRITICAL INVARIANTS:
 * - writing node: sequence=1, clickable=true, links to code artifact
 * - executing node: sequence=2, clickable=false, NO artifact
 * - output node: sequence=3, clickable=true, links to output artifact
 * - Status transitions: pending → active → completed|error
 */

'use strict';

class Node {
    /**
     * Create a Node instance
     * @param {Object} data - Node data
     * @param {string} data.nodeId - Node UUID
     * @param {string} data.subgroupId - Parent subgroup UUID
     * @param {string} data.type - Node type (writing|executing|output)
     * @param {number} data.sequence - Node sequence (1|2|3)
     * @param {boolean} data.clickable - Whether node is clickable in UI
     * @param {string} [data.status] - Status (pending|active|completed|error)
     * @param {string} [data.artifactId] - Linked artifact ID (null for executing node)
     * @param {string} [data.createdAt] - Creation timestamp
     * @param {string} [data.updatedAt] - Update timestamp
     */
    constructor(data) {
        // Required fields
        this.nodeId = data.nodeId || data.node_id;
        this.subgroupId = data.subgroupId || data.subgroup_id;
        this.type = data.type;
        this.sequence = data.sequence;
        this.clickable = data.clickable;
        
        // Optional fields
        this.status = data.status || 'pending';
        this.artifactId = data.artifactId || data.artifact_id || null;
        this.createdAt = data.createdAt || data.created_at || new Date().toISOString();
        this.updatedAt = data.updatedAt || data.updated_at || new Date().toISOString();
        
        // Validate
        this.validate();
    }
    
    /**
     * Validate node data
     * @throws {Error} If validation fails
     */
    validate() {
        // nodeId may be null for pre-persistence stubs; backend assigns IDs on save.
        if (!this.subgroupId) {
            throw new Error('Node must have subgroupId');
        }
        
        // Validate type
        if (!['writing', 'executing', 'output'].includes(this.type)) {
            throw new Error(`Invalid node type: ${this.type}`);
        }
        
        // Validate sequence
        if (![1, 2, 3].includes(this.sequence)) {
            throw new Error(`Invalid node sequence: ${this.sequence}. Must be 1, 2, or 3`);
        }
        
        // Validate status
        if (!['pending', 'active', 'completed', 'error'].includes(this.status)) {
            throw new Error(`Invalid node status: ${this.status}`);
        }
        
        // CRITICAL: Validate type → sequence → clickable mapping
        if (this.type === 'writing' && (this.sequence !== 1 || this.clickable !== true)) {
            throw new Error('Writing node must have sequence=1 and clickable=true');
        }
        if (this.type === 'executing' && (this.sequence !== 2 || this.clickable !== false)) {
            throw new Error('Executing node must have sequence=2 and clickable=false');
        }
        if (this.type === 'output' && (this.sequence !== 3 || this.clickable !== true)) {
            throw new Error('Output node must have sequence=3 and clickable=true');
        }
        
        // Validate artifact linkage rules
        if (this.type === 'executing' && this.artifactId) {
            throw new Error('Executing node cannot have artifact');
        }
    }
    
    /**
     * Update status
     * @param {string} status - New status
     */
    updateStatus(status) {
        if (!['pending', 'active', 'completed', 'error'].includes(status)) {
            throw new Error(`Invalid node status: ${status}`);
        }
        this.status = status;
        this.updatedAt = new Date().toISOString();
    }
    
    /**
     * Set artifact ID
     * @param {string} artifactId - Artifact UUID
     * @throws {Error} If trying to set artifact on executing node
     */
    setArtifact(artifactId) {
        if (this.type === 'executing') {
            throw new Error('Cannot set artifact on executing node');
        }
        this.artifactId = artifactId;
        this.updatedAt = new Date().toISOString();
    }
    
    /**
     * Check if node is active
     * @returns {boolean}
     */
    isActive() {
        return this.status === 'active';
    }
    
    /**
     * Check if node is completed
     * @returns {boolean}
     */
    isCompleted() {
        return this.status === 'completed';
    }
    
    /**
     * Check if node has artifact
     * @returns {boolean}
     */
    hasArtifact() {
        return this.artifactId !== null;
    }
    
    /**
     * Get CSS class for node type
     * @returns {string}
     */
    getTypeClass() {
        return `trail-node-${this.type}`;
    }
    
    /**
     * Get CSS class for node status
     * @returns {string}
     */
    getStatusClass() {
        return `trail-node-${this.status}`;
    }
    
    /**
     * Get display label for node
     * @returns {string}
     */
    getLabel() {
        switch (this.type) {
            case 'writing':
                return 'Writing';
            case 'executing':
                return 'Executing';
            case 'output':
                return 'Output';
            default:
                return this.type;
        }
    }
    
    /**
     * Get icon for node type
     * @returns {string}
     */
    getIcon() {
        switch (this.type) {
            case 'writing':
                return '✏️';
            case 'executing':
                return '⚙️';
            case 'output':
                return '📊';
            default:
                return '•';
        }
    }
    
    /**
     * Convert to JSON for persistence
     * @returns {Object}
     */
    toJSON() {
        return {
            nodeId: this.nodeId,
            subgroupId: this.subgroupId,
            type: this.type,
            sequence: this.sequence,
            clickable: this.clickable,
            status: this.status,
            artifactId: this.artifactId,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt
        };
    }
    
    /**
     * Create Node from backend response
     * @param {Object} data - Backend data
     * @returns {Node}
     */
    static fromBackend(data) {
        return new Node({
            nodeId: data.id || data.node_id,
            subgroupId: data.subgroup_id,
            type: data.type,
            sequence: data.sequence,
            clickable: data.clickable,
            status: data.status,
            artifactId: data.artifact_id,
            createdAt: data.created_at,
            updatedAt: data.updated_at
        });
    }
    
    /**
     * Create Node from WebSocket event
     * @param {Object} event - WebSocket node data
     * @returns {Node}
     */
    static fromWebSocketEvent(event) {
        return new Node({
            nodeId: event.node_id,
            subgroupId: event.subgroup_id,
            type: event.type,
            sequence: event.sequence,
            clickable: event.clickable,
            status: event.status || 'pending',
            artifactId: event.artifact_id || null,
            createdAt: event.timestamp || new Date().toISOString()
        });
    }
    
    /**
     * Create all 3 nodes for a subgroup
     * @param {string} subgroupId - Subgroup UUID
     * @returns {Array<Node>} Array of 3 nodes
     */
    static createNodesForSubgroup(subgroupId) {
        return [
            new Node({
                nodeId: null, // Will be set by backend
                subgroupId,
                type: 'writing',
                sequence: 1,
                clickable: true,
                status: 'pending'
            }),
            new Node({
                nodeId: null,
                subgroupId,
                type: 'executing',
                sequence: 2,
                clickable: false,
                status: 'pending'
            }),
            new Node({
                nodeId: null,
                subgroupId,
                type: 'output',
                sequence: 3,
                clickable: true,
                status: 'pending'
            })
        ];
    }
}

module.exports = { Node };
