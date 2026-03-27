/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */

'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() };

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

jest.mock('../../../../src/core/events/EventTypes', () => ({
  EventTypes: {
    HANDSFREE: { STATE_CHANGED: 'handsfree:state-changed' },
    UI: { SETTINGS_SAVED: 'ui:settings-saved' },
    WELCOME: { START: 'welcome:start', DISMISS: 'welcome:dismiss' },
  },
}));

// Stub fetch globally
global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });

const HandsfreeConversationDisplay = require('../../../../src/renderer/main/modules/handsfree/HandsfreeConversationDisplay');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEventBus() {
  const handlers = {};
  return {
    on: jest.fn((event, handler) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    off: jest.fn((event, handler) => {
      if (handlers[event]) handlers[event] = handlers[event].filter((h) => h !== handler);
    }),
    emit: jest.fn((event, data) => {
      (handlers[event] || []).forEach((h) => h(data));
    }),
    _handlers: handlers,
  };
}

function setupDOM() {
  const overlay = document.createElement('div');
  overlay.id = 'handsfree-conversation';
  overlay.classList.add('hidden');
  document.body.appendChild(overlay);

  const container = document.createElement('div');
  container.id = 'proactive-notifications-container';
  document.body.appendChild(container);

  return { overlay, container };
}

function createDisplay(overrides = {}) {
  const eventBus = overrides.eventBus || makeEventBus();
  const apiClient = overrides.apiClient || {
    post: jest.fn().mockResolvedValue(new ArrayBuffer(200)),
  };
  const display = new HandsfreeConversationDisplay({
    eventBus,
    apiClient,
    ...overrides,
  });
  return { display, eventBus };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HandsfreeConversationDisplay', () => {
  let domElements;

  beforeEach(() => {
    domElements = setupDOM();
  });

  afterEach(() => {
    document.getElementById('handsfree-conversation')?.remove();
    document.getElementById('proactive-notifications-container')?.remove();
    jest.restoreAllMocks();
    jest.clearAllTimers();
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    test('sets initial state', () => {
      const { display } = createDisplay();
      expect(display._isInitialized).toBe(false);
      expect(display._isDisposed).toBe(false);
      expect(display._isVisible).toBe(false);
      expect(display._currentProactiveMessage).toBeNull();
      expect(display._hideTimeout).toBeNull();
      expect(display._eventBusCleanups).toEqual([]);
      expect(display._proactiveTextAccumulator).toBe('');
      expect(display._consumedRunId).toBeNull();
      expect(display._proactiveStreamComplete).toBe(false);
    });

    test('stores eventBus', () => {
      const eventBus = makeEventBus();
      const { display } = createDisplay({ eventBus });
      expect(display.eventBus).toBe(eventBus);
    });

    test('uses default proactive TTS config', () => {
      const { display } = createDisplay();
      expect(display._proactiveTts.enabled).toBe(false);
      expect(display._proactiveTts.voice).toBe('Ryan');
    });

    test('merges custom proactive TTS config', () => {
      const { display } = createDisplay({ proactiveTts: { enabled: true, voice: 'Custom' } });
      expect(display._proactiveTts.enabled).toBe(true);
      expect(display._proactiveTts.voice).toBe('Custom');
    });

    test('logs error when eventBus is missing', () => {
      mockLog.error.mockClear();
      const display = new HandsfreeConversationDisplay({});
      expect(mockLog.error).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // initialize()
  // -----------------------------------------------------------------------

  describe('initialize()', () => {
    test('finds DOM elements and sets up listeners', async () => {
      const { display, eventBus } = createDisplay();
      await display.initialize();
      expect(display._isInitialized).toBe(true);
      expect(display.overlay).toBe(domElements.overlay);
      expect(display.proactiveContainer).toBe(domElements.container);
      expect(display._eventBusCleanups.length).toBeGreaterThan(0);
      expect(eventBus.on).toHaveBeenCalled();
    });

    test('warns on double initialization', async () => {
      const { display } = createDisplay();
      await display.initialize();
      mockLog.warn.mockClear();
      await display.initialize();
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Already initialized'));
    });

    test('errors when DOM elements missing', async () => {
      document.getElementById('handsfree-conversation').remove();
      const { display } = createDisplay();
      mockLog.error.mockClear();
      await display.initialize();
      expect(display._isInitialized).toBe(false);
      expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Required DOM elements'));
    });
  });

  // -----------------------------------------------------------------------
  // _createMessage()
  // -----------------------------------------------------------------------

  describe('_createMessage()', () => {
    test('creates message with role class', () => {
      const { display } = createDisplay();
      const msg = display._createMessage('assistant', 'Hello', 'msg-1');
      expect(msg.classList.contains('assistant')).toBe(true);
      expect(msg.id).toBe('msg-1');
      expect(msg.querySelector('.handsfree-message-content').textContent).toBe('Hello');
    });
  });

  // -----------------------------------------------------------------------
  // _insertSourceTag()
  // -----------------------------------------------------------------------

  describe('_insertSourceTag()', () => {
    test('inserts source tags for known types', () => {
      const { display } = createDisplay();
      const msg = display._createMessage('assistant', 'Test', 'msg-1');
      display._insertSourceTag(msg, { sources: [{ type: 'email' }] });
      expect(msg.querySelector('.proactive-source-tag')).not.toBeNull();
      expect(msg.querySelector('.proactive-source-email')).not.toBeNull();
    });

    test('no-ops when no context', () => {
      const { display } = createDisplay();
      const msg = display._createMessage('assistant', 'Test', 'msg-1');
      display._insertSourceTag(msg, null);
      expect(msg.querySelector('.proactive-source-tags')).toBeNull();
    });

    test('no-ops when sources empty', () => {
      const { display } = createDisplay();
      const msg = display._createMessage('assistant', 'Test', 'msg-1');
      display._insertSourceTag(msg, { sources: [] });
      expect(msg.querySelector('.proactive-source-tags')).toBeNull();
    });

    test('deduplicates source types', () => {
      const { display } = createDisplay();
      const msg = display._createMessage('assistant', 'Test', 'msg-1');
      display._insertSourceTag(msg, { sources: [{ type: 'email' }, { type: 'email' }] });
      expect(msg.querySelectorAll('.proactive-source-tag')).toHaveLength(1);
    });

    test('uses fallback for unknown types', () => {
      const { display } = createDisplay();
      const msg = display._createMessage('assistant', 'Test', 'msg-1');
      display._insertSourceTag(msg, { sources: [{ type: 'custom_thing' }] });
      const tag = msg.querySelector('.proactive-source-tag');
      expect(tag.textContent).toContain('custom_thing');
    });
  });

  // -----------------------------------------------------------------------
  // _handleProactiveChunk()
  // -----------------------------------------------------------------------

  describe('_handleProactiveChunk()', () => {
    test('creates message on first chunk', async () => {
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Hello', run_id: 'r1' });

      expect(display._currentProactiveMessage).not.toBeNull();
      expect(domElements.container.children.length).toBe(1);
      expect(display._proactiveTextAccumulator).toBe('Hello');
    });

    test('appends to existing message on subsequent chunks', async () => {
      jest.useFakeTimers();
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Hello ', run_id: 'r1' });
      jest.advanceTimersByTime(1000); // Allow typing to finish
      display._handleProactiveChunk({ content: 'World', run_id: 'r1' });
      jest.advanceTimersByTime(1000); // Allow typing to finish

      const content = display._currentProactiveMessage.querySelector('.handsfree-message-content');
      expect(content.textContent).toBe('Hello World');
      expect(display._proactiveTextAccumulator).toBe('Hello World');
      jest.useRealTimers();
    });

    test('ignores empty chunks', async () => {
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: '' });
      expect(display._currentProactiveMessage).toBeNull();
    });

    test('ignores chunks for consumed run_id', async () => {
      const { display } = createDisplay();
      await display.initialize();
      display._consumedRunId = 'r1';

      display._handleProactiveChunk({ content: 'Hello', run_id: 'r1' });
      expect(display._currentProactiveMessage).toBeNull();
    });

    test('replaces old notification when new run_id arrives', async () => {
      jest.useFakeTimers();
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Old', run_id: 'r1' });
      jest.advanceTimersByTime(1000);
      display._handleProactiveChunk({ content: 'New', run_id: 'r2' });
      jest.advanceTimersByTime(1000);

      const content = display._currentProactiveMessage.querySelector('.handsfree-message-content');
      expect(content.textContent).toBe('New');
      expect(display._proactiveTextAccumulator).toBe('New');
      jest.useRealTimers();
    });

    test('supports legacy chunk field names', async () => {
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ chunk: 'Chunk text', run_id: 'r1' });
      expect(display._proactiveTextAccumulator).toBe('Chunk text');
    });

    test('stores run_id in dataset', async () => {
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Hi', run_id: 'run-abc' });
      expect(display._currentProactiveMessage.dataset.runId).toBe('run-abc');
    });
  });

  // -----------------------------------------------------------------------
  // _handleProactiveEnd()
  // -----------------------------------------------------------------------

  describe('_handleProactiveEnd()', () => {
    test('enables interaction after stream ends', async () => {
      jest.useFakeTimers();
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Hello', run_id: 'r1' });
      expect(display._proactiveStreamComplete).toBe(false);

      display._handleProactiveEnd({});
      expect(display._proactiveStreamComplete).toBe(true);

      jest.useRealTimers();
    });

    test('removes typing class', async () => {
      jest.useFakeTimers();
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Hi', run_id: 'r1' });
      const content = display._currentProactiveMessage.querySelector('.handsfree-message-content');
      expect(content.classList.contains('typing')).toBe(true);

      display._handleProactiveEnd({});
      jest.advanceTimersByTime(1000);
      expect(content.classList.contains('typing')).toBe(false);

      jest.useRealTimers();
    });

    test('shows dismiss button', async () => {
      jest.useFakeTimers();
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Hi', run_id: 'r1' });
      const dismissBefore = display._currentProactiveMessage.querySelector('.proactive-dismiss-btn');
      expect(dismissBefore.style.display).toBe('none');

      display._handleProactiveEnd({});
      expect(dismissBefore.style.display).toBe('');

      jest.useRealTimers();
    });

    test('resets text accumulator', async () => {
      jest.useFakeTimers();
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Text', run_id: 'r1' });
      expect(display._proactiveTextAccumulator).toBe('Text');

      display._handleProactiveEnd({});
      expect(display._proactiveTextAccumulator).toBe('');

      jest.useRealTimers();
    });

    test('sets auto-hide timeout', async () => {
      jest.useFakeTimers();
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Hi', run_id: 'r1' });
      display._handleProactiveEnd({});
      expect(display._proactiveTimeoutId).not.toBeNull();

      jest.useRealTimers();
    });
  });

  // -----------------------------------------------------------------------
  // _handleProactiveClick()
  // -----------------------------------------------------------------------

  describe('_handleProactiveClick()', () => {
    test('sends clicked feedback and opens chat', async () => {
      const { display, eventBus } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Hi', run_id: 'r1' });
      display._handleProactiveEnd({});

      display._handleProactiveClick('r1', { sources: [] }, 'recommendation');

      expect(display._consumedRunId).toBe('r1');
      expect(display.apiClient.post).toHaveBeenCalledWith(
        expect.stringContaining('/v1/proactive/r1/feedback?feedback=clicked')
      );
      expect(eventBus.emit).toHaveBeenCalledWith('proactive:open-chat', expect.objectContaining({
        isProactive: true,
      }));
    });

    test('no-ops without run_id', () => {
      const { display } = createDisplay();
      display._handleProactiveClick(null, null, null);
      expect(display._consumedRunId).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // _handleProactiveDismiss()
  // -----------------------------------------------------------------------

  describe('_handleProactiveDismiss()', () => {
    test('sends dismissed feedback and removes message', async () => {
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Hi', run_id: 'r1' });
      display._handleProactiveDismiss('r1');

      expect(display.apiClient.post).toHaveBeenCalledWith(
        expect.stringContaining('feedback=dismissed')
      );
      expect(display._currentProactiveMessage).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // show() / hide()
  // -----------------------------------------------------------------------

  describe('show() / hide()', () => {
    test('show removes hidden class', async () => {
      const { display } = createDisplay();
      await display.initialize();
      display.show();
      expect(display._isVisible).toBe(true);
      expect(display.overlay.classList.contains('hidden')).toBe(false);
    });

    test('hide adds hidden class', async () => {
      const { display } = createDisplay();
      await display.initialize();
      display.show();
      display.hide();
      expect(display._isVisible).toBe(false);
      expect(display.overlay.classList.contains('hidden')).toBe(true);
    });

    test('show no-ops when already visible', async () => {
      const { display } = createDisplay();
      await display.initialize();
      display.show();
      display.show(); // Should not throw
      expect(display._isVisible).toBe(true);
    });

    test('hide no-ops when already hidden', async () => {
      const { display } = createDisplay();
      await display.initialize();
      display.hide(); // Already hidden
      expect(display._isVisible).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // updateProactiveTtsConfig()
  // -----------------------------------------------------------------------

  describe('updateProactiveTtsConfig()', () => {
    test('merges new config', () => {
      const { display } = createDisplay();
      display.updateProactiveTtsConfig({ enabled: true, voice: 'Nova' });
      expect(display._proactiveTts.enabled).toBe(true);
      expect(display._proactiveTts.voice).toBe('Nova');
    });

    test('ignores null config', () => {
      const { display } = createDisplay();
      display.updateProactiveTtsConfig(null);
      expect(display._proactiveTts.voice).toBe('Ryan');
    });
  });

  // -----------------------------------------------------------------------
  // _sendProactiveFeedback()
  // -----------------------------------------------------------------------

  describe('_sendProactiveFeedback()', () => {
    test('sends POST to feedback endpoint', () => {
      const { display } = createDisplay();
      display._sendProactiveFeedback('r1', 'timeout');
      expect(display.apiClient.post).toHaveBeenCalledWith(
        '/v1/proactive/r1/feedback?feedback=timeout'
      );
    });

    test('no-ops without run_id', () => {
      const { display } = createDisplay();
      display.apiClient.post.mockClear();
      display._sendProactiveFeedback(null, 'timeout');
      expect(display.apiClient.post).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _handleStateChanged()
  // -----------------------------------------------------------------------

  describe('_handleStateChanged()', () => {
    test('hides when no proactive content', async () => {
      const { display } = createDisplay();
      await display.initialize();
      display.show();

      display._handleStateChanged({ state: 'idle' });
      expect(display._isVisible).toBe(false);
    });

    test('shows when proactive content exists', async () => {
      const { display } = createDisplay();
      await display.initialize();

      // Add a child to proactive container
      const child = document.createElement('div');
      display.proactiveContainer.appendChild(child);

      display._handleStateChanged({ state: 'active' });
      expect(display._isVisible).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // dispose()
  // -----------------------------------------------------------------------

  describe('dispose()', () => {
    test('cleans up all resources', async () => {
      const { display, eventBus } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Hi', run_id: 'r1' });

      display.dispose();

      expect(display._isDisposed).toBe(true);
      expect(display._isInitialized).toBe(false);
      expect(display.overlay).toBeNull();
      expect(display.proactiveContainer).toBeNull();
      expect(display._currentProactiveMessage).toBeNull();
      expect(display._eventBusCleanups).toEqual([]);
      expect(display._proactiveTextAccumulator).toBe('');
      expect(display._hideTimeout).toBeNull();
    });

    test('is idempotent (double dispose)', async () => {
      const { display } = createDisplay();
      await display.initialize();
      display.dispose();
      display.dispose();
      expect(display._isDisposed).toBe(true);
    });

    test('clears proactive timeout', async () => {
      jest.useFakeTimers();
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Hi', run_id: 'r1' });
      display._handleProactiveEnd({});
      expect(display._proactiveTimeoutId).not.toBeNull();

      display.dispose();
      expect(display._proactiveTimeoutId).toBeNull();

      jest.useRealTimers();
    });

    test('calls eventBus.off for all subscriptions', async () => {
      const { display, eventBus } = createDisplay();
      await display.initialize();
      const offCountBefore = eventBus.off.mock.calls.length;

      display.dispose();

      expect(eventBus.off.mock.calls.length).toBeGreaterThan(offCountBefore);
    });
  });

  // -----------------------------------------------------------------------
  // Event listener callback bodies
  // -----------------------------------------------------------------------

  describe('event listener callback coverage', () => {
    test('STATE_CHANGED event invokes _handleStateChanged', async () => {
      const { display, eventBus } = createDisplay();
      await display.initialize();
      jest.spyOn(display, '_handleStateChanged');

      eventBus.emit('handsfree:state-changed', { active: true });
      expect(display._handleStateChanged).toHaveBeenCalledWith({ active: true });
    });

    test('proactive:stream-chunk event invokes _handleProactiveChunk', async () => {
      const { display, eventBus } = createDisplay();
      await display.initialize();
      jest.spyOn(display, '_handleProactiveChunk');

      eventBus.emit('proactive:stream-chunk', { content: 'hi', run_id: 'r1' });
      expect(display._handleProactiveChunk).toHaveBeenCalledWith({ content: 'hi', run_id: 'r1' });
    });

    test('proactive:stream-end event invokes _handleProactiveEnd', async () => {
      const { display, eventBus } = createDisplay();
      await display.initialize();
      jest.spyOn(display, '_handleProactiveEnd');

      eventBus.emit('proactive:stream-end', {});
      expect(display._handleProactiveEnd).toHaveBeenCalledWith({});
    });

    test('SETTINGS_SAVED event updates proactive TTS config', async () => {
      const { display, eventBus } = createDisplay();
      await display.initialize();

      eventBus.emit('ui:settings-saved', {
        handsfree: { proactive_tts_enabled: true, proactive_tts_voice: 'Luna' },
      });

      expect(display._proactiveTts.enabled).toBe(true);
      expect(display._proactiveTts.voice).toBe('Luna');
    });

    test('SETTINGS_SAVED without handsfree data is no-op', async () => {
      const { display, eventBus } = createDisplay();
      await display.initialize();
      const originalTts = { ...display._proactiveTts };

      eventBus.emit('ui:settings-saved', {});
      expect(display._proactiveTts).toEqual(originalTts);
    });
  });

  // -----------------------------------------------------------------------
  // _handleProactiveChunk — context and recommendation
  // -----------------------------------------------------------------------

  describe('_handleProactiveChunk — extended data', () => {
    test('stores context in dataset', async () => {
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({
        content: 'Hello',
        run_id: 'r1',
        context: { type: 'deadline', source: 'calendar' },
      });

      expect(display._currentProactiveMessage).not.toBeNull();
      expect(display._currentProactiveMessage.dataset.context).toBe(
        JSON.stringify({ type: 'deadline', source: 'calendar' })
      );
    });

    test('stores recommendation in dataset', async () => {
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({
        content: 'World',
        run_id: 'r2',
        recommendation: 'You should check your calendar.',
      });

      expect(display._currentProactiveMessage.dataset.recommendation).toBe(
        'You should check your calendar.'
      );
    });
  });

  // -----------------------------------------------------------------------
  // Click handler and dismiss handler bodies
  // -----------------------------------------------------------------------

  describe('proactive message click handlers', () => {
    test('click stops proactive audio and invokes _handleProactiveClick when stream complete', async () => {
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Click me', run_id: 'r1' });
      display._proactiveStreamComplete = true;
      jest.spyOn(display, '_stopProactiveAudio').mockImplementation(() => {});
      jest.spyOn(display, '_handleProactiveClick').mockImplementation(() => {});

      const msg = display._currentProactiveMessage;
      msg.dispatchEvent(new Event('click', { bubbles: true }));

      expect(display._stopProactiveAudio).toHaveBeenCalled();
      expect(display._handleProactiveClick).toHaveBeenCalledWith('r1', undefined);
    });

    test('click before stream complete blocks action', async () => {
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Not yet', run_id: 'r1' });
      display._proactiveStreamComplete = false;
      jest.spyOn(display, '_handleProactiveClick');

      display._currentProactiveMessage.dispatchEvent(new Event('click', { bubbles: true }));
      expect(display._handleProactiveClick).not.toHaveBeenCalled();
    });

    test('dismiss button click calls _handleProactiveDismiss', async () => {
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Dismiss me', run_id: 'r3' });
      jest.spyOn(display, '_handleProactiveDismiss');

      const dismissBtn = display._currentProactiveMessage.querySelector('.proactive-dismiss-btn');
      expect(dismissBtn).not.toBeNull();
      dismissBtn.dispatchEvent(new Event('click', { bubbles: true }));

      expect(display._handleProactiveDismiss).toHaveBeenCalledWith('r3');
    });
  });

  // -----------------------------------------------------------------------
  // _handleProactiveEnd — TTS and auto-hide timeout
  // -----------------------------------------------------------------------

  describe('_handleProactiveEnd — TTS and timeout', () => {
    test('synthesizes TTS when enabled and text accumulated', async () => {
      jest.useFakeTimers();
      const { display } = createDisplay({ proactiveTts: { enabled: true, voice: 'Nova' } });
      await display.initialize();

      display._handleProactiveChunk({ content: 'TTS test', run_id: 'r1' });
      jest.spyOn(display, '_synthesizeAndPlayProactiveTts').mockResolvedValue();

      display._handleProactiveEnd({});

      expect(display._synthesizeAndPlayProactiveTts).toHaveBeenCalledWith('TTS test');
      jest.useRealTimers();
    });

    test('timeout auto-hides and removes notification', async () => {
      jest.useFakeTimers();
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Auto hide', run_id: 'r1' });
      display._handleProactiveEnd({ duration: 100 });

      expect(display._proactiveTimeoutId).not.toBeNull();

      jest.advanceTimersByTime(150);
      expect(display._currentProactiveMessage).toBeNull();
      jest.useRealTimers();
    });

    test('updates context from stream-end data', async () => {
      jest.useFakeTimers();
      const { display } = createDisplay();
      await display.initialize();

      display._handleProactiveChunk({ content: 'Hi', run_id: 'r1' });
      display._handleProactiveEnd({ context: { updated: true } });

      expect(display._currentProactiveMessage.dataset.context).toBe(
        JSON.stringify({ updated: true })
      );
      jest.useRealTimers();
    });

    test('calculates TTS duration when proactive TTS enabled', async () => {
      jest.useFakeTimers();
      const { display } = createDisplay({ proactiveTts: { enabled: true } });
      await display.initialize();
      jest.spyOn(display, '_synthesizeAndPlayProactiveTts').mockResolvedValue();

      display._handleProactiveChunk({ content: 'A'.repeat(100), run_id: 'r1' });
      display._handleProactiveEnd({});

      // With 100 chars, TTS duration = 100 * 200 + 5000 = 25000ms
      // Read time = max(15000, min(100 * 50, 30000)) = 15000ms
      // Max = 25000ms
      expect(display._proactiveTimeoutId).not.toBeNull();
      jest.useRealTimers();
    });
  });

  // -----------------------------------------------------------------------
  // _synthesizeAndPlayProactiveTts
  // -----------------------------------------------------------------------

  describe('_synthesizeAndPlayProactiveTts', () => {
    let mockAudioCtx;

    beforeEach(() => {
      const mockSource = {
        connect: jest.fn(),
        start: jest.fn(),
        buffer: null,
        onended: null,
      };
      mockAudioCtx = {
        decodeAudioData: jest.fn().mockResolvedValue({ duration: 1 }),
        createBufferSource: jest.fn(() => mockSource),
        destination: {},
        close: jest.fn().mockResolvedValue(),
      };
      window.AudioContext = jest.fn(() => mockAudioCtx);
    });

    afterEach(() => {
      delete window.AudioContext;
    });

    test('returns early when text is empty', async () => {
      const { display } = createDisplay();
      global.fetch.mockClear();
      await display._synthesizeAndPlayProactiveTts('');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('returns early when apiBaseUrl is missing', async () => {
      const { display } = createDisplay({ apiBaseUrl: null });
      global.fetch.mockClear();
      await display._synthesizeAndPlayProactiveTts('Hello');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('fetches TTS audio and plays via AudioManager', async () => {
      const audioBuffer = new ArrayBuffer(200);
      global.fetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: jest.fn().mockResolvedValue(audioBuffer),
      });

      window.audioManager = {
        handleTTSAudio: jest.fn().mockResolvedValue(),
        stopTTS: jest.fn(),
      };

      const { display } = createDisplay({ proactiveTts: { enabled: true } });
      await display._synthesizeAndPlayProactiveTts('Hello world');

      expect(display.apiClient.post).toHaveBeenCalledWith(
        '/v1/tts/synthesize',
        expect.any(Object),
        expect.any(Object)
      );
      expect(window.audioManager.handleTTSAudio).toHaveBeenCalled();
      
      delete window.audioManager;
    });

    test('warns on non-ok response', async () => {
      const { display } = createDisplay();
      display.apiClient.post.mockRejectedValueOnce(new Error('500 Server Error'));

      mockLog.warn.mockClear();
      mockLog.error.mockClear();
      await display._synthesizeAndPlayProactiveTts('Fail');

      expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Proactive TTS error'), expect.any(Error));
    });

    test('warns on empty audio data', async () => {
      const { display } = createDisplay();
      display.apiClient.post.mockResolvedValueOnce(new ArrayBuffer(10));

      mockLog.warn.mockClear();
      await display._synthesizeAndPlayProactiveTts('Small');

      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('empty audio'));
    });

    test('catches errors without crashing', async () => {
      const { display } = createDisplay();
      display.apiClient.post.mockRejectedValueOnce(new Error('Network down'));

      mockLog.error.mockClear();
      await display._synthesizeAndPlayProactiveTts('Error test');

      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Proactive TTS error'),
        expect.any(Error)
      );
    });
  });

  // -----------------------------------------------------------------------
  // _stopProactiveAudio
  // -----------------------------------------------------------------------

  describe('_stopProactiveAudio', () => {
    test('stops source and closes context via AudioManager', () => {
      window.audioManager = { stopTTS: jest.fn(), clearTTSQueue: jest.fn() };
      const { display } = createDisplay();

      display._stopProactiveAudio();

      expect(window.audioManager.stopTTS).toHaveBeenCalled();
      delete window.audioManager;
    });

    test('handles already-stopped source gracefully', () => {
      window.audioManager = { stopTTS: jest.fn(() => { throw new Error('Already stopped'); }) };
      const { display } = createDisplay();

      expect(() => display._stopProactiveAudio()).not.toThrow();
      delete window.audioManager;
    });

    test('no-op when no active audio', () => {
      const { display } = createDisplay();
      expect(() => display._stopProactiveAudio()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // initialize() error path
  // -----------------------------------------------------------------------

  describe('initialize() error handling', () => {
    test('throws error when _setupEventListeners fails', async () => {
      const { display } = createDisplay();
      jest.spyOn(display, '_setupEventListeners').mockImplementation(() => {
        throw new Error('setup failed');
      });

      await expect(display.initialize()).rejects.toThrow('setup failed');
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Initialize failed'),
        expect.any(Error)
      );
    });
  });
});
