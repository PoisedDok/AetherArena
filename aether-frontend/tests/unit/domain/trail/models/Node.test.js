'use strict';

const { Node } = require('../../../../../src/domain/trail/models/Node');

describe('Node Domain Model', () => {
  const writingData = {
    nodeId: 'n-1', subgroupId: 'sg-1', type: 'writing',
    sequence: 1, clickable: true
  };
  const executingData = {
    nodeId: 'n-2', subgroupId: 'sg-1', type: 'executing',
    sequence: 2, clickable: false
  };
  const outputData = {
    nodeId: 'n-3', subgroupId: 'sg-1', type: 'output',
    sequence: 3, clickable: true
  };

  describe('Constructor', () => {
    it('should create writing node', () => {
      const n = new Node(writingData);
      expect(n.nodeId).toBe('n-1');
      expect(n.subgroupId).toBe('sg-1');
      expect(n.type).toBe('writing');
      expect(n.sequence).toBe(1);
      expect(n.clickable).toBe(true);
      expect(n.status).toBe('pending');
      expect(n.artifactId).toBeNull();
    });

    it('should create executing node', () => {
      const n = new Node(executingData);
      expect(n.type).toBe('executing');
      expect(n.sequence).toBe(2);
      expect(n.clickable).toBe(false);
    });

    it('should create output node', () => {
      const n = new Node(outputData);
      expect(n.type).toBe('output');
      expect(n.sequence).toBe(3);
      expect(n.clickable).toBe(true);
    });

    it('should accept snake_case fields', () => {
      const n = new Node({
        node_id: 'n1', subgroup_id: 'sg1',
        type: 'writing', sequence: 1, clickable: true,
        artifact_id: 'a1', created_at: '2024-01-01', updated_at: '2024-01-02'
      });
      expect(n.nodeId).toBe('n1');
      expect(n.subgroupId).toBe('sg1');
      expect(n.artifactId).toBe('a1');
    });

    it('should allow null nodeId (pre-persistence stubs)', () => {
      expect(() => new Node({
        nodeId: null, subgroupId: 'sg1',
        type: 'writing', sequence: 1, clickable: true
      })).not.toThrow();
    });
  });

  describe('Validation', () => {
    it('should throw without subgroupId', () => {
      expect(() => new Node({
        nodeId: 'n1', type: 'writing', sequence: 1, clickable: true
      })).toThrow('must have subgroupId');
    });

    it('should throw on invalid type', () => {
      expect(() => new Node({
        nodeId: 'n1', subgroupId: 'sg1', type: 'invalid',
        sequence: 1, clickable: true
      })).toThrow('Invalid node type');
    });

    it('should throw on invalid sequence', () => {
      expect(() => new Node({
        nodeId: 'n1', subgroupId: 'sg1', type: 'writing',
        sequence: 5, clickable: true
      })).toThrow('Invalid node sequence');
    });

    it('should throw on invalid status', () => {
      expect(() => new Node({
        ...writingData, status: 'bogus'
      })).toThrow('Invalid node status');
    });

    it('should enforce writing: sequence=1, clickable=true', () => {
      expect(() => new Node({
        nodeId: 'n1', subgroupId: 'sg1', type: 'writing',
        sequence: 2, clickable: true
      })).toThrow('sequence=1 and clickable=true');
      expect(() => new Node({
        nodeId: 'n1', subgroupId: 'sg1', type: 'writing',
        sequence: 1, clickable: false
      })).toThrow('sequence=1 and clickable=true');
    });

    it('should enforce executing: sequence=2, clickable=false', () => {
      expect(() => new Node({
        nodeId: 'n1', subgroupId: 'sg1', type: 'executing',
        sequence: 1, clickable: false
      })).toThrow('sequence=2 and clickable=false');
      expect(() => new Node({
        nodeId: 'n1', subgroupId: 'sg1', type: 'executing',
        sequence: 2, clickable: true
      })).toThrow('sequence=2 and clickable=false');
    });

    it('should enforce output: sequence=3, clickable=true', () => {
      expect(() => new Node({
        nodeId: 'n1', subgroupId: 'sg1', type: 'output',
        sequence: 2, clickable: true
      })).toThrow('sequence=3 and clickable=true');
    });

    it('should reject artifact on executing node', () => {
      expect(() => new Node({
        ...executingData, artifactId: 'a1'
      })).toThrow('cannot have artifact');
    });

    it('should allow artifact on writing and output nodes', () => {
      expect(() => new Node({ ...writingData, artifactId: 'a1' })).not.toThrow();
      expect(() => new Node({ ...outputData, artifactId: 'a1' })).not.toThrow();
    });
  });

  describe('Status management', () => {
    it('should update to valid statuses', () => {
      const n = new Node(writingData);
      n.updateStatus('active');
      expect(n.status).toBe('active');
      n.updateStatus('completed');
      expect(n.status).toBe('completed');
    });

    it('should throw on invalid status update', () => {
      const n = new Node(writingData);
      expect(() => n.updateStatus('invalid')).toThrow('Invalid node status');
    });

    it('should update updatedAt on status change', () => {
      const n = new Node({ ...writingData, updatedAt: '2020-01-01T00:00:00.000Z' });
      n.updateStatus('active');
      expect(n.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    });

    it('isActive and isCompleted', () => {
      const n = new Node(writingData);
      expect(n.isActive()).toBe(false);
      n.updateStatus('active');
      expect(n.isActive()).toBe(true);
      expect(n.isCompleted()).toBe(false);
      n.updateStatus('completed');
      expect(n.isCompleted()).toBe(true);
      expect(n.isActive()).toBe(false);
    });
  });

  describe('Artifact management', () => {
    it('should set artifact on writing node', () => {
      const n = new Node(writingData);
      n.setArtifact('art-1');
      expect(n.artifactId).toBe('art-1');
      expect(n.hasArtifact()).toBe(true);
    });

    it('should set artifact on output node', () => {
      const n = new Node(outputData);
      n.setArtifact('art-1');
      expect(n.hasArtifact()).toBe(true);
    });

    it('should reject artifact on executing node', () => {
      const n = new Node(executingData);
      expect(() => n.setArtifact('art-1')).toThrow('Cannot set artifact');
    });

    it('should report no artifact when null', () => {
      const n = new Node(writingData);
      expect(n.hasArtifact()).toBe(false);
    });
  });

  describe('Display helpers', () => {
    it('should return type CSS class', () => {
      expect(new Node(writingData).getTypeClass()).toBe('trail-node-writing');
      expect(new Node(executingData).getTypeClass()).toBe('trail-node-executing');
      expect(new Node(outputData).getTypeClass()).toBe('trail-node-output');
    });

    it('should return status CSS class', () => {
      expect(new Node(writingData).getStatusClass()).toBe('trail-node-pending');
      const n = new Node(writingData);
      n.updateStatus('active');
      expect(n.getStatusClass()).toBe('trail-node-active');
    });

    it('should return labels', () => {
      expect(new Node(writingData).getLabel()).toBe('Writing');
      expect(new Node(executingData).getLabel()).toBe('Executing');
      expect(new Node(outputData).getLabel()).toBe('Output');
    });

    it('should return icons', () => {
      expect(new Node(writingData).getIcon()).toBeTruthy();
      expect(new Node(executingData).getIcon()).toBeTruthy();
      expect(new Node(outputData).getIcon()).toBeTruthy();
    });
  });

  describe('Serialization', () => {
    it('should serialize to JSON', () => {
      const n = new Node({ ...writingData, artifactId: 'a1', status: 'active' });
      const json = n.toJSON();
      expect(json.nodeId).toBe('n-1');
      expect(json.subgroupId).toBe('sg-1');
      expect(json.type).toBe('writing');
      expect(json.sequence).toBe(1);
      expect(json.clickable).toBe(true);
      expect(json.status).toBe('active');
      expect(json.artifactId).toBe('a1');
    });
  });

  describe('Factory methods', () => {
    it('should create from backend data', () => {
      const n = Node.fromBackend({
        id: 'uuid-1', subgroup_id: 'sg1',
        type: 'writing', sequence: 1, clickable: true,
        status: 'completed', artifact_id: 'a1',
        created_at: '2024-01-01', updated_at: '2024-01-02'
      });
      expect(n.nodeId).toBe('uuid-1');
      expect(n.subgroupId).toBe('sg1');
      expect(n.artifactId).toBe('a1');
    });

    it('should create from WebSocket event', () => {
      const n = Node.fromWebSocketEvent({
        node_id: 'n1', subgroup_id: 'sg1',
        type: 'executing', sequence: 2, clickable: false,
        status: 'active'
      });
      expect(n.nodeId).toBe('n1');
      expect(n.status).toBe('active');
    });

    it('should create all 3 nodes for subgroup', () => {
      const nodes = Node.createNodesForSubgroup('sg-1');
      expect(nodes).toHaveLength(3);
      expect(nodes[0].type).toBe('writing');
      expect(nodes[0].sequence).toBe(1);
      expect(nodes[0].clickable).toBe(true);
      expect(nodes[1].type).toBe('executing');
      expect(nodes[1].sequence).toBe(2);
      expect(nodes[1].clickable).toBe(false);
      expect(nodes[2].type).toBe('output');
      expect(nodes[2].sequence).toBe(3);
      expect(nodes[2].clickable).toBe(true);
      nodes.forEach(n => {
        expect(n.subgroupId).toBe('sg-1');
        expect(n.status).toBe('pending');
        expect(n.nodeId).toBeFalsy();
      });
    });
  });
});
