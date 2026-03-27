/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */

'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

const mockAether = { logger: mockLog };

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => mockAether,
}));

const mockToast = {
  success: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn(),
};
jest.mock('../../../../src/renderer/shared/components/Toast', () => mockToast);

const mockConfirmDialog = { confirm: jest.fn().mockResolvedValue(true) };
jest.mock('../../../../src/renderer/shared/components/ConfirmDialog', () => mockConfirmDialog);

const mockDialogManager = {
  isOpen: jest.fn(() => false),
  open: jest.fn(),
  close: jest.fn(),
  cleanup: jest.fn(),
};

jest.mock(
  '../../../../src/renderer/main/modules/agents/components/dialogs/DialogManager',
  () => jest.fn(() => mockDialogManager),
);

const mockJobDetailsCreate = jest.fn(() => document.createElement('div'));
const mockJobDetailsSetupListeners = jest.fn();
jest.mock(
  '../../../../src/renderer/main/modules/jobs/JobDetailsDialog',
  () => jest.fn().mockImplementation(() => ({
    create: mockJobDetailsCreate,
    setupListeners: mockJobDetailsSetupListeners,
  })),
);

const JobHistoryModal = require('../../../../src/renderer/main/modules/jobs/JobHistoryModal');
const ConfirmDialog = require('../../../../src/renderer/shared/components/ConfirmDialog');
const JobDetailsDialog = require('../../../../src/renderer/main/modules/jobs/JobDetailsDialog');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEndpoint(overrides = {}) {
  return {
    getSettings: jest.fn().mockResolvedValue({
      agents: { ui_polling: { jobs_poll_interval_ms: 5000 } },
    }),
    listAgentConfigs: jest.fn().mockResolvedValue([
      { agent_name: 'research', execution_trigger: 'on_demand' },
      { agent_name: 'testing', execution_trigger: 'on_demand' },
    ]),
    api: {
      get: jest.fn().mockResolvedValue({
        history: [
          { id: 'job-1', agent_name: 'research', status: 'completed', created_at: '2026-01-01T00:00:00Z', metadata: { query: 'test query' } },
          { id: 'job-2', agent_name: 'testing', status: 'running', created_at: '2026-01-01T01:00:00Z' },
        ],
      }),
    },
    cancelAgentJob: jest.fn().mockResolvedValue({}),
    retryAgentJob: jest.fn().mockResolvedValue({}),
    deleteAgentJob: jest.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function makeJob(overrides = {}) {
  return {
    id: 'job-abc',
    agent_name: 'research',
    status: 'completed',
    created_at: '2026-01-15T12:00:00Z',
    metadata: { query: 'sample query' },
    ...overrides,
  };
}

function createModal(endpointOverrides = {}) {
  const endpoint = makeEndpoint(endpointOverrides);
  const modal = new JobHistoryModal({ endpoint });
  return { modal, endpoint };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobHistoryModal', () => {

  afterEach(() => {
    // Clean up any modals left in DOM
    document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
    jest.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Constructor / Wiring
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    test('sets default properties', () => {
      const { modal } = createModal();
      expect(modal.jobs).toEqual([]);
      expect(modal.agents).toEqual([]);
      expect(modal._listeners).toEqual([]);
      expect(modal._timers).toEqual([]);
      expect(modal._pollTimer).toBeNull();
      expect(modal._pollInFlight).toBe(false);
      expect(modal.filters).toEqual({ agentName: '', query: '' });
    });

    test('uses provided endpoint', () => {
      const endpoint = makeEndpoint();
      const modal = new JobHistoryModal({ endpoint });
      expect(modal.endpoint).toBe(endpoint);
    });


    test('uses custom id and size', () => {
      const modal = new JobHistoryModal({
        id: 'custom-id',
        size: 'md',
        heightPreset: 'compact',
        endpoint: makeEndpoint(),
      });
      expect(modal.id).toBe('custom-id');
      expect(modal.size).toBe('md');
      expect(modal.heightPreset).toBe('compact');
    });
  });

  // -----------------------------------------------------------------------
  // show()
  // -----------------------------------------------------------------------

  describe('show()', () => {
    test('throws toast error when endpoint is missing', async () => {
      const modal = new JobHistoryModal({});
      modal.endpoint = null;
      await modal.show();
      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Failed to load jobs'));
    });

    test('does not re-open if already open', async () => {
      const { modal, endpoint } = createModal();
      modal.isOpen = true;
      await modal.show();
      expect(endpoint.getSettings).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _fetchAgents()
  // -----------------------------------------------------------------------

  describe('_fetchAgents()', () => {
    test('filters to on_demand and tool agents only', async () => {
      const { modal, endpoint } = createModal();
      endpoint.listAgentConfigs.mockResolvedValue([
        { agent_name: 'research', execution_trigger: 'background' }, // research is always included via TOOL_AGENT_NAMES
        { agent_name: 'testing', execution_trigger: 'on_demand' }, // testing should be excluded by "Hide legacy redundant agents from dropdown" condition `if (name === 'testing') return false;`
        { agent_name: 'aether_rag', execution_trigger: 'background' }, // aether_rag should be excluded as not on_demand and not in TOOL_AGENT_NAMES
        { agent_name: 'new_tool', execution_trigger: 'on_demand' }, // newly added on_demand agent should be included
      ]);
      await modal._fetchAgents();
      const names = modal.agents.map((a) => a.agent_name);
      expect(names).toContain('research'); // Included because it's in TOOL_AGENT_NAMES
      expect(names).not.toContain('testing'); // Excluded because of hardcoded legacy exclusion
      expect(names).not.toContain('aether_rag'); // Excluded because it's background and not in TOOL_AGENT_NAMES
      expect(names).toContain('new_tool'); // Included because it's on_demand
    });

    test('handles null response from listAgentConfigs', async () => {
      const { modal, endpoint } = createModal();
      endpoint.listAgentConfigs.mockResolvedValue(null);
      await modal._fetchAgents();
      expect(modal.agents).toEqual([]);
    });

    test('throws on API failure', async () => {
      const { modal, endpoint } = createModal();
      endpoint.listAgentConfigs.mockRejectedValue(new Error('Network'));
      await expect(modal._fetchAgents()).rejects.toThrow('Network');
    });
  });

  // -----------------------------------------------------------------------
  // _fetchJobs()
  // -----------------------------------------------------------------------

  describe('_fetchJobs()', () => {
    test('fetches and filters jobs by allowed agents', async () => {
      const { modal, endpoint } = createModal();
      modal.agents = [{ agent_name: 'research' }];
      endpoint.api.get.mockResolvedValue({
        history: [
          { id: '1', agent_name: 'research', status: 'completed' },
          { id: '2', agent_name: 'unknown_agent', status: 'completed' },
          { id: '3', entity_type: 'system', agent_name: 'research' },
        ],
      });
      await modal._fetchJobs();
      expect(modal.jobs).toHaveLength(1);
      expect(modal.jobs[0].id).toBe('1');
    });

    test('excludes system entity_type jobs', async () => {
      const { modal, endpoint } = createModal();
      modal.agents = [];
      endpoint.api.get.mockResolvedValue({
        history: [
          { id: '1', agent_name: 'research', entity_type: 'system' },
          { id: '2', agent_name: 'research', status: 'completed' },
        ],
      });
      await modal._fetchJobs();
      expect(modal.jobs).toHaveLength(1);
      expect(modal.jobs[0].id).toBe('2');
    });

    test('applies agent name filter to API call', async () => {
      const { modal, endpoint } = createModal();
      modal.agents = [{ agent_name: 'research' }];
      modal.filters.agentName = 'research';
      await modal._fetchJobs();
      expect(endpoint.api.get).toHaveBeenCalledWith(
        expect.stringContaining('&agent_name=research'),
      );
    });

    test('sets lastUpdatedAt on successful fetch', async () => {
      const { modal } = createModal();
      modal.agents = [];
      expect(modal.lastUpdatedAt).toBeNull();
      await modal._fetchJobs();
      expect(modal.lastUpdatedAt).toBeInstanceOf(Date);
    });
  });

  // -----------------------------------------------------------------------
  // _applyQueryFilter()
  // -----------------------------------------------------------------------

  describe('_applyQueryFilter()', () => {
    test('returns all jobs when query is empty', () => {
      const { modal } = createModal();
      const jobs = [makeJob({ id: '1' }), makeJob({ id: '2' })];
      expect(modal._applyQueryFilter(jobs, '')).toEqual(jobs);
      expect(modal._applyQueryFilter(jobs, null)).toEqual(jobs);
      expect(modal._applyQueryFilter(jobs, undefined)).toEqual(jobs);
    });

    test('filters by job id', () => {
      const { modal } = createModal();
      const jobs = [makeJob({ id: 'abc' }), makeJob({ id: 'xyz' })];
      const result = modal._applyQueryFilter(jobs, 'abc');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('abc');
    });

    test('filters by status', () => {
      const { modal } = createModal();
      const jobs = [
        makeJob({ id: '1', status: 'completed' }),
        makeJob({ id: '2', status: 'running' }),
      ];
      const result = modal._applyQueryFilter(jobs, 'running');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('2');
    });

    test('filters case-insensitively', () => {
      const { modal } = createModal();
      const jobs = [makeJob({ id: 'ABC-123' })];
      expect(modal._applyQueryFilter(jobs, 'abc')).toHaveLength(1);
      expect(modal._applyQueryFilter(jobs, 'ABC')).toHaveLength(1);
    });

    test('handles null/undefined jobs array', () => {
      const { modal } = createModal();
      expect(modal._applyQueryFilter(null, 'test')).toEqual([]);
      expect(modal._applyQueryFilter(undefined, 'test')).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // _formatRelativeTime()
  // -----------------------------------------------------------------------

  describe('_formatRelativeTime()', () => {
    test('returns "just now" for recent dates', () => {
      const { modal } = createModal();
      const now = new Date();
      expect(modal._formatRelativeTime(now)).toBe('just now');
    });

    test('returns minutes for recent dates', () => {
      const { modal } = createModal();
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      expect(modal._formatRelativeTime(fiveMinAgo)).toBe('5m ago');
    });

    test('returns hours for older dates', () => {
      const { modal } = createModal();
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      expect(modal._formatRelativeTime(threeHoursAgo)).toBe('3h ago');
    });

    test('returns days for very old dates', () => {
      const { modal } = createModal();
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      expect(modal._formatRelativeTime(fiveDaysAgo)).toBe('5d ago');
    });

    test('handles invalid date string', () => {
      const { modal } = createModal();
      expect(modal._formatRelativeTime('not-a-date')).toBe('not-a-date');
    });

    test('handles null — coerces to epoch', () => {
      const { modal } = createModal();
      // new Date(null) creates epoch (Jan 1 1970), which is a valid date
      const result = modal._formatRelativeTime(null);
      expect(result).toMatch(/d ago$/);
    });

    test('handles undefined — returns em dash', () => {
      const { modal } = createModal();
      // new Date(undefined) creates Invalid Date
      expect(modal._formatRelativeTime(undefined)).toBe('—');
    });
  });

  // -----------------------------------------------------------------------
  // _formatTimestamp()
  // -----------------------------------------------------------------------

  describe('_formatTimestamp()', () => {
    test('formats valid date', () => {
      const { modal } = createModal();
      const result = modal._formatTimestamp('2026-01-15T12:00:00Z');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    test('handles invalid date', () => {
      const { modal } = createModal();
      expect(modal._formatTimestamp('invalid')).toBe('invalid');
    });

    test('handles null — coerces to epoch', () => {
      const { modal } = createModal();
      // new Date(null) creates epoch (valid date), not Invalid Date
      const result = modal._formatTimestamp(null);
      expect(typeof result).toBe('string');
      expect(result).toContain('1970');
    });

    test('handles undefined — returns em dash', () => {
      const { modal } = createModal();
      expect(modal._formatTimestamp(undefined)).toBe('—');
    });
  });

  // -----------------------------------------------------------------------
  // _formatShortId()
  // -----------------------------------------------------------------------

  describe('_formatShortId()', () => {
    test('returns short IDs unchanged', () => {
      const { modal } = createModal();
      expect(modal._formatShortId('abc')).toBe('abc');
    });

    test('truncates long IDs', () => {
      const { modal } = createModal();
      const result = modal._formatShortId('abcdefghijklmnop');
      expect(result).toBe('abcdefgh…');
      expect(result.length).toBe(9); // 8 chars + ellipsis
    });

    test('returns dash for falsy input', () => {
      const { modal } = createModal();
      expect(modal._formatShortId(null)).toBe('-');
      expect(modal._formatShortId('')).toBe('-');
    });
  });

  // -----------------------------------------------------------------------
  // _getStatusIcon()
  // -----------------------------------------------------------------------

  describe('_getStatusIcon()', () => {
    test('returns correct icons for all statuses', () => {
      const { modal } = createModal();
      expect(modal._getStatusIcon('completed')).toBe('fa-check-circle');
      expect(modal._getStatusIcon('running')).toBe('fa-spinner fa-spin');
      expect(modal._getStatusIcon('processing')).toBe('fa-spinner fa-spin');
      expect(modal._getStatusIcon('failed')).toBe('fa-exclamation-circle');
      expect(modal._getStatusIcon('pending')).toBe('fa-clock');
      expect(modal._getStatusIcon('cancelled')).toBe('fa-ban');
      expect(modal._getStatusIcon('weird')).toBe('fa-question-circle');
    });
  });

  // -----------------------------------------------------------------------
  // _resolveJobAgentName() / _resolveJobLabel()
  // -----------------------------------------------------------------------

  describe('_resolveJobAgentName()', () => {
    test('returns agent_name directly', () => {
      const { modal } = createModal();
      expect(modal._resolveJobAgentName({ agent_name: 'research' })).toBe('research');
    });

    test('falls back to agent property', () => {
      const { modal } = createModal();
      expect(modal._resolveJobAgentName({ agent: 'testing' })).toBe('testing');
    });

    test('extracts from job_type with agent_ prefix', () => {
      const { modal } = createModal();
      expect(modal._resolveJobAgentName({ job_type: 'agent_research_task' })).toBe('research');
    });

    test('returns empty for null input', () => {
      const { modal } = createModal();
      expect(modal._resolveJobAgentName(null)).toBe('');
    });
  });

  describe('_formatAgentLabel()', () => {
    test('capitalizes and replaces underscores', () => {
      const { modal } = createModal();
      expect(modal._formatAgentLabel('research_agent')).toBe('Research Agent');
    });

    test('returns Unknown for falsy input', () => {
      const { modal } = createModal();
      expect(modal._formatAgentLabel('')).toBe('Unknown');
      expect(modal._formatAgentLabel(null)).toBe('Unknown');
    });
  });

  // -----------------------------------------------------------------------
  // _getAgentIcon()
  // -----------------------------------------------------------------------

  describe('_getAgentIcon()', () => {
    test('returns correct icons by agent name', () => {
      const { modal } = createModal();
      expect(modal._getAgentIcon({ agent_name: 'research' })).toBe('fa-globe');
      expect(modal._getAgentIcon({ agent_name: 'indexer' })).toBe('fa-database');
      expect(modal._getAgentIcon({ agent_name: 'other' })).toBe('fa-microchip');
    });
  });

  // -----------------------------------------------------------------------
  // _escapeHtml()
  // -----------------------------------------------------------------------

  describe('_escapeHtml()', () => {
    test('escapes HTML via textContent/innerHTML', () => {
      const { modal } = createModal();
      expect(modal._escapeHtml('<b>bold</b>')).toBe('&lt;b&gt;bold&lt;/b&gt;');
    });

    test('handles empty string', () => {
      const { modal } = createModal();
      expect(modal._escapeHtml('')).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // _renderJobs()
  // -----------------------------------------------------------------------

  describe('_renderJobs()', () => {
    test('renders empty state when no jobs', () => {
      const { modal } = createModal();
      modal.jobs = [];
      const html = modal._renderJobs();
      expect(html).toContain('jobs-empty');
      expect(html).toContain('No jobs yet');
    });

    test('renders job items with correct data attributes', () => {
      const { modal } = createModal();
      modal.jobs = [makeJob({ id: 'job-123', status: 'completed' })];
      const html = modal._renderJobs();
      expect(html).toContain('data-job-id="job-123"');
      expect(html).toContain('status-completed');
    });

    test('renders delete button for terminal statuses', () => {
      const { modal } = createModal();
      modal.jobs = [makeJob({ status: 'completed' })];
      const html = modal._renderJobs();
      expect(html).toContain('data-action="job-delete"');
    });

    test('does not render delete button for active statuses', () => {
      const { modal } = createModal();
      modal.jobs = [makeJob({ status: 'running' })];
      const html = modal._renderJobs();
      expect(html).not.toContain('data-action="job-delete"');
    });

    test('renders query from metadata', () => {
      const { modal } = createModal();
      modal.jobs = [makeJob({ metadata: { query: 'search term' } })];
      const html = modal._renderJobs();
      expect(html).toContain('search term');
    });

    test('uses job_id fallback when id missing', () => {
      const { modal } = createModal();
      modal.jobs = [{ job_id: 'fallback-id', agent_name: 'research', status: 'completed' }];
      const html = modal._renderJobs();
      expect(html).toContain('data-job-id="fallback-id"');
    });
  });

  // -----------------------------------------------------------------------
  // _renderFilters()
  // -----------------------------------------------------------------------

  describe('_renderFilters()', () => {
    test('renders agent filter options', () => {
      const { modal } = createModal();
      modal.agents = [{ agent_name: 'research' }, { agent_name: 'testing' }];
      const html = modal._renderFilters();
      expect(html).toContain('jobs-filter-agent');
      expect(html).toContain('research');
      expect(html).toContain('testing');
      expect(html).toContain('All tools');
    });

    test('marks current agent filter as selected', () => {
      const { modal } = createModal();
      modal.agents = [{ agent_name: 'research' }];
      modal.filters.agentName = 'research';
      const html = modal._renderFilters();
      expect(html).toContain('selected');
    });
  });

  // -----------------------------------------------------------------------
  // _getPollingInterval()
  // -----------------------------------------------------------------------

  describe('_getPollingInterval()', () => {
    test('returns interval from settings', () => {
      const { modal } = createModal();
      modal.settings = { agents: { ui_polling: { jobs_poll_interval_ms: 3000 } } };
      expect(modal._getPollingInterval()).toBe(3000);
    });

    test('throws when settings are missing', () => {
      const { modal } = createModal();
      modal.settings = null;
      expect(() => modal._getPollingInterval()).toThrow('Missing settings');
    });

    test('throws when interval is not a number', () => {
      const { modal } = createModal();
      modal.settings = { agents: { ui_polling: { jobs_poll_interval_ms: 'bad' } } };
      expect(() => modal._getPollingInterval()).toThrow('Invalid');
    });
  });

  // -----------------------------------------------------------------------
  // _startPolling()
  // -----------------------------------------------------------------------

  describe('_startPolling()', () => {
    test('creates interval and tracks in _timers', () => {
      const { modal } = createModal();
      modal.settings = { agents: { ui_polling: { jobs_poll_interval_ms: 5000 } } };
      modal._startPolling();
      expect(modal._timers).toHaveLength(1);
      expect(modal._pollTimer).not.toBeNull();
      // Clean up
      modal._clearTimers();
    });

    test('does not create interval when interval is 0', () => {
      const { modal } = createModal();
      modal.settings = { agents: { ui_polling: { jobs_poll_interval_ms: 0 } } };
      modal._startPolling();
      expect(modal._timers).toHaveLength(0);
    });

    test('poll skips when _pollInFlight is true', async () => {
      jest.useFakeTimers();
      const { modal, endpoint } = createModal();
      modal.settings = { agents: { ui_polling: { jobs_poll_interval_ms: 100 } } };
      modal.agents = [];
      // Set up bodyEl with list element for _refreshList
      modal.bodyEl.innerHTML = '<div class="jobs-history-list"></div>';

      modal._startPolling();
      modal._pollInFlight = true;

      jest.advanceTimersByTime(200);
      // Wait for any micro-tasks
      await Promise.resolve();

      // _fetchJobs should not have been called because _pollInFlight was true
      expect(endpoint.api.get).not.toHaveBeenCalled();

      modal._clearTimers();
      jest.useRealTimers();
    });

    test('poll resets _pollInFlight on error', async () => {
      jest.useFakeTimers();
      const { modal, endpoint } = createModal();
      modal.settings = { agents: { ui_polling: { jobs_poll_interval_ms: 100 } } };
      modal.agents = [];
      modal.bodyEl.innerHTML = '<div class="jobs-history-list"></div>';

      endpoint.api.get.mockRejectedValueOnce(new Error('poll fail'));
      modal._startPolling();

      jest.advanceTimersByTime(150);
      // Wait for the async callback to settle
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(modal._pollInFlight).toBe(false);

      modal._clearTimers();
      jest.useRealTimers();
    });
  });

  // -----------------------------------------------------------------------
  // Listener tracking
  // -----------------------------------------------------------------------

  describe('_trackListener / _clearListeners', () => {
    test('tracks and clears listeners', () => {
      const { modal } = createModal();
      const el = document.createElement('div');
      const handler = jest.fn();
      const addSpy = jest.spyOn(el, 'addEventListener');
      const removeSpy = jest.spyOn(el, 'removeEventListener');

      modal._trackListener(el, 'click', handler);
      expect(addSpy).toHaveBeenCalledWith('click', handler, undefined);
      expect(modal._listeners).toHaveLength(1);

      modal._clearListeners();
      expect(removeSpy).toHaveBeenCalledWith('click', handler, undefined);
      expect(modal._listeners).toHaveLength(0);
    });

    test('ignores null element', () => {
      const { modal } = createModal();
      modal._trackListener(null, 'click', jest.fn());
      expect(modal._listeners).toHaveLength(0);
    });

    test('ignores null event', () => {
      const { modal } = createModal();
      modal._trackListener(document.createElement('div'), null, jest.fn());
      expect(modal._listeners).toHaveLength(0);
    });

    test('ignores null handler', () => {
      const { modal } = createModal();
      modal._trackListener(document.createElement('div'), 'click', null);
      expect(modal._listeners).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // _clearTimers()
  // -----------------------------------------------------------------------

  describe('_clearTimers()', () => {
    test('clears all tracked intervals', () => {
      const { modal } = createModal();
      const spy = jest.spyOn(global, 'clearInterval');
      modal._timers = [100, 200, 300];
      modal._clearTimers();
      expect(spy).toHaveBeenCalledTimes(3);
      expect(spy).toHaveBeenCalledWith(100);
      expect(spy).toHaveBeenCalledWith(200);
      expect(spy).toHaveBeenCalledWith(300);
      expect(modal._timers).toEqual([]);
      spy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // close() / _cleanup()
  // -----------------------------------------------------------------------

  describe('close()', () => {
    test('clears listeners and timers on close', () => {
      const { modal } = createModal();
      modal.isOpen = true;
      const el = document.createElement('div');
      modal._trackListener(el, 'click', jest.fn());
      modal._timers = [setInterval(() => {}, 99999)];

      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      modal.close();

      expect(modal._listeners).toEqual([]);
      expect(modal._timers).toEqual([]);
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    test('no-ops when not open', () => {
      const { modal } = createModal();
      modal.isOpen = false;
      const clearSpy = jest.spyOn(modal, '_clearListeners');
      modal.close();
      expect(clearSpy).not.toHaveBeenCalled();
    });
  });

  describe('_cleanup()', () => {
    test('clears listeners, timers, jobs, and dialog manager', () => {
      const { modal } = createModal();
      modal.jobs = [makeJob()];
      modal._timers = [42];
      modal._listeners = [{ element: document.createElement('div'), event: 'click', handler: jest.fn() }];

      modal._cleanup();

      expect(modal.jobs).toEqual([]);
      expect(modal._timers).toEqual([]);
      expect(modal._listeners).toEqual([]);
      expect(mockDialogManager.cleanup).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _handleJobAction()
  // -----------------------------------------------------------------------

  describe('_handleJobAction()', () => {
    test('job-delete confirms before deletion', async () => {
      const { modal, endpoint } = createModal();
      modal.agents = [];
      ConfirmDialog.confirm.mockResolvedValue(true);

      await modal._handleJobAction('job-delete', 'job-1');

      expect(ConfirmDialog.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Delete job', variant: 'danger' }),
      );
      expect(endpoint.deleteAgentJob).toHaveBeenCalledWith('job-1');
      expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('deleted'));
    });

    test('job-delete aborts when user cancels', async () => {
      const { modal, endpoint } = createModal();
      modal.agents = [];
      ConfirmDialog.confirm.mockResolvedValue(false);

      await modal._handleJobAction('job-delete', 'job-1');

      expect(endpoint.deleteAgentJob).not.toHaveBeenCalled();
    });

    test('job-delete closes dialog manager if open', async () => {
      const { modal } = createModal();
      modal.agents = [];
      ConfirmDialog.confirm.mockResolvedValue(true);
      mockDialogManager.isOpen.mockReturnValue(true);

      await modal._handleJobAction('job-delete', 'job-1');

      expect(mockDialogManager.close).toHaveBeenCalled();
    });

    test('job-delete shows error toast on failure', async () => {
      const { modal, endpoint } = createModal();
      modal.agents = [];
      ConfirmDialog.confirm.mockResolvedValue(true);
      endpoint.deleteAgentJob.mockRejectedValue(new Error('Delete failed'));

      await modal._handleJobAction('job-delete', 'job-1');

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Failed to delete'));
    });

    test('job-cancel confirms and calls cancelAgentJob', async () => {
      const { modal, endpoint } = createModal();
      modal.agents = [];
      ConfirmDialog.confirm.mockResolvedValue(true);

      await modal._handleJobAction('job-cancel', 'job-1');

      expect(endpoint.cancelAgentJob).toHaveBeenCalledWith('job-1');
    });

    test('job-retry confirms and calls retryAgentJob', async () => {
      const { modal, endpoint } = createModal();
      modal.agents = [];
      ConfirmDialog.confirm.mockResolvedValue(true);

      await modal._handleJobAction('job-retry', 'job-1');

      expect(endpoint.retryAgentJob).toHaveBeenCalledWith('job-1');
    });
  });

  // -----------------------------------------------------------------------
  // setAgentFilter()
  // -----------------------------------------------------------------------

  describe('setAgentFilter()', () => {
    test('sets agent filter value', () => {
      const { modal } = createModal();
      modal.setAgentFilter('research');
      expect(modal.filters.agentName).toBe('research');
    });

    test('ignores falsy value', () => {
      const { modal } = createModal();
      modal.filters.agentName = 'existing';
      modal.setAgentFilter('');
      expect(modal.filters.agentName).toBe('existing');
    });
  });

  // -----------------------------------------------------------------------
  // showJobDetailsById()
  // -----------------------------------------------------------------------

  describe('showJobDetailsById()', () => {
    test('no-ops when jobId is falsy', async () => {
      const { modal } = createModal();
      await modal.showJobDetailsById(null);
      expect(JobDetailsDialog).not.toHaveBeenCalled();
    });

    test('finds job in _allJobs and shows details', async () => {
      const { modal } = createModal();
      const job = makeJob({ id: 'found-job' });
      modal._allJobs = [job];

      await modal.showJobDetailsById('found-job');

      expect(JobDetailsDialog).toHaveBeenCalledWith(
        expect.objectContaining({ job }),
      );
      expect(mockDialogManager.open).toHaveBeenCalled();
    });

    test('fetches from status endpoint when not in _allJobs', async () => {
      const { modal, endpoint } = createModal();
      modal._allJobs = [];
      const fetchedJob = makeJob({ job_id: 'remote-job' });
      endpoint.api.get.mockResolvedValue(fetchedJob);

      await modal.showJobDetailsById('remote-job');

      expect(endpoint.api.get).toHaveBeenCalledWith('/v1/agent/status/remote-job');
      expect(JobDetailsDialog).toHaveBeenCalled();
    });

    test('shows warning toast when job not found anywhere', async () => {
      const { modal, endpoint } = createModal();
      modal._allJobs = [];
      endpoint.api.get.mockRejectedValue(new Error('Not found'));

      await modal.showJobDetailsById('missing-job');

      expect(mockToast.warning).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });
  });

  // -----------------------------------------------------------------------
  // _renderContent()
  // -----------------------------------------------------------------------

  describe('_renderContent()', () => {
    test('shows skeleton first, then renders jobs on success', async () => {
      const { modal, endpoint } = createModal();
      endpoint.getSettings.mockResolvedValue({
        agents: { ui_polling: { jobs_poll_interval_ms: 0 } },
      });

      await modal._renderContent();

      // After successful render, should have jobs-history (not skeleton)
      expect(modal.bodyEl.innerHTML).toContain('jobs-history');
    });

    test('shows error state on fetch failure', async () => {
      const { modal, endpoint } = createModal();
      endpoint.getSettings.mockRejectedValue(new Error('Settings fail'));

      await modal._renderContent();

      expect(modal.bodyEl.innerHTML).toContain('Failed to Load Jobs');
      expect(modal.bodyEl.innerHTML).toContain('modal-empty-state');
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle quantitative proof
  // -----------------------------------------------------------------------

  describe('lifecycle: quantitative resource tracking', () => {
    test('N listeners created = M listeners removed on close', async () => {
      const { modal, endpoint } = createModal();
      endpoint.getSettings.mockResolvedValue({
        agents: { ui_polling: { jobs_poll_interval_ms: 0 } },
      });

      await modal._renderContent();
      modal._setupEventListeners();

      const N = modal._listeners.length;
      expect(N).toBeGreaterThan(0);

      modal._clearListeners();
      expect(modal._listeners).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // BUG REGRESSION: _refreshList() preserves topbar listeners
  // -----------------------------------------------------------------------

  describe('BUG REGRESSION: _refreshList preserves topbar listeners', () => {
    test('agentFilter change handler still fires after _refreshList', async () => {
      const { modal, endpoint } = createModal();
      endpoint.getSettings.mockResolvedValue({
        agents: { ui_polling: { jobs_poll_interval_ms: 0 } },
      });
      modal.agents = [{ agent_name: 'research' }];

      // Render content (creates DOM with topbar + list)
      await modal._renderContent();
      modal._setupEventListeners();

      // Capture reference to the filter element BEFORE refresh
      const agentFilterBefore = modal.bodyEl.querySelector('.jobs-filter-agent');
      expect(agentFilterBefore).not.toBeNull();

      // Simulate poll refresh — only list innerHTML should change
      modal.jobs = [makeJob({ id: 'new-job', status: 'running' })];
      modal._refreshList();

      // Verify filter element is the SAME DOM node (not replaced)
      const agentFilterAfter = modal.bodyEl.querySelector('.jobs-filter-agent');
      expect(agentFilterAfter).toBe(agentFilterBefore);

      // Verify the listener still works — dispatch change event
      agentFilterAfter.value = 'research';
      agentFilterAfter.dispatchEvent(new Event('change', { bubbles: true }));

      // Wait for async handler
      await Promise.resolve();
      await Promise.resolve();

      expect(modal.filters.agentName).toBe('research');
    });

    test('queryFilter input handler still fires after _refreshList', async () => {
      const { modal, endpoint } = createModal();
      endpoint.getSettings.mockResolvedValue({
        agents: { ui_polling: { jobs_poll_interval_ms: 0 } },
      });
      modal.agents = [{ agent_name: 'research' }];

      await modal._renderContent();
      modal._setupEventListeners();

      const queryFilterBefore = modal.bodyEl.querySelector('.jobs-filter-query');
      expect(queryFilterBefore).not.toBeNull();

      // Refresh list (simulates poll tick)
      modal.jobs = [makeJob({ id: 'updated-job' })];
      modal._refreshList();

      // Verify filter element is the SAME DOM node
      const queryFilterAfter = modal.bodyEl.querySelector('.jobs-filter-query');
      expect(queryFilterAfter).toBe(queryFilterBefore);

      // Verify the listener still works — dispatch input event
      // Use Object.defineProperty since jsdom input value doesn't trigger events
      queryFilterAfter.value = 'search term';
      queryFilterAfter.dispatchEvent(new Event('input', { bubbles: true }));

      expect(modal.filters.query).toBe('search term');
    });

    test('job list content IS updated by _refreshList', async () => {
      const { modal, endpoint } = createModal();
      endpoint.getSettings.mockResolvedValue({
        agents: { ui_polling: { jobs_poll_interval_ms: 0 } },
      });
      modal.agents = [{ agent_name: 'research' }];

      await modal._renderContent();

      const list = modal.bodyEl.querySelector('.jobs-history-list');
      expect(list).not.toBeNull();
      const htmlBefore = list.innerHTML;

      // Change jobs data and refresh
      modal.jobs = [makeJob({ id: 'brand-new-job', status: 'failed' })];
      modal._refreshList();

      const htmlAfter = list.innerHTML;
      expect(htmlAfter).not.toBe(htmlBefore);
      expect(htmlAfter).toContain('brand-new-job');
      expect(htmlAfter).toContain('status-failed');
    });

    test('topbar is NOT re-rendered by _refreshList (DOM identity preserved)', async () => {
      const { modal, endpoint } = createModal();
      endpoint.getSettings.mockResolvedValue({
        agents: { ui_polling: { jobs_poll_interval_ms: 0 } },
      });
      modal.agents = [{ agent_name: 'research' }];

      await modal._renderContent();

      // Capture topbar DOM reference
      const topbar = modal.bodyEl.querySelector('.jobs-topbar');
      expect(topbar).not.toBeNull();

      modal._refreshList();

      // Topbar must be the same DOM node (not replaced)
      const topbarAfter = modal.bodyEl.querySelector('.jobs-topbar');
      expect(topbarAfter).toBe(topbar);
    });
  });
});
