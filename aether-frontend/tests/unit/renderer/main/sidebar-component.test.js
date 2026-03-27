'use strict';

const SidebarComponent = require('../../../../src/renderer/main/modules/indexes/internal/components/SidebarComponent');
const BaseComponent = require('../../../../src/renderer/main/modules/indexes/internal/components/BaseComponent');
const IndexBrowserUtils = require('../../../../src/renderer/main/modules/indexes/internal/IndexBrowserUtils');

// Mock utilities
jest.mock('../../../../src/renderer/main/modules/indexes/internal/IndexBrowserUtils', () => ({
  escapeHtml: jest.fn(s => s),
  escapeAttr: jest.fn(s => s)
}));

describe('SidebarComponent', () => {
  let container;
  let ctx;
  let uiText;
  let indexTypeIcons;

  beforeEach(() => {
    container = document.createElement('div');
    ctx = {
      sourcesExpanded: false,
      searchMode: 'semantic',
      _getAvailableSearchModes: jest.fn().mockReturnValue(new Set(['semantic', 'bm25'])),
      _groupIndexes: jest.fn(idxList => ({ 'Sources': idxList })),
      toggleSidebar: jest.fn(),
      searchService: {
        searchMode: 'semantic',
        updateSearchMode: jest.fn(),
        topK: 10,
        confidenceThreshold: 0.5
      },
      indexingService: {
        sourceManagerState: 'idle',
        selectedFiles: [],
        newSourceName: '',
        newSourceIndexMode: ['semantic', 'bm25'],
        indexingJobs: new Map(),
        indexes: [
          { index_name: 'idx1', display_name: 'Index 1', is_searchable: true, index_type: 'source', _unindexed: false }
        ],
        selectedSources: new Set(['idx1']),
        deriveSourceName: jest.fn().mockReturnValue('Derived Name'),
        handleAddFiles: jest.fn(),
        handleAddFolder: jest.fn(),
        toggleSourceSelection: jest.fn(),
        toggleAllSources: jest.fn(),
        submitNewSource: jest.fn()
      },
      events: {
        emit: jest.fn()
      }
    };
    uiText = {
      FILTERS: { settings: 'Settings' },
      SOURCE_MANAGER: {
        addTitle: 'Add Data Source',
        configTitle: 'Configure Source',
        supported: 'Supported files...',
        sourceName: 'Name',
        sourceNamePlaceholder: 'Enter name',
        searchMode: 'Mode',
        modeCards: {
          semantic: { label: 'Semantic', desc: 'desc' },
          bm25: { label: 'Exact Match', desc: 'desc' }
        },
        indexButton: 'Start Indexing'
      },
      HERO: {
        selectFiles: 'Select Files',
        selectFolder: 'Select Folder'
      },
      MODES: {
        labels: {
          semantic: 'Semantic',
          bm25: 'Keyword'
        }
      },
      SOURCES: {
        emptyHint: 'Empty',
        toggleSelectAll: 'Select All',
        toggleDeselectAll: 'Deselect All',
        chunkIndexing: 'Indexing...',
        chunkUnindexed: 'Not indexed',
        chunkChunks: 'chunks'
      },
      ADVANCED: {
        title: 'Advanced',
        topK: 'Top K',
        confidence: 'Confidence'
      },
      SEARCH_MODES: {
        hybrid: { label: 'Hybrid' },
        semantic: { label: 'Semantic' },
        bm25: { label: 'Keyword' }
      }
    };
    indexTypeIcons = {
      source: 'fa-database'
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('render', () => {
    test('renders initial layout correctly', () => {
      const comp = new SidebarComponent(container, ctx, uiText, indexTypeIcons);
      
      const sidebar = container.querySelector('.se-sidebar');
      expect(sidebar).not.toBeNull();
      
      const title = container.querySelector('.se-sidebar-title');
      expect(title.textContent).toBe('Settings');
    });

    test('adds is-active and is-open if sourcesExpanded is true', () => {
      ctx.sourcesExpanded = true;
      const comp = new SidebarComponent(container, ctx, uiText, indexTypeIcons);
      
      expect(container.querySelector('.se-sidebar-overlay.is-active')).not.toBeNull();
      expect(container.querySelector('.se-sidebar.is-open')).not.toBeNull();
    });
  });

  describe('_renderSourceManager', () => {
    test('renders empty when idle', () => {
      ctx.indexingService.sourceManagerState = 'idle';
      const comp = new SidebarComponent(container, ctx, uiText, indexTypeIcons);
      
      const manager = container.querySelector('#sidebar-source-manager');
      expect(manager.innerHTML).toBe('');
    });

    test('renders selecting state', () => {
      ctx.indexingService.sourceManagerState = 'selecting';
      const comp = new SidebarComponent(container, ctx, uiText, indexTypeIcons);
      
      const title = container.querySelector('.se-source-add-title');
      expect(title.textContent).toBe('Add Data Source');
    });

    test('renders configuring state with files', () => {
      ctx.indexingService.sourceManagerState = 'configuring';
      ctx.indexingService.selectedFiles = [{ name: 'file1.pdf' }, { name: 'file2.txt' }];
      
      const comp = new SidebarComponent(container, ctx, uiText, indexTypeIcons);
      
      const summary = container.querySelector('.se-source-file-summary span');
      expect(summary.textContent).toBe('2 files selected');
    });

    test('renders indexing notifications', () => {
      ctx.indexingService.indexingJobs.set('job1', {
        state: 'indexing',
        progress_pct: 50,
        files_total: 10,
        files_processed: 5,
        display_name: 'Job 1'
      });
      
      const comp = new SidebarComponent(container, ctx, uiText, indexTypeIcons);
      const bar = container.querySelector('.se-indexing-bar[data-index-name="job1"]');
      expect(bar).not.toBeNull();
      
      const detail = bar.querySelector('.se-indexing-bar-detail');
      expect(detail.textContent).toContain('50% 5/10 files');
    });
  });

  describe('interactions', () => {
    test('closes sidebar via overlay click', () => {
      const comp = new SidebarComponent(container, ctx, uiText, indexTypeIcons);
      const overlay = container.querySelector('.se-sidebar-overlay');
      
      overlay.click();
      expect(ctx.toggleSidebar).toHaveBeenCalledWith(false);
    });

    test('closes sidebar via close button click', () => {
      const comp = new SidebarComponent(container, ctx, uiText, indexTypeIcons);
      const closeBtn = container.querySelector('.se-sidebar-close-btn');
      
      closeBtn.click();
      expect(ctx.toggleSidebar).toHaveBeenCalledWith(false);
    });

    test('handles add file click', () => {
      ctx.indexingService.sourceManagerState = 'selecting';
      const comp = new SidebarComponent(container, ctx, uiText, indexTypeIcons);
      
      const btn = container.querySelector('.se-source-pick-files');
      btn.click();
      expect(ctx.indexingService.handleAddFiles).toHaveBeenCalled();
    });

    test('handles source selection toggle', () => {
      const comp = new SidebarComponent(container, ctx, uiText, indexTypeIcons);
      
      const sourceItem = container.querySelector('[data-source-toggle="idx1"]');
      sourceItem.click();
      
      expect(ctx.indexingService.toggleSourceSelection).toHaveBeenCalledWith('idx1', true);
    });
  });
});