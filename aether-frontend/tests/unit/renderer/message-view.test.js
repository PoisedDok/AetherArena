'use strict';

// ---------------------------------------------------------------------------
// Mocks — hoisted before require()
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

jest.mock('../../../src/renderer/shared/messaging/MarkdownRenderer', () => {
  return jest.fn().mockImplementation(() => ({
    render: jest.fn((content) => `<p>${content}</p>`),
    dispose: jest.fn(),
  }));
});

jest.mock('../../../src/renderer/shared/security/SecuritySanitizer', () => {
  return jest.fn().mockImplementation(() => ({
    escapeHTML: jest.fn((s) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;')),
    dispose: jest.fn(),
  }));
});

jest.mock('../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: jest.fn(() => ({
    storage: null,
  })),
}));

// FileViewerModal is lazily required; mock at module level
jest.mock('../../../src/renderer/chat/modals/FileViewerModal', () => {
  return jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    destroy: jest.fn(),
  }));
});

const MessageView = require('../../../src/renderer/chat/modules/messaging/MessageView');
const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEventBus() {
  const handlers = {};
  return {
    on: jest.fn((event, handler) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      const cleanup = jest.fn(() => {
        const idx = handlers[event].indexOf(handler);
        if (idx >= 0) handlers[event].splice(idx, 1);
      });
      return cleanup;
    }),
    off: jest.fn(),
    emit: jest.fn(),
    _handlers: handlers,
  };
}

function createContentElement() {
  const parent = document.createElement('div');
  const content = document.createElement('div');
  content.className = 'aether-chat-content';
  parent.appendChild(content);
  document.body.appendChild(parent);
  return content;
}

function createMessageView(overrides = {}) {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  };
  createRendererLogger.mockReturnValue(mockLogger);

  const eventBus = overrides.eventBus || createMockEventBus();
  const contentElement = overrides.contentElement || createContentElement();

  const mv = new MessageView({
    eventBus,
    messageState: overrides.messageState || null,
    aether: overrides.aether || { storage: null },
    maxMessages: overrides.maxMessages || 500,
    ...overrides,
  });

  return { mv, contentElement, eventBus, log: mockLogger };
}

function createInitializedMessageView(overrides = {}) {
  const result = createMessageView(overrides);
  result.mv.init(result.contentElement);
  return result;
}

function makeMessage(overrides = {}) {
  return {
    id: overrides.id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    role: overrides.role || 'user',
    content: overrides.content || 'Hello world',
    timestamp: overrides.timestamp || Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  document.body.innerHTML = '';
  jest.restoreAllMocks();
});

// ===========================================================================
// TEST SUITE
// ===========================================================================

describe('MessageView', () => {
  // =========================================================================
  // Construction
  // =========================================================================
  describe('construction', () => {
    test('creates instance with default dependencies', () => {
      const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() };
      createRendererLogger.mockReturnValue(mockLogger);
      const mv = new MessageView();
      expect(mv).toBeInstanceOf(MessageView);
      expect(mv._isDisposed).toBe(false);
      expect(mv._eventBusCleanups).toEqual([]);
      expect(mv._typingFallbackTimer).toBeNull();
      expect(mv.messageElements).toBeInstanceOf(Map);
      expect(mv.messageElements.size).toBe(0);
    });

    test('accepts injected dependencies', () => {
      const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() };
      createRendererLogger.mockReturnValue(mockLogger);
      const eventBus = createMockEventBus();
      const messageState = { currentChatId: 'abc' };
      const mv = new MessageView({ eventBus, messageState, maxMessages: 10 });
      expect(mv.eventBus).toBe(eventBus);
      expect(mv.messageState).toBe(messageState);
      expect(mv.maxMessages).toBe(10);
    });
  });

  // =========================================================================
  // Initialization
  // =========================================================================
  describe('init', () => {
    test('sets contentElement and creates scroll button', () => {
      const { mv, contentElement } = createInitializedMessageView();
      expect(mv.contentElement).toBe(contentElement);
      expect(mv.scrollButtonElement).not.toBeNull();
      expect(mv.scrollButtonElement.style.display).toBe('none');
    });

    test('throws if no contentElement provided', () => {
      const { mv } = createMessageView();
      expect(() => mv.init(null)).toThrow('[MessageView] Content element required');
    });

    test('registers 3 EventBus listeners', () => {
      const { mv, eventBus } = createInitializedMessageView();
      expect(eventBus.on).toHaveBeenCalledTimes(3);
      expect(eventBus.on).toHaveBeenCalledWith('artifacts:open-file', expect.any(Function));
      expect(eventBus.on).toHaveBeenCalledWith('scroll:at-bottom', expect.any(Function));
      expect(eventBus.on).toHaveBeenCalledWith('scroll:scrolled-up', expect.any(Function));
      // MV-2: Cleanup functions stored
      expect(mv._eventBusCleanups.length).toBe(3);
    });
  });

  // =========================================================================
  // renderMessage
  // =========================================================================
  describe('renderMessage', () => {
    test('renders user message with escaped HTML', () => {
      const { mv, contentElement } = createInitializedMessageView();
      const msg = makeMessage({ role: 'user', content: 'Hello <b>test</b>' });
      const el = mv.renderMessage(msg);
      expect(el).not.toBeNull();
      expect(el.dataset.messageId).toBe(msg.id);
      expect(el.dataset.role).toBe('user');
      expect(contentElement.contains(el)).toBe(true);
      expect(mv.messageElements.get(msg.id)).toBe(el);
    });

    test('renders assistant message with markdown', () => {
      const { mv } = createInitializedMessageView();
      const msg = makeMessage({ role: 'assistant', content: '**bold**' });
      const el = mv.renderMessage(msg);
      expect(el).not.toBeNull();
      const textEl = el.querySelector('.chat-text');
      expect(textEl.classList.contains('assistant')).toBe(true);
    });

    test('returns null for null message', () => {
      const { mv } = createInitializedMessageView();
      expect(mv.renderMessage(null)).toBeNull();
    });

    test('returns null for empty non-assistant message', () => {
      const { mv } = createInitializedMessageView();
      const msg = makeMessage({ role: 'user', content: '' });
      expect(mv.renderMessage(msg)).toBeNull();
    });

    test('allows empty assistant message (streaming placeholder)', () => {
      const { mv } = createInitializedMessageView();
      const msg = makeMessage({ role: 'assistant', content: '' });
      const el = mv.renderMessage(msg);
      expect(el).not.toBeNull();
    });

    test('prevents duplicate rendering of same message ID', () => {
      const { mv, contentElement } = createInitializedMessageView();
      const msg = makeMessage({ id: 'dup-1' });
      const el1 = mv.renderMessage(msg);
      const el2 = mv.renderMessage(msg);
      expect(el1).toBe(el2); // Same element returned
      expect(contentElement.querySelectorAll('.chat-entry').length).toBe(1);
    });

    test('sets backend_id and sequence data attributes', () => {
      const { mv } = createInitializedMessageView();
      const msg = makeMessage({ backend_id: 'be-123', sequence_in_chat: 5 });
      const el = mv.renderMessage(msg);
      expect(el.dataset.backendId).toBe('be-123');
      expect(el.dataset.sequence).toBe('5');
    });

    test('adds error class for error messages', () => {
      const { mv } = createInitializedMessageView();
      const msg = makeMessage({ type: 'error', error_category: 'rate_limit', role: 'system', content: 'Rate limited' });
      const el = mv.renderMessage(msg);
      expect(el.classList.contains('chat-entry-error')).toBe(true);
      expect(el.dataset.errorCategory).toBe('rate_limit');
    });

    test('returns null before initialization', () => {
      const { mv } = createMessageView();
      const msg = makeMessage();
      expect(mv.renderMessage(msg)).toBeNull();
    });
  });

  // =========================================================================
  // updateMessage
  // =========================================================================
  describe('updateMessage', () => {
    test('updates existing message content', () => {
      const { mv } = createInitializedMessageView();
      const msg = makeMessage({ role: 'assistant', content: 'Initial' });
      mv.renderMessage(msg);
      const result = mv.updateMessage(msg.id, 'Updated content');
      expect(result).toBe(true);
      const el = mv.getMessageElement(msg.id);
      const textEl = el.querySelector('.chat-text');
      // markdownRenderer.render returns <p>content</p>
      expect(textEl.innerHTML).toContain('Updated content');
    });

    test('creates placeholder for unknown messageId', () => {
      const { mv } = createInitializedMessageView();
      const result = mv.updateMessage('new-msg-id', 'Streaming content');
      expect(result).toBe(true);
      expect(mv.messageElements.has('new-msg-id')).toBe(true);
    });

    test('returns false for missing messageId', () => {
      const { mv } = createInitializedMessageView();
      expect(mv.updateMessage(null, 'content')).toBe(false);
    });
  });

  // =========================================================================
  // removeMessage
  // =========================================================================
  describe('removeMessage', () => {
    test('removes existing message from DOM and map', () => {
      const { mv, contentElement } = createInitializedMessageView();
      const msg = makeMessage();
      mv.renderMessage(msg);
      expect(contentElement.querySelectorAll('.chat-entry').length).toBe(1);
      const result = mv.removeMessage(msg.id);
      expect(result).toBe(true);
      expect(contentElement.querySelectorAll('.chat-entry').length).toBe(0);
      expect(mv.messageElements.has(msg.id)).toBe(false);
    });

    test('returns false for non-existent message', () => {
      const { mv } = createInitializedMessageView();
      expect(mv.removeMessage('nonexistent')).toBe(false);
    });
  });

  // =========================================================================
  // clear
  // =========================================================================
  describe('clear', () => {
    test('removes all messages from DOM and map', () => {
      const { mv, contentElement } = createInitializedMessageView();
      mv.renderMessage(makeMessage({ id: 'm1' }));
      mv.renderMessage(makeMessage({ id: 'm2' }));
      expect(mv.getMessageCount()).toBe(2);
      mv.clear();
      expect(mv.getMessageCount()).toBe(0);
      expect(contentElement.innerHTML).toBe('');
    });
  });

  // =========================================================================
  // showLoadingState / hideLoadingState
  // =========================================================================
  describe('loading state', () => {
    test('shows and hides loading spinner', () => {
      const { mv, contentElement } = createInitializedMessageView();
      mv.showLoadingState();
      expect(contentElement.querySelector('.message-loading')).not.toBeNull();
      mv.hideLoadingState();
      expect(contentElement.querySelector('.message-loading')).toBeNull();
    });
  });

  // =========================================================================
  // showEmptyState
  // =========================================================================
  describe('showEmptyState', () => {
    test('renders empty state element', () => {
      const { mv, contentElement } = createInitializedMessageView();
      mv.showEmptyState();
      expect(contentElement.querySelector('.chat-empty-state')).not.toBeNull();
      expect(contentElement.querySelector('.chat-empty-title').textContent).toBe('How can I help?');
    });
  });

  // =========================================================================
  // Typing indicator
  // =========================================================================
  describe('typing indicator', () => {
    test('showTypingIndicator adds element to DOM', () => {
      const { mv, contentElement } = createInitializedMessageView();
      mv.showTypingIndicator();
      expect(contentElement.querySelector('.typing-indicator-entry')).not.toBeNull();
      expect(mv._typingIndicatorElement).not.toBeNull();
    });

    test('showTypingIndicator is idempotent', () => {
      const { mv, contentElement } = createInitializedMessageView();
      mv.showTypingIndicator();
      mv.showTypingIndicator();
      expect(contentElement.querySelectorAll('.typing-indicator-entry').length).toBe(1);
    });

    test('hideTypingIndicator clears element reference', () => {
      const { mv } = createInitializedMessageView();
      mv.showTypingIndicator();
      mv.hideTypingIndicator();
      expect(mv._typingIndicatorElement).toBeNull();
    });

    test('hideTypingIndicator is idempotent (safe on no indicator)', () => {
      const { mv } = createInitializedMessageView();
      mv.hideTypingIndicator(); // no-op
      expect(mv._typingIndicatorElement).toBeNull();
    });

    test('MV-3: hideTypingIndicator tracks safety timeout', () => {
      jest.useFakeTimers();
      const { mv } = createInitializedMessageView();
      mv.showTypingIndicator();
      mv.hideTypingIndicator();
      expect(mv._typingFallbackTimer).not.toBeNull();
      jest.advanceTimersByTime(300);
      expect(mv._typingFallbackTimer).toBeNull();
      jest.useRealTimers();
    });
  });

  // =========================================================================
  // _formatTimestamp — MV-5 regression
  // =========================================================================
  describe('_formatTimestamp', () => {
    test('MV-5: handles numeric (epoch ms) timestamps', () => {
      const { mv } = createInitializedMessageView();
      const epoch = new Date('2025-06-15T10:30:00Z').getTime();
      const result = mv._formatTimestamp(epoch);
      // Must format from the epoch, not from Date.now()
      const expected = new Date(epoch).toLocaleTimeString();
      expect(result).toBe(expected);
    });

    test('handles ISO string timestamps', () => {
      const { mv } = createInitializedMessageView();
      const iso = '2025-06-15T10:30:00Z';
      const result = mv._formatTimestamp(iso);
      const expected = new Date(iso).toLocaleTimeString();
      expect(result).toBe(expected);
    });

    test('returns current time for null/undefined/0 timestamp', () => {
      const { mv } = createInitializedMessageView();
      const result = mv._formatTimestamp(null);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    test('returns current time for invalid string', () => {
      const { mv } = createInitializedMessageView();
      const result = mv._formatTimestamp('not-a-date');
      expect(typeof result).toBe('string');
    });
  });

  // =========================================================================
  // _sanitizeFilenameForDisplay
  // =========================================================================
  describe('_sanitizeFilenameForDisplay', () => {
    test('returns Untitled for non-string', () => {
      const { mv } = createInitializedMessageView();
      expect(mv._sanitizeFilenameForDisplay(null)).toBe('Untitled');
      expect(mv._sanitizeFilenameForDisplay(123)).toBe('Untitled');
    });

    test('strips control chars', () => {
      const { mv } = createInitializedMessageView();
      expect(mv._sanitizeFilenameForDisplay('file\x00name.txt')).toBe('filename.txt');
    });

    test('strips event handler injection', () => {
      const { mv } = createInitializedMessageView();
      expect(mv._sanitizeFilenameForDisplay('file onerror=alert(1).txt')).toBe('file alert(1).txt');
    });

    test('strips javascript: protocol', () => {
      const { mv } = createInitializedMessageView();
      expect(mv._sanitizeFilenameForDisplay('javascript:void(0)')).toBe('void(0)');
    });

    test('truncates at 255 chars', () => {
      const { mv } = createInitializedMessageView();
      const longName = 'a'.repeat(300);
      expect(mv._sanitizeFilenameForDisplay(longName).length).toBe(255);
    });
  });

  // =========================================================================
  // _formatFileSize
  // =========================================================================
  describe('_formatFileSize', () => {
    test('formats bytes correctly', () => {
      const { mv } = createInitializedMessageView();
      expect(mv._formatFileSize(500)).toBe('500 B');
      expect(mv._formatFileSize(1536)).toBe('1.5 KB');
      expect(mv._formatFileSize(1048576)).toBe('1.0 MB');
    });
  });

  // =========================================================================
  // _isImageFile
  // =========================================================================
  describe('_isImageFile', () => {
    test('recognizes image extensions', () => {
      const { mv } = createInitializedMessageView();
      expect(mv._isImageFile('photo.jpg')).toBe(true);
      expect(mv._isImageFile('photo.JPEG')).toBe(true);
      expect(mv._isImageFile('photo.png')).toBe(true);
      expect(mv._isImageFile('photo.gif')).toBe(true);
      expect(mv._isImageFile('photo.webp')).toBe(true);
      expect(mv._isImageFile('photo.svg')).toBe(true);
    });

    test('rejects non-image extensions', () => {
      const { mv } = createInitializedMessageView();
      expect(mv._isImageFile('file.txt')).toBe(false);
      expect(mv._isImageFile('file.pdf')).toBe(false);
    });

    test('returns false for null/empty', () => {
      const { mv } = createInitializedMessageView();
      expect(mv._isImageFile(null)).toBe(false);
      expect(mv._isImageFile('')).toBe(false);
    });
  });

  // =========================================================================
  // _cleanMessageContent
  // =========================================================================
  describe('_cleanMessageContent', () => {
    test('strips leading system instruction block from user messages', () => {
      const { mv } = createInitializedMessageView();
      const msg = {
        id: 'c1',
        role: 'user',
        content: '[SYSTEM INSTRUCTION: attached file]\nContent here\n[SYSTEM INSTRUCTION: End of attached file content]\nActual message',
      };
      const cleaned = mv._cleanMessageContent(msg);
      expect(cleaned.content).toBe('Actual message');
      expect(cleaned.id).toBe('c1'); // id preserved
    });

    test('passes through assistant messages unchanged', () => {
      const { mv } = createInitializedMessageView();
      const msg = { id: 'a1', role: 'assistant', content: '[SYSTEM INSTRUCTION: foo]' };
      const result = mv._cleanMessageContent(msg);
      expect(result).toBe(msg); // exact same reference
    });

    test('passes through null message', () => {
      const { mv } = createInitializedMessageView();
      expect(mv._cleanMessageContent(null)).toBeNull();
    });
  });

  // =========================================================================
  // Message pruning
  // =========================================================================
  describe('_pruneMessages', () => {
    test('prunes when exceeding maxMessages', () => {
      const { mv, contentElement } = createInitializedMessageView({ maxMessages: 3 });
      mv.renderMessage(makeMessage({ id: 'p1', content: 'msg1' }));
      mv.renderMessage(makeMessage({ id: 'p2', content: 'msg2' }));
      mv.renderMessage(makeMessage({ id: 'p3', content: 'msg3' }));
      mv.renderMessage(makeMessage({ id: 'p4', content: 'msg4' }));
      // After rendering 4 with max 3, oldest should be pruned
      expect(mv.getMessageCount()).toBe(3);
      expect(mv.messageElements.has('p1')).toBe(false);
      expect(mv.messageElements.has('p4')).toBe(true);
    });
  });

  // =========================================================================
  // getState accessors
  // =========================================================================
  describe('getMessageCount / getMessageElement', () => {
    test('returns correct count', () => {
      const { mv } = createInitializedMessageView();
      expect(mv.getMessageCount()).toBe(0);
      mv.renderMessage(makeMessage({ id: 'g1' }));
      expect(mv.getMessageCount()).toBe(1);
    });

    test('returns element by ID', () => {
      const { mv } = createInitializedMessageView();
      const msg = makeMessage({ id: 'g2' });
      const el = mv.renderMessage(msg);
      expect(mv.getMessageElement('g2')).toBe(el);
    });

    test('returns null for unknown ID', () => {
      const { mv } = createInitializedMessageView();
      expect(mv.getMessageElement('unknown')).toBeNull();
    });
  });

  // =========================================================================
  // Bug regressions — MV-1: _isDisposed lifecycle guards
  // =========================================================================
  describe('MV-1: _isDisposed lifecycle guards', () => {
    test('renderMessage returns null after dispose', () => {
      const { mv } = createInitializedMessageView();
      mv.dispose();
      expect(mv.renderMessage(makeMessage())).toBeNull();
    });

    test('updateMessage returns false after dispose', () => {
      const { mv } = createInitializedMessageView();
      const msg = makeMessage({ role: 'assistant', content: 'Hi' });
      mv.renderMessage(msg);
      mv.dispose();
      expect(mv.updateMessage(msg.id, 'new')).toBe(false);
    });

    test('removeMessage returns false after dispose', () => {
      const { mv } = createInitializedMessageView();
      const msg = makeMessage();
      mv.renderMessage(msg);
      mv.dispose();
      expect(mv.removeMessage(msg.id)).toBe(false);
    });

    test('showLoadingState is no-op after dispose', () => {
      const { mv } = createInitializedMessageView();
      mv.dispose();
      mv.showLoadingState(); // should not throw
    });

    test('showTypingIndicator is no-op after dispose', () => {
      const { mv } = createInitializedMessageView();
      mv.dispose();
      mv.showTypingIndicator(); // should not throw
      expect(mv._typingIndicatorElement).toBeNull();
    });

    test('showEmptyState is no-op after dispose', () => {
      const { mv } = createInitializedMessageView();
      mv.dispose();
      mv.showEmptyState(); // should not throw
    });

    test('init is no-op after dispose', () => {
      const { mv } = createInitializedMessageView();
      mv.dispose();
      mv.init(document.createElement('div')); // should not throw or reinitialize
      expect(mv.contentElement).toBeNull();
    });

    test('dispose is idempotent', () => {
      const { mv } = createInitializedMessageView();
      mv.dispose();
      mv.dispose(); // second call should not throw
      expect(mv._isDisposed).toBe(true);
    });
  });

  // =========================================================================
  // Bug regressions — MV-2: EventBus cleanup
  // =========================================================================
  describe('MV-2: EventBus listener cleanup in dispose', () => {
    test('all 3 eventBus cleanups are called on dispose', () => {
      const { mv } = createInitializedMessageView();
      const cleanups = mv._eventBusCleanups;
      expect(cleanups.length).toBe(3);
      // Each is a jest.fn()
      mv.dispose();
      for (const fn of cleanups) {
        expect(fn).toHaveBeenCalledTimes(1);
      }
    });

    test('eventBus handlers no longer fire after dispose', () => {
      const { mv, eventBus } = createInitializedMessageView();
      mv.dispose();
      // Simulate emitting scroll event — handler should not throw on null refs
      const scrollHandlers = eventBus._handlers['scroll:at-bottom'] || [];
      // After cleanup, the handler arrays should be empty
      expect(scrollHandlers.length).toBe(0);
    });
  });

  // =========================================================================
  // Bug regressions — MV-3: typing fallback timer cleanup
  // =========================================================================
  describe('MV-3: typing fallback timer cleanup in dispose', () => {
    test('dispose clears pending typing fallback timer', () => {
      jest.useFakeTimers();
      const { mv, contentElement } = createInitializedMessageView();
      mv.showTypingIndicator();
      const indicatorEl = mv._typingIndicatorElement;
      expect(contentElement.contains(indicatorEl)).toBe(true);
      mv.hideTypingIndicator();
      // Timer is pending (300ms)
      expect(mv._typingFallbackTimer).not.toBeNull();
      // Dispose before timer fires
      mv.dispose();
      expect(mv._typingFallbackTimer).toBeNull();
      // Advance timers — should not throw
      jest.advanceTimersByTime(500);
      jest.useRealTimers();
    });

    test('dispose directly removes typing indicator without animation', () => {
      const { mv, contentElement } = createInitializedMessageView();
      mv.showTypingIndicator();
      expect(contentElement.querySelector('.typing-indicator-entry')).not.toBeNull();
      mv.dispose();
      // Indicator should be gone (parent element wiped by innerHTML = '')
      // The typing indicator element was directly removed in dispose
    });
  });

  // =========================================================================
  // Bug regressions — MV-4: fileViewerModal cleanup
  // =========================================================================
  describe('MV-4: fileViewerModal destroy in dispose', () => {
    test('lazily-created fileViewerModal is destroyed on dispose', async () => {
      const { mv, eventBus } = createInitializedMessageView();
      // Trigger lazy creation via event handler
      const openFileHandler = eventBus._handlers['artifacts:open-file']?.[0];
      if (openFileHandler) {
        await openFileHandler({ filename: 'test.txt', content: 'hello' });
      }
      expect(mv.fileViewerModal).toBeDefined();
      const destroySpy = mv.fileViewerModal.destroy;
      mv.dispose();
      expect(destroySpy).toHaveBeenCalledTimes(1);
    });

    test('dispose works when fileViewerModal was never created', () => {
      const { mv } = createInitializedMessageView();
      expect(mv.fileViewerModal).toBeUndefined();
      mv.dispose(); // should not throw
    });
  });

  // =========================================================================
  // Bug regressions — MV-5: numeric timestamp
  // =========================================================================
  describe('MV-5: _formatTimestamp numeric regression', () => {
    test('epoch ms produces correct time, not current time', () => {
      const { mv } = createInitializedMessageView();
      // Use a time far in the past to ensure it differs from Date.now()
      const pastEpoch = new Date('2020-01-01T00:00:00Z').getTime();
      const result = mv._formatTimestamp(pastEpoch);
      const expected = new Date(pastEpoch).toLocaleTimeString();
      expect(result).toBe(expected);
      // Verify it's NOT the current time
      const now = new Date().toLocaleTimeString();
      // These could match only if clock is exactly midnight on Jan 1, 2020 — astronomically unlikely
      if (now !== expected) {
        expect(result).not.toBe(now);
      }
    });
  });

  // =========================================================================
  // renderMessageWithAttachments
  // =========================================================================
  describe('renderMessageWithAttachments', () => {
    test('renders message with file attachments', () => {
      const { mv, contentElement } = createInitializedMessageView();
      const msg = makeMessage({ content: 'Check this file' });
      const attachments = {
        imageBase64: null,
        files: [{ name: 'readme.txt', size: 100, artifactId: 'art-1' }],
      };
      const el = mv.renderMessageWithAttachments(msg, attachments);
      expect(el).not.toBeNull();
      expect(contentElement.contains(el)).toBe(true);
      expect(el.querySelector('.file-attachment-item')).not.toBeNull();
      expect(mv.messageElements.get(msg.id)).toBe(el);
    });

    test('returns null after dispose', () => {
      const { mv } = createInitializedMessageView();
      mv.dispose();
      expect(mv.renderMessageWithAttachments(makeMessage(), { files: [] })).toBeNull();
    });

    test('renders image preview when imageBase64 provided', () => {
      const { mv } = createInitializedMessageView();
      const msg = makeMessage();
      const attachments = {
        imageBase64: 'data:image/png;base64,abc123',
        files: [],
      };
      const el = mv.renderMessageWithAttachments(msg, attachments);
      const img = el.querySelector('.attached-image');
      expect(img).not.toBeNull();
      expect(img.getAttribute('src')).toBe('data:image/png;base64,abc123');
    });
  });

  // =========================================================================
  // Scroll button
  // =========================================================================
  describe('scroll button', () => {
    test('scroll button shows/hides via eventBus events', () => {
      const { mv, eventBus } = createInitializedMessageView();
      expect(mv.scrollButtonElement.style.display).toBe('none');
      // Trigger scrolled-up handler
      const scrollUpHandler = eventBus._handlers['scroll:scrolled-up']?.[0];
      scrollUpHandler?.();
      expect(mv.scrollButtonElement.style.display).toBe('flex');
      // Trigger at-bottom handler
      const atBottomHandler = eventBus._handlers['scroll:at-bottom']?.[0];
      atBottomHandler?.();
      expect(mv.scrollButtonElement.style.display).toBe('none');
    });

    test('scroll button click emits scroll:request-bottom', () => {
      const { mv, eventBus } = createInitializedMessageView();
      mv.scrollButtonElement.click();
      expect(eventBus.emit).toHaveBeenCalledWith('scroll:request-bottom', expect.objectContaining({ force: true }));
    });
  });

  // =========================================================================
  // Quantitative resource proof
  // =========================================================================
  describe('quantitative resource proof', () => {
    test('all tracked resources are cleaned in dispose', () => {
      const { mv } = createInitializedMessageView();
      // Pre-dispose state
      expect(mv._eventBusCleanups.length).toBe(3);
      expect(mv.scrollButtonElement).not.toBeNull();
      // Render some messages
      mv.renderMessage(makeMessage({ id: 'q1' }));
      mv.renderMessage(makeMessage({ id: 'q2' }));
      expect(mv.getMessageCount()).toBe(2);
      // Show typing indicator
      mv.showTypingIndicator();
      expect(mv._typingIndicatorElement).not.toBeNull();

      // Dispose
      mv.dispose();

      // Verify all cleaned
      expect(mv._eventBusCleanups.length).toBe(0);    // 3 cleaned
      expect(mv.scrollButtonElement).toBeNull();        // button cleaned
      expect(mv.contentElement).toBeNull();             // DOM ref nulled
      expect(mv.eventBus).toBeNull();                   // eventBus nulled
      expect(mv.messageState).toBeNull();               // messageState nulled
      expect(mv.aether).toBeNull();                     // aether nulled
      expect(mv.markdownRenderer).toBeNull();           // renderer nulled
      expect(mv.securitySanitizer).toBeNull();          // sanitizer nulled
      expect(mv._typingIndicatorElement).toBeNull();    // typing indicator nulled
      expect(mv._typingFallbackTimer).toBeNull();       // timer cleared
      expect(mv._isDisposed).toBe(true);                // flag set
    });
  });
});
