'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../../src/renderer/shared/utils/logger', () => {
  const noop = () => {};
  const makeLogger = () => {
    const log = { info: noop, warn: noop, error: noop, debug: noop, trace: noop };
    log.child = () => log;
    return log;
  };
  return { createRendererLogger: makeLogger };
});

const mockMarkdownRender = jest.fn((content) => `<p>${content}</p>`);
jest.mock('../../../../src/renderer/shared/messaging/MarkdownRenderer', () => {
  return function MockMarkdownRenderer() {
    this.render = mockMarkdownRender;
    this.dispose = jest.fn();
  };
});

const mockEscapeHTML = jest.fn((s) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
jest.mock('../../../../src/renderer/shared/security/SecuritySanitizer', () => {
  return function MockSecuritySanitizer() {
    this.escapeHTML = mockEscapeHTML;
    this.dispose = jest.fn();
  };
});

const mockLoadArtifacts = jest.fn().mockResolvedValue([]);
const mockGetArtifact = jest.fn().mockResolvedValue(null);
jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => ({
    storage: {
      loadArtifacts: mockLoadArtifacts,
      getArtifact: mockGetArtifact,
    },
  }),
}));

// FileViewerModal lazy-loaded — mock the require path
const mockFileViewerOpen = jest.fn();
jest.mock('../../../../src/renderer/chat/modals/FileViewerModal', () => {
  return function MockFileViewerModal() {
    this.open = mockFileViewerOpen;
  };
});

const MessageView = require('../../../../src/renderer/chat/modules/messaging/MessageView');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEventBus() {
  const listeners = {};
  return {
    on: jest.fn((event, cb) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    }),
    emit: jest.fn((event, data) => {
      (listeners[event] || []).forEach(cb => cb(data));
    }),
    _listeners: listeners,
  };
}

function createMessageState(chatId = 'chat-1') {
  return {
    currentChatId: chatId,
    messages: [],
    getCurrentChatId: jest.fn().mockReturnValue(chatId),
  };
}

/**
 * Create a properly-parented content container (needed for scroll button).
 */
function createContentContainer() {
  const parent = document.createElement('div');
  parent.className = 'aether-chat-panel';
  const content = document.createElement('div');
  content.className = 'aether-chat-content';
  parent.appendChild(content);
  document.body.appendChild(parent);
  return { parent, content };
}

/**
 * Create a MessageView with standard mocks.
 */
function createView(opts = {}) {
  const eventBus = opts.eventBus || createEventBus();
  const messageState = opts.messageState || createMessageState();
  const { parent, content } = createContentContainer();

  const view = new MessageView({
    eventBus,
    messageState,
    maxMessages: opts.maxMessages || 500,
    ...opts,
  });

  if (opts.skipInit !== true) {
    view.init(content);
  }

  return { view, eventBus, messageState, content, parent };
}

function makeMessage(overrides = {}) {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'Hello world',
    timestamp: '2026-01-01T12:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageView', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
    mockMarkdownRender.mockImplementation((c) => `<p>${c}</p>`);
    mockEscapeHTML.mockImplementation((s) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    mockLoadArtifacts.mockReset().mockResolvedValue([]);
    mockGetArtifact.mockReset().mockResolvedValue(null);
    mockFileViewerOpen.mockReset();
  });

  // =========================================================================
  // constructor
  // =========================================================================
  describe('constructor', () => {
    it('initializes default state', () => {
      const view = new MessageView();
      expect(view.contentElement).toBeNull();
      expect(view.scrollButtonElement).toBeNull();
      expect(view.messageElements).toBeInstanceOf(Map);
      expect(view.messageElements.size).toBe(0);
      expect(view._hasUntrackedMessages).toBe(false);
      expect(view.maxMessages).toBe(500);
    });

    it('accepts custom options', () => {
      const eb = createEventBus();
      const ms = createMessageState();
      const view = new MessageView({ eventBus: eb, messageState: ms, maxMessages: 100 });
      expect(view.eventBus).toBe(eb);
      expect(view.messageState).toBe(ms);
      expect(view.maxMessages).toBe(100);
    });

    it('binds _handleScrollToBottomClick', () => {
      const view = new MessageView();
      expect(typeof view._handleScrollToBottomClick).toBe('function');
    });
  });

  // =========================================================================
  // init
  // =========================================================================
  describe('init', () => {
    it('throws when contentElement is null', () => {
      const view = new MessageView();
      expect(() => view.init(null)).toThrow('Content element required');
    });

    it('stores contentElement', () => {
      const { view, content } = createView();
      expect(view.contentElement).toBe(content);
    });

    it('creates scroll-to-bottom button', () => {
      const { parent } = createView();
      const btn = parent.querySelector('.chat-scroll-to-bottom');
      expect(btn).not.toBeNull();
      expect(btn.style.display).toBe('none');
    });

    it('sets up eventBus listeners', () => {
      const eventBus = createEventBus();
      createView({ eventBus });
      expect(eventBus.on).toHaveBeenCalledWith('artifacts:open-file', expect.any(Function));
      expect(eventBus.on).toHaveBeenCalledWith('scroll:at-bottom', expect.any(Function));
      expect(eventBus.on).toHaveBeenCalledWith('scroll:scrolled-up', expect.any(Function));
    });

    it('skips eventBus listeners when eventBus is null', () => {
      const { parent, content } = createContentContainer();
      const view = new MessageView({ eventBus: null });
      expect(() => view.init(content)).not.toThrow();
    });
  });

  // =========================================================================
  // _createScrollButton
  // =========================================================================
  describe('_createScrollButton', () => {
    it('inserts before input wrapper when present', () => {
      const { parent, content } = createContentContainer();
      const inputWrapper = document.createElement('div');
      inputWrapper.className = 'aether-chat-input-wrapper';
      parent.appendChild(inputWrapper);

      const view = new MessageView({ eventBus: createEventBus() });
      view.init(content);

      const btn = parent.querySelector('.chat-scroll-to-bottom');
      expect(btn.nextElementSibling).toBe(inputWrapper);
    });

    it('appends to parent when no input wrapper exists', () => {
      const { parent } = createView();
      const btn = parent.querySelector('.chat-scroll-to-bottom');
      expect(btn).toBeTruthy();
      expect(btn.parentElement).toBe(parent);
    });

    it('does nothing when contentElement has no parent', () => {
      const orphan = document.createElement('div');
      const view = new MessageView();
      view.contentElement = orphan;
      expect(() => view._createScrollButton()).not.toThrow();
      expect(view.scrollButtonElement).toBeNull();
    });
  });

  // =========================================================================
  // scroll button show/hide
  // =========================================================================
  describe('scroll button show/hide', () => {
    it('shows button via scroll:scrolled-up event', () => {
      const { view, eventBus } = createView();
      eventBus.emit('scroll:scrolled-up');
      expect(view.scrollButtonElement.style.display).toBe('flex');
    });

    it('hides button via scroll:at-bottom event', () => {
      const { view, eventBus } = createView();
      eventBus.emit('scroll:scrolled-up');
      eventBus.emit('scroll:at-bottom');
      expect(view.scrollButtonElement.style.display).toBe('none');
    });

    it('emits scroll:request-bottom on click', () => {
      const { view, eventBus } = createView();
      view.scrollButtonElement.click();
      expect(eventBus.emit).toHaveBeenCalledWith('scroll:request-bottom', {
        behavior: 'smooth',
        force: true,
      });
    });

    it('hides button after click', () => {
      const { view } = createView();
      view._showScrollButton();
      expect(view.scrollButtonElement.style.display).toBe('flex');
      view.scrollButtonElement.click();
      expect(view.scrollButtonElement.style.display).toBe('none');
    });

    it('_showScrollButton is safe when scrollButtonElement is null', () => {
      const view = new MessageView();
      view.scrollButtonElement = null;
      expect(() => view._showScrollButton()).not.toThrow();
    });

    it('_hideScrollButton is safe when scrollButtonElement is null', () => {
      const view = new MessageView();
      view.scrollButtonElement = null;
      expect(() => view._hideScrollButton()).not.toThrow();
    });
  });

  // =========================================================================
  // renderMessage
  // =========================================================================
  describe('renderMessage', () => {
    it('returns null before init', () => {
      const view = new MessageView();
      expect(view.renderMessage(makeMessage())).toBeNull();
    });

    it('returns null for null message', () => {
      const { view } = createView();
      expect(view.renderMessage(null)).toBeNull();
    });

    it('returns null for empty non-assistant message', () => {
      const { view } = createView();
      expect(view.renderMessage(makeMessage({ content: '', role: 'user' }))).toBeNull();
    });

    it('allows empty content for assistant messages', () => {
      const { view } = createView();
      const el = view.renderMessage(makeMessage({ content: '', role: 'assistant' }));
      expect(el).not.toBeNull();
    });

    it('creates chat-entry element with correct dataset', () => {
      const { view, content } = createView();
      const el = view.renderMessage(makeMessage({ id: 'msg-x', role: 'user' }));
      expect(el.className).toContain('chat-entry');
      expect(el.dataset.messageId).toBe('msg-x');
      expect(el.dataset.role).toBe('user');
      expect(content.contains(el)).toBe(true);
    });

    it('tracks element in messageElements map', () => {
      const { view } = createView();
      view.renderMessage(makeMessage({ id: 'msg-x' }));
      expect(view.messageElements.has('msg-x')).toBe(true);
    });

    it('prevents duplicate rendering for same message id', () => {
      const { view, content } = createView();
      view.renderMessage(makeMessage({ id: 'msg-dup' }));
      view.renderMessage(makeMessage({ id: 'msg-dup' }));
      expect(content.querySelectorAll('[data-message-id="msg-dup"]').length).toBe(1);
    });

    it('uses escapeHTML for user messages', () => {
      const { view } = createView();
      view.renderMessage(makeMessage({ role: 'user', content: '<script>alert(1)</script>' }));
      expect(mockEscapeHTML).toHaveBeenCalledWith('<script>alert(1)</script>');
    });

    it('uses markdownRenderer for assistant messages', () => {
      const { view } = createView();
      view.renderMessage(makeMessage({ role: 'assistant', content: '**bold**' }));
      expect(mockMarkdownRender).toHaveBeenCalledWith('**bold**', expect.any(Object));
    });

    it('sets backend_id dataset when provided', () => {
      const { view } = createView();
      const el = view.renderMessage(makeMessage({ backend_id: 'be-123' }));
      expect(el.dataset.backendId).toBe('be-123');
    });

    it('sets sequence dataset when sequence_in_chat is provided', () => {
      const { view } = createView();
      const el = view.renderMessage(makeMessage({ sequence_in_chat: 5 }));
      expect(el.dataset.sequence).toBe('5');
    });

    it('adds error class and category for error messages', () => {
      const { view } = createView();
      const el = view.renderMessage(makeMessage({
        type: 'error',
        error_category: 'network',
        role: 'assistant',
        content: 'Connection failed',
      }));
      expect(el.classList.contains('chat-entry-error')).toBe(true);
      expect(el.dataset.errorCategory).toBe('network');
    });

    it('generates temp id when message has no id', () => {
      const { view } = createView();
      const el = view.renderMessage(makeMessage({ id: undefined }));
      expect(el.dataset.messageId).toMatch(/^temp_/);
      expect(view._hasUntrackedMessages).toBe(true);
    });

    it('returns the created element', () => {
      const { view } = createView();
      const el = view.renderMessage(makeMessage());
      expect(el).toBeInstanceOf(HTMLElement);
    });
  });

  // =========================================================================
  // updateMessage
  // =========================================================================
  describe('updateMessage', () => {
    it('returns false for missing messageId', () => {
      const { view } = createView();
      expect(view.updateMessage(null, 'text')).toBe(false);
    });

    it('creates placeholder when element not found', () => {
      const { view } = createView();
      const result = view.updateMessage('new-msg', 'hello');
      expect(result).toBe(true);
      expect(view.messageElements.has('new-msg')).toBe(true);
    });

    it('updates existing element content', () => {
      const { view } = createView();
      view.renderMessage(makeMessage({ id: 'msg-u', role: 'assistant', content: 'initial' }));
      const result = view.updateMessage('msg-u', 'updated text');
      expect(result).toBe(true);
    });

    it('throttles logging during streaming updates', () => {
      const { view } = createView();
      view.renderMessage(makeMessage({ id: 'msg-stream', role: 'assistant', content: 'a' }));

      // Multiple rapid updates
      for (let i = 0; i < 10; i++) {
        view.updateMessage('msg-stream', `content-${i}`);
      }

      // Should have tracked updates
      expect(view._updateLogThrottle.currentMessageId).toBe('msg-stream');
    });

    it('resets throttle counter when message id changes', () => {
      const { view } = createView();
      view.renderMessage(makeMessage({ id: 'msg-a', role: 'assistant', content: 'a' }));
      view.renderMessage(makeMessage({ id: 'msg-b', role: 'assistant', content: 'b' }));

      view.updateMessage('msg-a', 'updated-a');
      expect(view._updateLogThrottle.currentMessageId).toBe('msg-a');

      view.updateMessage('msg-b', 'updated-b');
      expect(view._updateLogThrottle.currentMessageId).toBe('msg-b');
    });
  });

  // =========================================================================
  // removeMessage
  // =========================================================================
  describe('removeMessage', () => {
    it('removes existing message from DOM and map', () => {
      const { view, content } = createView();
      view.renderMessage(makeMessage({ id: 'rm-1' }));
      expect(view.removeMessage('rm-1')).toBe(true);
      expect(view.messageElements.has('rm-1')).toBe(false);
      expect(content.querySelector('[data-message-id="rm-1"]')).toBeNull();
    });

    it('returns false for non-existent message', () => {
      const { view } = createView();
      expect(view.removeMessage('nonexistent')).toBe(false);
    });
  });

  // =========================================================================
  // clear
  // =========================================================================
  describe('clear', () => {
    it('empties content and clears map', () => {
      const { view, content } = createView();
      view.renderMessage(makeMessage({ id: 'c1' }));
      view.renderMessage(makeMessage({ id: 'c2', content: 'two' }));

      view.clear();
      expect(content.innerHTML).toBe('');
      expect(view.messageElements.size).toBe(0);
      expect(view._hasUntrackedMessages).toBe(false);
    });

    it('handles null contentElement gracefully', () => {
      const view = new MessageView();
      expect(() => view.clear()).not.toThrow();
    });
  });

  // =========================================================================
  // showLoadingState / hideLoadingState
  // =========================================================================
  describe('loading state', () => {
    it('shows loading spinner', () => {
      const { view, content } = createView();
      view.showLoadingState();
      expect(content.querySelector('.message-loading')).not.toBeNull();
      expect(content.querySelector('.loading-spinner')).not.toBeNull();
    });

    it('hides loading spinner', () => {
      const { view, content } = createView();
      view.showLoadingState();
      view.hideLoadingState();
      expect(content.querySelector('.message-loading')).toBeNull();
    });

    it('showLoadingState is safe before init', () => {
      const view = new MessageView();
      expect(() => view.showLoadingState()).not.toThrow();
    });

    it('hideLoadingState is safe before init', () => {
      const view = new MessageView();
      expect(() => view.hideLoadingState()).not.toThrow();
    });

    it('hideLoadingState is safe when no loader present', () => {
      const { view } = createView();
      expect(() => view.hideLoadingState()).not.toThrow();
    });
  });

  // =========================================================================
  // showEmptyState
  // =========================================================================
  describe('showEmptyState', () => {
    it('creates empty state element', () => {
      const { view, content } = createView();
      view.showEmptyState();
      expect(content.querySelector('.chat-empty-state')).not.toBeNull();
      expect(content.querySelector('.chat-empty-title').textContent).toBe('How can I help?');
    });

    it('is safe before init', () => {
      const view = new MessageView();
      expect(() => view.showEmptyState()).not.toThrow();
    });
  });

  // =========================================================================
  // renderMessageWithAttachments
  // =========================================================================
  describe('renderMessageWithAttachments', () => {
    it('returns null before init', () => {
      const view = new MessageView();
      expect(view.renderMessageWithAttachments(makeMessage(), {})).toBeNull();
    });

    it('renders image preview', () => {
      const { view, content } = createView();
      const el = view.renderMessageWithAttachments(
        makeMessage({ id: 'att-1' }),
        { imageBase64: 'data:image/png;base64,ABC123' }
      );
      expect(el).not.toBeNull();
      const img = content.querySelector('.attached-image');
      expect(img).not.toBeNull();
      expect(img.getAttribute('src')).toBe('data:image/png;base64,ABC123');
    });

    it('renders file list with sanitized names', () => {
      const { view, content } = createView();
      view.renderMessageWithAttachments(
        makeMessage({ id: 'att-2' }),
        {
          files: [
            { name: 'test.py', size: 1024, artifactId: 'a-1' },
            { name: 'data.json', size: 512, artifactId: 'a-2' },
          ],
        }
      );
      const items = content.querySelectorAll('.file-attachment-item');
      expect(items.length).toBe(2);
      expect(mockEscapeHTML).toHaveBeenCalled();
    });

    it('shows correct file count summary', () => {
      const { view, content } = createView();
      view.renderMessageWithAttachments(
        makeMessage({ id: 'att-3' }),
        {
          files: [
            { name: 'a.txt', size: 100 },
          ],
        }
      );
      const summary = content.querySelector('.attachment-summary');
      expect(summary.textContent).toBe('1 file attached');
    });

    it('pluralizes file count correctly', () => {
      const { view, content } = createView();
      view.renderMessageWithAttachments(
        makeMessage({ id: 'att-4' }),
        {
          files: [
            { name: 'a.txt', size: 100 },
            { name: 'b.txt', size: 200 },
          ],
        }
      );
      expect(content.querySelector('.attachment-summary').textContent).toBe('2 files attached');
    });

    it('tracks message element in map', () => {
      const { view } = createView();
      view.renderMessageWithAttachments(makeMessage({ id: 'att-track' }), {});
      expect(view.messageElements.has('att-track')).toBe(true);
    });

    it('uses DOC icon for JSON files', () => {
      const { view, content } = createView();
      view.renderMessageWithAttachments(
        makeMessage({ id: 'att-json' }),
        { files: [{ name: 'config.json', size: 50 }] }
      );
      const icon = content.querySelector('.file-attachment-icon');
      expect(icon.textContent).toBe('DOC');
    });

    it('uses FILE icon for non-JSON files', () => {
      const { view, content } = createView();
      view.renderMessageWithAttachments(
        makeMessage({ id: 'att-file' }),
        { files: [{ name: 'script.py', size: 50 }] }
      );
      expect(content.querySelector('.file-attachment-icon').textContent).toBe('FILE');
    });

    it('handles file with no name', () => {
      const { view, content } = createView();
      view.renderMessageWithAttachments(
        makeMessage({ id: 'att-noname' }),
        { files: [{ size: 50 }] }
      );
      const nameEl = content.querySelector('.file-attachment-name');
      expect(nameEl).toBeTruthy();
    });
  });

  // =========================================================================
  // _handleFileAttachmentClickById
  // =========================================================================
  describe('_handleFileAttachmentClickById', () => {
    it('opens file viewer modal when artifact found', async () => {
      const { view } = createView();
      mockGetArtifact.mockResolvedValue({
        title: 'script.py',
        content: 'print("hello")',
        language: 'python',
        type: 'code',
      });

      await view._handleFileAttachmentClickById('art-1');
      expect(mockGetArtifact).toHaveBeenCalledWith('art-1');
      expect(mockFileViewerOpen).toHaveBeenCalledWith(expect.objectContaining({
        filename: 'script.py',
        content: 'print("hello")',
        language: 'python',
      }));
    });

    it('does not open modal when artifact is null', async () => {
      const { view } = createView();
      mockGetArtifact.mockResolvedValue(null);

      await view._handleFileAttachmentClickById('art-missing');
      expect(mockFileViewerOpen).not.toHaveBeenCalled();
    });

    it('catches errors gracefully', async () => {
      const { view } = createView();
      mockGetArtifact.mockRejectedValue(new Error('storage error'));

      await expect(view._handleFileAttachmentClickById('art-err')).resolves.toBeUndefined();
    });

    it('reuses existing fileViewerModal instance', async () => {
      const { view } = createView();
      mockGetArtifact.mockResolvedValue({ title: 'a.py', content: 'x', language: 'py', type: 'code' });

      await view._handleFileAttachmentClickById('art-1');
      const modal1 = view.fileViewerModal;

      await view._handleFileAttachmentClickById('art-2');
      expect(view.fileViewerModal).toBe(modal1);
    });
  });

  // =========================================================================
  // _handleFileAttachmentClick
  // =========================================================================
  describe('_handleFileAttachmentClick', () => {
    it('returns early when no chatId', async () => {
      const { view } = createView({ messageState: { currentChatId: null } });
      await view._handleFileAttachmentClick({ name: 'test.py' }, makeMessage());
      expect(mockLoadArtifacts).not.toHaveBeenCalled();
    });

    it('opens modal when matching artifact found by title', async () => {
      const { view } = createView();
      mockLoadArtifacts.mockResolvedValue([
        { id: 'a-1', title: 'test.py', content: 'code', language: 'python', type: 'code' },
      ]);

      await view._handleFileAttachmentClick({ name: 'test.py' }, makeMessage());
      expect(mockFileViewerOpen).toHaveBeenCalled();
    });

    it('does not open modal when artifact not found', async () => {
      const { view } = createView();
      mockLoadArtifacts.mockResolvedValue([]);

      await view._handleFileAttachmentClick({ name: 'missing.py' }, makeMessage());
      expect(mockFileViewerOpen).not.toHaveBeenCalled();
    });

    it('catches errors gracefully', async () => {
      const { view } = createView();
      mockLoadArtifacts.mockRejectedValue(new Error('fail'));

      await expect(view._handleFileAttachmentClick({ name: 'x.py' }, makeMessage())).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // _handleOpenFileFromEvent
  // =========================================================================
  describe('_handleOpenFileFromEvent', () => {
    it('opens file viewer modal with event data', async () => {
      const { view } = createView();
      await view._handleOpenFileFromEvent({
        artifactId: 'art-1',
        filename: 'test.py',
        content: 'print(1)',
        type: 'code',
        metadata: { language: 'python' },
      });

      expect(mockFileViewerOpen).toHaveBeenCalledWith(expect.objectContaining({
        filename: 'test.py',
        content: 'print(1)',
      }));
    });

    it('defaults filename to Untitled', async () => {
      const { view } = createView();
      await view._handleOpenFileFromEvent({
        artifactId: 'a-1',
        content: 'data',
      });

      expect(mockFileViewerOpen).toHaveBeenCalledWith(expect.objectContaining({
        filename: 'Untitled',
      }));
    });

    it('catches errors gracefully', async () => {
      const { view } = createView();
      mockFileViewerOpen.mockRejectedValue(new Error('modal fail'));

      await expect(view._handleOpenFileFromEvent({
        artifactId: 'a-1',
        content: 'x',
      })).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // _renderContent
  // =========================================================================
  describe('_renderContent', () => {
    it('returns empty string for falsy content', () => {
      const { view } = createView();
      expect(view._renderContent(null, 'user')).toBe('');
      expect(view._renderContent('', 'assistant')).toBe('');
    });

    it('renders markdown for assistant role', () => {
      const { view } = createView();
      view._renderContent('**bold**', 'assistant');
      expect(mockMarkdownRender).toHaveBeenCalledWith('**bold**', { sanitize: true, profile: 'markdown' });
    });

    it('renders markdown for error type', () => {
      const { view } = createView();
      view._renderContent('Error occurred', 'user', 'error');
      expect(mockMarkdownRender).toHaveBeenCalledWith('Error occurred', expect.any(Object));
    });

    it('renders markdown for system role', () => {
      const { view } = createView();
      view._renderContent('System msg', 'system');
      expect(mockMarkdownRender).toHaveBeenCalledWith('System msg', expect.any(Object));
    });

    it('escapes HTML for user role', () => {
      const { view } = createView();
      view._renderContent('<b>hi</b>', 'user');
      expect(mockEscapeHTML).toHaveBeenCalledWith('<b>hi</b>');
    });
  });

  // =========================================================================
  // _getRoleIndicator
  // =========================================================================
  describe('_getRoleIndicator', () => {
    it('returns G for assistant', () => {
      const { view } = createView();
      expect(view._getRoleIndicator('assistant')).toBe('G');
    });

    it('returns U for user', () => {
      const { view } = createView();
      expect(view._getRoleIndicator('user')).toBe('U');
    });

    it('returns bullet for other roles', () => {
      const { view } = createView();
      expect(view._getRoleIndicator('system')).toBe('•');
      expect(view._getRoleIndicator('unknown')).toBe('•');
    });
  });

  // =========================================================================
  // _formatTimestamp
  // =========================================================================
  describe('_formatTimestamp', () => {
    it('handles ISO string timestamp', () => {
      const { view } = createView();
      const result = view._formatTimestamp('2026-01-01T12:00:00Z');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns current time for falsy timestamp', () => {
      const { view } = createView();
      const result = view._formatTimestamp(null);
      expect(typeof result).toBe('string');
    });

    it('returns current time for non-ISO string', () => {
      const { view } = createView();
      const result = view._formatTimestamp('not-a-date');
      expect(typeof result).toBe('string');
    });

    it('handles formatting error gracefully', () => {
      const { view } = createView();
      // Force Date constructor to throw by passing a problematic value
      // The try-catch in source should handle it
      const result = view._formatTimestamp({});
      expect(typeof result).toBe('string');
    });
  });

  // =========================================================================
  // _isImageFile
  // =========================================================================
  describe('_isImageFile', () => {
    it('returns true for image extensions', () => {
      const { view } = createView();
      expect(view._isImageFile('photo.jpg')).toBe(true);
      expect(view._isImageFile('photo.jpeg')).toBe(true);
      expect(view._isImageFile('photo.png')).toBe(true);
      expect(view._isImageFile('photo.gif')).toBe(true);
      expect(view._isImageFile('photo.webp')).toBe(true);
      expect(view._isImageFile('photo.bmp')).toBe(true);
      expect(view._isImageFile('photo.svg')).toBe(true);
    });

    it('returns false for non-image extensions', () => {
      const { view } = createView();
      expect(view._isImageFile('script.py')).toBe(false);
      expect(view._isImageFile('data.json')).toBe(false);
    });

    it('returns false for falsy filename', () => {
      const { view } = createView();
      expect(view._isImageFile(null)).toBe(false);
      expect(view._isImageFile('')).toBe(false);
    });

    it('handles uppercase extensions', () => {
      const { view } = createView();
      expect(view._isImageFile('photo.PNG')).toBe(true);
      expect(view._isImageFile('photo.JPG')).toBe(true);
    });
  });

  // =========================================================================
  // _formatFileSize
  // =========================================================================
  describe('_formatFileSize', () => {
    it('formats bytes', () => {
      const { view } = createView();
      expect(view._formatFileSize(500)).toBe('500 B');
    });

    it('formats kilobytes', () => {
      const { view } = createView();
      expect(view._formatFileSize(2048)).toBe('2.0 KB');
    });

    it('formats megabytes', () => {
      const { view } = createView();
      expect(view._formatFileSize(1048576)).toBe('1.0 MB');
    });
  });

  // =========================================================================
  // _sanitizeFilenameForDisplay
  // =========================================================================
  describe('_sanitizeFilenameForDisplay', () => {
    it('returns Untitled for non-string', () => {
      const { view } = createView();
      expect(view._sanitizeFilenameForDisplay(null)).toBe('Untitled');
      expect(view._sanitizeFilenameForDisplay(123)).toBe('Untitled');
    });

    it('returns Untitled for empty/whitespace string', () => {
      const { view } = createView();
      expect(view._sanitizeFilenameForDisplay('')).toBe('Untitled');
      expect(view._sanitizeFilenameForDisplay('   ')).toBe('Untitled');
    });

    it('strips control characters', () => {
      const { view } = createView();
      expect(view._sanitizeFilenameForDisplay('file\x00name.txt')).toBe('filename.txt');
    });

    it('strips event handler tokens', () => {
      const { view } = createView();
      expect(view._sanitizeFilenameForDisplay('onerror=alert.txt')).toBe('alert.txt');
    });

    it('strips javascript: protocol', () => {
      const { view } = createView();
      const result = view._sanitizeFilenameForDisplay('javascript:alert(1).txt');
      expect(result).not.toContain('javascript:');
    });

    it('strips data: protocol', () => {
      const { view } = createView();
      const result = view._sanitizeFilenameForDisplay('data:text/html,<h1>Hi</h1>');
      expect(result).not.toContain('data:');
    });

    it('truncates to 255 characters', () => {
      const { view } = createView();
      const longName = 'a'.repeat(300);
      expect(view._sanitizeFilenameForDisplay(longName).length).toBe(255);
    });

    it('returns Untitled when all content is stripped', () => {
      const { view } = createView();
      // All content is control characters
      expect(view._sanitizeFilenameForDisplay('\x00\x01\x02')).toBe('Untitled');
    });
  });

  // =========================================================================
  // _pruneMessages
  // =========================================================================
  describe('_pruneMessages', () => {
    it('removes oldest messages when exceeding maxMessages', () => {
      const { view } = createView({ maxMessages: 3 });

      // Render 5 messages
      for (let i = 1; i <= 5; i++) {
        view.renderMessage(makeMessage({ id: `prune-${i}`, content: `msg ${i}` }));
      }

      // Should have pruned to 3
      expect(view.messageElements.size).toBe(3);
    });

    it('handles untracked messages (no id)', () => {
      const { view, content } = createView({ maxMessages: 2 });

      // Add messages without IDs to trigger untracked pruning path
      view.renderMessage(makeMessage({ id: undefined, content: 'untracked1' }));
      view.renderMessage(makeMessage({ id: undefined, content: 'untracked2' }));
      view.renderMessage(makeMessage({ id: undefined, content: 'untracked3' }));

      // _hasUntrackedMessages should be true
      expect(view._hasUntrackedMessages).toBe(true);
    });

    it('is safe when contentElement is null', () => {
      const view = new MessageView();
      expect(() => view._pruneMessages()).not.toThrow();
    });
  });

  // =========================================================================
  // _generateTempId
  // =========================================================================
  describe('_generateTempId', () => {
    it('generates unique temp IDs', () => {
      const { view } = createView();
      const id1 = view._generateTempId();
      const id2 = view._generateTempId();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^temp_/);
    });
  });

  // =========================================================================
  // getMessageCount / getMessageElement
  // =========================================================================
  describe('getters', () => {
    it('getMessageCount returns map size', () => {
      const { view } = createView();
      expect(view.getMessageCount()).toBe(0);
      view.renderMessage(makeMessage({ id: 'g1' }));
      expect(view.getMessageCount()).toBe(1);
    });

    it('getMessageElement returns element or null', () => {
      const { view } = createView();
      view.renderMessage(makeMessage({ id: 'g-el' }));
      expect(view.getMessageElement('g-el')).toBeInstanceOf(HTMLElement);
      expect(view.getMessageElement('nonexistent')).toBeNull();
    });
  });

  // =========================================================================
  // showTypingIndicator / hideTypingIndicator
  // =========================================================================
  describe('typing indicator', () => {
    it('creates indicator element', () => {
      const { view, content } = createView();
      view.showTypingIndicator();
      expect(content.querySelector('.typing-indicator-entry')).not.toBeNull();
      expect(content.querySelector('.typing-indicator-role').textContent).toBe('G');
      expect(content.querySelectorAll('.typing-dot').length).toBe(3);
    });

    it('is idempotent (no duplicates)', () => {
      const { view, content } = createView();
      view.showTypingIndicator();
      view.showTypingIndicator();
      expect(content.querySelectorAll('.typing-indicator-entry').length).toBe(1);
    });

    it('emits scroll:request-bottom when shown', () => {
      const { view, eventBus } = createView();
      view.showTypingIndicator();
      expect(eventBus.emit).toHaveBeenCalledWith('scroll:request-bottom', {
        behavior: 'smooth',
        force: true,
      });
    });

    it('is safe before init', () => {
      const view = new MessageView();
      expect(() => view.showTypingIndicator()).not.toThrow();
    });

    it('hideTypingIndicator adds removing class', () => {
      const { view } = createView();
      view.showTypingIndicator();
      const el = view._typingIndicatorElement;

      view.hideTypingIndicator();
      expect(el.classList.contains('removing')).toBe(true);
      expect(view._typingIndicatorElement).toBeNull();
    });

    it('hideTypingIndicator is idempotent', () => {
      const { view } = createView();
      expect(() => view.hideTypingIndicator()).not.toThrow();
    });

    it('removes element from DOM after animation', () => {
      jest.useFakeTimers();
      const { view, content } = createView();
      view.showTypingIndicator();

      view.hideTypingIndicator();

      // Safety timeout fires at 300ms
      jest.advanceTimersByTime(300);
      expect(content.querySelector('.typing-indicator-entry')).toBeNull();

      jest.useRealTimers();
    });
  });

  // =========================================================================
  // renderMessages (async batch rendering)
  // =========================================================================
  describe('renderMessages', () => {
    it('handles null contentElement', async () => {
      const view = new MessageView();
      await expect(view.renderMessages([makeMessage()])).resolves.toBeUndefined();
    });

    it('handles non-array messages', async () => {
      const { view } = createView();
      await expect(view.renderMessages(null)).resolves.toBeUndefined();
    });

    it('renders messages in batches', async () => {
      const { view, content } = createView();

      const messages = [];
      for (let i = 0; i < 5; i++) {
        messages.push(makeMessage({ id: `batch-${i}`, content: `msg ${i}` }));
      }

      await view.renderMessages(messages);
      expect(content.querySelectorAll('.chat-entry').length).toBe(5);
    });

    it('loads artifacts for the chat', async () => {
      const { view } = createView();
      mockLoadArtifacts.mockResolvedValue([]);

      await view.renderMessages([makeMessage()]);
      expect(mockLoadArtifacts).toHaveBeenCalledWith('chat-1');
    });

    it('renders user messages with attachments when artifacts exist', async () => {
      const { view, content } = createView();
      mockLoadArtifacts.mockResolvedValue([
        {
          id: 'art-1',
          message_id: 'msg-1',
          title: 'file.py',
          content: 'code',
          type: 'code',
        },
      ]);

      await view.renderMessages([makeMessage({ id: 'msg-1', role: 'user', content: 'check this' })]);

      // Should render with attachment
      expect(content.querySelectorAll('.chat-entry').length).toBe(1);
    });

    it('filters out trail-linked artifacts', async () => {
      const { view, content } = createView();
      mockLoadArtifacts.mockResolvedValue([
        {
          id: 'art-trail',
          message_id: 'msg-1',
          title: 'output.py',
          content: 'result',
          type: 'code',
          node_id: 'node-1',
          subgroup_id: 'sg-1',
        },
      ]);

      await view.renderMessages([makeMessage({ id: 'msg-1', role: 'user', content: 'check this' })]);

      // Trail-linked artifacts should not create attachment rendering
      const fileItems = content.querySelectorAll('.file-attachment-item');
      expect(fileItems.length).toBe(0);
    });

    it('handles artifact loading failure gracefully', async () => {
      const { view } = createView();
      mockLoadArtifacts.mockRejectedValue(new Error('storage error'));

      await expect(view.renderMessages([makeMessage()])).resolves.toBeUndefined();
    });

    it('skips artifact loading when no chatId', async () => {
      const { view } = createView({ messageState: { currentChatId: null } });

      await view.renderMessages([makeMessage()]);
      expect(mockLoadArtifacts).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _cleanMessageContent
  // =========================================================================
  describe('_cleanMessageContent', () => {
    it('returns message unchanged for non-user role', () => {
      const { view } = createView();
      const msg = makeMessage({ role: 'assistant', content: '[SYSTEM INSTRUCTION: test]' });
      expect(view._cleanMessageContent(msg)).toBe(msg);
    });

    it('returns message unchanged for null message', () => {
      const { view } = createView();
      expect(view._cleanMessageContent(null)).toBeNull();
    });

    it('returns message unchanged when no system instructions', () => {
      const { view } = createView();
      const msg = makeMessage({ role: 'user', content: 'normal message' });
      expect(view._cleanMessageContent(msg)).toBe(msg);
    });

    it('strips system instruction pattern from user messages', () => {
      const { view } = createView();
      const msg = makeMessage({
        role: 'user',
        content: '[SYSTEM INSTRUCTION: File attached]\nSome file content\n[SYSTEM INSTRUCTION: End of attached file content]\nActual user message',
      });

      const cleaned = view._cleanMessageContent(msg);
      expect(cleaned.content).toBe('Actual user message');
      expect(cleaned.id).toBe(msg.id);
    });

    it('returns message unchanged when content is empty', () => {
      const { view } = createView();
      const msg = makeMessage({ role: 'user', content: '' });
      expect(view._cleanMessageContent(msg)).toBe(msg);
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================
  describe('dispose', () => {
    it('clears all state and DOM references', () => {
      const { view } = createView();
      view.renderMessage(makeMessage({ id: 'd-1' }));
      view.showTypingIndicator();

      view.dispose();

      expect(view.contentElement).toBeNull();
      expect(view.scrollButtonElement).toBeNull();
      expect(view.markdownRenderer).toBeNull();
      expect(view.securitySanitizer).toBeNull();
      expect(view.eventBus).toBeNull();
      expect(view._typingIndicatorElement).toBeNull();
    });

    it('removes scroll button from DOM', () => {
      const { view, parent } = createView();
      expect(parent.querySelector('.chat-scroll-to-bottom')).not.toBeNull();

      view.dispose();
      expect(parent.querySelector('.chat-scroll-to-bottom')).toBeNull();
    });

    it('calls dispose on markdownRenderer and securitySanitizer', () => {
      const { view } = createView();
      const mdDispose = view.markdownRenderer.dispose;
      const ssDispose = view.securitySanitizer.dispose;

      view.dispose();
      expect(mdDispose).toHaveBeenCalled();
      expect(ssDispose).toHaveBeenCalled();
    });

    it('is safe when dependencies are already null', () => {
      const view = new MessageView();
      view.markdownRenderer = null;
      view.securitySanitizer = null;
      expect(() => view.dispose()).not.toThrow();
    });
  });

  // =========================================================================
  // attachment click handlers (DOM event coverage)
  // =========================================================================
  describe('attachment click handlers', () => {
    it('image click handler opens artifact via storage lookup', async () => {
      const { view, content } = createView();
      mockLoadArtifacts.mockResolvedValue([
        { id: 'img-art', message_id: 'att-img', title: 'photo.png', filename: 'photo.png' },
      ]);
      mockGetArtifact.mockResolvedValue({
        title: 'photo.png',
        content: 'base64data',
        language: null,
        type: 'image',
      });

      view.renderMessageWithAttachments(
        makeMessage({ id: 'att-img' }),
        { imageBase64: 'data:image/png;base64,ABC' }
      );

      const img = content.querySelector('.attached-image');
      expect(img).not.toBeNull();

      // Click the image — triggers async handler
      img.click();
      // Allow microtasks
      await new Promise(r => setTimeout(r, 10));

      expect(mockLoadArtifacts).toHaveBeenCalledWith('chat-1');
    });

    it('image click does nothing without chatId', async () => {
      const { view, content } = createView({ messageState: { currentChatId: null } });
      view.renderMessageWithAttachments(
        makeMessage({ id: 'att-img2' }),
        { imageBase64: 'data:image/png;base64,XYZ' }
      );

      const img = content.querySelector('.attached-image');
      img.click();
      await new Promise(r => setTimeout(r, 10));

      expect(mockLoadArtifacts).not.toHaveBeenCalled();
    });

    it('file click handler calls _handleFileAttachmentClickById with artifactId', async () => {
      const { view, content } = createView();
      mockGetArtifact.mockResolvedValue({
        title: 'file.py',
        content: 'code',
        language: 'python',
        type: 'code',
      });

      view.renderMessageWithAttachments(
        makeMessage({ id: 'att-fc' }),
        { files: [{ name: 'file.py', size: 100, artifactId: 'art-fc-1' }] }
      );

      const fileItem = content.querySelector('.file-attachment-item');
      expect(fileItem).not.toBeNull();

      fileItem.click();
      await new Promise(r => setTimeout(r, 10));

      expect(mockGetArtifact).toHaveBeenCalledWith('art-fc-1');
    });

    it('file click handler falls back to _handleFileAttachmentClick without artifactId', async () => {
      const { view, content } = createView();
      mockLoadArtifacts.mockResolvedValue([
        { id: 'a-fb', title: 'fallback.py', content: 'code', language: 'python', type: 'code' },
      ]);

      view.renderMessageWithAttachments(
        makeMessage({ id: 'att-fb' }),
        { files: [{ name: 'fallback.py', size: 100 }] } // No artifactId
      );

      const fileItem = content.querySelector('.file-attachment-item');
      fileItem.click();
      await new Promise(r => setTimeout(r, 10));

      expect(mockLoadArtifacts).toHaveBeenCalledWith('chat-1');
    });

    // NOTE: mouseenter/mouseleave hover handlers (lines 440/443) are untestable
    // in jsdom — it does not dispatch these events to registered listeners.
    // These are 2 lines of CSS style toggling, verified via component tests.
  });

  // =========================================================================
  // edge case coverage
  // =========================================================================
  describe('edge cases', () => {
    it('eventBus artifacts:open-file triggers _handleOpenFileFromEvent', async () => {
      const eventBus = createEventBus();
      const { view } = createView({ eventBus });

      const spy = jest.spyOn(view, '_handleOpenFileFromEvent');
      eventBus.emit('artifacts:open-file', { artifactId: 'x', filename: 'f.py', content: 'c' });

      expect(spy).toHaveBeenCalledWith({ artifactId: 'x', filename: 'f.py', content: 'c' });
    });

    it('updateMessage returns false when textElement is missing', () => {
      const { view } = createView();
      // Manually create a malformed entry
      const entry = document.createElement('div');
      entry.className = 'chat-entry';
      entry.dataset.role = 'assistant';
      // No .chat-text child
      view.messageElements.set('broken', entry);

      expect(view.updateMessage('broken', 'text')).toBe(false);
    });

    it('hideTypingIndicator animationend callback removes element', () => {
      const { view, content } = createView();
      view.showTypingIndicator();
      const el = view._typingIndicatorElement;

      view.hideTypingIndicator();

      // Dispatch animationend
      el.dispatchEvent(new Event('animationend'));
      expect(content.contains(el)).toBe(false);
    });

    it('renderMessages yields between batches via requestAnimationFrame', async () => {
      const { view } = createView();
      const rafSpy = jest.spyOn(global, 'requestAnimationFrame').mockImplementation(cb => { cb(); return 0; });

      const messages = [];
      for (let i = 0; i < 15; i++) {
        messages.push(makeMessage({ id: `raf-${i}`, content: `msg ${i}` }));
      }

      await view.renderMessages(messages);

      // With 15 messages and batch size 10, should have 1 raf yield between batches
      expect(rafSpy).toHaveBeenCalled();
      rafSpy.mockRestore();
    });

    it('renderMessages handles artifact filename extraction from artifact_id', async () => {
      const { view, content } = createView();
      mockLoadArtifacts.mockResolvedValue([
        {
          id: 'a-meta',
          message_id: 'msg-meta',
          content: 'data',
          type: 'file',
          artifact_id: 'file:1234:original_name',
          // No title, no filename, no name
        },
      ]);

      await view.renderMessages([makeMessage({ id: 'msg-meta', role: 'user', content: 'attached' })]);

      // File should be rendered with name extracted from artifact_id
      const nameEl = content.querySelector('.file-attachment-name');
      expect(nameEl).toBeTruthy();
    });

    it('renderMessages handles artifact filename from metadata', async () => {
      const { view, content } = createView();
      mockLoadArtifacts.mockResolvedValue([
        {
          id: 'a-metafn',
          message_id: 'msg-mfn',
          content: 'data',
          type: 'file',
          metadata: { original_filename: 'from_meta.txt' },
          // No title, no filename, no name, no artifact_id with enough parts
        },
      ]);

      await view.renderMessages([makeMessage({ id: 'msg-mfn', role: 'user', content: 'file here' })]);

      const nameEl = content.querySelector('.file-attachment-name');
      expect(nameEl).toBeTruthy();
    });

    it('_formatTimestamp catch block returns fallback', () => {
      const { view } = createView();
      // Temporarily break Date to trigger the catch
      const origDate = global.Date;
      const throwingDate = function (...args) {
        if (args.length > 0 && typeof args[0] === 'string' && args[0].includes('T')) {
          throw new Error('bad date');
        }
        return new origDate(...args);
      };
      throwingDate.prototype = origDate.prototype;
      global.Date = throwingDate;

      const result = view._formatTimestamp('2026-01-01T12:00:00Z');
      expect(typeof result).toBe('string');

      global.Date = origDate;
    });

    it('renderMessageWithAttachments sets _hasUntrackedMessages for no-id message', () => {
      const { view } = createView();
      view.renderMessageWithAttachments(makeMessage({ id: undefined }), {});
      expect(view._hasUntrackedMessages).toBe(true);
    });
  });
});
