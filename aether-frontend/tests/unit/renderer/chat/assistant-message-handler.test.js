'use strict';

// ---------------------------------------------------------------------------
// AssistantMessageHandler.js — Comprehensive unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/chat/modules/messaging/handlers/AssistantMessageHandler.js
// Handles assistant text message streams. Delegates to StreamHandler.
// Handles assistant.message_flushed positioned messages with DOM sorting.
// ---------------------------------------------------------------------------

// Logger mock: plain noop functions survive resetMocks: true
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

const AssistantMessageHandler = require(
  '../../../../src/renderer/chat/modules/messaging/handlers/AssistantMessageHandler'
);

describe('AssistantMessageHandler', () => {
  let contentEl;

  function createStreamHandler(overrides = {}) {
    return {
      processChunk: jest.fn().mockResolvedValue(undefined),
      accumulatedText: '',
      currentMessageId: null,
      currentRequestId: null,
      messageView: null,
      ...overrides,
    };
  }

  function createMessageView() {
    contentEl = document.createElement('div');
    contentEl.id = 'messages-content';
    document.body.appendChild(contentEl);

    return {
      renderMessage: jest.fn((msg) => {
        const el = document.createElement('div');
        el.className = 'chat-entry';
        el.dataset.messageId = msg.id;
        if (msg.sequence_in_chat !== undefined) {
          el.dataset.sequence = String(msg.sequence_in_chat);
        }
        contentEl.appendChild(el);
        return el;
      }),
      removeMessage: jest.fn(),
      getMessageElement: jest.fn(),
      contentElement: contentEl,
    };
  }

  function addChatEntry(sequence, id) {
    const el = document.createElement('div');
    el.className = 'chat-entry';
    el.dataset.sequence = String(sequence);
    el.dataset.messageId = id || `msg-${sequence}`;
    contentEl.appendChild(el);
    return el;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    contentEl = null;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores streamHandler from options', () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });
      expect(handler.streamHandler).toBe(sh);
    });

    it('throws when streamHandler is not provided', () => {
      expect(() => new AssistantMessageHandler())
        .toThrow('[AssistantMessageHandler] streamHandler is REQUIRED');
    });

    it('throws when streamHandler is null', () => {
      expect(() => new AssistantMessageHandler({ streamHandler: null }))
        .toThrow('[AssistantMessageHandler] streamHandler is REQUIRED');
    });

    it('initializes log', () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });
      expect(handler.log).toBeDefined();
    });
  });

  // =========================================================================
  // handleMessage — start marker
  // =========================================================================

  describe('handleMessage — start marker', () => {
    it('delegates to processChunk with start: true', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await handler.handleMessage({
        requestId: 'req-1',
        content: null,
        start: true,
        end: false,
        type: 'message',
      });

      expect(sh.processChunk).toHaveBeenCalledTimes(1);
      expect(sh.processChunk).toHaveBeenCalledWith({
        request_id: 'req-1',
        chunk: '',
        start: true,
      });
    });

    it('returns after start (does not process as content)', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await handler.handleMessage({
        requestId: 'req-1',
        content: 'hello',
        start: true,
        end: false,
        type: 'message',
      });

      // Should only be called once (for start), not again for content
      expect(sh.processChunk).toHaveBeenCalledTimes(1);
      expect(sh.processChunk).toHaveBeenCalledWith(expect.objectContaining({ start: true }));
    });
  });

  // =========================================================================
  // handleMessage — end marker
  // =========================================================================

  describe('handleMessage — end marker', () => {
    it('delegates to processChunk with done: true', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await handler.handleMessage({
        requestId: 'req-1',
        content: null,
        start: false,
        end: true,
        type: 'message',
      });

      expect(sh.processChunk).toHaveBeenCalledTimes(1);
      expect(sh.processChunk).toHaveBeenCalledWith({
        request_id: 'req-1',
        chunk: '',
        done: true,
      });
    });
  });

  // =========================================================================
  // handleMessage — content delta
  // =========================================================================

  describe('handleMessage — content delta', () => {
    it('delegates to processChunk with content', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await handler.handleMessage({
        requestId: 'req-1',
        content: 'Hello world',
        start: false,
        end: false,
        type: 'message',
      });

      expect(sh.processChunk).toHaveBeenCalledTimes(1);
      expect(sh.processChunk).toHaveBeenCalledWith({
        request_id: 'req-1',
        chunk: 'Hello world',
      });
    });

    it('does not call processChunk when content is empty/falsy', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await handler.handleMessage({
        requestId: 'req-1',
        content: '',
        start: false,
        end: false,
        type: 'message',
      });

      expect(sh.processChunk).not.toHaveBeenCalled();
    });

    it('does not call processChunk when content is null', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await handler.handleMessage({
        requestId: 'req-1',
        content: null,
        start: false,
        end: false,
        type: 'message',
      });

      expect(sh.processChunk).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleMessage — contract violations
  // =========================================================================

  describe('handleMessage — contract violations', () => {
    it('throws when requestId is missing for non-flush messages', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await expect(handler.handleMessage({
        requestId: null,
        content: 'hello',
        start: false,
        end: false,
        type: 'message',
      })).rejects.toThrow('CONTRACT VIOLATION');
    });

    it('throws when requestId is empty string', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await expect(handler.handleMessage({
        requestId: '',
        content: 'hello',
        start: false,
        end: false,
        type: 'message',
      })).rejects.toThrow('CONTRACT VIOLATION');
    });

    it('throws when requestId is a number', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await expect(handler.handleMessage({
        requestId: 123,
        content: 'hello',
        start: false,
        end: false,
        type: 'message',
      })).rejects.toThrow('CONTRACT VIOLATION');
    });

    it('error message includes payload keys', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      try {
        await handler.handleMessage({
          requestId: undefined,
          content: 'test',
          type: 'message',
          start: false,
          end: false,
        });
        expect(true).toBe(false); // should not reach
      } catch (e) {
        expect(e.message).toContain('requestId');
      }
    });
  });

  // =========================================================================
  // handleMessage — assistant.message_flushed
  // =========================================================================

  describe('handleMessage — assistant.message_flushed', () => {
    it('throws when sequenceInChat is not finite', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await expect(handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: NaN,
        messageId: 'msg-1',
        content: 'Hello',
      })).rejects.toThrow('Invalid sequence NaN');
    });

    it('throws when sequenceInChat is 0', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await expect(handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: 0,
        messageId: 'msg-1',
        content: 'Hello',
      })).rejects.toThrow('Invalid sequence 0');
    });

    it('throws when sequenceInChat is negative', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await expect(handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: -1,
        messageId: 'msg-1',
        content: 'Hello',
      })).rejects.toThrow('Invalid sequence -1');
    });

    it('throws when sequenceInChat is undefined', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await expect(handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: undefined,
        messageId: 'msg-1',
        content: 'Hello',
      })).rejects.toThrow('Invalid sequence');
    });

    it('throws when sequenceInChat is Infinity', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await expect(handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: Infinity,
        messageId: 'msg-1',
        content: 'Hello',
      })).rejects.toThrow('Invalid sequence');
    });

    it('removes old streaming message when currentMessageId exists', async () => {
      const mv = createMessageView();
      const sh = createStreamHandler({
        currentMessageId: 'old-msg',
        currentRequestId: 'old-req',
        accumulatedText: 'old text',
        messageView: mv,
      });
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: 1,
        messageId: 'new-msg',
        content: 'New content',
      });

      expect(mv.removeMessage).toHaveBeenCalledWith('old-msg');
    });

    it('clears streaming state after flush', async () => {
      const mv = createMessageView();
      const sh = createStreamHandler({
        currentMessageId: 'old-msg',
        currentRequestId: 'old-req',
        accumulatedText: 'some text',
        messageView: mv,
      });
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: 1,
        messageId: 'new-msg',
        content: 'Content',
      });

      expect(sh.accumulatedText).toBe('');
      expect(sh.currentMessageId).toBeNull();
      expect(sh.currentRequestId).toBeNull();
    });

    it('creates new positioned message via renderMessage', async () => {
      const mv = createMessageView();
      const sh = createStreamHandler({ messageView: mv });
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: 3,
        messageId: 'flushed-msg',
        content: 'Flushed content',
      });

      expect(mv.renderMessage).toHaveBeenCalledTimes(1);
      expect(mv.renderMessage).toHaveBeenCalledWith(expect.objectContaining({
        id: 'flushed-msg',
        role: 'assistant',
        content: 'Flushed content',
        sequence_in_chat: 3,
      }));
    });

    it('adds positioned-message class to rendered element', async () => {
      const mv = createMessageView();
      const sh = createStreamHandler({ messageView: mv });
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: 1,
        messageId: 'msg-1',
        content: 'Content',
      });

      const renderedEl = mv.renderMessage.mock.results[0].value;
      expect(renderedEl.classList.contains('positioned-message')).toBe(true);
    });

    it('does not call renderMessage when content is empty', async () => {
      const mv = createMessageView();
      const sh = createStreamHandler({ messageView: mv });
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: 1,
        messageId: 'msg-1',
        content: '',
      });

      expect(mv.renderMessage).not.toHaveBeenCalled();
    });

    it('does not call renderMessage when content is null', async () => {
      const mv = createMessageView();
      const sh = createStreamHandler({ messageView: mv });
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: 1,
        messageId: 'msg-1',
        content: null,
      });

      expect(mv.renderMessage).not.toHaveBeenCalled();
    });

    it('does not removeMessage when currentMessageId is null', async () => {
      const mv = createMessageView();
      const sh = createStreamHandler({
        currentMessageId: null,
        messageView: mv,
      });
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: 1,
        messageId: 'msg-1',
        content: 'Content',
      });

      expect(mv.removeMessage).not.toHaveBeenCalled();
    });

    it('does not throw when streamHandler has no messageView', async () => {
      const sh = createStreamHandler({ messageView: null });
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await expect(handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: 1,
        messageId: 'msg-1',
        content: 'Content',
      })).resolves.toBeUndefined();
    });

    it('does not call processChunk for flush events (pure delegation bypass)', async () => {
      const mv = createMessageView();
      const sh = createStreamHandler({ messageView: mv });
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      await handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: 1,
        messageId: 'msg-1',
        requestId: 'req-1',
        content: 'Flushed',
        start: false,
        end: false,
      });

      expect(sh.processChunk).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleMessage — DOM positioning for flushed messages
  // =========================================================================

  describe('DOM positioning for flushed messages', () => {
    it('inserts message after element with lower sequence', async () => {
      const mv = createMessageView();
      const sh = createStreamHandler({ messageView: mv });
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      // Pre-existing entries
      addChatEntry(1, 'msg-1');
      addChatEntry(2, 'msg-2');

      await handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: 3,
        messageId: 'msg-3',
        content: 'Third message',
      });

      const entries = contentEl.querySelectorAll('.chat-entry');
      expect(entries.length).toBe(3);
      // msg-3 should be after msg-2
      expect(entries[2].dataset.messageId).toBe('msg-3');
    });

    it('inserts message between existing entries at correct position', async () => {
      const mv = createMessageView();
      const sh = createStreamHandler({ messageView: mv });
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      addChatEntry(1, 'msg-1');
      addChatEntry(5, 'msg-5');

      await handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: 3,
        messageId: 'msg-3',
        content: 'Middle message',
      });

      const entries = contentEl.querySelectorAll('.chat-entry');
      expect(entries.length).toBe(3);
      // Order should be: msg-1, msg-3, msg-5
      expect(entries[0].dataset.messageId).toBe('msg-1');
      expect(entries[1].dataset.messageId).toBe('msg-3');
      expect(entries[2].dataset.messageId).toBe('msg-5');
    });

    it('inserts at beginning when sequence is earliest', async () => {
      const mv = createMessageView();
      const sh = createStreamHandler({ messageView: mv });
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      addChatEntry(5, 'msg-5');
      addChatEntry(10, 'msg-10');

      await handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: 1,
        messageId: 'msg-1',
        content: 'Earliest',
      });

      const entries = contentEl.querySelectorAll('.chat-entry');
      // msg-1 should be first (earliest sequence)
      expect(entries[0].dataset.messageId).toBe('msg-1');
    });

    it('handles renderMessage returning null (no element)', async () => {
      const mv = createMessageView();
      mv.renderMessage = jest.fn(() => null);
      const sh = createStreamHandler({ messageView: mv });
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      // Should not throw even though renderMessage returns null
      await expect(handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: 1,
        messageId: 'msg-1',
        content: 'Content',
      })).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================

  describe('dispose()', () => {
    it('nulls streamHandler', () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      handler.dispose();
      expect(handler.streamHandler).toBeNull();
    });

    it('safe to call twice', () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });

      handler.dispose();
      expect(() => handler.dispose()).not.toThrow();
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports AssistantMessageHandler class', () => {
      expect(typeof AssistantMessageHandler).toBe('function');
      expect(AssistantMessageHandler.name).toBe('AssistantMessageHandler');
    });
  });

  // =========================================================================
  // BUG REGRESSIONS (AMH-1)
  // =========================================================================

  describe('bug regressions', () => {
    it('[AMH-1] constructor initializes _isDisposed to false', () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });
      expect(handler._isDisposed).toBe(false);
    });

    it('[AMH-1] handleMessage is no-op after dispose (prevents null-ref crash)', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });
      handler.dispose();

      // This would have crashed with TypeError: Cannot read properties of null
      // because streamHandler is null and handleMessage called streamHandler.processChunk()
      await expect(handler.handleMessage({
        requestId: 'r1',
        content: 'Hello',
      })).resolves.toBeUndefined();
    });

    it('[AMH-1] handleMessage is no-op for flushed type after dispose', async () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });
      handler.dispose();

      await expect(handler.handleMessage({
        type: 'assistant.message_flushed',
        sequenceInChat: 1,
        messageId: 'msg-1',
        content: 'Content',
      })).resolves.toBeUndefined();
    });

    it('[AMH-1] dispose is idempotent (double-dispose safe)', () => {
      const sh = createStreamHandler();
      const handler = new AssistantMessageHandler({ streamHandler: sh });
      handler.dispose();
      expect(() => handler.dispose()).not.toThrow();
      expect(handler._isDisposed).toBe(true);
    });
  });
});
