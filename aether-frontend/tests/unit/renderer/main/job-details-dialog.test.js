'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSourceResultCreate = jest.fn(() => document.createElement('div'));
const mockSourceResultSetupListeners = jest.fn();

jest.mock(
  '../../../../src/renderer/main/modules/jobs/SourceResultDialog',
  () => jest.fn().mockImplementation(() => ({
    create: mockSourceResultCreate,
    setupListeners: mockSourceResultSetupListeners,
  }))
);

const JobDetailsDialog = require('../../../../src/renderer/main/modules/jobs/JobDetailsDialog');
const SourceResultDialog = require('../../../../src/renderer/main/modules/jobs/SourceResultDialog');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides = {}) {
  return {
    id: 'job-abc12345-6789-0def-ghij-klmnopqrstuv',
    agent_name: 'research_agent',
    status: 'completed',
    type: 'job',
    created_at: '2026-01-15T10:00:00Z',
    started_at: '2026-01-15T10:00:05Z',
    completed_at: '2026-01-15T10:01:30Z',
    content: {},
    results: null,
    metadata: {},
    ...overrides,
  };
}

function createDialog(jobOverrides = {}, configOverrides = {}) {
  const job = makeJob(jobOverrides);
  const onAction = configOverrides.onAction || jest.fn();
  const logger = configOverrides.logger || { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const endpoint = configOverrides.endpoint || {};
  const dialog = new JobDetailsDialog({ job, endpoint, logger, onAction });
  return { dialog, job, onAction, logger };
}

function createDialogManager() {
  return {
    trackListener: jest.fn((el, event, handler) => el?.addEventListener(event, handler)),
    close: jest.fn(),
    open: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JobDetailsDialog', () => {
  beforeEach(() => {
    SourceResultDialog.mockClear();
    mockSourceResultCreate.mockClear();
    mockSourceResultSetupListeners.mockClear();
  });

  // ── Constructor ──────────────────────────────────────────────────────

  describe('constructor', () => {
    test('stores config properties', () => {
      const { dialog, job } = createDialog();
      expect(dialog.job).toBe(job);
      expect(typeof dialog.onAction).toBe('function');
    });

    test('defaults logger to console', () => {
      const d = new JobDetailsDialog({ job: makeJob() });
      expect(d.logger).toBe(console);
    });

    test('defaults onAction to no-op', () => {
      const d = new JobDetailsDialog({ job: makeJob() });
      d.onAction(); // should not throw
    });

    test('throws without job', () => {
      expect(() => new JobDetailsDialog({})).toThrow('Job object is required');
    });

    test('initializes _dialogElement to null', () => {
      const { dialog } = createDialog();
      expect(dialog._dialogElement).toBeNull();
    });
  });

  // ── Utility methods ──────────────────────────────────────────────────

  describe('_formatAgentLabel()', () => {
    test('converts snake_case to Title Case', () => {
      const { dialog } = createDialog();
      expect(dialog._formatAgentLabel('research_agent')).toBe('Research Agent');
    });

    test('handles empty/falsy values', () => {
      const { dialog } = createDialog();
      expect(dialog._formatAgentLabel('')).toBe('Unknown');
      expect(dialog._formatAgentLabel(null)).toBe('Unknown');
    });
  });

  describe('_formatShortId()', () => {
    test('truncates long IDs', () => {
      const { dialog } = createDialog();
      const long = 'abc12345-6789-0def-ghij-klmnopqrstuv';
      const short = dialog._formatShortId(long);
      expect(short.length).toBeLessThan(long.length);
      expect(short).toContain('...');
    });

    test('preserves short IDs', () => {
      const { dialog } = createDialog();
      expect(dialog._formatShortId('abc123')).toBe('abc123');
    });

    test('returns "-" for empty/dash', () => {
      const { dialog } = createDialog();
      expect(dialog._formatShortId('-')).toBe('-');
      expect(dialog._formatShortId('')).toBe('-');
      expect(dialog._formatShortId(null)).toBe('-');
    });
  });

  describe('_getStatusIcon()', () => {
    test('maps known statuses to icons', () => {
      const { dialog } = createDialog();
      expect(dialog._getStatusIcon('completed')).toBe('fa-check-circle');
      expect(dialog._getStatusIcon('running')).toContain('fa-spinner');
      expect(dialog._getStatusIcon('processing')).toContain('fa-spinner');
      expect(dialog._getStatusIcon('failed')).toBe('fa-exclamation-circle');
      expect(dialog._getStatusIcon('pending')).toBe('fa-clock');
      expect(dialog._getStatusIcon('cancelled')).toBe('fa-ban');
    });

    test('returns question icon for unknown status', () => {
      const { dialog } = createDialog();
      expect(dialog._getStatusIcon('weird')).toBe('fa-question-circle');
    });
  });

  describe('_getSourceIcon()', () => {
    test('maps source names to icons', () => {
      const { dialog } = createDialog();
      expect(dialog._getSourceIcon('web_search')).toBe('fa-globe');
      expect(dialog._getSourceIcon('news_api')).toBe('fa-newspaper');
      expect(dialog._getSourceIcon('reddit')).toBe('fa-reddit');
      expect(dialog._getSourceIcon('local_files')).toBe('fa-folder-open');
      expect(dialog._getSourceIcon('file_search')).toBe('fa-file-alt');
      expect(dialog._getSourceIcon('database')).toBe('fa-database');
    });
  });

  describe('_formatDuration()', () => {
    test('handles sub-second', () => {
      const { dialog } = createDialog();
      expect(dialog._formatDuration(500)).toBe('500ms');
    });

    test('handles seconds', () => {
      const { dialog } = createDialog();
      expect(dialog._formatDuration(5000)).toBe('5.0s');
      expect(dialog._formatDuration(30500)).toBe('30.5s');
    });

    test('handles minutes', () => {
      const { dialog } = createDialog();
      expect(dialog._formatDuration(90000)).toBe('1m 30s');
      expect(dialog._formatDuration(120000)).toBe('2m 0s');
    });

    test('handles zero/negative/null', () => {
      const { dialog } = createDialog();
      expect(dialog._formatDuration(0)).toBe('0s');
      expect(dialog._formatDuration(-100)).toBe('0s');
      expect(dialog._formatDuration(null)).toBe('0s');
    });
  });

  describe('_formatTimestamp()', () => {
    test('formats valid date', () => {
      const { dialog } = createDialog();
      const result = dialog._formatTimestamp('2026-01-15T10:00:00Z');
      expect(result).toBeTruthy();
      expect(result).not.toBe('—');
    });

    test('returns dash for falsy values', () => {
      const { dialog } = createDialog();
      expect(dialog._formatTimestamp(null)).toBe('—');
      expect(dialog._formatTimestamp('')).toBe('—');
    });

    test('returns string for invalid date', () => {
      const { dialog } = createDialog();
      expect(dialog._formatTimestamp('not-a-date')).toBe('not-a-date');
    });
  });

  describe('_escapeHtml()', () => {
    test('escapes HTML entities', () => {
      const { dialog } = createDialog();
      const result = dialog._escapeHtml('<script>alert(1)</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });
  });

  // ── _renderJobActions ────────────────────────────────────────────────

  describe('_renderJobActions()', () => {
    test('shows CANCEL for active jobs', () => {
      const { dialog } = createDialog();
      for (const status of ['pending', 'running', 'processing']) {
        const html = dialog._renderJobActions({ status, id: 'j1' });
        expect(html).toContain('CANCEL');
        expect(html).toContain('data-action="job-cancel"');
        expect(html).toContain('data-job-id="j1"');
      }
    });

    test('shows DELETE for finished jobs', () => {
      const { dialog } = createDialog();
      for (const status of ['completed', 'failed', 'cancelled']) {
        const html = dialog._renderJobActions({ status, id: 'j2' });
        expect(html).toContain('DELETE');
        expect(html).toContain('data-action="job-delete"');
      }
    });

    test('returns empty for unknown status', () => {
      const { dialog } = createDialog();
      expect(dialog._renderJobActions({ status: 'weird' })).toBe('');
    });

    test('uses job_id fallback', () => {
      const { dialog } = createDialog();
      const html = dialog._renderJobActions({ status: 'completed', job_id: 'alt-id' });
      expect(html).toContain('data-job-id="alt-id"');
    });
  });

  // ── create ───────────────────────────────────────────────────────────

  describe('create()', () => {
    test('returns a DOM element with tool-dialog class', () => {
      const { dialog } = createDialog();
      const el = dialog.create();
      expect(el).toBeInstanceOf(HTMLElement);
      expect(el.className).toContain('tool-dialog');
    });

    test('stores element in _dialogElement', () => {
      const { dialog } = createDialog();
      const el = dialog.create();
      expect(dialog._dialogElement).toBe(el);
    });

    test('renders agent label from agent_name', () => {
      const { dialog } = createDialog({ agent_name: 'research_scout' });
      const el = dialog.create();
      expect(el.textContent).toContain('Research Scout');
    });

    test('falls back to agent field', () => {
      const { dialog } = createDialog({ agent_name: null, agent: 'testing_agent' });
      const el = dialog.create();
      expect(el.textContent).toContain('Testing Agent');
    });

    test('renders status badge', () => {
      const { dialog } = createDialog({ status: 'completed' });
      const el = dialog.create();
      expect(el.querySelector('.status-completed')).not.toBeNull();
      expect(el.textContent).toContain('completed');
    });

    test('renders short job ID', () => {
      const { dialog } = createDialog({ id: 'abc12345-very-long-id-suffix' });
      const el = dialog.create();
      expect(el.querySelector('.mono-text')).not.toBeNull();
    });

    test('renders timeline with created_at', () => {
      const { dialog } = createDialog({ created_at: '2026-01-15T10:00:00Z' });
      const el = dialog.create();
      expect(el.textContent).toContain('Created');
    });

    test('renders started_at step for type=job', () => {
      const { dialog } = createDialog({ type: 'job', started_at: '2026-01-15T10:00:05Z' });
      const el = dialog.create();
      expect(el.textContent).toContain('Started');
    });

    test('omits started_at for non-job type', () => {
      const { dialog } = createDialog({ type: 'notification', started_at: '2026-01-15T10:00:05Z' });
      const el = dialog.create();
      // Started should not appear (type !== 'job')
      const steps = Array.from(el.querySelectorAll('.timeline-stage')).map(s => s.textContent);
      expect(steps).not.toContain('Started');
    });

    test('renders completed_at step when different from created_at', () => {
      const { dialog } = createDialog({
        created_at: '2026-01-15T10:00:00Z',
        completed_at: '2026-01-15T10:01:00Z',
      });
      const el = dialog.create();
      expect(el.textContent).toContain('Completed');
    });

    test('omits completed_at when same as created_at', () => {
      const { dialog } = createDialog({
        created_at: '2026-01-15T10:00:00Z',
        completed_at: '2026-01-15T10:00:00Z',
      });
      const el = dialog.create();
      const steps = Array.from(el.querySelectorAll('.timeline-stage')).map(s => s.textContent);
      expect(steps).not.toContain('Completed');
    });

    test('renders duration when time_ms is available', () => {
      const { dialog } = createDialog({ time_ms: 5000 });
      const el = dialog.create();
      expect(el.textContent).toContain('Duration');
      expect(el.textContent).toContain('5.0s');
    });

    test('renders model when model_used is available', () => {
      const { dialog } = createDialog({ model_used: 'gpt-4' });
      const el = dialog.create();
      expect(el.textContent).toContain('Model');
      expect(el.textContent).toContain('gpt-4');
    });

    test('renders "Awaiting results" for running job with no results', () => {
      const { dialog } = createDialog({ status: 'running', results: null });
      const el = dialog.create();
      expect(el.textContent).toContain('Awaiting results');
    });

    test('renders "No detailed findings" for completed job with no results', () => {
      const { dialog } = createDialog({ status: 'completed', results: null, content: {} });
      const el = dialog.create();
      expect(el.textContent).toContain('No detailed findings');
    });
  });

  // ── _renderResultsGrid ───────────────────────────────────────────────

  describe('_renderResultsGrid()', () => {
    test('returns empty string for null', () => {
      const { dialog } = createDialog();
      expect(dialog._renderResultsGrid(null)).toBe('');
    });

    test('renders research results with sources', () => {
      const { dialog } = createDialog();
      const results = {
        results: {
          web_search: { results: [{ title: 'A' }, { title: 'B' }] },
          news_api: { results: [{ title: 'C' }] },
        },
        sources_used: ['web_search', 'news_api'],
      };
      const html = dialog._renderResultsGrid(results);
      expect(html).toContain('web_search');
      expect(html).toContain('news_api');
      expect(html).toContain('2 Findings');
      expect(html).toContain('1 Findings');
    });

    test('renders fallback for unrecognized structure', () => {
      const { dialog } = createDialog();
      const results = { someRandomKey: 'data' };
      const html = dialog._renderResultsGrid(results);
      expect(html).toContain('no detailed findings');
    });

    test('handles source with answer but no items', () => {
      const { dialog } = createDialog();
      const results = {
        results: {
          perplexity: { answer: 'Some AI answer', results: [] },
        },
        sources_used: ['perplexity'],
      };
      const html = dialog._renderResultsGrid(results);
      expect(html).toContain('perplexity');
      expect(html).toContain('1 Findings');
    });

    test('skips sources with no items and no answer', () => {
      const { dialog } = createDialog();
      const results = {
        results: {
          empty_source: {},
        },
        sources_used: ['empty_source'],
      };
      const html = dialog._renderResultsGrid(results);
      expect(html).not.toContain('empty_source');
    });

    test('handles source using items array', () => {
      const { dialog } = createDialog();
      const results = {
        results: {
          web_search: { items: [{ title: 'A' }] },
        },
        sources_used: ['web_search'],
      };
      const html = dialog._renderResultsGrid(results);
      expect(html).toContain('1 Findings');
    });

    test('handles source using sources array', () => {
      const { dialog } = createDialog();
      const results = {
        results: {
          local: { sources: [{ path: '/a' }, { path: '/b' }] },
        },
        sources_used: ['local'],
      };
      const html = dialog._renderResultsGrid(results);
      expect(html).toContain('2 Findings');
    });

    test('derives sources from results keys when sources_used absent', () => {
      const { dialog } = createDialog();
      const results = {
        results: {
          web_search: { results: [{ title: 'A' }] },
        },
      };
      const html = dialog._renderResultsGrid(results);
      expect(html).toContain('web_search');
    });
  });

  // ── setupListeners ───────────────────────────────────────────────────

  describe('setupListeners()', () => {
    test('does nothing without _dialogElement', () => {
      const { dialog } = createDialog();
      const dm = createDialogManager();
      dialog.setupListeners(dm); // Should not throw
      expect(dm.trackListener).not.toHaveBeenCalled();
    });

    test('registers close and overlay listeners', () => {
      const { dialog } = createDialog({ status: 'completed' });
      dialog.create();
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      // At minimum: close button + overlay + action buttons
      expect(dm.trackListener.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    test('close button calls dialogManager.close', () => {
      const { dialog } = createDialog();
      dialog.create();
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      const closeBtn = dialog._dialogElement.querySelector('.tool-dialog-close');
      closeBtn.click();

      expect(dm.close).toHaveBeenCalled();
    });

    test('overlay click calls dialogManager.close', () => {
      const { dialog } = createDialog();
      dialog.create();
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      const overlay = dialog._dialogElement.querySelector('.tool-dialog-overlay');
      overlay.click();

      expect(dm.close).toHaveBeenCalled();
    });

    test('action buttons call onAction with action and jobId', async () => {
      const { dialog, onAction } = createDialog({
        status: 'completed',
        id: 'test-job-id',
      });
      dialog.create();
      const dm = createDialogManager();
      dialog.setupListeners(dm);

      const deleteBtn = dialog._dialogElement.querySelector('[data-action="job-delete"]');
      if (deleteBtn) {
        const mockEvent = {
          stopPropagation: jest.fn(),
          preventDefault: jest.fn(),
          stopImmediatePropagation: jest.fn(),
        };
        // Find the handler registered for this button
        const call = dm.trackListener.mock.calls.find(c => c[0] === deleteBtn);
        if (call) {
          await call[2](mockEvent);
          expect(onAction).toHaveBeenCalledWith('job-delete', 'test-job-id');
        }
      }
    });
  });

  // ── Sub-dialog openers ───────────────────────────────────────────────

  describe('_openSourceDetailDialog()', () => {
    test('creates SourceResultDialog with source data', () => {
      const { dialog } = createDialog({
        results: {
          results: { web_search: { results: [{ title: 'A' }] } },
        },
      });
      const dm = createDialogManager();
      dialog._openSourceDetailDialog('web_search', dm);

      expect(SourceResultDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'web_search',
          data: expect.objectContaining({ results: [{ title: 'A' }] }),
        })
      );
      expect(dm.open).toHaveBeenCalled();
    });

    test('returns early when no results', () => {
      const { dialog } = createDialog({ results: null });
      const dm = createDialogManager();
      dialog._openSourceDetailDialog('web', dm);
      expect(SourceResultDialog).not.toHaveBeenCalled();
    });

    test('returns early when source block not found', () => {
      const { dialog } = createDialog({
        results: { results: { other: {} } },
      });
      const dm = createDialogManager();
      dialog._openSourceDetailDialog('nonexistent', dm);
      expect(SourceResultDialog).not.toHaveBeenCalled();
    });
  });

});
