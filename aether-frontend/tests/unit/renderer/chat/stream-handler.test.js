'use strict';

// ---------------------------------------------------------------------------
// Mocks — use plain functions for logger to survive resetMocks: true
// ---------------------------------------------------------------------------

jest.mock('../../../../src/renderer/shared/utils/logger', () => {
  const noop = () => {};
  const makeLogger = () => {
    const log = {
      info: noop, warn: noop, error: noop,
      debug: noop, trace: noop,
    };
    log.child = () => log;
    return log;
  };
  return { createRendererLogger: makeLogger };
});

// Use REAL streamUtils — pure functions, already tested, avoids mock depth trap
const { EventTypes } = require('../../../../src/core/events/EventTypes');
const StreamHandler = require('../../../../src/renderer/chat/modules/messaging/StreamHandler');

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

function createEventBus() {
  const listeners = new Map();
  return {
    emit: jest.fn((event, data) => {
      const handlers = listeners.get(event) || [];
      handlers.forEach(h => h(data));
    }),
    on: jest.fn((event, handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      // Return unsubscribe function (matches real EventBus contract)
      return () => {
        const arr = listeners.get(event);
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx !== -1) arr.splice(idx, 1);
        }
      };
    }),
    off: jest.fn(),
  };
}

function createMessageView() {
  const container = document.createElement('div');
  return {
    renderMessage: jest.fn((data) => {
      const el = document.createElement('div');
      el.dataset.messageId = data.id;
      if (data.sequence_in_chat !== undefined) {
        el.dataset.sequence = String(data.sequence_in_chat);
      }
      if (data.backend_id) {
        el.dataset.backendId = data.backend_id;
      }
      container.appendChild(el);
    }),
    updateMessage: jest.fn(),
    hideTypingIndicator: jest.fn(),
    contentElement: container,
  };
}

function createMessageState() {
  return {
    getCurrentChatId: jest.fn().mockReturnValue('chat-1'),
    messages: [],
  };
}

function createSessionAPI() {
  let counter = 0;
  return {
    nextAssistantMessageId: jest.fn().mockImplementation(() => {
      counter += 1;
      return `asst-msg-${counter}`;
    }),
  };
}

function createHandler(overrides = {}) {
  const log = createLogger();

  const defaults = {
    messageView: createMessageView(),
    messageState: createMessageState(),
    eventBus: createEventBus(),
    sessionAPI: createSessionAPI(),
    userMessageId: 'user-msg-1',
    userMessageCorrelationId: 'corr-uuid-1',
  };

  const opts = { ...defaults, ...overrides };
  const handler = new StreamHandler(opts);
  handler.log = log;
  handler.init();

  return { handler, log, ...opts };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('StreamHandler', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // =========================================================================
  // constructor
  // =========================================================================
  describe('constructor', () => {
    it('stores all options correctly', () => {
      const { handler, messageView, messageState, eventBus, sessionAPI } = createHandler();
      expect(handler.messageView).toBe(messageView);
      expect(handler.messageState).toBe(messageState);
      expect(handler.eventBus).toBe(eventBus);
      expect(handler.sessionAPI).toBe(sessionAPI);
      expect(handler.userMessageId).toBe('user-msg-1');
      expect(handler.userMessageCorrelationId).toBe('corr-uuid-1');
    });

    it('initializes streaming state to defaults', () => {
      const { handler } = createHandler();
      expect(handler.currentRequestId).toBeNull();
      expect(handler.currentMessageId).toBeNull();
      expect(handler.accumulatedText).toBe('');
      expect(handler.thinkingText).toBe('');
      expect(handler.isInThinkingTag).toBe(false);
      expect(handler._thinkingParseState).toEqual({ depth: 0, carry: '' });
    });

    it('initializes deduplication state', () => {
      const { handler } = createHandler();
      expect(handler._lastChunkContent).toBe('');
      expect(handler._lastChunkTimestamp).toBe(0);
    });

    it('initializes tracking maps as empty', () => {
      const { handler } = createHandler();
      expect(handler.persistedMessageIds).toBeInstanceOf(Map);
      expect(handler.persistedMessageIds.size).toBe(0);
      expect(handler.reservedSequences).toBeInstanceOf(Map);
      expect(handler.reservedSequences.size).toBe(0);
      expect(handler._finalizedRequestIds).toBeInstanceOf(Map);
      expect(handler._finalizedRequestIds.size).toBe(0);
    });

    it('initializes finalization guards', () => {
      const { handler } = createHandler();
      expect(handler._isFinalizingStream).toBe(false);
      expect(handler._pendingFinalization).toBeNull();
    });

    it('initializes serial queue as resolved promise', async () => {
      const { handler } = createHandler();
      await expect(handler._serialQueue).resolves.toBeUndefined();
    });

    it('defaults all options to null when empty', () => {
      const log = createLogger();
      const handler = new StreamHandler();
      handler.log = log;
      expect(handler.messageView).toBeNull();
      expect(handler.messageState).toBeNull();
      expect(handler.eventBus).toBeNull();
      expect(handler.sessionAPI).toBeNull();
      expect(handler.userMessageId).toBeNull();
      expect(handler.userMessageCorrelationId).toBeNull();
    });
  });

  // =========================================================================
  // init
  // =========================================================================
  describe('init', () => {
    it('registers TRAIL.AGENT_MESSAGE_SEQUENCE listener when eventBus exists', () => {
      const { eventBus } = createHandler();
      expect(eventBus.on).toHaveBeenCalledWith(
        EventTypes.TRAIL.AGENT_MESSAGE_SEQUENCE,
        expect.any(Function)
      );
    });

    it('does not crash when eventBus is null', () => {
      expect(() => createHandler({ eventBus: null })).not.toThrow();
    });

    it('stores reserved sequence on AGENT_MESSAGE_SEQUENCE event', () => {
      const { handler, eventBus } = createHandler();
      eventBus.emit(EventTypes.TRAIL.AGENT_MESSAGE_SEQUENCE, {
        backend_id: 'req-99',
        sequence_in_chat: 5,
      });
      expect(handler.reservedSequences.get('req-99')).toBe(5);
    });

    it('ignores AGENT_MESSAGE_SEQUENCE with falsy backend_id', () => {
      const { handler, eventBus } = createHandler();
      eventBus.emit(EventTypes.TRAIL.AGENT_MESSAGE_SEQUENCE, {
        backend_id: '',
        sequence_in_chat: 5,
      });
      expect(handler.reservedSequences.size).toBe(0);
    });

    it('updates existing DOM element sequence when container matches current request', async () => {
      const { handler, eventBus, messageView } = createHandler();

      await handler.processChunk({ request_id: 'req-1', chunk: 'hello' });
      const msgId = handler.currentMessageId;

      eventBus.emit(EventTypes.TRAIL.AGENT_MESSAGE_SEQUENCE, {
        backend_id: 'req-1',
        sequence_in_chat: 7,
      });

      const el = messageView.contentElement.querySelector(`[data-message-id="${msgId}"]`);
      expect(el).not.toBeNull();
      expect(el.dataset.sequence).toBe('7');
    });

    it('does not crash when container does not exist for sequence update', () => {
      const { handler, eventBus } = createHandler();

      // No chunk sent — no container. Should just store in reservedSequences.
      handler.currentRequestId = 'req-1';
      handler.currentMessageId = 'msg-1';

      expect(() => {
        eventBus.emit(EventTypes.TRAIL.AGENT_MESSAGE_SEQUENCE, {
          backend_id: 'req-1',
          sequence_in_chat: 3,
        });
      }).not.toThrow();

      expect(handler.reservedSequences.get('req-1')).toBe(3);
    });
  });

  // =========================================================================
  // processChunk — contract violations
  // =========================================================================
  describe('processChunk — contract violations', () => {
    it('throws on null data', async () => {
      const { handler } = createHandler();
      await expect(handler.processChunk(null)).rejects.toThrow('CONTRACT VIOLATION');
    });

    it('throws on undefined data', async () => {
      const { handler } = createHandler();
      await expect(handler.processChunk(undefined)).rejects.toThrow('CONTRACT VIOLATION');
    });

    it('throws on string data', async () => {
      const { handler } = createHandler();
      await expect(handler.processChunk('bad')).rejects.toThrow('CONTRACT VIOLATION');
    });

    it('throws on number data', async () => {
      const { handler } = createHandler();
      await expect(handler.processChunk(42)).rejects.toThrow('CONTRACT VIOLATION');
    });

    it('throws when request_id is missing', async () => {
      const { handler } = createHandler();
      await expect(handler.processChunk({ chunk: 'hi' })).rejects.toThrow('request_id');
    });

    it('throws when request_id is not a string', async () => {
      const { handler } = createHandler();
      await expect(handler.processChunk({ request_id: 123, chunk: 'hi' })).rejects.toThrow('request_id');
    });

    it('throws when request_id is empty string', async () => {
      const { handler } = createHandler();
      await expect(handler.processChunk({ request_id: '', chunk: 'hi' })).rejects.toThrow('request_id');
    });

    it('throws when chunk is a number (non-string, non-null)', async () => {
      const { handler } = createHandler();
      await expect(handler.processChunk({ request_id: 'r', chunk: 42 })).rejects.toThrow('chunk must be a string');
    });

    it('throws when chunk is an object', async () => {
      const { handler } = createHandler();
      await expect(handler.processChunk({ request_id: 'r', chunk: { t: 1 } })).rejects.toThrow('chunk must be a string');
    });

    it('throws when chunk is boolean true', async () => {
      const { handler } = createHandler();
      await expect(handler.processChunk({ request_id: 'r', chunk: true })).rejects.toThrow('chunk must be a string');
    });

    it('throws when chunk is boolean false', async () => {
      const { handler } = createHandler();
      await expect(handler.processChunk({ request_id: 'r', chunk: false })).rejects.toThrow('chunk must be a string');
    });

    it('throws ARCHITECTURAL VIOLATION when messageId is null at visible text (sessionAPI returns null)', async () => {
      const sessionAPI = { nextAssistantMessageId: jest.fn().mockReturnValue(null) };
      const { handler } = createHandler({ sessionAPI });
      await expect(handler.processChunk({ request_id: 'r', chunk: 'hi' })).rejects.toThrow('ARCHITECTURAL VIOLATION');
    });
  });

  // =========================================================================
  // processChunk — late chunk rejection
  // =========================================================================
  describe('processChunk — late chunk rejection', () => {
    it('rejects chunks for finalized request IDs', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'req-1', chunk: 'hello', done: true });

      const result = await handler.processChunk({ request_id: 'req-1', chunk: 'late!' });
      expect(result).toBe(false);
    });

    it('prunes finalized requests beyond TTL', async () => {
      const { handler } = createHandler();
      handler._finalizedRequestIds.set('old-req', Date.now() - 6 * 60 * 1000);

      await handler.processChunk({ request_id: 'new-req', chunk: 'hello' });
      expect(handler._finalizedRequestIds.has('old-req')).toBe(false);
    });

    it('rejects done=true signal for already finalized request', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'req-1', chunk: 'hi', done: true });

      const result = await handler.processChunk({ request_id: 'req-1', chunk: '', done: true });
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // processChunk — done signal without text
  // =========================================================================
  describe('processChunk — done signal without text', () => {
    it('finalizes when done=true and chunk is empty string', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'req-1', chunk: 'hello' });

      const result = await handler.processChunk({ request_id: 'req-1', chunk: '', done: true });
      expect(result).toBe(true);
      expect(handler.isStreaming()).toBe(false);
    });

    it('finalizes when done=true and chunk is undefined', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'req-1', chunk: 'hello' });

      const result = await handler.processChunk({ request_id: 'req-1', done: true });
      expect(result).toBe(true);
      expect(handler.isStreaming()).toBe(false);
    });

    it('resets for new request when done=true arrives for different requestId', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'req-1', chunk: 'hello' });

      await handler.processChunk({ request_id: 'req-2', done: true });

      expect(handler._finalizedRequestIds.has('req-1')).toBe(true);
      expect(handler._finalizedRequestIds.has('req-2')).toBe(true);
    });
  });

  // =========================================================================
  // processChunk — non-text payload
  // =========================================================================
  describe('processChunk — non-text payload', () => {
    it('returns false when no chunk and not done', async () => {
      const { handler } = createHandler();
      const result = await handler.processChunk({ request_id: 'r', type: 'metadata' });
      expect(result).toBe(false);
    });

    it('returns false for null chunk when not done', async () => {
      const { handler } = createHandler();
      const result = await handler.processChunk({ request_id: 'r', chunk: null });
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // processChunk — deduplication
  // =========================================================================
  describe('processChunk — deduplication', () => {
    it('rejects duplicate content within time window', async () => {
      const { handler } = createHandler();
      const r1 = await handler.processChunk({ request_id: 'r', chunk: 'hello' });
      expect(r1).toBe(true);

      // Force same timestamp into the dedup window
      handler._lastChunkTimestamp = Date.now();
      const r2 = await handler.processChunk({ request_id: 'r', chunk: 'hello' });
      expect(r2).toBe(false);
    });

    it('accepts different content within time window', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'hello' });

      handler._lastChunkTimestamp = Date.now();
      const result = await handler.processChunk({ request_id: 'r', chunk: 'world' });
      expect(result).toBe(true);
    });

    it('resets dedup state on new request', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r1', chunk: 'hello' });

      // Same content for new request should NOT be deduped
      const result = await handler.processChunk({ request_id: 'r2', chunk: 'hello' });
      expect(result).toBe(true);
    });
  });

  // =========================================================================
  // processChunk — artifact routing
  // =========================================================================
  describe('processChunk — artifact routing', () => {
    it('routes artifact type=code with JSON format', async () => {
      const { handler, eventBus } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'init' });
      eventBus.emit.mockClear();

      const result = await handler.processChunk({
        request_id: 'r',
        chunk: '{"type":"code","content":"x=1"}',
        type: 'artifact',
        format: 'json',
      });

      expect(result).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.ARTIFACTS.STREAM_RECEIVED, {
        requestId: 'r',
        payload: { type: 'code', content: 'x=1' },
      });
      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.ARTIFACTS.CODE_RECEIVED, {
        requestId: 'r',
        artifact: { type: 'code', content: 'x=1' },
      });
    });

    it('routes artifact type=output', async () => {
      const { handler, eventBus } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'init' });
      eventBus.emit.mockClear();

      await handler.processChunk({
        request_id: 'r',
        chunk: '{"type":"output","data":"42"}',
        type: 'artifact',
      });

      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.ARTIFACTS.OUTPUT_RECEIVED, {
        requestId: 'r',
        artifact: { type: 'output', data: '42' },
      });
    });

    it('routes artifact type=html', async () => {
      const { handler, eventBus } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'init' });
      eventBus.emit.mockClear();

      await handler.processChunk({
        request_id: 'r',
        chunk: '{"type":"html","content":"<p>hi</p>"}',
        type: 'artifact',
      });

      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.ARTIFACTS.HTML_RECEIVED, {
        requestId: 'r',
        artifact: { type: 'html', content: '<p>hi</p>' },
      });
    });

    it('routes artifact type=media', async () => {
      const { handler, eventBus } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'init' });
      eventBus.emit.mockClear();

      await handler.processChunk({
        request_id: 'r',
        chunk: '{"type":"media","url":"img.png"}',
        type: 'artifact',
      });

      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.ARTIFACTS.MEDIA_RECEIVED, {
        requestId: 'r',
        artifact: { type: 'media', url: 'img.png' },
      });
    });

    it('emits only STREAM_RECEIVED for unknown artifact type', async () => {
      const { handler, eventBus } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'init' });
      eventBus.emit.mockClear();

      await handler.processChunk({
        request_id: 'r',
        chunk: '{"type":"custom","foo":"bar"}',
        type: 'artifact',
      });

      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.ARTIFACTS.STREAM_RECEIVED, {
        requestId: 'r',
        payload: { type: 'custom', foo: 'bar' },
      });
      expect(eventBus.emit).not.toHaveBeenCalledWith(EventTypes.ARTIFACTS.CODE_RECEIVED, expect.anything());
      expect(eventBus.emit).not.toHaveBeenCalledWith(EventTypes.ARTIFACTS.OUTPUT_RECEIVED, expect.anything());
      expect(eventBus.emit).not.toHaveBeenCalledWith(EventTypes.ARTIFACTS.HTML_RECEIVED, expect.anything());
      expect(eventBus.emit).not.toHaveBeenCalledWith(EventTypes.ARTIFACTS.MEDIA_RECEIVED, expect.anything());
    });

    it('handles malformed JSON gracefully (uses raw string)', async () => {
      const { handler, eventBus } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'init' });
      eventBus.emit.mockClear();

      await handler.processChunk({
        request_id: 'r',
        chunk: '{bad-json',
        type: 'artifact',
        format: 'json',
      });

      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.ARTIFACTS.STREAM_RECEIVED, {
        requestId: 'r',
        payload: '{bad-json',
      });
    });

    it('auto-detects JSON from content starting with {', async () => {
      const { handler, eventBus } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'init' });
      eventBus.emit.mockClear();

      await handler.processChunk({
        request_id: 'r',
        chunk: '{"type":"output","result":"ok"}',
        type: 'artifact',
        // no format
      });

      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.ARTIFACTS.OUTPUT_RECEIVED, {
        requestId: 'r',
        artifact: { type: 'output', result: 'ok' },
      });
    });

    it('skips JSON parse for non-JSON raw strings', async () => {
      const { handler, eventBus } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'init' });
      eventBus.emit.mockClear();

      await handler.processChunk({
        request_id: 'r',
        chunk: 'plain text artifact',
        type: 'artifact',
        // no format, content doesn't start with {
      });

      expect(eventBus.emit).toHaveBeenCalledWith(EventTypes.ARTIFACTS.STREAM_RECEIVED, {
        requestId: 'r',
        payload: 'plain text artifact',
      });
      // No typed events since payload is string (not object)
      expect(eventBus.emit).not.toHaveBeenCalledWith(EventTypes.ARTIFACTS.CODE_RECEIVED, expect.anything());
    });

    it('does not emit when eventBus is null', async () => {
      const { handler } = createHandler({ eventBus: null });
      // Call private method directly (eventBus=null causes early return)
      await handler._processArtifactChunk({
        requestId: 'r',
        raw: '{"type":"code"}',
        format: 'json',
      });
      // No crash = success
    });
  });

  // =========================================================================
  // processChunk — text processing
  // =========================================================================
  describe('processChunk — text processing', () => {
    it('creates message container on first visible text (lazy creation)', async () => {
      const { handler, messageView } = createHandler();

      await handler.processChunk({ request_id: 'r', chunk: 'Hello' });

      expect(messageView.renderMessage).toHaveBeenCalledTimes(1);
      expect(messageView.renderMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'assistant',
          content: '',
          backend_id: 'r',
        })
      );
    });

    it('does not re-create container for subsequent chunks', async () => {
      const { handler, messageView } = createHandler();

      await handler.processChunk({ request_id: 'r', chunk: 'Hello' });
      await handler.processChunk({ request_id: 'r', chunk: ' World' });

      expect(messageView.renderMessage).toHaveBeenCalledTimes(1);
    });

    it('accumulates text across chunks', async () => {
      const { handler } = createHandler();

      await handler.processChunk({ request_id: 'r', chunk: 'Hello' });
      await handler.processChunk({ request_id: 'r', chunk: ' World' });

      expect(handler.accumulatedText).toBe('Hello World');
    });

    it('calls messageView.updateMessage with accumulated text', async () => {
      const { handler, messageView } = createHandler();

      await handler.processChunk({ request_id: 'r', chunk: 'Hello' });
      handler._flushViewUpdate(); // RAF-coalesced — flush to synchronously apply
      const msgId = handler.currentMessageId;
      expect(messageView.updateMessage).toHaveBeenCalledWith(msgId, 'Hello');

      await handler.processChunk({ request_id: 'r', chunk: ' World' });
      handler._flushViewUpdate();
      expect(messageView.updateMessage).toHaveBeenCalledWith(msgId, 'Hello World');
    });

    it('emits STREAM_CHUNK event with correct payload', async () => {
      const { handler, eventBus } = createHandler();
      eventBus.emit.mockClear();

      await handler.processChunk({ request_id: 'r', chunk: 'Hello' });

      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.STREAM_CHUNK,
        expect.objectContaining({
          requestId: 'r',
          chatId: 'chat-1',
          chunk: 'Hello',
          contentLength: 5,
        })
      );
    });

    it('hides typing indicator when new request starts', async () => {
      const { handler, messageView } = createHandler();

      await handler.processChunk({ request_id: 'r', chunk: 'Hello' });

      expect(messageView.hideTypingIndicator).toHaveBeenCalled();
    });

    it('applies reserved sequence to container creation', async () => {
      const { handler, messageView } = createHandler();
      handler.reservedSequences.set('r', 42);

      await handler.processChunk({ request_id: 'r', chunk: 'Hello' });

      expect(messageView.renderMessage).toHaveBeenCalledWith(
        expect.objectContaining({ sequence_in_chat: 42 })
      );
    });

    it('returns true for successfully processed text chunk', async () => {
      const { handler } = createHandler();
      const result = await handler.processChunk({ request_id: 'r', chunk: 'Hello' });
      expect(result).toBe(true);
    });

    it('processes text without messageView (null) — no crash', async () => {
      const { handler } = createHandler({ messageView: null });
      const result = await handler.processChunk({ request_id: 'r', chunk: 'Hello' });
      expect(result).toBe(true);
      expect(handler.accumulatedText).toBe('Hello');
    });

    it('processes text without eventBus (null) — no crash', async () => {
      const { handler } = createHandler({ eventBus: null });
      const result = await handler.processChunk({ request_id: 'r', chunk: 'Hello' });
      expect(result).toBe(true);
      expect(handler.accumulatedText).toBe('Hello');
    });
  });

  // =========================================================================
  // processChunk — thinking tags
  // =========================================================================
  describe('processChunk — thinking tags', () => {
    it('separates thinking content from visible content', async () => {
      const { handler } = createHandler();

      await handler.processChunk({
        request_id: 'r',
        chunk: 'visible<thinking>hidden</thinking>more',
      });

      expect(handler.accumulatedText).toBe('visiblemore');
      expect(handler.thinkingText).toBe('hidden');
    });

    it('emits stream:thinking event for thinking content', async () => {
      const { handler, eventBus } = createHandler();

      await handler.processChunk({
        request_id: 'r',
        chunk: '<thinking>pondering</thinking>visible',
      });

      expect(eventBus.emit).toHaveBeenCalledWith('stream:thinking', {
        content: 'pondering',
        requestId: 'r',
      });
    });

    it('tracks isInThinkingTag for unclosed tags', async () => {
      const { handler } = createHandler();

      await handler.processChunk({ request_id: 'r', chunk: 'hello<thinking>still' });
      expect(handler.isInThinkingTag).toBe(true);

      await handler.processChunk({ request_id: 'r', chunk: ' thinking</thinking>back' });
      expect(handler.isInThinkingTag).toBe(false);
    });

    it('handles <think> tag variant', async () => {
      const { handler } = createHandler();

      await handler.processChunk({
        request_id: 'r',
        chunk: 'before<think>inner</think>after',
      });

      expect(handler.accumulatedText).toBe('beforeafter');
      expect(handler.thinkingText).toBe('inner');
    });

    it('accumulates thinking across multiple chunks', async () => {
      const { handler } = createHandler();

      await handler.processChunk({ request_id: 'r', chunk: 'v<thinking>part1' });
      await handler.processChunk({ request_id: 'r', chunk: 'part2</thinking>more' });

      expect(handler.thinkingText).toBe('part1part2');
      expect(handler.accumulatedText).toBe('vmore');
    });
  });

  // =========================================================================
  // processChunk — stream completion
  // =========================================================================
  describe('processChunk — stream completion', () => {
    it('finalizes stream when done=true with text', async () => {
      const { handler, eventBus } = createHandler();

      await handler.processChunk({ request_id: 'r', chunk: 'Hello', done: true });

      expect(handler.isStreaming()).toBe(false);
      expect(eventBus.emit).toHaveBeenCalledWith('stream:finalized', expect.objectContaining({
        requestId: 'r',
      }));
    });

    it('persists message to messageState on finalization', async () => {
      const { handler, messageState } = createHandler();

      await handler.processChunk({ request_id: 'r', chunk: 'Hello', done: true });

      expect(messageState.messages).toHaveLength(1);
      expect(messageState.messages[0]).toEqual(expect.objectContaining({
        role: 'assistant',
        content: 'Hello',
        correlation_id: 'corr-uuid-1',
      }));
    });

    it('emits MESSAGE_RECEIVED and STREAM_ENDED events', async () => {
      const { handler, eventBus } = createHandler();

      await handler.processChunk({ request_id: 'r', chunk: 'Hi', done: true });

      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.MESSAGE_RECEIVED,
        expect.objectContaining({ requestId: 'r', chatId: 'chat-1' })
      );
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.STREAM_ENDED,
        expect.objectContaining({ requestId: 'r' })
      );
    });

    it('marks request as finalized after completion', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hi', done: true });
      expect(handler._finalizedRequestIds.has('r')).toBe(true);
    });

    it('clears streaming state after finalization', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hi', done: true });

      expect(handler.currentRequestId).toBeNull();
      expect(handler.currentMessageId).toBeNull();
      expect(handler.accumulatedText).toBe('');
      expect(handler.thinkingText).toBe('');
    });

    it('persists empty content for artifact-only streams', async () => {
      const { handler, messageState } = createHandler();
      // Start stream
      await handler.processChunk({ request_id: 'r', chunk: '{"type":"code"}', type: 'artifact' });
      // Finalize with done signal (no visible text was accumulated)
      await handler.processChunk({ request_id: 'r', done: true });

      expect(messageState.messages).toHaveLength(1);
      expect(messageState.messages[0].content).toBe('');
    });
  });

  // =========================================================================
  // processChunk — new request detection
  // =========================================================================
  describe('processChunk — new request detection', () => {
    it('finalizes previous request when new request arrives', async () => {
      const { handler, messageState } = createHandler();

      await handler.processChunk({ request_id: 'r1', chunk: 'First' });
      await handler.processChunk({ request_id: 'r2', chunk: 'Second' });

      expect(handler._finalizedRequestIds.has('r1')).toBe(true);
      expect(messageState.messages.some(m => m.content === 'First')).toBe(true);
    });

    it('generates new message ID for each request', async () => {
      const { handler, sessionAPI } = createHandler();

      await handler.processChunk({ request_id: 'r1', chunk: 'First' });
      const firstMsgId = handler.currentMessageId;

      await handler.processChunk({ request_id: 'r2', chunk: 'Second' });
      expect(handler.currentMessageId).not.toBe(firstMsgId);
      expect(sessionAPI.nextAssistantMessageId).toHaveBeenCalledTimes(2);
    });

    it('stores messageId in persistedMessageIds map', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r1', chunk: 'Hi' });
      expect(handler.persistedMessageIds.get('r1')).toBe(handler.currentMessageId);
    });

    it('emits STREAM_STARTED event for new request', async () => {
      const { handler, eventBus } = createHandler();
      eventBus.emit.mockClear();

      await handler.processChunk({ request_id: 'r1', chunk: 'Hi' });

      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.STREAM_STARTED,
        expect.objectContaining({
          requestId: 'r1',
          chatId: 'chat-1',
          parentMessageId: 'user-msg-1',
        })
      );
    });

    it('resets thinking parse state for new request', async () => {
      const { handler } = createHandler();

      await handler.processChunk({ request_id: 'r1', chunk: 'v<thinking>open' });
      expect(handler.isInThinkingTag).toBe(true);

      await handler.processChunk({ request_id: 'r2', chunk: 'fresh' });
      expect(handler.isInThinkingTag).toBe(false);
      expect(handler._thinkingParseState).toEqual({ depth: 0, carry: '' });
    });
  });

  // =========================================================================
  // _finalizeStream — concurrency guard
  // =========================================================================
  describe('_finalizeStream — concurrency guard', () => {
    it('prevents double persistence from concurrent calls', async () => {
      const { handler, messageState } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hi' });

      const p1 = handler._finalizeStream();
      const p2 = handler._finalizeStream();
      await Promise.all([p1, p2]);

      expect(messageState.messages.length).toBe(1);
    });

    it('returns early when no currentMessageId', async () => {
      const { handler, log } = createHandler();
      await handler._finalizeStream();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Nothing to finalize'));
    });

    it('clears finalization guard even when error occurs', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hi' });

      // Replace messageState with one that throws on push
      handler.messageState = {
        getCurrentChatId: jest.fn().mockReturnValue('chat-1'),
        messages: { push: () => { throw new Error('boom'); } },
      };

      await handler._finalizeStream();

      expect(handler._isFinalizingStream).toBe(false);
      expect(handler._pendingFinalization).toBeNull();
    });
  });

  // =========================================================================
  // _generateMessageId
  // =========================================================================
  describe('_generateMessageId', () => {
    it('throws when sessionAPI is null', async () => {
      const { handler } = createHandler({ sessionAPI: null });
      await expect(handler._generateMessageId()).rejects.toThrow(
        'sessionAPI.nextAssistantMessageId is required'
      );
    });

    it('throws when nextAssistantMessageId is not a function', async () => {
      const { handler } = createHandler({ sessionAPI: { nextAssistantMessageId: 'nope' } });
      await expect(handler._generateMessageId()).rejects.toThrow(
        'sessionAPI.nextAssistantMessageId is required'
      );
    });

    it('calls nextAssistantMessageId with parentId and chatId', async () => {
      const { handler, sessionAPI } = createHandler();
      await handler._generateMessageId();

      expect(sessionAPI.nextAssistantMessageId).toHaveBeenCalledWith({
        parentId: 'user-msg-1',
        chatId: 'chat-1',
      });
    });

    it('returns the generated ID', async () => {
      const { handler } = createHandler();
      const id = await handler._generateMessageId();
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^asst-msg-\d+$/);
    });
  });

  // =========================================================================
  // Getters
  // =========================================================================
  describe('getters', () => {
    it('getCurrentMessageId returns null before stream', () => {
      const { handler } = createHandler();
      expect(handler.getCurrentMessageId()).toBeNull();
    });

    it('getCurrentMessageId returns ID during stream', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hi' });
      expect(handler.getCurrentMessageId()).toMatch(/^asst-msg-/);
    });

    it('getCurrentRequestId returns null before stream', () => {
      const { handler } = createHandler();
      expect(handler.getCurrentRequestId()).toBeNull();
    });

    it('getCurrentRequestId returns ID during stream', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hi' });
      expect(handler.getCurrentRequestId()).toBe('r');
    });

    it('getAccumulatedText returns empty string initially', () => {
      const { handler } = createHandler();
      expect(handler.getAccumulatedText()).toBe('');
    });

    it('getAccumulatedText returns accumulated text', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hello' });
      expect(handler.getAccumulatedText()).toBe('Hello');
    });

    it('getThinkingText returns empty string initially', () => {
      const { handler } = createHandler();
      expect(handler.getThinkingText()).toBe('');
    });

    it('getThinkingText returns thinking text', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: '<think>deep</think>v' });
      expect(handler.getThinkingText()).toBe('deep');
    });

    it('isStreaming returns false before any chunk', () => {
      const { handler } = createHandler();
      expect(handler.isStreaming()).toBe(false);
    });

    it('isStreaming returns true during stream', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hi' });
      expect(handler.isStreaming()).toBe(true);
    });

    it('isStreaming returns false after finalization', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hi', done: true });
      expect(handler.isStreaming()).toBe(false);
    });
  });

  // =========================================================================
  // forceFinalize
  // =========================================================================
  describe('forceFinalize', () => {
    it('finalizes when streaming', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hello' });

      await handler.forceFinalize();
      expect(handler.isStreaming()).toBe(false);
      expect(handler._finalizedRequestIds.has('r')).toBe(true);
    });

    it('is a no-op when not streaming', async () => {
      const { handler, eventBus } = createHandler();
      eventBus.emit.mockClear();

      await handler.forceFinalize();
      expect(eventBus.emit).not.toHaveBeenCalledWith('stream:finalized', expect.anything());
    });
  });

  // =========================================================================
  // finalizeStream (public API)
  // =========================================================================
  describe('finalizeStream (public)', () => {
    it('throws on null requestId', async () => {
      const { handler } = createHandler();
      await expect(handler.finalizeStream(null)).rejects.toThrow('CONTRACT VIOLATION');
    });

    it('throws on empty string requestId', async () => {
      const { handler } = createHandler();
      await expect(handler.finalizeStream('')).rejects.toThrow('CONTRACT VIOLATION');
    });

    it('is idempotent for already-finalized requests', async () => {
      const { handler, messageState } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hi', done: true });
      const count = messageState.messages.length;

      await handler.finalizeStream('r');
      expect(messageState.messages.length).toBe(count);
    });

    it('marks unknown request as finalized for future late-chunk rejection', async () => {
      const { handler } = createHandler();
      await handler.finalizeStream('unknown');
      expect(handler._finalizedRequestIds.has('unknown')).toBe(true);
    });

    it('finalizes current stream when requestId matches', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hello' });

      await handler.finalizeStream('r');
      expect(handler.isStreaming()).toBe(false);
    });

    it('does not finalize current stream for different requestId', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r1', chunk: 'Hello' });

      await handler.finalizeStream('r-other');
      expect(handler.isStreaming()).toBe(true); // r1 still active
      expect(handler._finalizedRequestIds.has('r-other')).toBe(true);
    });
  });

  // =========================================================================
  // _markRequestFinalized
  // =========================================================================
  describe('_markRequestFinalized', () => {
    it('adds requestId with timestamp to map', () => {
      const { handler } = createHandler();
      const before = Date.now();
      handler._markRequestFinalized('r1');
      const ts = handler._finalizedRequestIds.get('r1');
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(Date.now());
    });

    it('is a no-op for null', () => {
      const { handler } = createHandler();
      handler._markRequestFinalized(null);
      expect(handler._finalizedRequestIds.size).toBe(0);
    });

    it('is a no-op for non-string', () => {
      const { handler } = createHandler();
      handler._markRequestFinalized(123);
      expect(handler._finalizedRequestIds.size).toBe(0);
    });

    it('is a no-op for empty string', () => {
      const { handler } = createHandler();
      handler._markRequestFinalized('');
      expect(handler._finalizedRequestIds.size).toBe(0);
    });
  });

  // =========================================================================
  // _pruneFinalizedRequests
  // =========================================================================
  describe('_pruneFinalizedRequests', () => {
    it('removes entries older than TTL', () => {
      const { handler } = createHandler();
      handler._finalizedRequestIds.set('old', Date.now() - handler._finalizedRequestTtlMs - 1000);
      handler._finalizedRequestIds.set('recent', Date.now());

      handler._pruneFinalizedRequests();

      expect(handler._finalizedRequestIds.has('old')).toBe(false);
      expect(handler._finalizedRequestIds.has('recent')).toBe(true);
    });

    it('removes entries with falsy timestamp', () => {
      const { handler } = createHandler();
      handler._finalizedRequestIds.set('zero', 0);
      handler._finalizedRequestIds.set('null', null);
      handler._finalizedRequestIds.set('good', Date.now());

      handler._pruneFinalizedRequests();

      expect(handler._finalizedRequestIds.has('zero')).toBe(false);
      expect(handler._finalizedRequestIds.has('null')).toBe(false);
      expect(handler._finalizedRequestIds.has('good')).toBe(true);
    });

    it('trims to _maxFinalizedRequests', () => {
      const { handler } = createHandler();
      handler._maxFinalizedRequests = 3;

      for (let i = 0; i < 5; i++) {
        handler._finalizedRequestIds.set(`r-${i}`, Date.now());
      }

      handler._pruneFinalizedRequests();
      expect(handler._finalizedRequestIds.size).toBeLessThanOrEqual(3);
    });
  });

  // =========================================================================
  // _enqueueSerial
  // =========================================================================
  describe('_enqueueSerial', () => {
    it('serializes concurrent async calls', async () => {
      const { handler } = createHandler();
      const order = [];

      const p1 = handler._enqueueSerial(async () => {
        order.push('start-1');
        await new Promise(r => setTimeout(r, 20));
        order.push('end-1');
        return 'result-1';
      });

      const p2 = handler._enqueueSerial(async () => {
        order.push('start-2');
        return 'result-2';
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe('result-1');
      expect(r2).toBe('result-2');
      expect(order).toEqual(['start-1', 'end-1', 'start-2']);
    });

    it('continues queue after error in previous task', async () => {
      const { handler } = createHandler();

      const p1 = handler._enqueueSerial(async () => { throw new Error('boom'); });
      const p2 = handler._enqueueSerial(async () => 'after-error');

      await expect(p1).rejects.toThrow('boom');
      await expect(p2).resolves.toBe('after-error');
    });

    it('wraps non-function arguments in async function', async () => {
      const { handler } = createHandler();
      const result = await handler._enqueueSerial('static-value');
      expect(result).toBe('static-value');
    });
  });

  // =========================================================================
  // _clearState
  // =========================================================================
  describe('_clearState', () => {
    it('resets all streaming state to defaults', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hi<thinking>t</thinking>' });

      handler._clearState();

      expect(handler.currentRequestId).toBeNull();
      expect(handler.currentMessageId).toBeNull();
      expect(handler.accumulatedText).toBe('');
      expect(handler.thinkingText).toBe('');
      expect(handler.isInThinkingTag).toBe(false);
      expect(handler._thinkingParseState).toEqual({ depth: 0, carry: '' });
      expect(handler._lastChunkContent).toBe('');
      expect(handler._lastChunkTimestamp).toBe(0);
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================
  describe('dispose', () => {
    it('clears all streaming state', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hello' });

      handler.dispose();

      expect(handler.currentRequestId).toBeNull();
      expect(handler.currentMessageId).toBeNull();
      expect(handler.accumulatedText).toBe('');
    });

    it('clears persistedMessageIds', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hi' });
      expect(handler.persistedMessageIds.size).toBeGreaterThan(0);

      handler.dispose();
      expect(handler.persistedMessageIds.size).toBe(0);
    });

    it('clears reservedSequences', () => {
      const { handler } = createHandler();
      handler.reservedSequences.set('r', 5);

      handler.dispose();
      expect(handler.reservedSequences.size).toBe(0);
    });

    it('clears _finalizedRequestIds', () => {
      const { handler } = createHandler();
      handler._finalizedRequestIds.set('r', Date.now());

      handler.dispose();
      expect(handler._finalizedRequestIds.size).toBe(0);
    });

    it('nulls out references', () => {
      const { handler } = createHandler();

      handler.dispose();

      expect(handler.messageView).toBeNull();
      expect(handler.messageState).toBeNull();
      expect(handler.eventBus).toBeNull();
    });
  });

  // =========================================================================
  // Integration — multi-request lifecycle
  // =========================================================================
  describe('integration — multi-request lifecycle', () => {
    it('handles sequential requests correctly', async () => {
      const { handler, messageState } = createHandler();

      await handler.processChunk({ request_id: 'r1', chunk: 'First response' });
      await handler.processChunk({ request_id: 'r1', chunk: ' continues', done: true });

      expect(messageState.messages).toHaveLength(1);
      expect(messageState.messages[0].content).toBe('First response continues');
      expect(handler.isStreaming()).toBe(false);

      await handler.processChunk({ request_id: 'r2', chunk: 'Second', done: true });

      expect(messageState.messages).toHaveLength(2);
      expect(messageState.messages[1].content).toBe('Second');
      expect(handler._finalizedRequestIds.has('r1')).toBe(true);
      expect(handler._finalizedRequestIds.has('r2')).toBe(true);
    });

    it('handles request switch mid-stream (interruption)', async () => {
      const { handler, messageState } = createHandler();

      await handler.processChunk({ request_id: 'r1', chunk: 'Working...' });
      await handler.processChunk({ request_id: 'r2', chunk: 'New priority' });

      expect(handler._finalizedRequestIds.has('r1')).toBe(true);
      expect(messageState.messages.some(m => m.content === 'Working...')).toBe(true);
      expect(handler.currentRequestId).toBe('r2');
      expect(handler.accumulatedText).toBe('New priority');
    });

    it('falls back to userMessageId when userMessageCorrelationId is null', async () => {
      const { handler, messageState } = createHandler({ userMessageCorrelationId: null });

      await handler.processChunk({ request_id: 'r', chunk: 'Test', done: true });

      expect(messageState.messages[0].correlation_id).toBe('user-msg-1');
    });

    it('handles concurrent processChunk calls via serial queue', async () => {
      const { handler } = createHandler();

      const results = await Promise.all([
        handler.processChunk({ request_id: 'r', chunk: 'A' }),
        handler.processChunk({ request_id: 'r', chunk: 'B' }),
        handler.processChunk({ request_id: 'r', chunk: 'C' }),
      ]);

      expect(results.every(r => typeof r === 'boolean')).toBe(true);
      expect(handler.accumulatedText).toBe('ABC');
    });

    it('full lifecycle: stream → finalize → reject late → new stream', async () => {
      const { handler, messageState } = createHandler();

      // Stream 1
      await handler.processChunk({ request_id: 'r1', chunk: 'Hello', done: true });
      expect(messageState.messages).toHaveLength(1);

      // Late chunk for r1
      const late = await handler.processChunk({ request_id: 'r1', chunk: 'late' });
      expect(late).toBe(false);

      // Stream 2 works fine
      await handler.processChunk({ request_id: 'r2', chunk: 'World', done: true });
      expect(messageState.messages).toHaveLength(2);
      expect(handler.isStreaming()).toBe(false);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe('edge cases', () => {
    it('handles messageState without getCurrentChatId method', async () => {
      const ms = { messages: [] };
      const { handler } = createHandler({ messageState: ms });

      await handler.processChunk({ request_id: 'r', chunk: 'Hello' });
      expect(handler.accumulatedText).toBe('Hello');
    });

    it('handles dispose during active stream', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hello' });

      handler.dispose();

      expect(handler.messageView).toBeNull();
      expect(handler.eventBus).toBeNull();
      expect(handler.currentRequestId).toBeNull();
    });

    it('handles very long accumulated text', async () => {
      const { handler } = createHandler();
      const longChunk = 'x'.repeat(10000);

      await handler.processChunk({ request_id: 'r', chunk: longChunk });
      expect(handler.accumulatedText.length).toBe(10000);
    });

    it('handles messageState with null getCurrentChatId return', async () => {
      const ms = createMessageState();
      ms.getCurrentChatId.mockReturnValue(null);
      const { handler, eventBus } = createHandler({ messageState: ms });
      eventBus.emit.mockClear();

      await handler.processChunk({ request_id: 'r', chunk: 'Hi' });

      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.STREAM_CHUNK,
        expect.objectContaining({ chatId: null })
      );
    });
  });

  // =========================================================================
  // BUG REGRESSIONS (SH-1, SH-2, SH-5, SH-6)
  // =========================================================================
  describe('bug regressions', () => {
    // --- SH-1: _isDisposed flag + guards ---
    it('[SH-1] constructor initializes _isDisposed to false', () => {
      const { handler } = createHandler();
      expect(handler._isDisposed).toBe(false);
    });

    it('[SH-1] constructor initializes _eventBusCleanups array', () => {
      const { handler } = createHandler();
      expect(Array.isArray(handler._eventBusCleanups)).toBe(true);
    });

    it('[SH-1] init() is no-op after dispose', () => {
      const eventBus = createEventBus();
      const { handler } = createHandler({ eventBus });
      handler.dispose();

      const callsBefore = eventBus.on.mock.calls.length;
      handler.init();
      expect(eventBus.on.mock.calls.length).toBe(callsBefore);
    });

    it('[SH-1] processChunk returns false after dispose', async () => {
      const { handler } = createHandler();
      handler.dispose();
      const result = await handler.processChunk({ request_id: 'r', chunk: 'Hi' });
      expect(result).toBe(false);
    });

    it('[SH-1] forceFinalize is no-op after dispose', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hello' });
      handler.dispose();
      // Should not throw or finalize
      await expect(handler.forceFinalize()).resolves.toBeUndefined();
    });

    it('[SH-1] finalizeStream is no-op after dispose', async () => {
      const { handler } = createHandler();
      handler.dispose();
      await expect(handler.finalizeStream('r')).resolves.toBeUndefined();
    });

    it('[SH-1] dispose is idempotent (double-dispose safe)', () => {
      const { handler } = createHandler();
      handler.dispose();
      expect(() => handler.dispose()).not.toThrow();
      expect(handler._isDisposed).toBe(true);
    });

    // --- SH-2: EventBus subscription tracked and cleaned ---
    it('[SH-2] init stores EventBus cleanup function', () => {
      const { handler } = createHandler();
      expect(handler._eventBusCleanups.length).toBe(1);
      expect(typeof handler._eventBusCleanups[0]).toBe('function');
    });

    it('[SH-2] dispose calls EventBus cleanup functions', () => {
      const eventBus = createEventBus();
      const { handler } = createHandler({ eventBus });

      // Verify listener is active before dispose
      eventBus.emit(EventTypes.TRAIL.AGENT_MESSAGE_SEQUENCE, {
        backend_id: 'req-1', sequence_in_chat: 5,
      });
      expect(handler.reservedSequences.get('req-1')).toBe(5);

      handler.dispose();

      // Cleanups array should be empty after dispose
      expect(handler._eventBusCleanups).toEqual([]);
    });

    // --- SH-5: sessionAPI nulled in dispose ---
    it('[SH-5] dispose nulls sessionAPI', () => {
      const { handler } = createHandler();
      expect(handler.sessionAPI).not.toBeNull();
      handler.dispose();
      expect(handler.sessionAPI).toBeNull();
    });

    // --- SH-6: finalization state reset in dispose ---
    it('[SH-6] dispose resets _isFinalizingStream and _pendingFinalization', async () => {
      const { handler } = createHandler();
      await handler.processChunk({ request_id: 'r', chunk: 'Hi' });

      // Manually set to simulate in-progress finalization
      handler._isFinalizingStream = true;
      handler._pendingFinalization = Promise.resolve();

      handler.dispose();

      expect(handler._isFinalizingStream).toBe(false);
      expect(handler._pendingFinalization).toBeNull();
    });

    // --- Quantitative proof ---
    it('[QUANT] N created = M cleaned: 1 EventBus subscription', () => {
      const { handler } = createHandler();
      const created = handler._eventBusCleanups.length; // N=1
      handler.dispose();
      // After dispose: array emptied = M=1
      expect(created).toBe(1);
      expect(handler._eventBusCleanups.length).toBe(0);
    });
  });
});
