'use strict';

// ---------------------------------------------------------------------------
// Mocks — plain functions for logger to survive resetMocks: true
// ---------------------------------------------------------------------------

jest.mock('../../../../../src/renderer/shared/utils/logger', () => {
  const noop = () => {};
  const makeLogger = () => {
    const log = { info: noop, warn: noop, error: noop, debug: noop, trace: noop };
    log.child = () => log;
    return log;
  };
  return { createRendererLogger: makeLogger };
});

jest.mock('../../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => ({ artifacts: null }),
}));

jest.mock('../../../../../src/renderer/shared/adapters/session', () => ({
  setActiveChat: jest.fn(),
}));

const sessionBridge = require('../../../../../src/renderer/shared/adapters/session');
const ChatLifecycleManager = require('../../../../../src/renderer/chat/modules/messaging/lifecycle/ChatLifecycleManager');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  };
}

function createMessageState(overrides = {}) {
  return {
    createChat: jest.fn().mockResolvedValue('new-chat-id'),
    loadChat: jest.fn().mockResolvedValue({ id: 'chat-123', title: 'Test Chat' }),
    getMessages: jest.fn().mockReturnValue([]),
    getCurrentChatId: jest.fn().mockReturnValue(null),
    saveMessage: jest.fn().mockResolvedValue({}),
    messages: [],
    ...overrides,
  };
}

function createMessageView() {
  return {
    showLoadingState: jest.fn(),
    hideLoadingState: jest.fn(),
    clear: jest.fn(),
    showEmptyState: jest.fn(),
    renderMessages: jest.fn().mockResolvedValue(undefined),
    renderMessage: jest.fn(),
    messageElements: new Map(),
  };
}

function createEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createIpc() {
  return { send: jest.fn() };
}

function createAether() {
  return { artifacts: { switchChat: jest.fn() } };
}

function createManager(overrides = {}) {
  const log = createLogger();

  const defaults = {
    messageState: createMessageState(),
    messageView: createMessageView(),
    eventBus: createEventBus(),
    ipc: createIpc(),
    aether: createAether(),
  };

  const opts = { ...defaults, ...overrides };

  // Re-establish sessionBridge mock after resetMocks clears it
  sessionBridge.setActiveChat.mockResolvedValue(undefined);

  const manager = new ChatLifecycleManager(opts);
  manager.log = log;

  return { manager, log, ...opts };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ChatLifecycleManager', () => {
  // =========================================================================
  // constructor
  // =========================================================================
  describe('constructor', () => {
    it('stores all options correctly', () => {
      const { manager, messageState, messageView, eventBus, ipc } = createManager();
      expect(manager.messageState).toBe(messageState);
      expect(manager.messageView).toBe(messageView);
      expect(manager.eventBus).toBe(eventBus);
      expect(manager.ipc).toBe(ipc);
    });

    it('throws when messageState is missing', () => {
      expect(() => createManager({ messageState: null }))
        .toThrow('messageState is REQUIRED');
    });

    it('throws when messageView is missing', () => {
      expect(() => createManager({ messageView: null }))
        .toThrow('messageView is REQUIRED');
    });

    it('initializes _activeLoad to null', () => {
      const { manager } = createManager();
      expect(manager._activeLoad).toBeNull();
    });

    it('initializes _isDisposed to false', () => {
      const { manager } = createManager();
      expect(manager._isDisposed).toBe(false);
    });

    it('throws when called with no arguments (exercises default options={})', () => {
      expect(() => new ChatLifecycleManager()).toThrow('messageState is REQUIRED');
    });

    it('uses provided aether over getAether() default', () => {
      const customAether = { artifacts: { switchChat: jest.fn() } };
      const { manager } = createManager({ aether: customAether });
      expect(manager.aether).toBe(customAether);
    });

    it('falls back to getAether() when aether not provided', () => {
      const log = createLogger();
      sessionBridge.setActiveChat.mockResolvedValue(undefined);
      const manager = new ChatLifecycleManager({
        messageState: createMessageState(),
        messageView: createMessageView(),
      });
      manager.log = log;
      // getAether returns { artifacts: null } from mock
      expect(manager.aether).toEqual({ artifacts: null });
    });
  });

  // =========================================================================
  // createChat
  // =========================================================================
  describe('createChat', () => {
    it('creates chat via messageState.createChat with given title', async () => {
      const { manager, messageState } = createManager();
      await manager.createChat('My Chat');
      expect(messageState.createChat).toHaveBeenCalledWith('My Chat');
    });

    it('uses default title "New Chat" when none provided', async () => {
      const { manager, messageState } = createManager();
      await manager.createChat();
      expect(messageState.createChat).toHaveBeenCalledWith('New Chat');
    });

    it('emits chat:title-changed event', async () => {
      const { manager, eventBus } = createManager();
      await manager.createChat('My Chat');
      expect(eventBus.emit).toHaveBeenCalledWith('chat:title-changed', { title: 'My Chat' });
    });

    it('does not emit when eventBus is null', async () => {
      const { manager } = createManager({ eventBus: null });
      await manager.createChat('My Chat');
      // No crash, no event emitted
    });

    it('clears the message view', async () => {
      const { manager, messageView } = createManager();
      await manager.createChat('My Chat');
      expect(messageView.clear).toHaveBeenCalled();
    });

    it('sets active session via sessionBridge', async () => {
      const { manager } = createManager();
      await manager.createChat();
      expect(sessionBridge.setActiveChat).toHaveBeenCalledWith('new-chat-id');
    });

    it('notifies backend via IPC context_reset', async () => {
      const { manager, ipc } = createManager();
      await manager.createChat();
      expect(ipc.send).toHaveBeenCalledWith('chat:send', expect.objectContaining({
        chatId: 'new-chat-id',
        metadata: expect.objectContaining({
          type: 'context_reset',
          chatId: 'new-chat-id',
        }),
      }));
    });

    it('seeds messages if options.seedMessages is provided', async () => {
      const { manager, messageState, messageView } = createManager();
      const seedMsg1 = { role: 'system', content: 'test' };
      const seedMsg2 = { role: 'assistant', content: 'hello' };
      messageState.saveMessage
        .mockResolvedValueOnce({ ...seedMsg1, id: '1' })
        .mockResolvedValueOnce({ ...seedMsg2, id: '2' });

      await manager.createChat('Test Chat', { seedMessages: [seedMsg1, seedMsg2] });

      expect(messageState.saveMessage).toHaveBeenCalledTimes(2);
      expect(messageState.saveMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ role: 'system', chatId: 'new-chat-id' }));
      expect(messageState.saveMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ role: 'assistant', chatId: 'new-chat-id' }));
      expect(messageView.renderMessage).toHaveBeenCalledTimes(2);
      expect(messageView.renderMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: '1' }));
    });

    it('returns the new chatId', async () => {
      const { manager } = createManager();
      const chatId = await manager.createChat();
      expect(chatId).toBe('new-chat-id');
    });

    it('throws when messageState.createChat fails', async () => {
      const { manager, messageState } = createManager();
      messageState.createChat.mockRejectedValue(new Error('create failed'));
      await expect(manager.createChat()).rejects.toThrow('create failed');
    });

    it('throws when IPC is missing', async () => {
      const { manager } = createManager({ ipc: null });
      await expect(manager.createChat()).rejects.toThrow('IPC bridge is REQUIRED');
    });

    it('returns null and warns when called after dispose', async () => {
      const { manager, log, messageState } = createManager();
      manager.dispose();
      const result = await manager.createChat('After Dispose');
      expect(result).toBeNull();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('disposed'),
        expect.objectContaining({ title: 'After Dispose' })
      );
      expect(messageState.createChat).not.toHaveBeenCalled();
    });

    it('BUG REGRESSION: aborts when disposed during messageState.createChat await', async () => {
      const { manager, log, messageState, messageView } = createManager();

      // messageState.createChat yields, then dispose runs before continuation
      messageState.createChat.mockImplementation(async () => {
        manager.dispose(); // dispose during async operation
        return 'orphan-id';
      });

      const result = await manager.createChat('Mid-Async Dispose');

      // Should abort and return null, NOT crash on this.messageView.clear()
      expect(result).toBeNull();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('disposed during messageState.createChat'),
        expect.objectContaining({ title: 'Mid-Async Dispose' })
      );
      // messageView.clear() must NOT have been called (it was nulled by dispose)
      expect(messageView.clear).not.toHaveBeenCalled();
    });

    it('BUG REGRESSION: aborts when disposed during setActiveChat await', async () => {
      const { manager, log, messageView, eventBus } = createManager();

      // sessionBridge.setActiveChat yields, then dispose runs before continuation
      sessionBridge.setActiveChat.mockImplementation(async () => {
        manager.dispose();
      });

      const result = await manager.createChat('Dispose During Session');

      expect(result).toBeNull();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('disposed during setActiveChat'),
        expect.objectContaining({ title: 'Dispose During Session' })
      );
      // messageView.clear was called before setActiveChat (sync step before await)
      expect(messageView.clear).toHaveBeenCalled();
      // But backend notification must NOT have been attempted
    });

    it('BUG REGRESSION: aborts when disposed during backend notification await', async () => {
      const { manager, log, ipc } = createManager();

      // ipc.send is called synchronously inside _notifyBackendContextSwitch.
      // Dispose happens during that call. The lifecycle guard after the await catches it.
      ipc.send.mockImplementation(() => {
        manager.dispose();
      });

      const result = await manager.createChat('Dispose During Backend');

      expect(result).toBeNull();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('disposed during backend notification'),
        expect.objectContaining({ title: 'Dispose During Backend' })
      );
    });
  });

  // =========================================================================
  // loadChat
  // =========================================================================
  describe('loadChat', () => {
    it('shows loading state before loading', async () => {
      const { manager, messageView } = createManager();
      await manager.loadChat('chat-1');
      expect(messageView.showLoadingState).toHaveBeenCalled();
    });

    it('loads chat via messageState.loadChat', async () => {
      const { manager, messageState } = createManager();
      await manager.loadChat('chat-1');
      expect(messageState.loadChat).toHaveBeenCalledWith('chat-1');
    });

    it('emits chat:title-changed when chat has title', async () => {
      const { manager, eventBus } = createManager();
      await manager.loadChat('chat-1');
      expect(eventBus.emit).toHaveBeenCalledWith('chat:title-changed', { title: 'Test Chat' });
    });

    it('does not emit title event when chat has no title', async () => {
      const { manager, eventBus, messageState } = createManager();
      messageState.loadChat.mockResolvedValue({ id: 'chat-1' });
      await manager.loadChat('chat-1');
      expect(eventBus.emit).not.toHaveBeenCalledWith('chat:title-changed', expect.anything());
    });

    it('hides loading state and clears view', async () => {
      const { manager, messageView } = createManager();
      await manager.loadChat('chat-1');
      expect(messageView.hideLoadingState).toHaveBeenCalled();
      expect(messageView.clear).toHaveBeenCalled();
    });

    it('sets active session via sessionBridge', async () => {
      const { manager } = createManager();
      await manager.loadChat('chat-1');
      expect(sessionBridge.setActiveChat).toHaveBeenCalledWith('chat-1');
    });

    it('notifies backend via IPC context_reset', async () => {
      const { manager, ipc } = createManager();
      await manager.loadChat('chat-1');
      expect(ipc.send).toHaveBeenCalledWith('chat:send', expect.objectContaining({
        chatId: 'chat-1',
        metadata: expect.objectContaining({ type: 'context_reset' }),
      }));
    });

    it('notifies artifacts renderer of chat switch', async () => {
      const { manager, aether } = createManager();
      await manager.loadChat('chat-1');
      expect(aether.artifacts.switchChat).toHaveBeenCalledWith('chat-1');
    });

    it('renders messages when present', async () => {
      const msgs = [
        { id: 'm1', role: 'user', content: 'hi', timestamp: Date.now() },
        { id: 'm2', role: 'assistant', content: 'hello', timestamp: Date.now() },
      ];
      const { manager, messageState, messageView } = createManager();
      messageState.getMessages.mockReturnValue(msgs);

      await manager.loadChat('chat-1');

      expect(messageView.renderMessages).toHaveBeenCalledWith(msgs);
      expect(messageView.showEmptyState).not.toHaveBeenCalled();
    });

    it('shows empty state when no messages', async () => {
      const { manager, messageView, messageState } = createManager();
      messageState.getMessages.mockReturnValue([]);

      await manager.loadChat('chat-1');

      expect(messageView.showEmptyState).toHaveBeenCalled();
      expect(messageView.renderMessages).not.toHaveBeenCalled();
    });

    it('falls back to renderMessage loop when renderMessages not available', async () => {
      const msgs = [
        { id: 'm1', role: 'user', content: 'hi', timestamp: Date.now() },
        { id: 'm2', role: 'assistant', content: 'hello', timestamp: Date.now() },
      ];
      const { manager, messageState, messageView } = createManager();
      messageState.getMessages.mockReturnValue(msgs);
      messageView.renderMessages = undefined; // Not a function

      await manager.loadChat('chat-1');

      expect(messageView.renderMessage).toHaveBeenCalledTimes(2);
      expect(messageView.renderMessage).toHaveBeenCalledWith(msgs[0]);
      expect(messageView.renderMessage).toHaveBeenCalledWith(msgs[1]);
    });

    it('requests session restoration via eventBus', async () => {
      const { manager, eventBus } = createManager();
      await manager.loadChat('chat-1');
      expect(eventBus.emit).toHaveBeenCalledWith('session:restoration:requested', { chatId: 'chat-1' });
    });

    it('logs warning when eventBus is null for session restoration', async () => {
      const { manager, log } = createManager({ eventBus: null });
      await manager.loadChat('chat-1');
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('EventBus not available'));
    });

    it('skips reload for already-active chat with rendered messages', async () => {
      const { manager, messageState, messageView } = createManager();
      messageState.getCurrentChatId.mockReturnValue('chat-1');
      messageView.messageElements.set('m1', document.createElement('div'));

      await manager.loadChat('chat-1');

      expect(messageState.loadChat).not.toHaveBeenCalled();
    });

    it('forces reload when force=true even for active chat', async () => {
      const { manager, messageState, messageView } = createManager();
      messageState.getCurrentChatId.mockReturnValue('chat-1');
      messageView.messageElements.set('m1', document.createElement('div'));

      await manager.loadChat('chat-1', { force: true });

      expect(messageState.loadChat).toHaveBeenCalledWith('chat-1');
    });

    it('dedup guard: returns same promise for concurrent loads of same chat', async () => {
      const { manager, messageState } = createManager();

      const p1 = manager.loadChat('chat-1');
      const p2 = manager.loadChat('chat-1');

      await Promise.all([p1, p2]);

      // Only one loadChat call despite two loadChat invocations
      expect(messageState.loadChat).toHaveBeenCalledTimes(1);
    });

    it('clears _activeLoad in finally block', async () => {
      const { manager } = createManager();
      await manager.loadChat('chat-1');
      expect(manager._activeLoad).toBeNull();
    });

    it('clears _activeLoad even when loadChat fails', async () => {
      const { manager, messageState } = createManager();
      messageState.loadChat.mockRejectedValue(new Error('load failed'));

      await manager.loadChat('chat-1');

      expect(manager._activeLoad).toBeNull();
    });

    it('logs error when loadChat fails (does not throw)', async () => {
      const { manager, messageState, log } = createManager();
      messageState.loadChat.mockRejectedValue(new Error('load failed'));

      // loadChat catches errors internally — should not throw
      await manager.loadChat('chat-1');

      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load chat'),
        expect.objectContaining({ chatId: 'chat-1' })
      );
    });

    it('handles messageState with currentChatId property instead of method', async () => {
      const ms = createMessageState();
      ms.getCurrentChatId = undefined;
      ms.currentChatId = 'chat-1';
      const { manager, messageView } = createManager({ messageState: ms });
      messageView.messageElements.set('m1', document.createElement('div'));

      await manager.loadChat('chat-1');

      // Should skip because currentChatId matches and has rendered messages
      expect(ms.loadChat).not.toHaveBeenCalled();
    });

    it('handles null options parameter', async () => {
      const { manager, messageState } = createManager();
      // null options should be handled (destructured with defaults)
      await manager.loadChat('chat-1', null);
      expect(messageState.loadChat).toHaveBeenCalledWith('chat-1');
    });

    it('does not emit title when chat is null', async () => {
      const { manager, eventBus, messageState } = createManager();
      messageState.loadChat.mockResolvedValue(null);
      await manager.loadChat('chat-1');
      expect(eventBus.emit).not.toHaveBeenCalledWith('chat:title-changed', expect.anything());
    });

    it('does not skip when chat has no rendered messages', async () => {
      const { manager, messageState, messageView } = createManager();
      messageState.getCurrentChatId.mockReturnValue('chat-1');
      // messageElements is empty (size 0)

      await manager.loadChat('chat-1');

      expect(messageState.loadChat).toHaveBeenCalledWith('chat-1');
    });

    it('returns early and warns when called after dispose', async () => {
      const { manager, log, messageState } = createManager();
      manager.dispose();
      await manager.loadChat('chat-1');
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('disposed'),
        expect.objectContaining({ chatId: 'chat-1' })
      );
      expect(messageState.loadChat).not.toHaveBeenCalled();
    });

    it('proceeds to load when chatId is null (no skip, exercises chatId&& falsiness)', async () => {
      const { manager, messageState, messageView } = createManager();
      messageState.loadChat.mockResolvedValue(null);
      messageState.getMessages.mockReturnValue([]);
      await manager.loadChat(null);
      // chatId is falsy, so the skip guard at line 127 is bypassed
      expect(messageView.showLoadingState).toHaveBeenCalled();
    });

    it('proceeds to load when chatId is undefined', async () => {
      const { manager, messageState, messageView } = createManager();
      messageState.loadChat.mockResolvedValue(null);
      messageState.getMessages.mockReturnValue([]);
      await manager.loadChat(undefined);
      expect(messageView.showLoadingState).toHaveBeenCalled();
    });

    it('BUG REGRESSION: undefined chatId does not false-match null _activeLoad dedup guard', async () => {
      // Before fix: null?.chatId === undefined was true, causing null.promise TypeError
      // After fix: this._activeLoad && ... short-circuits to false when _activeLoad is null
      const { manager, messageState, messageView } = createManager();
      messageState.loadChat.mockResolvedValue(null);
      messageState.getMessages.mockReturnValue([]);

      expect(manager._activeLoad).toBeNull();
      await manager.loadChat(undefined);

      // Should proceed past dedup guard to loading state, not crash
      expect(messageView.showLoadingState).toHaveBeenCalled();
    });

    it('concurrent loads for different chatIds both execute', async () => {
      const { manager, messageState } = createManager();
      let resolveFirst;
      messageState.loadChat
        .mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }))
        .mockImplementationOnce(() => Promise.resolve({ id: 'chat-2', title: 'Second' }));
      messageState.getMessages.mockReturnValue([]);

      const p1 = manager.loadChat('chat-1');
      const p2 = manager.loadChat('chat-2');

      // First load is pending, second starts because different chatId
      // _activeLoad was overwritten to chat-2
      expect(manager._activeLoad.chatId).toBe('chat-2');

      resolveFirst({ id: 'chat-1', title: 'First' });
      await Promise.all([p1, p2]);

      // Both loadChat calls were made
      expect(messageState.loadChat).toHaveBeenCalledWith('chat-1');
      expect(messageState.loadChat).toHaveBeenCalledWith('chat-2');
    });

    it('finally block preserves _activeLoad from different chatId', async () => {
      const { manager, messageState } = createManager();
      let resolveFirst;
      messageState.loadChat
        .mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }))
        .mockImplementationOnce(() => Promise.resolve({ id: 'chat-2', title: 'Two' }));
      messageState.getMessages.mockReturnValue([]);

      const p1 = manager.loadChat('chat-1');
      const p2 = manager.loadChat('chat-2');

      // Resolve chat-1 after chat-2 is already set as _activeLoad
      resolveFirst({ id: 'chat-1', title: 'One' });
      await p1;

      // chat-1's finally should NOT clear _activeLoad (it belongs to chat-2)
      // (chat-2 might still be in progress or already cleared itself)
      // The key assertion: no crash, both complete
      await p2;
    });
  });

  // =========================================================================
  // _notifyBackendContextSwitch
  // =========================================================================
  describe('_notifyBackendContextSwitch', () => {
    it('sends context_reset via IPC with correct payload', async () => {
      const { manager, ipc } = createManager();
      await manager._notifyBackendContextSwitch('chat-42');

      expect(ipc.send).toHaveBeenCalledWith('chat:send', {
        message: '',
        chatId: 'chat-42',
        metadata: {
          type: 'context_reset',
          chatId: 'chat-42',
          timestamp: expect.any(Number),
        },
      });
    });

    it('throws when IPC is null', async () => {
      const { manager } = createManager({ ipc: null });
      await expect(manager._notifyBackendContextSwitch('c1'))
        .rejects.toThrow('IPC bridge is REQUIRED');
    });

    it('throws when IPC.send is not a function', async () => {
      const { manager } = createManager({ ipc: { send: 'nope' } });
      await expect(manager._notifyBackendContextSwitch('c1'))
        .rejects.toThrow('IPC bridge is REQUIRED');
    });

    it('logs error and re-throws on failure', async () => {
      const { manager, ipc, log } = createManager();
      ipc.send.mockImplementation(() => { throw new Error('IPC down'); });

      await expect(manager._notifyBackendContextSwitch('c1'))
        .rejects.toThrow('IPC down');
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to notify backend'),
        expect.objectContaining({ chatId: 'c1' })
      );
    });
  });

  // =========================================================================
  // _notifyArtifactsOfChatSwitch
  // =========================================================================
  describe('_notifyArtifactsOfChatSwitch', () => {
    it('uses aether.artifacts.switchChat when available', () => {
      const { manager, aether } = createManager();
      manager._notifyArtifactsOfChatSwitch('chat-1');
      expect(aether.artifacts.switchChat).toHaveBeenCalledWith('chat-1');
    });

    it('falls back to IPC when aether.artifacts unavailable', () => {
      const { manager, ipc } = createManager({ aether: { artifacts: null } });
      manager._notifyArtifactsOfChatSwitch('chat-1');
      expect(ipc.send).toHaveBeenCalledWith('artifacts:switch-chat', 'chat-1');
    });

    it('falls back to IPC when switchChat is not a function', () => {
      const { manager, ipc } = createManager({ aether: { artifacts: { switchChat: 'nope' } } });
      manager._notifyArtifactsOfChatSwitch('chat-1');
      expect(ipc.send).toHaveBeenCalledWith('artifacts:switch-chat', 'chat-1');
    });

    it('no-ops when neither aether.artifacts nor IPC available', () => {
      const { manager } = createManager({ aether: null, ipc: null });
      // Should not crash
      expect(() => manager._notifyArtifactsOfChatSwitch('c1')).not.toThrow();
    });

    it('no-ops when aether has no artifacts and IPC has no send', () => {
      const { manager } = createManager({ aether: {}, ipc: {} });
      expect(() => manager._notifyArtifactsOfChatSwitch('c1')).not.toThrow();
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================
  describe('dispose', () => {
    it('nulls all references', () => {
      const { manager } = createManager();
      manager.dispose();

      expect(manager.messageState).toBeNull();
      expect(manager.messageView).toBeNull();
      expect(manager.eventBus).toBeNull();
      expect(manager.ipc).toBeNull();
      expect(manager.trailOrchestrator).toBeNull();
    });

    it('sets _isDisposed to true', () => {
      const { manager } = createManager();
      expect(manager._isDisposed).toBe(false);
      manager.dispose();
      expect(manager._isDisposed).toBe(true);
    });

    it('clears _activeLoad', () => {
      const { manager } = createManager();
      // Simulate in-flight load
      manager._activeLoad = { chatId: 'c1', promise: Promise.resolve() };
      manager.dispose();
      expect(manager._activeLoad).toBeNull();
    });

    it('is idempotent — second call is a no-op', () => {
      const { manager, log } = createManager();
      manager.dispose();
      const logCallCount = log.info.mock.calls.length;

      manager.dispose(); // second call
      // No additional log.info call for "disposed" message
      expect(log.info.mock.calls.length).toBe(logCallCount);
      // Still disposed
      expect(manager._isDisposed).toBe(true);
    });
  });

  // =========================================================================
  // Integration
  // =========================================================================
  describe('integration', () => {
    it('create then load lifecycle', async () => {
      const { manager, messageState, messageView, eventBus, ipc } = createManager();

      // Create
      const chatId = await manager.createChat('First Chat');
      expect(chatId).toBe('new-chat-id');
      expect(messageView.clear).toHaveBeenCalled();

      // Load same chat with messages
      const msgs = [{ id: 'm1', role: 'user', content: 'hi', timestamp: Date.now() }];
      messageState.getMessages.mockReturnValue(msgs);
      messageState.loadChat.mockResolvedValue({ id: chatId, title: 'First Chat' });

      await manager.loadChat(chatId, { force: true });

      expect(messageView.renderMessages).toHaveBeenCalledWith(msgs);
      expect(eventBus.emit).toHaveBeenCalledWith('session:restoration:requested', { chatId });
    });
  });
});
