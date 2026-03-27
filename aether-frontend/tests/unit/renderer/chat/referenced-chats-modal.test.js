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

const mockAether = {
  chatReferences: {
    list: jest.fn(),
    delete: jest.fn(),
  },
};

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => mockAether,
}));

const ReferencedChatsModal = require(
  '../../../../src/renderer/chat/modals/ReferencedChatsModal'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEventBus() {
  return { on: jest.fn(), emit: jest.fn(), off: jest.fn() };
}

function createModal(overrides = {}) {
  const eventBus = overrides.eventBus || createEventBus();
  const modal = new ReferencedChatsModal({ eventBus, ...overrides });
  return { modal, eventBus };
}

function makeRef(overrides = {}) {
  return {
    source_chat_id: 'src-chat-1',
    target_chat_id: 'tgt-chat-1',
    reference_type: 'context',
    metadata: { title: 'Test Chat' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReferencedChatsModal', () => {
  let modal;
  let eventBus;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
    mockAether.chatReferences.list.mockReset();
    mockAether.chatReferences.delete.mockReset();
  });

  afterEach(() => {
    if (modal) {
      try { modal.destroy(); } catch (e) { /* noop */ }
      modal = null;
    }
    eventBus = null;
    jest.useRealTimers();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('extends BaseModal with correct id and title', () => {
      ({ modal, eventBus } = createModal());
      expect(modal.id).toBe('referenced-chats-modal');
      expect(modal.title).toBe('Context Chats');
    });

    it('initializes chatId to null', () => {
      ({ modal, eventBus } = createModal());
      expect(modal.chatId).toBeNull();
    });

    it('initializes references as empty array', () => {
      ({ modal, eventBus } = createModal());
      expect(modal.references).toEqual([]);
    });

    it('initializes _listeners as empty array', () => {
      ({ modal, eventBus } = createModal());
      expect(modal._listeners).toEqual([]);
    });

    it('stores eventBus reference', () => {
      const eb = createEventBus();
      ({ modal } = createModal({ eventBus: eb }));
      expect(modal.eventBus).toBe(eb);
    });

    it('uses injected aether over getAether()', () => {
      const customAether = { chatReferences: { list: jest.fn() } };
      ({ modal } = createModal({ aether: customAether }));
      expect(modal.aether).toBe(customAether);
    });

    it('creates overlay in DOM (inherited from BaseModal)', () => {
      ({ modal, eventBus } = createModal());
      expect(document.getElementById('referenced-chats-modal-overlay')).not.toBeNull();
    });
  });

  // =========================================================================
  // open
  // =========================================================================

  describe('open', () => {
    beforeEach(() => {
      ({ modal, eventBus } = createModal());
    });

    it('warns and returns when chatId is null', async () => {
      await modal.open(null);
      expect(mockLog.warn).toHaveBeenCalledWith('No chatId provided');
      expect(modal.chatId).toBeNull();
    });

    it('warns and returns when chatId is undefined', async () => {
      await modal.open(undefined);
      expect(mockLog.warn).toHaveBeenCalledWith('No chatId provided');
    });

    it('warns and returns when chatId is empty string', async () => {
      await modal.open('');
      expect(mockLog.warn).toHaveBeenCalledWith('No chatId provided');
    });

    it('sets chatId and calls super.open()', async () => {
      mockAether.chatReferences.list.mockResolvedValue([]);
      await modal.open('chat-1');
      expect(modal.chatId).toBe('chat-1');
      expect(modal.isOpen).toBe(true);
    });

    it('renders skeleton loading state', async () => {
      mockAether.chatReferences.list.mockResolvedValue([]);
      await modal.open('chat-1');
      // _renderContent clears bodyEl and creates skeleton, then _loadReferences replaces
      // After load completes with empty, we should see empty state
      expect(modal.bodyEl.innerHTML).toContain('csumm-empty');
    });

    it('loads and displays references', async () => {
      const refs = [makeRef()];
      mockAether.chatReferences.list.mockResolvedValue(refs);
      await modal.open('chat-1');
      expect(modal.references).toEqual(refs);
      expect(modal.bodyEl.querySelector('.rcm-card')).not.toBeNull();
    });
  });

  // =========================================================================
  // _renderContent
  // =========================================================================

  describe('_renderContent', () => {
    it('creates header with title and close button', async () => {
      ({ modal, eventBus } = createModal());
      mockAether.chatReferences.list.mockResolvedValue([]);
      await modal.open('chat-1');

      const title = modal.headerEl.querySelector('.cm-section-title');
      expect(title.textContent).toBe('Context Chats');

      const closeBtn = modal.headerEl.querySelector('.cm-action-btn--close');
      expect(closeBtn).not.toBeNull();
    });

    it('close button in header tracks listener', async () => {
      ({ modal, eventBus } = createModal());
      mockAether.chatReferences.list.mockResolvedValue([]);
      await modal.open('chat-1');
      // At least 1 listener tracked (close button)
      expect(modal._listeners.length).toBeGreaterThanOrEqual(1);
    });

    it('close button calls close()', async () => {
      ({ modal, eventBus } = createModal());
      mockAether.chatReferences.list.mockResolvedValue([]);
      await modal.open('chat-1');

      const closeBtn = modal.headerEl.querySelector('.cm-action-btn--close');
      const closeSpy = jest.spyOn(modal, 'close');
      closeBtn.click();
      expect(closeSpy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _loadReferences
  // =========================================================================

  describe('_loadReferences', () => {
    beforeEach(() => {
      ({ modal, eventBus } = createModal());
    });

    it('displays references when array returned', async () => {
      const refs = [makeRef(), makeRef({ target_chat_id: 'tgt-2' })];
      mockAether.chatReferences.list.mockResolvedValue(refs);
      await modal.open('chat-1');

      const cards = modal.bodyEl.querySelectorAll('.rcm-card');
      expect(cards.length).toBe(2);
    });

    it('shows empty state when empty array returned', async () => {
      mockAether.chatReferences.list.mockResolvedValue([]);
      await modal.open('chat-1');
      expect(modal.bodyEl.innerHTML).toContain('No context chats attached');
    });

    it('shows empty state when non-array returned', async () => {
      mockAether.chatReferences.list.mockResolvedValue('not-array');
      await modal.open('chat-1');
      expect(modal.references).toEqual([]);
    });

    it('shows empty state when null returned', async () => {
      mockAether.chatReferences.list.mockResolvedValue(null);
      await modal.open('chat-1');
      expect(modal.references).toEqual([]);
    });

    it('shows empty state on API error', async () => {
      mockAether.chatReferences.list.mockRejectedValue(new Error('fail'));
      await modal.open('chat-1');
      expect(modal.bodyEl.innerHTML).toContain('No context chats attached');
    });
  });

  // =========================================================================
  // _displayReferences
  // =========================================================================

  describe('_displayReferences', () => {
    beforeEach(() => {
      ({ modal, eventBus } = createModal());
    });

    it('displays chat title from metadata', async () => {
      const ref = makeRef({ metadata: { title: 'My Chat' } });
      mockAether.chatReferences.list.mockResolvedValue([ref]);
      await modal.open('chat-1');

      const title = modal.bodyEl.querySelector('.rcm-chat-title');
      expect(title.textContent).toBe('My Chat');
    });

    it('falls back to target_chat_id when no metadata title', async () => {
      const ref = makeRef({ metadata: {}, target_chat_id: 'tgt-abc' });
      mockAether.chatReferences.list.mockResolvedValue([ref]);
      await modal.open('chat-1');

      const title = modal.bodyEl.querySelector('.rcm-chat-title');
      expect(title.textContent).toBe('tgt-abc');
    });

    it('falls back to target_chat_id when metadata is null', async () => {
      const ref = makeRef({ metadata: null, target_chat_id: 'tgt-abc' });
      mockAether.chatReferences.list.mockResolvedValue([ref]);
      await modal.open('chat-1');

      const title = modal.bodyEl.querySelector('.rcm-chat-title');
      expect(title.textContent).toBe('tgt-abc');
    });

    it('shows reference type in meta', async () => {
      const ref = makeRef({ reference_type: 'dependency' });
      mockAether.chatReferences.list.mockResolvedValue([ref]);
      await modal.open('chat-1');

      const meta = modal.bodyEl.querySelector('.rcm-chat-meta');
      expect(meta.textContent).toContain('dependency');
    });

    it('defaults reference type to "context"', async () => {
      const ref = makeRef({ reference_type: undefined });
      mockAether.chatReferences.list.mockResolvedValue([ref]);
      await modal.open('chat-1');

      const meta = modal.bodyEl.querySelector('.rcm-chat-meta');
      expect(meta.textContent).toContain('context');
    });

    it('creates unlink button with tracked listener', async () => {
      const ref = makeRef();
      mockAether.chatReferences.list.mockResolvedValue([ref]);
      await modal.open('chat-1');

      const unlinkBtn = modal.bodyEl.querySelector('.rcm-unlink-btn');
      expect(unlinkBtn).not.toBeNull();
      expect(unlinkBtn.getAttribute('aria-label')).toBe('Remove reference');
      // At least 2 listeners: close btn + unlink btn
      expect(modal._listeners.length).toBeGreaterThanOrEqual(2);
    });
  });

  // =========================================================================
  // _handleUnlink
  // =========================================================================

  describe('_handleUnlink', () => {
    beforeEach(() => {
      ({ modal, eventBus } = createModal());
    });

    it('calls delete API with correct IDs', async () => {
      const ref = makeRef();
      mockAether.chatReferences.list.mockResolvedValue([ref]);
      mockAether.chatReferences.delete.mockResolvedValue(undefined);
      await modal.open('chat-1');

      // After open, re-mock list to return empty (simulating deletion)
      mockAether.chatReferences.list.mockResolvedValue([]);
      await modal._handleUnlink(ref);

      expect(mockAether.chatReferences.delete).toHaveBeenCalledWith('src-chat-1', 'tgt-chat-1');
    });

    it('emits chat-reference:deleted event', async () => {
      const ref = makeRef();
      mockAether.chatReferences.list.mockResolvedValue([ref]);
      mockAether.chatReferences.delete.mockResolvedValue(undefined);
      await modal.open('chat-1');

      mockAether.chatReferences.list.mockResolvedValue([]);
      await modal._handleUnlink(ref);

      expect(eventBus.emit).toHaveBeenCalledWith('chat-reference:deleted', {
        sourceChatId: 'src-chat-1',
        targetChatId: 'tgt-chat-1',
      });
    });

    it('does not emit when eventBus is null', async () => {
      ({ modal } = createModal({ eventBus: null }));
      const ref = makeRef();
      mockAether.chatReferences.list.mockResolvedValue([ref]);
      mockAether.chatReferences.delete.mockResolvedValue(undefined);
      await modal.open('chat-1');

      mockAether.chatReferences.list.mockResolvedValue([]);
      await modal._handleUnlink(ref);
      // No error thrown
    });

    it('reloads references after successful delete', async () => {
      const ref = makeRef();
      mockAether.chatReferences.list.mockResolvedValue([ref]);
      mockAether.chatReferences.delete.mockResolvedValue(undefined);
      await modal.open('chat-1');

      // After delete, list returns empty
      mockAether.chatReferences.list.mockResolvedValue([]);
      await modal._handleUnlink(ref);

      // Should have called list twice: open + reload
      expect(mockAether.chatReferences.list).toHaveBeenCalledTimes(2);
    });

    it('logs error on delete failure', async () => {
      const ref = makeRef();
      mockAether.chatReferences.list.mockResolvedValue([ref]);
      mockAether.chatReferences.delete.mockRejectedValue(new Error('delete fail'));
      await modal.open('chat-1');

      await modal._handleUnlink(ref);
      expect(mockLog.error).toHaveBeenCalledWith('failed to delete reference', expect.objectContaining({ ref }));
    });

    it('unlink button triggers _handleUnlink', async () => {
      const ref = makeRef();
      mockAether.chatReferences.list.mockResolvedValue([ref]);
      mockAether.chatReferences.delete.mockResolvedValue(undefined);
      await modal.open('chat-1');

      const spy = jest.spyOn(modal, '_handleUnlink');
      mockAether.chatReferences.list.mockResolvedValue([]);
      const unlinkBtn = modal.bodyEl.querySelector('.rcm-unlink-btn');
      unlinkBtn.click();
      expect(spy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _trackListener
  // =========================================================================

  describe('_trackListener', () => {
    it('adds listener and tracks for cleanup', () => {
      ({ modal, eventBus } = createModal());
      const el = document.createElement('button');
      const handler = jest.fn();
      modal._trackListener(el, 'click', handler);
      expect(modal._listeners.length).toBe(1);
      el.click();
      expect(handler).toHaveBeenCalled();
    });

    it('no-ops when element is null', () => {
      ({ modal, eventBus } = createModal());
      modal._trackListener(null, 'click', jest.fn());
      expect(modal._listeners.length).toBe(0);
    });

    it('no-ops when element is undefined', () => {
      ({ modal, eventBus } = createModal());
      modal._trackListener(undefined, 'click', jest.fn());
      expect(modal._listeners.length).toBe(0);
    });
  });

  // =========================================================================
  // _cleanup
  // =========================================================================

  describe('_cleanup', () => {
    it('removes all tracked listeners', async () => {
      ({ modal, eventBus } = createModal());
      mockAether.chatReferences.list.mockResolvedValue([makeRef()]);
      await modal.open('chat-1');

      const listenerCountBefore = modal._listeners.length;
      expect(listenerCountBefore).toBeGreaterThan(0);

      modal._cleanup();
      expect(modal._listeners).toEqual([]);
    });

    it('resets chatId to null', async () => {
      ({ modal, eventBus } = createModal());
      mockAether.chatReferences.list.mockResolvedValue([]);
      await modal.open('chat-1');

      modal._cleanup();
      expect(modal.chatId).toBeNull();
    });

    it('resets references to empty array', async () => {
      ({ modal, eventBus } = createModal());
      mockAether.chatReferences.list.mockResolvedValue([makeRef()]);
      await modal.open('chat-1');

      modal._cleanup();
      expect(modal.references).toEqual([]);
    });

    it('is safe to call with already-removed elements', () => {
      ({ modal, eventBus } = createModal());
      const el = document.createElement('button');
      const handler = jest.fn();
      modal._trackListener(el, 'click', handler);

      // Remove element from DOM before cleanup
      el.remove();
      expect(() => modal._cleanup()).not.toThrow();
    });
  });

  // =========================================================================
  // _showEmptyState
  // =========================================================================

  describe('_showEmptyState', () => {
    it('renders empty state with icon and messages', async () => {
      ({ modal, eventBus } = createModal());
      mockAether.chatReferences.list.mockResolvedValue([]);
      await modal.open('chat-1');

      expect(modal.bodyEl.innerHTML).toContain('No context chats attached');
      expect(modal.bodyEl.innerHTML).toContain('Use the attach button');
    });
  });

  // =========================================================================
  // BaseModal integration
  // =========================================================================

  describe('BaseModal integration', () => {
    it('close() calls _cleanup via BaseModal setTimeout', async () => {
      ({ modal, eventBus } = createModal());
      mockAether.chatReferences.list.mockResolvedValue([makeRef()]);
      await modal.open('chat-1');

      // Flush the pending requestAnimationFrame from open() before closing
      jest.advanceTimersByTime(0);

      modal.close();
      // _cleanup is called inside setTimeout(300ms) in BaseModal.close()
      jest.advanceTimersByTime(300);
      expect(modal.chatId).toBeNull();
      expect(modal._listeners).toEqual([]);
    });

    it('destroy() calls close() and removes from DOM', async () => {
      ({ modal, eventBus } = createModal());
      mockAether.chatReferences.list.mockResolvedValue([]);
      await modal.open('chat-1');

      // Flush the pending requestAnimationFrame from open() before destroying
      jest.advanceTimersByTime(0);

      const overlay = modal.overlay;
      expect(overlay.parentNode).toBe(document.body);
      modal.destroy();
      expect(overlay.parentNode).toBeNull();
    });

    it('ESC key closes modal', async () => {
      ({ modal, eventBus } = createModal());
      mockAether.chatReferences.list.mockResolvedValue([]);
      await modal.open('chat-1');

      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(event);
      expect(modal.isOpen).toBe(false);
    });

    it('backdrop click closes modal', async () => {
      ({ modal, eventBus } = createModal());
      mockAether.chatReferences.list.mockResolvedValue([]);
      await modal.open('chat-1');

      // Click on overlay (not panel)
      const clickEvent = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(clickEvent, 'target', { value: modal.overlay });
      modal.overlay.dispatchEvent(clickEvent);
      expect(modal.isOpen).toBe(false);
    });
  });
});
