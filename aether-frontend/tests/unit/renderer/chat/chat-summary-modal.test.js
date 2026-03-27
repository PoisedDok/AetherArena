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
  chatSummaries: {
    list: jest.fn(),
    generate: jest.fn(),
  },
};

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => mockAether,
}));

const ChatSummaryModal = require(
  '../../../../src/renderer/chat/modals/ChatSummaryModal'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createModal(overrides = {}) {
  return new ChatSummaryModal(overrides);
}

function makeSummary(overrides = {}) {
  return {
    title: 'Test Summary',
    summary_text: 'This is the prose.\n\n- Bullet point',
    key_points: ['Point A', 'Point B'],
    entities: {
      entities: { people: ['Alice'], technology: ['React'] },
      topics: ['Testing'],
    },
    created_at: new Date().toISOString(),
    summary_type: 'auto',
    metadata: { message_count: 25 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatSummaryModal', () => {
  let modal;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
    mockAether.chatSummaries.list.mockReset();
    mockAether.chatSummaries.generate.mockReset();
  });

  afterEach(() => {
    if (modal) {
      try { modal.destroy(); } catch (e) { /* noop */ }
      modal = null;
    }
    jest.useRealTimers();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('extends BaseModal with correct id and title', () => {
      modal = createModal();
      expect(modal.id).toBe('chat-summary-modal');
      expect(modal.title).toBe('Chat Summary');
    });

    it('sets panel id for scoped styling', () => {
      modal = createModal();
      expect(modal.panel.id).toBe('chat-summary-modal');
    });

    it('initializes chatId to null', () => {
      modal = createModal();
      expect(modal.chatId).toBeNull();
    });

    it('initializes summaries as empty array', () => {
      modal = createModal();
      expect(modal.summaries).toEqual([]);
    });

    it('initializes _listeners and _timers as empty arrays', () => {
      modal = createModal();
      expect(modal._listeners).toEqual([]);
      expect(modal._timers).toEqual([]);
    });

    it('uses injected aether over getAether()', () => {
      const customAether = { chatSummaries: { list: jest.fn() } };
      modal = createModal({ aether: customAether });
      expect(modal.aether).toBe(customAether);
    });
  });

  // =========================================================================
  // open
  // =========================================================================

  describe('open', () => {
    it('warns and returns when chatId is null', async () => {
      modal = createModal();
      await modal.open(null);
      expect(mockLog.warn).toHaveBeenCalledWith('No chatId provided');
      expect(modal.chatId).toBeNull();
    });

    it('warns and returns when chatId is empty', async () => {
      modal = createModal();
      await modal.open('');
      expect(mockLog.warn).toHaveBeenCalledWith('No chatId provided');
    });

    it('sets chatId and calls super.open()', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('chat-1');
      expect(modal.chatId).toBe('chat-1');
      expect(modal.isOpen).toBe(true);
    });

    it('renders content and loads summaries', async () => {
      modal = createModal();
      const summary = makeSummary();
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await modal.open('chat-1');
      expect(modal.summaries.length).toBe(1);
    });
  });

  // =========================================================================
  // _renderContent
  // =========================================================================

  describe('_renderContent', () => {
    it('creates header with title and close button', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('chat-1');

      const title = modal.headerEl.querySelector('.cm-section-title');
      expect(title.textContent).toBe('Chat Summary');
    });

    it('close button calls close()', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('chat-1');

      const closeBtn = modal.headerEl.querySelector('.cm-action-btn--close');
      const closeSpy = jest.spyOn(modal, 'close');
      closeBtn.click();
      expect(closeSpy).toHaveBeenCalled();
    });

    it('tracks close button listener', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('chat-1');
      expect(modal._listeners.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // _loadSummaries
  // =========================================================================

  describe('_loadSummaries', () => {
    it('displays summaries when array returned', async () => {
      modal = createModal();
      const summaries = [makeSummary()];
      mockAether.chatSummaries.list.mockResolvedValue(summaries);
      await modal.open('chat-1');

      expect(modal.bodyEl.querySelector('.csumm-card')).not.toBeNull();
    });

    it('shows empty state when no summaries', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('chat-1');

      expect(modal.bodyEl.innerHTML).toContain('No summary available');
    });

    it('handles null response', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue(null);
      await modal.open('chat-1');
      expect(modal.summaries).toEqual([]);
    });

    it('handles non-array response', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue('not-array');
      await modal.open('chat-1');
      expect(modal.summaries).toEqual([]);
    });

    it('shows error on API failure', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockRejectedValue(new Error('network'));
      await modal.open('chat-1');

      expect(mockLog.error).toHaveBeenCalledWith('failed to load summaries', expect.objectContaining({
        chatId: 'chat-1',
      }));
      expect(modal.bodyEl.innerHTML).toContain('Failed to load summary');
    });

    it('handles non-Error thrown value (string) via error?.message fallback', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockRejectedValue('string-error');
      await modal.open('chat-1');

      // error?.message is undefined for a string, so fallback to the string itself
      expect(mockLog.error).toHaveBeenCalledWith('failed to load summaries', expect.objectContaining({
        error: 'string-error',
        chatId: 'chat-1',
      }));
      expect(modal.bodyEl.innerHTML).toContain('Failed to load summary');
    });
  });

  // =========================================================================
  // _displaySummaries
  // =========================================================================

  describe('_displaySummaries', () => {
    it('displays title when present', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({ title: 'My Title' })]);
      await modal.open('chat-1');

      const title = modal.bodyEl.querySelector('.csumm-card-title');
      expect(title.textContent).toBe('My Title');
    });

    it('omits title element when title absent', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({ title: '' })]);
      await modal.open('chat-1');

      const title = modal.bodyEl.querySelector('.csumm-card-title');
      expect(title).toBeNull();
    });

    it('displays prose from first paragraph', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        summary_text: 'First paragraph.\n\n- Bullet',
      })]);
      await modal.open('chat-1');

      const prose = modal.bodyEl.querySelector('.csumm-card-prose');
      expect(prose.textContent).toBe('First paragraph.');
    });

    it('omits prose when summary_text starts with bullet', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        summary_text: '- Bullet only',
      })]);
      await modal.open('chat-1');

      const prose = modal.bodyEl.querySelector('.csumm-card-prose');
      expect(prose).toBeNull();
    });

    it('omits prose when summary_text is empty', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        summary_text: '',
      })]);
      await modal.open('chat-1');

      const prose = modal.bodyEl.querySelector('.csumm-card-prose');
      expect(prose).toBeNull();
    });

    it('displays key points as list', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        key_points: ['A', 'B', 'C'],
      })]);
      await modal.open('chat-1');

      const items = modal.bodyEl.querySelectorAll('.csumm-points-item');
      expect(items.length).toBe(3);
      expect(items[0].textContent).toBe('A');
    });

    it('omits key points when empty array', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        key_points: [],
      })]);
      await modal.open('chat-1');

      const title = modal.bodyEl.querySelector('.csumm-points-title');
      expect(title).toBeNull();
    });

    it('omits key points when null', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        key_points: null,
      })]);
      await modal.open('chat-1');

      const title = modal.bodyEl.querySelector('.csumm-points-title');
      expect(title).toBeNull();
    });

    it('displays entity badges from categorized format', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        entities: { entities: { people: ['Alice'], tech: ['React'] }, topics: [] },
      })]);
      await modal.open('chat-1');

      const badges = modal.bodyEl.querySelectorAll('.csumm-entity-badge');
      expect(badges.length).toBe(2);
    });

    it('skips topics category in entity badges', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        entities: { entities: { topics: ['AI'], people: ['Bob'] } },
      })]);
      await modal.open('chat-1');

      const badges = modal.bodyEl.querySelectorAll('.csumm-entity-badge');
      expect(badges.length).toBe(1);
    });

    it('handles non-array entity values', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        entities: { entities: { people: 'not-array' } },
      })]);
      await modal.open('chat-1');

      const badges = modal.bodyEl.querySelectorAll('.csumm-entity-badge');
      expect(badges.length).toBe(0);
    });

    it('escapes HTML in entity names', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        entities: { entities: { xss: ['<script>alert(1)</script>'] } },
      })]);
      await modal.open('chat-1');

      const badge = modal.bodyEl.querySelector('.csumm-entity-badge');
      expect(badge.innerHTML).not.toContain('<script>');
    });

    it('omits entities section when no badges', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        entities: {},
      })]);
      await modal.open('chat-1');

      const container = modal.bodyEl.querySelector('.csumm-badges-container');
      expect(container).toBeNull();
    });

    it('displays topics when present', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        entities: { topics: ['AI', 'Testing'] },
      })]);
      await modal.open('chat-1');

      const topicBadges = modal.bodyEl.querySelectorAll('.csumm-topic-badge');
      expect(topicBadges.length).toBe(2);
    });

    it('omits topics section when empty', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        entities: { topics: [] },
      })]);
      await modal.open('chat-1');

      const topicsContainer = modal.bodyEl.querySelector('.csumm-badges-container--topics');
      expect(topicsContainer).toBeNull();
    });

    it('displays metadata with date, type, and message count', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        summary_type: 'manual',
        metadata: { message_count: 30 },
      })]);
      await modal.open('chat-1');

      const meta = modal.bodyEl.querySelector('.csumm-meta');
      expect(meta.textContent).toContain('manual');
      expect(meta.textContent).toContain('30 msgs');
    });

    it('omits message count from metadata when absent', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        metadata: {},
      })]);
      await modal.open('chat-1');

      const meta = modal.bodyEl.querySelector('.csumm-meta');
      expect(meta.textContent).not.toContain('msgs');
    });

    it('defaults summary_type to "auto"', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        summary_type: undefined,
      })]);
      await modal.open('chat-1');

      const meta = modal.bodyEl.querySelector('.csumm-meta');
      expect(meta.textContent).toContain('auto');
    });

    it('creates regenerate button with tracked listener', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary()]);
      await modal.open('chat-1');

      // Action bar now has: Copy All, Export PDF, Regenerate (in that order)
      const btns = modal.bodyEl.querySelectorAll('.csumm-glass-btn');
      const regenBtn = [...btns].find(b => b.textContent === 'Regenerate');
      expect(regenBtn).not.toBeNull();
      expect(regenBtn.textContent).toBe('Regenerate');
    });

    it('displays multiple summaries as cards', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([
        makeSummary({ title: 'Summary 1' }),
        makeSummary({ title: 'Summary 2' }),
      ]);
      await modal.open('chat-1');

      const cards = modal.bodyEl.querySelectorAll('.csumm-card');
      expect(cards.length).toBe(2);
    });

    it('handles flat entities (no nested .entities key)', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        entities: { people: ['Alice'] },
      })]);
      await modal.open('chat-1');

      const badges = modal.bodyEl.querySelectorAll('.csumm-entity-badge');
      expect(badges.length).toBe(1);
    });

    it('handles undefined entities (uses {} fallback)', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        entities: undefined,
      })]);
      await modal.open('chat-1');

      // No entity badges rendered, no error
      const container = modal.bodyEl.querySelector('.csumm-badges-container');
      expect(container).toBeNull();
    });

    it('skips entity section when entities is an Array (not object)', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary({
        entities: { entities: ['plain', 'array'] },
      })]);
      await modal.open('chat-1');

      // Array.isArray check on line 156 should skip entity badge rendering
      const container = modal.bodyEl.querySelector('.csumm-badges-container');
      expect(container).toBeNull();
    });
  });

  // =========================================================================
  // _showEmptyState
  // =========================================================================

  describe('_showEmptyState', () => {
    it('renders empty state with generate button', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('chat-1');

      expect(modal.bodyEl.innerHTML).toContain('No summary available');
      const genBtn = modal.bodyEl.querySelector('.csumm-glass-btn--inline');
      expect(genBtn).not.toBeNull();
      expect(genBtn.textContent).toBe('Generate Summary');
    });

    it('generate button triggers _handleRegenerate', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('chat-1');

      const spy = jest.spyOn(modal, '_handleRegenerate');
      const genBtn = modal.bodyEl.querySelector('.csumm-glass-btn--inline');
      genBtn.click();
      expect(spy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _handleRegenerate
  // =========================================================================

  describe('_handleRegenerate', () => {
    // _handleRegenerate contains `await new Promise(resolve => setTimeout(resolve, 500))`
    // which requires proper async timer advancement with fake timers.

    it('calls generate API and reloads summaries', async () => {
      modal = createModal();
      const summary = makeSummary();
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('chat-1');

      mockAether.chatSummaries.generate.mockResolvedValue(summary);
      mockAether.chatSummaries.list.mockResolvedValue([summary]);

      // Start regenerate (will block on internal setTimeout)
      const regenPromise = modal._handleRegenerate();
      // Advance past the 500ms internal wait
      await jest.advanceTimersByTimeAsync(500);
      await regenPromise;

      expect(mockAether.chatSummaries.generate).toHaveBeenCalledWith('chat-1');
    });

    it('shows generating state while working', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('chat-1');

      mockAether.chatSummaries.generate.mockResolvedValue(null);
      mockAether.chatSummaries.list.mockResolvedValue([]);

      // Start regenerate without awaiting
      const regenPromise = modal._handleRegenerate();
      // Generating state should be visible immediately
      expect(modal.bodyEl.innerHTML).toContain('Generating summary');
      expect(modal.bodyEl.innerHTML).toContain('This may take a few seconds');

      // Resolve internal timers
      await jest.advanceTimersByTimeAsync(500);
      await regenPromise;
    });

    it('shows error on API failure', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('chat-1');

      mockAether.chatSummaries.generate.mockRejectedValue(new Error('fail'));

      // _handleRegenerate catches the error internally, so no need for 500ms advance
      await modal._handleRegenerate();

      expect(mockLog.error).toHaveBeenCalledWith('failed to regenerate summary', expect.objectContaining({
        chatId: 'chat-1',
      }));
      expect(modal.bodyEl.innerHTML).toContain('Failed to load summary');
    });
  });

  // =========================================================================
  // _trackListener / _trackTimer
  // =========================================================================

  describe('_trackListener', () => {
    it('tracks listener for cleanup', () => {
      modal = createModal();
      const el = document.createElement('button');
      const handler = jest.fn();
      modal._trackListener(el, 'click', handler);
      expect(modal._listeners.length).toBe(1);
      el.click();
      expect(handler).toHaveBeenCalled();
    });

    it('no-ops for null element', () => {
      modal = createModal();
      modal._trackListener(null, 'click', jest.fn());
      expect(modal._listeners.length).toBe(0);
    });
  });

  describe('_trackTimer', () => {
    it('tracks timer ID and returns it', () => {
      modal = createModal();
      const fn = jest.fn();
      const id = modal._trackTimer(fn, 1000);
      expect(typeof id).toBe('number');
      expect(modal._timers.length).toBe(1);
      expect(modal._timers[0]).toBe(id);
    });
  });

  // =========================================================================
  // _cleanup
  // =========================================================================

  describe('_cleanup', () => {
    it('removes all tracked listeners', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary()]);
      await modal.open('chat-1');

      expect(modal._listeners.length).toBeGreaterThan(0);
      modal._cleanup();
      expect(modal._listeners).toEqual([]);
    });

    it('clears all tracked timers', () => {
      modal = createModal();
      modal._trackTimer(jest.fn(), 1000);
      modal._trackTimer(jest.fn(), 2000);
      expect(modal._timers.length).toBe(2);

      modal._cleanup();
      expect(modal._timers).toEqual([]);
    });

    it('resets chatId and summaries', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary()]);
      await modal.open('chat-1');

      modal._cleanup();
      expect(modal.chatId).toBeNull();
      expect(modal.summaries).toEqual([]);
    });
  });

  // =========================================================================
  // _showError
  // =========================================================================

  describe('_showError', () => {
    it('renders error state', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockRejectedValue(new Error('fail'));
      await modal.open('chat-1');

      expect(modal.bodyEl.innerHTML).toContain('Failed to load summary');
    });
  });

  // =========================================================================
  // _escapeHtml
  // =========================================================================

  describe('_escapeHtml', () => {
    it('escapes HTML characters', () => {
      modal = createModal();
      expect(modal._escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
    });

    it('returns plain text unchanged', () => {
      modal = createModal();
      expect(modal._escapeHtml('hello')).toBe('hello');
    });
  });

  // =========================================================================
  // BaseModal integration
  // =========================================================================

  describe('BaseModal integration', () => {
    it('close() triggers _cleanup after 300ms', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([makeSummary()]);
      await modal.open('chat-1');

      // Flush rAF from open
      jest.advanceTimersByTime(0);

      modal.close();
      jest.advanceTimersByTime(300);
      expect(modal.chatId).toBeNull();
    });

    it('ESC key closes modal', async () => {
      modal = createModal();
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await modal.open('chat-1');

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(modal.isOpen).toBe(false);
    });
  });
});
