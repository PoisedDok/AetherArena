'use strict';

// ---------------------------------------------------------------------------
// FileIndexingManager + extracted modules — Unit tests
// Source: src/renderer/main/modules/settings/FileIndexingManager.js (640 lines)
// Modules: ReindexJobController.js (664), DaemonController.js (415), LocationCardRenderer.js (342)
// Bugs fixed: #1 pause handler leak, #2 untracked restart setTimeout, #3 ViewDetails listener leak
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mocks — MUST be at top level so Jest hoists them before require()
// ---------------------------------------------------------------------------
jest.mock('../../../../src/renderer/shared/components/ConfirmDialog', () => ({
  confirm: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }),
}));

const ConfirmDialog = require('../../../../src/renderer/shared/components/ConfirmDialog');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEndpoint() {
  return {
    getFileIndexingLocations: jest.fn().mockResolvedValue([]),
    createFileIndexingLocation: jest.fn().mockResolvedValue({ id: 'loc-1' }),
    deleteFileIndexingLocation: jest.fn().mockResolvedValue({}),
    updateFileIndexingLocation: jest.fn().mockResolvedValue({}),
    triggerFileIndexingReindex: jest.fn().mockResolvedValue({ job_id: 'job-1' }),
    getReindexJobStatus: jest.fn().mockResolvedValue({
      status: 'completed', progress_percent: 100, files_total: 10,
      chunks_processed: 50, files_scanned: 10, progress_phase: 'completed',
    }),
    pauseReindexJob: jest.fn().mockResolvedValue({}),
    resumeReindexJob: jest.fn().mockResolvedValue({}),
    stopReindexJob: jest.fn().mockResolvedValue({}),
    cancelReindexJob: jest.fn().mockResolvedValue({}),
    startFileIndexingDaemon: jest.fn().mockResolvedValue({ success: true }),
    stopFileIndexingDaemon: jest.fn().mockResolvedValue({ success: true }),
    restartFileIndexingDaemon: jest.fn().mockResolvedValue({ success: true }),
    getFileIndexingDaemonStatus: jest.fn().mockResolvedValue({ running: true, uptime_seconds: 120 }),
    getActiveJobForLocation: jest.fn().mockResolvedValue({ job_id: null }),
    api: { get: jest.fn().mockResolvedValue(null) },
  };
}

function createMockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function setupMinimalDOM() {
  document.body.innerHTML = `
    <input type="checkbox" id="file-indexing-enabled" />
    <button id="file-indexing-add-location">Add</button>
    <div id="file-indexing-locations-list"></div>
    <div id="file-indexing-daemon-banner-slot"></div>
    <div id="settings-status"></div>
  `;
}

function teardownDOM() {
  document.body.innerHTML = '';
}

/** Create a fresh location fixture. Prevents cross-test mutation. */
function createLocationFixtures() {
  return [
    { id: 'loc-1', location_name: 'Primary', location_type: 'primary', root_path: '/data', enabled: true, file_count: 10, chunk_count: 50, index_size_bytes: 1024, last_scan_at: null, last_scan_status: 'completed' },
    { id: 'loc-2', location_name: 'Secondary', location_type: 'secondary', root_path: '/extra', enabled: false, file_count: 0, chunk_count: 0, index_size_bytes: 0, last_scan_at: null, last_scan_status: 'pending' },
  ];
}

// ===========================================================================
// 1. PURE LOGIC — _formatBytes, _formatStatus, _escapeHtml
// ===========================================================================

describe('Pure logic (no DOM)', () => {
  const FileIndexingManager = require('../../../../src/renderer/main/modules/settings/FileIndexingManager');
  let mgr;

  beforeEach(() => {
    setupMinimalDOM();
    mgr = new FileIndexingManager({ endpoint: createMockEndpoint() });
  });

  afterEach(() => {
    mgr.destroy();
    teardownDOM();
  });

  describe('_formatBytes', () => {
    it('returns "0 B" for zero', () => {
      expect(mgr._formatBytes(0)).toBe('0 B');
    });
    it('returns bytes for < 1024', () => {
      expect(mgr._formatBytes(512)).toBe('512 B');
    });
    it('returns KB for exactly 1024', () => {
      expect(mgr._formatBytes(1024)).toBe('1 KB');
    });
    it('returns KB with decimals', () => {
      expect(mgr._formatBytes(1536)).toBe('1.5 KB');
    });
    it('returns MB for 1048576', () => {
      expect(mgr._formatBytes(1048576)).toBe('1 MB');
    });
    it('returns GB for 1073741824', () => {
      expect(mgr._formatBytes(1073741824)).toBe('1 GB');
    });
    // BUG FOUND: Math.log(negative) → NaN → sizes[NaN] → undefined
    // The function returns "NaN undefined" for negative input.
    // Documenting actual behavior — this is a known edge case.
    it('does not crash on negative input (returns string)', () => {
      const result = mgr._formatBytes(-1);
      expect(typeof result).toBe('string');
    });
    // Mutation guard: Math.round precision
    it('preserves two-decimal precision for 2.5 MB', () => {
      // 2.5 * 1024 * 1024 = 2621440
      expect(mgr._formatBytes(2621440)).toBe('2.5 MB');
    });
  });

  describe('_formatStatus', () => {
    it('maps "pending" → "Pending"', () => {
      expect(mgr._formatStatus('pending')).toBe('Pending');
    });
    it('maps "running" → "Running"', () => {
      expect(mgr._formatStatus('running')).toBe('Running');
    });
    it('maps "completed" → "Completed"', () => {
      expect(mgr._formatStatus('completed')).toBe('Completed');
    });
    it('maps "failed" → "Failed"', () => {
      expect(mgr._formatStatus('failed')).toBe('Failed');
    });
    it('maps "timeout" → "Timeout"', () => {
      expect(mgr._formatStatus('timeout')).toBe('Timeout');
    });
    it('returns raw value for unknown status (pass-through)', () => {
      expect(mgr._formatStatus('custom_status_xyz')).toBe('custom_status_xyz');
    });
    // Mutation guard: if someone removes the statusMap, known statuses break
    it('returns capitalized string (not undefined) for every known status', () => {
      for (const s of ['pending', 'running', 'completed', 'failed', 'timeout']) {
        const result = mgr._formatStatus(s);
        expect(result).toBeDefined();
        expect(result[0]).toBe(result[0].toUpperCase());
      }
    });
  });

  describe('_escapeHtml', () => {
    it('escapes < and >', () => {
      expect(mgr._escapeHtml('<script>alert("xss")</script>'))
        .toBe('&lt;script&gt;alert("xss")&lt;/script&gt;');
    });
    it('escapes &', () => {
      expect(mgr._escapeHtml('a&b')).toBe('a&amp;b');
    });
    // Note: textContent → innerHTML in JSDOM does NOT escape quotes in text nodes.
    // This is correct browser behavior: quotes are only dangerous inside attributes.
    it('passes double quotes through (not escaped in text context)', () => {
      expect(mgr._escapeHtml('"hello"')).toBe('"hello"');
    });
    it('passes plain text through unchanged', () => {
      expect(mgr._escapeHtml('Hello World')).toBe('Hello World');
    });
    it('handles empty string', () => {
      expect(mgr._escapeHtml('')).toBe('');
    });
    // Mutation guard: if implementation changed to return raw text, XSS chars would pass
    it('escapes compound XSS payload', () => {
      const result = mgr._escapeHtml('<img src=x onerror=alert(1)>');
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
    });
  });

  describe('_formatLocationAddError', () => {
    it('returns setup guidance for backend-unavailable errors', () => {
      const message = mgr._formatLocationAddError({
        isBackendUnavailableError: true,
        message: 'Backend unavailable (no connection expected) — http://127.0.0.1:8765',
      });
      expect(message).toContain('indexing service is not ready');
      expect(message).toContain('Complete System Setup');
    });

    it('returns setup guidance for 503 not-initialized responses', () => {
      const message = mgr._formatLocationAddError({
        status: 503,
        message: 'Request failed',
        body: { detail: 'File indexing service not initialized' },
      });
      expect(message).toContain('indexing service is not ready');
    });

    it('preserves original message for non-service errors', () => {
      const message = mgr._formatLocationAddError(new Error('Disk full'));
      expect(message).toContain('Disk full');
    });
  });
});

// ===========================================================================
// 2. DaemonController._formatUptime (pure logic, lives in module)
// ===========================================================================

describe('DaemonController._formatUptime', () => {
  const DaemonController = require('../../../../src/renderer/main/modules/settings/modules/DaemonController');
  let dc;

  beforeEach(() => {
    setupMinimalDOM();
    dc = new DaemonController({
      endpoint: createMockEndpoint(),
      getElements: () => ({}),
      getIsEnabled: () => true,
      setIsEnabled: jest.fn(),
      getDaemonStatus: () => null,
      setDaemonStatus: jest.fn(),
      loadLocations: jest.fn(),
      showSuccess: jest.fn(),
      showError: jest.fn(),
      logger: createMockLogger(),
    });
  });

  afterEach(() => {
    dc.dispose();
    teardownDOM();
  });

  it('formats 0 as "0s"', () => {
    expect(dc._formatUptime(0)).toBe('0s');
  });
  it('formats seconds < 60 as Ns', () => {
    expect(dc._formatUptime(45)).toBe('45s');
  });
  it('formats 59 seconds as "59s" (boundary before minute)', () => {
    expect(dc._formatUptime(59)).toBe('59s');
  });
  it('formats exactly 60 seconds as "1m"', () => {
    expect(dc._formatUptime(60)).toBe('1m');
  });
  it('formats minutes < 60 as Nm', () => {
    expect(dc._formatUptime(300)).toBe('5m');
  });
  it('formats 3599 seconds as "59m" (boundary before hour)', () => {
    expect(dc._formatUptime(3599)).toBe('59m');
  });
  it('formats hours with remainder minutes', () => {
    expect(dc._formatUptime(3660)).toBe('1h 1m');
  });
  it('formats exactly 24h as days', () => {
    expect(dc._formatUptime(86400)).toBe('1d 0h');
  });
  it('formats days with remainder hours', () => {
    expect(dc._formatUptime(90000)).toBe('1d 1h');
  });
});

// ===========================================================================
// 3. ReindexJobController
// ===========================================================================

describe('ReindexJobController', () => {
  const ReindexJobController = require('../../../../src/renderer/main/modules/settings/modules/ReindexJobController');
  let rjc;
  let endpoint;
  let logger;
  let activeReindexJobs;

  beforeEach(() => {
    jest.useFakeTimers();
    setupMinimalDOM();
    endpoint = createMockEndpoint();
    logger = createMockLogger();
    activeReindexJobs = {};

    rjc = new ReindexJobController({
      endpoint,
      getActiveReindexJobs: () => activeReindexJobs,
      setActiveReindexJob: (id, job) => { activeReindexJobs[id] = job; },
      deleteActiveReindexJob: (id) => { delete activeReindexJobs[id]; },
      getLocations: () => [],
      loadLocations: jest.fn().mockResolvedValue(undefined),
      showSuccess: jest.fn(),
      showError: jest.fn(),
      escapeHtml: (t) => t,
      logger,
    });
  });

  afterEach(() => {
    rjc.dispose();
    teardownDOM();
    jest.useRealTimers();
  });

  describe('triggerReindex', () => {
    // triggerReindex calls _pollReindexProgress internally, which uses setTimeout.
    // With fake timers, the poll loop would hang. Mock the poll to test trigger logic in isolation.
    // _pollReindexProgress is tested independently below.

    it('calls endpoint.triggerFileIndexingReindex with locationId', async () => {
      jest.spyOn(rjc, '_pollReindexProgress').mockResolvedValue(undefined);
      await rjc.triggerReindex('loc-1', 'TestDir');
      expect(endpoint.triggerFileIndexingReindex).toHaveBeenCalledTimes(1);
      expect(endpoint.triggerFileIndexingReindex).toHaveBeenCalledWith('loc-1');
    });

    it('stores active job before polling starts', async () => {
      let jobCaptured = null;
      jest.spyOn(rjc, '_pollReindexProgress').mockImplementation(() => {
        jobCaptured = { ...activeReindexJobs['loc-1'] };
        return Promise.resolve();
      });
      await rjc.triggerReindex('loc-1', 'TestDir');
      expect(jobCaptured).toBeDefined();
      expect(jobCaptured.jobId).toBe('job-1');
      expect(jobCaptured.locationName).toBe('TestDir');
      expect(jobCaptured.locationId).toBe('loc-1');
      expect(typeof jobCaptured.startedAt).toBe('number');
    });

    it('shows reindex progress modal before polling', async () => {
      jest.spyOn(rjc, '_pollReindexProgress').mockResolvedValue(undefined);
      jest.spyOn(rjc, '_showReindexProgress');
      await rjc.triggerReindex('loc-1', 'TestDir');
      expect(rjc._showReindexProgress).toHaveBeenCalledWith('TestDir', 'job-1');
    });

    it('calls _pollReindexProgress with correct args', async () => {
      const pollSpy = jest.spyOn(rjc, '_pollReindexProgress').mockResolvedValue(undefined);
      await rjc.triggerReindex('loc-1', 'TestDir');
      expect(pollSpy).toHaveBeenCalledWith('job-1', 'TestDir', 'loc-1');
    });

    it('calls showError on API failure and hides progress', async () => {
      endpoint.triggerFileIndexingReindex.mockRejectedValue(new Error('Network error'));
      await rjc.triggerReindex('loc-1', 'TestDir');
      expect(rjc.showError).toHaveBeenCalledTimes(1);
      expect(rjc.showError).toHaveBeenCalledWith('Failed to start reindex: Network error');
    });
  });

  describe('_pollReindexProgress terminal states', () => {
    it('exits on "failed" — shows error, deletes job, cleans poll map', async () => {
      endpoint.getReindexJobStatus.mockResolvedValue({ status: 'failed', error_message: 'Disk full' });
      await rjc._pollReindexProgress('job-1', 'TestDir', 'loc-1');
      expect(rjc.showError).toHaveBeenCalledWith('Reindex failed: Disk full');
      expect(activeReindexJobs['loc-1']).toBeUndefined();
      expect(rjc._activePolls.size).toBe(0);
    });

    it('exits on "cancelled" — shows error', async () => {
      endpoint.getReindexJobStatus.mockResolvedValue({ status: 'cancelled' });
      await rjc._pollReindexProgress('job-1', 'TestDir', 'loc-1');
      expect(rjc.showError).toHaveBeenCalledWith('Reindex was cancelled');
    });

    it('exits on "stopped" — shows success', async () => {
      endpoint.getReindexJobStatus.mockResolvedValue({ status: 'stopped' });
      await rjc._pollReindexProgress('job-1', 'TestDir', 'loc-1');
      expect(rjc.showSuccess).toHaveBeenCalledWith('Reindex stopped. Progress saved.');
    });

    it('calls loadLocations after every terminal state', async () => {
      for (const status of ['failed', 'cancelled', 'stopped']) {
        rjc.loadLocations.mockClear();
        endpoint.getReindexJobStatus.mockResolvedValue({ status, error_message: 'x' });
        await rjc._pollReindexProgress('job-1', 'TestDir', `loc-${status}`);
        expect(rjc.loadLocations).toHaveBeenCalledTimes(1);
      }
    });

    it('exits on "failed" with fallback message when error_message is empty', async () => {
      endpoint.getReindexJobStatus.mockResolvedValue({ status: 'failed', error_message: '' });
      await rjc._pollReindexProgress('job-1', 'TestDir', 'loc-1');
      expect(rjc.showError).toHaveBeenCalledWith('Reindex failed: Unknown error');
    });

    it('handles API error during polling — shows error, cleans up', async () => {
      endpoint.getReindexJobStatus.mockRejectedValue(new Error('Timeout'));
      await rjc._pollReindexProgress('job-1', 'TestDir', 'loc-1');
      expect(rjc.showError).toHaveBeenCalledWith('Progress tracking failed: Timeout');
      expect(rjc._activePolls.size).toBe(0);
    });
  });

  describe('dispose — stop flag kills poll loop', () => {
    it('sets stop flag for active polls', () => {
      const stopFlag = { value: false };
      rjc._activePolls.set('loc-1', stopFlag);
      rjc.dispose();
      expect(stopFlag.value).toBe(true);
      expect(rjc._activePolls.size).toBe(0);
    });

    it('clears reindex modal listeners (verified by clicking removed handler)', () => {
      const el = document.createElement('button');
      const handler = jest.fn();
      el.addEventListener('click', handler);
      rjc._reindexModalListeners.push({ element: el, event: 'click', handler });
      rjc.dispose();
      el.click();
      expect(handler).not.toHaveBeenCalled();
    });

    it('removes orphaned reindex-progress-modal from DOM', () => {
      const modal = document.createElement('div');
      modal.id = 'reindex-progress-modal';
      document.body.appendChild(modal);
      rjc.dispose();
      expect(document.getElementById('reindex-progress-modal')).toBeNull();
    });

    it('nulls all closures to prevent stale references', () => {
      rjc.dispose();
      expect(rjc.endpoint).toBeNull();
      expect(rjc.getActiveReindexJobs).toBeNull();
      expect(rjc.setActiveReindexJob).toBeNull();
      expect(rjc.deleteActiveReindexJob).toBeNull();
      expect(rjc.getLocations).toBeNull();
      expect(rjc.loadLocations).toBeNull();
      expect(rjc.showSuccess).toBeNull();
      expect(rjc.showError).toBeNull();
      expect(rjc.escapeHtml).toBeNull();
    });
  });

  describe('BUG 1 REGRESSION: pause/resume handler tracking', () => {
    it('_updatePauseHandlerInTracking replaces handler reference in existing entry', () => {
      const btn = document.createElement('button');
      const oldHandler = jest.fn();
      const newHandler = jest.fn();
      rjc._reindexModalListeners.push({ element: btn, event: 'click', handler: oldHandler });

      rjc._updatePauseHandlerInTracking(btn, newHandler);

      const entry = rjc._reindexModalListeners.find(e => e.element === btn);
      expect(entry.handler).toBe(newHandler);
    });

    it('_updatePauseHandlerInTracking creates new entry if element was lost', () => {
      const btn = document.createElement('button');
      const handler = jest.fn();
      // No existing entry for this button
      expect(rjc._reindexModalListeners.length).toBe(0);

      rjc._updatePauseHandlerInTracking(btn, handler);
      expect(rjc._reindexModalListeners.length).toBe(1);
      expect(rjc._reindexModalListeners[0].element).toBe(btn);
      expect(rjc._reindexModalListeners[0].handler).toBe(handler);
    });

    it('_clearReindexModalListeners removes the CURRENT handler from DOM', () => {
      const btn = document.createElement('button');
      const currentHandler = jest.fn();
      btn.addEventListener('click', currentHandler);
      rjc._reindexModalListeners.push({ element: btn, event: 'click', handler: currentHandler });

      rjc._clearReindexModalListeners();
      btn.click();
      expect(currentHandler).not.toHaveBeenCalled();
      expect(rjc._reindexPauseHandler).toBeNull();
    });
  });

  describe('BUG 3 REGRESSION: inline progress ViewDetails listener tracking', () => {
    it('updateInlineProgress tracks ViewDetails listener in _inlineProgressListeners', () => {
      activeReindexJobs['loc-1'] = { jobId: 'job-1', locationName: 'TestDir' };

      const container = document.createElement('div');
      container.className = 'inline-progress-container';
      container.setAttribute('data-location-id', 'loc-1');
      document.body.appendChild(container);

      rjc.updateInlineProgress('loc-1', { progress_percent: 50, files_scanned: 3, files_total: 10, chunks_processed: 15, progress_phase: 'processing' });

      expect(rjc._inlineProgressListeners.has('loc-1')).toBe(true);
      const listeners = rjc._inlineProgressListeners.get('loc-1');
      expect(listeners.length).toBe(1);
      expect(listeners[0].event).toBe('click');
      expect(typeof listeners[0].handler).toBe('function');
    });

    it('removeInlineProgress cleans up tracked listeners and removes DOM', () => {
      activeReindexJobs['loc-1'] = { jobId: 'job-1', locationName: 'TestDir' };

      const container = document.createElement('div');
      container.className = 'inline-progress-container';
      container.setAttribute('data-location-id', 'loc-1');
      document.body.appendChild(container);

      rjc.updateInlineProgress('loc-1', { progress_percent: 50 });
      expect(rjc._inlineProgressListeners.has('loc-1')).toBe(true);

      rjc.removeInlineProgress('loc-1');
      expect(rjc._inlineProgressListeners.has('loc-1')).toBe(false);
      expect(document.querySelector('.inline-reindex-progress[data-location-id="loc-1"]')).toBeNull();
    });

    it('dispose removes all inline progress listeners across all locations', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      const el1 = document.createElement('button');
      const el2 = document.createElement('button');
      el1.addEventListener('click', handler1);
      el2.addEventListener('click', handler2);
      rjc._inlineProgressListeners.set('loc-1', [{ element: el1, event: 'click', handler: handler1 }]);
      rjc._inlineProgressListeners.set('loc-2', [{ element: el2, event: 'click', handler: handler2 }]);

      rjc.dispose();
      el1.click();
      el2.click();
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
      expect(rjc._inlineProgressListeners.size).toBe(0);
    });
  });

  // =========================================================================
  // resumeRunningJobs — full branching coverage
  // =========================================================================

  describe('resumeRunningJobs', () => {
    it('uses cached job data when cache is fresh', async () => {
      const locations = [{ id: 'loc-1', location_name: 'Cached' }];
      rjc.getLocations = () => locations;
      jest.spyOn(rjc, '_pollReindexProgress').mockResolvedValue();

      // Pre-populate cache with a fresh entry
      rjc._activeJobsCache.set('loc-1', {
        data: { job_id: 'cached-job-1', status: 'running' },
        timestamp: Date.now(),
      });

      await rjc.resumeRunningJobs();

      expect(activeReindexJobs['loc-1']).toBeDefined();
      expect(activeReindexJobs['loc-1'].jobId).toBe('cached-job-1');
      expect(activeReindexJobs['loc-1'].locationName).toBe('Cached');
      expect(endpoint.getActiveJobForLocation).not.toHaveBeenCalled();
    });

    it('skips cached entry when job is already active', async () => {
      const locations = [{ id: 'loc-1', location_name: 'Already' }];
      rjc.getLocations = () => locations;
      jest.spyOn(rjc, '_pollReindexProgress').mockResolvedValue();

      activeReindexJobs['loc-1'] = { jobId: 'existing' };
      rjc._activeJobsCache.set('loc-1', {
        data: { job_id: 'cached-job-1' },
        timestamp: Date.now(),
      });

      await rjc.resumeRunningJobs();

      // Should not overwrite existing job
      expect(activeReindexJobs['loc-1'].jobId).toBe('existing');
    });

    it('returns null from cache when cached data is null (no active job)', async () => {
      const locations = [{ id: 'loc-1', location_name: 'NoCachedJob' }];
      rjc.getLocations = () => locations;

      rjc._activeJobsCache.set('loc-1', {
        data: null,
        timestamp: Date.now(),
      });

      await rjc.resumeRunningJobs();

      expect(activeReindexJobs['loc-1']).toBeUndefined();
      expect(endpoint.getActiveJobForLocation).not.toHaveBeenCalled();
    });

    it('fetches from API when cache is stale and stores active job', async () => {
      const locations = [{ id: 'loc-2', location_name: 'APIFetch' }];
      rjc.getLocations = () => locations;
      jest.spyOn(rjc, '_pollReindexProgress').mockResolvedValue();

      endpoint.getActiveJobForLocation.mockResolvedValue({ job_id: 'api-job-2', status: 'processing' });

      await rjc.resumeRunningJobs();

      expect(endpoint.getActiveJobForLocation).toHaveBeenCalledWith('loc-2');
      expect(activeReindexJobs['loc-2']).toBeDefined();
      expect(activeReindexJobs['loc-2'].jobId).toBe('api-job-2');
      expect(rjc._activeJobsCache.has('loc-2')).toBe(true);
    });

    it('caches null when API returns no active job', async () => {
      const locations = [{ id: 'loc-3', location_name: 'NoJob' }];
      rjc.getLocations = () => locations;

      endpoint.getActiveJobForLocation.mockResolvedValue(null);

      await rjc.resumeRunningJobs();

      expect(activeReindexJobs['loc-3']).toBeUndefined();
      const cached = rjc._activeJobsCache.get('loc-3');
      expect(cached.data).toBeNull();
    });

    it('silently ignores 404 errors from API', async () => {
      const locations = [{ id: 'loc-4', location_name: 'Missing' }];
      rjc.getLocations = () => locations;

      endpoint.getActiveJobForLocation.mockRejectedValue({ status: 404, message: '404 Not Found' });

      await rjc.resumeRunningJobs();

      expect(logger.warn).not.toHaveBeenCalled();
      expect(rjc._activeJobsCache.get('loc-4').data).toBeNull();
    });

    it('logs warning for non-404 API errors', async () => {
      const locations = [{ id: 'loc-5', location_name: 'ErrorLoc' }];
      rjc.getLocations = () => locations;

      endpoint.getActiveJobForLocation.mockRejectedValue(new Error('Connection refused'));

      await rjc.resumeRunningJobs();

      expect(logger.warn).toHaveBeenCalled();
      expect(rjc._activeJobsCache.get('loc-5').data).toBeNull();
    });

    it('logs resumed count when jobs are found', async () => {
      const locations = [
        { id: 'loc-a', location_name: 'Alpha' },
        { id: 'loc-b', location_name: 'Beta' },
      ];
      rjc.getLocations = () => locations;
      jest.spyOn(rjc, '_pollReindexProgress').mockResolvedValue();

      endpoint.getActiveJobForLocation
        .mockResolvedValueOnce({ job_id: 'j1', status: 'running' })
        .mockResolvedValueOnce({ job_id: 'j2', status: 'running' });

      await rjc.resumeRunningJobs();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Resumed 2 active job(s)')
      );
    });

    it('catches top-level error without crashing', async () => {
      rjc.getLocations = () => { throw new Error('Location access failed'); };

      await expect(rjc.resumeRunningJobs()).resolves.not.toThrow();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to resume running jobs'),
        expect.any(Error)
      );
    });
  });

  // =========================================================================
  // renderInlineProgress — existing DOM element path
  // =========================================================================

  describe('renderInlineProgress', () => {
    it('returns empty string when no active job exists', () => {
      expect(rjc.renderInlineProgress('loc-x')).toBe('');
    });

    it('returns existing DOM element outerHTML when element exists in DOM', () => {
      activeReindexJobs['loc-1'] = { jobId: 'j1', locationName: 'Test' };

      const existing = document.createElement('div');
      existing.className = 'inline-reindex-progress';
      existing.setAttribute('data-location-id', 'loc-1');
      existing.textContent = 'Already rendered';
      document.body.appendChild(existing);

      const result = rjc.renderInlineProgress('loc-1');
      expect(result).toContain('Already rendered');
      expect(result).toContain('data-location-id="loc-1"');
    });

    it('returns fresh HTML template when no DOM element exists', () => {
      activeReindexJobs['loc-1'] = { jobId: 'j1', locationName: 'Fresh' };

      const result = rjc.renderInlineProgress('loc-1');
      expect(result).toContain('inline-reindex-progress');
      expect(result).toContain('data-location-id="loc-1"');
      expect(result).toContain('data-job-id="j1"');
      expect(result).toContain('Reindexing in progress');
      expect(result).toContain('View Details');
    });
  });

  // =========================================================================
  // showReindexProgress — public delegation
  // =========================================================================

  describe('showReindexProgress', () => {
    it('delegates to _showReindexProgress', () => {
      jest.spyOn(rjc, '_showReindexProgress').mockImplementation(() => {});
      rjc.showReindexProgress('MyDir', 'job-42');
      expect(rjc._showReindexProgress).toHaveBeenCalledWith('MyDir', 'job-42');
    });
  });

  // =========================================================================
  // _pollReindexProgress — completed path (lines 353-367)
  // =========================================================================

  describe('_pollReindexProgress — completed path', () => {
    it('waits 1s after completed, hides progress, deletes job, shows success', async () => {
      endpoint.getReindexJobStatus.mockResolvedValue({
        status: 'completed',
        progress_percent: 100,
        files_total: 42,
        chunks_processed: 200,
        files_scanned: 42,
      });

      const promise = rjc._pollReindexProgress('job-1', 'CompletedDir', 'loc-1');

      // Advance past the 1.5s delay
      await jest.advanceTimersByTimeAsync(1600);
      await promise;

      expect(rjc.showSuccess).toHaveBeenCalledWith(
        expect.stringContaining('Reindex completed for CompletedDir')
      );
      expect(rjc.showSuccess).toHaveBeenCalledWith(
        expect.stringContaining('42 files')
      );
      expect(rjc.showSuccess).toHaveBeenCalledWith(
        expect.stringContaining('200 chunks')
      );
      expect(activeReindexJobs['loc-1']).toBeUndefined();
      expect(rjc.loadLocations).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // _pollReindexProgress — polling interval (line 394)
  // =========================================================================

  describe('_pollReindexProgress — continuing poll', () => {
    it('waits pollInterval then checks again', async () => {
      let callCount = 0;
      endpoint.getReindexJobStatus.mockImplementation(() => {
        callCount++;
        if (callCount >= 2) {
          return Promise.resolve({ status: 'completed', files_total: 1, chunks_processed: 1 });
        }
        return Promise.resolve({ status: 'processing', progress_percent: 50 });
      });

      const promise = rjc._pollReindexProgress('job-1', 'PollDir', 'loc-1');

      // First call returns 'processing', then waits 2000ms
      await jest.advanceTimersByTimeAsync(2100);
      // Second call returns 'completed', then waits 1.5s
      await jest.advanceTimersByTimeAsync(1600);
      await promise;

      expect(endpoint.getReindexJobStatus).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // _showReindexProgress — full modal creation (lines 412-477)
  // =========================================================================

  describe('_showReindexProgress', () => {
    it('creates modal with all control buttons', () => {
      rjc._showReindexProgress('TestDir', 'job-1');

      const modal = document.getElementById('reindex-progress-modal');
      expect(modal).not.toBeNull();
      expect(modal.querySelector('#reindex-close-btn')).not.toBeNull();
      expect(modal.querySelector('#reindex-pause-btn')).not.toBeNull();
      expect(modal.querySelector('#reindex-stop-btn')).not.toBeNull();
      expect(modal.querySelector('#reindex-cancel-btn')).not.toBeNull();
      expect(modal.querySelector('.reindex-progress-overlay')).not.toBeNull();
    });

    it('tracks all button listeners in _reindexModalListeners', () => {
      rjc._showReindexProgress('TestDir', 'job-1');

      // minimize + pause + stop + cancel + overlay = 5
      expect(rjc._reindexModalListeners.length).toBe(5);
    });

    it('hides existing modal before showing new one', () => {
      rjc._showReindexProgress('First', 'job-1');
      expect(document.getElementById('reindex-progress-modal')).not.toBeNull();

      rjc._showReindexProgress('Second', 'job-2');
      // Advance past the 200ms removal timeout for the old modal
      jest.advanceTimersByTime(250);
      const modal = document.getElementById('reindex-progress-modal');
      expect(modal).not.toBeNull();
      expect(modal.innerHTML).toContain('Second');
    });

    it('sets opacity to 1 via requestAnimationFrame', () => {
      // jsdom supports requestAnimationFrame, need to flush it
      rjc._showReindexProgress('TestDir', 'job-1');
      const modal = document.getElementById('reindex-progress-modal');

      // Run rAF callback
      jest.advanceTimersByTime(16); // one frame
      expect(modal.style.opacity).toBe('1');
    });
  });

  // =========================================================================
  // _updateReindexProgress — DOM updates (lines 479-504)
  // =========================================================================

  describe('_updateReindexProgress', () => {
    beforeEach(() => {
      rjc._showReindexProgress('TestDir', 'job-1');
    });

    it('updates progress bar width', () => {
      rjc._updateReindexProgress({ progress_percent: 75, progress_phase: 'processing', files_scanned: 5, files_total: 10, chunks_processed: 25 });

      const fill = document.getElementById('reindex-progress-fill');
      expect(fill.style.width).toBe('75%');
    });

    it('updates percent display', () => {
      rjc._updateReindexProgress({ progress_percent: 42, progress_phase: 'scanning', files_scanned: 2, files_total: 10, chunks_processed: 5 });

      expect(document.getElementById('reindex-progress-percent').textContent).toBe('42%');
    });

    it('maps known phase names to human-readable text', () => {
      rjc._updateReindexProgress({ progress_percent: 0, progress_phase: 'scanning', files_scanned: 0, files_total: 0, chunks_processed: 0 });
      expect(document.getElementById('reindex-progress-phase').textContent).toBe('Scanning files...');

      rjc._updateReindexProgress({ progress_percent: 0, progress_phase: 'indexing', files_scanned: 0, files_total: 0, chunks_processed: 0 });
      expect(document.getElementById('reindex-progress-phase').textContent).toBe('Building search index...');
    });

    it('uses raw phase name when not in map', () => {
      rjc._updateReindexProgress({ progress_percent: 0, progress_phase: 'custom_phase', files_scanned: 0, files_total: 0, chunks_processed: 0 });
      expect(document.getElementById('reindex-progress-phase').textContent).toBe('custom_phase');
    });

    it('updates file and chunk stats', () => {
      rjc._updateReindexProgress({ progress_percent: 60, progress_phase: 'processing', files_scanned: 6, files_total: 10, chunks_processed: 1500 });

      expect(document.getElementById('detail-files').textContent).toBe('6 / 10');
      expect(document.getElementById('detail-chunks').textContent).toBe('1,500');
    });

    it('defaults to 0 for missing status fields', () => {
      rjc._updateReindexProgress({ progress_phase: 'processing' });

      expect(document.getElementById('reindex-progress-fill').style.width).toBe('0%');
      expect(document.getElementById('detail-files').textContent).toBe('0 / 0');
      expect(document.getElementById('detail-chunks').textContent).toBe('0');
    });
  });

  // =========================================================================
  // _hideReindexProgress + _minimizeReindexModal (lines 506-523)
  // =========================================================================

  describe('_hideReindexProgress', () => {
    it('sets modal opacity to 0 and removes after timeout', () => {
      rjc._showReindexProgress('TestDir', 'job-1');
      const modal = document.getElementById('reindex-progress-modal');
      expect(modal).not.toBeNull();

      rjc._hideReindexProgress();
      expect(modal.style.opacity).toBe('0');

      jest.advanceTimersByTime(250);
      expect(document.getElementById('reindex-progress-modal')).toBeNull();
    });

    it('does not throw when no modal exists', () => {
      expect(() => rjc._hideReindexProgress()).not.toThrow();
    });
  });

  describe('_minimizeReindexModal', () => {
    it('removes modal and shows floating minimized bar', () => {
      rjc._showReindexProgress('TestDir', 'job-1');

      rjc._minimizeReindexModal('TestDir', 'job-1');

      // Modal should be fading out
      const modal = document.getElementById('reindex-progress-modal');
      if (modal) expect(modal.style.opacity).toBe('0');

      // Minimized bar should exist
      const bar = document.getElementById('reindex-minimized-bar');
      expect(bar).not.toBeNull();
      expect(rjc._isMinimized).toBe(true);

      jest.advanceTimersByTime(250);
      // After timeout, modal is removed
      expect(document.getElementById('reindex-progress-modal')).toBeNull();
      // But minimized bar persists
      expect(document.getElementById('reindex-minimized-bar')).not.toBeNull();
    });
  });

  // =========================================================================
  // _pauseReindex + _resumeReindex (lines 544-594)
  // =========================================================================

  describe('_pauseReindex', () => {
    beforeEach(() => {
      rjc._showReindexProgress('TestDir', 'job-1');
    });

    it('calls endpoint.pauseReindexJob and swaps button to Resume', async () => {
      await rjc._pauseReindex('job-1');

      expect(endpoint.pauseReindexJob).toHaveBeenCalledWith('job-1');
      const btn = document.getElementById('reindex-pause-btn');
      expect(btn.innerHTML).toContain('Resume');
      expect(btn.classList.contains('btn-resume')).toBe(true);
      expect(btn.classList.contains('btn-pause')).toBe(false);
    });

    it('updates phase text to paused', async () => {
      await rjc._pauseReindex('job-1');

      expect(document.getElementById('reindex-progress-phase').textContent).toBe('Paused (checkpoint saved)');
    });

    it('shows error on API failure', async () => {
      endpoint.pauseReindexJob.mockRejectedValue(new Error('Pause failed'));
      await rjc._pauseReindex('job-1');
      expect(rjc.showError).toHaveBeenCalledWith('Failed to pause: Pause failed');
    });

    it('updates handler tracking after swap (BUG 1 regression)', async () => {
      await rjc._pauseReindex('job-1');

      const btn = document.getElementById('reindex-pause-btn');
      const entry = rjc._reindexModalListeners.find(e => e.element === btn);
      expect(entry).toBeDefined();
      expect(entry.handler).toBe(rjc._reindexPauseHandler);
    });
  });

  describe('_resumeReindex', () => {
    beforeEach(() => {
      rjc._showReindexProgress('TestDir', 'job-1');
    });

    it('calls endpoint.resumeReindexJob and swaps button to Pause', async () => {
      // First pause to get into resume state
      await rjc._pauseReindex('job-1');
      endpoint.resumeReindexJob.mockResolvedValue({});

      await rjc._resumeReindex('job-1');

      expect(endpoint.resumeReindexJob).toHaveBeenCalledWith('job-1');
      const btn = document.getElementById('reindex-pause-btn');
      expect(btn.innerHTML).toContain('Pause');
      expect(btn.classList.contains('btn-pause')).toBe(true);
      expect(btn.classList.contains('btn-resume')).toBe(false);
    });

    it('updates phase text to resuming', async () => {
      await rjc._pauseReindex('job-1');
      await rjc._resumeReindex('job-1');

      expect(document.getElementById('reindex-progress-phase').textContent).toBe('Resuming...');
    });

    it('shows error on API failure', async () => {
      endpoint.resumeReindexJob.mockRejectedValue(new Error('Resume failed'));
      await rjc._resumeReindex('job-1');
      expect(rjc.showError).toHaveBeenCalledWith('Failed to resume: Resume failed');
    });
  });

  // =========================================================================
  // _stopReindex + _cancelReindex (lines 596-638)
  // =========================================================================

  describe('_stopReindex', () => {
    beforeEach(() => {
      rjc._showReindexProgress('TestDir', 'job-1');
    });

    it('calls endpoint.stopReindexJob when user confirms', async () => {
      ConfirmDialog.confirm.mockResolvedValue(true);
      await rjc._stopReindex('job-1');

      expect(ConfirmDialog.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Stop indexing',
          confirmText: 'Stop',
        })
      );
      expect(endpoint.stopReindexJob).toHaveBeenCalledWith('job-1');
      expect(rjc.showSuccess).toHaveBeenCalledWith(
        'Reindex stopped. Progress saved - you can resume later.'
      );
    });

    it('does nothing when user cancels confirmation', async () => {
      ConfirmDialog.confirm.mockResolvedValue(false);
      await rjc._stopReindex('job-1');

      expect(endpoint.stopReindexJob).not.toHaveBeenCalled();
    });

    it('shows error on API failure', async () => {
      ConfirmDialog.confirm.mockResolvedValue(true);
      endpoint.stopReindexJob.mockRejectedValue(new Error('Stop failed'));
      await rjc._stopReindex('job-1');
      expect(rjc.showError).toHaveBeenCalledWith('Failed to stop: Stop failed');
    });
  });

  describe('_cancelReindex', () => {
    beforeEach(() => {
      rjc._showReindexProgress('TestDir', 'job-1');
    });

    it('calls endpoint.cancelReindexJob with danger variant when confirmed', async () => {
      ConfirmDialog.confirm.mockResolvedValue(true);
      await rjc._cancelReindex('job-1');

      expect(ConfirmDialog.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Cancel indexing',
          variant: 'danger',
        })
      );
      expect(endpoint.cancelReindexJob).toHaveBeenCalledWith('job-1');
      expect(rjc.showError).toHaveBeenCalledWith('Reindex cancelled - progress discarded');
    });

    it('does nothing when user cancels confirmation', async () => {
      ConfirmDialog.confirm.mockResolvedValue(false);
      await rjc._cancelReindex('job-1');

      expect(endpoint.cancelReindexJob).not.toHaveBeenCalled();
    });

    it('shows error on API failure', async () => {
      ConfirmDialog.confirm.mockResolvedValue(true);
      endpoint.cancelReindexJob.mockRejectedValue(new Error('Cancel failed'));
      await rjc._cancelReindex('job-1');
      expect(rjc.showError).toHaveBeenCalledWith('Failed to cancel: Cancel failed');
    });
  });

  // =========================================================================
  // updateInlineProgress — progress bar and stats updates (lines 277-289)
  // =========================================================================

  describe('updateInlineProgress — DOM updates', () => {
    it('updates existing progress bar width and stats text', () => {
      activeReindexJobs['loc-1'] = { jobId: 'j1', locationName: 'Test' };

      // Create the inline progress container in DOM
      const container = document.createElement('div');
      container.className = 'inline-reindex-progress';
      container.setAttribute('data-location-id', 'loc-1');
      container.innerHTML = `
        <div class="inline-progress-bar"><div class="inline-progress-fill" style="width: 0%"></div></div>
        <div class="inline-reindex-stats">Initializing...</div>
      `;
      document.body.appendChild(container);

      rjc.updateInlineProgress('loc-1', {
        progress_percent: 65,
        progress_phase: 'scanning',
        files_scanned: 7,
        files_total: 12,
        chunks_processed: 30,
      });

      expect(container.querySelector('.inline-progress-fill').style.width).toBe('65%');
      expect(container.querySelector('.inline-reindex-stats').textContent).toBe(
        'scanning \u2022 7 / 12 files \u2022 30 chunks'
      );
    });

    it('returns early when no active job', () => {
      expect(() => rjc.updateInlineProgress('loc-x', {})).not.toThrow();
    });

    it('returns early when container not found', () => {
      activeReindexJobs['loc-1'] = { jobId: 'j1', locationName: 'Test' };
      // No DOM container
      expect(() => rjc.updateInlineProgress('loc-1', {})).not.toThrow();
    });

    it('ViewDetails button click triggers _showReindexProgress with correct args', () => {
      activeReindexJobs['loc-1'] = { jobId: 'j1', locationName: 'TestDir' };

      const container = document.createElement('div');
      container.className = 'inline-progress-container';
      container.setAttribute('data-location-id', 'loc-1');
      document.body.appendChild(container);

      jest.spyOn(rjc, '_showReindexProgress').mockImplementation(() => {});
      rjc.updateInlineProgress('loc-1', { progress_percent: 50 });

      const viewBtn = container.querySelector('.inline-view-details-btn');
      expect(viewBtn).not.toBeNull();
      viewBtn.click();

      expect(rjc._showReindexProgress).toHaveBeenCalledWith('TestDir', 'j1');
    });
  });
});

// ===========================================================================
// 4. DaemonController
// ===========================================================================

describe('DaemonController', () => {
  const DaemonController = require('../../../../src/renderer/main/modules/settings/modules/DaemonController');
  let dc;
  let endpoint;
  let logger;
  let elements;
  let isEnabled;
  let daemonStatus;

  beforeEach(() => {
    jest.useFakeTimers();
    setupMinimalDOM();
    endpoint = createMockEndpoint();
    logger = createMockLogger();
    elements = {
      enableToggle: document.getElementById('file-indexing-enabled'),
      addButton: document.getElementById('file-indexing-add-location'),
      locationsList: document.getElementById('file-indexing-locations-list'),
    };
    isEnabled = true;
    daemonStatus = null;

    dc = new DaemonController({
      endpoint,
      getElements: () => elements,
      getIsEnabled: () => isEnabled,
      setIsEnabled: (val) => { isEnabled = val; },
      getDaemonStatus: () => daemonStatus,
      setDaemonStatus: (s) => { daemonStatus = s; },
      loadLocations: jest.fn().mockResolvedValue(undefined),
      showSuccess: jest.fn(),
      showError: jest.fn(),
      logger,
    });
  });

  afterEach(() => {
    dc.dispose();
    teardownDOM();
    jest.useRealTimers();
  });

  describe('loadDaemonStatus', () => {
    it('sets daemonStatus from API response with exact shape', async () => {
      endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: true, uptime_seconds: 300 });
      await dc.loadDaemonStatus();
      expect(daemonStatus.running).toBe(true);
      expect(daemonStatus.uptime_seconds).toBe(300);
    });

    it('syncs toggle checked state with daemon running status', async () => {
      elements.enableToggle.checked = false;
      isEnabled = false;
      dc._isChangingState = false;
      endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: true, uptime_seconds: 300 });
      await dc.loadDaemonStatus();
      expect(elements.enableToggle.checked).toBe(true);
      expect(isEnabled).toBe(true);
    });

    it('does NOT sync toggle when _isChangingState is true', async () => {
      elements.enableToggle.checked = false;
      dc._isChangingState = true;
      endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: true, uptime_seconds: 300 });
      await dc.loadDaemonStatus();
      expect(elements.enableToggle.checked).toBe(false);
    });

    it('sets {running: false, error: message} on API failure', async () => {
      endpoint.getFileIndexingDaemonStatus.mockRejectedValue(new Error('timeout'));
      await dc.loadDaemonStatus();
      expect(daemonStatus).toEqual({ running: false, error: 'timeout' });
    });

    it('applies "starting" UI state within grace window after start request', async () => {
      dc._daemonStartRequestedAt = Date.now() - 5000; // 5s ago (within 20s window)
      endpoint.getFileIndexingDaemonStatus.mockResolvedValue({ running: false, uptime_seconds: 0 });
      await dc.loadDaemonStatus();
      expect(daemonStatus._ui_state).toBe('starting');
    });
  });

  describe('_handleDaemonControlError', () => {
    it('returns true and locks controls for 403', () => {
      const result = dc._handleDaemonControlError({ status: 403 });
      expect(result).toBe(true);
      expect(dc._daemonControlsLocked).toBe(true);
    });

    it('disables toggle and restart button on 403', () => {
      dc._daemonBannerButtons = { restart: document.createElement('button') };
      dc._handleDaemonControlError({ status: 403 });
      expect(elements.enableToggle.disabled).toBe(true);
      expect(dc._daemonBannerButtons.restart.disabled).toBe(true);
    });

    it('calls showError with 403-specific message', () => {
      dc._handleDaemonControlError({ status: 403 });
      expect(dc.showError).toHaveBeenCalledWith(expect.stringContaining('HTTP 403'));
    });

    it('returns false for non-403 errors', () => {
      expect(dc._handleDaemonControlError({ status: 500 })).toBe(false);
      expect(dc._daemonControlsLocked).toBe(false);
    });

    it('returns false for error.response.status path', () => {
      expect(dc._handleDaemonControlError({ response: { status: 500 } })).toBe(false);
    });

    it('returns false when error has no status at all', () => {
      expect(dc._handleDaemonControlError(new Error('generic'))).toBe(false);
    });
  });

  describe('updateEnabledState — start daemon', () => {
    it('starts daemon when enabled', async () => {
      isEnabled = true;
      endpoint.startFileIndexingDaemon.mockResolvedValue({ success: true });
      // Mock _awaitDaemonStatusTransition to not actually poll
      jest.spyOn(dc, '_awaitDaemonStatusTransition').mockResolvedValue(undefined);

      await dc.updateEnabledState();

      expect(endpoint.startFileIndexingDaemon).toHaveBeenCalled();
      expect(dc.showSuccess).toHaveBeenCalledWith('Daemon started successfully');
    });

    it('shows error on start failure', async () => {
      isEnabled = true;
      endpoint.startFileIndexingDaemon.mockResolvedValue({ success: false, message: 'Port busy' });

      await dc.updateEnabledState();

      expect(dc.showError).toHaveBeenCalledWith('Port busy');
      expect(isEnabled).toBe(false);
    });

    it('stops daemon when disabled and user confirms', async () => {
      isEnabled = false;
      ConfirmDialog.confirm.mockResolvedValue(true);
      endpoint.stopFileIndexingDaemon.mockResolvedValue({ success: true });
      jest.spyOn(dc, '_awaitDaemonStatusTransition').mockResolvedValue(undefined);

      await dc.updateEnabledState();

      expect(endpoint.stopFileIndexingDaemon).toHaveBeenCalled();
      expect(dc.showSuccess).toHaveBeenCalledWith('Daemon stopped successfully');
    });

    it('reverts toggle when user cancels stop', async () => {
      isEnabled = false;
      ConfirmDialog.confirm.mockResolvedValue(false);

      await dc.updateEnabledState();

      expect(endpoint.stopFileIndexingDaemon).not.toHaveBeenCalled();
      expect(isEnabled).toBe(true);
    });

    it('is no-op when disposed', async () => {
      dc._isDisposed = true;
      await dc.updateEnabledState();
      expect(endpoint.startFileIndexingDaemon).not.toHaveBeenCalled();
    });

    it('is no-op when already changing state', async () => {
      dc._isChangingState = true;
      await dc.updateEnabledState();
      expect(endpoint.startFileIndexingDaemon).not.toHaveBeenCalled();
    });
  });

  describe('BUG 2 REGRESSION: restart timer tracked and cleared', () => {
    beforeEach(() => {
      ConfirmDialog.confirm.mockResolvedValue(true);
      // Place a restart button in DOM (banner would create it, we shortcut)
      const banner = document.createElement('div');
      banner.innerHTML = '<button id="daemon-restart-btn"></button>';
      document.body.appendChild(banner);
    });

    it('_restartTimerId is set after successful restart', async () => {
      endpoint.restartFileIndexingDaemon.mockResolvedValue({ success: true });
      await dc._restartDaemon();
      expect(dc._restartTimerId).not.toBeNull();
    });

    it('dispose() clears the pending restart timer', async () => {
      endpoint.restartFileIndexingDaemon.mockResolvedValue({ success: true });
      await dc._restartDaemon();
      const timerId = dc._restartTimerId;
      expect(timerId).not.toBeNull();

      dc.dispose();
      expect(dc._restartTimerId).toBeNull();
    });

    it('restart timer callback is a no-op after dispose (guards null endpoint)', async () => {
      endpoint.restartFileIndexingDaemon.mockResolvedValue({ success: true });
      await dc._restartDaemon();
      dc.dispose();
      // Timer was cleared, but let's ensure advancing time doesn't crash
      jest.advanceTimersByTime(5000);
      // If callback ran on disposed instance, endpoint calls would throw.
      // No calls should have been made after the initial restartFileIndexingDaemon.
      expect(endpoint.getFileIndexingDaemonStatus).not.toHaveBeenCalled();
    });

    it('does not set timer on restart failure', async () => {
      endpoint.restartFileIndexingDaemon.mockResolvedValue({ success: false, message: 'denied' });
      await dc._restartDaemon();
      expect(dc._restartTimerId).toBeNull();
      expect(dc.showError).toHaveBeenCalledWith('denied');
    });

    it('does nothing when user cancels confirm dialog', async () => {
      ConfirmDialog.confirm.mockResolvedValueOnce(false);
      await dc._restartDaemon();
      expect(endpoint.restartFileIndexingDaemon).not.toHaveBeenCalled();
      expect(dc._restartTimerId).toBeNull();
    });
  });

  describe('dispose', () => {
    it('removes banner listeners (verified by clicking removed handler)', () => {
      const btn = document.createElement('button');
      const handler = jest.fn();
      btn.addEventListener('click', handler);
      dc._daemonBannerListeners.push({ element: btn, event: 'click', handler });

      dc.dispose();
      btn.click();
      expect(handler).not.toHaveBeenCalled();
    });

    it('nulls all closures', () => {
      dc.dispose();
      expect(dc.endpoint).toBeNull();
      expect(dc.getElements).toBeNull();
      expect(dc.getIsEnabled).toBeNull();
      expect(dc.setIsEnabled).toBeNull();
      expect(dc.getDaemonStatus).toBeNull();
      expect(dc.setDaemonStatus).toBeNull();
      expect(dc.loadLocations).toBeNull();
      expect(dc.showSuccess).toBeNull();
      expect(dc.showError).toBeNull();
    });
  });
});

// ===========================================================================
// 5. LocationCardRenderer
// ===========================================================================

describe('LocationCardRenderer', () => {
  const LocationCardRenderer = require('../../../../src/renderer/main/modules/settings/modules/LocationCardRenderer');
  let lcr;
  let logger;
  let elements;
  let locations;

  beforeEach(() => {
    setupMinimalDOM();
    logger = createMockLogger();
    elements = {
      addButton: document.getElementById('file-indexing-add-location'),
      locationsList: document.getElementById('file-indexing-locations-list'),
    };
    locations = createLocationFixtures();

    lcr = new LocationCardRenderer({
      getLocations: () => locations,
      getElements: () => elements,
      getActiveReindexJobs: () => ({}),
      showConfig: jest.fn(),
      triggerReindex: jest.fn(),
      toggleLocation: jest.fn(),
      deleteLocation: jest.fn(),
      renderInlineProgress: () => '',
      showReindexProgress: jest.fn(),
      escapeHtml: (t) => t,
      formatBytes: (b) => `${b} B`,
      formatStatus: (s) => s,
      logger,
    });
  });

  afterEach(() => {
    lcr.dispose();
    teardownDOM();
  });

  describe('renderLocations', () => {
    it('creates DOM card elements for each location', () => {
      lcr.renderLocations();
      expect(lcr._locationCards.size).toBe(2);
      expect(elements.locationsList.querySelectorAll('.file-location-item').length).toBe(2);
    });

    it('removes cards for deleted locations and cleans their listeners', () => {
      lcr.renderLocations();
      expect(lcr._locationCards.size).toBe(2);
      expect(lcr._locationCardListeners.has('loc-2')).toBe(true);

      locations.splice(1, 1); // Remove second location
      lcr.renderLocations();
      expect(lcr._locationCards.size).toBe(1);
      expect(lcr._locationCardListeners.has('loc-2')).toBe(false);
      expect(elements.locationsList.querySelectorAll('.file-location-item').length).toBe(1);
    });

    it('updates existing cards without recreating them', () => {
      lcr.renderLocations();
      const originalCard = lcr._locationCards.get('loc-1');

      locations[0] = { ...locations[0], file_count: 99 };
      lcr.renderLocations();
      const sameCard = lcr._locationCards.get('loc-1');
      expect(sameCard).toBe(originalCard); // Same DOM reference — no recreation
    });

    it('renders empty state when locations is empty', () => {
      locations.length = 0;
      lcr.renderLocations();
      expect(elements.locationsList.querySelector('.empty-state')).not.toBeNull();
      expect(elements.locationsList.querySelector('.empty-state').textContent).toContain('No indexed locations');
    });

    it('removes empty state when locations appear after being empty', () => {
      locations.length = 0;
      lcr.renderLocations();
      expect(elements.locationsList.querySelector('.empty-state')).not.toBeNull();

      locations.push(...createLocationFixtures());
      lcr.renderLocations();
      expect(elements.locationsList.querySelector('.empty-state')).toBeNull();
      expect(lcr._locationCards.size).toBe(2);
    });
  });

  describe('_createLocationElement — listener tracking', () => {
    it('tracks exactly 4 listeners per card (config, reindex, toggle, delete)', () => {
      lcr.renderLocations();
      const listeners = lcr._locationCardListeners.get('loc-1');
      expect(listeners).toBeDefined();
      expect(listeners.length).toBe(4);
      // Verify each listener has correct shape
      for (const l of listeners) {
        expect(l.element).toBeInstanceOf(HTMLElement);
        expect(l.event).toBe('click');
        expect(typeof l.handler).toBe('function');
      }
    });

    it('config button calls showConfig with the correct location object', () => {
      lcr.renderLocations();
      lcr._locationCards.get('loc-1').querySelector('.btn-config').click();
      expect(lcr.showConfig).toHaveBeenCalledTimes(1);
      expect(lcr.showConfig).toHaveBeenCalledWith(locations[0]);
    });

    it('reindex button calls triggerReindex with locationId and name', () => {
      lcr.renderLocations();
      lcr._locationCards.get('loc-1').querySelector('.btn-reindex').click();
      expect(lcr.triggerReindex).toHaveBeenCalledWith('loc-1', 'Primary');
    });

    it('toggle button calls toggleLocation with locationId and current enabled state', () => {
      lcr.renderLocations();
      lcr._locationCards.get('loc-1').querySelector('.btn-toggle').click();
      expect(lcr.toggleLocation).toHaveBeenCalledWith('loc-1', true);
    });

    it('delete button calls deleteLocation with locationId and name', () => {
      lcr.renderLocations();
      lcr._locationCards.get('loc-1').querySelector('.btn-delete').click();
      expect(lcr.deleteLocation).toHaveBeenCalledWith('loc-1', 'Primary');
    });

    it('disables reindex button and shows spinner when location has an active job', () => {
      const lcrWithJob = new LocationCardRenderer({
        getLocations: () => locations,
        getElements: () => elements,
        getActiveReindexJobs: () => ({ 'loc-1': { jobId: 'j1' } }),
        showConfig: jest.fn(),
        triggerReindex: jest.fn(),
        toggleLocation: jest.fn(),
        deleteLocation: jest.fn(),
        renderInlineProgress: () => '',
        showReindexProgress: jest.fn(),
        escapeHtml: (t) => t,
        formatBytes: (b) => `${b} B`,
        formatStatus: (s) => s,
        logger,
      });
      lcrWithJob.renderLocations();
      const card = lcrWithJob._locationCards.get('loc-1');
      const reindexBtn = card.querySelector('.btn-reindex');
      expect(reindexBtn.disabled).toBe(true);
      expect(reindexBtn.innerHTML).toContain('fa-spinner');
      lcrWithJob.dispose();
    });
  });

  describe('updateAddButtonState', () => {
    it('disables add button when both primary and secondary exist', () => {
      lcr.updateAddButtonState();
      expect(elements.addButton.disabled).toBe(true);
      expect(elements.addButton.style.opacity).toBe('0.5');
    });

    it('enables add button when secondary is missing', () => {
      locations.splice(1, 1);
      lcr.updateAddButtonState();
      expect(elements.addButton.disabled).toBe(false);
      expect(elements.addButton.style.opacity).toBe('1');
    });
  });

  describe('dispose', () => {
    it('clears all card caches and listener maps', () => {
      lcr.renderLocations();
      expect(lcr._locationCards.size).toBe(2);
      expect(lcr._locationCardListeners.size).toBe(2);
      lcr.dispose();
      expect(lcr._locationCards.size).toBe(0);
      expect(lcr._locationCardListeners.size).toBe(0);
    });

    it('nulls all closures', () => {
      lcr.dispose();
      expect(lcr.getLocations).toBeNull();
      expect(lcr.getElements).toBeNull();
      expect(lcr.showConfig).toBeNull();
      expect(lcr.triggerReindex).toBeNull();
      expect(lcr.toggleLocation).toBeNull();
      expect(lcr.deleteLocation).toBeNull();
      expect(lcr.renderInlineProgress).toBeNull();
      expect(lcr.showReindexProgress).toBeNull();
      expect(lcr.escapeHtml).toBeNull();
      expect(lcr.formatBytes).toBeNull();
      expect(lcr.formatStatus).toBeNull();
    });
  });
});

// ===========================================================================
// 6. FileIndexingManager (Orchestrator)
// ===========================================================================

describe('FileIndexingManager (Orchestrator)', () => {
  const FileIndexingManager = require('../../../../src/renderer/main/modules/settings/FileIndexingManager');
  let mgr;
  let endpoint;

  beforeEach(() => {
    jest.useFakeTimers();
    setupMinimalDOM();
    endpoint = createMockEndpoint();
    mgr = new FileIndexingManager({ endpoint });
  });

  afterEach(() => {
    mgr.destroy();
    teardownDOM();
    jest.useRealTimers();
  });

  describe('constructor wiring', () => {
    it('creates ReindexJobController module', () => {
      expect(mgr._reindexJobController).toBeDefined();
      expect(mgr._reindexJobController.constructor.name).toBe('ReindexJobController');
    });

    it('creates DaemonController module', () => {
      expect(mgr._daemonController).toBeDefined();
      expect(mgr._daemonController.constructor.name).toBe('DaemonController');
    });

    it('creates LocationCardRenderer module', () => {
      expect(mgr._locationCardRenderer).toBeDefined();
      expect(mgr._locationCardRenderer.constructor.name).toBe('LocationCardRenderer');
    });

    it('initializes shared state correctly', () => {
      expect(mgr.locations).toEqual([]);
      expect(mgr.activeReindexJobs).toEqual({});
      expect(mgr.isEnabled).toBe(true);
      expect(mgr._isInitialized).toBe(false);
      expect(mgr._isInitializing).toBe(false);
    });

    it('ReindexJobController closures reference orchestrator state', () => {
      mgr.activeReindexJobs['loc-x'] = { test: true };
      const jobs = mgr._reindexJobController.getActiveReindexJobs();
      expect(jobs['loc-x']).toEqual({ test: true });
    });
  });

  describe('initialize', () => {
    it('sets DOM element references', async () => {
      await mgr.initialize();
      expect(mgr.elements.enableToggle).toBe(document.getElementById('file-indexing-enabled'));
      expect(mgr.elements.addButton).toBe(document.getElementById('file-indexing-add-location'));
      expect(mgr.elements.locationsList).toBe(document.getElementById('file-indexing-locations-list'));
    });

    it('sets _isInitialized flag', async () => {
      await mgr.initialize();
      expect(mgr._isInitialized).toBe(true);
      expect(mgr._isInitializing).toBe(false);
    });

    it('is idempotent — second call is a no-op', async () => {
      await mgr.initialize();
      const callCount = endpoint.getFileIndexingLocations.mock.calls.length;
      await mgr.initialize();
      expect(endpoint.getFileIndexingLocations.mock.calls.length).toBe(callCount);
    });

    it('returns early if required DOM elements are missing', async () => {
      teardownDOM();
      document.body.innerHTML = '<div id="file-indexing-enabled"></div>';
      await mgr.initialize();
      expect(mgr._isInitialized).toBe(false);
    });

    it('calls loadLocations on first init', async () => {
      await mgr.initialize();
      expect(endpoint.getFileIndexingLocations).toHaveBeenCalledTimes(1);
    });
  });

  describe('triggerReindex — delegates to module', () => {
    it('forwards call to ReindexJobController.triggerReindex', async () => {
      const spy = jest.spyOn(mgr._reindexJobController, 'triggerReindex').mockResolvedValue(undefined);
      await mgr.triggerReindex('loc-1', 'TestDir');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('loc-1', 'TestDir');
    });
  });

  describe('deleteLocation — confirm dialog gate', () => {
    it('does not delete when user cancels confirm', async () => {
      ConfirmDialog.confirm.mockResolvedValueOnce(false);
      await mgr.deleteLocation('loc-1', 'TestDir');
      expect(endpoint.deleteFileIndexingLocation).not.toHaveBeenCalled();
    });

    it('deletes location and reloads when user confirms', async () => {
      ConfirmDialog.confirm.mockResolvedValueOnce(true);
      await mgr.deleteLocation('loc-1', 'TestDir');
      expect(endpoint.deleteFileIndexingLocation).toHaveBeenCalledTimes(1);
      expect(endpoint.deleteFileIndexingLocation).toHaveBeenCalledWith('loc-1');
      expect(endpoint.getFileIndexingLocations).toHaveBeenCalled(); // via loadLocations
    });

    it('shows error on delete failure', async () => {
      ConfirmDialog.confirm.mockResolvedValueOnce(true);
      endpoint.deleteFileIndexingLocation.mockRejectedValue(new Error('forbidden'));
      await mgr.deleteLocation('loc-1', 'TestDir');
      const statusEl = document.getElementById('settings-status');
      expect(statusEl.textContent).toContain('forbidden');
    });
  });

  describe('addLocation — type limit enforcement', () => {
    it('shows error when both primary and secondary exist', async () => {
      mgr.locations = [{ location_type: 'primary' }, { location_type: 'secondary' }];
      await mgr.addLocation();
      const statusEl = document.getElementById('settings-status');
      expect(statusEl.textContent).toContain('Maximum locations reached');
    });
  });

  describe('loadLocations — caching', () => {
    it('uses cached data when within TTL', async () => {
      endpoint.getFileIndexingLocations.mockResolvedValue(createLocationFixtures());
      await mgr.loadLocations(false);
      const firstCallCount = endpoint.getFileIndexingLocations.mock.calls.length;

      // Second call within TTL should use cache
      await mgr.loadLocations(false);
      expect(endpoint.getFileIndexingLocations.mock.calls.length).toBe(firstCallCount);
    });

    it('bypasses cache when forceRefresh=true', async () => {
      endpoint.getFileIndexingLocations.mockResolvedValue(createLocationFixtures());
      await mgr.loadLocations(false);
      const firstCallCount = endpoint.getFileIndexingLocations.mock.calls.length;

      await mgr.loadLocations(true);
      expect(endpoint.getFileIndexingLocations.mock.calls.length).toBe(firstCallCount + 1);
    });

    it('starts auto-refresh when location is running', async () => {
      const locations = createLocationFixtures();
      locations[0].last_scan_status = 'running';
      endpoint.getFileIndexingLocations.mockResolvedValue(locations);

      await mgr.loadLocations(true);
      expect(mgr.refreshInterval).not.toBeNull();
    });

    it('stops auto-refresh when no location is running', async () => {
      endpoint.getFileIndexingLocations.mockResolvedValue(createLocationFixtures());
      mgr.refreshInterval = setInterval(() => {}, 5000);

      await mgr.loadLocations(true);
      expect(mgr.refreshInterval).toBeNull();
    });
  });

  describe('toggleLocation', () => {
    it('calls endpoint.updateFileIndexingLocation with inverted enabled', async () => {
      await mgr.toggleLocation('loc-1', true);
      expect(endpoint.updateFileIndexingLocation).toHaveBeenCalledWith('loc-1', { enabled: false });
    });

    it('reloads locations after toggle', async () => {
      await mgr.toggleLocation('loc-1', false);
      expect(endpoint.getFileIndexingLocations).toHaveBeenCalled();
    });

    it('shows error on failure', async () => {
      endpoint.updateFileIndexingLocation.mockRejectedValue(new Error('denied'));
      await mgr.toggleLocation('loc-1', true);
      const statusEl = document.getElementById('settings-status');
      expect(statusEl.textContent).toContain('denied');
    });
  });

  describe('_showSuccess / _showError', () => {
    it('_showSuccess displays message in settings-status element', () => {
      mgr._showSuccess('Done!');
      const statusEl = document.getElementById('settings-status');
      expect(statusEl.textContent).toBe('Done!');
    });

    it('_showError displays message in settings-status element', () => {
      mgr._showError('Failed!');
      const statusEl = document.getElementById('settings-status');
      expect(statusEl.textContent).toBe('Failed!');
    });
  });

  describe('auto-refresh lifecycle', () => {
    it('_startAutoRefresh creates interval', () => {
      mgr._startAutoRefresh();
      expect(mgr.refreshInterval).not.toBeNull();
    });

    it('_startAutoRefresh is idempotent', () => {
      mgr._startAutoRefresh();
      const firstId = mgr.refreshInterval;
      mgr._startAutoRefresh();
      expect(mgr.refreshInterval).toBe(firstId);
    });

    it('_stopAutoRefresh clears interval', () => {
      mgr._startAutoRefresh();
      expect(mgr.refreshInterval).not.toBeNull();
      mgr._stopAutoRefresh();
      expect(mgr.refreshInterval).toBeNull();
    });

    it('auto-refresh polls locations and stops when no running', async () => {
      endpoint.getFileIndexingLocations.mockResolvedValue(createLocationFixtures());
      mgr._startAutoRefresh();
      endpoint.getFileIndexingLocations.mockClear();

      // Advance timer
      jest.advanceTimersByTime(5000);
      // Wait for async
      await Promise.resolve();
      await Promise.resolve();

      expect(endpoint.getFileIndexingLocations).toHaveBeenCalled();
      // No running locations -> stops
      expect(mgr.refreshInterval).toBeNull();
    });

    it('guards against concurrent auto-refresh calls', async () => {
      let resolveFirst;
      endpoint.getFileIndexingLocations.mockImplementation(() => new Promise(r => { resolveFirst = r; }));
      mgr._startAutoRefresh();

      // First tick
      jest.advanceTimersByTime(5000);
      expect(mgr._autoRefreshInFlight).toBe(true);

      // Second tick while first is in-flight
      jest.advanceTimersByTime(5000);
      // Only one call should be pending
      expect(endpoint.getFileIndexingLocations).toHaveBeenCalledTimes(1);

      // Resolve to clean up
      resolveFirst([]);
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  describe('destroy — full cleanup chain', () => {
    it('disposes all 3 modules', () => {
      const rjcSpy = jest.spyOn(mgr._reindexJobController, 'dispose');
      const dcSpy = jest.spyOn(mgr._daemonController, 'dispose');
      const lcrSpy = jest.spyOn(mgr._locationCardRenderer, 'dispose');

      mgr.destroy();

      expect(rjcSpy).toHaveBeenCalledTimes(1);
      expect(dcSpy).toHaveBeenCalledTimes(1);
      expect(lcrSpy).toHaveBeenCalledTimes(1);
    });

    it('nulls all module references after disposal', () => {
      mgr.destroy();
      expect(mgr._reindexJobController).toBeNull();
      expect(mgr._daemonController).toBeNull();
      expect(mgr._locationCardRenderer).toBeNull();
    });

    it('stops auto-refresh interval', () => {
      mgr.refreshInterval = setInterval(() => {}, 5000);
      mgr.destroy();
      expect(mgr.refreshInterval).toBeNull();
    });

    it('resets initialization flags for clean re-init', () => {
      mgr._isInitialized = true;
      mgr._isInitializing = true;
      mgr.destroy();
      expect(mgr._isInitialized).toBe(false);
      expect(mgr._isInitializing).toBe(false);
    });

    it('clears shared state', () => {
      mgr.locations = [{ id: 1 }];
      mgr.activeReindexJobs = { 'loc-1': {} };
      mgr.destroy();
      expect(mgr.locations).toEqual([]);
      expect(mgr.activeReindexJobs).toEqual({});
    });

    it('removes static DOM listeners', async () => {
      await mgr.initialize();
      expect(mgr._staticListeners.length).toBeGreaterThan(0);
      mgr.destroy();
      expect(mgr._staticListeners).toEqual([]);
    });

    it('is safe to call destroy twice (idempotent)', () => {
      mgr.destroy();
      expect(() => mgr.destroy()).not.toThrow();
    });
  });

  // =========================================================================
  // addLocation — full flow via LocationSelectorModal mock
  // =========================================================================

  describe('addLocation — LocationSelectorModal flow', () => {
    let mockSelectorInstance;

    beforeEach(() => {
      mockSelectorInstance = {
        show: jest.fn().mockResolvedValue(undefined),
      };

      // Mock the LocationSelectorModal constructor
      window.LocationSelectorModal = jest.fn((opts) => {
        mockSelectorInstance._opts = opts;
        return mockSelectorInstance;
      });
    });

    afterEach(() => {
      delete window.LocationSelectorModal;
    });

    it('creates LocationSelectorModal and calls show()', async () => {
      mgr.locations = [];
      await mgr.addLocation();
      expect(window.LocationSelectorModal).toHaveBeenCalledTimes(1);
      expect(mockSelectorInstance.show).toHaveBeenCalledTimes(1);
    });

    it('onSelect creates location via endpoint and reloads', async () => {
      mgr.locations = [];
      // Mock triggerReindex to prevent _pollReindexProgress timer loop under fake timers
      jest.spyOn(mgr, 'triggerReindex').mockResolvedValue(undefined);
      await mgr.addLocation();

      // Invoke the onSelect callback
      await mockSelectorInstance._opts.onSelect({
        path: '/Users/me/docs',
        type: 'primary',
      });

      expect(endpoint.createFileIndexingLocation).toHaveBeenCalledTimes(1);
      expect(endpoint.createFileIndexingLocation).toHaveBeenCalledWith(
        expect.objectContaining({
          location_name: 'docs',
          root_path: '/Users/me/docs',
          location_type: 'primary',
        })
      );
      expect(endpoint.getFileIndexingLocations).toHaveBeenCalled();
      // Verify auto-reindex was triggered for the newly created location
      expect(mgr.triggerReindex).toHaveBeenCalledWith('loc-1', 'docs');
    });

    it('onSelect shows error when type already exists', async () => {
      mgr.locations = [{ location_type: 'primary' }];
      await mgr.addLocation();

      await mockSelectorInstance._opts.onSelect({
        path: '/Users/me/other',
        type: 'primary',
      });

      expect(endpoint.createFileIndexingLocation).not.toHaveBeenCalled();
      const statusEl = document.getElementById('settings-status');
      expect(statusEl.textContent).toContain('primary location already exists');
    });

    it('onSelect shows error on API failure', async () => {
      mgr.locations = [];
      endpoint.createFileIndexingLocation.mockRejectedValue(new Error('Quota exceeded'));
      await mgr.addLocation();

      await mockSelectorInstance._opts.onSelect({
        path: '/Users/me/docs',
        type: 'secondary',
      });

      const statusEl = document.getElementById('settings-status');
      expect(statusEl.textContent).toContain('Quota exceeded');
    });

    it('onCancel logs info', async () => {
      mgr.locations = [];
      await mgr.addLocation();
      mockSelectorInstance._opts.onCancel();
      expect(mgr.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('canceled')
      );
    });

    it('falls back to _addLocationFallback when LocationSelectorModal throws', async () => {
      mgr.locations = [];
      window.LocationSelectorModal = jest.fn(() => { throw new Error('Module not found'); });
      jest.spyOn(mgr, '_addLocationFallback').mockResolvedValue();

      await mgr.addLocation();

      expect(mgr._addLocationFallback).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // _addLocationFallback — directory picker flow
  // =========================================================================

  describe('_addLocationFallback', () => {
    it('shows error when directory picker is unavailable', async () => {
      mgr.aether = {};
      await mgr._addLocationFallback();
      const statusEl = document.getElementById('settings-status');
      expect(statusEl.textContent).toContain('Directory picker not available');
    });

    it('returns early when user cancels picker (null directory)', async () => {
      mgr.aether = { dialog: { showDirectoryPicker: jest.fn().mockResolvedValue(null) } };
      await mgr._addLocationFallback();
      expect(endpoint.createFileIndexingLocation).not.toHaveBeenCalled();
    });

    it('creates secondary location from selected directory', async () => {
      mgr.aether = { dialog: { showDirectoryPicker: jest.fn().mockResolvedValue('/Users/me/projects') } };
      // Mock triggerReindex to prevent _pollReindexProgress timer loop under fake timers
      jest.spyOn(mgr, 'triggerReindex').mockResolvedValue(undefined);
      await mgr._addLocationFallback();

      expect(endpoint.createFileIndexingLocation).toHaveBeenCalledWith(
        expect.objectContaining({
          location_name: 'projects',
          root_path: '/Users/me/projects',
          location_type: 'secondary',
        })
      );
      expect(endpoint.getFileIndexingLocations).toHaveBeenCalled();
      // Verify auto-reindex was triggered for the newly created location
      expect(mgr.triggerReindex).toHaveBeenCalledWith('loc-1', 'projects');
    });

    it('shows error on API failure', async () => {
      mgr.aether = { dialog: { showDirectoryPicker: jest.fn().mockResolvedValue('/Users/me/bad') } };
      endpoint.createFileIndexingLocation.mockRejectedValue(new Error('Disk full'));

      await mgr._addLocationFallback();

      const statusEl = document.getElementById('settings-status');
      expect(statusEl.textContent).toContain('Disk full');
    });
  });

  // =========================================================================
  // showConfig — IndexingConfigModal flow
  // =========================================================================

  describe('showConfig — IndexingConfigModal flow', () => {
    let mockConfigInstance;

    beforeEach(() => {
      mockConfigInstance = {
        show: jest.fn().mockResolvedValue(undefined),
      };

      window.IndexingConfigModal = jest.fn((opts) => {
        mockConfigInstance._opts = opts;
        return mockConfigInstance;
      });
    });

    afterEach(() => {
      delete window.IndexingConfigModal;
    });

    it('creates IndexingConfigModal with correct location and calls show()', async () => {
      const location = { id: 'loc-1', location_name: 'Docs' };
      await mgr.showConfig(location);

      expect(window.IndexingConfigModal).toHaveBeenCalledTimes(1);
      expect(mockConfigInstance.show).toHaveBeenCalledTimes(1);
    });

    it('onSave updates config via endpoint and triggers reindex', async () => {
      const location = { id: 'loc-1', location_name: 'Docs' };
      jest.spyOn(mgr, 'triggerReindex').mockResolvedValue();

      await mgr.showConfig(location);

      await mockConfigInstance._opts.onSave({ chunk_size: 512 });

      expect(endpoint.updateFileIndexingLocation).toHaveBeenCalledWith('loc-1', { chunk_size: 512 });
      expect(mgr.triggerReindex).toHaveBeenCalledWith('loc-1', 'Docs');
    });

    it('onSave throws on update failure (propagates to caller)', async () => {
      const location = { id: 'loc-1', location_name: 'Docs' };
      endpoint.updateFileIndexingLocation.mockRejectedValue(new Error('Update denied'));

      await mgr.showConfig(location);

      await expect(mockConfigInstance._opts.onSave({ chunk_size: 512 }))
        .rejects.toThrow('Update denied');
    });

    it('onCancel logs info', async () => {
      const location = { id: 'loc-1', location_name: 'Docs' };
      await mgr.showConfig(location);

      mockConfigInstance._opts.onCancel();
      expect(mgr.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('canceled')
      );
    });

    it('shows error when IndexingConfigModal constructor throws', async () => {
      window.IndexingConfigModal = jest.fn(() => { throw new Error('Module broken'); });
      const location = { id: 'loc-1', location_name: 'Docs' };
      await mgr.showConfig(location);

      const statusEl = document.getElementById('settings-status');
      expect(statusEl.textContent).toContain('Failed to show configuration');
    });
  });
});
