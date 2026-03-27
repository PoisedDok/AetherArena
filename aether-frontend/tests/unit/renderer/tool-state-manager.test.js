'use strict';

const ToolStateManager = require(
  '../../../src/renderer/main/modules/agents/components/state/ToolStateManager'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function createMockEndpoint(overrides = {}) {
  return {
    listAgentHistory: jest.fn().mockResolvedValue(
      overrides.history || { history: [] }
    ),
    getResearchStatus: jest.fn().mockResolvedValue(
      overrides.researchStatus || { perplexica: true, searxng: true }
    ),
  };
}

function makeJob(id, status, createdAt) {
  return { id, status, created_at: createdAt || '2026-01-01T00:00:00Z' };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ToolStateManager', () => {
  let sm;
  let logger;

  beforeEach(() => {
    logger = createLogger();
    sm = new ToolStateManager({ logger });
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('uses provided logger', () => {
      expect(sm.logger).toBe(logger);
    });

    it('falls back to console', () => {
      const s = new ToolStateManager();
      expect(s.logger).toBe(console);
    });

    it('initializes empty state', () => {
      expect(sm._toolJobs).toBeInstanceOf(Map);
      expect(sm._toolRunState).toBeInstanceOf(Map);
      expect(sm._researchStatus).toBeNull();
    });
  });

  // =========================================================================
  // prefetchJobs
  // =========================================================================

  describe('prefetchJobs', () => {
    let endpoint;
    const findAgent = (name) => ({ agent_name: name });

    beforeEach(() => {
      endpoint = createMockEndpoint();
    });

    it('warns and returns when endpoint is null', async () => {
      await sm.prefetchJobs(null, ['tool1'], findAgent);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Endpoint not available')
      );
    });

    it('warns and returns for empty toolNames', async () => {
      await sm.prefetchJobs(endpoint, [], findAgent);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('No tool names provided')
      );
    });

    it('warns and returns when toolNames is not an array', async () => {
      await sm.prefetchJobs(endpoint, 'not-array', findAgent);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('No tool names provided')
      );
    });

    it('sets empty jobs when agent is not found', async () => {
      await sm.prefetchJobs(endpoint, ['missing'], () => null);
      expect(sm.getToolJobs('missing')).toEqual([]);
    });

    it('sets empty jobs when findAgentFn is null', async () => {
      await sm.prefetchJobs(endpoint, ['noFn'], null);
      expect(sm.getToolJobs('noFn')).toEqual([]);
    });

    it('fetches and stores jobs for found agents', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [makeJob('j1', 'completed', '2026-01-02T00:00:00Z')],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      expect(sm.getToolJobs('scout').length).toBe(1);
      expect(sm.getToolJobs('scout')[0].id).toBe('j1');
    });

    it('uses response.jobs when history is absent', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        jobs: [makeJob('j2', 'completed')],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      expect(sm.getToolJobs('scout').length).toBe(1);
    });

    it('uses response directly when it is an array', async () => {
      endpoint.listAgentHistory.mockResolvedValue(
        [makeJob('j3', 'completed')]
      );
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      expect(sm.getToolJobs('scout').length).toBe(1);
    });

    it('handles non-array rawJobs gracefully', async () => {
      endpoint.listAgentHistory.mockResolvedValue('not-array');
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      expect(sm.getToolJobs('scout')).toEqual([]);
    });

    // --- Deduplication ---

    it('deduplicates jobs by id, keeping higher priority status', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [
          makeJob('j1', 'pending'),
          makeJob('j1', 'completed'),
        ],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      const jobs = sm.getToolJobs('scout');
      expect(jobs.length).toBe(1);
      expect(jobs[0].status).toBe('completed');
    });

    it('keeps original when duplicate has lower priority', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [
          makeJob('j1', 'completed'),
          makeJob('j1', 'pending'),
        ],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      expect(sm.getToolJobs('scout')[0].status).toBe('completed');
    });

    it('uses job_id when id is absent', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [
          { job_id: 'jx', status: 'completed', created_at: '2026-01-01' },
        ],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      expect(sm.getToolJobs('scout').length).toBe(1);
    });

    it('skips jobs without id or job_id', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [
          { status: 'completed', created_at: '2026-01-01' },
          makeJob('j1', 'completed'),
        ],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      expect(sm.getToolJobs('scout').length).toBe(1);
    });

    it('FIX VERIFIED: pending (priority 0) beats unknown (priority -1) after ?? fix', async () => {
      // BUG: || -1 treated pending (priority 0) as falsy, making it -1.
      // FIX: Changed to ?? -1 so 0 is correctly preserved.
      endpoint.listAgentHistory.mockResolvedValue({
        history: [
          makeJob('j1', 'unknown'),
          makeJob('j1', 'pending'),
        ],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      expect(sm.getToolJobs('scout')[0].status).toBe('pending');
    });

    it('sorts by created_at descending and limits to 5', async () => {
      const jobs = [];
      for (let i = 0; i < 8; i++) {
        jobs.push(makeJob(`j${i}`, 'completed', `2026-01-0${i + 1}T00:00:00Z`));
      }
      endpoint.listAgentHistory.mockResolvedValue({ history: jobs });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      const result = sm.getToolJobs('scout');
      expect(result.length).toBe(5);
      expect(result[0].id).toBe('j7'); // latest
    });

    // --- Run state sync ---

    it('records run state for active latest job', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [makeJob('j1', 'running', '2026-02-01T00:00:00Z')],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      const run = sm.getToolRunState('scout');
      expect(run).not.toBeNull();
      expect(run.status).toBe('running');
    });

    it('records run state for completed latest job when no current run', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [makeJob('j1', 'completed', '2026-02-01T00:00:00Z')],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      const run = sm.getToolRunState('scout');
      expect(run.status).toBe('completed');
    });

    it('syncs completed job with time_ms from metadata', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [{
          id: 'j1', status: 'completed',
          created_at: '2026-02-01T00:00:00Z',
          metadata: { time_ms: 1500 },
        }],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      const run = sm.getToolRunState('scout');
      expect(run.time_ms).toBe(1500);
    });

    it('does not overwrite newer local run state with older job', async () => {
      // Set a recent local run
      sm.recordToolRun('scout', { status: 'completed' });

      endpoint.listAgentHistory.mockResolvedValue({
        history: [makeJob('j1', 'completed', '2020-01-01T00:00:00Z')],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      const run = sm.getToolRunState('scout');
      // Should keep the local run (newer timestamp)
      expect(run.job_id).toBeUndefined(); // local run had no job_id
    });

    it('syncs failed latest job when no current run state', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [makeJob('j1', 'failed', '2026-02-01T00:00:00Z')],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      const run = sm.getToolRunState('scout');
      expect(run.status).toBe('failed');
    });

    it('uses job.time_ms over metadata.time_ms when both present', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [{
          id: 'j1', status: 'completed', created_at: '2026-02-01',
          time_ms: 200, metadata: { time_ms: 300 },
        }],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      expect(sm.getToolRunState('scout').time_ms).toBe(200);
    });

    it('handles job with no status gracefully', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [{ id: 'j1', created_at: '2026-01-01' }],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      expect(sm.getToolJobs('scout').length).toBe(1);
    });

    it('handles response with null history and null jobs', async () => {
      endpoint.listAgentHistory.mockResolvedValue({ history: null, jobs: null });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      expect(sm.getToolJobs('scout')).toEqual([]);
    });

    it('handles undefined/null response (line 65 fallback to [])', async () => {
      endpoint.listAgentHistory.mockResolvedValue(null);
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      expect(sm.getToolJobs('scout')).toEqual([]);
    });

    it('sorts correctly when created_at is missing (|| 0 branch)', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [
          { id: 'j1', status: 'completed' },
          { id: 'j2', status: 'completed', created_at: '2026-01-01' },
        ],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      expect(sm.getToolJobs('scout').length).toBe(2);
    });

    it('syncs active job using job_id when id is absent (line 115)', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [{ job_id: 'jx', status: 'running', created_at: '2026-02-01' }],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      const run = sm.getToolRunState('scout');
      expect(run.status).toBe('running');
      expect(run.job_id).toBe('jx');
    });

    it('covers error?.message || error fallback (line 136) when error is a string', async () => {
      endpoint.listAgentHistory.mockRejectedValue('raw string error');
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      expect(logger.warn).toHaveBeenCalledWith(
        'ToolStateManager: Failed to prefetch tool jobs',
        expect.objectContaining({ error: 'raw string error' })
      );
    });

    it('deduplicates with both statuses missing (falsy status branch)', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [
          { id: 'j1', created_at: '2026-01-01' },
          { id: 'j1', status: null, created_at: '2026-01-02' },
        ],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      // Both have priority -1. First stays (no replacement when equal).
      expect(sm.getToolJobs('scout').length).toBe(1);
    });

    it('syncs completed job that uses job_id fallback (line 115/124)', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [{ job_id: 'jx', status: 'completed', created_at: '2026-02-01' }],
      });
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      const run = sm.getToolRunState('scout');
      expect(run.job_id).toBe('jx');
    });

    it('fetches for multiple tool names in parallel', async () => {
      endpoint.listAgentHistory.mockResolvedValue({
        history: [makeJob('j1', 'completed')],
      });
      await sm.prefetchJobs(endpoint, ['a', 'b'], findAgent);
      expect(sm.getToolJobs('a').length).toBe(1);
      expect(sm.getToolJobs('b').length).toBe(1);
    });

    it('catches fetch error and sets empty jobs', async () => {
      endpoint.listAgentHistory.mockRejectedValue(new Error('net'));
      await sm.prefetchJobs(endpoint, ['scout'], findAgent);
      expect(sm.getToolJobs('scout')).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'ToolStateManager: Failed to prefetch tool jobs',
        expect.objectContaining({ agentName: 'scout' })
      );
    });
  });

  // =========================================================================
  // prefetchResearchStatus
  // =========================================================================

  describe('prefetchResearchStatus', () => {
    it('warns when endpoint is null', async () => {
      await sm.prefetchResearchStatus(null);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Endpoint not available')
      );
    });

    it('stores research status on success', async () => {
      const ep = createMockEndpoint();
      await sm.prefetchResearchStatus(ep);
      expect(sm.getResearchStatus()).toEqual({ perplexica: true, searxng: true });
    });

    it('sets null on failure and logs warning', async () => {
      const ep = createMockEndpoint();
      ep.getResearchStatus.mockRejectedValue(new Error('down'));
      await sm.prefetchResearchStatus(ep);
      expect(sm.getResearchStatus()).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'ToolStateManager: Failed to prefetch research status',
        expect.objectContaining({ error: 'down' })
      );
    });

    it('covers error?.message || error fallback (line 161) when error is a string', async () => {
      const ep = createMockEndpoint();
      ep.getResearchStatus.mockRejectedValue('raw string');
      await sm.prefetchResearchStatus(ep);
      expect(logger.warn).toHaveBeenCalledWith(
        'ToolStateManager: Failed to prefetch research status',
        expect.objectContaining({ error: 'raw string' })
      );
    });
  });

  // =========================================================================
  // prefetchAll
  // =========================================================================

  describe('prefetchAll', () => {
    it('calls both prefetchJobs and prefetchResearchStatus', async () => {
      const spy1 = jest.spyOn(sm, 'prefetchJobs').mockResolvedValue(undefined);
      const spy2 = jest.spyOn(sm, 'prefetchResearchStatus').mockResolvedValue(undefined);
      const ep = createMockEndpoint();

      await sm.prefetchAll(ep, ['t1'], () => null);

      expect(spy1).toHaveBeenCalledWith(ep, ['t1'], expect.any(Function));
      expect(spy2).toHaveBeenCalledWith(ep);
    });
  });

  // =========================================================================
  // getToolJobs / setToolJobs
  // =========================================================================

  describe('getToolJobs / setToolJobs', () => {
    it('returns empty array for unknown tool', () => {
      expect(sm.getToolJobs('unknown')).toEqual([]);
    });

    it('stores and retrieves jobs', () => {
      sm.setToolJobs('scout', [{ id: 1 }]);
      expect(sm.getToolJobs('scout')).toEqual([{ id: 1 }]);
    });

    it('defaults to empty array when jobs is null', () => {
      sm.setToolJobs('scout', null);
      expect(sm.getToolJobs('scout')).toEqual([]);
    });

    it('setToolJobs ignores falsy toolName', () => {
      sm.setToolJobs('', [{ id: 1 }]);
      expect(sm._toolJobs.size).toBe(0);
    });
  });

  // =========================================================================
  // recordToolRun
  // =========================================================================

  describe('recordToolRun', () => {
    it('records entry with timestamp and returns it', () => {
      const entry = sm.recordToolRun('scout', { status: 'running' });
      expect(entry.status).toBe('running');
      expect(entry.timestamp).toBeDefined();
    });

    it('stores entry in _toolRunState', () => {
      sm.recordToolRun('scout', { status: 'completed' });
      expect(sm.getToolRunState('scout').status).toBe('completed');
    });

    it('warns and returns null for falsy toolName', () => {
      const result = sm.recordToolRun('', { status: 'running' });
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cannot record tool run without toolName')
      );
    });

    it('logs info with tool name and status', () => {
      sm.recordToolRun('scout', { status: 'failed' });
      expect(logger.info).toHaveBeenCalledWith(
        'ToolStateManager: Recorded run for scout',
        { status: 'failed' }
      );
    });
  });

  // =========================================================================
  // convenience methods
  // =========================================================================

  describe('markToolRunning', () => {
    it('records running status', () => {
      sm.markToolRunning('scout');
      expect(sm.getToolRunState('scout').status).toBe('running');
    });

    it('ignores falsy toolName', () => {
      sm.markToolRunning('');
      expect(sm._toolRunState.size).toBe(0);
    });
  });

  describe('markToolCompleted', () => {
    it('records completed status with result data', () => {
      sm.markToolCompleted('scout', { time_ms: 500, sources_used: 3 });
      const run = sm.getToolRunState('scout');
      expect(run.status).toBe('completed');
      expect(run.time_ms).toBe(500);
      expect(run.sources_used).toBe(3);
    });

    it('defaults result to empty object', () => {
      sm.markToolCompleted('scout');
      expect(sm.getToolRunState('scout').status).toBe('completed');
    });

    it('ignores falsy toolName', () => {
      sm.markToolCompleted(null);
      expect(sm._toolRunState.size).toBe(0);
    });
  });

  describe('markToolFailed', () => {
    it('records failed status with Error message', () => {
      sm.markToolFailed('scout', new Error('timeout'));
      expect(sm.getToolRunState('scout').error).toBe('timeout');
    });

    it('records failed status with string error', () => {
      sm.markToolFailed('scout', 'connection refused');
      expect(sm.getToolRunState('scout').error).toBe('connection refused');
    });

    it('ignores falsy toolName', () => {
      sm.markToolFailed('');
      expect(sm._toolRunState.size).toBe(0);
    });
  });

  // =========================================================================
  // research status
  // =========================================================================

  describe('getResearchStatus / setResearchStatus', () => {
    it('returns null initially', () => {
      expect(sm.getResearchStatus()).toBeNull();
    });

    it('stores and retrieves research status', () => {
      sm.setResearchStatus({ perplexica: false });
      expect(sm.getResearchStatus()).toEqual({ perplexica: false });
    });
  });

  // =========================================================================
  // clear methods
  // =========================================================================

  describe('clearToolRunState', () => {
    it('removes run state for specific tool', () => {
      sm.recordToolRun('scout', { status: 'running' });
      sm.clearToolRunState('scout');
      expect(sm.getToolRunState('scout')).toBeNull();
    });

    it('ignores falsy toolName', () => {
      sm.recordToolRun('scout', { status: 'running' });
      sm.clearToolRunState('');
      expect(sm.getToolRunState('scout')).not.toBeNull();
    });
  });

  describe('clearAllRunStates', () => {
    it('removes all run states', () => {
      sm.recordToolRun('a', { status: 'running' });
      sm.recordToolRun('b', { status: 'completed' });
      sm.clearAllRunStates();
      expect(sm._toolRunState.size).toBe(0);
    });
  });

  // =========================================================================
  // reset
  // =========================================================================

  describe('reset', () => {
    it('clears all state', () => {
      sm.setToolJobs('scout', [{ id: 1 }]);
      sm.recordToolRun('scout', { status: 'running' });
      sm.setResearchStatus({ ok: true });

      sm.reset();

      expect(sm._toolJobs.size).toBe(0);
      expect(sm._toolRunState.size).toBe(0);
      expect(sm._researchStatus).toBeNull();
    });
  });

  // =========================================================================
  // query methods
  // =========================================================================

  describe('getToolNamesWithJobs', () => {
    it('returns tool names that have cached jobs', () => {
      sm.setToolJobs('a', []);
      sm.setToolJobs('b', [{ id: 1 }]);
      expect(sm.getToolNamesWithJobs().sort()).toEqual(['a', 'b']);
    });
  });

  describe('getToolNamesWithRunState', () => {
    it('returns tool names that have run state', () => {
      sm.recordToolRun('x', { status: 'running' });
      sm.recordToolRun('y', { status: 'completed' });
      expect(sm.getToolNamesWithRunState().sort()).toEqual(['x', 'y']);
    });
  });

  // =========================================================================
  // exports
  // =========================================================================

  describe('exports', () => {
    it('assigns ToolStateManager to window', () => {
      expect(window.ToolStateManager).toBe(ToolStateManager);
    });
  });
});
