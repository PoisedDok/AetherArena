'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: () => {},
  trace: () => {},
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

jest.mock('../../../../src/core/events/EventTypes', () => ({
  EventTypes: {
    UI: { NOTIFICATION: 'ui:notification' },
  },
}));

const { ArtifactDeletionHandler } = require(
  '../../../../src/renderer/artifacts/controllers/modules/ArtifactDeletionHandler'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createHandler(overrides = {}) {
  const deletedArtifacts = overrides.deleted || new Set();
  const artifactCache = overrides.cache || new Map();
  const currentTab = overrides.tab || 'output';
  const codeViewer = { loadCode: jest.fn() };
  const outputViewer = { loadOutput: jest.fn() };
  const modules = overrides.modules || { codeViewer, outputViewer };
  const eventBus = { emit: jest.fn() };

  const handler = new ArtifactDeletionHandler({
    getDeletedArtifacts: () => deletedArtifacts,
    getArtifactCache: () => artifactCache,
    getCurrentTab: () => currentTab,
    getModules: () => modules,
    eventBus,
  });

  return { handler, deletedArtifacts, artifactCache, modules, eventBus, codeViewer, outputViewer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArtifactDeletionHandler', () => {
  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });

  // =========================================================================
  // handleFileDeleted
  // =========================================================================

  describe('handleFileDeleted', () => {
    it('adds all provided IDs to deletedArtifacts set', () => {
      const { handler, deletedArtifacts } = createHandler();

      handler.handleFileDeleted({
        artifactId: 'art-1',
        postgresqlId: 'pg-1',
        frontendId: 'fe-1',
        filename: 'test.js',
      });

      expect(deletedArtifacts.has('art-1')).toBe(true);
      expect(deletedArtifacts.has('pg-1')).toBe(true);
      expect(deletedArtifacts.has('fe-1')).toBe(true);
      expect(deletedArtifacts.size).toBe(3);
    });

    it('removes artifacts from cache by all IDs', () => {
      const cache = new Map([
        ['art-1', { id: 'art-1' }],
        ['pg-1', { id: 'pg-1' }],
        ['fe-1', { id: 'fe-1' }],
      ]);
      const { handler } = createHandler({ cache });

      handler.handleFileDeleted({
        artifactId: 'art-1',
        postgresqlId: 'pg-1',
        frontendId: 'fe-1',
      });

      expect(cache.size).toBe(0);
    });

    it('handles partial ID data (only artifactId)', () => {
      const cache = new Map([['art-1', { id: 'art-1' }]]);
      const { handler, deletedArtifacts } = createHandler({ cache });

      handler.handleFileDeleted({ artifactId: 'art-1' });

      expect(deletedArtifacts.has('art-1')).toBe(true);
      expect(cache.size).toBe(0);
    });

    it('does not add undefined IDs to set', () => {
      const { handler, deletedArtifacts } = createHandler();

      handler.handleFileDeleted({ filename: 'only-filename.txt' });

      expect(deletedArtifacts.size).toBe(0);
    });

    it('does not crash when cache does not have the ID', () => {
      const { handler } = createHandler();

      expect(() => handler.handleFileDeleted({
        artifactId: 'nonexistent',
      })).not.toThrow();
    });

    it('handles multiple deletions accumulating in set', () => {
      const { handler, deletedArtifacts } = createHandler();

      handler.handleFileDeleted({ artifactId: 'a1' });
      handler.handleFileDeleted({ artifactId: 'a2' });
      handler.handleFileDeleted({ artifactId: 'a3' });

      expect(deletedArtifacts.size).toBe(3);
    });

    it('returns gracefully when data is null (regression: TypeError guard)', () => {
      const { handler, deletedArtifacts } = createHandler();

      expect(() => handler.handleFileDeleted(null)).not.toThrow();
      expect(deletedArtifacts.size).toBe(0);
    });

    it('returns gracefully when data is undefined', () => {
      const { handler } = createHandler();
      expect(() => handler.handleFileDeleted(undefined)).not.toThrow();
    });

    it('returns gracefully when data is a string', () => {
      const { handler } = createHandler();
      expect(() => handler.handleFileDeleted('not-an-object')).not.toThrow();
    });
  });

  // =========================================================================
  // showDeletedArtifactMessage
  // =========================================================================

  describe('showDeletedArtifactMessage', () => {
    it('shows message in outputViewer when current tab is output', () => {
      const { handler, outputViewer, codeViewer, eventBus } = createHandler({ tab: 'output' });

      handler.showDeletedArtifactMessage('deleted-art-1');

      expect(outputViewer.loadOutput).toHaveBeenCalledWith(
        expect.stringContaining('Artifact Deleted'),
        'html',
        'deleted-art-1'
      );
      expect(codeViewer.loadCode).not.toHaveBeenCalled();
      expect(eventBus.emit).toHaveBeenCalledWith('ui:notification', {
        type: 'info',
        message: 'This artifact has been deleted',
      });
    });

    it('clears code viewer and shows in output viewer when tab is code', () => {
      const { handler, outputViewer, codeViewer } = createHandler({ tab: 'code' });

      handler.showDeletedArtifactMessage('del-art');

      expect(codeViewer.loadCode).toHaveBeenCalledWith('', '', 'Deleted Artifact');
      expect(outputViewer.loadOutput).toHaveBeenCalledWith(
        expect.stringContaining('Artifact Deleted'),
        'html',
        'del-art'
      );
    });

    it('truncates long artifact IDs in display', () => {
      const { handler, outputViewer } = createHandler({ tab: 'output' });
      const longId = 'a'.repeat(100);

      handler.showDeletedArtifactMessage(longId);

      const renderedHtml = outputViewer.loadOutput.mock.calls[0][0];
      // Should contain truncated ID (60 chars)
      expect(renderedHtml).toContain(longId.substring(0, 60));
      expect(renderedHtml).not.toContain(longId);
    });

    it('handles null artifactId gracefully', () => {
      const { handler, outputViewer } = createHandler({ tab: 'output' });

      handler.showDeletedArtifactMessage(null);

      const renderedHtml = outputViewer.loadOutput.mock.calls[0][0];
      expect(renderedHtml).toContain('Unknown ID');
    });

    it('handles missing outputViewer when tab is files', () => {
      const { handler } = createHandler({ tab: 'files', modules: {} });

      expect(() => handler.showDeletedArtifactMessage('x')).not.toThrow();
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('nulls all references', () => {
      const { handler } = createHandler();
      handler.dispose();

      expect(handler.getDeletedArtifacts).toBeNull();
      expect(handler.getArtifactCache).toBeNull();
      expect(handler.getCurrentTab).toBeNull();
      expect(handler.getModules).toBeNull();
      expect(handler.eventBus).toBeNull();
    });
  });
});
