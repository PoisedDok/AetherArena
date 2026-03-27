'use strict';

// ---------------------------------------------------------------------------
// ToolStateManager.js — Unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/main/modules/agents/components/state/ToolStateManager.js (343 lines)
// Dependencies: None (pure state management).
// ---------------------------------------------------------------------------

const ToolStateManager = require('../../../../src/renderer/main/modules/agents/components/state/ToolStateManager');

describe('ToolStateManager', () => {
  let manager;
  let logger;

  beforeEach(() => {
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    manager = new ToolStateManager({ logger });
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores logger', () => {
      expect(manager.logger).toBe(logger);
    });

    it('defaults logger to console', () => {
      const m = new ToolStateManager();
      expect(m.logger).toBe(console);
    });

    it('initializes _toolJobs as empty Map', () => {
      expect(manager._toolJobs).toBeInstanceOf(Map);
      expect(manager._toolJobs.size).toBe(0);
    });

    it('initializes _toolRunState as empty Map', () => {
      expect(manager._toolRunState).toBeInstanceOf(Map);
      expect(manager._toolRunState.size).toBe(0);
    });

    it('initializes _researchStatus as null', () => {
      expect(manager._researchStatus).toBeNull();
    });
  });

  // =========================================================================
  // prefetchJobs
  // =========================================================================

  describe('prefetchJobs', () => {
    let endpoint;
    let findAgent;

    beforeEach(() => {
      endpoint = {
        listAgentHistory: jest.fn().mockResolvedValue({
          history: [
            { id: 'j1', status: 'completed', created_at: '2026-02-01T00:00:00Z' },
            { id: 'j2', status: 'running', created_at: '2026-02-02T00:00:00Z' },
          ],
        }),
      };
      findAgent = jest.fn().mockReturnValue({ agent_name: 'testing', enabled: true });
    });

    it('warns and returns when endpoint is null', async () => {
      await manager.prefetchJobs(null, ['testing'], findAgent);
      expect(logger.warn).toHaveBeenCalledWith(
        'ToolStateManager: Endpoint not available, skipping job prefetch'
      );
    });

    it('warns and returns when toolNames is empty', async () => {
      await manager.prefetchJobs(endpoint, [], findAgent);
      expect(logger.warn).toHaveBeenCalledWith(
        'ToolStateManager: No tool names provided for job prefetch'
      );
    });

    it('warns and returns when toolNames is not an array', async () => {
      await manager.prefetchJobs(endpoint, 'not-array', findAgent);
      expect(logger.warn).toHaveBeenCalledWith(
        'ToolStateManager: No tool names provided for job prefetch'
      );
    });

    it('sets empty jobs when agent not found', async () => {
      findAgent = jest.fn().mockReturnValue(null);
      await manager.prefetchJobs(endpoint, ['missing'], findAgent);
      expect(manager.getToolJobs('missing')).toEqual([]);
    });

    it('sets empty jobs when findAgentFn is null', async () => {
      await manager.prefetchJobs(endpoint, ['testing'], null);
      expect(manager.getToolJobs('testing')).toEqual([]);
    });

    it('calls listAgentHistory with agentName and limit', async () => {
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      expect(endpoint.listAgentHistory).toHaveBeenCalledWith({
        agentName: 'testing',
        limit: 10,
      });
    });

    it('stores jobs sorted by created_at descending', async () => {
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      const jobs = manager.getToolJobs('testing');
      // j2 (Feb 2) should come before j1 (Feb 1)
      expect(jobs[0].id).toBe('j2');
      expect(jobs[1].id).toBe('j1');
    });

    it('limits to 5 jobs', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: Array.from({ length: 8 }, (_, i) => ({
          id: `j${i}`,
          status: 'completed',
          created_at: new Date(2026, 1, i + 1).toISOString(),
        })),
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      expect(manager.getToolJobs('testing')).toHaveLength(5);
    });

    it('deduplicates jobs by ID keeping higher status priority', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'dup-1', status: 'running', created_at: '2026-02-01T00:00:00Z' },
          { id: 'dup-1', status: 'completed', created_at: '2026-02-01T00:00:00Z' },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      const jobs = manager.getToolJobs('testing');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe('completed');
    });

    it('skips jobs without id or job_id', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { status: 'completed', created_at: '2026-02-01T00:00:00Z' },
          { id: 'valid', status: 'completed', created_at: '2026-02-01T00:00:00Z' },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      expect(manager.getToolJobs('testing')).toHaveLength(1);
    });

    it('uses job_id when id is not present', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { job_id: 'jid-1', status: 'completed', created_at: '2026-02-01T00:00:00Z' },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      expect(manager.getToolJobs('testing')).toHaveLength(1);
    });

    it('handles response.jobs instead of response.history', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        jobs: [{ id: 'j1', status: 'completed', created_at: '2026-02-01T00:00:00Z' }],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      expect(manager.getToolJobs('testing')).toHaveLength(1);
    });

    it('handles raw array response', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue(
        [{ id: 'j1', status: 'completed', created_at: '2026-02-01T00:00:00Z' }]
      );
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      expect(manager.getToolJobs('testing')).toHaveLength(1);
    });

    it('handles non-array rawJobs', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({});
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      expect(manager.getToolJobs('testing')).toEqual([]);
    });

    it('syncs runState with active latest job', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'j1', status: 'running', created_at: '2026-02-02T00:00:00Z' },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      const runState = manager.getToolRunState('testing');
      expect(runState).not.toBeNull();
      expect(runState.status).toBe('running');
      expect(runState.job_id).toBe('j1');
    });

    it('syncs runState with completed latest job when no local run', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'j1', status: 'completed', created_at: '2026-02-02T00:00:00Z', time_ms: 5000 },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      const runState = manager.getToolRunState('testing');
      expect(runState).not.toBeNull();
      expect(runState.status).toBe('completed');
    });

    it('does NOT overwrite newer local run with older remote completed job', async () => {
      // Set a recent local run
      manager.recordToolRun('testing', { status: 'completed' });
      // The recordToolRun sets timestamp to now (2026-02-09 or later)

      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'j1', status: 'completed', created_at: '2020-01-01T00:00:00Z' },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      // The old remote job should not overwrite the newer local run
      const runState = manager.getToolRunState('testing');
      expect(runState.job_id).toBeUndefined(); // local run didn't have job_id
    });

    it('handles API error gracefully', async () => {
      endpoint.listAgentHistory = jest.fn().mockRejectedValue(new Error('API error'));
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      expect(manager.getToolJobs('testing')).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'ToolStateManager: Failed to prefetch tool jobs',
        expect.objectContaining({ agentName: 'testing', error: 'API error' })
      );
    });

    it('fetches multiple tools in parallel', async () => {
      findAgent = jest.fn().mockImplementation((name) => ({ agent_name: name }));
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({ history: [] });
      await manager.prefetchJobs(endpoint, ['testing', 'research'], findAgent);
      expect(endpoint.listAgentHistory).toHaveBeenCalledTimes(2);
    });

    it('logs info on successful prefetch', async () => {
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Prefetched')
      );
    });

    it('dedup status priority: completed > running', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'x', status: 'running', created_at: '2026-02-01T00:00:00Z' },
          { id: 'x', status: 'completed', created_at: '2026-02-01T00:00:00Z' },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      expect(manager.getToolJobs('testing')[0].status).toBe('completed');
    });

    it('dedup status priority: running > queued', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'x', status: 'queued', created_at: '2026-02-01T00:00:00Z' },
          { id: 'x', status: 'running', created_at: '2026-02-01T00:00:00Z' },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      expect(manager.getToolJobs('testing')[0].status).toBe('running');
    });

    it('handles unknown status with priority -1', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'x', status: 'unknown', created_at: '2026-02-01T00:00:00Z' },
          { id: 'x', status: 'pending', created_at: '2026-02-01T00:00:00Z' },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      // pending (priority 0) > unknown (priority -1)
      expect(manager.getToolJobs('testing')[0].status).toBe('pending');
    });

    // --- Branch coverage: dedup FALSE branch (existing wins) ---
    it('dedup: existing job wins when it has higher priority (FALSE branch)', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'x', status: 'completed', created_at: '2026-02-01T00:00:00Z' },
          { id: 'x', status: 'running', created_at: '2026-02-01T00:00:00Z' },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      const jobs = manager.getToolJobs('testing');
      expect(jobs).toHaveLength(1);
      // completed (5) is first, running (3) is second — running does NOT replace completed
      expect(jobs[0].status).toBe('completed');
    });

    it('dedup: equal priority does not replace (existing wins)', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'x', status: 'running', created_at: '2026-02-01T00:00:00Z', extra: 'first' },
          { id: 'x', status: 'running', created_at: '2026-02-01T00:00:00Z', extra: 'second' },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      const jobs = manager.getToolJobs('testing');
      expect(jobs).toHaveLength(1);
      // First stays because currentPriority (3) is NOT > existingPriority (3)
      expect(jobs[0].extra).toBe('first');
    });

    // --- Branch coverage: null/undefined job.status ---
    it('handles job with null status (treated as empty string, priority -1)', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'a', status: null, created_at: '2026-02-01T00:00:00Z' },
          { id: 'b', status: 'completed', created_at: '2026-02-02T00:00:00Z' },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      const jobs = manager.getToolJobs('testing');
      expect(jobs).toHaveLength(2);
      // Job with null status should still be stored (just has priority -1)
    });

    it('handles job with undefined status (treated as empty string, priority -1)', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'u', created_at: '2026-02-01T00:00:00Z' }, // no status field
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      expect(manager.getToolJobs('testing')).toHaveLength(1);
    });

    // --- Branch coverage: response is null/undefined ---
    it('handles null response from API (treats as empty array)', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue(null);
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      expect(manager.getToolJobs('testing')).toEqual([]);
    });

    it('handles undefined response from API (treats as empty array)', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue(undefined);
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      expect(manager.getToolJobs('testing')).toEqual([]);
    });

    // --- Branch coverage: active job sync using job_id (not id) ---
    it('syncs runState for active job using job_id when id is absent', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { job_id: 'jid-active', status: 'processing', created_at: '2026-02-02T00:00:00Z' },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      const runState = manager.getToolRunState('testing');
      expect(runState).not.toBeNull();
      expect(runState.status).toBe('processing');
      expect(runState.job_id).toBe('jid-active');
    });

    // --- Branch coverage: completed/failed job sync using job_id ---
    it('syncs runState for completed job using job_id when id is absent', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { job_id: 'jid-done', status: 'completed', created_at: '2026-02-02T00:00:00Z', time_ms: 7000 },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      const runState = manager.getToolRunState('testing');
      expect(runState).not.toBeNull();
      expect(runState.job_id).toBe('jid-done');
      expect(runState.time_ms).toBe(7000);
    });

    // --- Branch coverage: error without .message ---
    it('handles API rejection with string error (not Error instance)', async () => {
      endpoint.listAgentHistory = jest.fn().mockRejectedValue('raw string error');
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      expect(manager.getToolJobs('testing')).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'ToolStateManager: Failed to prefetch tool jobs',
        expect.objectContaining({ agentName: 'testing', error: 'raw string error' })
      );
    });

    // --- Branch coverage: dedup with null existing.status (line 91) ---
    it('dedup: existing job with null status gets replaced by higher priority', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'x', status: null, created_at: '2026-02-01T00:00:00Z' },
          { id: 'x', status: 'completed', created_at: '2026-02-01T00:00:00Z' },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      const jobs = manager.getToolJobs('testing');
      expect(jobs).toHaveLength(1);
      // null status → priority -1. completed → priority 5. 5 > -1 → replace.
      expect(jobs[0].status).toBe('completed');
    });

    // --- Branch coverage: sort with missing created_at (line 101) ---
    it('handles jobs with missing created_at in sort', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'a', status: 'completed' }, // no created_at
          { id: 'b', status: 'completed', created_at: '2026-02-01T00:00:00Z' },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      const jobs = manager.getToolJobs('testing');
      expect(jobs).toHaveLength(2);
      // Job with created_at should sort first (newer), job without should be last
      expect(jobs[0].id).toBe('b');
      expect(jobs[1].id).toBe('a');
    });

    it('handles sort when ALL jobs have no created_at (both || 0 branches)', async () => {
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'x', status: 'completed' },
          { id: 'y', status: 'failed' },
          { id: 'z', status: 'running' },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      const jobs = manager.getToolJobs('testing');
      // All 3 stored, sort order is stable when all dates are equal (epoch 0)
      expect(jobs).toHaveLength(3);
    });

    // --- BUG FIX verification: prefetchJobs sync preserves job timestamp ---
    it('BUG FIX: subsequent prefetch can sync newer remote job (timestamp preserved)', async () => {
      // Step 1: Sync job A (created Feb 1)
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'A', status: 'completed', created_at: '2026-02-01T00:00:00.000Z', time_ms: 1000 },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      const stateAfterA = manager.getToolRunState('testing');
      expect(stateAfterA.job_id).toBe('A');
      // With the fix, timestamp should be the job's created_at, NOT current time
      expect(stateAfterA.timestamp).toBe('2026-02-01T00:00:00.000Z');

      // Step 2: Sync job B (created Feb 5 — newer than A)
      endpoint.listAgentHistory = jest.fn().mockResolvedValue({
        history: [
          { id: 'B', status: 'completed', created_at: '2026-02-05T00:00:00.000Z', time_ms: 2000 },
        ],
      });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      const stateAfterB = manager.getToolRunState('testing');
      // Job B (Feb 5) is newer than local timestamp (Feb 1), so it SHOULD replace
      expect(stateAfterB.job_id).toBe('B');
      expect(stateAfterB.timestamp).toBe('2026-02-05T00:00:00.000Z');
    });
  });

  // =========================================================================
  // prefetchResearchStatus
  // =========================================================================

  describe('prefetchResearchStatus', () => {
    it('warns when endpoint is null', async () => {
      await manager.prefetchResearchStatus(null);
      expect(logger.warn).toHaveBeenCalledWith(
        'ToolStateManager: Endpoint not available, skipping research status'
      );
    });

    it('stores research status from endpoint', async () => {
      const endpoint = {
        getResearchStatus: jest.fn().mockResolvedValue({
          available: true,
          available_sources: { ai_mode: ['perplexica'] },
        }),
      };
      await manager.prefetchResearchStatus(endpoint);
      expect(manager.getResearchStatus()).toEqual({
        available: true,
        available_sources: { ai_mode: ['perplexica'] },
      });
      expect(logger.info).toHaveBeenCalledWith('ToolStateManager: Prefetched research status');
    });

    it('sets null on error (fail-soft)', async () => {
      const endpoint = {
        getResearchStatus: jest.fn().mockRejectedValue(new Error('fail')),
      };
      await manager.prefetchResearchStatus(endpoint);
      expect(manager.getResearchStatus()).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'ToolStateManager: Failed to prefetch research status',
        expect.objectContaining({ error: 'fail' })
      );
    });

    it('handles string error in prefetchResearchStatus (error?.message || error)', async () => {
      const endpoint = {
        getResearchStatus: jest.fn().mockRejectedValue('raw string rejection'),
      };
      await manager.prefetchResearchStatus(endpoint);
      expect(manager.getResearchStatus()).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'ToolStateManager: Failed to prefetch research status',
        expect.objectContaining({ error: 'raw string rejection' })
      );
    });
  });

  // =========================================================================
  // prefetchAll
  // =========================================================================

  describe('prefetchAll', () => {
    it('calls prefetchJobs and prefetchResearchStatus in parallel', async () => {
      const jobsSpy = jest.spyOn(manager, 'prefetchJobs').mockResolvedValue();
      const statusSpy = jest.spyOn(manager, 'prefetchResearchStatus').mockResolvedValue();
      const endpoint = {};
      const findAgent = jest.fn();

      await manager.prefetchAll(endpoint, ['testing'], findAgent);
      expect(jobsSpy).toHaveBeenCalledWith(endpoint, ['testing'], findAgent);
      expect(statusSpy).toHaveBeenCalledWith(endpoint);

      jobsSpy.mockRestore();
      statusSpy.mockRestore();
    });
  });

  // =========================================================================
  // getToolJobs / setToolJobs
  // =========================================================================

  describe('getToolJobs / setToolJobs', () => {
    it('returns empty array for unknown tool', () => {
      expect(manager.getToolJobs('unknown')).toEqual([]);
    });

    it('stores and retrieves jobs', () => {
      const jobs = [{ id: 'j1' }, { id: 'j2' }];
      manager.setToolJobs('testing', jobs);
      expect(manager.getToolJobs('testing')).toEqual(jobs);
    });

    it('setToolJobs ignores falsy toolName', () => {
      manager.setToolJobs(null, [{ id: 'j1' }]);
      expect(manager._toolJobs.size).toBe(0);
    });

    it('setToolJobs defaults to empty array when jobs is null', () => {
      manager.setToolJobs('testing', null);
      expect(manager.getToolJobs('testing')).toEqual([]);
    });
  });

  // =========================================================================
  // getToolRunState / recordToolRun
  // =========================================================================

  describe('getToolRunState / recordToolRun', () => {
    it('returns null for unknown tool', () => {
      expect(manager.getToolRunState('unknown')).toBeNull();
    });

    it('records and retrieves run state', () => {
      manager.recordToolRun('testing', { status: 'running' });
      const state = manager.getToolRunState('testing');
      expect(state.status).toBe('running');
      expect(state.timestamp).toBeDefined();
    });

    it('returns the recorded entry', () => {
      const result = manager.recordToolRun('testing', { status: 'completed', time_ms: 3000 });
      expect(result.status).toBe('completed');
      expect(result.time_ms).toBe(3000);
      expect(result.timestamp).toBeDefined();
    });

    it('overwrites previous run state', () => {
      manager.recordToolRun('testing', { status: 'running' });
      manager.recordToolRun('testing', { status: 'completed', time_ms: 5000 });
      expect(manager.getToolRunState('testing').status).toBe('completed');
    });

    it('warns and returns null when toolName is falsy', () => {
      expect(manager.recordToolRun(null, { status: 'running' })).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'ToolStateManager: Cannot record tool run without toolName'
      );
    });

    it('logs info on successful record', () => {
      manager.recordToolRun('testing', { status: 'running' });
      expect(logger.info).toHaveBeenCalledWith(
        'ToolStateManager: Recorded run for testing',
        { status: 'running' }
      );
    });

    it('spreads all payload fields into entry', () => {
      const result = manager.recordToolRun('research', {
        status: 'completed',
        time_ms: 1000,
        sources_used: 3,
        results: { key: 'val' },
        output_id: 'out-1',
        entity_id: 'ent-1',
      });
      expect(result.time_ms).toBe(1000);
      expect(result.sources_used).toBe(3);
      expect(result.output_id).toBe('out-1');
      expect(result.entity_id).toBe('ent-1');
    });
  });

  // =========================================================================
  // convenience methods
  // =========================================================================

  describe('markToolRunning', () => {
    it('records running state', () => {
      manager.markToolRunning('testing');
      expect(manager.getToolRunState('testing').status).toBe('running');
    });

    it('ignores falsy toolName', () => {
      manager.markToolRunning(null);
      expect(manager._toolRunState.size).toBe(0);
    });
  });

  describe('markToolCompleted', () => {
    it('records completed state', () => {
      manager.markToolCompleted('testing');
      expect(manager.getToolRunState('testing').status).toBe('completed');
    });

    it('includes result data', () => {
      manager.markToolCompleted('testing', { time_ms: 2000, sources_used: 5 });
      const state = manager.getToolRunState('testing');
      expect(state.time_ms).toBe(2000);
      expect(state.sources_used).toBe(5);
    });

    it('ignores falsy toolName', () => {
      manager.markToolCompleted('');
      expect(manager._toolRunState.size).toBe(0);
    });
  });

  describe('markToolFailed', () => {
    it('records failed state with Error instance', () => {
      manager.markToolFailed('testing', new Error('timeout'));
      const state = manager.getToolRunState('testing');
      expect(state.status).toBe('failed');
      expect(state.error).toBe('timeout');
    });

    it('records failed state with string error', () => {
      manager.markToolFailed('testing', 'something broke');
      expect(manager.getToolRunState('testing').error).toBe('something broke');
    });

    it('ignores falsy toolName', () => {
      manager.markToolFailed(null, new Error('x'));
      expect(manager._toolRunState.size).toBe(0);
    });
  });

  // =========================================================================
  // research status
  // =========================================================================

  describe('getResearchStatus / setResearchStatus', () => {
    it('returns null initially', () => {
      expect(manager.getResearchStatus()).toBeNull();
    });

    it('stores and retrieves status', () => {
      const status = { available: true };
      manager.setResearchStatus(status);
      expect(manager.getResearchStatus()).toBe(status);
    });

    it('can be set to null', () => {
      manager.setResearchStatus({ available: true });
      manager.setResearchStatus(null);
      expect(manager.getResearchStatus()).toBeNull();
    });
  });

  // =========================================================================
  // clearToolRunState / clearAllRunStates
  // =========================================================================

  describe('clearToolRunState', () => {
    it('removes run state for specific tool', () => {
      manager.recordToolRun('testing', { status: 'completed' });
      manager.recordToolRun('research', { status: 'running' });
      manager.clearToolRunState('testing');
      expect(manager.getToolRunState('testing')).toBeNull();
      expect(manager.getToolRunState('research')).not.toBeNull();
    });

    it('ignores falsy toolName', () => {
      manager.recordToolRun('testing', { status: 'completed' });
      manager.clearToolRunState(null);
      expect(manager.getToolRunState('testing')).not.toBeNull();
    });
  });

  describe('clearAllRunStates', () => {
    it('removes all run states', () => {
      manager.recordToolRun('a', { status: 'completed' });
      manager.recordToolRun('b', { status: 'running' });
      manager.clearAllRunStates();
      expect(manager._toolRunState.size).toBe(0);
    });
  });

  // =========================================================================
  // reset
  // =========================================================================

  describe('reset', () => {
    it('clears all state', () => {
      manager.setToolJobs('testing', [{ id: 'j1' }]);
      manager.recordToolRun('testing', { status: 'completed' });
      manager.setResearchStatus({ available: true });

      manager.reset();

      expect(manager._toolJobs.size).toBe(0);
      expect(manager._toolRunState.size).toBe(0);
      expect(manager._researchStatus).toBeNull();
    });

    it('safe on fresh instance', () => {
      expect(() => manager.reset()).not.toThrow();
    });
  });

  // =========================================================================
  // getToolNamesWithJobs / getToolNamesWithRunState
  // =========================================================================

  describe('getToolNamesWithJobs', () => {
    it('returns empty array when no jobs', () => {
      expect(manager.getToolNamesWithJobs()).toEqual([]);
    });

    it('returns tool names with cached jobs', () => {
      manager.setToolJobs('testing', []);
      manager.setToolJobs('research', []);
      const names = manager.getToolNamesWithJobs();
      expect(names).toContain('testing');
      expect(names).toContain('research');
    });
  });

  describe('getToolNamesWithRunState', () => {
    it('returns empty array when no run state', () => {
      expect(manager.getToolNamesWithRunState()).toEqual([]);
    });

    it('returns tool names with run state', () => {
      manager.recordToolRun('testing', { status: 'running' });
      expect(manager.getToolNamesWithRunState()).toContain('testing');
    });
  });

  // =========================================================================
  // edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('prefetchJobs handles job with metadata.time_ms', async () => {
      const endpoint = {
        listAgentHistory: jest.fn().mockResolvedValue({
          history: [
            { id: 'j1', status: 'completed', created_at: '2026-02-01T00:00:00Z', metadata: { time_ms: 3000 } },
          ],
        }),
      };
      const findAgent = jest.fn().mockReturnValue({ agent_name: 'testing' });
      await manager.prefetchJobs(endpoint, ['testing'], findAgent);
      const runState = manager.getToolRunState('testing');
      expect(runState.time_ms).toBe(3000);
    });

    it('recordToolRun adds timestamp automatically', () => {
      const entry = manager.recordToolRun('tool', { status: 'running' });
      expect(entry.timestamp).toBeDefined();
      // Should be an ISO string
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    });

    it('recordToolRun preserves caller-provided timestamp (BUG FIX)', () => {
      // When caller explicitly provides timestamp (e.g., prefetchJobs syncing a remote job),
      // recordToolRun must honor it. Previously, auto-timestamp always overwrote, breaking
      // the "don't overwrite newer local run" comparison in prefetchJobs line 121.
      const entry = manager.recordToolRun('tool', { status: 'running', timestamp: '2026-01-15T00:00:00.000Z' });
      expect(entry.timestamp).toBe('2026-01-15T00:00:00.000Z');
    });

    it('recordToolRun auto-generates timestamp when not provided in payload', () => {
      const entry = manager.recordToolRun('tool', { status: 'running' });
      // Auto-generated timestamp should be a recent ISO string
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
      expect(new Date(entry.timestamp).getTime()).toBeGreaterThan(Date.now() - 5000);
    });
  });
});
