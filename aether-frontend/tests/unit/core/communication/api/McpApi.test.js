'use strict';

const McpApi = require('../../../../../src/core/communication/api/McpApi');

function createMockCtx() {
  return {
    api: {
      get: jest.fn().mockResolvedValue({}),
      post: jest.fn().mockResolvedValue({}),
      put: jest.fn().mockResolvedValue({}),
      patch: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
  };
}

describe('McpApi', () => {
  let api, ctx;

  beforeEach(() => {
    ctx = createMockCtx();
    api = new McpApi(ctx);
  });

  describe('listMcpServers()', () => {
    it('should GET /v1/mcp/servers with enabledOnly=false', async () => {
      await api.listMcpServers();
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/mcp/servers',
        expect.objectContaining({ params: { enabled_only: false } })
      );
    });

    it('should pass enabledOnly=true as param', async () => {
      await api.listMcpServers(true);
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/mcp/servers',
        expect.objectContaining({ params: { enabled_only: true } })
      );
    });
  });

  describe('registerMcpServer()', () => {
    it('should POST /v1/mcp/servers with config', async () => {
      const config = { name: 'test-server', url: 'http://localhost:3000' };
      await api.registerMcpServer(config);
      expect(ctx.api.post).toHaveBeenCalledWith('/v1/mcp/servers', config, {});
    });
  });

  describe('updateMcpServer()', () => {
    it('should PUT /v1/mcp/servers/:id with encoded serverId', async () => {
      await api.updateMcpServer('srv-1', { enabled: false });
      expect(ctx.api.put).toHaveBeenCalledWith(
        '/v1/mcp/servers/srv-1',
        { enabled: false },
        expect.any(Object)
      );
    });

    it('should throw for missing serverId', async () => {
      await expect(api.updateMcpServer(null, {})).rejects.toThrow(
        '[Endpoint] serverId is required for updateMcpServer'
      );
    });
  });

  describe('deleteMcpServer()', () => {
    it('should DELETE /v1/mcp/servers/:id (void return, direct api.delete)', async () => {
      const result = await api.deleteMcpServer('srv-1');
      expect(ctx.api.delete).toHaveBeenCalledWith('/v1/mcp/servers/srv-1');
      expect(result).toBeUndefined();
    });

    it('should throw for missing serverId', async () => {
      await expect(api.deleteMcpServer('')).rejects.toThrow(
        '[Endpoint] serverId is required for deleteMcpServer'
      );
    });

    it('should log error with serverId on failure', async () => {
      ctx.api.delete.mockRejectedValueOnce(new Error('Not found'));
      await expect(api.deleteMcpServer('bad-id')).rejects.toThrow('Not found');
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('DELETE /v1/mcp/servers/bad-id failed'),
        expect.objectContaining({ serverId: 'bad-id' })
      );
    });
  });

  describe('startMcpServer()', () => {
    it('should POST /v1/mcp/servers/start with name in body', async () => {
      await api.startMcpServer('my-server');
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/mcp/servers/start',
        { name: 'my-server' },
        expect.any(Object)
      );
    });

    it('should throw for missing serverName', async () => {
      await expect(api.startMcpServer(null)).rejects.toThrow(
        '[Endpoint] serverName is required for startMcpServer'
      );
    });
  });

  describe('stopMcpServer()', () => {
    it('should POST /v1/mcp/servers/stop with name in body', async () => {
      await api.stopMcpServer('my-server');
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/mcp/servers/stop',
        { name: 'my-server' },
        expect.any(Object)
      );
    });

    it('should throw for missing serverName', async () => {
      await expect(api.stopMcpServer('')).rejects.toThrow(
        '[Endpoint] serverName is required for stopMcpServer'
      );
    });
  });

  describe('testMcpServer()', () => {
    it('should POST /v1/mcp/servers/:id/test', async () => {
      await api.testMcpServer('srv-1');
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/mcp/servers/srv-1/test',
        undefined,
        expect.any(Object)
      );
    });

    it('should throw for missing serverId', async () => {
      await expect(api.testMcpServer(null)).rejects.toThrow(
        '[Endpoint] serverId is required for testMcpServer'
      );
    });
  });

  describe('getMcpServerTools()', () => {
    it('should GET /v1/mcp/servers/:id/tools', async () => {
      ctx.api.get.mockResolvedValueOnce([{ name: 'tool1' }, { name: 'tool2' }]);
      const result = await api.getMcpServerTools('srv-1');
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/mcp/servers/srv-1/tools', expect.any(Object));
      expect(result).toEqual([{ name: 'tool1' }, { name: 'tool2' }]);
    });

    it('should throw for missing serverId', async () => {
      await expect(api.getMcpServerTools('')).rejects.toThrow(
        '[Endpoint] serverId is required for getMcpServerTools'
      );
    });
  });

  describe('executeMcpTool()', () => {
    it('should POST /v1/mcp/servers/:id/tools/:name', async () => {
      ctx.api.post.mockResolvedValueOnce({ result: 'success' });
      const result = await api.executeMcpTool('srv-1', 'tool-1', { param: 'value' });
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/mcp/servers/srv-1/tools/tool-1',
        { arguments: { param: 'value' } },
        expect.any(Object)
      );
      expect(result).toEqual({ result: 'success' });
    });

    it('should throw for missing serverId', async () => {
      await expect(api.executeMcpTool('', 'tool-1')).rejects.toThrow(
        '[Endpoint] serverId is required for executeMcpTool'
      );
    });

    it('should throw for missing toolName', async () => {
      await expect(api.executeMcpTool('srv-1', '')).rejects.toThrow(
        '[Endpoint] toolName is required for executeMcpTool'
      );
    });
  });
});
