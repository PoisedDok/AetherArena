'use strict';

// ---------------------------------------------------------------------------
// Mocks — MUST be at top level so Jest hoists them before require()
// ---------------------------------------------------------------------------

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  })),
}));

jest.mock('../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: jest.fn(() => ({
    ipc: { send: jest.fn() },
    isDetachedWindow: false,
  })),
}));

jest.mock('../../../src/renderer/chat/modules/window/StyleManager', () => {
  return jest.fn().mockImplementation(() => ({
    injectStyles: jest.fn(),
    dispose: jest.fn(),
    stylesLoaded: false,
  }));
});

// CircularRingButton mock needs DOM — create element lazily via getElement
const mockCircularRingButtonInstances = [];
jest.mock('../../../src/renderer/chat/components/CircularRingButton', () => {
  return jest.fn().mockImplementation(() => {
    const instance = {
      getElement: jest.fn(() => {
        if (!instance._el) {
          instance._el = global.document.createElement('button');
          instance._el.className = 'context-ring-button';
        }
        return instance._el;
      }),
      updateDisplay: jest.fn(),
      dispose: jest.fn(),
      tokenLimit: 128000,
      thresholds: { warning: 60, high: 80, critical: 95 },
      _el: null,
    };
    mockCircularRingButtonInstances.push(instance);
    return instance;
  });
});

jest.mock('../../../src/renderer/chat/modals/ContextViewerModal', () => {
  return jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
    destroy: jest.fn(),
  }));
});

const ChatWindow = require('../../../src/renderer/chat/modules/window/ChatWindow');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEventBus() {
  return {
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  };
}

function createChatWindow(overrides = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);

  const eventBus = overrides.eventBus || createMockEventBus();
  const controller = overrides.controller || null;

  const cw = new ChatWindow({
    container,
    eventBus,
    controller,
    ...overrides,
  });

  return { cw, container, eventBus };
}

async function createInitializedChatWindow(overrides = {}) {
  const result = createChatWindow(overrides);
  await result.cw.init();
  return result;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ChatWindow', () => {
  beforeEach(() => {
    document.body.innerHTML = '';

    // Provide EventTypes and EventPriority as globals (renderer pattern)
    global.EventTypes = {
      CHAT: {
        LOADED: 'chat:loaded',
        SWITCHED: 'chat:switched',
        CREATED: 'chat:created',
        DELETED: 'chat:deleted',
        MESSAGE_SENT: 'chat:message:sent',
        MESSAGE_RECEIVED: 'chat:message:received',
        STREAM_STARTED: 'chat:stream:started',
        STREAM_CHUNK: 'chat:stream:chunk',
        STREAM_ENDED: 'chat:stream:ended',
      },
    };
    global.EventPriority = {
      CRITICAL: 100,
      HIGH: 75,
      NORMAL: 50,
      LOW: 25,
      BACKGROUND: 10,
    };

    // Re-establish logger mock after resetMocks
    const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');
    createRendererLogger.mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
    });
  });

  afterEach(() => {
    delete global.EventTypes;
    delete global.EventPriority;
  });

  // =========================================================================
  // Construction & Init
  // =========================================================================

  describe('construction', () => {
    it('sets initial state correctly', () => {
      const { cw } = createChatWindow();
      expect(cw.isVisible).toBe(false);
      expect(cw._isDisposed).toBe(false);
      expect(cw._documentClickHandler).toBeNull();
      expect(cw._initContextTimer).toBeNull();
      expect(cw._contextRefreshThrottleTimer).toBeNull();
      expect(cw.element).toBeNull();
    });
  });

  describe('init', () => {
    it('creates DOM elements and stores references', async () => {
      const { cw, container } = await createInitializedChatWindow();

      expect(cw.element).not.toBeNull();
      expect(cw.element.id).toBe('aether-chat-window');
      expect(container.contains(cw.element)).toBe(true);
      expect(cw.elements.header).not.toBeNull();
      expect(cw.elements.input).not.toBeNull();
      expect(cw.elements.sendBtn).not.toBeNull();
    });

    it('registers EventBus listeners', async () => {
      const { eventBus } = await createInitializedChatWindow();
      // 12 eventBus.on calls in setupEventListeners
      expect(eventBus.on.mock.calls.length).toBeGreaterThanOrEqual(12);
    });

    it('injects styles via StyleManager', async () => {
      const { cw } = await createInitializedChatWindow();
      expect(cw.styleManager.injectStyles).toHaveBeenCalledTimes(1);
    });

    it('sets up document click handler for attach menu', async () => {
      const { cw } = await createInitializedChatWindow();
      expect(cw._documentClickHandler).not.toBeNull();
      expect(typeof cw._documentClickHandler).toBe('function');
    });
  });

  // =========================================================================
  // Show / Hide / Toggle
  // =========================================================================

  describe('show/hide/toggle', () => {
    it('show makes window visible', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.show();
      expect(cw.isVisible).toBe(true);
      expect(cw.element.classList.contains('hidden')).toBe(false);
    });

    it('hide makes window hidden', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.show();
      cw.hide();
      expect(cw.isVisible).toBe(false);
      expect(cw.element.classList.contains('hidden')).toBe(true);
    });

    it('toggle flips visibility', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.toggle();
      expect(cw.isVisible).toBe(true);
      cw.toggle();
      expect(cw.isVisible).toBe(false);
    });
  });

  // =========================================================================
  // setTitle
  // =========================================================================

  describe('setTitle', () => {
    it('sets title text content', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.setTitle('My Chat');
      expect(cw.elements.title.textContent).toBe('My Chat');
    });

    it('truncates long titles to 50 chars', async () => {
      const { cw } = await createInitializedChatWindow();
      const longTitle = 'A'.repeat(60);
      cw.setTitle(longTitle);
      expect(cw.elements.title.textContent).toBe('A'.repeat(50) + '...');
    });

    it('defaults to "New Chat" for falsy title', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.setTitle(null);
      expect(cw.elements.title.textContent).toBe('New Chat');
    });
  });

  // =========================================================================
  // BUG CW-1 REGRESSION: _isDisposed lifecycle flag
  // =========================================================================

  describe('BUG CW-1 REGRESSION: _isDisposed lifecycle flag', () => {
    it('_isDisposed is false after construction', () => {
      const { cw } = createChatWindow();
      expect(cw._isDisposed).toBe(false);
    });

    it('_isDisposed is true after dispose()', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.dispose();
      expect(cw._isDisposed).toBe(true);
    });

    it('dispose() is idempotent — second call is no-op', async () => {
      const { cw } = await createInitializedChatWindow();
      const logSpy = cw.log.info;

      cw.dispose();
      const firstCallCount = logSpy.mock.calls.length;

      cw.dispose();
      expect(logSpy.mock.calls.length).toBe(firstCallCount);
    });

    it('show() is no-op after dispose', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.dispose();
      cw.show(); // Should not throw
      expect(cw._isDisposed).toBe(true);
    });

    it('hide() is no-op after dispose', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.dispose();
      cw.hide(); // Should not throw
      expect(cw._isDisposed).toBe(true);
    });

    it('toggle() is no-op after dispose', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.dispose();
      cw.toggle(); // Should not throw
      expect(cw._isDisposed).toBe(true);
    });

    it('refreshContextDisplay() is no-op after dispose', async () => {
      const { cw } = await createInitializedChatWindow();
      const contextButton = cw.contextButton;
      cw.dispose();
      contextButton.updateDisplay.mockClear();

      await cw.refreshContextDisplay(true);
      expect(contextButton.updateDisplay).not.toHaveBeenCalled();
    });

    it('_openContextViewer() is no-op after dispose', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.dispose();

      const ContextViewerModal = require('../../../src/renderer/chat/modals/ContextViewerModal');
      ContextViewerModal.mockClear();

      cw._openContextViewer();
      expect(ContextViewerModal).not.toHaveBeenCalled();
    });

    it('dispose nullifies all references', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.dispose();

      expect(cw.element).toBeNull();
      expect(cw.controller).toBeNull();
      expect(cw.eventBus).toBeNull();
      expect(cw.contextButton).toBeNull();
    });

    it('dispose removes EventBus listeners', async () => {
      const { cw, eventBus } = await createInitializedChatWindow();
      cw.dispose();
      // 12 eventBus.off calls (matching the 12 .on calls)
      expect(eventBus.off.mock.calls.length).toBeGreaterThanOrEqual(12);
    });

    it('dispose removes element from DOM', async () => {
      const { cw, container } = await createInitializedChatWindow();
      const element = cw.element;
      expect(container.contains(element)).toBe(true);

      cw.dispose();
      expect(container.contains(element)).toBe(false);
    });
  });

  // =========================================================================
  // BUG CW-2 REGRESSION: document-level click listener cleanup
  // =========================================================================

  describe('BUG CW-2 REGRESSION: document click listener cleanup', () => {
    it('document click handler is registered during createElements', async () => {
      const { cw } = await createInitializedChatWindow();
      expect(cw._documentClickHandler).not.toBeNull();
      expect(typeof cw._documentClickHandler).toBe('function');
    });

    it('document click handler is removed during dispose', async () => {
      const { cw } = await createInitializedChatWindow();
      const handler = cw._documentClickHandler;

      const spy = jest.spyOn(document, 'removeEventListener');
      cw.dispose();

      expect(spy).toHaveBeenCalledWith('click', handler);
      expect(cw._documentClickHandler).toBeNull();
      spy.mockRestore();
    });
  });

  // =========================================================================
  // BUG CW-4 REGRESSION: initial context refresh timer tracked
  // =========================================================================

  describe('BUG CW-4 REGRESSION: initial context timer tracked', () => {
    it('init sets _initContextTimer', async () => {
      jest.useFakeTimers();
      const { cw } = await createInitializedChatWindow();
      expect(cw._initContextTimer).not.toBeNull();
      cw.dispose();
      jest.useRealTimers();
    });

    it('dispose clears _initContextTimer', async () => {
      jest.useFakeTimers();
      const { cw } = await createInitializedChatWindow();
      expect(cw._initContextTimer).not.toBeNull();

      cw.dispose();
      expect(cw._initContextTimer).toBeNull();
      jest.useRealTimers();
    });
  });

  // =========================================================================
  // BUG CW-5 REGRESSION: throttle timer cleared in dispose
  // =========================================================================

  describe('BUG CW-5 REGRESSION: throttle timer cleared in dispose', () => {
    it('dispose clears _contextRefreshThrottleTimer if active', async () => {
      jest.useFakeTimers();
      const { cw } = await createInitializedChatWindow();

      // Simulate an active throttle timer
      cw._contextRefreshThrottleTimer = setTimeout(() => {}, 5000);
      expect(cw._contextRefreshThrottleTimer).not.toBeNull();

      cw.dispose();
      expect(cw._contextRefreshThrottleTimer).toBeNull();
      jest.useRealTimers();
    });
  });

  // =========================================================================
  // getState
  // =========================================================================

  describe('getState', () => {
    it('returns frozen state object', async () => {
      const { cw } = await createInitializedChatWindow();
      const state = cw.getState();

      expect(state.hasElement).toBe(true);
      expect(state.isDetached).toBe(false);
      expect(Object.isFrozen(state)).toBe(true);
    });
  });

  // =========================================================================
  // Context display — stream events
  // =========================================================================

  describe('context display — stream events', () => {
    it('_handleStreamStarted sets _isStreaming flag', async () => {
      const { cw } = await createInitializedChatWindow();
      expect(cw._isStreaming).toBeFalsy();
      cw._handleStreamStarted({});
      expect(cw._isStreaming).toBe(true);
    });

    it('_handleStreamStarted ignores events for other chats', async () => {
      const controller = { currentChatId: 'chat-1' };
      const { cw } = await createInitializedChatWindow({ controller });
      cw._handleStreamStarted({ chatId: 'chat-2' });
      expect(cw._isStreaming).toBeFalsy();
    });

    it('_handleStreamChunk updates local token count', async () => {
      const { cw } = await createInitializedChatWindow();
      cw._localTokenCount = 0;
      cw._handleStreamChunk({ chunk: 'Hello World!' }); // 12 chars ~ 3 tokens
      expect(cw._localTokenCount).toBeGreaterThan(0);
      expect(cw.contextButton.updateDisplay).toHaveBeenCalled();
    });

    it('_handleStreamChunk ignores empty chunk', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.contextButton.updateDisplay.mockClear();
      cw._handleStreamChunk({});
      expect(cw.contextButton.updateDisplay).not.toHaveBeenCalled();
    });

    it('_handleStreamChunk ignores events for other chats', async () => {
      const controller = { currentChatId: 'chat-1' };
      const { cw } = await createInitializedChatWindow({ controller });
      cw.contextButton.updateDisplay.mockClear();
      cw._handleStreamChunk({ chunk: 'test', chatId: 'chat-2' });
      expect(cw.contextButton.updateDisplay).not.toHaveBeenCalled();
    });

    it('_handleStreamEnded resets _isStreaming and clears throttle timer', async () => {
      const { cw } = await createInitializedChatWindow();
      cw._isStreaming = true;
      cw._contextRefreshThrottleTimer = setTimeout(() => {}, 10000);
      cw._handleStreamEnded({});
      expect(cw._isStreaming).toBe(false);
      expect(cw._contextRefreshThrottleTimer).toBeNull();
    });

    it('_handleStreamEnded ignores events for other chats', async () => {
      const controller = { currentChatId: 'chat-1' };
      const { cw } = await createInitializedChatWindow({ controller });
      cw._isStreaming = true;
      cw._handleStreamEnded({ chatId: 'chat-2' });
      expect(cw._isStreaming).toBe(true);
    });
  });

  // =========================================================================
  // Title editing — double-click flow
  // =========================================================================

  describe('title editing — double-click flow', () => {
    it('creates input element on double-click', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.setTitle('My Chat');
      const titleEl = cw.elements.title;

      cw._handleTitleDoubleClick({ stopPropagation: jest.fn() });

      expect(cw._isEditingTitle).toBe(true);
      expect(titleEl.style.display).toBe('none');
      const input = titleEl.parentNode.querySelector('.aether-chat-title-input');
      expect(input).not.toBeNull();
      expect(input.value).toBe('My Chat');
    });

    it('does not create second input on rapid double-click', async () => {
      const { cw } = await createInitializedChatWindow();
      const titleEl = cw.elements.title;

      cw._handleTitleDoubleClick({ stopPropagation: jest.fn() });
      cw._handleTitleDoubleClick({ stopPropagation: jest.fn() });

      const inputs = titleEl.parentNode.querySelectorAll('.aether-chat-title-input');
      expect(inputs).toHaveLength(1);
    });

    it('Enter key commits the edit', async () => {
      const { cw, eventBus } = await createInitializedChatWindow({
        controller: { currentChatId: 'chat-1', modules: {} },
      });
      cw.setTitle('Old Title');

      cw._handleTitleDoubleClick({ stopPropagation: jest.fn() });
      const input = cw.elements.title.parentNode.querySelector('.aether-chat-title-input');
      input.value = 'New Title';

      // Simulate Enter key
      const keyEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      input.dispatchEvent(keyEvent);

      expect(cw._isEditingTitle).toBe(false);
      expect(cw.elements.title.textContent).toBe('New Title');
      expect(eventBus.emit).toHaveBeenCalledWith('chat:title-update-requested', {
        chatId: 'chat-1',
        title: 'New Title',
      });
    });

    it('Escape key cancels the edit', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.setTitle('Keep This');

      cw._handleTitleDoubleClick({ stopPropagation: jest.fn() });
      const input = cw.elements.title.parentNode.querySelector('.aether-chat-title-input');
      input.value = 'Changed';

      const keyEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      input.dispatchEvent(keyEvent);

      expect(cw._isEditingTitle).toBe(false);
      // Title should NOT have changed on cancel — it was 'Keep This' before
      expect(cw.elements.title.style.display).toBe('');
    });

    it('blur commits the edit', async () => {
      const { cw } = await createInitializedChatWindow({
        controller: { currentChatId: 'chat-1', modules: {} },
      });
      cw.setTitle('Before');

      cw._handleTitleDoubleClick({ stopPropagation: jest.fn() });
      const input = cw.elements.title.parentNode.querySelector('.aether-chat-title-input');
      input.value = 'After';

      input.dispatchEvent(new Event('blur'));

      expect(cw._isEditingTitle).toBe(false);
      expect(cw.elements.title.textContent).toBe('After');
    });

    it('does not emit update for "New Chat" title', async () => {
      const { cw, eventBus } = await createInitializedChatWindow({
        controller: { currentChatId: 'chat-1', modules: {} },
      });
      cw.setTitle('Old Title');

      cw._handleTitleDoubleClick({ stopPropagation: jest.fn() });
      const input = cw.elements.title.parentNode.querySelector('.aether-chat-title-input');
      input.value = 'New Chat';

      input.dispatchEvent(new Event('blur'));

      // Should NOT emit title-update-requested for "New Chat"
      const titleUpdateCalls = eventBus.emit.mock.calls.filter(
        c => c[0] === 'chat:title-update-requested'
      );
      expect(titleUpdateCalls).toHaveLength(0);
    });
  });

  // =========================================================================
  // _handleVisibilityRequest
  // =========================================================================

  describe('_handleVisibilityRequest', () => {
    it('shows on chat:show event', async () => {
      const { cw } = await createInitializedChatWindow();
      cw._handleVisibilityRequest({ type: 'chat:show' });
      expect(cw.isVisible).toBe(true);
    });

    it('hides on chat:hide event', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.show();
      cw._handleVisibilityRequest({ type: 'chat:hide' });
      expect(cw.isVisible).toBe(false);
    });

    it('toggles on chat:toggle event', async () => {
      const { cw } = await createInitializedChatWindow();
      cw._handleVisibilityRequest({ type: 'chat:toggle' });
      expect(cw.isVisible).toBe(true);
      cw._handleVisibilityRequest({ type: 'chat:toggle' });
      expect(cw.isVisible).toBe(false);
    });
  });

  // =========================================================================
  // _handleTitleChange
  // =========================================================================

  describe('_handleTitleChange', () => {
    it('sets title from event data', async () => {
      const { cw } = await createInitializedChatWindow();
      cw._handleTitleChange({ title: 'Event Title' });
      expect(cw.elements.title.textContent).toBe('Event Title');
    });

    it('ignores null data', async () => {
      const { cw } = await createInitializedChatWindow();
      cw.setTitle('Keep');
      cw._handleTitleChange(null);
      expect(cw.elements.title.textContent).toBe('Keep');
    });
  });

  // =========================================================================
  // _getCurrentChatId
  // =========================================================================

  describe('_getCurrentChatId', () => {
    it('returns chatId from controller', async () => {
      const controller = { currentChatId: 'chat-42' };
      const { cw } = await createInitializedChatWindow({ controller });
      expect(cw._getCurrentChatId()).toBe('chat-42');
    });

    it('falls back to messageOrchestrator', async () => {
      const controller = {
        currentChatId: null,
        modules: {
          messageOrchestrator: {
            messageState: { currentChatId: 'orchestrator-42' },
          },
        },
      };
      const { cw } = await createInitializedChatWindow({ controller });
      expect(cw._getCurrentChatId()).toBe('orchestrator-42');
    });

    it('returns null when no controller', async () => {
      const { cw } = await createInitializedChatWindow();
      expect(cw._getCurrentChatId()).toBeNull();
    });
  });

  // =========================================================================
  // Attach menu — document click handler
  // =========================================================================

  describe('attach menu — document click handler', () => {
    it('document click closes open attach menu', async () => {
      const { cw } = await createInitializedChatWindow();
      const attachMenu = cw.element.querySelector('.aether-attach-menu');
      expect(attachMenu).not.toBeNull();

      // Open menu
      attachMenu.style.display = 'block';

      // Simulate outside click
      cw._documentClickHandler({ target: document.body });

      expect(attachMenu.style.display).toBe('none');
    });
  });

  // =========================================================================
  // Resource tracking — quantitative proof
  // =========================================================================

  describe('resource tracking — quantitative proof', () => {
    it('dispose calls contextButton.dispose()', async () => {
      const { cw } = await createInitializedChatWindow();
      const disposeSpy = cw.contextButton.dispose;

      cw.dispose();
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('dispose calls styleManager.dispose()', async () => {
      const { cw } = await createInitializedChatWindow();
      const disposeSpy = cw.styleManager.dispose;

      cw.dispose();
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('dispose destroys contextModal if created', async () => {
      const { cw } = await createInitializedChatWindow();
      const mockModal = { destroy: jest.fn(), open: jest.fn(), close: jest.fn() };
      cw.contextModal = mockModal;

      cw.dispose();
      expect(mockModal.destroy).toHaveBeenCalledTimes(1);
      expect(cw.contextModal).toBeNull();
    });
  });
});
