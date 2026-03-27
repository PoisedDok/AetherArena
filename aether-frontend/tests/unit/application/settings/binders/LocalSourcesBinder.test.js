/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */
'use strict';

const LocalSourcesBinder = require('../../../../../src/application/main/modules/settings/binders/LocalSourcesBinder');

// Mock /v1/sources response
const MOCK_SOURCES = {
  enabled: true,
  sources: {},
  indexes: [],
  supported_browsers: [
    { value: 'edge', label: 'Microsoft Edge' },
    { value: 'chrome', label: 'Google Chrome' },
    { value: 'chromium', label: 'Chromium' },
  ],
};

describe('LocalSourcesBinder', () => {
  let binder;
  let mockLog;
  let mockEndpoint;

  const fullConfig = {
    enabled: true,
    index_root_dir: '/data/indexes',
    search: {
      mode: 'hybrid',
      hybrid_semantic_weight: 1.0,
      hybrid_sparse_weight: 0.5,
      rrf_k: 60
    }
  };

  function el(tag, id, attrs = {}) {
    const e = document.createElement(tag);
    e.id = id;
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'checked') e.checked = v;
      else if (k === 'type') e.type = v;
      else e.setAttribute(k, v);
    });
    document.body.appendChild(e);
    return e;
  }

  beforeEach(() => {
    mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    mockEndpoint = {
      getSources: jest.fn().mockResolvedValue({ enabled: true, sources: {}, indexes: [] }),
      setSettings: jest.fn().mockResolvedValue({}),
      getBackendURL: jest.fn().mockReturnValue('http://127.0.0.1:8765'),
      api: {
        get: jest.fn().mockResolvedValue(MOCK_SOURCES)
      }
    };
    binder = new LocalSourcesBinder({ log: mockLog, endpoint: mockEndpoint });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // =========================================================================
  // populate
  // =========================================================================
  describe('populate()', () => {
    it('populates global enabled and index root', async () => {
      el('input', 'aether-rag-sources-enabled', { type: 'checkbox' });
      el('input', 'aether-rag-sources-index-root-dir');
      await binder.populate(fullConfig);
      expect(document.getElementById('aether-rag-sources-enabled').checked).toBe(true);
      expect(document.getElementById('aether-rag-sources-index-root-dir').value).toBe('/data/indexes');
    });

    it('handles null/undefined localSources without error', async () => {
      await expect(binder.populate(null)).resolves.toBeUndefined();
      await expect(binder.populate(undefined)).resolves.toBeUndefined();
    });

    it('handles missing sub-objects', async () => {
      el('input', 'aether-rag-sources-enabled', { type: 'checkbox' });
      await binder.populate({ enabled: false });
      expect(document.getElementById('aether-rag-sources-enabled').checked).toBe(false);
    });
  });

  // =========================================================================
  // collect
  // =========================================================================
  describe('collect()', () => {
    it('returns null when no UI elements exist', () => {
      expect(binder.collect()).toBeNull();
    });

    it('collects all fields from DOM', () => {
      const enabledEl = el('input', 'aether-rag-sources-enabled', { type: 'checkbox' });
      enabledEl.checked = true;
      el('input', 'aether-rag-sources-index-root-dir').value = '/data';
      el('select', 'aether-rag-search-mode').value = 'hybrid';
      el('input', 'aether-rag-search-semantic-weight').value = '1.0';
      el('input', 'aether-rag-search-sparse-weight').value = '0.5';
      el('input', 'aether-rag-search-rrf-k').value = '60';

      const result = binder.collect();
      expect(result.enabled).toBe(true);
      expect(result.index_root_dir).toBe('/data');
      expect(result.search.mode).toBe('hybrid');
      expect(result.search.hybrid_semantic_weight).toBe(1.0);
    });
  });

  // =========================================================================
  // lockControls
  // =========================================================================
  describe('lockControls()', () => {
    it('disables all local sources controls', () => {
      const ids = ['aether-rag-sources-enabled', 'aether-rag-search-mode'];
      ids.forEach(id => el('input', id));

      binder.lockControls('Locked');
      ids.forEach(id => {
        const e = document.getElementById(id);
        expect(e.disabled).toBe(true);
        expect(e.title).toBe('Locked');
      });
    });

    it('does not throw when elements are absent', () => {
      expect(() => binder.lockControls()).not.toThrow();
    });
  });

  // =========================================================================
  // refreshStatus
  // =========================================================================
  describe('refreshStatus()', () => {
    it('calls endpoint.getSources and writes status text', async () => {
      mockEndpoint.getSources.mockResolvedValue({
        enabled: true,
        index_root_dir: '/idx',
        sources: {},
        indexes: [{ index_name: 'test_main' }],
      });
      el('div', 'aether-rag-sources-status');

      await binder.refreshStatus();

      const text = document.getElementById('aether-rag-sources-status').textContent;
      expect(text).toContain('enabled: true');
      expect(text).toContain('index_root_dir: /idx');
      expect(text).toContain('test_main');
    });

    it('handles endpoint lacking getSources gracefully', async () => {
      delete mockEndpoint.getSources;
      el('div', 'aether-rag-sources-status');

      await binder.refreshStatus();
      expect(document.getElementById('aether-rag-sources-status').textContent).toContain('missing getSources');
    });
  });

  // =========================================================================
  // attachListenersOnce
  // =========================================================================
  describe('attachListenersOnce()', () => {
    it('attaches click listener to refresh button and calls refreshStatus', () => {
      const btn = el('button', 'aether-rag-sources-refresh');
      binder.refreshStatus = jest.fn();

      binder.attachListenersOnce();
      btn.click();

      expect(binder.refreshStatus).toHaveBeenCalled();
    });

    it('attaches listener only once', () => {
      const btn = el('button', 'aether-rag-sources-refresh');
      binder.refreshStatus = jest.fn();

      binder.attachListenersOnce();
      binder.attachListenersOnce(); // second call
      btn.click();

      expect(binder.refreshStatus).toHaveBeenCalledTimes(1);
    });

    it('catches and logs errors during refresh', async () => {
      const btn = el('button', 'aether-rag-sources-refresh');
      el('div', 'aether-rag-sources-status');
      binder.refreshStatus = jest.fn().mockRejectedValue(new Error('Network error'));

      binder.attachListenersOnce();
      btn.click();
      await Promise.resolve(); // flush

      expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Failed to refresh'), expect.any(Error));
      expect(document.getElementById('aether-rag-sources-status').textContent).toContain('Network error');
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================
  describe('dispose()', () => {
    it('removes all event listeners', () => {
      const btn = el('button', 'aether-rag-sources-refresh');
      binder.refreshStatus = jest.fn();

      binder.attachListenersOnce();
      binder.dispose();
      btn.click();

      expect(binder.refreshStatus).not.toHaveBeenCalled();
    });

    it('nullifies endpoint', () => {
      binder.dispose();
      expect(binder._endpoint).toBeNull();
    });
  });
});
