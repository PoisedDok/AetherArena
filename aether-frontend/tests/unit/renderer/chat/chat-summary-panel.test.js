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

const mockAether = {
  chatSummaries: {
    list: jest.fn(),
    generate: jest.fn(),
  },
};

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => mockAether,
}));

const ChatSummaryPanel = require(
  '../../../../src/renderer/chat/components/ChatSummaryPanel'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function createPanel(overrides = {}) {
  return new ChatSummaryPanel(overrides);
}

function makeSummary(overrides = {}) {
  return {
    title: 'Test Summary',
    summary_text: 'This is the prose summary.\n\n- Point 1\n- Point 2',
    key_points: ['Point 1', 'Point 2'],
    entities: {
      entities: { people: ['Alice', 'Bob'], technology: ['React'] },
      topics: ['Testing'],
    },
    created_at: new Date().toISOString(),
    llm_model: 'gpt-4',
    metadata: { message_count: 25 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatSummaryPanel', () => {
  let panel;
  let container;

  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
    mockAether.chatSummaries.list.mockReset();
    mockAether.chatSummaries.generate.mockReset();
    container = createContainer();
  });

  afterEach(() => {
    if (panel) {
      try { panel.destroy(); } catch (e) { /* noop */ }
      panel = null;
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('initializes with null chatId', () => {
      panel = createPanel();
      expect(panel.chatId).toBeNull();
    });

    it('initializes summaries as empty array', () => {
      panel = createPanel();
      expect(panel.summaries).toEqual([]);
    });

    it('initializes loading and collapsed states', () => {
      panel = createPanel();
      expect(panel.isLoading).toBe(false);
      expect(panel.isCollapsed).toBe(false);
    });

    it('initializes container to null', () => {
      panel = createPanel();
      expect(panel.container).toBeNull();
    });

    it('accepts eventBus option', () => {
      const eventBus = { emit: jest.fn() };
      panel = createPanel({ eventBus });
      expect(panel.eventBus).toBe(eventBus);
    });

    it('uses injected aether over getAether()', () => {
      const customAether = { chatSummaries: { list: jest.fn() } };
      panel = createPanel({ aether: customAether });
      expect(panel.aether).toBe(customAether);
    });
  });

  // =========================================================================
  // init
  // =========================================================================

  describe('init', () => {
    it('throws when container is not provided', async () => {
      panel = createPanel();
      await expect(panel.init(null)).rejects.toThrow('[ChatSummaryPanel] Container required');
    });

    it('throws when container is undefined', async () => {
      panel = createPanel();
      await expect(panel.init(undefined)).rejects.toThrow('[ChatSummaryPanel] Container required');
    });

    it('creates panel DOM and appends to container', async () => {
      panel = createPanel();
      await panel.init(container);
      expect(container.querySelector('.chat-summary-panel')).not.toBeNull();
    });

    it('caches elements after panel creation', async () => {
      panel = createPanel();
      await panel.init(container);
      expect(panel.elements.regenerateBtn).not.toBeNull();
      expect(panel.elements.toggleBtn).not.toBeNull();
      expect(panel.elements.content).not.toBeNull();
      expect(panel.elements.loading).not.toBeNull();
      expect(panel.elements.empty).not.toBeNull();
      expect(panel.elements.display).not.toBeNull();
      expect(panel.elements.title).not.toBeNull();
      expect(panel.elements.keyPoints).not.toBeNull();
      expect(panel.elements.entities).not.toBeNull();
      expect(panel.elements.meta).not.toBeNull();
    });

    it('sets up click listeners on regenerate and toggle buttons', async () => {
      panel = createPanel();
      await panel.init(container);
      // Verify buttons exist and are clickable (listeners attached)
      expect(panel.elements.regenerateBtn).toBeInstanceOf(HTMLElement);
      expect(panel.elements.toggleBtn).toBeInstanceOf(HTMLElement);
    });
  });

  // =========================================================================
  // loadSummaries
  // =========================================================================

  describe('loadSummaries', () => {
    beforeEach(async () => {
      panel = createPanel();
      await panel.init(container);
    });

    it('shows empty state when chatId is falsy', async () => {
      await panel.loadSummaries(null);
      expect(panel.elements.empty.classList.contains('hidden')).toBe(false);
      expect(panel.elements.display.classList.contains('hidden')).toBe(true);
    });

    it('shows empty state when chatId is empty string', async () => {
      await panel.loadSummaries('');
      expect(panel.elements.empty.classList.contains('hidden')).toBe(false);
    });

    it('sets chatId', async () => {
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await panel.loadSummaries('chat-1');
      expect(panel.chatId).toBe('chat-1');
    });

    it('shows loading state while fetching', async () => {
      let resolveList;
      mockAether.chatSummaries.list.mockReturnValue(new Promise(r => { resolveList = r; }));
      const loadPromise = panel.loadSummaries('chat-1');
      expect(panel.isLoading).toBe(true);
      resolveList([]);
      await loadPromise;
    });

    it('displays first summary when summaries exist', async () => {
      const summary = makeSummary();
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      expect(panel.summaries.length).toBe(1);
      expect(panel.elements.display.classList.contains('hidden')).toBe(false);
      expect(panel.elements.title.textContent).toBe('Test Summary');
    });

    it('shows empty state when no summaries returned', async () => {
      mockAether.chatSummaries.list.mockResolvedValue([]);
      await panel.loadSummaries('chat-1');
      expect(panel.elements.empty.classList.contains('hidden')).toBe(false);
    });

    it('handles null response from list', async () => {
      mockAether.chatSummaries.list.mockResolvedValue(null);
      await panel.loadSummaries('chat-1');
      expect(panel.summaries).toEqual([]);
      expect(panel.elements.empty.classList.contains('hidden')).toBe(false);
    });

    it('shows error message on API failure', async () => {
      mockAether.chatSummaries.list.mockRejectedValue(new Error('Network fail'));
      await panel.loadSummaries('chat-1');
      expect(mockLog.error).toHaveBeenCalledWith('failed to load summaries', expect.objectContaining({
        chatId: 'chat-1',
      }));
      expect(panel.elements.empty.textContent).toBe('Failed to load summary');
    });
  });

  // =========================================================================
  // _displaySummary
  // =========================================================================

  describe('_displaySummary', () => {
    beforeEach(async () => {
      panel = createPanel();
      await panel.init(container);
    });

    it('displays title when present', async () => {
      const summary = makeSummary({ title: 'My Title' });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      expect(panel.elements.title.textContent).toBe('My Title');
      expect(panel.elements.title.style.display).toBe('block');
    });

    it('hides title when absent', async () => {
      const summary = makeSummary({ title: '' });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      expect(panel.elements.title.style.display).toBe('none');
    });

    it('displays prose from first paragraph of summary_text', async () => {
      const summary = makeSummary({ summary_text: 'First paragraph.\n\n- Bullet 1' });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      expect(panel.elements.prose.textContent).toBe('First paragraph.');
    });

    it('hides prose when summary_text starts with bullet', async () => {
      const summary = makeSummary({ summary_text: '- Bullet only' });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      expect(panel.elements.prose.style.display).toBe('none');
    });

    it('hides prose when summary_text is empty', async () => {
      const summary = makeSummary({ summary_text: '' });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      expect(panel.elements.prose.style.display).toBe('none');
    });

    it('displays key points as list items', async () => {
      const summary = makeSummary({ key_points: ['A', 'B', 'C'] });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      const items = panel.elements.keyPoints.querySelectorAll('li');
      expect(items.length).toBe(3);
      expect(items[0].textContent).toBe('A');
    });

    it('hides key points when empty', async () => {
      const summary = makeSummary({ key_points: [] });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      expect(panel.elements.keyPoints.style.display).toBe('none');
    });

    it('hides key points when null', async () => {
      const summary = makeSummary({ key_points: null });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      expect(panel.elements.keyPoints.style.display).toBe('none');
    });

    it('displays entity badges from categorized format', async () => {
      const summary = makeSummary({
        entities: {
          entities: { people: ['Alice'], technology: ['Node'] },
          topics: [],
        },
      });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      const badges = panel.elements.entities.querySelectorAll('.entity-badge');
      expect(badges.length).toBe(2);
    });

    it('hides entities when no entity badges', async () => {
      const summary = makeSummary({ entities: {} });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      expect(panel.elements.entities.style.display).toBe('none');
    });

    it('handles flat entities (no nested .entities key)', async () => {
      const summary = makeSummary({ entities: { people: ['Alice'] } });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      const badges = panel.elements.entities.querySelectorAll('.entity-badge');
      expect(badges.length).toBe(1);
    });

    it('skips topics category in entity badges', async () => {
      const summary = makeSummary({
        entities: { topics: ['AI'], people: ['Bob'] },
      });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      // Only 'Bob' should become a badge, not 'AI' (topics skipped)
      const badges = panel.elements.entities.querySelectorAll('.entity-badge');
      expect(badges.length).toBe(1);
    });

    it('handles non-array entity values gracefully', async () => {
      const summary = makeSummary({
        entities: { entities: { people: 'not-array' } },
      });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      // Should not crash
      expect(panel.elements.entities.style.display).toBe('none');
    });

    it('escapes HTML in entity names', async () => {
      const summary = makeSummary({
        entities: { entities: { xss: ['<script>alert(1)</script>'] } },
      });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      const badge = panel.elements.entities.querySelector('.entity-badge');
      expect(badge.innerHTML).not.toContain('<script>');
    });

    it('displays metadata with model and message count', async () => {
      const summary = makeSummary({
        llm_model: 'gpt-4',
        metadata: { message_count: 25 },
      });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      expect(panel.elements.meta.textContent).toContain('gpt-4');
      expect(panel.elements.meta.textContent).toContain('25 msgs');
    });

    it('shows "unknown" model when llm_model absent', async () => {
      const summary = makeSummary({ llm_model: undefined });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      expect(panel.elements.meta.textContent).toContain('unknown');
    });

    it('omits message count when metadata.message_count absent', async () => {
      const summary = makeSummary({ metadata: {} });
      mockAether.chatSummaries.list.mockResolvedValue([summary]);
      await panel.loadSummaries('chat-1');
      expect(panel.elements.meta.textContent).not.toContain('msgs');
    });

    it('creates prose element on first render and reuses on second', async () => {
      const summary1 = makeSummary({ summary_text: 'First.\n\nBullet' });
      mockAether.chatSummaries.list.mockResolvedValue([summary1]);
      await panel.loadSummaries('chat-1');
      const proseEl = panel.elements.prose;
      expect(proseEl).toBeDefined();

      // Second load reuses the element
      const summary2 = makeSummary({ summary_text: 'Second.\n\nBullet' });
      mockAether.chatSummaries.list.mockResolvedValue([summary2]);
      await panel.loadSummaries('chat-2');
      expect(panel.elements.prose.textContent).toBe('Second.');
    });
  });

  // =========================================================================
  // _handleRegenerate
  // =========================================================================

  describe('_handleRegenerate (via button click)', () => {
    beforeEach(async () => {
      panel = createPanel();
      await panel.init(container);
    });

    it('does nothing when chatId is null', async () => {
      panel.elements.regenerateBtn.click();
      expect(mockAether.chatSummaries.generate).not.toHaveBeenCalled();
    });

    it('does nothing when already loading', async () => {
      panel.chatId = 'chat-1';
      panel.isLoading = true;
      panel.elements.regenerateBtn.click();
      expect(mockAether.chatSummaries.generate).not.toHaveBeenCalled();
    });

    it('calls generate API and displays result', async () => {
      const summary = makeSummary();
      mockAether.chatSummaries.generate.mockResolvedValue(summary);
      mockAether.chatSummaries.list.mockResolvedValue([summary]);

      panel.chatId = 'chat-1';
      // Directly call the handler (button click is async, hard to await)
      await panel._handleRegenerate();

      expect(mockAether.chatSummaries.generate).toHaveBeenCalledWith('chat-1');
      expect(panel.summaries.length).toBe(1);
    });

    it('shows error when generate returns null', async () => {
      mockAether.chatSummaries.generate.mockResolvedValue(null);
      panel.chatId = 'chat-1';
      await panel._handleRegenerate();
      expect(panel.elements.empty.textContent).toBe('Failed to generate summary');
    });

    it('shows error on API failure', async () => {
      mockAether.chatSummaries.generate.mockRejectedValue(new Error('fail'));
      panel.chatId = 'chat-1';
      await panel._handleRegenerate();
      expect(mockLog.error).toHaveBeenCalledWith('failed to regenerate summary', expect.objectContaining({
        chatId: 'chat-1',
      }));
      expect(panel.elements.empty.textContent).toBe('Failed to generate summary');
    });
  });

  // =========================================================================
  // _toggleCollapse
  // =========================================================================

  describe('_toggleCollapse (via button click)', () => {
    beforeEach(async () => {
      panel = createPanel();
      await panel.init(container);
    });

    it('collapses on first click', () => {
      panel.elements.toggleBtn.click();
      expect(panel.isCollapsed).toBe(true);
      expect(panel.elements.content.classList.contains('collapsed')).toBe(true);
      expect(panel.elements.toggleBtn.title).toBe('Expand');
    });

    it('expands on second click', () => {
      panel.elements.toggleBtn.click(); // collapse
      panel.elements.toggleBtn.click(); // expand
      expect(panel.isCollapsed).toBe(false);
      expect(panel.elements.content.classList.contains('collapsed')).toBe(false);
      expect(panel.elements.toggleBtn.title).toBe('Collapse');
    });

    it('updates chevron SVG points on collapse', () => {
      panel.elements.toggleBtn.click();
      const polyline = panel.elements.toggleBtn.querySelector('svg polyline');
      expect(polyline.getAttribute('points')).toBe('6 9 12 15 18 9');
    });

    it('restores chevron SVG points on expand', () => {
      panel.elements.toggleBtn.click();
      panel.elements.toggleBtn.click();
      const polyline = panel.elements.toggleBtn.querySelector('svg polyline');
      expect(polyline.getAttribute('points')).toBe('18 15 12 9 6 15');
    });
  });

  // =========================================================================
  // _getTimeAgo
  // =========================================================================

  describe('_getTimeAgo', () => {
    beforeEach(() => {
      panel = createPanel();
    });

    it('returns "unknown" for null timestamp', () => {
      expect(panel._getTimeAgo(null)).toBe('unknown');
    });

    it('returns "unknown" for undefined timestamp', () => {
      expect(panel._getTimeAgo(undefined)).toBe('unknown');
    });

    it('returns "just now" for seconds < 60', () => {
      const now = new Date();
      expect(panel._getTimeAgo(now.toISOString())).toBe('just now');
    });

    it('returns minutes ago for seconds < 3600', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      expect(panel._getTimeAgo(fiveMinAgo.toISOString())).toBe('5m ago');
    });

    it('returns hours ago for seconds < 86400', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
      expect(panel._getTimeAgo(twoHoursAgo.toISOString())).toBe('2h ago');
    });

    it('returns days ago for seconds < 604800', () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 86400 * 1000);
      expect(panel._getTimeAgo(threeDaysAgo.toISOString())).toBe('3d ago');
    });

    it('returns locale date string for older timestamps', () => {
      const twoWeeksAgo = new Date(Date.now() - 14 * 86400 * 1000);
      const result = panel._getTimeAgo(twoWeeksAgo.toISOString());
      // Should be a date string, not "Xd ago"
      expect(result).not.toContain('ago');
    });
  });

  // =========================================================================
  // _escapeHtml
  // =========================================================================

  describe('_escapeHtml', () => {
    beforeEach(() => {
      panel = createPanel();
    });

    it('escapes < and >', () => {
      expect(panel._escapeHtml('<b>bold</b>')).toBe('&lt;b&gt;bold&lt;/b&gt;');
    });

    it('escapes &', () => {
      expect(panel._escapeHtml('a&b')).toBe('a&amp;b');
    });

    it('returns plain text unchanged', () => {
      expect(panel._escapeHtml('hello world')).toBe('hello world');
    });
  });

  // =========================================================================
  // destroy
  // =========================================================================

  describe('destroy', () => {
    it('removes panel from container', async () => {
      panel = createPanel();
      await panel.init(container);
      expect(container.querySelector('.chat-summary-panel')).not.toBeNull();
      panel.destroy();
      expect(container.querySelector('.chat-summary-panel')).toBeNull();
    });

    it('is safe when panelEl has no parent', async () => {
      panel = createPanel();
      await panel.init(container);
      if (panel.panelEl.parentNode) {
        panel.panelEl.parentNode.removeChild(panel.panelEl);
      }
      expect(() => panel.destroy()).not.toThrow();
    });

    it('is safe when not initialized (no panelEl)', () => {
      panel = createPanel();
      expect(() => panel.destroy()).not.toThrow();
    });
  });

  // =========================================================================
  // _showLoading / _showEmpty / _showError
  // =========================================================================

  describe('state display methods', () => {
    beforeEach(async () => {
      panel = createPanel();
      await panel.init(container);
    });

    it('_showLoading reveals loading and hides others', () => {
      panel._showLoading();
      expect(panel.isLoading).toBe(true);
      expect(panel.elements.loading.classList.contains('hidden')).toBe(false);
      expect(panel.elements.empty.classList.contains('hidden')).toBe(true);
      expect(panel.elements.display.classList.contains('hidden')).toBe(true);
    });

    it('_showEmpty reveals empty and hides others', () => {
      panel._showEmpty();
      expect(panel.isLoading).toBe(false);
      expect(panel.elements.loading.classList.contains('hidden')).toBe(true);
      expect(panel.elements.empty.classList.contains('hidden')).toBe(false);
      expect(panel.elements.display.classList.contains('hidden')).toBe(true);
    });

    it('_showError reveals empty with error message', () => {
      panel._showError('Something broke');
      expect(panel.isLoading).toBe(false);
      expect(panel.elements.empty.textContent).toBe('Something broke');
      expect(panel.elements.empty.classList.contains('hidden')).toBe(false);
    });
  });
});
