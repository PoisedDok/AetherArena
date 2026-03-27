'use strict';

const FileIndexingApi = require('../../../../../src/core/communication/api/FileIndexingApi');

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

describe('FileIndexingApi', () => {
  let api, ctx;

  beforeEach(() => {
    ctx = createMockCtx();
    api = new FileIndexingApi(ctx);
  });

  // =========================================================================
  // Location CRUD
  // =========================================================================
  describe('getFileIndexingLocations()', () => {
    it('should GET /v1/file/location/list without params', async () => {
      await api.getFileIndexingLocations();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/file/location/list', {});
    });

    it('should append ?enabled_only=true when enabledOnly=true', async () => {
      await api.getFileIndexingLocations(true);
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/file/location/list?enabled_only=true', {});
    });
  });

  describe('createFileIndexingLocation()', () => {
    it('should POST /v1/file/location/create with location data', async () => {
      const data = { path: '/home/user/docs', name: 'My Docs' };
      await api.createFileIndexingLocation(data);
      expect(ctx.api.post).toHaveBeenCalledWith('/v1/file/location/create', data, {});
    });
  });

  describe('getFileIndexingLocation()', () => {
    it('should GET /v1/file/location/get/:id', async () => {
      await api.getFileIndexingLocation('loc-1');
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/file/location/get/loc-1', expect.any(Object));
    });

    it('should throw for missing locationId', async () => {
      await expect(api.getFileIndexingLocation(null)).rejects.toThrow(
        '[Endpoint] locationId is required for getFileIndexingLocation'
      );
    });
  });

  describe('updateFileIndexingLocation()', () => {
    it('should PUT /v1/file/location/update/:id', async () => {
      await api.updateFileIndexingLocation('loc-1', { enabled: false });
      expect(ctx.api.put).toHaveBeenCalledWith(
        '/v1/file/location/update/loc-1',
        { enabled: false },
        expect.any(Object)
      );
    });

    it('should throw for missing locationId', async () => {
      await expect(api.updateFileIndexingLocation('', {})).rejects.toThrow(
        '[Endpoint] locationId is required for updateFileIndexingLocation'
      );
    });
  });

  describe('deleteFileIndexingLocation()', () => {
    it('should DELETE /v1/file/location/delete/:id', async () => {
      await api.deleteFileIndexingLocation('loc-1');
      expect(ctx.api.delete).toHaveBeenCalledWith(
        '/v1/file/location/delete/loc-1',
        expect.any(Object)
      );
    });

    it('should throw for missing locationId', async () => {
      await expect(api.deleteFileIndexingLocation(null)).rejects.toThrow(
        '[Endpoint] locationId is required for deleteFileIndexingLocation'
      );
    });
  });

  // =========================================================================
  // Active Job Query
  // =========================================================================
  describe('getActiveJobForLocation()', () => {
    it('should GET /v1/file/location/active-job/:id', async () => {
      await api.getActiveJobForLocation('loc-1');
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/file/location/active-job/loc-1', expect.any(Object));
    });

    it('should throw for missing locationId', async () => {
      await expect(api.getActiveJobForLocation(null)).rejects.toThrow(
        '[Endpoint] locationId is required for getActiveJobForLocation'
      );
    });
  });

  // =========================================================================
  // Reindex Job Lifecycle
  // =========================================================================
  describe('triggerFileIndexingReindex()', () => {
    it('should POST /v1/file/location/reindex/:id with null body', async () => {
      await api.triggerFileIndexingReindex('loc-1');
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/file/location/reindex/loc-1',
        null,
        expect.any(Object)
      );
    });

    it('should throw for missing locationId', async () => {
      await expect(api.triggerFileIndexingReindex('')).rejects.toThrow(
        '[Endpoint] locationId is required for triggerFileIndexingReindex'
      );
    });
  });

  describe('getReindexJobStatus()', () => {
    it('should GET /v1/file/reindex/status/:id', async () => {
      await api.getReindexJobStatus('job-1');
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/file/reindex/status/job-1', expect.any(Object));
    });

    it('should throw for missing jobId', async () => {
      await expect(api.getReindexJobStatus(null)).rejects.toThrow(
        '[Endpoint] jobId is required for getReindexJobStatus'
      );
    });
  });

  describe('pauseReindexJob()', () => {
    it('should POST /v1/file/reindex/pause/:id', async () => {
      await api.pauseReindexJob('job-1');
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/file/reindex/pause/job-1',
        undefined,
        expect.any(Object)
      );
    });

    it('should throw for missing jobId', async () => {
      await expect(api.pauseReindexJob('')).rejects.toThrow(
        '[Endpoint] jobId is required for pauseReindexJob'
      );
    });
  });

  describe('resumeReindexJob()', () => {
    it('should POST /v1/file/reindex/resume/:id', async () => {
      await api.resumeReindexJob('job-1');
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/file/reindex/resume/job-1',
        undefined,
        expect.any(Object)
      );
    });

    it('should throw for missing jobId', async () => {
      await expect(api.resumeReindexJob(null)).rejects.toThrow(
        '[Endpoint] jobId is required for resumeReindexJob'
      );
    });
  });

  describe('stopReindexJob()', () => {
    it('should POST /v1/file/reindex/stop/:id', async () => {
      await api.stopReindexJob('job-1');
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/file/reindex/stop/job-1',
        undefined,
        expect.any(Object)
      );
    });

    it('should throw for missing jobId', async () => {
      await expect(api.stopReindexJob('')).rejects.toThrow(
        '[Endpoint] jobId is required for stopReindexJob'
      );
    });
  });

  describe('cancelReindexJob()', () => {
    it('should DELETE /v1/file/reindex/cancel/:id', async () => {
      await api.cancelReindexJob('job-1');
      expect(ctx.api.delete).toHaveBeenCalledWith(
        '/v1/file/reindex/cancel/job-1',
        expect.any(Object)
      );
    });

    it('should throw for missing jobId', async () => {
      await expect(api.cancelReindexJob(null)).rejects.toThrow(
        '[Endpoint] jobId is required for cancelReindexJob'
      );
    });
  });

  // =========================================================================
  // File Search
  // =========================================================================
  describe('searchIndexedFiles()', () => {
    it('should GET /v1/search/files with query params', async () => {
      await api.searchIndexedFiles('test.js', { limit: 10 });
      const path = ctx.api.get.mock.calls[0][0];
      expect(path).toContain('/v1/search/files?');
      expect(path).toContain('query=test.js');
      expect(path).toContain('limit=10');
    });
  });

  // =========================================================================
  // Daemon Management
  // =========================================================================
  describe('getFileIndexingHealth()', () => {
    it('should GET /v1/file/health', async () => {
      await api.getFileIndexingHealth();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/file/health', {});
    });
  });

  describe('getFileIndexingDaemonStatus()', () => {
    it('should GET /v1/file/daemon/status', async () => {
      await api.getFileIndexingDaemonStatus();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/file/daemon/status', {});
    });
  });

  describe('getFileIndexingDaemonConfig()', () => {
    it('should GET /v1/file/daemon/config', async () => {
      await api.getFileIndexingDaemonConfig();
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/file/daemon/config', {});
    });
  });

  describe('updateFileIndexingDaemonConfig()', () => {
    it('should POST /v1/file/daemon/config with config', async () => {
      await api.updateFileIndexingDaemonConfig({ interval: 300 });
      expect(ctx.api.post).toHaveBeenCalledWith(
        '/v1/file/daemon/config',
        { interval: 300 },
        {}
      );
    });
  });

  describe('restartFileIndexingDaemon()', () => {
    it('should POST /v1/file/daemon/restart', async () => {
      await api.restartFileIndexingDaemon();
      expect(ctx.api.post).toHaveBeenCalledWith('/v1/file/daemon/restart', undefined, {});
    });
  });

  describe('stopFileIndexingDaemon()', () => {
    it('should POST /v1/file/daemon/stop', async () => {
      await api.stopFileIndexingDaemon();
      expect(ctx.api.post).toHaveBeenCalledWith('/v1/file/daemon/stop', undefined, {});
    });
  });

  describe('startFileIndexingDaemon()', () => {
    it('should POST /v1/file/daemon/start', async () => {
      await api.startFileIndexingDaemon();
      expect(ctx.api.post).toHaveBeenCalledWith('/v1/file/daemon/start', undefined, {});
    });
  });
});
