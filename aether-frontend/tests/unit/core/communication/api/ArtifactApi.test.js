'use strict';

const ArtifactApi = require('../../../../../src/core/communication/api/ArtifactApi');

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

describe('ArtifactApi', () => {
  let api, ctx;

  beforeEach(() => {
    ctx = createMockCtx();
    api = new ArtifactApi(ctx);
  });

  describe('getArtifact()', () => {
    it('should GET /v1/storage/artifact/get/:id with encoded id', async () => {
      await api.getArtifact('art-1');
      expect(ctx.api.get).toHaveBeenCalledWith('/v1/storage/artifact/get/art-1', expect.any(Object));
    });

    it('should encode special characters in artifactId', async () => {
      await api.getArtifact('id/with/slashes');
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/storage/artifact/get/id%2Fwith%2Fslashes',
        expect.any(Object)
      );
    });

    it('should throw for missing artifactId', async () => {
      await expect(api.getArtifact(null)).rejects.toThrow(
        '[Endpoint] artifactId is required for getArtifact'
      );
    });

    it('should throw for empty string artifactId', async () => {
      await expect(api.getArtifact('')).rejects.toThrow(
        '[Endpoint] artifactId is required for getArtifact'
      );
    });
  });

  describe('exportArtifact()', () => {
    it('should GET /v1/storage/artifact/export/:id with responseType text', async () => {
      ctx.api.get.mockResolvedValueOnce('file content here');
      const result = await api.exportArtifact('art-1');
      expect(ctx.api.get).toHaveBeenCalledWith(
        '/v1/storage/artifact/export/art-1',
        expect.objectContaining({ responseType: 'text' })
      );
      expect(result).toBe('file content here');
    });

    it('should throw for missing artifactId', async () => {
      await expect(api.exportArtifact(undefined)).rejects.toThrow(
        '[Endpoint] artifactId is required for exportArtifact'
      );
    });
  });

  describe('updateArtifact()', () => {
    it('should PUT /v1/storage/artifact/update/:id with updates', async () => {
      const updates = { content: 'new content', filename: 'updated.js' };
      await api.updateArtifact('art-1', updates);
      expect(ctx.api.put).toHaveBeenCalledWith(
        '/v1/storage/artifact/update/art-1',
        updates,
        expect.any(Object)
      );
    });

    it('should throw for missing artifactId', async () => {
      await expect(api.updateArtifact(null, {})).rejects.toThrow(
        '[Endpoint] artifactId is required for updateArtifact'
      );
    });
  });

  describe('deleteArtifact()', () => {
    it('should DELETE /v1/storage/artifact/delete/:id', async () => {
      await api.deleteArtifact('art-1');
      expect(ctx.api.delete).toHaveBeenCalledWith('/v1/storage/artifact/delete/art-1', expect.any(Object));
    });

    it('should throw for missing artifactId', async () => {
      await expect(api.deleteArtifact('')).rejects.toThrow(
        '[Endpoint] artifactId is required for deleteArtifact'
      );
    });

    it('should propagate and log errors', async () => {
      ctx.api.delete.mockRejectedValueOnce(new Error('Not found'));
      await expect(api.deleteArtifact('bad-id')).rejects.toThrow('Not found');
      expect(ctx.logger.error).toHaveBeenCalled();
    });
  });
});
