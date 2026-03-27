'use strict';

const { Group } = require('../../../../../src/domain/trail/models/Group');

describe('Group Domain Model', () => {
  const validData = {
    groupId: 'g-1', chatId: 'c-1', sequenceNumber: 1,
    userMessage: 'Hello', agentMessage: 'Hi'
  };

  describe('Constructor', () => {
    it('should create with valid data', () => {
      const g = new Group(validData);
      expect(g.groupId).toBe('g-1');
      expect(g.chatId).toBe('c-1');
      expect(g.sequenceNumber).toBe(1);
      expect(g.userMessage).toBe('Hello');
      expect(g.agentMessage).toBe('Hi');
      expect(g.subgroups).toEqual([]);
      expect(g.frontendId).toBeNull();
      expect(g.backendId).toBeNull();
      expect(g.correlationId).toBeNull();
    });

    it('should accept snake_case fields', () => {
      const g = new Group({
        group_id: 'g-2', chat_id: 'c-2', sequence_number: 2,
        user_message: 'Q', agent_message: 'A',
        frontend_id: 'f1', backend_id: 'b1', correlation_id: 'cor1',
        created_at: '2024-01-01', updated_at: '2024-01-02'
      });
      expect(g.groupId).toBe('g-2');
      expect(g.chatId).toBe('c-2');
      expect(g.sequenceNumber).toBe(2);
      expect(g.frontendId).toBe('f1');
      expect(g.backendId).toBe('b1');
    });

    it('should default messages to empty strings', () => {
      const g = new Group({ groupId: 'g', chatId: 'c', sequenceNumber: 1 });
      expect(g.userMessage).toBe('');
      expect(g.agentMessage).toBe('');
    });
  });

  describe('Validation', () => {
    it('should throw without groupId', () => {
      expect(() => new Group({ chatId: 'c', sequenceNumber: 1 }))
        .toThrow('must have groupId');
    });

    it('should throw without chatId', () => {
      expect(() => new Group({ groupId: 'g', sequenceNumber: 1 }))
        .toThrow('must have chatId');
    });

    it('should throw on invalid sequenceNumber', () => {
      expect(() => new Group({ groupId: 'g', chatId: 'c', sequenceNumber: 0 }))
        .toThrow('positive integer');
      expect(() => new Group({ groupId: 'g', chatId: 'c', sequenceNumber: -1 }))
        .toThrow('positive integer');
    });
  });

  describe('Subgroup management', () => {
    it('should add subgroup and sort by sequence', () => {
      const g = new Group(validData);
      g.addSubgroup({ subgroupId: 's2', sequenceNumber: 2 });
      g.addSubgroup({ subgroupId: 's1', sequenceNumber: 1 });
      expect(g.subgroups[0].subgroupId).toBe('s1');
      expect(g.subgroups[1].subgroupId).toBe('s2');
    });

    it('should throw on invalid subgroup', () => {
      const g = new Group(validData);
      expect(() => g.addSubgroup(null)).toThrow('Invalid subgroup');
      expect(() => g.addSubgroup({})).toThrow('Invalid subgroup');
    });

    it('should get subgroup by ID', () => {
      const g = new Group(validData);
      g.addSubgroup({ subgroupId: 's1', sequenceNumber: 1 });
      expect(g.getSubgroup('s1').subgroupId).toBe('s1');
      expect(g.getSubgroup('nope')).toBeNull();
    });

    it('should return sorted subgroups copy', () => {
      const g = new Group(validData);
      g.addSubgroup({ subgroupId: 's2', sequenceNumber: 2 });
      g.addSubgroup({ subgroupId: 's1', sequenceNumber: 1 });
      const subs = g.getSubgroups();
      expect(subs[0].subgroupId).toBe('s1');
    });
  });

  describe('Serialization', () => {
    it('should serialize to JSON', () => {
      const g = new Group(validData);
      const json = g.toJSON();
      expect(json.groupId).toBe('g-1');
      expect(json.chatId).toBe('c-1');
      expect(json.subgroups).toEqual([]);
    });

    it('should call toJSON on subgroups with toJSON method', () => {
      const g = new Group(validData);
      g.addSubgroup({ subgroupId: 's1', sequenceNumber: 1, toJSON: () => ({ id: 's1' }) });
      const json = g.toJSON();
      expect(json.subgroups[0]).toEqual({ id: 's1' });
    });
  });

  describe('Factory methods', () => {
    it('should create from backend data', () => {
      const g = Group.fromBackend({
        id: 'uuid-1', chat_id: 'c1', sequence_number: 3,
        user_message: 'Q', agent_message: 'A',
        frontend_id: 'f1', backend_id: 'b1',
        correlation_id: 'cor', created_at: '2024-01-01'
      });
      expect(g.groupId).toBe('uuid-1');
      expect(g.chatId).toBe('c1');
      expect(g.sequenceNumber).toBe(3);
    });

    it('should create from WebSocket event', () => {
      const g = Group.fromWebSocketEvent({
        group_id: 'g1', chat_id: 'c1', sequence_number: 1,
        user_message: 'Q', agent_message: 'A'
      });
      expect(g.groupId).toBe('g1');
      expect(g.subgroups).toEqual([]);
    });

    it('should default messages in WebSocket event', () => {
      const g = Group.fromWebSocketEvent({
        group_id: 'g1', chat_id: 'c1', sequence_number: 1
      });
      expect(g.userMessage).toBe('[User message]');
      expect(g.agentMessage).toBe('[Agent response]');
    });
  });
});
