/**
 * Subgroup Domain Model
 * 
 * Represents ONE artifact run (multi-hop execution).
 * ALWAYS has exactly 3 nodes: writing, executing, output.
 * 
 * @.architecture
 * Incoming: trail_schema_architecture.yaml, WebSocket trail.subgroup_created events --- {Dict, json}
 * Processing: Validate subgroup schema, normalize subgroup fields --- {2 jobs: JOB_FILTER_DATA, JOB_VALIDATE_SCHEMA}
 * Outgoing: SubgroupRepository, TrailDOMRenderer --- {Subgroup, Object}
 * 
 * CRITICAL INVARIANTS:
 * - EXACTLY 3 nodes per subgroup (enforced at creation and validation)
 * - Nodes ordered: 1=writing, 2=executing, 3=output
 * - Status transitions: pending → running → completed|error
 */

'use strict';

class Subgroup {
    /**
     * Create a Subgroup instance
     * @param {Object} data - Subgroup data
     * @param {string} data.subgroupId - Subgroup UUID
     * @param {string} data.groupId - Parent group UUID
     * @param {number} data.sequenceNumber - Execution order within group (1-indexed)
     * @param {string} [data.executionGroup] - Execution identifier linking artifacts
     * @param {string} [data.status] - Status (pending|running|completed|error)
     * @param {string} [data.startedAt] - Execution start timestamp
     * @param {string} [data.completedAt] - Execution completion timestamp
     * @param {string} [data.createdAt] - Creation timestamp
     * @param {Array} [data.nodes] - Child nodes (must be exactly 3)
     */
    constructor(data) {
        // Required fields
        this.subgroupId = data.subgroupId || data.subgroup_id;
        this.groupId = data.groupId || data.group_id;
        this.sequenceNumber = data.sequenceNumber || data.sequence_number;
        
        // Optional fields
        this.executionGroup = data.executionGroup || data.execution_group || null;
        this.status = data.status || 'pending';
        this.startedAt = data.startedAt || data.started_at || null;
        this.completedAt = data.completedAt || data.completed_at || null;
        this.createdAt = data.createdAt || data.created_at || new Date().toISOString();
        
        // Child entities (MUST be exactly 3 nodes)
        this.nodes = data.nodes || [];
        
        // Validate
        this.validate();
    }
    
    /**
     * Validate subgroup data
     * @throws {Error} If validation fails
     */
    validate() {
        if (!this.subgroupId) {
            throw new Error('Subgroup must have subgroupId');
        }
        if (!this.groupId) {
            throw new Error('Subgroup must have groupId');
        }
        if (typeof this.sequenceNumber !== 'number' || this.sequenceNumber < 1) {
            throw new Error('Subgroup sequenceNumber must be a positive integer');
        }
        if (!['pending', 'running', 'active', 'completed', 'error'].includes(this.status)) {
            throw new Error(`Invalid subgroup status: ${this.status}`);
        }
        
        // CRITICAL: Validate exactly 3 nodes if nodes exist
        if (this.nodes.length > 0 && this.nodes.length !== 3) {
            throw new Error(`Subgroup must have exactly 3 nodes, got ${this.nodes.length}`);
        }
    }
    
    /**
     * Set nodes (must be exactly 3)
     * @param {Array<Node>} nodes - Nodes to set
     * @throws {Error} If not exactly 3 nodes
     */
    setNodes(nodes) {
        if (!Array.isArray(nodes) || nodes.length !== 3) {
            throw new Error(`Subgroup must have exactly 3 nodes, got ${nodes?.length || 0}`);
        }
        
        // Validate node types and sequences
        const types = nodes.map(n => n.type);
        const sequences = nodes.map(n => n.sequence);
        
        if (!types.includes('writing') || !types.includes('executing') || !types.includes('output')) {
            throw new Error('Subgroup must have writing, executing, and output nodes');
        }
        
        if (sequences.sort().join(',') !== '1,2,3') {
            throw new Error('Node sequences must be 1, 2, 3');
        }
        
        this.nodes = nodes.sort((a, b) => a.sequence - b.sequence);
    }
    
    /**
     * Get writing node (sequence=1)
     * @returns {Node|null}
     */
    getWritingNode() {
        return this.nodes.find(n => n.type === 'writing') || null;
    }
    
    /**
     * Get executing node (sequence=2)
     * @returns {Node|null}
     */
    getExecutingNode() {
        return this.nodes.find(n => n.type === 'executing') || null;
    }
    
    /**
     * Get output node (sequence=3)
     * @returns {Node|null}
     */
    getOutputNode() {
        return this.nodes.find(n => n.type === 'output') || null;
    }
    
    /**
     * Get node by ID
     * @param {string} nodeId - Node UUID
     * @returns {Node|null}
     */
    getNode(nodeId) {
        return this.nodes.find(n => n.nodeId === nodeId) || null;
    }
    
    /**
     * Update status
     * @param {string} status - New status
     */
    updateStatus(status) {
        if (!['pending', 'running', 'active', 'completed', 'error'].includes(status)) {
            throw new Error(`Invalid subgroup status: ${status}`);
        }
        this.status = status;
        
        if ((status === 'running' || status === 'active') && !this.startedAt) {
            this.startedAt = new Date().toISOString();
        }
        if ((status === 'completed' || status === 'error') && !this.completedAt) {
            this.completedAt = new Date().toISOString();
        }
    }
    
    /**
     * Check if subgroup is complete
     * @returns {boolean}
     */
    isComplete() {
        return this.status === 'completed' || this.status === 'error';
    }
    
    /**
     * Convert to JSON for persistence
     * @returns {Object}
     */
    toJSON() {
        return {
            subgroupId: this.subgroupId,
            groupId: this.groupId,
            sequenceNumber: this.sequenceNumber,
            executionGroup: this.executionGroup,
            status: this.status,
            startedAt: this.startedAt,
            completedAt: this.completedAt,
            createdAt: this.createdAt,
            nodes: this.nodes.map(n => n.toJSON ? n.toJSON() : n)
        };
    }
    
    /**
     * Create Subgroup from backend response
     * @param {Object} data - Backend data
     * @returns {Subgroup}
     */
    static fromBackend(data) {
        return new Subgroup({
            subgroupId: data.id || data.subgroup_id,
            groupId: data.group_id,
            sequenceNumber: data.sequence_number,
            executionGroup: data.execution_group,
            status: data.status,
            startedAt: data.started_at,
            completedAt: data.completed_at,
            createdAt: data.created_at,
            nodes: []
        });
    }
    
    /**
     * Create Subgroup from WebSocket event
     * @param {Object} event - WebSocket trail.subgroup_created event
     * @returns {Subgroup}
     */
    static fromWebSocketEvent(event) {
        const subgroup = new Subgroup({
            subgroupId: event.subgroup_id,
            groupId: event.group_id,
            sequenceNumber: event.sequence_number,
            executionGroup: event.execution_group,
            status: event.status || 'pending',
            createdAt: event.timestamp || new Date().toISOString(),
            nodes: []
        });
        
        // Add nodes if provided
        if (event.nodes && Array.isArray(event.nodes) && event.nodes.length === 3) {
            try {
                // Lazy require to avoid circular dependency surfaces in bundlers.
                // eslint-disable-next-line global-require
                const { Node } = require('./Node.js');
                const nodes = event.nodes.map(nodeData => new Node(nodeData));
                subgroup.setNodes(nodes);
            } catch (_error) {
                // If Node cannot be loaded, return subgroup without nodes; caller can reconcile later.
            }
        }
        
        return subgroup;
    }
}

module.exports = { Subgroup };
