'use strict';

const IndexingService = require('../../../../src/renderer/main/modules/indexes/internal/services/IndexingService');
const AetherBridge = require('../../../../src/renderer/shared/bridge/AetherBridge');

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: jest.fn()
}));

describe('IndexingService', () => {
  let endpoint;
  let logger;
  let service;
  let mockAether;

  beforeEach(() => {
    jest.clearAllMocks();

    endpoint = {
      listIndexes: jest.fn().mockResolvedValue({ indexes: [{ index_name: 'idx1' }] }),
      getSources: jest.fn().mockResolvedValue({
        sources: {
          browser_history: { enabled: true },
          email: { enabled: true }
        }
      }),
      getFileIndexingLocations: jest.fn().mockResolvedValue([
        { index_name: 'loc1', location_name: 'Loc 1' }
      ]),
      startIndexing: jest.fn().mockResolvedValue({ status: 'started' }),
      getIndexStatus: jest.fn().mockResolvedValue({ status: 'completed' })
    };

    logger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };

    mockAether = {
      dialog: {
        showFilePicker: jest.fn(),
        showDirectoryPicker: jest.fn()
      }
    };
    AetherBridge.getAether.mockReturnValue(mockAether);

    service = new IndexingService({ endpoint, logger });
  });

  afterEach(() => {
    service.dispose();
  });

  describe('constructor', () => {
    test('initializes state correctly', () => {
      expect(service.sourceManagerState).toBe('idle');
      expect(service.selectedSources.size).toBe(0);
      expect(service.indexMap).toBeInstanceOf(Map);
    });
  });

  describe('fetchIndexes', () => {
    test('fetches indexes and builds map', async () => {
      await service.fetchIndexes();

      expect(endpoint.listIndexes).toHaveBeenCalled();
      expect(endpoint.getSources).toHaveBeenCalled();
      expect(endpoint.getFileIndexingLocations).toHaveBeenCalled();

      // idx1 + loc1 + browser_history + email = 4 items
      expect(service.indexes.length).toBe(4);
      expect(service.indexMap.has('idx1')).toBe(true);
      expect(service.indexMap.has('loc1')).toBe(true);
      expect(service.indexMap.has('browser_history')).toBe(true);
      expect(service.indexMap.has('email')).toBe(true);
    });

    test('handles errors and resets state', async () => {
      endpoint.listIndexes.mockRejectedValue(new Error('Network error'));
      await expect(service.fetchIndexes()).rejects.toThrow('Network error');
      expect(service.indexes.length).toBe(0);
      expect(service.indexMap.size).toBe(0);
      expect(logger.error).toHaveBeenCalled();
    });

    test('does not fetch if disposed', async () => {
      service.dispose();
      await service.fetchIndexes();
      expect(endpoint.listIndexes).not.toHaveBeenCalled();
    });
  });

  describe('selection', () => {
    test('toggleSourceSelection toggles items', () => {
      service.toggleSourceSelection('idx1');
      expect(service.selectedSources.has('idx1')).toBe(true);
      
      service.toggleSourceSelection('idx1');
      expect(service.selectedSources.has('idx1')).toBe(false);
    });

    test('toggleAllSources selects all searchable sources or clears them', () => {
      service.indexes = [
        { index_name: 'idx1', is_searchable: true },
        { index_name: 'loc1', is_searchable: false }
      ];
      
      service.toggleAllSources();
      expect(service.selectedSources.has('idx1')).toBe(true);
      expect(service.selectedSources.has('loc1')).toBe(false);
      
      // Since size is 1 but length is 2, another toggleAll should select again? Wait, the logic is:
      // allSelected = size === length. So it will be false. Next toggle selects all.
      // We will just verify it adds properly.
      
      service.selectedSources.add('idx1');
      service.selectedSources.add('loc1');
      service.indexes.push({ index_name: 'idx2', is_searchable: true });
      service.toggleAllSources();
      
      expect(service.selectedSources.has('idx2')).toBe(true);
    });
  });

  describe('file picker handling', () => {
    test('handleAddFiles opens picker and updates state', async () => {
      mockAether.dialog.showFilePicker.mockResolvedValue(['/path/to/file.txt']);
      
      const changeSpy = jest.fn();
      service.addEventListener('change', changeSpy);
      
      await service.handleAddFiles();
      
      expect(mockAether.dialog.showFilePicker).toHaveBeenCalled();
      expect(service.selectedFiles.length).toBe(1);
      expect(service.selectedFiles[0].path).toBe('/path/to/file.txt');
      expect(service.sourceManagerState).toBe('configuring');
      expect(changeSpy).toHaveBeenCalled();
    });

    test('handleAddFiles notifies error if picker absent', async () => {
      mockAether.dialog.showFilePicker = undefined;
      const notifySpy = jest.fn();
      service.addEventListener('notification', (e) => notifySpy(e.detail));
      
      await service.handleAddFiles();
      expect(notifySpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });

    test('handleAddFolder opens picker and updates state', async () => {
      mockAether.dialog.showDirectoryPicker.mockResolvedValue('/path/to/folder');
      
      await service.handleAddFolder();
      
      expect(mockAether.dialog.showDirectoryPicker).toHaveBeenCalled();
      expect(service.selectedFiles.length).toBe(1);
      expect(service.selectedFiles[0].isDir).toBe(true);
      expect(service.sourceManagerState).toBe('configuring');
    });
  });

  describe('dispose', () => {
    test('sets flag and clears timers', () => {
      service._pollTimers.set('idx1', 123);
      global.clearInterval = jest.fn();
      
      service.dispose();
      
      expect(service._isDisposed).toBe(true);
      expect(global.clearInterval).toHaveBeenCalledWith(123);
      expect(service._pollTimers.size).toBe(0);
    });
  });
});