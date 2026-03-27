'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  })),
}));

const MenuBadgeController = require('../../../../src/renderer/main/runtime/coordinators/MenuBadgeController');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createElement() {
  return document.createElement('span');
}

function createElements() {
  return {
    indexBadge: createElement(),
    jobsBadge: createElement(),
  };
}

function createSettings(overrides = {}) {
  return {
    agents: {
      ui_polling: {
        index_health_poll_interval_ms: 60000,
        jobs_poll_interval_ms: 30000,
        ...overrides.ui_polling,
      },
      ...overrides.agents,
    },
  };
}

function createMockEndpoint(overrides = {}) {
  return {
    getSettings: jest.fn().mockResolvedValue(createSettings()),
    listIndexes: jest.fn().mockResolvedValue({ indexes: [{ id: 'a' }, { id: 'b' }] }),
    listAgentJobs: jest.fn().mockResolvedValue({
      jobs: [
        { status: 'running' },
        { status: 'completed' },
        { status: 'in_progress' },
      ],
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MenuBadgeController', () => {
  let controller;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 1, 9, 12, 0, 0)); // 2026-02-09 noon

    const { createRendererLogger } = require('../../../../src/renderer/shared/utils/logger');
    createRendererLogger.mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
    });

    Object.defineProperty(document, 'hidden', {
      writable: true,
      configurable: true,
      value: false,
    });

    controller = null;
  });

  afterEach(() => {
    if (controller) {
      try { controller.dispose(); } catch (_) { /* already disposed */ }
    }
    jest.useRealTimers();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Constructor
  // ═══════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('creates instance with defaults', () => {
      controller = new MenuBadgeController();
      expect(controller).toBeInstanceOf(MenuBadgeController);
      expect(controller.endpoint).toBeNull();
      expect(controller.elements).toEqual({});
      expect(controller._timers).toEqual([]);
      expect(controller._settings).toBeNull();
    });

    it('accepts options', () => {
      const endpoint = createMockEndpoint();
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });
      expect(controller.endpoint).toBe(endpoint);
      expect(controller.elements).toBe(elements);
    });

    it('creates logger with name MenuBadgeController', () => {
      const { createRendererLogger } = require('../../../../src/renderer/shared/utils/logger');
      controller = new MenuBadgeController();
      expect(createRendererLogger).toHaveBeenCalledWith('MenuBadgeController');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // initialize()
  // ═══════════════════════════════════════════════════════════════════════

  describe('initialize()', () => {
    it('loads settings and refreshes all badges', async () => {
      const endpoint = createMockEndpoint();
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });

      await controller.initialize();

      expect(endpoint.getSettings).toHaveBeenCalledTimes(1);
      expect(endpoint.listIndexes).toHaveBeenCalledTimes(1);
      expect(endpoint.listAgentJobs).toHaveBeenCalledTimes(1);
    });

    it('starts polling after initialization', async () => {
      const endpoint = createMockEndpoint();
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });

      await controller.initialize();

      expect(controller._timers.length).toBeGreaterThan(0);
    });

    it('warns and returns early when no endpoint', async () => {
      controller = new MenuBadgeController();

      await controller.initialize();

      expect(controller.log.warn).toHaveBeenCalledWith('Endpoint not available for menu badges');
      expect(controller._timers).toEqual([]);
    });

    it('catches and logs errors during initialization', async () => {
      const endpoint = createMockEndpoint({
        getSettings: jest.fn().mockRejectedValue(new Error('network error')),
      });
      controller = new MenuBadgeController({ endpoint, elements: createElements() });

      await controller.initialize();

      expect(controller.log.warn).toHaveBeenCalledWith(
        'Failed to initialize menu badges:',
        expect.any(Error)
      );
    });

    it('catches settings load failure', async () => {
      const endpoint = createMockEndpoint({
        getSettings: jest.fn().mockResolvedValue({}), // missing agents.ui_polling
      });
      controller = new MenuBadgeController({ endpoint, elements: createElements() });

      await controller.initialize();

      expect(controller.log.warn).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _loadSettings()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_loadSettings()', () => {
    it('stores settings from endpoint', async () => {
      const settings = createSettings();
      const endpoint = createMockEndpoint({ getSettings: jest.fn().mockResolvedValue(settings) });
      controller = new MenuBadgeController({ endpoint });

      await controller._loadSettings();

      expect(controller._settings).toBe(settings);
    });

    it('throws when settings missing agents.ui_polling', async () => {
      const endpoint = createMockEndpoint({
        getSettings: jest.fn().mockResolvedValue({ agents: {} }),
      });
      controller = new MenuBadgeController({ endpoint });

      await expect(controller._loadSettings()).rejects.toThrow('Missing settings.agents.ui_polling');
    });

    it('throws when settings is null', async () => {
      const endpoint = createMockEndpoint({
        getSettings: jest.fn().mockResolvedValue(null),
      });
      controller = new MenuBadgeController({ endpoint });

      await expect(controller._loadSettings()).rejects.toThrow('Missing settings.agents.ui_polling');
    });

    it('logs warning on failure and rethrows', async () => {
      const endpoint = createMockEndpoint({
        getSettings: jest.fn().mockRejectedValue(new Error('fetch failed')),
      });
      controller = new MenuBadgeController({ endpoint });

      await expect(controller._loadSettings()).rejects.toThrow('fetch failed');
      expect(controller.log.warn).toHaveBeenCalledWith(
        'Failed to load badge polling settings:',
        expect.any(Error)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _getPollingIntervals()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_getPollingIntervals()', () => {
    it('returns polling intervals from settings', () => {
      controller = new MenuBadgeController();
      controller._settings = createSettings();

      const intervals = controller._getPollingIntervals();
      expect(intervals).toEqual({
        index: 60000,
        jobs: 30000,
      });
    });

    it('throws when settings not loaded', () => {
      controller = new MenuBadgeController();
      expect(() => controller._getPollingIntervals())
        .toThrow('Missing settings.agents.ui_polling for badge polling');
    });

    it('throws when interval values are undefined', () => {
      controller = new MenuBadgeController();
      controller._settings = {
        agents: {
          ui_polling: {
            index_health_poll_interval_ms: 1000,
            // missing jobs_poll_interval_ms
          },
        },
      };

      expect(() => controller._getPollingIntervals())
        .toThrow('Incomplete badge polling intervals in settings');
    });

    it('throws when interval values are non-numeric', () => {
      controller = new MenuBadgeController();
      controller._settings = {
        agents: {
          ui_polling: {
            index_health_poll_interval_ms: '1000',
            jobs_poll_interval_ms: 3000,
          },
        },
      };

      expect(() => controller._getPollingIntervals())
        .toThrow('Invalid badge polling interval types in settings');
    });

    it('accepts zero intervals', () => {
      controller = new MenuBadgeController();
      controller._settings = {
        agents: {
          ui_polling: {
            index_health_poll_interval_ms: 0,
            jobs_poll_interval_ms: 0,
          },
        },
      };

      const intervals = controller._getPollingIntervals();
      expect(intervals).toEqual({ index: 0, jobs: 0 });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _startPolling() / _stopPolling()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_startPolling()', () => {
    it('creates intervals for non-zero polling values', () => {
      const elements = createElements();
      controller = new MenuBadgeController({ elements });
      controller._settings = createSettings();

      controller._startPolling();

      expect(controller._timers.length).toBe(2);
    });

    it('skips intervals for zero polling values', () => {
      controller = new MenuBadgeController({ elements: createElements() });
      controller._settings = createSettings({
        ui_polling: {
          index_health_poll_interval_ms: 0,
          jobs_poll_interval_ms: 0,
        },
      });

      controller._startPolling();
      expect(controller._timers.length).toBe(0);
    });

    it('stops existing timers before starting new ones', () => {
      controller = new MenuBadgeController({ elements: createElements() });
      controller._settings = createSettings();

      controller._startPolling();
      expect(controller._timers.length).toBe(2);

      // Start again — old timers should be cleared first
      controller._startPolling();
      expect(controller._timers.length).toBe(2);
    });

    it('interval callbacks skip when document is hidden', () => {
      const endpoint = createMockEndpoint();
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });
      controller._settings = createSettings({
        ui_polling: {
          index_health_poll_interval_ms: 1000,
          jobs_poll_interval_ms: 1000,
        },
      });

      controller._startPolling();
      endpoint.listIndexes.mockClear();
      endpoint.listAgentJobs.mockClear();

      Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true });
      jest.advanceTimersByTime(1000);

      expect(endpoint.listIndexes).not.toHaveBeenCalled();
      expect(endpoint.listAgentJobs).not.toHaveBeenCalled();
    });

    it('interval callbacks execute when document is visible', () => {
      const endpoint = createMockEndpoint();
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });
      controller._settings = createSettings({
        ui_polling: {
          index_health_poll_interval_ms: 1000,
          jobs_poll_interval_ms: 1000,
        },
      });

      controller._startPolling();
      endpoint.listIndexes.mockClear();
      endpoint.listAgentJobs.mockClear();

      jest.advanceTimersByTime(1000);

      expect(endpoint.listIndexes).toHaveBeenCalledTimes(1);
      expect(endpoint.listAgentJobs).toHaveBeenCalledTimes(1);
    });
  });

  describe('_stopPolling()', () => {
    it('clears all timers', () => {
      controller = new MenuBadgeController({ elements: createElements() });
      controller._settings = createSettings();
      controller._startPolling();

      expect(controller._timers.length).toBe(2);
      controller._stopPolling();
      expect(controller._timers).toEqual([]);
    });

    it('is safe to call when no timers exist', () => {
      controller = new MenuBadgeController();
      expect(() => controller._stopPolling()).not.toThrow();
    });

    it('is safe to call twice', () => {
      controller = new MenuBadgeController({ elements: createElements() });
      controller._settings = createSettings();
      controller._startPolling();
      controller._stopPolling();
      expect(() => controller._stopPolling()).not.toThrow();
    });

    it('handles _timers being null', () => {
      controller = new MenuBadgeController();
      controller._timers = null;
      expect(() => controller._stopPolling()).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _refreshIndexBadge()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_refreshIndexBadge()', () => {
    it('sets badge to index count', async () => {
      const endpoint = createMockEndpoint({
        listIndexes: jest.fn().mockResolvedValue({ indexes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
      });
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });

      await controller._refreshIndexBadge();

      expect(elements.indexBadge.textContent).toBe('3');
      expect(elements.indexBadge.classList.contains('is-hidden')).toBe(false);
    });

    it('hides badge when count is 0', async () => {
      const endpoint = createMockEndpoint({
        listIndexes: jest.fn().mockResolvedValue({ indexes: [] }),
      });
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });

      await controller._refreshIndexBadge();

      expect(elements.indexBadge.textContent).toBe('');
      expect(elements.indexBadge.classList.contains('is-hidden')).toBe(true);
    });

    it('handles flat array response (no indexes key)', async () => {
      const endpoint = createMockEndpoint({
        listIndexes: jest.fn().mockResolvedValue([{ id: 'x' }]),
      });
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });

      await controller._refreshIndexBadge();

      expect(elements.indexBadge.textContent).toBe('1');
    });

    it('returns early when no indexBadge element', async () => {
      const endpoint = createMockEndpoint();
      controller = new MenuBadgeController({ endpoint, elements: {} });

      await controller._refreshIndexBadge(); // No crash
      expect(endpoint.listIndexes).not.toHaveBeenCalled();
    });

    it('returns early when no endpoint', async () => {
      const elements = createElements();
      controller = new MenuBadgeController({ elements });

      await controller._refreshIndexBadge(); // No crash
    });

    it('handles null response (falls back to empty array)', async () => {
      const endpoint = createMockEndpoint({
        listIndexes: jest.fn().mockResolvedValue(null),
      });
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });

      await controller._refreshIndexBadge();

      expect(elements.indexBadge.textContent).toBe('');
      expect(elements.indexBadge.classList.contains('is-hidden')).toBe(true);
    });

    it('logs warning on error', async () => {
      const endpoint = createMockEndpoint({
        listIndexes: jest.fn().mockRejectedValue(new Error('network')),
      });
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });

      await controller._refreshIndexBadge();

      expect(controller.log.warn).toHaveBeenCalledWith(
        'Failed to refresh index badge:',
        expect.any(Error)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _refreshJobsBadge()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_refreshJobsBadge()', () => {
    it('counts running jobs and sets badge', async () => {
      const endpoint = createMockEndpoint({
        listAgentJobs: jest.fn().mockResolvedValue({
          jobs: [
            { status: 'running' },
            { status: 'completed' },
            { status: 'in_progress' },
            { status: 'failed' },
            { status: 'processing' },
          ],
        }),
      });
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });

      await controller._refreshJobsBadge();

      expect(elements.jobsBadge.textContent).toBe('3');
    });

    it('hides badge when no running jobs', async () => {
      const endpoint = createMockEndpoint({
        listAgentJobs: jest.fn().mockResolvedValue({
          jobs: [{ status: 'completed' }, { status: 'failed' }],
        }),
      });
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });

      await controller._refreshJobsBadge();

      expect(elements.jobsBadge.textContent).toBe('');
      expect(elements.jobsBadge.classList.contains('is-hidden')).toBe(true);
    });

    it('handles items key in response', async () => {
      const endpoint = createMockEndpoint({
        listAgentJobs: jest.fn().mockResolvedValue({
          items: [{ status: 'running' }],
        }),
      });
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });

      await controller._refreshJobsBadge();

      expect(elements.jobsBadge.textContent).toBe('1');
    });

    it('handles null response (falls back to empty array)', async () => {
      const endpoint = createMockEndpoint({
        listAgentJobs: jest.fn().mockResolvedValue(null),
      });
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });

      await controller._refreshJobsBadge();

      expect(elements.jobsBadge.textContent).toBe('');
      expect(elements.jobsBadge.classList.contains('is-hidden')).toBe(true);
    });

    it('handles flat array response', async () => {
      const endpoint = createMockEndpoint({
        listAgentJobs: jest.fn().mockResolvedValue([{ status: 'running' }]),
      });
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });

      await controller._refreshJobsBadge();

      expect(elements.jobsBadge.textContent).toBe('1');
    });

    it('returns early when no jobsBadge element', async () => {
      const endpoint = createMockEndpoint();
      controller = new MenuBadgeController({ endpoint, elements: {} });

      await controller._refreshJobsBadge();
      expect(endpoint.listAgentJobs).not.toHaveBeenCalled();
    });

    it('logs warning on error', async () => {
      const endpoint = createMockEndpoint({
        listAgentJobs: jest.fn().mockRejectedValue(new Error('fail')),
      });
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });

      await controller._refreshJobsBadge();

      expect(controller.log.warn).toHaveBeenCalledWith(
        'Failed to refresh jobs badge:',
        expect.any(Error)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _countRunningJobs()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_countRunningJobs()', () => {
    beforeEach(() => {
      controller = new MenuBadgeController();
    });

    it('counts running status', () => {
      expect(controller._countRunningJobs([{ status: 'running' }])).toBe(1);
    });

    it('counts processing status', () => {
      expect(controller._countRunningJobs([{ status: 'processing' }])).toBe(1);
    });

    it('counts started status', () => {
      expect(controller._countRunningJobs([{ status: 'started' }])).toBe(1);
    });

    it('counts in_progress status', () => {
      expect(controller._countRunningJobs([{ status: 'in_progress' }])).toBe(1);
    });

    it('does not count completed status', () => {
      expect(controller._countRunningJobs([{ status: 'completed' }])).toBe(0);
    });

    it('does not count failed status', () => {
      expect(controller._countRunningJobs([{ status: 'failed' }])).toBe(0);
    });

    it('is case-insensitive', () => {
      expect(controller._countRunningJobs([{ status: 'RUNNING' }])).toBe(1);
      expect(controller._countRunningJobs([{ status: 'In_Progress' }])).toBe(1);
    });

    it('handles null/undefined jobs', () => {
      expect(controller._countRunningJobs(null)).toBe(0);
      expect(controller._countRunningJobs(undefined)).toBe(0);
    });

    it('handles empty array', () => {
      expect(controller._countRunningJobs([])).toBe(0);
    });

    it('handles jobs with missing status', () => {
      expect(controller._countRunningJobs([{}])).toBe(0);
      expect(controller._countRunningJobs([{ status: null }])).toBe(0);
    });

    it('handles mixed statuses', () => {
      const jobs = [
        { status: 'running' },
        { status: 'completed' },
        { status: 'processing' },
        { status: 'failed' },
        { status: 'in_progress' },
        { status: 'started' },
        { status: 'queued' },
      ];
      expect(controller._countRunningJobs(jobs)).toBe(4);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _setBadgeValue()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_setBadgeValue()', () => {
    beforeEach(() => {
      controller = new MenuBadgeController();
    });

    it('shows badge with count for positive values', () => {
      const el = createElement();
      controller._setBadgeValue(el, 5);

      expect(el.textContent).toBe('5');
      expect(el.classList.contains('is-hidden')).toBe(false);
    });

    it('hides badge for zero', () => {
      const el = createElement();
      controller._setBadgeValue(el, 0);

      expect(el.textContent).toBe('');
      expect(el.classList.contains('is-hidden')).toBe(true);
    });

    it('hides badge for negative values', () => {
      const el = createElement();
      controller._setBadgeValue(el, -1);

      expect(el.textContent).toBe('');
      expect(el.classList.contains('is-hidden')).toBe(true);
    });

    it('treats NaN as 0 (hidden)', () => {
      const el = createElement();
      controller._setBadgeValue(el, NaN);

      expect(el.textContent).toBe('');
      expect(el.classList.contains('is-hidden')).toBe(true);
    });

    it('treats Infinity as 0 (hidden)', () => {
      const el = createElement();
      controller._setBadgeValue(el, Infinity);

      expect(el.textContent).toBe('');
      expect(el.classList.contains('is-hidden')).toBe(true);
    });

    it('treats undefined as 0 (hidden)', () => {
      const el = createElement();
      controller._setBadgeValue(el, undefined);

      expect(el.textContent).toBe('');
      expect(el.classList.contains('is-hidden')).toBe(true);
    });

    it('does nothing when element is null', () => {
      expect(() => controller._setBadgeValue(null, 5)).not.toThrow();
    });

    it('removes is-hidden class when showing badge', () => {
      const el = createElement();
      el.classList.add('is-hidden');
      controller._setBadgeValue(el, 3);

      expect(el.classList.contains('is-hidden')).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // dispose()
  // ═══════════════════════════════════════════════════════════════════════

  describe('dispose()', () => {
    it('stops polling and nulls references', () => {
      const endpoint = createMockEndpoint();
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });
      controller._settings = createSettings();
      controller._startPolling();

      expect(controller._timers.length).toBe(2);

      controller.dispose();

      expect(controller._timers).toEqual([]);
      expect(controller._settings).toBeNull();
      expect(controller.endpoint).toBeNull();
      expect(controller.elements).toEqual({});
    });

    it('is safe to call twice', () => {
      controller = new MenuBadgeController();
      controller.dispose();
      expect(() => controller.dispose()).not.toThrow();
    });

    it('is safe to call on never-initialized instance', () => {
      controller = new MenuBadgeController();
      expect(() => controller.dispose()).not.toThrow();
    });

    // Quantitative: N timers created = M timers cleared
    it('lifecycle: N created = M cleared', () => {
      controller = new MenuBadgeController({ elements: createElements() });
      controller._settings = createSettings();

      const clearSpy = jest.spyOn(global, 'clearInterval');

      controller._startPolling();
      const timerCount = controller._timers.length;
      expect(timerCount).toBe(2);

      controller.dispose();

      expect(clearSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Full integration
  // ═══════════════════════════════════════════════════════════════════════

  describe('full integration', () => {
    it('initialize -> poll -> dispose lifecycle', async () => {
      const endpoint = createMockEndpoint({
        getSettings: jest.fn().mockResolvedValue(createSettings({
          ui_polling: {
            index_health_poll_interval_ms: 5000,
            jobs_poll_interval_ms: 5000,
          },
        })),
        listIndexes: jest.fn().mockResolvedValue({ indexes: [{ id: '1' }] }),
        listAgentJobs: jest.fn().mockResolvedValue({
          jobs: [{ status: 'running' }, { status: 'completed' }],
        }),
      });
      const elements = createElements();
      controller = new MenuBadgeController({ endpoint, elements });

      await controller.initialize();

      // Wait for async badge refresh
      await Promise.resolve();
      await Promise.resolve();

      expect(elements.indexBadge.textContent).toBe('1');
      expect(elements.jobsBadge.textContent).toBe('1');

      // Advance past index poll interval
      endpoint.listIndexes.mockResolvedValue({ indexes: [{ id: '1' }, { id: '2' }] });
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();

      expect(elements.indexBadge.textContent).toBe('2');

      controller.dispose();
      expect(controller._timers).toEqual([]);
      expect(controller.endpoint).toBeNull();
    });
  });
});
