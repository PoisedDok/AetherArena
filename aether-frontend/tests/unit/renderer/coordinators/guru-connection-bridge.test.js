'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  })),
}));

jest.mock('../../../../src/renderer/shared/components/Toast', () => ({
  success: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn(),
}));

const GuruConnectionBridge = require('../../../../src/renderer/main/runtime/coordinators/GuruConnectionBridge');
const { EventTypes } = require('../../../../src/core/events/EventTypes');
const Toast = require('../../../../src/renderer/shared/components/Toast');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockGuru() {
  const listeners = new Map();
  return {
    state: { assistant: 'idle' },
    connectionState: 'connected',
    ws: { readyState: 1 },
    on: jest.fn((event, handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    }),
    off: jest.fn((event, handler) => {
      const arr = listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    }),
    _emit(event, data) {
      const arr = listeners.get(event);
      if (arr) arr.forEach(h => h(data));
    },
    _listeners: listeners,
  };
}

function createMockEventBus() {
  return {
    emit: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
  };
}

function createMockEndpoint() {
  return {
    connection: {
      stopRequest: jest.fn(),
      send: jest.fn(),
    },
    sendUserMessage: jest.fn(),
  };
}

function createMockIpc() {
  return { send: jest.fn() };
}

function createMockAether() {
  return { ipc: { send: jest.fn() } };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('GuruConnectionBridge', () => {
  let bridge;

  beforeEach(() => {
    const { createRendererLogger } = require('../../../../src/renderer/shared/utils/logger');
    createRendererLogger.mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
    });
    Toast.success.mockClear();
    Toast.error.mockClear();
    Toast.warning.mockClear();
    Toast.info.mockClear();
    bridge = null;
  });

  afterEach(() => {
    if (bridge) {
      try { bridge.dispose(); } catch (_) { /* */ }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Constructor
  // ═══════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('creates instance with defaults', () => {
      bridge = new GuruConnectionBridge();
      expect(bridge.guru).toBeNull();
      expect(bridge.endpoint).toBeNull();
      expect(bridge.eventBus).toBeNull();
      expect(bridge.ipc).toBeNull();
      expect(bridge.aether).toBeNull();
      expect(bridge._guruListeners).toEqual([]);
    });

    it('accepts all options', () => {
      const guru = createMockGuru();
      const endpoint = createMockEndpoint();
      const eventBus = createMockEventBus();
      const ipc = createMockIpc();
      const aether = createMockAether();
      bridge = new GuruConnectionBridge({ guru, endpoint, eventBus, ipc, aether });
      expect(bridge.guru).toBe(guru);
      expect(bridge.endpoint).toBe(endpoint);
      expect(bridge.eventBus).toBe(eventBus);
      expect(bridge.ipc).toBe(ipc);
      expect(bridge.aether).toBe(aether);
    });

    it('creates logger', () => {
      const { createRendererLogger } = require('../../../../src/renderer/shared/utils/logger');
      bridge = new GuruConnectionBridge();
      expect(createRendererLogger).toHaveBeenCalledWith('GuruConnectionBridge');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // initialize()
  // ═══════════════════════════════════════════════════════════════════════

  describe('initialize()', () => {
    it('warns and returns when no guru', () => {
      bridge = new GuruConnectionBridge();
      bridge.initialize();
      expect(bridge.log.warn).toHaveBeenCalledWith('GuruConnection not available, skipping event listeners');
    });

    it('warns when guru has no .on method', () => {
      bridge = new GuruConnectionBridge({ guru: {} });
      bridge.initialize();
      expect(bridge.log.warn).toHaveBeenCalledWith('GuruConnection not available, skipping event listeners');
    });

    it('registers 4 core listeners without eventBus', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();
      // open, close, error, message = 4
      expect(bridge._guruListeners.length).toBe(4);
    });

    it('registers core + bridge listeners with eventBus', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();
      // 4 core + 11 bridged = 15
      expect(bridge._guruListeners.length).toBe(15);
    });

    it('logs bridge established when eventBus present', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();
      expect(bridge.log.debug).toHaveBeenCalledWith(
        'GuruConnection -> EventBus bridge established (Audio + Proactive)'
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Guru Event Handlers
  // ═══════════════════════════════════════════════════════════════════════

  describe('_handleGuruOpen()', () => {
    it('sets guru state to idle', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      guru._emit('open');
      expect(guru.state.assistant).toBe('idle');
    });
  });

  describe('_handleGuruClose()', () => {
    it('sets guru state to waiting', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      guru._emit('close', { code: 1000 });
      expect(guru.state.assistant).toBe('waiting');
    });

    it('logs warning for non-1000 close code', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      guru._emit('close', { code: 1006, reason: 'abnormal' });
      expect(bridge.log.warn).toHaveBeenCalledWith('GuruConnection closed', 1006, 'abnormal');
    });

    it('does not log for normal close (1000)', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      guru._emit('close', { code: 1000 });
      expect(bridge.log.warn).not.toHaveBeenCalledWith('GuruConnection closed', expect.anything(), expect.anything());
    });

    it('handles close without event', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      guru._emit('close', undefined);
      expect(guru.state.assistant).toBe('waiting');
    });

    it('handles close with empty reason', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      guru._emit('close', { code: 1001 });
      expect(bridge.log.warn).toHaveBeenCalledWith('GuruConnection closed', 1001, '');
    });
  });

  describe('_handleGuruError()', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    it('logs error and sets state to error', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      const err = new Error('ws error');
      guru._emit('error', err);
      expect(bridge.log.error).toHaveBeenCalledWith('GuruConnection error:', err);
      expect(guru.state.assistant).toBe('error');
    });

    it('auto-recovers from error state after 3 seconds', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      // Trigger error
      guru._emit('error', new Error('ws error'));
      expect(guru.state.assistant).toBe('error');

      // Advance timer by 3 seconds
      jest.advanceTimersByTime(3000);

      // Should auto-recover to idle
      expect(guru.state.assistant).toBe('idle');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.VISUALIZER.STATE_CHANGED,
        { state: 'idle', source: 'chat' }
      );
    });

    it('does not auto-recover if state changed before timeout', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      // Trigger error
      guru._emit('error', new Error('ws error'));
      expect(guru.state.assistant).toBe('error');

      // Manually change state before timeout
      bridge._setGuruState({ assistant: 'speaking' });
      expect(guru.state.assistant).toBe('speaking');

      // Advance timer
      jest.advanceTimersByTime(3000);

      // Should stay speaking (not revert to idle)
      expect(guru.state.assistant).toBe('speaking');
    });

    it('clears timer when connection reopens', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      // Trigger error (creates timer)
      guru._emit('error', new Error('ws error'));
      expect(guru.state.assistant).toBe('error');

      // Connection reopens before timeout
      guru._emit('open');
      expect(guru.state.assistant).toBe('idle');

      // Advance timer - should not fire since timer was cleared
      jest.advanceTimersByTime(3000);
      expect(guru.state.assistant).toBe('idle'); // Still idle, not reset again
    });

    it('clears timer when connection closes', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      // Trigger error (creates timer)
      guru._emit('error', new Error('ws error'));
      expect(guru.state.assistant).toBe('error');

      // Connection closes before timeout
      guru._emit('close', { code: 1000 });
      expect(guru.state.assistant).toBe('waiting');

      // Advance timer - should not fire
      jest.advanceTimersByTime(3000);
      expect(guru.state.assistant).toBe('waiting');
    });

    it('clears old timer when new error occurs', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      // First error
      guru._emit('error', new Error('error 1'));
      expect(guru.state.assistant).toBe('error');

      // Advance halfway
      jest.advanceTimersByTime(1500);
      expect(guru.state.assistant).toBe('error'); // Still error

      // Second error (should clear first timer and start new one)
      guru._emit('error', new Error('error 2'));
      expect(guru.state.assistant).toBe('error');

      // Advance remaining 1.5s (total 3s from first error)
      jest.advanceTimersByTime(1500);
      expect(guru.state.assistant).toBe('error'); // First timer cancelled, still waiting

      // Advance another 1.5s (3s from second error)
      jest.advanceTimersByTime(1500);
      expect(guru.state.assistant).toBe('idle'); // Second timer fired
    });

    it('does not auto-recover after dispose', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      guru._emit('error', new Error('ws error'));
      expect(guru.state.assistant).toBe('error');

      // Dispose before timeout
      bridge.dispose();

      // Advance timer
      jest.advanceTimersByTime(3000);

      // State should remain error (timer was cleared on dispose)
      expect(guru.state.assistant).toBe('error');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // EventBus Bridge Events
  // ═══════════════════════════════════════════════════════════════════════

  describe('EventBus bridged events', () => {
    it('bridges audio:stt-final', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      const payload = { text: 'hello world' };
      guru._emit('audio:stt-final', payload);
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.AUDIO.STT_FINAL, payload);
    });

    it('bridges audio:stt-partial', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      guru._emit('audio:stt-partial', { text: 'hel' });
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.AUDIO.STT_PARTIAL, { text: 'hel' });
    });

    it('bridges audio:tts-queued', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      guru._emit('audio:tts-queued', { id: 1 });
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.AUDIO.TTS_QUEUED, { id: 1 });
    });

    it('bridges audio:tts-completed', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      guru._emit('audio:tts-completed', { id: 1 });
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.AUDIO.TTS_COMPLETED, { id: 1 });
    });

    it('bridges audio:tts-audio', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      guru._emit('audio:tts-audio', { data: 'chunk' });
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.AUDIO.TTS_AUDIO, { data: 'chunk' });
    });

    it('bridges audio:tts-error and shows toast', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      guru._emit('audio:tts-error', { message: 'queue overflow' });
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.AUDIO.TTS_BACKEND_ERROR, { message: 'queue overflow' });
      expect(Toast.warning).toHaveBeenCalledWith('Voice: queue overflow', 4000);
    });

    it('tts-error toast uses error_type when no message', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      guru._emit('audio:tts-error', { error_type: 'synthesis_failure' });
      expect(Toast.warning).toHaveBeenCalledWith('Voice: synthesis_failure', 4000);
    });

    it('tts-error toast uses default when no message or error_type', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      guru._emit('audio:tts-error', {});
      expect(Toast.warning).toHaveBeenCalledWith('Voice: Voice synthesis failed', 4000);
    });

    it('bridges audio:sleep-word-detected and shows toast', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      guru._emit('audio:sleep-word-detected', {});
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.AUDIO.SLEEP_WORD_DETECTED, {});
      expect(Toast.info).toHaveBeenCalledWith('Hands-free mode paused (sleep word detected)', 3000);
    });

    it('bridges audio:interruption-detected', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      guru._emit('audio:interruption-detected', {});
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.AUDIO.INTERRUPTION_DETECTED, {});
    });

    it('bridges proactive:stream-chunk', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      guru._emit('proactive:stream-chunk', { text: 'chunk' });
      expect(eventBus.emit).toHaveBeenCalledWith('proactive:stream-chunk', { text: 'chunk' });
    });

    it('bridges proactive:stream-end', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      guru._emit('proactive:stream-end', { done: true });
      expect(eventBus.emit).toHaveBeenCalledWith('proactive:stream-end', { done: true });
    });

    it('bridges proactive:intervention', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      guru._emit('proactive:intervention', { data: 'alert' });
      expect(eventBus.emit).toHaveBeenCalledWith('proactive:intervention', { data: 'alert' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _handleGuruMessage()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_handleGuruMessage()', () => {
    it('returns early for null payload', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();
      guru._emit('message', null);
      // No crash, no log
    });

    it('returns early for non-object payload', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();
      guru._emit('message', 'string');
    });

    it('warns for payload without type', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      guru._emit('message', { role: 'assistant' });
      expect(bridge.log.warn).toHaveBeenCalledWith(
        '[GuruConnectionBridge] Dropping guru payload without type',
        { role: 'assistant' }
      );
    });

    it('handles assistant message — sets state and emits llm stream', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      const ipc = createMockIpc();
      bridge = new GuruConnectionBridge({ guru, eventBus, ipc });
      bridge.initialize();

      guru._emit('message', { type: 'message', role: 'assistant', content: 'hello' });
      expect(guru.state.assistant).toBe('speaking');
      expect(eventBus.emit).toHaveBeenCalledWith('llm:stream-chunk', {
        chunk: 'hello',
        text: 'hello',
        delta: 'hello',
      });
    });

    it('does not emit llm:stream-chunk without eventBus', () => {
      const guru = createMockGuru();
      const ipc = createMockIpc();
      bridge = new GuruConnectionBridge({ guru, ipc });
      bridge.initialize();

      guru._emit('message', { type: 'message', role: 'assistant', content: 'hello' });
      expect(guru.state.assistant).toBe('speaking');
    });

    it('handles completion message — sets idle and notifies', () => {
      const guru = createMockGuru();
      const ipc = createMockIpc();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, ipc, eventBus });
      bridge.initialize();

      guru._emit('message', { type: 'done', role: 'assistant' });
      expect(guru.state.assistant).toBe('idle');
      expect(ipc.send).toHaveBeenCalledWith('chat:request-complete', expect.objectContaining({ type: 'completion' }));
      expect(eventBus.emit).toHaveBeenCalledWith('llm:stream-end', { done: true });
    });

    it('normalizes "done" type to "completion"', () => {
      const guru = createMockGuru();
      const ipc = createMockIpc();
      bridge = new GuruConnectionBridge({ guru, ipc });
      bridge.initialize();

      guru._emit('message', { type: 'done', role: 'assistant' });
      expect(ipc.send).toHaveBeenCalledWith('chat:request-complete', expect.objectContaining({ type: 'completion' }));
    });

    it('handles stopped message', () => {
      const guru = createMockGuru();
      const ipc = createMockIpc();
      bridge = new GuruConnectionBridge({ guru, ipc });
      bridge.initialize();

      guru._emit('message', { type: 'stopped', role: 'system' });
      expect(guru.state.assistant).toBe('idle');
    });

    it('handles error message — sets error state', () => {
      const guru = createMockGuru();
      const ipc = createMockIpc();
      bridge = new GuruConnectionBridge({ guru, ipc });
      bridge.initialize();

      guru._emit('message', { type: 'error', role: 'system', error: 'fail' });
      expect(guru.state.assistant).toBe('error');
    });

    it('handles done:true flag', () => {
      const guru = createMockGuru();
      const ipc = createMockIpc();
      bridge = new GuruConnectionBridge({ guru, ipc });
      bridge.initialize();

      guru._emit('message', { type: 'message', role: 'assistant', done: true });
      expect(guru.state.assistant).toBe('idle');
    });

    it('completion does not emit llm:stream-end without eventBus', () => {
      const guru = createMockGuru();
      const ipc = createMockIpc();
      bridge = new GuruConnectionBridge({ guru, ipc });
      bridge.initialize();

      guru._emit('message', { type: 'done', role: 'assistant' });
      // No crash — eventBus is null
    });

    it('skips handsfree message types (already bridged)', () => {
      const guru = createMockGuru();
      const ipc = createMockIpc();
      bridge = new GuruConnectionBridge({ guru, ipc });
      bridge.initialize();

      const handsfreeTypes = ['stt-final', 'stt-partial', 'tts-queued', 'tts-completed', 'tts-audio', 'tts-error', 'sleep-word-detected', 'wake-word-detected', 'interruption-detected'];
      for (const type of handsfreeTypes) {
        guru._emit('message', { type });
        expect(bridge.log.debug).toHaveBeenCalledWith(
          expect.stringContaining(`Handsfree message (already bridged to EventBus): ${type}`)
        );
      }
      expect(ipc.send).not.toHaveBeenCalledWith('chat:assistant-stream', expect.anything());
    });

    it('warns for non-handsfree message without role', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      guru._emit('message', { type: 'update' });
      expect(bridge.log.warn).toHaveBeenCalledWith(
        '[GuruConnectionBridge] Dropping guru payload without role',
        { type: 'update' }
      );
    });

    it('forwards assistant stream to chat via ipc', () => {
      const guru = createMockGuru();
      const ipc = createMockIpc();
      bridge = new GuruConnectionBridge({ guru, ipc });
      bridge.initialize();

      const payload = { type: 'message', role: 'assistant', content: 'hi' };
      guru._emit('message', payload);
      expect(ipc.send).toHaveBeenCalledWith('chat:assistant-stream', payload);
    });

    it('falls back to aether.ipc when no ipc', () => {
      const guru = createMockGuru();
      const aether = createMockAether();
      bridge = new GuruConnectionBridge({ guru, aether });
      bridge.initialize();

      const payload = { type: 'message', role: 'assistant', content: 'hi' };
      guru._emit('message', payload);
      expect(aether.ipc.send).toHaveBeenCalledWith('chat:assistant-stream', payload);
    });

    it('handles no ipc and no aether gracefully', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      guru._emit('message', { type: 'message', role: 'assistant', content: 'hi' });
    });

    it('catches errors in message handling', () => {
      const guru = createMockGuru();
      const ipc = { send: jest.fn(() => { throw new Error('ipc fail'); }) };
      bridge = new GuruConnectionBridge({ guru, ipc });
      bridge.initialize();

      guru._emit('message', { type: 'message', role: 'assistant', content: 'hi' });
      expect(bridge.log.error).toHaveBeenCalledWith(
        '[GuruConnectionBridge] Failed to forward assistant stream:',
        expect.any(Error)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // handleChatStop()
  // ═══════════════════════════════════════════════════════════════════════

  describe('handleChatStop()', () => {
    it('stops request via endpoint.connection', () => {
      const guru = createMockGuru();
      const endpoint = createMockEndpoint();
      bridge = new GuruConnectionBridge({ guru, endpoint });

      bridge.handleChatStop({ requestId: 'req-1' });
      expect(endpoint.connection.stopRequest).toHaveBeenCalledWith('req-1');
      expect(guru.state.assistant).toBe('idle');
    });

    it('errors when no endpoint', () => {
      bridge = new GuruConnectionBridge({});
      bridge.handleChatStop({ requestId: 'req-1' });
      expect(bridge.log.error).toHaveBeenCalledWith('[GuruConnectionBridge] Cannot stop - endpoint not initialized');
    });

    it('errors when endpoint has no connection', () => {
      bridge = new GuruConnectionBridge({ endpoint: {} });
      bridge.handleChatStop({ requestId: 'req-1' });
      expect(bridge.log.error).toHaveBeenCalledWith('[GuruConnectionBridge] Cannot stop - endpoint not initialized');
    });

    it('warns when no requestId', () => {
      const endpoint = createMockEndpoint();
      bridge = new GuruConnectionBridge({ endpoint });
      bridge.handleChatStop({});
      expect(bridge.log.warn).toHaveBeenCalledWith('[GuruConnectionBridge] chat:stop called without requestId');
    });

    it('catches stopRequest errors', () => {
      const endpoint = createMockEndpoint();
      endpoint.connection.stopRequest.mockImplementation(() => { throw new Error('ws fail'); });
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru, endpoint });

      bridge.handleChatStop({ requestId: 'req-1' });
      expect(bridge.log.error).toHaveBeenCalledWith('[GuruConnectionBridge] Failed to stop generation:', expect.any(Error));
    });

    it('handles default empty payload', () => {
      bridge = new GuruConnectionBridge({});
      bridge.handleChatStop();
      expect(bridge.log.error).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // handleChatSend()
  // ═══════════════════════════════════════════════════════════════════════

  describe('handleChatSend()', () => {
    it('sends user message via endpoint', () => {
      const guru = createMockGuru();
      const endpoint = createMockEndpoint();
      bridge = new GuruConnectionBridge({ guru, endpoint });

      bridge.handleChatSend({
        message: 'hello',
        requestId: 'req-1',
        correlationId: 'corr-1',
        chatId: 'chat-1',
      });

      expect(guru.state.assistant).toBe('thinking');
      expect(endpoint.sendUserMessage).toHaveBeenCalledWith('hello', 'req-1', 'chat-1', 'corr-1');
    });

    it('returns early for null payload', () => {
      bridge = new GuruConnectionBridge({});
      bridge.handleChatSend(null);
      // No error
    });

    it('returns early for non-object payload', () => {
      bridge = new GuruConnectionBridge({});
      bridge.handleChatSend('string');
    });

    it('handles context_reset messages', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru, endpoint });

      bridge.handleChatSend({
        message: '',
        requestId: 'req-1',
        chatId: 'chat-1',
        metadata: { type: 'context_reset', chatId: 'chat-1', timestamp: 123 },
      });

      expect(endpoint.connection.send).toHaveBeenCalledWith(expect.objectContaining({
        role: 'user',
        type: 'context_reset',
        chat_id: 'chat-1',
        timestamp: 123,
        request_id: 'req-1',
      }));
    });

    it('context_reset uses chatId from metadata over payload', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru, endpoint });

      bridge.handleChatSend({
        chatId: 'outer-chat',
        metadata: { type: 'context_reset', chatId: 'inner-chat' },
      });

      expect(endpoint.connection.send).toHaveBeenCalledWith(expect.objectContaining({
        chat_id: 'inner-chat',
      }));
    });

    it('context_reset falls back to payload chatId when metadata.chatId is falsy', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru, endpoint });

      bridge.handleChatSend({
        chatId: 'outer-chat',
        metadata: { type: 'context_reset' }, // no chatId in metadata
      });

      expect(endpoint.connection.send).toHaveBeenCalledWith(expect.objectContaining({
        chat_id: 'outer-chat',
      }));
    });

    it('errors on missing requestId and correlationId', () => {
      bridge = new GuruConnectionBridge({});
      bridge.handleChatSend({ message: 'hello' });
      expect(bridge.log.error).toHaveBeenCalledWith(
        '[GuruConnectionBridge] CONTRACT VIOLATION: User message payload missing requestId and correlationId',
        expect.anything()
      );
    });

    it('uses correlationId when requestId missing', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru, endpoint });

      bridge.handleChatSend({ message: 'hello', correlationId: 'corr-1', chatId: 'c1' });
      expect(endpoint.sendUserMessage).toHaveBeenCalledWith('hello', 'corr-1', 'c1', 'corr-1');
    });

    it('forwards metadata only when explicit metadata is provided', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru, endpoint });

      const hiddenMetadata = {
        source: 'proactive',
        context: { doc_research: [{ query: 'q1' }] },
      };
      bridge.handleChatSend({
        message: 'hello',
        requestId: 'req-1',
        correlationId: 'corr-1',
        chatId: 'c1',
        metadata: hiddenMetadata,
      });

      expect(endpoint.sendUserMessage).toHaveBeenCalledWith(
        'hello',
        'req-1',
        'c1',
        'corr-1',
        hiddenMetadata
      );
    });

    it('returns early for empty message after trim', () => {
      const endpoint = createMockEndpoint();
      bridge = new GuruConnectionBridge({ endpoint });
      bridge.handleChatSend({ message: '   ', requestId: 'r1' });
      expect(endpoint.sendUserMessage).not.toHaveBeenCalled();
    });

    it('returns early for non-string message', () => {
      const endpoint = createMockEndpoint();
      bridge = new GuruConnectionBridge({ endpoint });
      bridge.handleChatSend({ message: 42, requestId: 'r1' });
      expect(endpoint.sendUserMessage).not.toHaveBeenCalled();
    });

    it('errors when no endpoint', () => {
      bridge = new GuruConnectionBridge({});
      bridge.handleChatSend({ message: 'hello', requestId: 'r1' });
      expect(bridge.log.error).toHaveBeenCalledWith('[GuruConnectionBridge] Endpoint not initialized; dropping chat message');
    });

    it('catches sendUserMessage errors', () => {
      const guru = createMockGuru();
      const endpoint = createMockEndpoint();
      const ipc = createMockIpc();
      endpoint.sendUserMessage.mockImplementation(() => { throw new Error('send fail'); });
      bridge = new GuruConnectionBridge({ guru, endpoint, ipc });

      bridge.handleChatSend({ message: 'hello', requestId: 'r1' });
      expect(bridge.log.error).toHaveBeenCalledWith('[GuruConnectionBridge] Failed to send chat message:', expect.any(Error));
      expect(guru.state.assistant).toBe('error');
      expect(ipc.send).toHaveBeenCalledWith('chat:request-complete', expect.objectContaining({
        error: 'send fail',
        requestId: 'r1',
      }));
    });

    it('handles default empty payload', () => {
      bridge = new GuruConnectionBridge({});
      bridge.handleChatSend();
      // No crash - returns early
    });

    it('handles payload without metadata key (no metadata forwarded)', () => {
      const guru = createMockGuru();
      const endpoint = createMockEndpoint();
      bridge = new GuruConnectionBridge({ guru, endpoint });

      bridge.handleChatSend({ message: 'hello', requestId: 'r1', chatId: 'c1' });
      // no metadata key -> preserves legacy call shape
      expect(endpoint.sendUserMessage).toHaveBeenCalledWith('hello', 'r1', 'c1', undefined);
    });

    it('uses fallback error message when error has no message', () => {
      const guru = createMockGuru();
      const endpoint = createMockEndpoint();
      const ipc = createMockIpc();
      const errWithoutMessage = {};
      endpoint.sendUserMessage.mockImplementation(() => { throw errWithoutMessage; });
      bridge = new GuruConnectionBridge({ guru, endpoint, ipc });

      bridge.handleChatSend({ message: 'hello', requestId: 'r1' });
      expect(ipc.send).toHaveBeenCalledWith('chat:request-complete', expect.objectContaining({
        error: 'Failed to send message',
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _notifyChatRequestComplete()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_notifyChatRequestComplete()', () => {
    it('sends via ipc when available', () => {
      const ipc = createMockIpc();
      bridge = new GuruConnectionBridge({ ipc });
      bridge._notifyChatRequestComplete({ done: true });
      expect(ipc.send).toHaveBeenCalledWith('chat:request-complete', { done: true });
    });

    it('falls back to aether.ipc', () => {
      const aether = createMockAether();
      bridge = new GuruConnectionBridge({ aether });
      bridge._notifyChatRequestComplete({ done: true });
      expect(aether.ipc.send).toHaveBeenCalledWith('chat:request-complete', { done: true });
    });

    it('handles neither ipc nor aether', () => {
      bridge = new GuruConnectionBridge({});
      expect(() => bridge._notifyChatRequestComplete({ done: true })).not.toThrow();
    });

    it('catches errors', () => {
      const ipc = { send: jest.fn(() => { throw new Error('fail'); }) };
      bridge = new GuruConnectionBridge({ ipc });
      bridge._notifyChatRequestComplete({ done: true });
      expect(bridge.log.error).toHaveBeenCalledWith(
        '[GuruConnectionBridge] Failed to notify chat window about completion:',
        expect.any(Error)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _setGuruState()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_setGuruState()', () => {
    it('patches guru.state', () => {
      const guru = createMockGuru();
      guru.state = { assistant: 'idle', extra: 'data' };
      bridge = new GuruConnectionBridge({ guru });

      bridge._setGuruState({ assistant: 'thinking' });
      expect(guru.state).toEqual({ assistant: 'thinking', extra: 'data' });
    });

    it('returns early without guru', () => {
      bridge = new GuruConnectionBridge({});
      expect(() => bridge._setGuruState({ assistant: 'idle' })).not.toThrow();
    });

    it('handles guru without existing state', () => {
      const guru = createMockGuru();
      guru.state = undefined;
      bridge = new GuruConnectionBridge({ guru });

      bridge._setGuruState({ assistant: 'idle' });
      expect(guru.state).toEqual({ assistant: 'idle' });
    });

    it('handles default empty patch', () => {
      const guru = createMockGuru();
      guru.state = { assistant: 'idle' };
      bridge = new GuruConnectionBridge({ guru });

      bridge._setGuruState();
      expect(guru.state).toEqual({ assistant: 'idle' });
    });

    // --- Visualizer state emission (text chat mode) ---

    it('emits visualizer:state:changed when assistant key is patched', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });

      bridge._setGuruState({ assistant: 'thinking' });
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.VISUALIZER.STATE_CHANGED,
        { state: 'thinking', source: 'chat' }
      );
    });

    it('does not emit visualizer event without eventBus', () => {
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });

      // No crash, no emission
      expect(() => bridge._setGuruState({ assistant: 'thinking' })).not.toThrow();
    });

    it('does not emit visualizer event when patch has no assistant key', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });

      bridge._setGuruState({ someOtherKey: 'value' });
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('does not emit visualizer event when assistant is falsy', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });

      bridge._setGuruState({ assistant: '' });
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('does not emit visualizer event after dispose', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });

      // Simulate partial dispose state: _isDisposed=true but refs still exist
      bridge._isDisposed = true;
      bridge._setGuruState({ assistant: 'speaking' });
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('emits correct source for all assistant states', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });

      const states = ['idle', 'thinking', 'speaking', 'waiting', 'error'];
      for (const state of states) {
        // Set a different state first so the performance guard doesn't skip
        guru.state = { assistant: state === 'idle' ? 'thinking' : 'idle' };
        eventBus.emit.mockClear();
        bridge._setGuruState({ assistant: state });
        expect(eventBus.emit).toHaveBeenCalledWith(
          EventTypes.VISUALIZER.STATE_CHANGED,
          { state, source: 'chat' }
        );
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Visualizer state emission — full text chat flow
  // ═══════════════════════════════════════════════════════════════════════

  describe('visualizer state: text chat flow', () => {
    it('full lifecycle: send → thinking → streaming → speaking → done → idle', () => {
      const guru = createMockGuru();
      const endpoint = createMockEndpoint();
      const eventBus = createMockEventBus();
      const ipc = createMockIpc();
      bridge = new GuruConnectionBridge({ guru, endpoint, eventBus, ipc });
      bridge.initialize();

      // 1. User sends message → thinking
      bridge.handleChatSend({ message: 'hello', requestId: 'r1', chatId: 'c1' });
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.VISUALIZER.STATE_CHANGED,
        { state: 'thinking', source: 'chat' }
      );

      // 2. Backend streams response → speaking
      eventBus.emit.mockClear();
      guru._emit('message', { type: 'message', role: 'assistant', content: 'Hi there' });
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.VISUALIZER.STATE_CHANGED,
        { state: 'speaking', source: 'chat' }
      );

      // 3. Response complete → idle
      eventBus.emit.mockClear();
      guru._emit('message', { type: 'done', role: 'assistant' });
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.VISUALIZER.STATE_CHANGED,
        { state: 'idle', source: 'chat' }
      );
    });

    it('error during send → thinking then error', () => {
      const guru = createMockGuru();
      const endpoint = createMockEndpoint();
      const eventBus = createMockEventBus();
      const ipc = createMockIpc();
      endpoint.sendUserMessage.mockImplementation(() => { throw new Error('fail'); });
      bridge = new GuruConnectionBridge({ guru, endpoint, eventBus, ipc });

      bridge.handleChatSend({ message: 'hello', requestId: 'r1' });

      // First emission: thinking (before send attempt)
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.VISUALIZER.STATE_CHANGED,
        { state: 'thinking', source: 'chat' }
      );
      // Second emission: error (after send failure)
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.VISUALIZER.STATE_CHANGED,
        { state: 'error', source: 'chat' }
      );
    });

    it('connection open → idle', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      // Set to non-idle so the performance guard doesn't skip the idle transition
      guru.state = { assistant: 'waiting' };
      eventBus.emit.mockClear();
      guru._emit('open');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.VISUALIZER.STATE_CHANGED,
        { state: 'idle', source: 'chat' }
      );
    });

    it('connection close → waiting', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      guru._emit('close', { code: 1000 });
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.VISUALIZER.STATE_CHANGED,
        { state: 'waiting', source: 'chat' }
      );
    });

    it('connection error → error', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      guru._emit('error', new Error('ws fail'));
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.VISUALIZER.STATE_CHANGED,
        { state: 'error', source: 'chat' }
      );
    });

    it('stop generation → idle', () => {
      const guru = createMockGuru();
      const endpoint = createMockEndpoint();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, endpoint, eventBus });

      // Set to non-idle so the performance guard doesn't skip the idle transition
      guru.state = { assistant: 'speaking' };
      eventBus.emit.mockClear();
      bridge.handleChatStop({ requestId: 'r1' });
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.VISUALIZER.STATE_CHANGED,
        { state: 'idle', source: 'chat' }
      );
    });

    it('context reset → waiting', () => {
      const guru = createMockGuru();
      const endpoint = createMockEndpoint();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, endpoint, eventBus });

      bridge.handleChatSend({
        metadata: { type: 'context_reset', chatId: 'c1', timestamp: 123 },
      });
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.VISUALIZER.STATE_CHANGED,
        { state: 'waiting', source: 'chat' }
      );
    });

    it('error response from backend → error', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      const ipc = createMockIpc();
      bridge = new GuruConnectionBridge({ guru, eventBus, ipc });
      bridge.initialize();

      guru._emit('message', { type: 'error', role: 'system', error: 'server fail' });
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.VISUALIZER.STATE_CHANGED,
        { state: 'error', source: 'chat' }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _sendContextReset()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_sendContextReset()', () => {
    it('sends context reset payload', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru, endpoint });

      bridge._sendContextReset({ chatId: 'c1', requestId: 'r1', timestamp: 999 });

      expect(endpoint.connection.send).toHaveBeenCalledWith({
        role: 'user',
        type: 'context_reset',
        chat_id: 'c1',
        request_id: 'r1',
        timestamp: 999,
      });
      expect(guru.state.assistant).toBe('waiting');
    });

    it('uses Date.now() when no timestamp', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru, endpoint });

      bridge._sendContextReset({ chatId: 'c1', requestId: 'r1' });

      const call = endpoint.connection.send.mock.calls[0][0];
      expect(typeof call.timestamp).toBe('number');
      expect(call.timestamp).toBeGreaterThan(0);
    });

    it('omits request_id when not provided', () => {
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru, endpoint });

      bridge._sendContextReset({ chatId: 'c1' });

      const call = endpoint.connection.send.mock.calls[0][0];
      expect(call).not.toHaveProperty('request_id');
    });

    it('returns early without endpoint', () => {
      bridge = new GuruConnectionBridge({});
      bridge._sendContextReset({ chatId: 'c1' });
      // No crash
    });

    it('returns early without connection', () => {
      bridge = new GuruConnectionBridge({ endpoint: {} });
      bridge._sendContextReset({ chatId: 'c1' });
    });

    it('returns early without chatId', () => {
      const endpoint = createMockEndpoint();
      bridge = new GuruConnectionBridge({ endpoint });
      bridge._sendContextReset({});
      expect(endpoint.connection.send).not.toHaveBeenCalled();
    });

    it('catches send errors', () => {
      const endpoint = createMockEndpoint();
      endpoint.connection.send.mockImplementation(() => { throw new Error('ws fail'); });
      bridge = new GuruConnectionBridge({ endpoint });

      bridge._sendContextReset({ chatId: 'c1' });
      expect(bridge.log.error).toHaveBeenCalledWith(
        '[GuruConnectionBridge] Failed to send context reset:',
        expect.any(Error)
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _generateRequestId()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_generateRequestId()', () => {
    it('returns a UUID when crypto.randomUUID available', () => {
      bridge = new GuruConnectionBridge();
      // jsdom augmented crypto.randomUUID
      const origRandomUUID = globalThis.crypto.randomUUID;
      globalThis.crypto.randomUUID = jest.fn(() => '550e8400-e29b-41d4-a716-446655440000');

      const id = bridge._generateRequestId();
      expect(id).toBe('550e8400-e29b-41d4-a716-446655440000');

      globalThis.crypto.randomUUID = origRandomUUID;
    });

    it('falls back to req_ format when crypto.randomUUID unavailable', () => {
      bridge = new GuruConnectionBridge();
      const origRandomUUID = globalThis.crypto.randomUUID;
      globalThis.crypto.randomUUID = undefined;

      const id = bridge._generateRequestId();
      expect(id).toMatch(/^req_\d+_[a-z0-9]+$/);

      globalThis.crypto.randomUUID = origRandomUUID;
    });

    it('falls back when crypto.randomUUID throws', () => {
      bridge = new GuruConnectionBridge();
      const origRandomUUID = globalThis.crypto.randomUUID;
      globalThis.crypto.randomUUID = jest.fn(() => { throw new Error('not supported'); });

      const id = bridge._generateRequestId();
      expect(id).toMatch(/^req_\d+_[a-z0-9]+$/);

      globalThis.crypto.randomUUID = origRandomUUID;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // dispose()
  // ═══════════════════════════════════════════════════════════════════════

  describe('dispose()', () => {
    it('removes all guru listeners', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      const N = bridge._guruListeners.length;
      expect(N).toBe(15);

      bridge.dispose();

      expect(guru.off).toHaveBeenCalledTimes(N);
      expect(bridge._guruListeners).toEqual([]);
    });

    it('nulls all references', () => {
      const guru = createMockGuru();
      const endpoint = createMockEndpoint();
      const eventBus = createMockEventBus();
      const ipc = createMockIpc();
      const aether = createMockAether();
      bridge = new GuruConnectionBridge({ guru, endpoint, eventBus, ipc, aether });

      bridge.dispose();

      expect(bridge.guru).toBeNull();
      expect(bridge.endpoint).toBeNull();
      expect(bridge.eventBus).toBeNull();
      expect(bridge.ipc).toBeNull();
      expect(bridge.aether).toBeNull();
    });

    it('clears error recovery timer', () => {
      jest.useFakeTimers();
      const guru = createMockGuru();
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      // Trigger error (creates timer)
      guru._emit('error', new Error('ws error'));
      expect(guru.state.assistant).toBe('error');
      expect(bridge._errorRecoveryTimer).not.toBeNull();

      // Dispose
      bridge.dispose();
      expect(bridge._errorRecoveryTimer).toBeNull();

      // Timer should not fire after dispose
      jest.advanceTimersByTime(3000);
      expect(guru.state.assistant).toBe('error'); // Stays error, no recovery

      jest.useRealTimers();
    });

    it('is safe to call twice', () => {
      bridge = new GuruConnectionBridge();
      bridge.dispose();
      expect(() => bridge.dispose()).not.toThrow();
    });

    it('handles guru without .off method', () => {
      const guru = { on: jest.fn(), state: {} };
      bridge = new GuruConnectionBridge({ guru });
      bridge.initialize();

      expect(() => bridge.dispose()).not.toThrow();
      expect(bridge._guruListeners).toEqual([]);
    });

    // Quantitative: N listeners registered = M listeners removed
    it('lifecycle: N registered = M removed', () => {
      const guru = createMockGuru();
      const eventBus = createMockEventBus();
      bridge = new GuruConnectionBridge({ guru, eventBus });
      bridge.initialize();

      const N = guru.on.mock.calls.length;
      bridge.dispose();
      const M = guru.off.mock.calls.length;

      expect(N).toBe(M);
    });
  });
});
