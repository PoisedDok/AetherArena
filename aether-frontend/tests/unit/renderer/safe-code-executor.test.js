'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => mockLogger),
}));

const SafeCodeExecutor = require('../../../src/renderer/artifacts/modules/execution/SafeCodeExecutor');

// ---------------------------------------------------------------------------
// Worker mock infrastructure
// ---------------------------------------------------------------------------

/**
 * Creates a mock Worker that stores handlers and exposes trigger helpers.
 * Each test can control exactly what the "worker" sends back.
 */
function createMockWorker() {
  const worker = {
    onmessage: null,
    onerror: null,
    postMessage: jest.fn(),
    terminate: jest.fn(),
    // Test helpers
    _triggerMessage(data) {
      if (worker.onmessage) {
        worker.onmessage({ data });
      }
    },
    _triggerError(error) {
      if (worker.onerror) {
        worker.onerror(error);
      }
    },
  };
  return worker;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SafeCodeExecutor', () => {
  let mockWorkerInstance;
  let originalWorker;
  let originalBlob;
  let originalCreateObjectURL;
  let originalRevokeObjectURL;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockWorkerInstance = createMockWorker();

    // Save originals
    originalWorker = global.Worker;
    originalBlob = global.Blob;
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;

    // Mock Worker constructor
    global.Worker = jest.fn(() => mockWorkerInstance);

    // Mock Blob (jsdom has it, but ensure it's predictable)
    global.Blob = jest.fn(() => ({ type: 'application/javascript' }));

    // Mock URL methods
    URL.createObjectURL = jest.fn(() => 'blob:mock-url');
    URL.revokeObjectURL = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.Worker = originalWorker;
    global.Blob = originalBlob;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // constructor
  // ═══════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('sets default timeout of 5000ms', () => {
      const executor = new SafeCodeExecutor();
      expect(executor.timeout).toBe(5000);
    });

    it('accepts custom timeout', () => {
      const executor = new SafeCodeExecutor({ timeout: 10000 });
      expect(executor.timeout).toBe(10000);
    });

    it('clamps timeout to MAX_TIMEOUT (30000ms)', () => {
      const executor = new SafeCodeExecutor({ timeout: 60000 });
      expect(executor.timeout).toBe(30000);
    });

    it('initializes worker as null', () => {
      const executor = new SafeCodeExecutor();
      expect(executor.worker).toBeNull();
    });

    it('initializes pendingExecution as null', () => {
      const executor = new SafeCodeExecutor();
      expect(executor.pendingExecution).toBeNull();
    });

    it('stores logger reference', () => {
      const executor = new SafeCodeExecutor();
      expect(executor.log).toBe(mockLogger);
    });

    it('uses default timeout when options.timeout is 0 (falsy)', () => {
      const executor = new SafeCodeExecutor({ timeout: 0 });
      // 0 || 5000 = 5000, Math.min(5000, 30000) = 5000
      expect(executor.timeout).toBe(5000);
    });

    it('defaults to empty object when no options provided', () => {
      const executor = new SafeCodeExecutor();
      expect(executor.timeout).toBe(5000);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // executeJavaScript — successful execution
  // ═══════════════════════════════════════════════════════════════════════

  describe('executeJavaScript — success', () => {
    let executor;

    beforeEach(() => {
      executor = new SafeCodeExecutor();
    });

    it('creates a Blob with worker code', async () => {
      const promise = executor.executeJavaScript('1 + 1');
      mockWorkerInstance._triggerMessage({ type: 'result', data: { result: 2 } });
      await promise;

      expect(global.Blob).toHaveBeenCalledWith(
        [expect.any(String)],
        { type: 'application/javascript' }
      );
    });

    it('creates object URL from blob', async () => {
      const promise = executor.executeJavaScript('1 + 1');
      mockWorkerInstance._triggerMessage({ type: 'result', data: { result: 2 } });
      await promise;

      expect(URL.createObjectURL).toHaveBeenCalled();
    });

    it('creates Worker with blob URL', async () => {
      const promise = executor.executeJavaScript('1 + 1');
      mockWorkerInstance._triggerMessage({ type: 'result', data: { result: 2 } });
      await promise;

      expect(global.Worker).toHaveBeenCalledWith('blob:mock-url');
    });

    it('sends code to worker via postMessage', async () => {
      const promise = executor.executeJavaScript('2 + 2');
      mockWorkerInstance._triggerMessage({ type: 'result', data: { result: 4 } });
      await promise;

      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith({
        type: 'execute',
        code: '2 + 2',
      });
    });

    it('resolves with success result', async () => {
      const promise = executor.executeJavaScript('1 + 1');
      mockWorkerInstance._triggerMessage({
        type: 'result',
        data: { result: 2 },
      });

      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.result).toBe(2);
      expect(result.logs).toEqual([]);
      expect(typeof result.executionTime).toBe('number');
    });

    it('terminates worker after result', async () => {
      const promise = executor.executeJavaScript('x');
      mockWorkerInstance._triggerMessage({ type: 'result', data: { result: 'x' } });
      await promise;

      expect(mockWorkerInstance.terminate).toHaveBeenCalled();
    });

    it('nulls worker reference after result', async () => {
      const promise = executor.executeJavaScript('x');
      mockWorkerInstance._triggerMessage({ type: 'result', data: { result: 'x' } });
      await promise;

      expect(executor.worker).toBeNull();
    });

    it('revokes object URL after result', async () => {
      const promise = executor.executeJavaScript('x');
      mockWorkerInstance._triggerMessage({ type: 'result', data: { result: 'x' } });
      await promise;

      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    });

    it('stores worker reference during execution', () => {
      executor.executeJavaScript('x');
      expect(executor.worker).toBe(mockWorkerInstance);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // executeJavaScript — log collection
  // ═══════════════════════════════════════════════════════════════════════

  describe('executeJavaScript — log collection', () => {
    let executor;

    beforeEach(() => {
      executor = new SafeCodeExecutor();
    });

    it('collects log messages before result', async () => {
      const promise = executor.executeJavaScript('console.log("hello")');

      // Worker sends log, then result
      mockWorkerInstance._triggerMessage({ type: 'log', data: 'hello' });
      mockWorkerInstance._triggerMessage({ type: 'log', data: 'world' });
      mockWorkerInstance._triggerMessage({ type: 'result', data: { result: undefined } });

      const result = await promise;
      expect(result.logs).toEqual(['hello', 'world']);
    });

    it('does not terminate or resolve on log message', () => {
      executor.executeJavaScript('x');
      mockWorkerInstance._triggerMessage({ type: 'log', data: 'log line' });

      // Worker should still be alive
      expect(mockWorkerInstance.terminate).not.toHaveBeenCalled();
      expect(executor.worker).toBe(mockWorkerInstance);
    });

    it('ignores unknown message types without resolving or terminating', () => {
      executor.executeJavaScript('x');
      mockWorkerInstance._triggerMessage({ type: 'unknown', data: {} });

      // Worker should still be alive — unknown type is silently ignored
      expect(mockWorkerInstance.terminate).not.toHaveBeenCalled();
      expect(executor.worker).toBe(mockWorkerInstance);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // executeJavaScript — error handling
  // ═══════════════════════════════════════════════════════════════════════

  describe('executeJavaScript — error from worker message', () => {
    let executor;

    beforeEach(() => {
      executor = new SafeCodeExecutor();
    });

    it('resolves with error result on type=error', async () => {
      const promise = executor.executeJavaScript('throw new Error("boom")');
      mockWorkerInstance._triggerMessage({
        type: 'error',
        data: { message: 'boom', stack: 'Error: boom\n at ...' },
      });

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('boom');
      expect(result.stack).toBe('Error: boom\n at ...');
      expect(result.logs).toEqual([]);
      expect(typeof result.executionTime).toBe('number');
    });

    it('terminates worker on error', async () => {
      const promise = executor.executeJavaScript('x');
      mockWorkerInstance._triggerMessage({
        type: 'error',
        data: { message: 'err' },
      });
      await promise;

      expect(mockWorkerInstance.terminate).toHaveBeenCalled();
      expect(executor.worker).toBeNull();
    });

    it('revokes object URL on error', async () => {
      const promise = executor.executeJavaScript('x');
      mockWorkerInstance._triggerMessage({
        type: 'error',
        data: { message: 'err' },
      });
      await promise;

      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    });

    it('includes accumulated logs in error result', async () => {
      const promise = executor.executeJavaScript('x');

      mockWorkerInstance._triggerMessage({ type: 'log', data: 'before error' });
      mockWorkerInstance._triggerMessage({
        type: 'error',
        data: { message: 'fail' },
      });

      const result = await promise;
      expect(result.logs).toEqual(['before error']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // executeJavaScript — Worker onerror
  // ═══════════════════════════════════════════════════════════════════════

  describe('executeJavaScript — Worker onerror', () => {
    let executor;

    beforeEach(() => {
      executor = new SafeCodeExecutor();
    });

    it('resolves with error on Worker crash', async () => {
      const promise = executor.executeJavaScript('x');
      mockWorkerInstance._triggerError({ message: 'Script error.' });

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Script error.');
    });

    it('uses fallback error message when error.message is missing', async () => {
      const promise = executor.executeJavaScript('x');
      mockWorkerInstance._triggerError({});

      const result = await promise;
      expect(result.error).toBe('Worker error');
    });

    it('terminates worker on onerror', async () => {
      const promise = executor.executeJavaScript('x');
      mockWorkerInstance._triggerError({ message: 'crash' });
      await promise;

      expect(mockWorkerInstance.terminate).toHaveBeenCalled();
      expect(executor.worker).toBeNull();
    });

    it('revokes object URL on onerror', async () => {
      const promise = executor.executeJavaScript('x');
      mockWorkerInstance._triggerError({ message: 'crash' });
      await promise;

      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // executeJavaScript — timeout
  // ═══════════════════════════════════════════════════════════════════════

  describe('executeJavaScript — timeout', () => {
    it('resolves with timeout error after default timeout', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('while(true){}');

      jest.advanceTimersByTime(5000);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Execution timeout after 5000ms');
    });

    it('uses per-call timeout when provided', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('while(true){}', { timeout: 2000 });

      jest.advanceTimersByTime(2000);

      const result = await promise;
      expect(result.error).toBe('Execution timeout after 2000ms');
    });

    it('clamps per-call timeout to MAX_TIMEOUT', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('while(true){}', { timeout: 99999 });

      jest.advanceTimersByTime(30000);

      const result = await promise;
      expect(result.error).toBe('Execution timeout after 30000ms');
    });

    it('terminates worker on timeout', async () => {
      const executor = new SafeCodeExecutor();
      executor.executeJavaScript('x');

      jest.advanceTimersByTime(5000);

      expect(mockWorkerInstance.terminate).toHaveBeenCalled();
    });

    it('nulls worker reference on timeout', async () => {
      const executor = new SafeCodeExecutor();
      executor.executeJavaScript('x');

      jest.advanceTimersByTime(5000);

      expect(executor.worker).toBeNull();
    });

    it('revokes object URL on timeout', async () => {
      const executor = new SafeCodeExecutor();
      executor.executeJavaScript('x');

      jest.advanceTimersByTime(5000);

      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    });

    it('timeout returns empty logs when no messages received', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('x');

      jest.advanceTimersByTime(5000);

      const result = await promise;
      expect(result.logs).toEqual([]);
    });

    it('handles timeout when worker already null', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('x');

      // Manually null the worker before timeout fires
      executor.worker = null;
      jest.advanceTimersByTime(5000);

      const result = await promise;
      expect(result.success).toBe(false);
      // Should not crash even though worker is null
    });

    it('clears timeout when result arrives before timeout', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('fast');

      // Result arrives immediately
      mockWorkerInstance._triggerMessage({ type: 'result', data: { result: 'done' } });
      await promise;

      // Advance time past timeout — should NOT trigger timeout handler
      jest.advanceTimersByTime(5000);

      // Worker was already terminated by result handler, no double terminate
      expect(mockWorkerInstance.terminate).toHaveBeenCalledTimes(1);
    });

    it('uses default timeout when options.timeout is 0 (falsy)', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('x', { timeout: 0 });

      // 0 || 5000 = 5000, clamped to 30000 -> 5000
      jest.advanceTimersByTime(5000);

      const result = await promise;
      expect(result.error).toBe('Execution timeout after 5000ms');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // executeJavaScript — Worker creation failure
  // ═══════════════════════════════════════════════════════════════════════

  describe('executeJavaScript — Worker creation failure', () => {
    it('resolves with error when Worker constructor throws', async () => {
      global.Worker = jest.fn(() => {
        throw new Error('SecurityError: Worker blocked');
      });

      const executor = new SafeCodeExecutor();
      const result = await executor.executeJavaScript('x');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to create worker: SecurityError: Worker blocked');
    });

    it('revokes object URL even when Worker creation fails', async () => {
      global.Worker = jest.fn(() => {
        throw new Error('blocked');
      });

      const executor = new SafeCodeExecutor();
      await executor.executeJavaScript('x');

      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    });

    it('returns empty logs on creation failure', async () => {
      global.Worker = jest.fn(() => {
        throw new Error('blocked');
      });

      const executor = new SafeCodeExecutor();
      const result = await executor.executeJavaScript('x');

      expect(result.logs).toEqual([]);
      expect(typeof result.executionTime).toBe('number');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // terminate
  // ═══════════════════════════════════════════════════════════════════════

  describe('terminate', () => {
    it('terminates active worker', () => {
      const executor = new SafeCodeExecutor();
      executor.executeJavaScript('x'); // creates worker
      expect(executor.worker).toBe(mockWorkerInstance);

      executor.terminate();

      expect(mockWorkerInstance.terminate).toHaveBeenCalled();
      expect(executor.worker).toBeNull();
    });

    it('is safe to call when no worker exists', () => {
      const executor = new SafeCodeExecutor();
      expect(executor.worker).toBeNull();
      expect(() => executor.terminate()).not.toThrow();
    });

    it('handles worker.terminate() throwing an error', () => {
      const executor = new SafeCodeExecutor();
      executor.executeJavaScript('x');
      mockWorkerInstance.terminate.mockImplementation(() => {
        throw new Error('already terminated');
      });

      expect(() => executor.terminate()).not.toThrow();
      expect(mockLogger.error).toHaveBeenCalledWith(
        '[SafeCodeExecutor] Failed to terminate worker:',
        expect.any(Error)
      );
    });

    it('nulls worker even when terminate throws', () => {
      const executor = new SafeCodeExecutor();
      executor.executeJavaScript('x');
      mockWorkerInstance.terminate.mockImplementation(() => {
        throw new Error('fail');
      });

      executor.terminate();
      expect(executor.worker).toBeNull();
    });

    it('is idempotent — safe to call multiple times', () => {
      const executor = new SafeCodeExecutor();
      executor.executeJavaScript('x');

      executor.terminate();
      executor.terminate();
      executor.terminate();

      // First call terminates, subsequent calls are no-ops
      expect(mockWorkerInstance.terminate).toHaveBeenCalledTimes(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // dispose
  // ═══════════════════════════════════════════════════════════════════════

  describe('dispose', () => {
    it('terminates active worker', () => {
      const executor = new SafeCodeExecutor();
      executor.executeJavaScript('x');

      executor.dispose();

      expect(mockWorkerInstance.terminate).toHaveBeenCalled();
      expect(executor.worker).toBeNull();
    });

    it('is safe when no worker exists', () => {
      const executor = new SafeCodeExecutor();
      expect(() => executor.dispose()).not.toThrow();
    });

    it('cancels pending execution and resolves promise with cancellation error', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('long running');

      executor.dispose();

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Execution cancelled: superseded by new execution');
      expect(mockWorkerInstance.terminate).toHaveBeenCalled();
      expect(executor.worker).toBeNull();
      expect(executor.pendingExecution).toBeNull();
    });

    it('clears pending timeout on dispose (no delayed timeout fire)', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('x');

      executor.dispose();
      await promise;

      // Advance past what would have been the timeout
      jest.advanceTimersByTime(5000);

      // Timeout should NOT have fired (was cleared by dispose)
      // If it had fired, it would try to resolve again (no-op, but indicates leak)
      expect(mockWorkerInstance.terminate).toHaveBeenCalledTimes(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _cancelPendingExecution
  // ═══════════════════════════════════════════════════════════════════════

  describe('_cancelPendingExecution', () => {
    it('is safe to call when no pending execution exists', () => {
      const executor = new SafeCodeExecutor();
      expect(() => executor._cancelPendingExecution()).not.toThrow();
    });

    it('still calls terminate when no pending execution (defensive cleanup)', () => {
      const executor = new SafeCodeExecutor();
      // Manually set a worker without pendingExecution (edge case)
      executor.worker = mockWorkerInstance;

      executor._cancelPendingExecution();

      expect(mockWorkerInstance.terminate).toHaveBeenCalled();
      expect(executor.worker).toBeNull();
    });

    it('clears timeout, terminates worker, resolves promise on cancel', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('x');

      expect(executor.pendingExecution).not.toBeNull();

      executor._cancelPendingExecution();

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Execution cancelled: superseded by new execution');
      expect(result.logs).toEqual([]);
      expect(typeof result.executionTime).toBe('number');
      expect(executor.pendingExecution).toBeNull();
      expect(executor.worker).toBeNull();
    });

    it('revokes blob URL on cancel', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('x');

      executor._cancelPendingExecution();
      await promise;

      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    });

    it('preserves accumulated logs in cancellation result', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('x');

      // Worker sends some logs before cancellation
      mockWorkerInstance._triggerMessage({ type: 'log', data: 'before cancel' });
      mockWorkerInstance._triggerMessage({ type: 'log', data: 'also before' });

      executor._cancelPendingExecution();

      const result = await promise;
      expect(result.logs).toEqual(['before cancel', 'also before']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // REGRESSION: concurrent execution (Bug #1)
  // ═══════════════════════════════════════════════════════════════════════

  describe('concurrent execution — regression tests', () => {
    it('terminates first worker when second execution starts', async () => {
      const workerA = createMockWorker();
      const workerB = createMockWorker();

      global.Worker = jest.fn()
        .mockReturnValueOnce(workerA)
        .mockReturnValueOnce(workerB);

      const executor = new SafeCodeExecutor();

      const promiseA = executor.executeJavaScript('first');
      expect(executor.worker).toBe(workerA);

      // Start second execution before first completes
      const promiseB = executor.executeJavaScript('second');

      // Worker A should have been terminated by _cancelPendingExecution
      expect(workerA.terminate).toHaveBeenCalled();
      // Worker B is now the active worker
      expect(executor.worker).toBe(workerB);

      // Promise A should resolve with cancellation
      const resultA = await promiseA;
      expect(resultA.success).toBe(false);
      expect(resultA.error).toBe('Execution cancelled: superseded by new execution');

      // Promise B should work normally
      workerB._triggerMessage({ type: 'result', data: { result: 42 } });
      const resultB = await promiseB;
      expect(resultB.success).toBe(true);
      expect(resultB.result).toBe(42);
    });

    it('first execution timeout does NOT terminate second worker', async () => {
      const workerA = createMockWorker();
      const workerB = createMockWorker();

      global.Worker = jest.fn()
        .mockReturnValueOnce(workerA)
        .mockReturnValueOnce(workerB);

      const executor = new SafeCodeExecutor();

      // First execution with 2s timeout
      executor.executeJavaScript('first', { timeout: 2000 });
      // Second execution supersedes first (default 5s timeout)
      const promiseB = executor.executeJavaScript('second');

      // Advance past timeout A (2000ms) but before timeout B (5000ms)
      jest.advanceTimersByTime(3000);

      // If timeout A was NOT cleared by _cancelPendingExecution, it would have
      // fired at 2000ms and terminated this.worker (which is now workerB).
      // Verify workerB is still alive — proving timeout A was properly cleared.
      expect(workerB.terminate).not.toHaveBeenCalled();
      expect(executor.worker).toBe(workerB);

      // Worker B completes normally before its own timeout
      workerB._triggerMessage({ type: 'result', data: { result: 'done' } });
      const resultB = await promiseB;
      expect(resultB.success).toBe(true);
    });

    it('blob URL from first execution is revoked on cancellation', async () => {
      const workerA = createMockWorker();
      const workerB = createMockWorker();

      URL.createObjectURL = jest.fn()
        .mockReturnValueOnce('blob:url-A')
        .mockReturnValueOnce('blob:url-B');

      global.Worker = jest.fn()
        .mockReturnValueOnce(workerA)
        .mockReturnValueOnce(workerB);

      const executor = new SafeCodeExecutor();

      const promiseA = executor.executeJavaScript('first');
      executor.executeJavaScript('second');

      await promiseA;

      // URL A should be revoked by _cancelPendingExecution
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:url-A');
    });

    it('three rapid calls: only the last execution survives', async () => {
      const workerA = createMockWorker();
      const workerB = createMockWorker();
      const workerC = createMockWorker();

      global.Worker = jest.fn()
        .mockReturnValueOnce(workerA)
        .mockReturnValueOnce(workerB)
        .mockReturnValueOnce(workerC);

      const executor = new SafeCodeExecutor();

      const pA = executor.executeJavaScript('a');
      const pB = executor.executeJavaScript('b');
      const pC = executor.executeJavaScript('c');

      // Workers A and B should be terminated
      expect(workerA.terminate).toHaveBeenCalled();
      expect(workerB.terminate).toHaveBeenCalled();
      expect(workerC.terminate).not.toHaveBeenCalled();

      // Only worker C is active
      expect(executor.worker).toBe(workerC);

      // Promises A and B resolve with cancellation
      const rA = await pA;
      const rB = await pB;
      expect(rA.error).toBe('Execution cancelled: superseded by new execution');
      expect(rB.error).toBe('Execution cancelled: superseded by new execution');

      // Promise C resolves normally
      workerC._triggerMessage({ type: 'result', data: { result: 'final' } });
      const rC = await pC;
      expect(rC.success).toBe(true);
      expect(rC.result).toBe('final');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // REGRESSION: log messages must NOT disable timeout (Bug #2)
  // ═══════════════════════════════════════════════════════════════════════

  describe('log messages and timeout interaction — regression tests', () => {
    it('timeout still fires after log messages are received', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('console.log("hi"); while(true){}');

      // Worker sends logs but then enters infinite loop (no result/error)
      mockWorkerInstance._triggerMessage({ type: 'log', data: 'before infinite loop' });
      mockWorkerInstance._triggerMessage({ type: 'log', data: 'second log' });

      // Advance to timeout
      jest.advanceTimersByTime(5000);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Execution timeout after 5000ms');
      // Logs should be preserved in the timeout result
      expect(result.logs).toEqual(['before infinite loop', 'second log']);
    });

    it('worker is terminated on timeout even after log messages', async () => {
      const executor = new SafeCodeExecutor();
      executor.executeJavaScript('x');

      // Send a log, then let timeout fire
      mockWorkerInstance._triggerMessage({ type: 'log', data: 'a log' });
      jest.advanceTimersByTime(5000);

      expect(mockWorkerInstance.terminate).toHaveBeenCalled();
      expect(executor.worker).toBeNull();
    });

    it('unknown message types do NOT clear timeout', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('x');

      // Unknown message type — should be silently ignored
      mockWorkerInstance._triggerMessage({ type: 'unknown', data: {} });

      // Timeout should still fire
      jest.advanceTimersByTime(5000);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Execution timeout after 5000ms');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // pendingExecution tracking
  // ═══════════════════════════════════════════════════════════════════════

  describe('pendingExecution lifecycle', () => {
    it('pendingExecution is set during active execution', () => {
      const executor = new SafeCodeExecutor();
      executor.executeJavaScript('x');

      expect(executor.pendingExecution).not.toBeNull();
      expect(executor.pendingExecution).toEqual(expect.objectContaining({
        workerUrl: 'blob:mock-url',
      }));
    });

    it('pendingExecution is null after successful result', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('x');
      mockWorkerInstance._triggerMessage({ type: 'result', data: { result: 1 } });
      await promise;

      expect(executor.pendingExecution).toBeNull();
    });

    it('pendingExecution is null after error message', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('x');
      mockWorkerInstance._triggerMessage({ type: 'error', data: { message: 'err' } });
      await promise;

      expect(executor.pendingExecution).toBeNull();
    });

    it('pendingExecution is null after timeout', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('x');
      jest.advanceTimersByTime(5000);
      await promise;

      expect(executor.pendingExecution).toBeNull();
    });

    it('pendingExecution is null after onerror', async () => {
      const executor = new SafeCodeExecutor();
      const promise = executor.executeJavaScript('x');
      mockWorkerInstance._triggerError({ message: 'crash' });
      await promise;

      expect(executor.pendingExecution).toBeNull();
    });

    it('pendingExecution is null after Worker creation failure', async () => {
      global.Worker = jest.fn(() => { throw new Error('blocked'); });
      const executor = new SafeCodeExecutor();
      await executor.executeJavaScript('x');

      expect(executor.pendingExecution).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _createWorkerCode
  // ═══════════════════════════════════════════════════════════════════════

  describe('_createWorkerCode', () => {
    let executor;

    beforeEach(() => {
      executor = new SafeCodeExecutor();
    });

    it('returns a string', () => {
      const code = executor._createWorkerCode();
      expect(typeof code).toBe('string');
    });

    it('includes console override for log', () => {
      const code = executor._createWorkerCode();
      expect(code).toContain('console');
      expect(code).toContain("log: (...args)");
    });

    it('includes console override for error', () => {
      const code = executor._createWorkerCode();
      expect(code).toContain("error: (...args)");
    });

    it('includes console override for warn', () => {
      const code = executor._createWorkerCode();
      expect(code).toContain("warn: (...args)");
    });

    it('includes console override for info', () => {
      const code = executor._createWorkerCode();
      expect(code).toContain("info: (...args)");
    });

    it('includes message event listener', () => {
      const code = executor._createWorkerCode();
      expect(code).toContain("self.addEventListener('message'");
    });

    it('includes use strict directive', () => {
      const code = executor._createWorkerCode();
      expect(code).toContain("'use strict'");
    });

    it('includes eval for code execution', () => {
      const code = executor._createWorkerCode();
      expect(code).toContain('eval(code)');
    });

    it('includes error handling with try-catch', () => {
      const code = executor._createWorkerCode();
      expect(code).toContain('catch (error)');
    });

    it('includes result serialization via JSON round-trip', () => {
      const code = executor._createWorkerCode();
      expect(code).toContain('JSON.parse(JSON.stringify(result))');
    });

    it('includes postMessage for result', () => {
      const code = executor._createWorkerCode();
      expect(code).toContain("type: 'result'");
    });

    it('includes postMessage for error', () => {
      const code = executor._createWorkerCode();
      expect(code).toContain("type: 'error'");
    });

    it('includes postMessage for log', () => {
      const code = executor._createWorkerCode();
      expect(code).toContain("type: 'log'");
    });

    it('includes circular object safety in console methods', () => {
      const code = executor._createWorkerCode();
      expect(code).toContain('[Circular or Non-serializable]');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // window export
  // ═══════════════════════════════════════════════════════════════════════

  describe('module export', () => {
    it('exports SafeCodeExecutor as constructor', () => {
      expect(typeof SafeCodeExecutor).toBe('function');
    });

    it('is available on window in jsdom', () => {
      expect(window.SafeCodeExecutor).toBe(SafeCodeExecutor);
    });
  });
});
