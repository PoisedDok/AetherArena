'use strict';

// ---------------------------------------------------------------------------
// Mocks
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

jest.mock('../../../../src/core/events/EventTypes', () => ({
  EventTypes: {
    CHAT: {
      MESSAGE_SENT: 'chat:message-sent',
      MESSAGE_RECEIVED: 'chat:message-received',
      MESSAGE_DELETED: 'chat:message-deleted',
      REQUEST_COMPLETED: 'chat:request-completed',
      REQUEST_COMPLETE: 'chat:request-complete',
      STREAM_ENDED: 'chat:stream-ended',
      STREAM_ERROR: 'chat:stream-error',
      STREAM_CHUNK: 'chat:stream-chunk',
      SWITCHED: 'chat:switched',
      LOADED: 'chat:loaded',
      STREAM_STARTED: 'chat:stream-started',
    },
  },
  EventPriority: {},
}));

jest.mock('../../../../src/renderer/shared/components/Toast', () => ({
  info: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
}));
const Toast = require('../../../../src/renderer/shared/components/Toast');

jest.mock('../../../../src/renderer/shared/components/ConfirmDialog', () => ({
  confirm: jest.fn(),
}));
const ConfirmDialog = require('../../../../src/renderer/shared/components/ConfirmDialog');

const ContextViewerModal = require(
  '../../../../src/renderer/chat/modals/ContextViewerModal'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEventBus() {
  const handlers = {};
  return {
    on: jest.fn((event, handler) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      const cleanup = () => {
        handlers[event] = handlers[event].filter(h => h !== handler);
      };
      return cleanup;
    }),
    emit: jest.fn((event, data) => {
      (handlers[event] || []).forEach(h => h(data));
    }),
    off: jest.fn(),
    _handlers: handlers,
  };
}

function createEndpoint() {
  return {
    getContextMessages: jest.fn(),
    deleteMessageGroup: jest.fn(),
  };
}

function makeContextData(overrides = {}) {
  return {
    messages: [],
    message_count: 3,
    token_count: 500,
    token_limit: 10000,
    usage_percent: 5.0,
    thresholds: { warning: 80, high: 90, critical: 95 },
    ...overrides,
  };
}

function makeMessage(overrides = {}) {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'Hello world',
    is_system: false,
    ...overrides,
  };
}

function createModal(overrides = {}) {
  const endpoint = overrides.endpoint !== undefined ? overrides.endpoint : createEndpoint();
  const eventBus = overrides.eventBus !== undefined ? overrides.eventBus : createEventBus();
  const modal = new ContextViewerModal({
    endpoint,
    eventBus,
    chatId: overrides.chatId || 'chat-1',
    ...overrides,
  });
  if (overrides.isOpen) {
    modal.isOpen = true;
  }
  return { modal, endpoint, eventBus };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContextViewerModal', () => {
  let modal;
  let endpoint;
  let eventBus;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
    Toast.info.mockClear();
    Toast.error.mockClear();
    ConfirmDialog.confirm.mockReset();
  });

  afterEach(() => {
    if (modal) {
      try { modal.destroy(); } catch (e) { /* noop */ }
      modal = null;
    }
    endpoint = null;
    eventBus = null;
    jest.useRealTimers();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('extends BaseModal with correct id and title', () => {
      ({ modal, endpoint, eventBus } = createModal());
      expect(modal.id).toBe('context-viewer-modal');
      expect(modal.title).toBe('Context');
    });

    it('creates overlay in DOM', () => {
      ({ modal } = createModal());
      expect(document.getElementById('context-viewer-modal-overlay')).not.toBeNull();
    });

    it('stores endpoint reference', () => {
      const ep = createEndpoint();
      ({ modal } = createModal({ endpoint: ep }));
      expect(modal.endpoint).toBe(ep);
    });

    it('stores eventBus reference', () => {
      const eb = createEventBus();
      ({ modal } = createModal({ eventBus: eb }));
      expect(modal.eventBus).toBe(eb);
    });

    it('stores chatId', () => {
      ({ modal } = createModal({ chatId: 'test-chat' }));
      expect(modal.chatId).toBe('test-chat');
    });

    it('defaults endpoint to null when not provided', () => {
      ({ modal } = createModal({ endpoint: undefined }));
      expect(modal.endpoint).toBeNull();
    });

    it('defaults eventBus to null when not provided', () => {
      ({ modal } = createModal({ eventBus: undefined }));
      expect(modal.eventBus).toBeNull();
    });

    it('initializes state properties', () => {
      ({ modal } = createModal());
      expect(modal.contextData).toBeNull();
      expect(modal.messages).toEqual([]);
      expect(modal._listeners).toEqual([]);
      expect(modal._subscriptions).toEqual([]);
      expect(modal._refreshTimer).toBeNull();
      expect(modal._isStreaming).toBe(false);
      expect(modal._liveIndicatorEl).toBeNull();
    });

    it('sets panel id and body class', () => {
      ({ modal } = createModal());
      expect(modal.panel.id).toBe('context-viewer-modal');
      expect(modal.bodyEl.classList.contains('ctx-body')).toBe(true);
    });
  });

  // =========================================================================
  // _renderContent
  // =========================================================================

  describe('_renderContent', () => {
    it('shows empty state when endpoint is null', async () => {
      ({ modal } = createModal({ endpoint: null }));
      await modal._renderContent();
      expect(modal.bodyEl.innerHTML).toContain('Endpoint not initialized');
    });

    it('shows empty state when chatId is null', async () => {
      ({ modal, endpoint } = createModal({ chatId: null }));
      await modal._renderContent();
      expect(modal.bodyEl.innerHTML).toContain('No active chat');
    });

    it('shows loading skeleton then renders content on success', async () => {
      const data = makeContextData({ messages: [makeMessage()] });
      ({ modal, endpoint } = createModal());
      modal.isOpen = true; // Set open for direct _renderContent call
      endpoint.getContextMessages.mockResolvedValue(data);
      await modal._renderContent();
      expect(endpoint.getContextMessages).toHaveBeenCalledWith('chat-1');
      expect(modal.contextData).toBe(data);
      expect(modal.messages.length).toBe(1);
      // Stats header rendered
      expect(modal.bodyEl.querySelector('.ctx-stats')).not.toBeNull();
    });

    it('shows error state on fetch failure', async () => {
      ({ modal, endpoint } = createModal());
      modal.isOpen = true; // Set open for direct _renderContent call
      endpoint.getContextMessages.mockRejectedValue(new Error('network fail'));
      await modal._renderContent();
      expect(modal.bodyEl.innerHTML).toContain('Failed to Load Context');
      expect(modal.bodyEl.innerHTML).toContain('network fail');
    });

    it('shows "Unknown error" when error has no message', async () => {
      ({ modal, endpoint } = createModal());
      modal.isOpen = true; // Set open for direct _renderContent call
      endpoint.getContextMessages.mockRejectedValue({});
      await modal._renderContent();
      expect(modal.bodyEl.innerHTML).toContain('Unknown error');
    });
  });

  // =========================================================================
  // _renderUI — stats header
  // =========================================================================

  describe('_renderUI — stats', () => {
    it('displays message count and token stats', async () => {
      const data = makeContextData({
        message_count: 7,
        token_count: 1500,
        token_limit: 10000,
        usage_percent: 15.0,
        messages: [],
      });
      ({ modal, endpoint } = createModal());
      modal.isOpen = true;
      endpoint.getContextMessages.mockResolvedValue(data);
      await modal._renderContent();
      const leftStats = modal.bodyEl.querySelector('.ctx-stats-left');
      expect(leftStats.textContent).toContain('7');
      expect(leftStats.textContent).toContain('1,500');
      expect(leftStats.textContent).toContain('10,000');
    });

    it('shows usage badge with percentage', async () => {
      const data = makeContextData({ usage_percent: 42.567, messages: [] });
      ({ modal, endpoint } = createModal());
      modal.isOpen = true;
      endpoint.getContextMessages.mockResolvedValue(data);
      await modal._renderContent();
      const badge = modal.bodyEl.querySelector('.ctx-usage-badge');
      expect(badge.textContent).toBe('42.6% Used');
    });

    it('applies success tone when usage < warning', async () => {
      const data = makeContextData({ usage_percent: 50, messages: [] });
      ({ modal, endpoint } = createModal());
      modal.isOpen = true;
      endpoint.getContextMessages.mockResolvedValue(data);
      await modal._renderContent();
      const badge = modal.bodyEl.querySelector('.ctx-usage-badge');
      expect(badge.parentElement.style.getPropertyValue('--ctx-usage-bg')).toContain('success');
    });

    it('applies info tone when usage >= warning but < high', async () => {
      const data = makeContextData({ usage_percent: 85, messages: [] });
      ({ modal, endpoint } = createModal());
      modal.isOpen = true;
      endpoint.getContextMessages.mockResolvedValue(data);
      await modal._renderContent();
      const badge = modal.bodyEl.querySelector('.ctx-usage-badge');
      expect(badge.parentElement.style.getPropertyValue('--ctx-usage-bg')).toContain('info');
    });

    it('applies warning tone when usage >= high but < critical', async () => {
      const data = makeContextData({ usage_percent: 92, messages: [] });
      ({ modal, endpoint } = createModal());
      modal.isOpen = true; // Add this
      endpoint.getContextMessages.mockResolvedValue(data);
      await modal._renderContent();
      const badge = modal.bodyEl.querySelector('.ctx-usage-badge');
      expect(badge.parentElement.style.getPropertyValue('--ctx-usage-bg')).toContain('warning');
    });

    it('applies error tone when usage >= critical', async () => {
      const data = makeContextData({ usage_percent: 97, messages: [] });
      ({ modal, endpoint } = createModal());
      modal.isOpen = true; // Add this
      endpoint.getContextMessages.mockResolvedValue(data);
      await modal._renderContent();
      const badge = modal.bodyEl.querySelector('.ctx-usage-badge');
      expect(badge.parentElement.style.getPropertyValue('--ctx-usage-bg')).toContain('error');
    });

    it('handles absolute threshold values (> 100) by converting to percentages', async () => {
      const data = makeContextData({
        usage_percent: 85,
        token_limit: 10000,
        thresholds: { warning: 8000, high: 9000, critical: 9500 },
        messages: [],
      });
      ({ modal, endpoint } = createModal());
      modal.isOpen = true; // Add this
      endpoint.getContextMessages.mockResolvedValue(data);
      await modal._renderContent();
      // 8000/10000*100 = 80%, so 85% >= 80% => info tone
      const badge = modal.bodyEl.querySelector('.ctx-usage-badge');
      expect(badge.parentElement.style.getPropertyValue('--ctx-usage-bg')).toContain('info');
    });

    it('uses default thresholds when not provided', async () => {
      const data = makeContextData({ usage_percent: 50, messages: [] });
      delete data.thresholds;
      ({ modal, endpoint } = createModal());
      modal.isOpen = true; // Add this
      endpoint.getContextMessages.mockResolvedValue(data);
      await modal._renderContent();
      const badge = modal.bodyEl.querySelector('.ctx-usage-badge');
      expect(badge.parentElement.style.getPropertyValue('--ctx-usage-bg')).toContain('success');
    });

    it('shows empty state when no messages', async () => {
      const data = makeContextData({ messages: [] });
      ({ modal, endpoint } = createModal());
      modal.isOpen = true; // Add this
      endpoint.getContextMessages.mockResolvedValue(data);
      await modal._renderContent();
      expect(modal.bodyEl.innerHTML).toContain('No Messages');
      expect(modal.bodyEl.innerHTML).toContain('Start a conversation');
    });
  });

  // =========================================================================
  // _groupMessages
  // =========================================================================

  describe('_groupMessages', () => {
    beforeEach(() => {
      ({ modal } = createModal());
    });

    it('returns empty array for empty messages', () => {
      expect(modal._groupMessages([])).toEqual([]);
    });

    it('groups system messages as standalone', () => {
      const messages = [makeMessage({ role: 'system', is_system: true })];
      const groups = modal._groupMessages(messages);
      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe('system');
      expect(groups[0].messages.length).toBe(1);
    });

    it('detects system via is_system flag', () => {
      const messages = [makeMessage({ role: 'user', is_system: true })];
      const groups = modal._groupMessages(messages);
      expect(groups[0].type).toBe('system');
    });

    it('pairs user + assistant together', () => {
      const messages = [
        makeMessage({ id: 'u1', role: 'user' }),
        makeMessage({ id: 'a1', role: 'assistant' }),
      ];
      const groups = modal._groupMessages(messages);
      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe('pair');
      expect(groups[0].messages.length).toBe(2);
      expect(groups[0].userMessageId).toBe('u1');
    });

    it('handles user without following assistant', () => {
      const messages = [makeMessage({ id: 'u1', role: 'user' })];
      const groups = modal._groupMessages(messages);
      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe('pair');
      expect(groups[0].messages.length).toBe(1);
    });

    it('groups orphan assistant as standalone', () => {
      const messages = [makeMessage({ role: 'assistant' })];
      const groups = modal._groupMessages(messages);
      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe('orphan');
    });

    it('skips unknown roles', () => {
      const messages = [makeMessage({ role: 'unknown' })];
      const groups = modal._groupMessages(messages);
      expect(groups.length).toBe(0);
    });

    it('handles complex mixed sequence', () => {
      const messages = [
        makeMessage({ role: 'system', is_system: true }),
        makeMessage({ id: 'u1', role: 'user' }),
        makeMessage({ id: 'a1', role: 'assistant' }),
        makeMessage({ id: 'u2', role: 'user' }),
        makeMessage({ role: 'assistant' }),
        makeMessage({ role: 'unknown' }),
        makeMessage({ role: 'assistant' }),
      ];
      const groups = modal._groupMessages(messages);
      expect(groups.length).toBe(4); // system, pair, pair, orphan
      expect(groups[0].type).toBe('system');
      expect(groups[1].type).toBe('pair');
      expect(groups[1].messages.length).toBe(2);
      expect(groups[2].type).toBe('pair');
      expect(groups[2].messages.length).toBe(2);
      expect(groups[3].type).toBe('orphan');
    });
  });

  // =========================================================================
  // _createGroupCard
  // =========================================================================

  describe('_createGroupCard', () => {
    beforeEach(async () => {
      const data = makeContextData({ messages: [] });
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(data);
      await modal._renderContent();
    });

    it('renders system group as system card', () => {
      const group = { type: 'system', messages: [makeMessage({ role: 'system', content: 'You are helpful' })] };
      const card = modal._createGroupCard(group, 0);
      // System card has collapsible sections
      expect(card.querySelector('.ctx-accordion')).not.toBeNull();
    });

    it('renders pair group with turn badge', () => {
      const group = {
        type: 'pair',
        messages: [makeMessage({ role: 'user' }), makeMessage({ role: 'assistant' })],
        userMessageId: 'u1',
      };
      const card = modal._createGroupCard(group, 0);
      expect(card.className).toBe('ctx-turn');
      const badge = card.querySelector('.ctx-turn-badge');
      expect(badge.textContent).toBe('Turn #1');
    });

    it('renders delete button when userMessageId exists', () => {
      const group = {
        type: 'pair',
        messages: [makeMessage({ role: 'user' })],
        userMessageId: 'u1',
      };
      const card = modal._createGroupCard(group, 0);
      const deleteBtn = card.querySelector('.ctx-delete');
      expect(deleteBtn).not.toBeNull();
      expect(deleteBtn.title).toContain('Delete this turn');
    });

    it('does not render delete button when no userMessageId', () => {
      const group = {
        type: 'pair',
        messages: [makeMessage({ role: 'user' })],
      };
      const card = modal._createGroupCard(group, 0);
      const deleteBtn = card.querySelector('.ctx-delete');
      expect(deleteBtn).toBeNull();
    });

    it('renders separator between user and assistant messages', () => {
      const group = {
        type: 'pair',
        messages: [makeMessage({ role: 'user' }), makeMessage({ role: 'assistant' })],
        userMessageId: 'u1',
      };
      const card = modal._createGroupCard(group, 0);
      const sep = card.querySelector('.ctx-separator');
      expect(sep).not.toBeNull();
    });

    it('does not render separator for single-message group', () => {
      const group = { type: 'pair', messages: [makeMessage({ role: 'user' })], userMessageId: 'u1' };
      const card = modal._createGroupCard(group, 0);
      const sep = card.querySelector('.ctx-separator');
      expect(sep).toBeNull();
    });
  });

  // =========================================================================
  // _createSystemCard
  // =========================================================================

  describe('_createSystemCard', () => {
    beforeEach(async () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal._renderContent();
    });

    it('renders system prompt section', () => {
      const msg = makeMessage({ role: 'system', content: 'You are an AI assistant.' });
      const card = modal._createSystemCard(msg);
      const badges = card.querySelectorAll('.ctx-accordion-badge');
      const titles = Array.from(badges).map(b => b.textContent);
      expect(titles).toContain('SYSTEM PROMPT');
      expect(titles).toContain('GLOBAL MEMORIES');
    });

    it('renders global memories when marker present', () => {
      const content = 'Prompt text\n## 🧠 Global Memory Context\nMemory item 1';
      const msg = makeMessage({ role: 'system', content });
      const card = modal._createSystemCard(msg);
      const contents = card.querySelectorAll('.ctx-accordion-content');
      // First card = system prompt, second = global memories
      expect(contents[0].textContent).toBe('Prompt text');
      expect(contents[1].textContent).toContain('Memory item 1');
    });

    it('renders API docs when marker present', () => {
      const content = 'Prompt\n## 🔌 Backend API Access\nGET /api/foo';
      const msg = makeMessage({ role: 'system', content });
      const card = modal._createSystemCard(msg);
      const badges = card.querySelectorAll('.ctx-accordion-badge');
      const titles = Array.from(badges).map(b => b.textContent);
      expect(titles).toContain('API REFERENCE');
    });

    it('renders all three sections when all markers present', () => {
      const content = [
        'System prompt text',
        '## 🧠 Global Memory Context',
        'Global memories here',
        '## 💬 Chat Memory Context',
        'Chat memories here',
        '## 🔌 Backend API Access',
        'API docs here',
      ].join('\n');
      const msg = makeMessage({ role: 'system', content });
      const card = modal._createSystemCard(msg);
      const accordions = card.querySelectorAll('.ctx-accordion');
      expect(accordions.length).toBe(3);
    });

    it('handles object content with text property', () => {
      const msg = makeMessage({ role: 'system', content: { text: 'Object prompt' } });
      const card = modal._createSystemCard(msg);
      const contents = card.querySelectorAll('.ctx-accordion-content');
      expect(contents[0].textContent).toContain('Object prompt');
    });

    it('handles object content without text property', () => {
      const msg = makeMessage({ role: 'system', content: { custom: 'data' } });
      const card = modal._createSystemCard(msg);
      const contents = card.querySelectorAll('.ctx-accordion-content');
      expect(contents[0].textContent).toContain('"custom"');
    });

    it('shows default global memories text when no global marker', () => {
      const msg = makeMessage({ role: 'system', content: 'Just a prompt' });
      const card = modal._createSystemCard(msg);
      const contents = card.querySelectorAll('.ctx-accordion-content');
      // Second accordion is global memories with default text
      expect(contents[1].textContent).toBe('No global memories available for this chat.');
    });

    it('uses plain text marker fallback (no emoji)', () => {
      const content = 'Prompt\n## Global Memory Context\nPlain marker memory';
      const msg = makeMessage({ role: 'system', content });
      const card = modal._createSystemCard(msg);
      const contents = card.querySelectorAll('.ctx-accordion-content');
      expect(contents[1].textContent).toContain('Plain marker memory');
    });
  });

  // =========================================================================
  // _createCollapsibleCard
  // =========================================================================

  describe('_createCollapsibleCard', () => {
    beforeEach(async () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal._renderContent();
    });

    it('creates collapsed card by default', () => {
      const card = modal._createCollapsibleCard({
        title: 'TEST',
        content: 'content',
        palette: { bg: 'bg', border: 'border', text: 'text' },
      });
      expect(card.classList.contains('ctx-accordion')).toBe(true);
      expect(card.classList.contains('is-open')).toBe(false);
    });

    it('creates open card when collapsed=false', () => {
      const card = modal._createCollapsibleCard({
        title: 'TEST',
        content: 'content',
        palette: { bg: 'bg', border: 'border', text: 'text' },
        collapsed: false,
      });
      expect(card.classList.contains('is-open')).toBe(true);
    });

    it('toggles open state on header click', () => {
      const card = modal._createCollapsibleCard({
        title: 'TEST',
        content: 'content',
        palette: { bg: 'bg', border: 'border', text: 'text' },
        collapsed: true,
      });
      const header = card.querySelector('.ctx-accordion-header');
      header.click();
      expect(card.classList.contains('is-open')).toBe(true);
      header.click();
      expect(card.classList.contains('is-open')).toBe(false);
    });

    it('sets CSS custom properties from palette', () => {
      const card = modal._createCollapsibleCard({
        title: 'TEST',
        content: 'content',
        palette: { bg: 'red', border: 'green', text: 'blue' },
      });
      expect(card.style.getPropertyValue('--ctx-badge-bg')).toBe('red');
      expect(card.style.getPropertyValue('--ctx-badge-border')).toBe('green');
      expect(card.style.getPropertyValue('--ctx-badge-text')).toBe('blue');
    });

    it('renders title badge and content', () => {
      const card = modal._createCollapsibleCard({
        title: 'MY SECTION',
        content: 'My content here',
        palette: { bg: 'bg', border: 'border', text: 'text' },
      });
      expect(card.querySelector('.ctx-accordion-badge').textContent).toBe('MY SECTION');
      expect(card.querySelector('.ctx-accordion-content').textContent).toBe('My content here');
    });
  });

  // =========================================================================
  // _createMessageInGroup
  // =========================================================================

  describe('_createMessageInGroup', () => {
    beforeEach(async () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal._renderContent();
    });

    it('renders user role badge', () => {
      const msg = makeMessage({ role: 'user', content: 'Hello' });
      const el = modal._createMessageInGroup(msg, 0);
      const badge = el.querySelector('div');
      expect(badge.textContent).toBe('USER');
    });

    it('renders assistant role badge', () => {
      const msg = makeMessage({ role: 'assistant', content: 'Hi there' });
      const el = modal._createMessageInGroup(msg, 0);
      const badge = el.querySelector('div');
      expect(badge.textContent).toBe('ASSISTANT');
    });

    it('renders unknown role badge', () => {
      const msg = makeMessage({ role: 'tool', content: 'result' });
      const el = modal._createMessageInGroup(msg, 0);
      const badge = el.querySelector('div');
      expect(badge.textContent).toBe('TOOL');
    });

    it('renders string content', () => {
      const msg = makeMessage({ content: 'Hello world' });
      const el = modal._createMessageInGroup(msg, 0);
      const divs = el.querySelectorAll('div');
      expect(divs[1].textContent).toBe('Hello world');
    });

    it('renders object content with text property', () => {
      const msg = makeMessage({ content: { text: 'Object text' } });
      const el = modal._createMessageInGroup(msg, 0);
      const divs = el.querySelectorAll('div');
      expect(divs[1].textContent).toBe('Object text');
    });

    it('renders object content as JSON when no text property', () => {
      const msg = makeMessage({ content: { key: 'value' } });
      const el = modal._createMessageInGroup(msg, 0);
      const divs = el.querySelectorAll('div');
      expect(divs[1].textContent).toContain('"key"');
    });
  });

  // =========================================================================
  // _setupEventListeners
  // =========================================================================

  describe('_setupEventListeners', () => {
    it('does nothing when eventBus is null', () => {
      ({ modal } = createModal({ eventBus: null }));
      modal._setupEventListeners();
      expect(modal._subscriptions.length).toBe(0);
    });

    it('subscribes to multiple chat events', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      // At least: MESSAGE_SENT, MESSAGE_RECEIVED, MESSAGE_DELETED, REQUEST_COMPLETED,
      // REQUEST_COMPLETE, STREAM_ENDED (x2), STREAM_ERROR (x2), STREAM_CHUNK, SWITCHED, LOADED, STREAM_STARTED
      expect(eventBus.on.mock.calls.length).toBeGreaterThanOrEqual(10);
    });

    it('refreshForChat triggers refresh when chatId matches', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      const spy = jest.spyOn(modal, '_scheduleRefresh');
      eventBus.emit('chat:message-sent', { chatId: 'chat-1' });
      expect(spy).toHaveBeenCalled();
    });

    it('refreshForChat does not trigger for different chatId', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      const spy = jest.spyOn(modal, '_scheduleRefresh');
      eventBus.emit('chat:message-sent', { chatId: 'other-chat' });
      expect(spy).not.toHaveBeenCalled();
    });

    it('refreshForChat does not trigger when modal is closed', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      jest.advanceTimersByTime(0);
      modal.close();
      const spy = jest.spyOn(modal, '_scheduleRefresh');
      eventBus.emit('chat:message-sent', { chatId: 'chat-1' });
      expect(spy).not.toHaveBeenCalled();
    });

    it('handleChatSwitch updates chatId and shows loading', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      eventBus.emit('chat:switched', { chatId: 'new-chat' });
      expect(modal.chatId).toBe('new-chat');
      expect(modal.contextData).toBeNull();
      expect(modal.messages).toEqual([]);
    });

    it('handleChatSwitch ignores same chatId', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      const spy = jest.spyOn(modal, '_scheduleRefresh');
      spy.mockClear();
      eventBus.emit('chat:switched', { chatId: 'chat-1' });
      expect(spy).not.toHaveBeenCalled();
    });

    it('handleChatSwitch ignores null chatId', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      modal.chatId = 'original';
      eventBus.emit('chat:switched', { chatId: null });
      expect(modal.chatId).toBe('original');
    });

    it('STREAM_STARTED sets streaming state', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      eventBus.emit('chat:stream-started', { chatId: 'chat-1' });
      expect(modal._isStreaming).toBe(true);
    });

    it('STREAM_STARTED ignores different chatId', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      eventBus.emit('chat:stream-started', { chatId: 'other' });
      expect(modal._isStreaming).toBe(false);
    });

    it('STREAM_CHUNK calls _handleStreamChunk', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      const spy = jest.spyOn(modal, '_handleStreamChunk');
      eventBus.emit('chat:stream-chunk', { chatId: 'chat-1', chunk: 'data' });
      expect(spy).toHaveBeenCalledWith({ chatId: 'chat-1', chunk: 'data' });
    });

    it('STREAM_CHUNK ignores different chatId', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      const spy = jest.spyOn(modal, '_handleStreamChunk');
      eventBus.emit('chat:stream-chunk', { chatId: 'other', chunk: 'data' });
      expect(spy).not.toHaveBeenCalled();
    });

    it('STREAM_ENDED clears streaming state for matching chatId', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      modal._isStreaming = true;
      eventBus.emit('chat:stream-ended', { chatId: 'chat-1' });
      expect(modal._isStreaming).toBe(false);
    });

    it('STREAM_ENDED does not clear streaming state for different chatId', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      modal._isStreaming = true;
      eventBus.emit('chat:stream-ended', { chatId: 'other-chat' });
      expect(modal._isStreaming).toBe(true);
    });

    it('STREAM_ERROR clears streaming state for matching chatId', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      modal._isStreaming = true;
      eventBus.emit('chat:stream-error', { chatId: 'chat-1' });
      expect(modal._isStreaming).toBe(false);
    });

    it('STREAM_ERROR does not clear streaming state for different chatId', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      modal._isStreaming = true;
      eventBus.emit('chat:stream-error', { chatId: 'other-chat' });
      expect(modal._isStreaming).toBe(true);
    });
  });

  // =========================================================================
  // _scheduleRefresh
  // =========================================================================

  describe('_scheduleRefresh', () => {
    it('debounces refresh with 300ms delay', async () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      
      const spy = jest.spyOn(modal, '_loadContextData').mockResolvedValue(undefined);
      
      modal._scheduleRefresh();
      modal._scheduleRefresh();
      modal._scheduleRefresh();
      
      expect(spy).not.toHaveBeenCalled();
      
      jest.advanceTimersByTime(300);
      
      // Should only call once (debounced)
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('clears previous timer on re-schedule', () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      modal.isOpen = true;
      modal._scheduleRefresh();
      const firstTimer = modal._refreshTimer;
      modal._scheduleRefresh();
      expect(modal._refreshTimer).not.toBe(firstTimer);
    });

    it('does not refresh when modal is closed', async () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      jest.advanceTimersByTime(0);
      modal.close();
      modal.isOpen = false;
      const spy = jest.spyOn(modal, '_renderContent');
      spy.mockClear();
      modal._scheduleRefresh();
      jest.advanceTimersByTime(300);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _handleStreamChunk
  // =========================================================================

  describe('_handleStreamChunk', () => {
    it('returns early when modal is closed', async () => {
      ({ modal, endpoint } = createModal());
      modal.isOpen = false;
      modal._handleStreamChunk({ chunk: 'data' });
      // No error thrown
    });

    it('returns early when no chunk data', async () => {
      ({ modal, endpoint } = createModal());
      modal.isOpen = true;
      modal._handleStreamChunk({});
      // No error thrown
    });

    it('returns early when contextData is null', () => {
      ({ modal, endpoint } = createModal());
      modal.isOpen = true;
      modal.contextData = null;
      modal._handleStreamChunk({ chunk: 'data' });
      // No error thrown
    });

    it('updates token count and usage percentage', async () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({
        token_count: 100,
        token_limit: 1000,
        usage_percent: 10,
        messages: [makeMessage({ role: 'user' }), makeMessage({ role: 'assistant' })],
      }));
      await modal.open(); // Use open to trigger _renderContent and set isOpen
      modal._handleStreamChunk({ chunk: 'Hello world test data' }); // ~5 tokens estimated (20/4)
      expect(modal.contextData.token_count).toBeGreaterThan(100);
      expect(modal.contextData.usage_percent).toBeGreaterThan(10);
    });

    it('updates usage badge text in UI', async () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({
        token_count: 100,
        token_limit: 1000,
        usage_percent: 10,
        messages: [],
      }));
      await modal.open(); // Use open to trigger _renderContent and set isOpen
      modal._handleStreamChunk({ chunk: 'abc' }); // ~1 token
      const badge = modal.bodyEl.querySelector('.ctx-usage-badge');
      // Badge text should have been updated
      expect(badge.textContent).toContain('% Used');
    });
  });

  // =========================================================================
  // _setStreamingState / _updateLiveIndicator
  // =========================================================================

  describe('_setStreamingState / _updateLiveIndicator', () => {
    it('sets streaming flag', () => {
      ({ modal } = createModal());
      modal._setStreamingState(true);
      expect(modal._isStreaming).toBe(true);
      modal._setStreamingState(false);
      expect(modal._isStreaming).toBe(false);
    });

    it('coerces to boolean', () => {
      ({ modal } = createModal());
      modal._setStreamingState(1);
      expect(modal._isStreaming).toBe(true);
      modal._setStreamingState(0);
      expect(modal._isStreaming).toBe(false);
    });

    it('updates live indicator to "Live" when streaming', async () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open(); // This calls _renderContent and guarantees elements exist in DOM
      modal._setStreamingState(true);
      expect(modal._liveIndicatorEl.textContent).toContain('Live');
    });

    it('updates live indicator to "Idle" when not streaming', async () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      modal._setStreamingState(false);
      expect(modal._liveIndicatorEl.textContent).toContain('Idle');
    });

    it('is safe when _liveIndicatorEl is null', () => {
      ({ modal } = createModal());
      modal._liveIndicatorEl = null;
      expect(() => modal._updateLiveIndicator()).not.toThrow();
    });
  });

  // =========================================================================
  // _handleDelete
  // =========================================================================

  describe('_handleDelete', () => {
    it('logs error and returns when endpoint is null', async () => {
      ({ modal } = createModal({ endpoint: null }));
      await modal._handleDelete('msg-1');
      expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Cannot delete'));
    });

    it('logs error and returns when chatId is null', async () => {
      ({ modal, endpoint } = createModal({ chatId: null }));
      await modal._handleDelete('msg-1');
      expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Cannot delete'));
    });

    it('does nothing when user cancels confirmation', async () => {
      ({ modal, endpoint } = createModal());
      ConfirmDialog.confirm.mockResolvedValue(false);
      await modal._handleDelete('msg-1');
      expect(endpoint.deleteMessageGroup).not.toHaveBeenCalled();
    });

    it('deletes message group on confirmation', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      ConfirmDialog.confirm.mockResolvedValue(true);
      endpoint.deleteMessageGroup.mockResolvedValue({ deleted_messages: 2, deleted_artifacts: 1 });
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal._handleDelete('msg-1');
      expect(endpoint.deleteMessageGroup).toHaveBeenCalledWith('chat-1', 'msg-1');
    });

    it('emits MESSAGE_DELETED event after successful delete', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      ConfirmDialog.confirm.mockResolvedValue(true);
      endpoint.deleteMessageGroup.mockResolvedValue({ deleted_messages: 2, deleted_artifacts: 1 });
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal._handleDelete('msg-1');
      expect(eventBus.emit).toHaveBeenCalledWith('chat:message-deleted', expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'msg-1',
        deletedMessages: 2,
        deletedArtifacts: 1,
      }));
    });

    it('does not emit when eventBus is null', async () => {
      ({ modal, endpoint } = createModal({ eventBus: null }));
      ConfirmDialog.confirm.mockResolvedValue(true);
      endpoint.deleteMessageGroup.mockResolvedValue({ deleted_messages: 1, deleted_artifacts: 0 });
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal._handleDelete('msg-1');
      // No error thrown
    });

    it('shows info toast after successful delete', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      ConfirmDialog.confirm.mockResolvedValue(true);
      endpoint.deleteMessageGroup.mockResolvedValue({ deleted_messages: 3, deleted_artifacts: 2 });
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal._handleDelete('msg-1');
      expect(Toast.info).toHaveBeenCalledWith('Deleted 3 messages and 2 artifacts');
    });

    it('shows error toast on delete failure', async () => {
      ({ modal, endpoint } = createModal());
      ConfirmDialog.confirm.mockResolvedValue(true);
      endpoint.deleteMessageGroup.mockRejectedValue(new Error('delete failed'));
      await modal._handleDelete('msg-1');
      expect(Toast.error).toHaveBeenCalledWith('Failed to delete: delete failed');
    });

    it('shows "Unknown error" toast when error has no message', async () => {
      ({ modal, endpoint } = createModal());
      ConfirmDialog.confirm.mockResolvedValue(true);
      endpoint.deleteMessageGroup.mockRejectedValue({});
      await modal._handleDelete('msg-1');
      expect(Toast.error).toHaveBeenCalledWith('Failed to delete: Unknown error');
    });

    it('reloads content after successful delete', async () => {
      ({ modal, endpoint } = createModal());
      ConfirmDialog.confirm.mockResolvedValue(true);
      endpoint.deleteMessageGroup.mockResolvedValue({ deleted_messages: 1, deleted_artifacts: 0 });
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal._handleDelete('msg-1');
      // getContextMessages called twice: initial _renderContent + reload after delete
      expect(endpoint.getContextMessages).toHaveBeenCalled();
    });

    it('confirmation dialog shows correct text', async () => {
      ({ modal, endpoint } = createModal());
      ConfirmDialog.confirm.mockResolvedValue(false);
      await modal._handleDelete('msg-1');
      expect(ConfirmDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Delete message',
        confirmText: 'Delete',
        variant: 'danger',
      }));
    });
  });

  // =========================================================================
  // _trackListener / _clearListeners
  // =========================================================================

  describe('_trackListener / _clearListeners', () => {
    it('tracks and removes listeners', () => {
      ({ modal } = createModal());
      const el = document.createElement('button');
      const handler = jest.fn();
      modal._trackListener(el, 'click', handler);
      expect(modal._listeners.length).toBe(1);
      el.click();
      expect(handler).toHaveBeenCalled();
      modal._clearListeners();
      expect(modal._listeners).toEqual([]);
      handler.mockClear();
      el.click();
      expect(handler).not.toHaveBeenCalled();
    });

    it('no-ops for null element', () => {
      ({ modal } = createModal());
      modal._trackListener(null, 'click', jest.fn());
      expect(modal._listeners.length).toBe(0);
    });
  });

  // =========================================================================
  // _cleanup
  // =========================================================================

  describe('_cleanup', () => {
    it('clears all listeners', async () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({
        messages: [makeMessage({ role: 'system', content: 'prompt' })],
      }));
      await modal.open(); // Use open to trigger _renderContent and DOM attachment properly
      expect(modal._listeners.length).toBeGreaterThan(0);
      modal._cleanup();
      expect(modal._listeners).toEqual([]);
    });

    it('resets contextData and messages', async () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [makeMessage()] }));
      await modal._renderContent();
      modal._cleanup();
      expect(modal.contextData).toBeNull();
      expect(modal.messages).toEqual([]);
    });

    it('clears refresh timer', () => {
      ({ modal } = createModal());
      modal.isOpen = true;
      modal._scheduleRefresh();
      expect(modal._refreshTimer).not.toBeNull();
      modal._cleanup();
      expect(modal._refreshTimer).toBeNull();
    });

    it('resets streaming state', () => {
      ({ modal } = createModal());
      modal._isStreaming = true;
      modal._cleanup();
      expect(modal._isStreaming).toBe(false);
    });

    it('nulls live indicator reference', async () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open(); // Use open to trigger _renderContent and DOM attachment properly
      expect(modal._liveIndicatorEl).not.toBeNull();
      modal._cleanup();
      expect(modal._liveIndicatorEl).toBeNull();
    });

    it('calls subscription cleanup functions', async () => {
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      expect(modal._subscriptions.length).toBeGreaterThan(0);
      modal._cleanup();
      expect(modal._subscriptions).toEqual([]);
    });

    it('handles cleanup function errors gracefully', () => {
      ({ modal } = createModal());
      modal._subscriptions = [
        () => { throw new Error('cleanup fail'); },
        jest.fn(),
      ];
      expect(() => modal._cleanup()).not.toThrow();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to cleanup subscription'),
        expect.any(Error)
      );
    });
  });

  // =========================================================================
  // BaseModal integration
  // =========================================================================

  describe('BaseModal integration', () => {
    it('ESC key closes modal', async () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(modal.isOpen).toBe(false);
    });

    it('destroy removes overlay from DOM', async () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [] }));
      await modal.open();
      jest.advanceTimersByTime(0);
      const overlay = modal.overlay;
      modal.destroy();
      expect(overlay.parentNode).toBeNull();
    });

    it('close triggers _cleanup after animation', async () => {
      ({ modal, endpoint } = createModal());
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [makeMessage()] }));
      await modal.open();
      jest.advanceTimersByTime(0);
      modal.close();
      jest.advanceTimersByTime(300);
      expect(modal.contextData).toBeNull();
      expect(modal._listeners).toEqual([]);
    });
  });

  // =========================================================================
  // Full lifecycle
  // =========================================================================

  describe('full lifecycle', () => {
    it('open -> view context -> delete turn -> close works', async () => {
      const messages = [
        makeMessage({ role: 'system', is_system: true, content: 'System prompt' }),
        makeMessage({ id: 'u1', role: 'user', content: 'Hello' }),
        makeMessage({ id: 'a1', role: 'assistant', content: 'Hi' }),
      ];
      const data = makeContextData({ messages, message_count: 3 });
      ({ modal, endpoint, eventBus } = createModal());
      endpoint.getContextMessages.mockResolvedValue(data);
      await modal.open();
      expect(modal.isOpen).toBe(true);
      expect(modal.messages.length).toBe(3);

      // Verify UI
      const turns = modal.bodyEl.querySelectorAll('.ctx-turn');
      expect(turns.length).toBe(1);
      const accordions = modal.bodyEl.querySelectorAll('.ctx-accordion');
      expect(accordions.length).toBeGreaterThanOrEqual(2); // system prompt + global memories

      // Delete turn
      ConfirmDialog.confirm.mockResolvedValue(true);
      endpoint.deleteMessageGroup.mockResolvedValue({ deleted_messages: 2, deleted_artifacts: 0 });
      endpoint.getContextMessages.mockResolvedValue(makeContextData({ messages: [messages[0]], message_count: 1 }));
      await modal._handleDelete('u1');
      expect(Toast.info).toHaveBeenCalled();

      // Close
      jest.advanceTimersByTime(0);
      modal.close();
      jest.advanceTimersByTime(300);
      expect(modal.isOpen).toBe(false);
      expect(modal.contextData).toBeNull();
    });
  });
});
