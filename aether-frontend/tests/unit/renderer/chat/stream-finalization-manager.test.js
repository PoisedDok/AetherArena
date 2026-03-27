'use strict';

// ---------------------------------------------------------------------------
// Mocks — plain functions survive resetMocks: true
// ---------------------------------------------------------------------------

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const StreamFinalizationManager = require(
  '../../../../src/renderer/chat/modules/messaging/stream/StreamFinalizationManager'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMessageState(overrides = {}) {
  return {
    saveMessage: jest.fn().mockResolvedValue({ id: 'saved-msg-1' }),
    ...overrides,
  };
}

function createMessageView(overrides = {}) {
  const messageElements = new Map();
  return {
    getMessageElement: jest.fn().mockReturnValue(null),
    messageElements,
    ...overrides,
  };
}

function createEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createManager(overrides = {}) {
  const deps = {
    messageState: createMessageState(),
    messageView: createMessageView(),
    eventBus: createEventBus(),
    ...overrides,
  };
  const manager = new StreamFinalizationManager(deps);
  return { manager, ...deps };
}

function createDefaultState(overrides = {}) {
  return {
    messageId: 'msg-1',
    requestId: 'req-1',
    accumulatedText: 'Hello world',
    thinkingText: 'I thought about this',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamFinalizationManager', () => {
  beforeEach(() => {
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    test('throws when messageState is not provided', () => {
      expect(() => new StreamFinalizationManager({
        messageView: createMessageView(),
      })).toThrow('[StreamFinalizationManager] messageState is REQUIRED');
    });

    test('throws when messageView is not provided', () => {
      expect(() => new StreamFinalizationManager({
        messageState: createMessageState(),
      })).toThrow('[StreamFinalizationManager] messageView is REQUIRED');
    });

    test('throws when both are missing', () => {
      expect(() => new StreamFinalizationManager()).toThrow(
        '[StreamFinalizationManager] messageState is REQUIRED'
      );
    });

    test('throws when messageState is null', () => {
      expect(() => new StreamFinalizationManager({
        messageState: null,
        messageView: createMessageView(),
      })).toThrow('[StreamFinalizationManager] messageState is REQUIRED');
    });

    test('throws when messageView is null', () => {
      expect(() => new StreamFinalizationManager({
        messageState: createMessageState(),
        messageView: null,
      })).toThrow('[StreamFinalizationManager] messageView is REQUIRED');
    });

    test('succeeds with required deps (eventBus is optional)', () => {
      const manager = new StreamFinalizationManager({
        messageState: createMessageState(),
        messageView: createMessageView(),
      });
      expect(manager.eventBus).toBeNull();
    });

    test('stores all dependencies', () => {
      const { manager, messageState, messageView, eventBus } = createManager();

      expect(manager.messageState).toBe(messageState);
      expect(manager.messageView).toBe(messageView);
      expect(manager.eventBus).toBe(eventBus);
    });

    test('initializes _isFinalizingStream to false', () => {
      const { manager } = createManager();
      expect(manager._isFinalizingStream).toBe(false);
    });

    test('initializes _pendingFinalization to null', () => {
      const { manager } = createManager();
      expect(manager._pendingFinalization).toBeNull();
    });

    test('initializes _isDisposed to false', () => {
      const { manager } = createManager();
      expect(manager._isDisposed).toBe(false);
    });
  });

  // =========================================================================
  // finalize() — basic flow
  // =========================================================================
  describe('finalize — basic flow', () => {
    test('persists message via messageState.saveMessage', async () => {
      const { manager, messageState } = createManager();
      const state = createDefaultState();

      await manager.finalize(state);

      expect(messageState.saveMessage).toHaveBeenCalledTimes(1);
      expect(messageState.saveMessage).toHaveBeenCalledWith({
        id: 'msg-1',
        role: 'assistant',
        content: 'Hello world',
        timestamp: expect.any(Number),
        correlation_id: 'req-1',
      });
    });

    test('uses empty string for content when accumulatedText is empty', async () => {
      const { manager, messageState } = createManager();

      await manager.finalize(createDefaultState({ accumulatedText: '' }));

      const call = messageState.saveMessage.mock.calls[0][0];
      expect(call.content).toBe('');
    });

    test('uses empty string for content when accumulatedText is null', async () => {
      // FIX VERIFIED: accumulatedText null no longer crashes at .length
      // (accumulatedText || '').length now used for safe access
      const { manager, messageState, eventBus } = createManager();

      await manager.finalize(createDefaultState({ accumulatedText: null }));

      expect(messageState.saveMessage).toHaveBeenCalledTimes(1);
      const call = messageState.saveMessage.mock.calls[0][0];
      expect(call.content).toBe('');

      // No error — finalization completes successfully
      expect(mockLog.error).not.toHaveBeenCalled();

      // Event emitted with contentLength 0
      expect(eventBus.emit).toHaveBeenCalledWith('stream:finalized', {
        messageId: 'saved-msg-1',
        requestId: 'req-1',
        contentLength: 0,
        thinkingLength: 20,
      });
    });

    test('emits stream:finalized event to eventBus', async () => {
      const { manager, eventBus } = createManager();
      const state = createDefaultState();

      await manager.finalize(state);

      expect(eventBus.emit).toHaveBeenCalledWith('stream:finalized', {
        messageId: 'saved-msg-1',
        requestId: 'req-1',
        contentLength: 11, // 'Hello world'.length
        thinkingLength: 20, // 'I thought about this'.length
      });
    });

    test('does not emit event when eventBus is null', async () => {
      const { manager } = createManager({ eventBus: null });
      const state = createDefaultState();

      await manager.finalize(state);

      // No crash, no emit — eventBus guard works
    });

    test('logs debug on finalization start', async () => {
      const { manager } = createManager();

      await manager.finalize(createDefaultState());

      expect(mockLog.debug).toHaveBeenCalledWith(
        'Finalizing stream',
        { messageId: 'msg-1', requestId: 'req-1' }
      );
    });

    test('logs info on successful finalization', async () => {
      const { manager } = createManager();

      await manager.finalize(createDefaultState());

      expect(mockLog.info).toHaveBeenCalledWith(
        'Stream finalized',
        {
          messageId: 'saved-msg-1',
          requestId: 'req-1',
          contentLength: 11,
        }
      );
    });
  });

  // =========================================================================
  // finalize() — messageId validation
  // =========================================================================
  describe('finalize — messageId validation', () => {
    test('returns early when messageId is null', async () => {
      const { manager, messageState } = createManager();

      await manager.finalize(createDefaultState({ messageId: null }));

      expect(messageState.saveMessage).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Nothing to finalize - missing message ID'
      );
    });

    test('returns early when messageId is undefined', async () => {
      const { manager, messageState } = createManager();

      await manager.finalize(createDefaultState({ messageId: undefined }));

      expect(messageState.saveMessage).not.toHaveBeenCalled();
    });

    test('returns early when messageId is empty string', async () => {
      const { manager, messageState } = createManager();

      await manager.finalize(createDefaultState({ messageId: '' }));

      expect(messageState.saveMessage).not.toHaveBeenCalled();
    });

    test('proceeds when messageId is present', async () => {
      const { manager, messageState } = createManager();

      await manager.finalize(createDefaultState({ messageId: 'valid-id' }));

      expect(messageState.saveMessage).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // finalize() — ID update logic
  // =========================================================================
  describe('finalize — ID update logic', () => {
    test('updates DOM element and messageElements map when ID changes', async () => {
      const mockElement = { dataset: { messageId: 'msg-1' } };
      const messageElements = new Map([['msg-1', mockElement]]);
      const messageView = createMessageView({
        getMessageElement: jest.fn().mockReturnValue(mockElement),
        messageElements,
      });
      const messageState = createMessageState({
        saveMessage: jest.fn().mockResolvedValue({ id: 'persisted-id' }),
      });

      const { manager } = createManager({ messageState, messageView });
      await manager.finalize(createDefaultState());

      // Element dataset updated
      expect(mockElement.dataset.messageId).toBe('persisted-id');

      // Old key removed, new key set
      expect(messageElements.has('msg-1')).toBe(false);
      expect(messageElements.get('persisted-id')).toBe(mockElement);
    });

    test('does not update when persisted ID matches original', async () => {
      const messageState = createMessageState({
        saveMessage: jest.fn().mockResolvedValue({ id: 'msg-1' }),
      });
      const messageView = createMessageView();

      const { manager } = createManager({ messageState, messageView });
      await manager.finalize(createDefaultState());

      // getMessageElement should NOT be called — IDs match
      expect(messageView.getMessageElement).not.toHaveBeenCalled();
    });

    test('does not crash when element is not found in DOM', async () => {
      const messageState = createMessageState({
        saveMessage: jest.fn().mockResolvedValue({ id: 'new-id' }),
      });
      const messageView = createMessageView({
        getMessageElement: jest.fn().mockReturnValue(null),
      });

      const { manager } = createManager({ messageState, messageView });

      await expect(manager.finalize(createDefaultState())).resolves.not.toThrow();
    });

    test('does not update when savedMessage is null', async () => {
      const messageState = createMessageState({
        saveMessage: jest.fn().mockResolvedValue(null),
      });
      const messageView = createMessageView();

      const { manager } = createManager({ messageState, messageView });
      await manager.finalize(createDefaultState());

      expect(messageView.getMessageElement).not.toHaveBeenCalled();
    });

    test('logs debug when ID changes', async () => {
      const messageState = createMessageState({
        saveMessage: jest.fn().mockResolvedValue({ id: 'new-persisted-id' }),
      });
      const messageView = createMessageView({
        getMessageElement: jest.fn().mockReturnValue({ dataset: {} }),
        messageElements: new Map([['msg-1', {}]]),
      });

      const { manager } = createManager({ messageState, messageView });
      await manager.finalize(createDefaultState());

      expect(mockLog.debug).toHaveBeenCalledWith(
        'Message ID updated post-persistence',
        { previousId: 'msg-1', persistedId: 'new-persisted-id' }
      );
    });
  });

  // =========================================================================
  // finalize() — event emission details
  // =========================================================================
  describe('finalize — event emission', () => {
    test('uses savedMessage.id in event when available', async () => {
      const messageState = createMessageState({
        saveMessage: jest.fn().mockResolvedValue({ id: 'db-id-123' }),
      });
      const { manager, eventBus } = createManager({ messageState });

      await manager.finalize(createDefaultState());

      const emitCall = eventBus.emit.mock.calls[0];
      expect(emitCall[1].messageId).toBe('db-id-123');
    });

    test('falls back to original messageId when savedMessage is null', async () => {
      const messageState = createMessageState({
        saveMessage: jest.fn().mockResolvedValue(null),
      });
      const { manager, eventBus } = createManager({ messageState });

      await manager.finalize(createDefaultState());

      const emitCall = eventBus.emit.mock.calls[0];
      expect(emitCall[1].messageId).toBe('msg-1');
    });

    test('contentLength reflects actual accumulated text length', async () => {
      const { manager, eventBus } = createManager();

      await manager.finalize(createDefaultState({
        accumulatedText: 'x'.repeat(500),
        thinkingText: '',
      }));

      const emitCall = eventBus.emit.mock.calls[0];
      expect(emitCall[1].contentLength).toBe(500);
      expect(emitCall[1].thinkingLength).toBe(0);
    });

    test('requestId is included in event', async () => {
      const { manager, eventBus } = createManager();

      await manager.finalize(createDefaultState({ requestId: 'req-abc' }));

      const emitCall = eventBus.emit.mock.calls[0];
      expect(emitCall[1].requestId).toBe('req-abc');
    });
  });

  // =========================================================================
  // finalize() — concurrency guard
  // =========================================================================
  describe('finalize — concurrency guard', () => {
    test('sets _isFinalizingStream during execution', async () => {
      let wasTrue = false;
      const messageState = createMessageState({
        saveMessage: jest.fn().mockImplementation(() => {
          // Check flag DURING execution
          wasTrue = true;
          return Promise.resolve({ id: 'msg-1' });
        }),
      });

      const { manager } = createManager({ messageState });

      await manager.finalize(createDefaultState());

      expect(wasTrue).toBe(true);
      // After completion, flag is cleared
      expect(manager._isFinalizingStream).toBe(false);
    });

    test('clears _pendingFinalization after completion', async () => {
      const { manager } = createManager();

      await manager.finalize(createDefaultState());

      expect(manager._pendingFinalization).toBeNull();
    });

    test('second concurrent finalize returns early after waiting', async () => {
      let resolveFirst;
      const savePromise = new Promise(resolve => { resolveFirst = resolve; });
      const messageState = createMessageState({
        saveMessage: jest.fn().mockReturnValue(savePromise),
      });

      const { manager } = createManager({ messageState });

      // Start first finalization (will block on savePromise)
      const first = manager.finalize(createDefaultState());

      // Start second finalization (should detect in-progress)
      const second = manager.finalize(createDefaultState({ messageId: 'msg-2' }));

      // Resolve first
      resolveFirst({ id: 'msg-1' });

      await first;
      await second;

      // saveMessage called only once (from first)
      expect(messageState.saveMessage).toHaveBeenCalledTimes(1);
    });

    test('logs trace when finalization is already in progress', async () => {
      let resolveFirst;
      const savePromise = new Promise(resolve => { resolveFirst = resolve; });
      const messageState = createMessageState({
        saveMessage: jest.fn().mockReturnValue(savePromise),
      });

      const { manager } = createManager({ messageState });

      // Start first
      const first = manager.finalize(createDefaultState());

      // Start second — should log trace
      const second = manager.finalize(createDefaultState());

      resolveFirst({ id: 'msg-1' });
      await first;
      await second;

      expect(mockLog.trace).toHaveBeenCalledWith(
        'Finalization already in progress, waiting for completion'
      );
    });

    test('guard resets after failed finalization', async () => {
      const messageState = createMessageState({
        saveMessage: jest.fn().mockRejectedValue(new Error('DB down')),
      });

      const { manager } = createManager({ messageState });

      await manager.finalize(createDefaultState());

      // Flag should be cleared even after error (finally block)
      expect(manager._isFinalizingStream).toBe(false);
      expect(manager._pendingFinalization).toBeNull();
    });

    test('returns early even when _pendingFinalization is null (flag-only guard)', async () => {
      // Covers line 72 false branch: _isFinalizingStream is true
      // but _pendingFinalization is null (edge case: flag set manually or race)
      const { manager, messageState } = createManager();

      // Manually set the flag without a pending promise
      manager._isFinalizingStream = true;
      manager._pendingFinalization = null;

      await manager.finalize(createDefaultState());

      // Should return early — saveMessage NOT called
      expect(messageState.saveMessage).not.toHaveBeenCalled();
      expect(mockLog.trace).toHaveBeenCalledWith(
        'Finalization already in progress, waiting for completion'
      );
    });

    test('can finalize again after previous finalization completes', async () => {
      const messageState = createMessageState({
        saveMessage: jest.fn()
          .mockResolvedValueOnce({ id: 'first-id' })
          .mockResolvedValueOnce({ id: 'second-id' }),
      });

      const { manager, eventBus } = createManager({ messageState });

      await manager.finalize(createDefaultState({ messageId: 'msg-1' }));
      await manager.finalize(createDefaultState({ messageId: 'msg-2' }));

      expect(messageState.saveMessage).toHaveBeenCalledTimes(2);
      expect(eventBus.emit).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // finalize() — error handling
  // =========================================================================
  describe('finalize — error handling', () => {
    test('catches and logs saveMessage errors', async () => {
      const dbError = new Error('Database connection lost');
      const messageState = createMessageState({
        saveMessage: jest.fn().mockRejectedValue(dbError),
      });

      const { manager } = createManager({ messageState });

      // Should not throw
      await expect(manager.finalize(createDefaultState())).resolves.not.toThrow();

      expect(mockLog.error).toHaveBeenCalledWith(
        'Stream finalization failed',
        { error: dbError }
      );
    });

    test('clears guard flags even on error', async () => {
      const messageState = createMessageState({
        saveMessage: jest.fn().mockRejectedValue(new Error('fail')),
      });

      const { manager } = createManager({ messageState });
      await manager.finalize(createDefaultState());

      expect(manager._isFinalizingStream).toBe(false);
      expect(manager._pendingFinalization).toBeNull();
    });

    test('does not emit event on save failure', async () => {
      const messageState = createMessageState({
        saveMessage: jest.fn().mockRejectedValue(new Error('fail')),
      });

      const { manager, eventBus } = createManager({ messageState });
      await manager.finalize(createDefaultState());

      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    test('FIX VERIFIED: undefined accumulatedText no longer crashes', async () => {
      // Previously: accumulatedText.length threw TypeError
      // Fix: (accumulatedText || '').length used for safe access
      const { manager, eventBus } = createManager();

      await manager.finalize(createDefaultState({
        accumulatedText: undefined,
        thinkingText: 'thinking',
      }));

      // No error — completes successfully
      expect(mockLog.error).not.toHaveBeenCalled();

      // Event emitted with contentLength 0
      expect(eventBus.emit).toHaveBeenCalledWith('stream:finalized', {
        messageId: 'saved-msg-1',
        requestId: 'req-1',
        contentLength: 0,
        thinkingLength: 8,
      });
    });

    test('FIX VERIFIED: undefined thinkingText no longer crashes', async () => {
      // Previously: thinkingText.length threw TypeError
      // Fix: (thinkingText || '').length used for safe access
      const { manager, eventBus } = createManager();

      await manager.finalize(createDefaultState({
        accumulatedText: 'valid text',
        thinkingText: undefined,
      }));

      // No error — completes successfully
      expect(mockLog.error).not.toHaveBeenCalled();

      // Event emitted with thinkingLength 0
      expect(eventBus.emit).toHaveBeenCalledWith('stream:finalized', {
        messageId: 'saved-msg-1',
        requestId: 'req-1',
        contentLength: 10,
        thinkingLength: 0,
      });
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================
  describe('dispose', () => {
    test('clears all references', () => {
      const { manager } = createManager();

      manager.dispose();

      expect(manager.messageState).toBeNull();
      expect(manager.messageView).toBeNull();
      expect(manager.eventBus).toBeNull();
    });

    test('resets finalization guard', () => {
      const { manager } = createManager();

      manager.dispose();

      expect(manager._isFinalizingStream).toBe(false);
      expect(manager._pendingFinalization).toBeNull();
    });

    test('can be called multiple times', () => {
      const { manager } = createManager();

      expect(() => {
        manager.dispose();
        manager.dispose();
      }).not.toThrow();
    });

    test('sets _isDisposed to true', () => {
      const { manager } = createManager();
      expect(manager._isDisposed).toBe(false);
      manager.dispose();
      expect(manager._isDisposed).toBe(true);
    });

    test('is idempotent — second call is a no-op', () => {
      const { manager } = createManager();
      manager.dispose();
      mockLog.info.mockClear();

      manager.dispose(); // second call
      // No additional "disposed" log
      expect(mockLog.info).not.toHaveBeenCalledWith('StreamFinalizationManager disposed');
      expect(manager._isDisposed).toBe(true);
    });

    test('BUG REGRESSION: finalize after dispose returns early via guard (not error path)', async () => {
      const { manager, messageState } = createManager();
      manager.dispose();

      await manager.finalize(createDefaultState());

      // Guard returns early — saveMessage never called (no TypeError on null)
      expect(messageState.saveMessage).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith(
        'finalize called on disposed StreamFinalizationManager'
      );
      // No error logged (guard caught it before any null-ref)
      expect(mockLog.error).not.toHaveBeenCalled();
    });

    test('BUG REGRESSION: dispose during saveMessage does not crash messageView access', async () => {
      const messageState = createMessageState({
        saveMessage: jest.fn().mockImplementation(async () => {
          // Simulate: saveMessage yields, dispose runs during await
          // Can't actually interleave, so we trigger dispose inside the mock
          return { id: 'new-id' };
        }),
      });
      const mockElement = { dataset: { messageId: 'msg-1' } };
      const messageElements = new Map([['msg-1', mockElement]]);
      const messageView = createMessageView({
        getMessageElement: jest.fn().mockReturnValue(mockElement),
        messageElements,
      });

      const { manager } = createManager({ messageState, messageView });

      // Start finalization, then dispose during saveMessage
      messageState.saveMessage.mockImplementation(async () => {
        manager.dispose(); // dispose while saveMessage is in-flight
        return { id: 'changed-id' }; // ID changes, would trigger view update
      });

      await manager.finalize(createDefaultState());

      // Should abort after saveMessage — messageView.getMessageElement NOT called
      // (messageView is now null from dispose)
      expect(messageView.getMessageElement).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith(
        'finalize aborted: disposed during saveMessage',
        { messageId: 'msg-1' }
      );
    });
  });

  // =========================================================================
  // Lifecycle integration
  // =========================================================================
  describe('lifecycle integration', () => {
    test('full lifecycle: create → finalize → finalize again → dispose', async () => {
      const messageState = createMessageState({
        saveMessage: jest.fn()
          .mockResolvedValueOnce({ id: 'saved-1' })
          .mockResolvedValueOnce({ id: 'saved-2' }),
      });

      const { manager, eventBus } = createManager({ messageState });

      // First finalization
      await manager.finalize(createDefaultState({
        messageId: 'msg-1',
        requestId: 'req-1',
        accumulatedText: 'First response',
        thinkingText: '',
      }));

      expect(eventBus.emit).toHaveBeenCalledTimes(1);
      expect(eventBus.emit.mock.calls[0][1].messageId).toBe('saved-1');

      // Second finalization (different stream)
      await manager.finalize(createDefaultState({
        messageId: 'msg-2',
        requestId: 'req-2',
        accumulatedText: 'Second response',
        thinkingText: 'More thinking',
      }));

      expect(eventBus.emit).toHaveBeenCalledTimes(2);
      expect(eventBus.emit.mock.calls[1][1].messageId).toBe('saved-2');

      // Dispose
      manager.dispose();
      expect(manager.messageState).toBeNull();
      expect(manager._isFinalizingStream).toBe(false);
    });

    test('finalize after dispose returns early via _isDisposed guard', async () => {
      const { manager, messageState } = createManager();

      manager.dispose();

      // With _isDisposed guard, finalize returns immediately — no error path needed
      await expect(manager.finalize(createDefaultState())).resolves.not.toThrow();
      expect(messageState.saveMessage).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================
  describe('module exports', () => {
    test('exports StreamFinalizationManager constructor', () => {
      expect(typeof StreamFinalizationManager).toBe('function');
    });

    test('instances have expected methods', () => {
      const { manager } = createManager();
      expect(typeof manager.finalize).toBe('function');
      expect(typeof manager.dispose).toBe('function');
    });
  });
});
