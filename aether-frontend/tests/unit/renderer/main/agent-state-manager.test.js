'use strict';

// ---------------------------------------------------------------------------
// AgentStateManager.js — Unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/main/modules/agents/components/state/AgentStateManager.js (307 lines)
// Dependencies: None (pure state management).
// ---------------------------------------------------------------------------

const AgentStateManager = require('../../../../src/renderer/main/modules/agents/components/state/AgentStateManager');

describe('AgentStateManager', () => {
  let manager;
  let logger;

  beforeEach(() => {
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    manager = new AgentStateManager({ logger });
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores logger', () => {
      expect(manager.logger).toBe(logger);
    });

    it('defaults logger to console', () => {
      const m = new AgentStateManager();
      expect(m.logger).toBe(console);
    });

    it('initializes agents as empty array', () => {
      expect(manager.agents).toEqual([]);
    });

    it('initializes models as empty array', () => {
      expect(manager.models).toEqual([]);
    });

    it('initializes templatesByName as empty object', () => {
      expect(manager.templatesByName).toEqual({});
    });

    it('initializes settings as null', () => {
      expect(manager.settings).toBeNull();
    });

    it('initializes selectedAgent as null', () => {
      expect(manager.selectedAgent).toBeNull();
    });

    it('initializes dirtyAgents as empty Set', () => {
      expect(manager.dirtyAgents).toBeInstanceOf(Set);
      expect(manager.dirtyAgents.size).toBe(0);
    });
  });

  // =========================================================================
  // fetchAll
  // =========================================================================

  describe('fetchAll', () => {
    let endpoint;

    beforeEach(() => {
      endpoint = {
        listAgentConfigs: jest.fn().mockResolvedValue([
          { agent_name: 'testing', enabled: true },
          { agent_name: 'research', enabled: false },
        ]),
        getAgentModels: jest.fn().mockResolvedValue({
          models: [{ name: 'gpt-4' }, { name: 'claude-3' }],
        }),
        getAgentTemplates: jest.fn().mockResolvedValue({
          templates: [
            { name: 'testing', description: 'Document testing' },
            { name: 'research', description: 'Research tool' },
          ],
        }),
        getSettings: jest.fn().mockResolvedValue({
          agents: { context_retrieval: { enabled: true, default_top_k: 10, min_score: 0.5 } },
        }),
      };
    });

    it('throws when endpoint is not provided', async () => {
      await expect(manager.fetchAll()).rejects.toThrow('Endpoint is required');
    });

    it('throws when endpoint is null', async () => {
      await expect(manager.fetchAll(null)).rejects.toThrow('Endpoint is required');
    });

    it('calls all 4 endpoint methods', async () => {
      await manager.fetchAll(endpoint);
      expect(endpoint.listAgentConfigs).toHaveBeenCalled();
      expect(endpoint.getAgentModels).toHaveBeenCalled();
      expect(endpoint.getAgentTemplates).toHaveBeenCalled();
      expect(endpoint.getSettings).toHaveBeenCalled();
    });

    it('stores agents', async () => {
      await manager.fetchAll(endpoint);
      expect(manager.agents).toHaveLength(2);
      expect(manager.agents[0].agent_name).toBe('testing');
    });

    it('stores models', async () => {
      await manager.fetchAll(endpoint);
      expect(manager.models).toHaveLength(2);
      expect(manager.models[0].name).toBe('gpt-4');
    });

    it('stores templatesByName as keyed object', async () => {
      await manager.fetchAll(endpoint);
      expect(manager.templatesByName.testing).toBeDefined();
      expect(manager.templatesByName.testing.description).toBe('Document testing');
      expect(manager.templatesByName.research).toBeDefined();
    });

    it('stores settings', async () => {
      await manager.fetchAll(endpoint);
      expect(manager.settings.agents.context_retrieval.enabled).toBe(true);
    });

    it('logs info for each successful fetch', async () => {
      await manager.fetchAll(endpoint);
      expect(logger.info).toHaveBeenCalledWith('AgentStateManager: Loaded 2 agent configurations');
      expect(logger.info).toHaveBeenCalledWith('AgentStateManager: Loaded 2 models');
      expect(logger.info).toHaveBeenCalledWith('AgentStateManager: Loaded 2 templates');
      expect(logger.info).toHaveBeenCalledWith('AgentStateManager: Loaded settings');
    });

    it('handles null response from listAgentConfigs', async () => {
      endpoint.listAgentConfigs = jest.fn().mockResolvedValue(null);
      await manager.fetchAll(endpoint);
      expect(manager.agents).toEqual([]);
    });

    it('handles null models in response', async () => {
      endpoint.getAgentModels = jest.fn().mockResolvedValue({});
      await manager.fetchAll(endpoint);
      expect(manager.models).toEqual([]);
    });

    it('handles null templates in response', async () => {
      endpoint.getAgentTemplates = jest.fn().mockResolvedValue({});
      await manager.fetchAll(endpoint);
      expect(manager.templatesByName).toEqual({});
    });

    it('propagates error from _fetchAgents', async () => {
      endpoint.listAgentConfigs = jest.fn().mockRejectedValue(new Error('Agent API down'));
      await expect(manager.fetchAll(endpoint)).rejects.toThrow('Agent API down');
      expect(logger.error).toHaveBeenCalledWith(
        'AgentStateManager: Failed to fetch agents:',
        expect.any(Error)
      );
    });

    it('propagates error from _fetchModels', async () => {
      endpoint.getAgentModels = jest.fn().mockRejectedValue(new Error('Model API down'));
      await expect(manager.fetchAll(endpoint)).rejects.toThrow('Model API down');
    });

    it('propagates error from _fetchTemplates', async () => {
      endpoint.getAgentTemplates = jest.fn().mockRejectedValue(new Error('Template fail'));
      await expect(manager.fetchAll(endpoint)).rejects.toThrow('Template fail');
    });

    it('propagates error from _fetchSettings', async () => {
      endpoint.getSettings = jest.fn().mockRejectedValue(new Error('Settings fail'));
      await expect(manager.fetchAll(endpoint)).rejects.toThrow('Settings fail');
    });
  });

  // =========================================================================
  // findAgentByName
  // =========================================================================

  describe('findAgentByName', () => {
    beforeEach(() => {
      manager.agents = [
        { agent_name: 'testing', enabled: true },
        { agent_name: 'research', enabled: false },
      ];
    });

    it('finds agent by name', () => {
      expect(manager.findAgentByName('research')).toEqual({ agent_name: 'research', enabled: false });
    });

    it('returns null when name not found', () => {
      expect(manager.findAgentByName('nonexistent')).toBeNull();
    });

    it('returns null when name is null', () => {
      expect(manager.findAgentByName(null)).toBeNull();
    });

    it('returns null when name is undefined', () => {
      expect(manager.findAgentByName(undefined)).toBeNull();
    });

    it('returns null when name is empty string', () => {
      expect(manager.findAgentByName('')).toBeNull();
    });

    it('returns null when agents is not an array', () => {
      manager.agents = 'not-array';
      expect(manager.findAgentByName('testing')).toBeNull();
    });

    it('skips null entries in agents array', () => {
      manager.agents = [null, { agent_name: 'testing' }, undefined];
      expect(manager.findAgentByName('testing')).toEqual({ agent_name: 'testing' });
    });
  });

  // =========================================================================
  // getAgent
  // =========================================================================

  describe('getAgent', () => {
    beforeEach(() => {
      manager.agents = [{ agent_name: 'a' }, { agent_name: 'b' }, { agent_name: 'c' }];
    });

    it('returns agent at valid index', () => {
      expect(manager.getAgent(1)).toEqual({ agent_name: 'b' });
    });

    it('returns first agent at index 0', () => {
      expect(manager.getAgent(0)).toEqual({ agent_name: 'a' });
    });

    it('returns null for negative index', () => {
      expect(manager.getAgent(-1)).toBeNull();
    });

    it('returns null for out-of-bounds index', () => {
      expect(manager.getAgent(3)).toBeNull();
    });

    it('returns null when index is null', () => {
      expect(manager.getAgent(null)).toBeNull();
    });

    it('returns null when index is undefined', () => {
      expect(manager.getAgent(undefined)).toBeNull();
    });
  });

  // =========================================================================
  // updateAgent
  // =========================================================================

  describe('updateAgent', () => {
    beforeEach(() => {
      manager.agents = [
        { agent_name: 'testing', enabled: true, model_name: 'gpt-4' },
      ];
    });

    it('updates agent fields via Object.assign', () => {
      manager.updateAgent(0, { enabled: false, model_name: 'claude-3' });
      expect(manager.agents[0].enabled).toBe(false);
      expect(manager.agents[0].model_name).toBe('claude-3');
    });

    it('marks agent as dirty', () => {
      manager.updateAgent(0, { enabled: false });
      expect(manager.dirtyAgents.has('testing')).toBe(true);
    });

    it('throws when agent index not found', () => {
      expect(() => manager.updateAgent(5, { enabled: false }))
        .toThrow('Agent at index 5 not found');
    });

    it('throws for negative index', () => {
      expect(() => manager.updateAgent(-1, {}))
        .toThrow('Agent at index -1 not found');
    });

    it('preserves existing fields not in updates', () => {
      manager.updateAgent(0, { enabled: false });
      expect(manager.agents[0].agent_name).toBe('testing');
      expect(manager.agents[0].model_name).toBe('gpt-4');
    });

    it('can add new fields to agent', () => {
      manager.updateAgent(0, { new_field: 'value' });
      expect(manager.agents[0].new_field).toBe('value');
    });
  });

  // =========================================================================
  // groupAgents
  // =========================================================================

  describe('groupAgents', () => {
    it('groups tool agents (on_demand) into tools', () => {
      manager.agents = [
        { agent_name: 'testing', execution_trigger: 'on_demand' },
        { agent_name: 'research', execution_trigger: 'on_demand' },
      ];
      const groups = manager.groupAgents();
      expect(groups.tools).toHaveLength(2);
      expect(groups.system).toHaveLength(0);
    });

    it('groups non-tool agents into system', () => {
      manager.agents = [
        { agent_name: 'proactive', execution_trigger: 'proactive' },
        { agent_name: 'memory', execution_trigger: 'background' },
      ];
      const groups = manager.groupAgents();
      expect(groups.system).toHaveLength(2);
      expect(groups.tools).toHaveLength(0);
    });

    it('includes agent and original index in grouped entries', () => {
      manager.agents = [
        { agent_name: 'proactive', execution_trigger: 'proactive' },
        { agent_name: 'testing', execution_trigger: 'on_demand' },
      ];
      const groups = manager.groupAgents();
      expect(groups.system[0]).toEqual({ agent: manager.agents[0], index: 0 });
      expect(groups.tools[0]).toEqual({ agent: manager.agents[1], index: 1 });
    });

    it('accepts custom agents array parameter', () => {
      const custom = [{ agent_name: 'custom', execution_trigger: 'on_demand' }];
      const groups = manager.groupAgents(custom);
      expect(groups.tools).toHaveLength(1);
    });

    it('returns empty groups when no agents', () => {
      const groups = manager.groupAgents();
      expect(groups.system).toEqual([]);
      expect(groups.tools).toEqual([]);
      expect(groups.other).toEqual([]);
    });

    it('returns empty groups when agents is null', () => {
      manager.agents = null;
      const groups = manager.groupAgents();
      expect(groups.system).toEqual([]);
      expect(groups.tools).toEqual([]);
    });
  });

  // =========================================================================
  // isToolAgent
  // =========================================================================

  describe('isToolAgent', () => {
    it('returns true for on_demand agent', () => {
      expect(manager.isToolAgent({ agent_name: 'testing', execution_trigger: 'on_demand' })).toBe(true);
    });

    it('returns false for non-on_demand agent', () => {
      expect(manager.isToolAgent({ agent_name: 'proactive', execution_trigger: 'proactive' })).toBe(false);
    });

    it('returns false for null agent', () => {
      expect(manager.isToolAgent(null)).toBe(false);
    });

    it('returns false for undefined agent', () => {
      expect(manager.isToolAgent(undefined)).toBe(false);
    });

    it('returns false for agent without execution_trigger', () => {
      expect(manager.isToolAgent({ agent_name: 'x' })).toBe(false);
    });
  });

  // =========================================================================
  // getTemplateConfig
  // =========================================================================

  describe('getTemplateConfig', () => {
    beforeEach(() => {
      manager.templatesByName = {
        testing: { name: 'testing', recommended_config: { model: 'gpt-4', temp: 0.7 } },
        research: { name: 'research' },
      };
    });

    it('returns recommended_config for known agent', () => {
      expect(manager.getTemplateConfig('testing')).toEqual({ model: 'gpt-4', temp: 0.7 });
    });

    it('returns empty object when template has no recommended_config', () => {
      expect(manager.getTemplateConfig('research')).toEqual({});
    });

    it('returns empty object for unknown agent', () => {
      expect(manager.getTemplateConfig('unknown')).toEqual({});
    });

    it('returns empty object when templatesByName is null', () => {
      manager.templatesByName = null;
      expect(manager.getTemplateConfig('testing')).toEqual({});
    });
  });

  // =========================================================================
  // getContextDefaults
  // =========================================================================

  describe('getContextDefaults', () => {
    it('returns context retrieval defaults from settings', () => {
      manager.settings = {
        agents: { context_retrieval: { enabled: true, default_top_k: 10, min_score: 0.5 } },
      };
      expect(manager.getContextDefaults()).toEqual({
        enabled: true,
        default_top_k: 10,
        min_score: 0.5,
      });
    });

    it('throws when settings is null', () => {
      manager.settings = null;
      expect(() => manager.getContextDefaults())
        .toThrow('Missing settings.agents.context_retrieval for defaults');
    });

    it('throws when settings.agents is missing', () => {
      manager.settings = {};
      expect(() => manager.getContextDefaults())
        .toThrow('Missing settings.agents.context_retrieval for defaults');
    });

    it('throws when context_retrieval is missing', () => {
      manager.settings = { agents: {} };
      expect(() => manager.getContextDefaults())
        .toThrow('Missing settings.agents.context_retrieval for defaults');
    });

    it('throws when enabled is undefined', () => {
      manager.settings = { agents: { context_retrieval: { default_top_k: 10, min_score: 0.5 } } };
      expect(() => manager.getContextDefaults())
        .toThrow('Incomplete context retrieval defaults in settings');
    });

    it('throws when default_top_k is undefined', () => {
      manager.settings = { agents: { context_retrieval: { enabled: true, min_score: 0.5 } } };
      expect(() => manager.getContextDefaults())
        .toThrow('Incomplete context retrieval defaults in settings');
    });

    it('throws when min_score is undefined', () => {
      manager.settings = { agents: { context_retrieval: { enabled: true, default_top_k: 10 } } };
      expect(() => manager.getContextDefaults())
        .toThrow('Incomplete context retrieval defaults in settings');
    });

    it('accepts false for enabled', () => {
      manager.settings = {
        agents: { context_retrieval: { enabled: false, default_top_k: 5, min_score: 0.3 } },
      };
      expect(manager.getContextDefaults().enabled).toBe(false);
    });

    it('accepts 0 for default_top_k', () => {
      manager.settings = {
        agents: { context_retrieval: { enabled: true, default_top_k: 0, min_score: 0.5 } },
      };
      expect(manager.getContextDefaults().default_top_k).toBe(0);
    });
  });

  // =========================================================================
  // dirty tracking
  // =========================================================================

  describe('dirty tracking', () => {
    it('markDirty adds agent name to Set', () => {
      manager.markDirty('testing');
      expect(manager.dirtyAgents.has('testing')).toBe(true);
    });

    it('markDirty ignores falsy name', () => {
      manager.markDirty(null);
      manager.markDirty(undefined);
      manager.markDirty('');
      expect(manager.dirtyAgents.size).toBe(0);
    });

    it('markClean removes agent name from Set', () => {
      manager.markDirty('testing');
      manager.markClean('testing');
      expect(manager.dirtyAgents.has('testing')).toBe(false);
    });

    it('markClean ignores falsy name', () => {
      manager.markDirty('testing');
      manager.markClean(null);
      expect(manager.dirtyAgents.has('testing')).toBe(true);
    });

    it('isDirty returns true when dirty agents exist', () => {
      manager.markDirty('testing');
      expect(manager.isDirty()).toBe(true);
    });

    it('isDirty returns false when no dirty agents', () => {
      expect(manager.isDirty()).toBe(false);
    });

    it('getDirtyAgents returns array of dirty names', () => {
      manager.markDirty('testing');
      manager.markDirty('research');
      const dirty = manager.getDirtyAgents();
      expect(dirty).toHaveLength(2);
      expect(dirty).toContain('testing');
      expect(dirty).toContain('research');
    });

    it('getDirtyAgents returns empty array when clean', () => {
      expect(manager.getDirtyAgents()).toEqual([]);
    });

    it('clearDirty removes all dirty flags', () => {
      manager.markDirty('a');
      manager.markDirty('b');
      manager.markDirty('c');
      manager.clearDirty();
      expect(manager.isDirty()).toBe(false);
      expect(manager.dirtyAgents.size).toBe(0);
    });

    it('markDirty is idempotent (Set deduplicates)', () => {
      manager.markDirty('testing');
      manager.markDirty('testing');
      expect(manager.dirtyAgents.size).toBe(1);
    });
  });

  // =========================================================================
  // selectedAgent
  // =========================================================================

  describe('selectedAgent', () => {
    it('setSelectedAgent stores index', () => {
      manager.setSelectedAgent(2);
      expect(manager.getSelectedAgent()).toBe(2);
    });

    it('setSelectedAgent accepts null to deselect', () => {
      manager.setSelectedAgent(2);
      manager.setSelectedAgent(null);
      expect(manager.getSelectedAgent()).toBeNull();
    });

    it('getSelectedAgent returns null initially', () => {
      expect(manager.getSelectedAgent()).toBeNull();
    });
  });

  // =========================================================================
  // reset
  // =========================================================================

  describe('reset', () => {
    it('clears all state', () => {
      manager.agents = [{ agent_name: 'x' }];
      manager.models = [{ name: 'y' }];
      manager.templatesByName = { x: {} };
      manager.settings = { key: 'val' };
      manager.selectedAgent = 3;
      manager.markDirty('x');

      manager.reset();

      expect(manager.agents).toEqual([]);
      expect(manager.models).toEqual([]);
      expect(manager.templatesByName).toEqual({});
      expect(manager.settings).toBeNull();
      expect(manager.selectedAgent).toBeNull();
      expect(manager.dirtyAgents.size).toBe(0);
    });

    it('is safe to call on fresh instance', () => {
      expect(() => manager.reset()).not.toThrow();
    });

    it('is idempotent', () => {
      manager.reset();
      manager.reset();
      expect(manager.agents).toEqual([]);
    });
  });

  // =========================================================================
  // integration
  // =========================================================================

  describe('integration', () => {
    it('fetchAll then groupAgents and findAgentByName', async () => {
      const endpoint = {
        listAgentConfigs: jest.fn().mockResolvedValue([
          { agent_name: 'testing', execution_trigger: 'on_demand' },
          { agent_name: 'proactive', execution_trigger: 'proactive' },
        ]),
        getAgentModels: jest.fn().mockResolvedValue({ models: [] }),
        getAgentTemplates: jest.fn().mockResolvedValue({ templates: [] }),
        getSettings: jest.fn().mockResolvedValue({}),
      };

      await manager.fetchAll(endpoint);
      const groups = manager.groupAgents();
      expect(groups.tools).toHaveLength(1);
      expect(groups.tools[0].agent.agent_name).toBe('testing');
      expect(groups.system).toHaveLength(1);

      expect(manager.findAgentByName('testing').execution_trigger).toBe('on_demand');
    });

    it('updateAgent then save flow', () => {
      manager.agents = [{ agent_name: 'testing', enabled: true }];

      manager.updateAgent(0, { enabled: false });
      expect(manager.isDirty()).toBe(true);
      expect(manager.getDirtyAgents()).toEqual(['testing']);

      // Simulate save
      manager.markClean('testing');
      expect(manager.isDirty()).toBe(false);
    });
  });

  // =========================================================================
  // edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('findAgentByName with duplicate names returns first match', () => {
      manager.agents = [
        { agent_name: 'dup', version: 1 },
        { agent_name: 'dup', version: 2 },
      ];
      expect(manager.findAgentByName('dup').version).toBe(1);
    });

    it('getAgent returns exact reference (not copy)', () => {
      const original = { agent_name: 'test' };
      manager.agents = [original];
      expect(manager.getAgent(0)).toBe(original);
    });

    it('updateAgent mutates agent in-place', () => {
      const original = { agent_name: 'test', value: 1 };
      manager.agents = [original];
      manager.updateAgent(0, { value: 2 });
      expect(original.value).toBe(2);
    });

    it('groupAgents with mixed triggers', () => {
      manager.agents = [
        { agent_name: 'a', execution_trigger: 'on_demand' },
        { agent_name: 'b', execution_trigger: 'proactive' },
        { agent_name: 'c', execution_trigger: 'on_demand' },
        { agent_name: 'd', execution_trigger: 'event' },
      ];
      const groups = manager.groupAgents();
      expect(groups.tools).toHaveLength(2); // a, c
      expect(groups.system).toHaveLength(2); // b, d
    });
  });
});
