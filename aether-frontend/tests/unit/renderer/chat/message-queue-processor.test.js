'use strict';

// ---------------------------------------------------------------------------
// Mocks — plain functions survive resetMocks: true
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: () => {},
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const MessageQueueProcessor = require(
  '../../../../src/renderer/chat/modules/messaging/queue/MessageQueueProcessor'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flush microtask queue — lets async processing settle.
 */
const flushPromises = () => new Promise((r) => process.nextTick(r));

function createRouter() {
  return { route: jest.fn().mockResolvedValue(undefined) };
}

function createProcessor(overrides = {}) {
  const router = createRouter();
  const proc = new MessageQueueProcessor({ router, ...overrides });
  return { proc, router };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageQueueProcessor', () => {
  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.trace.mockClear();
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    test('throws when router is not provided', () => {
      expect(() => new MessageQueueProcessor()).toThrow(
        '[MessageQueueProcessor] router is REQUIRED'
      );
    });

    test('throws when router is null', () => {
      expect(() => new MessageQueueProcessor({ router: null })).toThrow(
        '[MessageQueueProcessor] router is REQUIRED'
      );
    });

    test('throws when options is empty object', () => {
      expect(() => new MessageQueueProcessor({})).toThrow(
        '[MessageQueueProcessor] router is REQUIRED'
      );
    });

    test('succeeds with valid router', () => {
      const router = createRouter();
      const proc = new MessageQueueProcessor({ router });
      expect(proc.router).toBe(router);
    });

    test('initializes with empty queue', () => {
      const { proc } = createProcessor();
      expect(proc.getQueueSize()).toBe(0);
    });

    test('initializes with isProcessing = false', () => {
      const { proc } = createProcessor();
      expect(proc.isProcessing()).toBe(false);
    });

    test('initializes with _isDisposed = false', () => {
      const { proc } = createProcessor();
      expect(proc._isDisposed).toBe(false);
    });
  });

  // =========================================================================
  // enqueue() — basic
  // =========================================================================
  describe('enqueue', () => {
    test('routes single message to router', async () => {
      const { proc, router } = createProcessor();

      proc.enqueue({ id: 1, content: 'hello' });
      await flushPromises();

      expect(router.route).toHaveBeenCalledTimes(1);
      expect(router.route).toHaveBeenCalledWith({ id: 1, content: 'hello' });
    });

    test('processes multiple messages in FIFO order', async () => {
      const { proc, router } = createProcessor();
      const callOrder = [];

      router.route.mockImplementation(async (p) => {
        callOrder.push(p.id);
      });

      proc.enqueue({ id: 'first' });
      proc.enqueue({ id: 'second' });
      proc.enqueue({ id: 'third' });
      await flushPromises();

      expect(callOrder).toEqual(['first', 'second', 'third']);
    });

    test('starts processor only if not already running', async () => {
      const { proc, router } = createProcessor();
      let resolveFirst;

      // First message: hold processing
      router.route.mockImplementationOnce(
        () => new Promise((r) => { resolveFirst = r; })
      );

      proc.enqueue({ id: 1 });
      // At this point, processor is running, blocked on first message

      proc.enqueue({ id: 2 });
      proc.enqueue({ id: 3 });
      // These should NOT start a new processor

      // Release first message
      resolveFirst();
      await flushPromises();

      // All 3 processed by same processor loop
      expect(router.route).toHaveBeenCalledTimes(3);
    });

    test('logs trace with queue size on enqueue', () => {
      const { proc } = createProcessor();

      proc.enqueue({ id: 1 });

      expect(mockLog.trace).toHaveBeenCalledWith('Message enqueued', {
        queueSize: 1,
        isProcessing: false,
      });
    });

    test('logs trace with isProcessing=true for subsequent enqueues', async () => {
      const { proc, router } = createProcessor();
      let resolveFirst;

      router.route.mockImplementationOnce(
        () => new Promise((r) => { resolveFirst = r; })
      );

      proc.enqueue({ id: 1 });
      // Now processor is running

      mockLog.trace.mockClear();
      proc.enqueue({ id: 2 });

      expect(mockLog.trace).toHaveBeenCalledWith('Message enqueued', {
        queueSize: 1,
        isProcessing: true,
      });

      resolveFirst();
      await flushPromises();
    });
  });

  // =========================================================================
  // _processQueue() — sequential processing
  // =========================================================================
  describe('_processQueue — sequential processing', () => {
    test('processes items one at a time (no concurrent route calls)', async () => {
      const { proc, router } = createProcessor();
      let concurrentCount = 0;
      let maxConcurrent = 0;

      router.route.mockImplementation(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        // Use microtask yield (compatible with flushPromises)
        await Promise.resolve();
        concurrentCount--;
      });

      proc.enqueue({ id: 1 });
      proc.enqueue({ id: 2 });
      proc.enqueue({ id: 3 });
      await flushPromises();

      expect(maxConcurrent).toBe(1);
      expect(router.route).toHaveBeenCalledTimes(3);
    });

    test('isProcessing is true during processing', async () => {
      const { proc, router } = createProcessor();
      let processingDuringRoute = null;

      router.route.mockImplementation(async () => {
        processingDuringRoute = proc.isProcessing();
      });

      proc.enqueue({ id: 1 });
      await flushPromises();

      expect(processingDuringRoute).toBe(true);
    });

    test('isProcessing is false after processing completes', async () => {
      const { proc } = createProcessor();

      proc.enqueue({ id: 1 });
      await flushPromises();

      expect(proc.isProcessing()).toBe(false);
    });

    test('queue is empty after all messages processed', async () => {
      const { proc } = createProcessor();

      proc.enqueue({ id: 1 });
      proc.enqueue({ id: 2 });
      await flushPromises();

      expect(proc.getQueueSize()).toBe(0);
    });
  });

  // =========================================================================
  // _processQueue() — error handling
  // =========================================================================
  describe('_processQueue — error handling', () => {
    test('continues processing after route error', async () => {
      const { proc, router } = createProcessor();
      const processed = [];

      router.route.mockImplementation(async (p) => {
        if (p.id === 'error') throw new Error('Route failed');
        processed.push(p.id);
      });

      proc.enqueue({ id: 'before' });
      proc.enqueue({ id: 'error' });
      proc.enqueue({ id: 'after' });
      await flushPromises();

      expect(processed).toEqual(['before', 'after']);
    });

    test('logs error for failed route with message and stack', async () => {
      const { proc, router } = createProcessor();
      const testError = new Error('route kaboom');

      router.route.mockRejectedValueOnce(testError);

      proc.enqueue({ id: 1 });
      await flushPromises();

      expect(mockLog.error).toHaveBeenCalledWith(
        'Error processing queued message',
        { error: 'route kaboom', stack: testError.stack }
      );
    });

    test('processes all messages even with multiple errors', async () => {
      const { proc, router } = createProcessor();
      let successCount = 0;

      router.route.mockImplementation(async (p) => {
        if (p.shouldFail) throw new Error('fail');
        successCount++;
      });

      proc.enqueue({ id: 1, shouldFail: false });
      proc.enqueue({ id: 2, shouldFail: true });
      proc.enqueue({ id: 3, shouldFail: true });
      proc.enqueue({ id: 4, shouldFail: false });
      await flushPromises();

      expect(successCount).toBe(2);
      expect(mockLog.error).toHaveBeenCalledTimes(2);
    });

    test('resets isProcessing after error', async () => {
      const { proc, router } = createProcessor();

      router.route.mockRejectedValueOnce(new Error('fail'));

      proc.enqueue({ id: 1 });
      await flushPromises();

      expect(proc.isProcessing()).toBe(false);
    });

    test('logs fatal error for outer catch (e.g. queue corruption)', async () => {
      const { proc, router } = createProcessor();
      const fatalError = new Error('queue shift failed');

      // Replace _queue with object that throws on shift after first call
      let callCount = 0;
      const originalQueue = proc._queue;
      proc._queue = {
        get length() { return originalQueue.length; },
        push(item) { originalQueue.push(item); },
        shift() {
          callCount++;
          if (callCount > 1) throw fatalError;
          return originalQueue.shift();
        },
      };

      proc.enqueue({ id: 'first' });
      proc.enqueue({ id: 'triggers-crash' });
      await flushPromises();

      // First item processed, second triggers outer catch
      expect(router.route).toHaveBeenCalledTimes(1);
      expect(mockLog.error).toHaveBeenCalledWith(
        'Fatal error in queue processor',
        { error: 'queue shift failed', stack: fatalError.stack }
      );
    });

    test('restarts processor via finally when items remain after fatal error', async () => {
      const { proc, router } = createProcessor();
      const processed = [];

      // First call to shift() succeeds, second throws, then subsequent calls succeed
      const originalQueue = proc._queue;
      let shiftCount = 0;
      proc._queue = {
        get length() { return originalQueue.length; },
        push(item) { originalQueue.push(item); },
        shift() {
          shiftCount++;
          if (shiftCount === 2) {
            throw new Error('transient');
          }
          return originalQueue.shift();
        },
      };

      router.route.mockImplementation(async (p) => {
        processed.push(p.id);
      });

      proc.enqueue({ id: 'a' });
      proc.enqueue({ id: 'b' });
      proc.enqueue({ id: 'c' });
      await flushPromises();
      await flushPromises();

      // 'a' processed, then crash on shift() for 'b', then finally restarts
      // and processes 'c' (shift #3 succeeds, but 'b' was lost to the crash)
      expect(processed).toContain('a');
      // After restart, remaining items should be processed
      expect(proc.isProcessing()).toBe(false);
    });
  });

  // =========================================================================
  // _processQueue() — items added during processing
  // =========================================================================
  describe('_processQueue — items added during processing', () => {
    test('processes items added during route callback', async () => {
      const { proc, router } = createProcessor();
      const callOrder = [];

      router.route.mockImplementation(async (p) => {
        callOrder.push(p.id);
        if (p.id === 'trigger') {
          proc.enqueue({ id: 'added-mid-processing' });
        }
      });

      proc.enqueue({ id: 'trigger' });
      await flushPromises();

      expect(callOrder).toEqual(['trigger', 'added-mid-processing']);
    });

    test('processes nested enqueues in order', async () => {
      const { proc, router } = createProcessor();
      const callOrder = [];

      router.route.mockImplementation(async (p) => {
        callOrder.push(p.id);
        if (p.id === 'a') {
          proc.enqueue({ id: 'b' });
          proc.enqueue({ id: 'c' });
        }
      });

      proc.enqueue({ id: 'a' });
      await flushPromises();

      expect(callOrder).toEqual(['a', 'b', 'c']);
    });
  });

  // =========================================================================
  // _processQueue() — concurrent guard
  // =========================================================================
  describe('_processQueue — concurrent guard', () => {
    test('_processQueue returns immediately if already processing', async () => {
      const { proc, router } = createProcessor();
      let resolveFirst;

      router.route.mockImplementationOnce(
        () => new Promise((r) => { resolveFirst = r; })
      );

      proc.enqueue({ id: 1 });
      // Processor is now running

      // Manually call _processQueue — should return immediately
      proc._processQueue();

      // Only 1 route call, not 2
      expect(router.route).toHaveBeenCalledTimes(1);

      resolveFirst();
      await flushPromises();
    });
  });

  // =========================================================================
  // getQueueSize()
  // =========================================================================
  describe('getQueueSize', () => {
    test('returns 0 for empty queue', () => {
      const { proc } = createProcessor();
      expect(proc.getQueueSize()).toBe(0);
    });

    test('reflects enqueued items before processing starts', () => {
      const { proc, router } = createProcessor();
      let resolveFirst;
      router.route.mockImplementationOnce(
        () => new Promise((r) => { resolveFirst = r; })
      );

      proc.enqueue({ id: 1 });
      proc.enqueue({ id: 2 });
      proc.enqueue({ id: 3 });

      // First is being processed, 2 remain in queue
      expect(proc.getQueueSize()).toBe(2);

      resolveFirst();
    });

    test('returns 0 after processing', async () => {
      const { proc } = createProcessor();

      proc.enqueue({ id: 1 });
      await flushPromises();

      expect(proc.getQueueSize()).toBe(0);
    });
  });

  // =========================================================================
  // isProcessing()
  // =========================================================================
  describe('isProcessing', () => {
    test('returns false initially', () => {
      const { proc } = createProcessor();
      expect(proc.isProcessing()).toBe(false);
    });

    test('returns false after processing completes', async () => {
      const { proc } = createProcessor();

      proc.enqueue({ id: 1 });
      await flushPromises();

      expect(proc.isProcessing()).toBe(false);
    });
  });

  // =========================================================================
  // clear()
  // =========================================================================
  describe('clear', () => {
    test('empties the queue', () => {
      const { proc, router } = createProcessor();
      let resolveFirst;
      router.route.mockImplementationOnce(
        () => new Promise((r) => { resolveFirst = r; })
      );

      proc.enqueue({ id: 1 });
      proc.enqueue({ id: 2 });
      proc.enqueue({ id: 3 });

      proc.clear();

      expect(proc.getQueueSize()).toBe(0);
      resolveFirst();
    });

    test('logs previous size', () => {
      const { proc, router } = createProcessor();
      let resolveFirst;
      router.route.mockImplementationOnce(
        () => new Promise((r) => { resolveFirst = r; })
      );

      proc.enqueue({ id: 1 });
      proc.enqueue({ id: 2 });
      mockLog.warn.mockClear();

      proc.clear();

      expect(mockLog.warn).toHaveBeenCalledWith('Queue cleared', {
        previousSize: 1,
      });
      resolveFirst();
    });

    test('logs previousSize 0 when already empty', () => {
      const { proc } = createProcessor();
      mockLog.warn.mockClear();

      proc.clear();

      expect(mockLog.warn).toHaveBeenCalledWith('Queue cleared', {
        previousSize: 0,
      });
    });

    test('cleared items are not processed', async () => {
      const { proc, router } = createProcessor();
      let resolveFirst;

      router.route.mockImplementationOnce(
        () => new Promise((r) => { resolveFirst = r; })
      );

      proc.enqueue({ id: 'will-process' });
      proc.enqueue({ id: 'will-clear-1' });
      proc.enqueue({ id: 'will-clear-2' });

      // Clear queue while first is processing
      proc.clear();

      resolveFirst();
      await flushPromises();

      // Only the first was processed (already dequeued before clear)
      expect(router.route).toHaveBeenCalledTimes(1);
      expect(router.route).toHaveBeenCalledWith({ id: 'will-process' });
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================
  describe('dispose', () => {
    test('empties queue', () => {
      const { proc } = createProcessor();
      proc._queue.push({ id: 1 }, { id: 2 });

      proc.dispose();

      expect(proc.getQueueSize()).toBe(0);
    });

    test('resets isProcessing flag', () => {
      const { proc } = createProcessor();
      proc._isProcessing = true;

      proc.dispose();

      expect(proc.isProcessing()).toBe(false);
    });

    test('nulls router', () => {
      const { proc } = createProcessor();

      proc.dispose();

      expect(proc.router).toBeNull();
    });

    test('sets _isDisposed to true', () => {
      const { proc } = createProcessor();
      expect(proc._isDisposed).toBe(false);
      proc.dispose();
      expect(proc._isDisposed).toBe(true);
    });

    test('is idempotent — second call is a no-op', () => {
      const { proc } = createProcessor();
      proc.dispose();
      const firstDisposed = proc._isDisposed;

      // Second dispose should not throw or change state
      expect(() => proc.dispose()).not.toThrow();
      expect(proc._isDisposed).toBe(firstDisposed);
    });

    test('BUG REGRESSION: enqueue after dispose is a no-op (prevents null-ref crash on router)', async () => {
      const { proc, router } = createProcessor();
      proc.dispose();

      // This would crash pre-fix: router is null, _processQueue would call this.router.route()
      proc.enqueue({ id: 'post-dispose' });
      await flushPromises();

      expect(router.route).not.toHaveBeenCalled();
      expect(proc.getQueueSize()).toBe(0);
      expect(mockLog.warn).toHaveBeenCalledWith(
        'enqueue called on disposed MessageQueueProcessor'
      );
    });

    test('BUG REGRESSION: processQueue stops when disposed mid-processing', async () => {
      const { proc, router } = createProcessor();
      const processed = [];

      router.route.mockImplementation(async (p) => {
        processed.push(p.id);
        if (p.id === 'trigger-dispose') {
          proc.dispose(); // dispose during processing
        }
      });

      proc.enqueue({ id: 'before' });
      proc.enqueue({ id: 'trigger-dispose' });
      proc.enqueue({ id: 'should-not-process' });
      await flushPromises();

      // 'before' and 'trigger-dispose' processed, 'should-not-process' dropped
      expect(processed).toEqual(['before', 'trigger-dispose']);
      expect(router.route).toHaveBeenCalledTimes(2);
    });

    test('BUG REGRESSION: finally block does not restart processor when disposed', async () => {
      const { proc, router } = createProcessor();

      // Enqueue one item that will dispose during processing
      router.route.mockImplementation(async () => {
        proc.dispose();
      });

      proc.enqueue({ id: 'a' });
      // Enqueue while processing is in flight but before dispose
      // This goes into the queue but processing loop should exit
      proc._queue.push({ id: 'b' });

      await flushPromises();

      // Only 'a' was processed, 'b' was NOT restarted by finally block
      expect(router.route).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Lifecycle integration
  // =========================================================================
  describe('lifecycle integration', () => {
    test('full lifecycle: create → enqueue → process → clear → dispose', async () => {
      const { proc, router } = createProcessor();

      // Enqueue and process
      proc.enqueue({ id: 1 });
      proc.enqueue({ id: 2 });
      await flushPromises();

      expect(router.route).toHaveBeenCalledTimes(2);
      expect(proc.getQueueSize()).toBe(0);
      expect(proc.isProcessing()).toBe(false);

      // More enqueues
      proc.enqueue({ id: 3 });
      await flushPromises();

      expect(router.route).toHaveBeenCalledTimes(3);

      // Dispose
      proc.dispose();
      expect(proc.router).toBeNull();
      expect(proc.getQueueSize()).toBe(0);
    });

    test('handles rapid sequential enqueues correctly', async () => {
      const { proc, router } = createProcessor();
      const processed = [];

      router.route.mockImplementation(async (p) => {
        processed.push(p.id);
      });

      for (let i = 0; i < 20; i++) {
        proc.enqueue({ id: i });
      }
      await flushPromises();

      expect(processed).toEqual(Array.from({ length: 20 }, (_, i) => i));
      expect(proc.getQueueSize()).toBe(0);
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================
  describe('module exports', () => {
    test('exports MessageQueueProcessor constructor', () => {
      expect(typeof MessageQueueProcessor).toBe('function');
    });

    test('instances have expected methods', () => {
      const { proc } = createProcessor();
      expect(typeof proc.enqueue).toBe('function');
      expect(typeof proc.getQueueSize).toBe('function');
      expect(typeof proc.isProcessing).toBe('function');
      expect(typeof proc.clear).toBe('function');
      expect(typeof proc.dispose).toBe('function');
    });
  });
});
