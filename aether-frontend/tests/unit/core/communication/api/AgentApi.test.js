'use strict';

const AgentApi = require('../../../../../src/core/communication/api/AgentApi');

function createMockCtx() {
  return {
    api: {
      get: jest.fn().mockResolvedValue({}),
      post: jest.fn().mockResolvedValue({}),
      put: jest.fn().mockResolvedValue({}),
      patch: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
  };
}

describe('AgentApi', () => {
  let api, ctx;

  beforeEach(() => {
    ctx = createMockCtx();
    api = new AgentApi(ctx);
  });

  describe('listAgentConfigs()', () => {
    it('should GET /v1/agent/configs', async () => {
      await api.listAgentConfigs();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/agent/configs', {});
    });
  });

  describe('listSystemAgents()', () => {
    it('should GET /v1/agent/configs (alias)', async () => {
      await api.listSystemAgents();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/agent/configs', {});
    });
  });

  describe('updateAgentConfig()', () => {
    it('should PUT /v1/agent/config/:name with encoded name', async () => {
      const updates = { enabled: true };
      await api.updateAgentConfig('my agent', updates);
      expect(ctx.api.put).toHaveBeenCalledWith('/v1/agent/config/my%20agent', updates, expect.any(Object));
    });

    it('should throw for missing agentName', async () => {
      await expect(api.updateAgentConfig(null, {})).rejects.toThrow('[Endpoint] agentName is required');
    });

    it('should throw for empty agentName', async () => {
      await expect(api.updateAgentConfig('', {})).rejects.toThrow('[Endpoint] agentName is required');
    });
  });

  describe('getAgentModels()', () => {
    it('should GET /v1/agent/models', async () => {
      await api.getAgentModels();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/agent/models', {});
    });
  });

  describe('getAgentTemplates()', () => {
    it('should GET /v1/agent/templates', async () => {
      await api.getAgentTemplates();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/agent/templates', {});
    });
  });

  describe('listAgentJobs()', () => {
    it('should GET /v1/agent/jobs with no filters', async () => {
      await api.listAgentJobs();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/agent/jobs', expect.any(Object));
    });

    it('should build query from filters using backend param names', async () => {
      await api.listAgentJobs({ agentName: 'scout', status: 'running', limit: 10, offset: 5 });
      const path = ctx.api.get.mock.calls[0][0];
      expect(path).toContain('agent_name=scout');
      expect(path).toContain('status_filter=running');
      expect(path).toContain('limit=10');
      expect(path).toContain('offset=5');
    });

    it('should include onDemandOnly when true', async () => {
      await api.listAgentJobs({ onDemandOnly: true });
      const path = ctx.api.get.mock.calls[0][0];
      expect(path).toContain('on_demand_only=true');
    });
  });

  describe('listAgentHistory()', () => {
    it('should GET /v1/agent/history with filters', async () => {
      await api.listAgentHistory({ agentName: 'scout', limit: 20 });
      const path = ctx.api.get.mock.calls[0][0];
      expect(path).toContain('/v1/agent/history');
      expect(path).toContain('agent_name=scout');
      expect(path).toContain('limit=20');
    });
  });

  describe('cancelAgentJob()', () => {
    it('should POST /v1/agent/stop/:id with encoded jobId', async () => {
      await api.cancelAgentJob('job-123');
      expect(ctx.api.post).toHaveBeenCalledWith('/v1/agent/stop/job-123', undefined, expect.any(Object));
    });

    it('should throw for missing jobId', async () => {
      await expect(api.cancelAgentJob(null)).rejects.toThrow('[Endpoint] jobId is required');
    });
  });

  describe('retryAgentJob()', () => {
    it('should POST /v1/agent/retry/:id', async () => {
      await api.retryAgentJob('job-456');
      expect(ctx.api.post).toHaveBeenCalledWith('/v1/agent/retry/job-456', undefined, expect.any(Object));
    });

    it('should throw for missing jobId', async () => {
      await expect(api.retryAgentJob('')).rejects.toThrow('[Endpoint] jobId is required');
    });
  });

  describe('deleteAgentJob()', () => {
    it('should DELETE /v1/agent/delete/:id', async () => {
      await api.deleteAgentJob('job-789');
      expect(ctx.api.delete).toHaveBeenCalledWith('/v1/agent/delete/job-789', expect.any(Object));
    });

    it('should throw for missing jobId', async () => {
      await expect(api.deleteAgentJob(null)).rejects.toThrow('[Endpoint] jobId is required');
    });
  });

  describe('getResearchStatus()', () => {
    it('should GET /v1/status/research', async () => {
      await api.getResearchStatus();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/status/research', {});
    });
  });

  describe('createAgentJob()', () => {
    it('should POST /v1/agent/start with payload', async () => {
      const payload = { agent_name: 'scout', entity_id: 'e1' };
      await api.createAgentJob(payload);
      expect(ctx.api.post).toHaveBeenCalledWith('/v1/agent/start', payload, expect.any(Object));
    });

    it('should throw when agent_name is missing', async () => {
      await expect(api.createAgentJob({})).rejects.toThrow(
        '[Endpoint] agent_name is required for createAgentJob'
      );
    });
  });

  describe('getAgentJobStatus()', () => {
    it('should GET /v1/agent/status/:id with encoded id', async () => {
      await api.getAgentJobStatus('abc-def');
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/agent/status/abc-def', {});
    });

    it('should encode special characters in jobId', async () => {
      await api.getAgentJobStatus('id/with/slashes');
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/agent/status/id%2Fwith%2Fslashes', {});
    });

    it('should throw for missing jobId', async () => {
      await expect(api.getAgentJobStatus(null)).rejects.toThrow('[Endpoint] jobId is required');
    });
  });

  describe('runResearch()', () => {
    it('should POST /v1/search/research with 600s timeout', async () => {
      const payload = { query: 'What is AI?' };
      await api.runResearch(payload);
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/search/research',
        payload,
        expect.objectContaining({ timeout: 600000 })
      );
    });

    it('should throw for missing query', async () => {
      await expect(api.runResearch({})).rejects.toThrow('[Endpoint] query is required');
    });

    it('should throw for non-string query', async () => {
      await expect(api.runResearch({ query: 42 })).rejects.toThrow('[Endpoint] query is required');
    });

    it('should throw for empty string query', async () => {
      await expect(api.runResearch({ query: '' })).rejects.toThrow('[Endpoint] query is required');
    });

    it('should throw for whitespace-only query', async () => {
      await expect(api.runResearch({ query: '   ' })).rejects.toThrow('[Endpoint] query is required');
    });
  });

  describe('listResearchHistory()', () => {
    it('should GET /v1/agent/outputs with research filters', async () => {
      await api.listResearchHistory({ limit: 25, offset: 10 });
      const path = ctx.api.get.mock.calls[0][0];
      expect(path).toContain('agent_name=research');
      expect(path).toContain('output_type=research');
      expect(path).toContain('limit=25');
      expect(path).toContain('offset=10');
    });

    it('should not append limit/offset when not provided', async () => {
      await api.listResearchHistory();
      const path = ctx.api.get.mock.calls[0][0];
      expect(path).toContain('agent_name=research');
      expect(path).not.toContain('limit=');
    });
  });
});
