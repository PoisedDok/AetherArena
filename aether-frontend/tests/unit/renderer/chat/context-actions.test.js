'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const { ContextActions } = require(
  '../../../../src/renderer/chat/components/ContextActions'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function createEventBus() {
  return { on: jest.fn(), emit: jest.fn(), off: jest.fn() };
}

function createActions(overrides = {}) {
  const container = overrides.container || createContainer();
  const eventBus = overrides.eventBus || createEventBus();
  return {
    actions: new ContextActions({ container, eventBus, ...overrides }),
    container,
    eventBus,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContextActions', () => {
  let actions;
  let container;
  let eventBus;

  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
  });

  afterEach(() => {
    if (actions) {
      try { actions.destroy(); } catch (e) { /* noop */ }
      actions = null;
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
    eventBus = null;
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('throws when container is not provided', () => {
      expect(() => new ContextActions()).toThrow('[ContextActions] container required');
    });

    it('throws when container is null', () => {
      expect(() => new ContextActions({ container: null })).toThrow('[ContextActions] container required');
    });

    it('creates actions container in parent', () => {
      ({ actions, container, eventBus } = createActions());
      expect(container.querySelector('.context-actions')).not.toBeNull();
    });

    it('creates three action buttons', () => {
      ({ actions, container, eventBus } = createActions());
      const buttons = container.querySelectorAll('.context-action-btn');
      expect(buttons.length).toBe(3);
    });

    it('creates Summarize button with correct text and classes', () => {
      ({ actions, container, eventBus } = createActions());
      expect(actions.summarizeBtn.textContent).toBe('Summarize');
      expect(actions.summarizeBtn.classList.contains('context-action-btn-default')).toBe(true);
      expect(actions.summarizeBtn.title).toBe('Condense conversation context');
    });

    it('creates Export button with correct text', () => {
      ({ actions, container, eventBus } = createActions());
      expect(actions.exportBtn.textContent).toBe('Export');
      expect(actions.exportBtn.title).toBe('Export context for cross-chat use');
    });

    it('creates New Chat button with primary variant', () => {
      ({ actions, container, eventBus } = createActions());
      expect(actions.newChatBtn.textContent).toBe('New Chat');
      expect(actions.newChatBtn.classList.contains('context-action-btn-primary')).toBe(true);
    });

    it('sets aria-label on all buttons', () => {
      ({ actions, container, eventBus } = createActions());
      expect(actions.summarizeBtn.getAttribute('aria-label')).toBe('Condense conversation context');
      expect(actions.exportBtn.getAttribute('aria-label')).toBe('Export context for cross-chat use');
      expect(actions.newChatBtn.getAttribute('aria-label')).toBe('Start fresh conversation');
    });

    it('initializes currentChatId and currentStatus to null', () => {
      ({ actions, container, eventBus } = createActions());
      expect(actions.currentChatId).toBeNull();
      expect(actions.currentStatus).toBeNull();
    });

    it('logs debug when enableLogging is true', () => {
      ({ actions, container, eventBus } = createActions({ enableLogging: true }));
      expect(mockLog.debug).toHaveBeenCalledWith('[ContextActions] Initialized');
    });
  });

  // =========================================================================
  // update
  // =========================================================================

  describe('update', () => {
    beforeEach(() => {
      ({ actions, container, eventBus } = createActions());
    });

    it('hides actions when status is null', () => {
      actions.update('chat-1', null);
      expect(actions.actionsContainer.style.display).toBe('none');
    });

    it('stores chatId and status', () => {
      const status = { status: 'warning', message_count: 20 };
      actions.update('chat-1', status);
      expect(actions.currentChatId).toBe('chat-1');
      expect(actions.currentStatus).toBe(status);
    });

    it('hides actions for normal status', () => {
      actions.update('chat-1', { status: 'normal' });
      expect(actions.actionsContainer.style.display).toBe('none');
    });

    it('shows actions for warning status', () => {
      actions.update('chat-1', { status: 'warning', message_count: 20 });
      expect(actions.actionsContainer.style.display).toBe('flex');
    });

    it('shows actions for high status', () => {
      actions.update('chat-1', { status: 'high', message_count: 20 });
      expect(actions.actionsContainer.style.display).toBe('flex');
    });

    it('shows actions for critical status', () => {
      actions.update('chat-1', { status: 'critical', message_count: 20 });
      expect(actions.actionsContainer.style.display).toBe('flex');
    });

    it('shows New Chat button only for critical status', () => {
      actions.update('chat-1', { status: 'critical', message_count: 20 });
      expect(actions.newChatBtn.style.display).toBe('inline-block');
    });

    it('hides New Chat button for warning status', () => {
      actions.update('chat-1', { status: 'warning', message_count: 20 });
      expect(actions.newChatBtn.style.display).toBe('none');
    });

    it('hides New Chat button for high status', () => {
      actions.update('chat-1', { status: 'high', message_count: 20 });
      expect(actions.newChatBtn.style.display).toBe('none');
    });

    it('enables summarize when message_count > 10', () => {
      actions.update('chat-1', { status: 'warning', message_count: 11 });
      expect(actions.summarizeBtn.disabled).toBe(false);
    });

    it('disables summarize when message_count <= 10', () => {
      actions.update('chat-1', { status: 'warning', message_count: 10 });
      expect(actions.summarizeBtn.disabled).toBe(true);
    });

    it('reads messageCount (camelCase) as fallback', () => {
      actions.update('chat-1', { status: 'warning', messageCount: 15 });
      expect(actions.summarizeBtn.disabled).toBe(false);
    });

    it('defaults message count to 0 when absent', () => {
      actions.update('chat-1', { status: 'warning' });
      expect(actions.summarizeBtn.disabled).toBe(true);
    });

    it('defaults status to normal when not provided', () => {
      actions.update('chat-1', {});
      expect(actions.actionsContainer.style.display).toBe('none');
    });

    it('logs debug when enableLogging is true', () => {
      actions.destroy();
      ({ actions, container, eventBus } = createActions({ enableLogging: true }));
      mockLog.debug.mockClear();
      actions.update('chat-123', { status: 'warning', message_count: 20 });
      expect(mockLog.debug).toHaveBeenCalledWith(
        '[ContextActions] Updated:',
        { chatId: 'chat-123', statusLevel: 'warning' }
      );
    });

    it('truncates chatId to 8 chars in log', () => {
      actions.destroy();
      ({ actions, container, eventBus } = createActions({ enableLogging: true }));
      mockLog.debug.mockClear();
      actions.update('abcdefghijklmnop', { status: 'warning', message_count: 20 });
      expect(mockLog.debug).toHaveBeenCalledWith(
        '[ContextActions] Updated:',
        { chatId: 'abcdefgh', statusLevel: 'warning' }
      );
    });
  });

  // =========================================================================
  // Button click handlers
  // =========================================================================

  describe('_handleSummarize (via button click)', () => {
    beforeEach(() => {
      ({ actions, container, eventBus } = createActions());
    });

    it('emits context:action:summarize with chatId', () => {
      actions.update('chat-1', { status: 'warning', message_count: 20 });
      actions.summarizeBtn.click();
      expect(eventBus.emit).toHaveBeenCalledWith('context:action:summarize', expect.objectContaining({
        chatId: 'chat-1',
        timestamp: expect.any(Number),
      }));
    });

    it('does not emit when currentChatId is null', () => {
      actions.summarizeBtn.click();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('does not emit when eventBus is null', () => {
      actions.destroy();
      ({ actions, container } = createActions({ eventBus: null }));
      actions.update('chat-1', { status: 'warning', message_count: 20 });
      expect(() => actions.summarizeBtn.click()).not.toThrow();
    });

    it('logs when enableLogging is true', () => {
      actions.destroy();
      ({ actions, container, eventBus } = createActions({ enableLogging: true }));
      mockLog.debug.mockClear();
      actions.update('chat-1', { status: 'warning', message_count: 20 });
      mockLog.debug.mockClear();
      actions.summarizeBtn.click();
      expect(mockLog.debug).toHaveBeenCalledWith('[ContextActions] Summarize clicked');
    });
  });

  describe('_handleExport (via button click)', () => {
    beforeEach(() => {
      ({ actions, container, eventBus } = createActions());
    });

    it('emits context:action:export with chatId', () => {
      actions.update('chat-1', { status: 'warning', message_count: 20 });
      actions.exportBtn.click();
      expect(eventBus.emit).toHaveBeenCalledWith('context:action:export', expect.objectContaining({
        chatId: 'chat-1',
        timestamp: expect.any(Number),
      }));
    });

    it('does not emit when currentChatId is null', () => {
      actions.exportBtn.click();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('does not emit when eventBus is null', () => {
      actions.destroy();
      ({ actions, container } = createActions({ eventBus: null }));
      actions.update('chat-1', { status: 'warning', message_count: 20 });
      expect(() => actions.exportBtn.click()).not.toThrow();
    });

    it('logs when enableLogging is true', () => {
      actions.destroy();
      ({ actions, container, eventBus } = createActions({ enableLogging: true }));
      mockLog.debug.mockClear();
      actions.update('chat-1', { status: 'warning', message_count: 20 });
      mockLog.debug.mockClear();
      actions.exportBtn.click();
      expect(mockLog.debug).toHaveBeenCalledWith('[ContextActions] Export clicked');
    });
  });

  describe('_handleNewChat (via button click)', () => {
    beforeEach(() => {
      ({ actions, container, eventBus } = createActions());
    });

    it('emits context:action:new-chat', () => {
      actions.newChatBtn.click();
      expect(eventBus.emit).toHaveBeenCalledWith('context:action:new-chat', expect.objectContaining({
        timestamp: expect.any(Number),
      }));
    });

    it('does not emit when eventBus is null', () => {
      actions.destroy();
      ({ actions, container } = createActions({ eventBus: null }));
      expect(() => actions.newChatBtn.click()).not.toThrow();
    });

    it('logs when enableLogging is true', () => {
      actions.destroy();
      ({ actions, container, eventBus } = createActions({ enableLogging: true }));
      mockLog.debug.mockClear();
      actions.newChatBtn.click();
      expect(mockLog.debug).toHaveBeenCalledWith('[ContextActions] New chat clicked');
    });
  });

  // =========================================================================
  // hide / show
  // =========================================================================

  describe('hide', () => {
    it('sets display to none', () => {
      ({ actions, container, eventBus } = createActions());
      actions.hide();
      expect(actions.actionsContainer.style.display).toBe('none');
    });

    it('is safe when actionsContainer is null', () => {
      ({ actions, container, eventBus } = createActions());
      actions.actionsContainer = null;
      expect(() => actions.hide()).not.toThrow();
    });
  });

  describe('show', () => {
    it('sets display to flex', () => {
      ({ actions, container, eventBus } = createActions());
      actions.show();
      expect(actions.actionsContainer.style.display).toBe('flex');
    });

    it('is safe when actionsContainer is null', () => {
      ({ actions, container, eventBus } = createActions());
      actions.actionsContainer = null;
      expect(() => actions.show()).not.toThrow();
    });
  });

  // =========================================================================
  // destroy
  // =========================================================================

  describe('destroy', () => {
    it('removes actionsContainer from DOM', () => {
      ({ actions, container, eventBus } = createActions());
      expect(container.querySelector('.context-actions')).not.toBeNull();
      actions.destroy();
      expect(container.querySelector('.context-actions')).toBeNull();
    });

    it('nulls all DOM references', () => {
      ({ actions, container, eventBus } = createActions());
      actions.destroy();
      expect(actions.actionsContainer).toBeNull();
      expect(actions.summarizeBtn).toBeNull();
      expect(actions.exportBtn).toBeNull();
      expect(actions.newChatBtn).toBeNull();
    });

    it('is safe when actionsContainer has no parent', () => {
      ({ actions, container, eventBus } = createActions());
      if (actions.actionsContainer.parentNode) {
        actions.actionsContainer.parentNode.removeChild(actions.actionsContainer);
      }
      expect(() => actions.destroy()).not.toThrow();
    });

    it('logs when enableLogging is true', () => {
      ({ actions, container, eventBus } = createActions({ enableLogging: true }));
      mockLog.debug.mockClear();
      actions.destroy();
      expect(mockLog.debug).toHaveBeenCalledWith('[ContextActions] Destroyed');
    });
  });
});
