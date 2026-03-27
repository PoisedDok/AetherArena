'use strict';

const { Subgroup } = require('../../../../../src/domain/trail/models/Subgroup');

describe('Subgroup Domain Model', () => {
  const validData = {
    subgroupId: 'sg-1', groupId: 'g-1', sequenceNumber: 1
  };

  describe('Constructor', () => {
    it('should create with valid data', () => {
      const sg = new Subgroup(validData);
      expect(sg.subgroupId).toBe('sg-1');
      expect(sg.groupId).toBe('g-1');
      expect(sg.sequenceNumber).toBe(1);
      expect(sg.status).toBe('pending');
      expect(sg.executionGroup).toBeNull();
      expect(sg.startedAt).toBeNull();
      expect(sg.completedAt).toBeNull();
      expect(sg.nodes).toEqual([]);
    });

    it('should accept snake_case fields', () => {
      const sg = new Subgroup({
        subgroup_id: 'sg-2', group_id: 'g-2', sequence_number: 2,
        execution_group: 'eg-1', started_at: '2024-01-01',
        completed_at: '2024-01-02', created_at: '2024-01-01'
      });
      expect(sg.subgroupId).toBe('sg-2');
      expect(sg.groupId).toBe('g-2');
      expect(sg.executionGroup).toBe('eg-1');
    });

    it('should accept status values', () => {
      expect(new Subgroup({ ...validData, status: 'running' }).status).toBe('running');
      expect(new Subgroup({ ...validData, status: 'active' }).status).toBe('active');
      expect(new Subgroup({ ...validData, status: 'completed' }).status).toBe('completed');
      expect(new Subgroup({ ...validData, status: 'error' }).status).toBe('error');
    });
  });

  describe('Validation', () => {
    it('should throw without subgroupId', () => {
      expect(() => new Subgroup({ groupId: 'g', sequenceNumber: 1 }))
        .toThrow('must have subgroupId');
    });

    it('should throw without groupId', () => {
      expect(() => new Subgroup({ subgroupId: 'sg', sequenceNumber: 1 }))
        .toThrow('must have groupId');
    });

    it('should throw on invalid sequenceNumber', () => {
      expect(() => new Subgroup({ subgroupId: 'sg', groupId: 'g', sequenceNumber: 0 }))
        .toThrow('positive integer');
    });

    it('should throw on invalid status', () => {
      expect(() => new Subgroup({ ...validData, status: 'invalid' }))
        .toThrow('Invalid subgroup status');
    });

    it('should throw if nodes exist but count is not 3', () => {
      expect(() => new Subgroup({ ...validData, nodes: [{ id: 1 }] }))
        .toThrow('exactly 3 nodes');
      expect(() => new Subgroup({ ...validData, nodes: [1, 2] }))
        .toThrow('exactly 3 nodes');
    });

    it('should allow 0 or 3 nodes', () => {
      expect(() => new Subgroup({ ...validData, nodes: [] })).not.toThrow();
      const threeNodes = [
        { type: 'writing', sequence: 1 },
        { type: 'executing', sequence: 2 },
        { type: 'output', sequence: 3 }
      ];
      expect(() => new Subgroup({ ...validData, nodes: threeNodes })).not.toThrow();
    });
  });

  describe('Node management', () => {
    it('should set exactly 3 valid nodes', () => {
      const sg = new Subgroup(validData);
      const nodes = [
        { type: 'writing', sequence: 1 },
        { type: 'executing', sequence: 2 },
        { type: 'output', sequence: 3 }
      ];
      sg.setNodes(nodes);
      expect(sg.nodes).toHaveLength(3);
      expect(sg.nodes[0].type).toBe('writing');
    });

    it('should reject non-3 node arrays', () => {
      const sg = new Subgroup(validData);
      expect(() => sg.setNodes([])).toThrow('exactly 3 nodes');
      expect(() => sg.setNodes([{ type: 'writing', sequence: 1 }])).toThrow('exactly 3 nodes');
      expect(() => sg.setNodes(null)).toThrow('exactly 3 nodes');
    });

    it('should reject nodes missing required types', () => {
      const sg = new Subgroup(validData);
      const badNodes = [
        { type: 'writing', sequence: 1 },
        { type: 'writing', sequence: 2 },
        { type: 'output', sequence: 3 }
      ];
      expect(() => sg.setNodes(badNodes)).toThrow('writing, executing, and output');
    });

    it('should reject nodes with bad sequences', () => {
      const sg = new Subgroup(validData);
      const badNodes = [
        { type: 'writing', sequence: 1 },
        { type: 'executing', sequence: 1 },
        { type: 'output', sequence: 3 }
      ];
      expect(() => sg.setNodes(badNodes)).toThrow('sequences must be 1, 2, 3');
    });

    it('should sort nodes by sequence', () => {
      const sg = new Subgroup(validData);
      const nodes = [
        { type: 'output', sequence: 3 },
        { type: 'writing', sequence: 1 },
        { type: 'executing', sequence: 2 }
      ];
      sg.setNodes(nodes);
      expect(sg.nodes[0].sequence).toBe(1);
      expect(sg.nodes[1].sequence).toBe(2);
      expect(sg.nodes[2].sequence).toBe(3);
    });

    it('should get nodes by type', () => {
      const sg = new Subgroup(validData);
      const nodes = [
        { type: 'writing', sequence: 1 },
        { type: 'executing', sequence: 2 },
        { type: 'output', sequence: 3 }
      ];
      sg.setNodes(nodes);
      expect(sg.getWritingNode().type).toBe('writing');
      expect(sg.getExecutingNode().type).toBe('executing');
      expect(sg.getOutputNode().type).toBe('output');
    });

    it('should return null for missing node types', () => {
      const sg = new Subgroup(validData);
      expect(sg.getWritingNode()).toBeNull();
      expect(sg.getExecutingNode()).toBeNull();
      expect(sg.getOutputNode()).toBeNull();
    });

    it('should get node by id', () => {
      const sg = new Subgroup(validData);
      sg.nodes = [{ nodeId: 'n1' }, { nodeId: 'n2' }, { nodeId: 'n3' }];
      expect(sg.getNode('n2').nodeId).toBe('n2');
      expect(sg.getNode('nope')).toBeNull();
    });
  });

  describe('Status management', () => {
    it('should update to valid statuses', () => {
      const sg = new Subgroup(validData);
      sg.updateStatus('running');
      expect(sg.status).toBe('running');
      expect(sg.startedAt).toBeTruthy();
    });

    it('should set completedAt on completed/error', () => {
      const sg = new Subgroup(validData);
      sg.updateStatus('completed');
      expect(sg.completedAt).toBeTruthy();
    });

    it('should not overwrite startedAt if already set', () => {
      const sg = new Subgroup({ ...validData, startedAt: '2024-01-01' });
      sg.updateStatus('running');
      expect(sg.startedAt).toBe('2024-01-01');
    });

    it('should throw on invalid status', () => {
      const sg = new Subgroup(validData);
      expect(() => sg.updateStatus('invalid')).toThrow('Invalid subgroup status');
    });

    it('should check completion', () => {
      expect(new Subgroup({ ...validData, status: 'completed' }).isComplete()).toBe(true);
      expect(new Subgroup({ ...validData, status: 'error' }).isComplete()).toBe(true);
      expect(new Subgroup({ ...validData, status: 'pending' }).isComplete()).toBe(false);
      expect(new Subgroup({ ...validData, status: 'running' }).isComplete()).toBe(false);
    });
  });

  describe('Serialization', () => {
    it('should serialize to JSON', () => {
      const sg = new Subgroup({ ...validData, executionGroup: 'eg-1' });
      const json = sg.toJSON();
      expect(json.subgroupId).toBe('sg-1');
      expect(json.groupId).toBe('g-1');
      expect(json.executionGroup).toBe('eg-1');
      expect(json.nodes).toEqual([]);
    });

    it('should call toJSON on nodes with toJSON method', () => {
      const sg = new Subgroup(validData);
      sg.nodes = [
        { toJSON: () => ({ id: 'n1' }) },
        { toJSON: () => ({ id: 'n2' }) },
        { toJSON: () => ({ id: 'n3' }) }
      ];
      const json = sg.toJSON();
      expect(json.nodes).toEqual([{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }]);
    });
  });

  describe('Factory methods', () => {
    it('should create from backend data', () => {
      const sg = Subgroup.fromBackend({
        id: 'uuid-1', group_id: 'g1', sequence_number: 2,
        execution_group: 'eg1', status: 'completed',
        started_at: '2024-01-01', completed_at: '2024-01-02'
      });
      expect(sg.subgroupId).toBe('uuid-1');
      expect(sg.groupId).toBe('g1');
      expect(sg.sequenceNumber).toBe(2);
      expect(sg.nodes).toEqual([]);
    });

    it('should create from WebSocket event without nodes', () => {
      const sg = Subgroup.fromWebSocketEvent({
        subgroup_id: 'sg1', group_id: 'g1', sequence_number: 1,
        execution_group: 'eg1'
      });
      expect(sg.subgroupId).toBe('sg1');
      expect(sg.status).toBe('pending');
      expect(sg.nodes).toEqual([]);
    });
  });
});
