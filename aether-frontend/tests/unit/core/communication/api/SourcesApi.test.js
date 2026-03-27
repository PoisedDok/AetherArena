'use strict';

const SourcesApi = require('../../../../../src/core/communication/api/SourcesApi');

function createMockCtx() {
  return {
    api: {
      get: jest.fn().mockResolvedValue({}),
      post: jest.fn().mockResolvedValue({}),
      put: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
    },
    logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
  };
}

describe('SourcesApi', () => {
  let api, ctx;

  beforeEach(() => {
    ctx = createMockCtx();
    api = new SourcesApi(ctx);
  });

  // =========================================================================
  // Source Integrations
  // =========================================================================
  describe('getSources()', () => {
    it('should GET /v1/sources', async () => {
      await api.getSources();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/sources', {});
    });
  });

  describe('listSources()', () => {
    it('should GET /v1/sources (alias for getSources)', async () => {
      await api.listSources();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/sources', {});
    });
  });

  describe('discoverBrowserProfiles()', () => {
    it('should POST /v1/sources/browser-history/discover', async () => {
      await api.discoverBrowserProfiles({ browser: 'chrome' });
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/sources/browser-history/discover',
        { browser: 'chrome' },
        {}
      );
    });

    it('should default to empty payload', async () => {
      await api.discoverBrowserProfiles();
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/sources/browser-history/discover',
        {},
        {}
      );
    });
  });

  describe('buildBrowserHistorySourceIndex()', () => {
    it('should POST /v1/sources/browser-history/index with Cache-Control header', async () => {
      await api.buildBrowserHistorySourceIndex({ profile_id: 'p1' });
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/sources/browser-history/index',
        { profile_id: 'p1' },
        expect.objectContaining({ headers: { 'Cache-Control': 'no-cache' } })
      );
    });
  });

  describe('buildEmailSourceIndex()', () => {
    it('should POST /v1/sources/email/index', async () => {
      await api.buildEmailSourceIndex({ path: '/inbox.mbox' });
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/sources/email/index',
        { path: '/inbox.mbox' },
        {}
      );
    });
  });

  // =========================================================================
  // Custom Source Indexing
  // =========================================================================
  describe('buildCustomSourceIndex()', () => {
    it('should POST /v1/sources/custom/index with payload', async () => {
      const payload = {
        file_paths: ['/tmp/doc.pdf'],
        index_name: 'my_docs',
        display_name: 'My Documents',
        index_mode: 'combined',
      };
      await api.buildCustomSourceIndex(payload);
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/sources/custom/index',
        payload,
        {}
      );
    });

    it('should throw for missing file_paths', async () => {
      await expect(
        api.buildCustomSourceIndex({ index_name: 'x', display_name: 'X' })
      ).rejects.toThrow('file_paths[]');
    });

    it('should throw for empty file_paths array', async () => {
      await expect(
        api.buildCustomSourceIndex({ file_paths: [], index_name: 'x', display_name: 'X' })
      ).rejects.toThrow('file_paths[]');
    });

    it('should throw for missing index_name', async () => {
      await expect(
        api.buildCustomSourceIndex({ file_paths: ['/f'], display_name: 'X' })
      ).rejects.toThrow('index_name');
    });

    it('should throw for missing display_name', async () => {
      await expect(
        api.buildCustomSourceIndex({ file_paths: ['/f'], index_name: 'x' })
      ).rejects.toThrow('display_name');
    });
  });

  describe('getSourceIndexStatus()', () => {
    it('should GET /v1/sources/index-status/{name}', async () => {
      await api.getSourceIndexStatus('my_idx');
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/sources/index-status/my_idx',
        {}
      );
    });

    it('should throw for missing indexName', async () => {
      await expect(api.getSourceIndexStatus(null)).rejects.toThrow('indexName');
    });
  });

  describe('getActiveIndexingJobs()', () => {
    it('should GET /v1/sources/active-jobs', async () => {
      await api.getActiveIndexingJobs();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/sources/active-jobs', {});
    });
  });

  describe('deleteSourceIndex()', () => {
    it('should DELETE /v1/sources/{name}', async () => {
      ctx.api.delete = jest.fn().mockResolvedValue({ success: true });
      await api.deleteSourceIndex('old_idx');
      expect(ctx.api.delete).toHaveBeenCalledWith(
        '/v1/sources/old_idx',
        {}
      );
    });

    it('should throw for missing indexName', async () => {
      await expect(api.deleteSourceIndex(null)).rejects.toThrow('indexName');
    });
  });

  // =========================================================================
  // Index Management & Search
  // =========================================================================
  describe('listIndexes()', () => {
    it('should GET /v1/index/list', async () => {
      await api.listIndexes();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/index/list', {});
    });
  });

  describe('searchIndex()', () => {
    it('should GET /v1/search/index with query params', async () => {
      await api.searchIndex('browser-history', { query: 'cursor.sh', topK: 10 });
      const path = ctx.api.get.mock.calls[0][0];
      expect(path).toContain('/v1/search/index?');
      expect(path).toContain('name=browser-history');
      expect(path).toContain('query=cursor.sh');
      expect(path).toContain('top_k=10');
    });

    it('should include minScore and mode when provided', async () => {
      await api.searchIndex('docs', { query: 'help', minScore: 0.5, mode: 'semantic' });
      const path = ctx.api.get.mock.calls[0][0];
      expect(path).toContain('min_score=0.5');
      expect(path).toContain('mode=semantic');
    });

    it('should throw for missing indexName', async () => {
      await expect(api.searchIndex(null)).rejects.toThrow(
        '[Endpoint] indexName is required for searchIndex'
      );
    });

    it('should default query to empty string', async () => {
      await api.searchIndex('test-idx');
      const path = ctx.api.get.mock.calls[0][0];
      expect(path).toContain('query=');
    });
  });

  describe('searchIndexes()', () => {
    it('should POST /v1/search/indexes with payload', async () => {
      const payload = { query: 'meeting notes', indexes: ['slack', 'email'] };
      await api.searchIndexes(payload);
      expect(ctx.api.post).toHaveBeenCalledWith('/v1/search/indexes', payload, expect.any(Object));
    });

    it('should throw for missing query in payload', async () => {
      await expect(api.searchIndexes({ indexes: ['slack'] })).rejects.toThrow(
        'query is required for searchIndexes'
      );
    });

    it('should throw for null payload', async () => {
      await expect(api.searchIndexes(null)).rejects.toThrow(
        'query is required for searchIndexes'
      );
    });
  });
});
