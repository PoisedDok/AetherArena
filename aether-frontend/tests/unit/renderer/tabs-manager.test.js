'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: jest.fn(function () { return this; }),
  })),
}));

const { EventTypes } = require('../../../src/core/events/EventTypes');
const TabManager = require('../../../src/renderer/artifacts/modules/tabs/TabManager');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEventBus() {
  return {
    emit: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
  };
}

function createMockArtifactsWindow() {
  const tabsContainer = document.createElement('div');
  tabsContainer.className = 'tabs-container';
  document.body.appendChild(tabsContainer);

  const contentContainer = document.createElement('div');
  contentContainer.className = 'content-container';
  document.body.appendChild(contentContainer);

  return {
    getTabsContainer: jest.fn(() => tabsContainer),
    getContentContainer: jest.fn(() => contentContainer),
    _tabsContainer: tabsContainer,
    _contentContainer: contentContainer,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('TabManager', () => {
  let manager;
  let eventBus;
  let artifactsWindow;

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = '';

    // Re-establish logger mock (resetMocks clears implementations)
    const { createRendererLogger } = require('../../../src/renderer/shared/utils/logger');
    createRendererLogger.mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      child: jest.fn(function () { return this; }),
    });

    eventBus = createMockEventBus();
    artifactsWindow = createMockArtifactsWindow();
    manager = null;
  });

  afterEach(() => {
    if (manager) {
      try { manager.dispose(); } catch (_) { /* already disposed */ }
    }
  });

  function createManager(opts = {}) {
    manager = new TabManager({
      artifactsWindow,
      eventBus,
      ...opts,
    });
    return manager;
  }

  async function createAndInit(opts = {}) {
    const m = createManager(opts);
    await m.init();
    return m;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // constructor
  // ═══════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('throws if artifactsWindow is not provided', () => {
      expect(() => new TabManager({ eventBus }))
        .toThrow('[TabManager] ArtifactsWindow required');
    });

    it('throws if eventBus is not provided', () => {
      expect(() => new TabManager({ artifactsWindow }))
        .toThrow('[TabManager] EventBus required');
    });

    it('throws if both options are missing', () => {
      expect(() => new TabManager())
        .toThrow('[TabManager] ArtifactsWindow required');
    });

    it('throws if options is empty object', () => {
      expect(() => new TabManager({}))
        .toThrow('[TabManager] ArtifactsWindow required');
    });

    it('stores artifactsWindow reference', () => {
      const m = createManager();
      expect(m.artifactsWindow).toBe(artifactsWindow);
    });

    it('stores eventBus reference', () => {
      const m = createManager();
      expect(m.eventBus).toBe(eventBus);
    });

    it('initializes tabs as empty Map', () => {
      const m = createManager();
      expect(m.tabs).toBeInstanceOf(Map);
      expect(m.tabs.size).toBe(0);
    });

    it('sets default activeTab to "output"', () => {
      const m = createManager();
      expect(m.activeTab).toBe('output');
    });

    it('initializes empty _eventListeners array', () => {
      const m = createManager();
      expect(m._eventListeners).toEqual([]);
    });

    it('initializes empty _tabOrder array', () => {
      const m = createManager();
      expect(m._tabOrder).toEqual([]);
    });

    it('initializes null DOM containers', () => {
      const m = createManager();
      expect(m.tabsContainer).toBeNull();
      expect(m.contentContainer).toBeNull();
    });

    it('binds _handleTabClick and _handleTabKeydown', () => {
      const m = createManager();
      // Bound methods should be functions but not the prototype methods
      expect(typeof m._handleTabClick).toBe('function');
      expect(typeof m._handleTabKeydown).toBe('function');
      expect(m._handleTabClick).not.toBe(TabManager.prototype._handleTabClick);
      expect(m._handleTabKeydown).not.toBe(TabManager.prototype._handleTabKeydown);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // init
  // ═══════════════════════════════════════════════════════════════════════

  describe('init', () => {
    it('gets containers from artifactsWindow', async () => {
      await createAndInit();
      expect(artifactsWindow.getTabsContainer).toHaveBeenCalledTimes(1);
      expect(artifactsWindow.getContentContainer).toHaveBeenCalledTimes(1);
    });

    it('stores tabsContainer reference', async () => {
      const m = await createAndInit();
      expect(m.tabsContainer).toBe(artifactsWindow._tabsContainer);
    });

    it('stores contentContainer reference', async () => {
      const m = await createAndInit();
      expect(m.contentContainer).toBe(artifactsWindow._contentContainer);
    });

    it('creates 3 tabs (code, output, files)', async () => {
      const m = await createAndInit();
      expect(m.tabs.size).toBe(3);
      expect(m.tabs.has('code')).toBe(true);
      expect(m.tabs.has('output')).toBe(true);
      expect(m.tabs.has('files')).toBe(true);
    });

    it('creates tab buttons in the tabsContainer', async () => {
      await createAndInit();
      const buttons = artifactsWindow._tabsContainer.querySelectorAll('button.artifacts-tab');
      expect(buttons.length).toBe(3);
    });

    it('creates pane divs in the contentContainer', async () => {
      await createAndInit();
      const panes = artifactsWindow._contentContainer.querySelectorAll('div.artifacts-pane');
      expect(panes.length).toBe(3);
    });

    it('sets the default active tab to "output"', async () => {
      const m = await createAndInit();
      expect(m.activeTab).toBe('output');
    });

    it('emits UI.COMPONENT_READY event', async () => {
      await createAndInit();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.UI.COMPONENT_READY,
        expect.objectContaining({ component: 'TabManager' })
      );
    });

    it('emits ARTIFACTS.TAB_CHANGED for default tab', async () => {
      await createAndInit();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.ARTIFACTS.TAB_CHANGED,
        expect.objectContaining({ tab: 'output' })
      );
    });

    it('throws if tabsContainer is null', async () => {
      artifactsWindow.getTabsContainer.mockReturnValue(null);
      const m = createManager();
      await expect(m.init()).rejects.toThrow('[TabManager] Containers not found');
    });

    it('throws if contentContainer is null', async () => {
      artifactsWindow.getContentContainer.mockReturnValue(null);
      const m = createManager();
      await expect(m.init()).rejects.toThrow('[TabManager] Containers not found');
    });

    it('throws if both containers are null', async () => {
      artifactsWindow.getTabsContainer.mockReturnValue(null);
      artifactsWindow.getContentContainer.mockReturnValue(null);
      const m = createManager();
      await expect(m.init()).rejects.toThrow('[TabManager] Containers not found');
    });

    it('populates _tabOrder with [code, output, files]', async () => {
      const m = await createAndInit();
      expect(m._tabOrder).toEqual(['code', 'output', 'files']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Tab DOM structure
  // ═══════════════════════════════════════════════════════════════════════

  describe('tab DOM structure', () => {
    beforeEach(async () => {
      await createAndInit();
    });

    it('each tab button has correct class', () => {
      for (const [, { button }] of manager.tabs.entries()) {
        expect(button.className).toContain('artifacts-tab');
      }
    });

    it('each tab button has role="tab"', () => {
      for (const [, { button }] of manager.tabs.entries()) {
        expect(button.getAttribute('role')).toBe('tab');
      }
    });

    it('each tab button has correct data-tab attribute', () => {
      for (const [id, { button }] of manager.tabs.entries()) {
        expect(button.dataset.tab).toBe(id);
      }
    });

    it('each tab button has type="button"', () => {
      for (const [, { button }] of manager.tabs.entries()) {
        expect(button.type).toBe('button');
      }
    });

    it('each tab button has correct id', () => {
      for (const [id, { button }] of manager.tabs.entries()) {
        expect(button.id).toBe(`artifacts-tab-${id}`);
      }
    });

    it('each tab button has aria-controls pointing to pane', () => {
      for (const [id, { button }] of manager.tabs.entries()) {
        expect(button.getAttribute('aria-controls')).toBe(`artifacts-pane-${id}`);
      }
    });

    it('each tab button has a tab-label span', () => {
      const expectedLabels = { code: 'Code', output: 'Output', files: 'Files' };
      for (const [id, { button }] of manager.tabs.entries()) {
        const label = button.querySelector('.tab-label');
        expect(label).not.toBeNull();
        expect(label.textContent).toBe(expectedLabels[id]);
      }
    });

    it('each tab button has title attribute', () => {
      const expectedLabels = { code: 'Code', output: 'Output', files: 'Files' };
      for (const [id, { button }] of manager.tabs.entries()) {
        expect(button.title).toBe(expectedLabels[id]);
      }
    });

    it('each pane has role="tabpanel"', () => {
      for (const [, { pane }] of manager.tabs.entries()) {
        expect(pane.getAttribute('role')).toBe('tabpanel');
      }
    });

    it('each pane has correct id', () => {
      for (const [id, { pane }] of manager.tabs.entries()) {
        expect(pane.id).toBe(`artifacts-pane-${id}`);
      }
    });

    it('each pane has aria-labelledby pointing to button', () => {
      for (const [id, { pane }] of manager.tabs.entries()) {
        expect(pane.getAttribute('aria-labelledby')).toBe(`artifacts-tab-${id}`);
      }
    });

    it('each pane has tabindex="0"', () => {
      for (const [, { pane }] of manager.tabs.entries()) {
        expect(pane.getAttribute('tabindex')).toBe('0');
      }
    });

    it('each pane has correct data-tab attribute', () => {
      for (const [id, { pane }] of manager.tabs.entries()) {
        expect(pane.dataset.tab).toBe(id);
      }
    });

    it('code pane has code-specific class', () => {
      const { pane } = manager.tabs.get('code');
      expect(pane.className).toContain('artifacts-code-pane');
    });

    it('output pane has output-specific class', () => {
      const { pane } = manager.tabs.get('output');
      expect(pane.className).toContain('artifacts-output-pane');
    });

    it('files pane has files-specific class', () => {
      const { pane } = manager.tabs.get('files');
      expect(pane.className).toContain('artifacts-files-pane');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // setActiveTab
  // ═══════════════════════════════════════════════════════════════════════

  describe('setActiveTab', () => {
    beforeEach(async () => {
      await createAndInit();
      eventBus.emit.mockClear();
    });

    it('switches active tab to code', () => {
      manager.setActiveTab('code');
      expect(manager.activeTab).toBe('code');
    });

    it('switches active tab to files', () => {
      manager.setActiveTab('files');
      expect(manager.activeTab).toBe('files');
    });

    it('adds active class to selected button', () => {
      manager.setActiveTab('code');
      const { button } = manager.tabs.get('code');
      expect(button.classList.contains('active')).toBe(true);
    });

    it('removes active class from other buttons', () => {
      manager.setActiveTab('code');
      const { button: outputBtn } = manager.tabs.get('output');
      const { button: filesBtn } = manager.tabs.get('files');
      expect(outputBtn.classList.contains('active')).toBe(false);
      expect(filesBtn.classList.contains('active')).toBe(false);
    });

    it('adds active class to selected pane', () => {
      manager.setActiveTab('code');
      const { pane } = manager.tabs.get('code');
      expect(pane.classList.contains('active')).toBe(true);
    });

    it('removes active class from other panes', () => {
      manager.setActiveTab('code');
      const { pane: outputPane } = manager.tabs.get('output');
      const { pane: filesPane } = manager.tabs.get('files');
      expect(outputPane.classList.contains('active')).toBe(false);
      expect(filesPane.classList.contains('active')).toBe(false);
    });

    it('sets aria-selected="true" on active button', () => {
      manager.setActiveTab('code');
      const { button } = manager.tabs.get('code');
      expect(button.getAttribute('aria-selected')).toBe('true');
    });

    it('sets aria-selected="false" on inactive buttons', () => {
      manager.setActiveTab('code');
      const { button: outputBtn } = manager.tabs.get('output');
      const { button: filesBtn } = manager.tabs.get('files');
      expect(outputBtn.getAttribute('aria-selected')).toBe('false');
      expect(filesBtn.getAttribute('aria-selected')).toBe('false');
    });

    it('sets tabIndex=0 on active button', () => {
      manager.setActiveTab('code');
      const { button } = manager.tabs.get('code');
      expect(button.tabIndex).toBe(0);
    });

    it('sets tabIndex=-1 on inactive buttons', () => {
      manager.setActiveTab('code');
      const { button: outputBtn } = manager.tabs.get('output');
      const { button: filesBtn } = manager.tabs.get('files');
      expect(outputBtn.tabIndex).toBe(-1);
      expect(filesBtn.tabIndex).toBe(-1);
    });

    it('sets aria-hidden="false" on active pane', () => {
      manager.setActiveTab('code');
      const { pane } = manager.tabs.get('code');
      expect(pane.getAttribute('aria-hidden')).toBe('false');
    });

    it('sets aria-hidden="true" on inactive panes', () => {
      manager.setActiveTab('code');
      const { pane: outputPane } = manager.tabs.get('output');
      const { pane: filesPane } = manager.tabs.get('files');
      expect(outputPane.getAttribute('aria-hidden')).toBe('true');
      expect(filesPane.getAttribute('aria-hidden')).toBe('true');
    });

    it('emits TAB_CHANGED event with tab id', () => {
      manager.setActiveTab('code');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.ARTIFACTS.TAB_CHANGED,
        expect.objectContaining({ tab: 'code' })
      );
    });

    it('emits TAB_CHANGED with timestamp', () => {
      manager.setActiveTab('code');
      const call = eventBus.emit.mock.calls.find(
        c => c[0] === EventTypes.ARTIFACTS.TAB_CHANGED
      );
      expect(call[1]).toHaveProperty('timestamp');
      expect(typeof call[1].timestamp).toBe('number');
    });

    it('ignores invalid tab id (returns early)', () => {
      manager.setActiveTab('nonexistent');
      expect(manager.activeTab).toBe('output'); // unchanged
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('does not change other tab states on invalid id', () => {
      const { button } = manager.tabs.get('output');
      const wasActive = button.classList.contains('active');
      manager.setActiveTab('nonexistent');
      expect(button.classList.contains('active')).toBe(wasActive);
    });

    it('focuses button when focus option is true', () => {
      const { button } = manager.tabs.get('code');
      const focusSpy = jest.spyOn(button, 'focus');
      manager.setActiveTab('code', { focus: true });
      expect(focusSpy).toHaveBeenCalled();
    });

    it('does not focus button when focus option is false', () => {
      const { button } = manager.tabs.get('code');
      const focusSpy = jest.spyOn(button, 'focus');
      manager.setActiveTab('code', { focus: false });
      expect(focusSpy).not.toHaveBeenCalled();
    });

    it('does not focus button when focus option is omitted', () => {
      const { button } = manager.tabs.get('code');
      const focusSpy = jest.spyOn(button, 'focus');
      manager.setActiveTab('code');
      expect(focusSpy).not.toHaveBeenCalled();
    });

    it('handles switching same tab (idempotent)', () => {
      manager.setActiveTab('output');
      expect(manager.activeTab).toBe('output');
      const { button } = manager.tabs.get('output');
      expect(button.classList.contains('active')).toBe(true);
    });

    it('switches through all tabs in sequence', () => {
      const tabIds = ['code', 'output', 'files'];
      for (const id of tabIds) {
        manager.setActiveTab(id);
        expect(manager.activeTab).toBe(id);
        const { button, pane } = manager.tabs.get(id);
        expect(button.classList.contains('active')).toBe(true);
        expect(pane.classList.contains('active')).toBe(true);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // getActiveTab
  // ═══════════════════════════════════════════════════════════════════════

  describe('getActiveTab', () => {
    it('returns default tab before init', () => {
      const m = createManager();
      expect(m.getActiveTab()).toBe('output');
    });

    it('returns default tab after init', async () => {
      const m = await createAndInit();
      expect(m.getActiveTab()).toBe('output');
    });

    it('returns current tab after setActiveTab', async () => {
      const m = await createAndInit();
      m.setActiveTab('code');
      expect(m.getActiveTab()).toBe('code');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // getPane
  // ═══════════════════════════════════════════════════════════════════════

  describe('getPane', () => {
    beforeEach(async () => {
      await createAndInit();
    });

    it('returns pane element for code tab', () => {
      const pane = manager.getPane('code');
      expect(pane).toBeInstanceOf(HTMLElement);
      expect(pane.dataset.tab).toBe('code');
    });

    it('returns pane element for output tab', () => {
      const pane = manager.getPane('output');
      expect(pane).toBeInstanceOf(HTMLElement);
      expect(pane.dataset.tab).toBe('output');
    });

    it('returns pane element for files tab', () => {
      const pane = manager.getPane('files');
      expect(pane).toBeInstanceOf(HTMLElement);
      expect(pane.dataset.tab).toBe('files');
    });

    it('returns null for invalid tab id', () => {
      expect(manager.getPane('nonexistent')).toBeNull();
    });

    it('returns null for undefined tab id', () => {
      expect(manager.getPane(undefined)).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // getAllPanes
  // ═══════════════════════════════════════════════════════════════════════

  describe('getAllPanes', () => {
    beforeEach(async () => {
      await createAndInit();
    });

    it('returns a Map', () => {
      const panes = manager.getAllPanes();
      expect(panes).toBeInstanceOf(Map);
    });

    it('returns 3 panes', () => {
      const panes = manager.getAllPanes();
      expect(panes.size).toBe(3);
    });

    it('contains all tab ids as keys', () => {
      const panes = manager.getAllPanes();
      expect(panes.has('code')).toBe(true);
      expect(panes.has('output')).toBe(true);
      expect(panes.has('files')).toBe(true);
    });

    it('values are HTMLElement instances', () => {
      const panes = manager.getAllPanes();
      for (const [, pane] of panes.entries()) {
        expect(pane).toBeInstanceOf(HTMLElement);
      }
    });

    it('returns a new Map each call (not the internal reference)', () => {
      const panes1 = manager.getAllPanes();
      const panes2 = manager.getAllPanes();
      expect(panes1).not.toBe(panes2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // showTab / hideTab
  // ═══════════════════════════════════════════════════════════════════════

  describe('showTab', () => {
    beforeEach(async () => {
      await createAndInit();
    });

    it('makes a hidden tab visible', () => {
      manager.hideTab('code');
      manager.showTab('code');
      const { button } = manager.tabs.get('code');
      expect(button.style.display).toBe('');
    });

    it('does nothing for invalid tab id', () => {
      expect(() => manager.showTab('nonexistent')).not.toThrow();
    });

    it('does nothing for already-visible tab', () => {
      const { button } = manager.tabs.get('code');
      button.style.display = '';
      manager.showTab('code');
      expect(button.style.display).toBe('');
    });
  });

  describe('hideTab', () => {
    beforeEach(async () => {
      await createAndInit();
    });

    it('hides a tab button', () => {
      manager.hideTab('code');
      const { button } = manager.tabs.get('code');
      expect(button.style.display).toBe('none');
    });

    it('does nothing for invalid tab id', () => {
      expect(() => manager.hideTab('nonexistent')).not.toThrow();
    });

    it('switches to first visible tab if hiding active tab', () => {
      manager.setActiveTab('output');
      eventBus.emit.mockClear();
      manager.hideTab('output');
      // Default tab order is [code, output, files]; code is first visible
      expect(manager.activeTab).toBe('code');
    });

    it('does not switch tab if hiding non-active tab', () => {
      manager.setActiveTab('output');
      eventBus.emit.mockClear();
      manager.hideTab('code');
      expect(manager.activeTab).toBe('output');
    });

    it('switches to next available tab when first is also hidden', () => {
      manager.setActiveTab('output');
      manager.hideTab('code');
      eventBus.emit.mockClear();
      manager.hideTab('output');
      // code is hidden, output is hidden -> files should become active
      expect(manager.activeTab).toBe('files');
    });

    it('does not switch if all other tabs are hidden (no firstVisible)', () => {
      // Hide code and files first, then hide output (active)
      manager.hideTab('code');
      manager.hideTab('files');
      eventBus.emit.mockClear();
      // Now output is active and only visible. Hiding it:
      // No visible tab found, so setActiveTab not called, activeTab stays
      manager.hideTab('output');
      // The active tab stays 'output' since no firstVisible found
      expect(manager.activeTab).toBe('output');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // getState
  // ═══════════════════════════════════════════════════════════════════════

  describe('getState', () => {
    beforeEach(async () => {
      await createAndInit();
    });

    it('returns frozen object', () => {
      const state = manager.getState();
      expect(Object.isFrozen(state)).toBe(true);
    });

    it('returns activeTab', () => {
      const state = manager.getState();
      expect(state.activeTab).toBe('output');
    });

    it('returns all tab ids', () => {
      const state = manager.getState();
      expect(state.tabs).toEqual(['code', 'output', 'files']);
    });

    it('returns all tabs as visible by default', () => {
      const state = manager.getState();
      expect(state.visibleTabs).toEqual(['code', 'output', 'files']);
    });

    it('excludes hidden tabs from visibleTabs', () => {
      manager.hideTab('files');
      const state = manager.getState();
      expect(state.visibleTabs).toEqual(['code', 'output']);
    });

    it('reflects active tab change', () => {
      manager.setActiveTab('code');
      const state = manager.getState();
      expect(state.activeTab).toBe('code');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Tab click handling
  // ═══════════════════════════════════════════════════════════════════════

  describe('tab click handling', () => {
    beforeEach(async () => {
      await createAndInit();
      eventBus.emit.mockClear();
    });

    it('clicking a tab button activates that tab', () => {
      const { button } = manager.tabs.get('code');
      button.click();
      expect(manager.activeTab).toBe('code');
    });

    it('clicking already-active tab is idempotent', () => {
      const { button } = manager.tabs.get('output');
      button.click();
      expect(manager.activeTab).toBe('output');
    });

    it('clicking files tab activates files', () => {
      const { button } = manager.tabs.get('files');
      button.click();
      expect(manager.activeTab).toBe('files');
    });

    it('clicking emits TAB_CHANGED event', () => {
      const { button } = manager.tabs.get('code');
      button.click();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.ARTIFACTS.TAB_CHANGED,
        expect.objectContaining({ tab: 'code' })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Tab keyboard handling
  // ═══════════════════════════════════════════════════════════════════════

  describe('tab keyboard handling', () => {
    beforeEach(async () => {
      await createAndInit();
      eventBus.emit.mockClear();
    });

    function dispatchKeydown(button, key) {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      });
      button.dispatchEvent(event);
      return event;
    }

    describe('ArrowRight', () => {
      it('moves from code to output', () => {
        manager.setActiveTab('code', { focus: true });
        eventBus.emit.mockClear();
        const { button } = manager.tabs.get('code');
        dispatchKeydown(button, 'ArrowRight');
        expect(manager.activeTab).toBe('output');
      });

      it('moves from output to files', () => {
        manager.setActiveTab('output', { focus: true });
        eventBus.emit.mockClear();
        const { button } = manager.tabs.get('output');
        dispatchKeydown(button, 'ArrowRight');
        expect(manager.activeTab).toBe('files');
      });

      it('wraps from files to code', () => {
        manager.setActiveTab('files', { focus: true });
        eventBus.emit.mockClear();
        const { button } = manager.tabs.get('files');
        dispatchKeydown(button, 'ArrowRight');
        expect(manager.activeTab).toBe('code');
      });
    });

    describe('ArrowLeft', () => {
      it('moves from output to code', () => {
        manager.setActiveTab('output', { focus: true });
        eventBus.emit.mockClear();
        const { button } = manager.tabs.get('output');
        dispatchKeydown(button, 'ArrowLeft');
        expect(manager.activeTab).toBe('code');
      });

      it('moves from files to output', () => {
        manager.setActiveTab('files', { focus: true });
        eventBus.emit.mockClear();
        const { button } = manager.tabs.get('files');
        dispatchKeydown(button, 'ArrowLeft');
        expect(manager.activeTab).toBe('output');
      });

      it('wraps from code to files', () => {
        manager.setActiveTab('code', { focus: true });
        eventBus.emit.mockClear();
        const { button } = manager.tabs.get('code');
        dispatchKeydown(button, 'ArrowLeft');
        expect(manager.activeTab).toBe('files');
      });
    });

    describe('Home', () => {
      it('moves to first tab from any tab', () => {
        manager.setActiveTab('files', { focus: true });
        eventBus.emit.mockClear();
        const { button } = manager.tabs.get('files');
        dispatchKeydown(button, 'Home');
        expect(manager.activeTab).toBe('code');
      });

      it('stays on first tab if already there', () => {
        manager.setActiveTab('code', { focus: true });
        eventBus.emit.mockClear();
        const { button } = manager.tabs.get('code');
        dispatchKeydown(button, 'Home');
        expect(manager.activeTab).toBe('code');
      });
    });

    describe('End', () => {
      it('moves to last tab from any tab', () => {
        manager.setActiveTab('code', { focus: true });
        eventBus.emit.mockClear();
        const { button } = manager.tabs.get('code');
        dispatchKeydown(button, 'End');
        expect(manager.activeTab).toBe('files');
      });

      it('stays on last tab if already there', () => {
        manager.setActiveTab('files', { focus: true });
        eventBus.emit.mockClear();
        const { button } = manager.tabs.get('files');
        dispatchKeydown(button, 'End');
        expect(manager.activeTab).toBe('files');
      });
    });

    describe('Enter', () => {
      it('activates current tab with focus', () => {
        const { button } = manager.tabs.get('code');
        const focusSpy = jest.spyOn(button, 'focus');
        dispatchKeydown(button, 'Enter');
        expect(manager.activeTab).toBe('code');
        expect(focusSpy).toHaveBeenCalled();
      });
    });

    describe('Space', () => {
      it('activates current tab with focus', () => {
        const { button } = manager.tabs.get('files');
        const focusSpy = jest.spyOn(button, 'focus');
        dispatchKeydown(button, ' ');
        expect(manager.activeTab).toBe('files');
        expect(focusSpy).toHaveBeenCalled();
      });
    });

    describe('other keys', () => {
      it('does not change active tab for unhandled key', () => {
        manager.setActiveTab('output');
        eventBus.emit.mockClear();
        const { button } = manager.tabs.get('output');
        dispatchKeydown(button, 'Tab');
        // Tab key should not trigger any tab change
        expect(eventBus.emit).not.toHaveBeenCalledWith(
          EventTypes.ARTIFACTS.TAB_CHANGED,
          expect.anything()
        );
      });
    });

    describe('keydown on element without dataset.tab', () => {
      it('returns early without error', () => {
        // Create a button without dataset.tab and call _handleTabKeydown
        const fakeEvent = {
          currentTarget: {},
          key: 'ArrowRight',
          preventDefault: jest.fn(),
        };
        expect(() => manager._handleTabKeydown(fakeEvent)).not.toThrow();
        expect(fakeEvent.preventDefault).not.toHaveBeenCalled();
      });

      it('handles null currentTarget gracefully', () => {
        const fakeEvent = {
          currentTarget: null,
          key: 'ArrowRight',
          preventDefault: jest.fn(),
        };
        expect(() => manager._handleTabKeydown(fakeEvent)).not.toThrow();
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _focusRelativeTab edge cases
  // ═══════════════════════════════════════════════════════════════════════

  describe('_focusRelativeTab edge cases', () => {
    beforeEach(async () => {
      await createAndInit();
      eventBus.emit.mockClear();
    });

    it('returns early if _tabOrder is empty', () => {
      manager._tabOrder = [];
      expect(() => manager._focusRelativeTab(1, 'code')).not.toThrow();
    });

    it('returns early if originTab not in _tabOrder', () => {
      expect(() => manager._focusRelativeTab(1, 'nonexistent')).not.toThrow();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _focusEdgeTab edge cases
  // ═══════════════════════════════════════════════════════════════════════

  describe('_focusEdgeTab edge cases', () => {
    beforeEach(async () => {
      await createAndInit();
      eventBus.emit.mockClear();
    });

    it('returns early if _tabOrder is empty for first', () => {
      manager._tabOrder = [];
      expect(() => manager._focusEdgeTab('first')).not.toThrow();
    });

    it('returns early if _tabOrder is empty for last', () => {
      manager._tabOrder = [];
      expect(() => manager._focusEdgeTab('last')).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _getPaneClassName
  // ═══════════════════════════════════════════════════════════════════════

  describe('_getPaneClassName', () => {
    it('returns code pane class for "code"', () => {
      const m = createManager();
      expect(m._getPaneClassName('code')).toBe('artifacts-code-pane');
    });

    it('returns output pane class for "output"', () => {
      const m = createManager();
      expect(m._getPaneClassName('output')).toBe('artifacts-output-pane');
    });

    it('returns files pane class for "files"', () => {
      const m = createManager();
      expect(m._getPaneClassName('files')).toBe('artifacts-files-pane');
    });

    it('returns empty string for unknown id', () => {
      const m = createManager();
      expect(m._getPaneClassName('unknown')).toBe('');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // dispose
  // ═══════════════════════════════════════════════════════════════════════

  describe('dispose', () => {
    it('removes all event listeners', async () => {
      await createAndInit();
      // 3 tabs, each pushes 1 cleanup fn that removes both click + keydown
      expect(manager._eventListeners.length).toBe(3);
      manager.dispose();
      expect(manager._eventListeners).toEqual([]);
    });

    it('clears tabs Map', async () => {
      await createAndInit();
      expect(manager.tabs.size).toBe(3);
      manager.dispose();
      expect(manager.tabs.size).toBe(0);
    });

    it('nulls tabsContainer', async () => {
      await createAndInit();
      expect(manager.tabsContainer).not.toBeNull();
      manager.dispose();
      expect(manager.tabsContainer).toBeNull();
    });

    it('nulls contentContainer', async () => {
      await createAndInit();
      expect(manager.contentContainer).not.toBeNull();
      manager.dispose();
      expect(manager.contentContainer).toBeNull();
    });

    it('clicking tab after dispose does not emit events', async () => {
      await createAndInit();
      const { button } = manager.tabs.get('code');
      manager.dispose();
      eventBus.emit.mockClear();
      // Click still fires on the DOM node, but the handler was removed
      button.click();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('handles cleanup function that throws', async () => {
      await createAndInit();
      // Inject a failing cleanup
      manager._eventListeners.push(() => { throw new Error('cleanup fail'); });
      expect(() => manager.dispose()).not.toThrow();
      expect(manager._eventListeners).toEqual([]);
    });

    it('is safe to call dispose twice', async () => {
      await createAndInit();
      manager.dispose();
      expect(() => manager.dispose()).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Listener tracking (quantitative proof)
  // ═══════════════════════════════════════════════════════════════════════

  describe('listener tracking', () => {
    it('tracks 1 cleanup function per tab (each removes click + keydown)', async () => {
      await createAndInit();
      // 3 tabs, each pushes 1 cleanup fn that removes both listeners
      expect(manager._eventListeners.length).toBe(3);
    });

    it('every cleanup function is callable', async () => {
      await createAndInit();
      for (const cleanup of manager._eventListeners) {
        expect(typeof cleanup).toBe('function');
      }
    });

    it('N created = M cleaned after dispose', async () => {
      await createAndInit();
      const created = manager._eventListeners.length;
      expect(created).toBe(3); // 3 cleanup fns, each removes 2 DOM listeners
      manager.dispose();
      // All cleaned, array emptied
      expect(manager._eventListeners.length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // window.TabManager export
  // ═══════════════════════════════════════════════════════════════════════

  describe('window export', () => {
    it('exports TabManager to window if window is defined', () => {
      // In jsdom, window is always defined
      expect(window.TabManager).toBe(TabManager);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BUG TM-1 Regression: _isDisposed lifecycle flag
  // ═══════════════════════════════════════════════════════════════════════

  describe('BUG TM-1: _isDisposed lifecycle flag', () => {
    it('_isDisposed is false after construction', () => {
      const m = createManager();
      expect(m._isDisposed).toBe(false);
    });

    it('_isDisposed is true after dispose', async () => {
      const m = await createAndInit();
      m.dispose();
      expect(m._isDisposed).toBe(true);
    });

    it('double-dispose is idempotent and does not throw', async () => {
      const m = await createAndInit();
      m.dispose();
      expect(m._isDisposed).toBe(true);
      expect(() => m.dispose()).not.toThrow();
      expect(m._isDisposed).toBe(true);
    });

    it('setActiveTab is no-op after dispose', async () => {
      const m = await createAndInit();
      m.dispose();
      eventBus.emit.mockClear();
      // setActiveTab should return immediately — no emit, no crash
      m.setActiveTab('code');
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('showTab is no-op after dispose', async () => {
      const m = await createAndInit();
      m.dispose();
      // Should not throw even though tabs Map is cleared
      expect(() => m.showTab('code')).not.toThrow();
    });

    it('hideTab is no-op after dispose', async () => {
      const m = await createAndInit();
      m.dispose();
      expect(() => m.hideTab('output')).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BUG TM-2 Regression: State fully reset on dispose
  // ═══════════════════════════════════════════════════════════════════════

  describe('BUG TM-2: State fully reset on dispose', () => {
    it('activeTab is null after dispose', async () => {
      const m = await createAndInit();
      m.setActiveTab('code');
      expect(m.activeTab).toBe('code');
      m.dispose();
      expect(m.activeTab).toBeNull();
    });

    it('getActiveTab returns null after dispose', async () => {
      const m = await createAndInit();
      m.dispose();
      expect(m.getActiveTab()).toBeNull();
    });

    it('_tabOrder is empty after dispose', async () => {
      const m = await createAndInit();
      expect(m._tabOrder).toEqual(['code', 'output', 'files']);
      m.dispose();
      expect(m._tabOrder).toEqual([]);
    });

    it('artifactsWindow reference is released after dispose', async () => {
      const m = await createAndInit();
      expect(m.artifactsWindow).not.toBeNull();
      m.dispose();
      expect(m.artifactsWindow).toBeNull();
    });

    it('eventBus reference is released after dispose', async () => {
      const m = await createAndInit();
      expect(m.eventBus).not.toBeNull();
      m.dispose();
      expect(m.eventBus).toBeNull();
    });

    it('clears _scrollPositions Map', async () => {
      const m = await createAndInit();
      m._scrollPositions.set('code', 100);
      m.dispose();
      expect(m._scrollPositions.size).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Scroll Position Memory (BUG TM-5 & TM-6)
  // ═══════════════════════════════════════════════════════════════════════

  describe('scroll position memory', () => {
    let m;
    beforeEach(async () => {
      m = await createAndInit();
    });

    it('saves scroll position before switching tabs', () => {
      const { pane: outputPane } = m.tabs.get('output');
      const scrollable = document.createElement('div');
      scrollable.className = 'output-content';
      Object.defineProperty(scrollable, 'scrollTop', { value: 150, configurable: true });
      outputPane.appendChild(scrollable);

      m.setActiveTab('code');
      expect(m._scrollPositions.get('output')).toBe(150);
    });

    it('restores scroll position after switching tabs', (done) => {
      const { pane: codePane } = m.tabs.get('code');
      const scrollable = document.createElement('div');
      scrollable.className = 'code-content';
      codePane.appendChild(scrollable);

      m._scrollPositions.set('code', 250);
      
      // Spy on requestAnimationFrame to track when it's called
      const rafSpy = jest.spyOn(window, 'requestAnimationFrame');
      
      m.setActiveTab('code');
      
      expect(rafSpy).toHaveBeenCalled();
      
      // Wait for rAF to execute
      window.requestAnimationFrame(() => {
        expect(scrollable.scrollTop).toBe(250);
        done();
      });
    });

    it('_restoreScrollPosition guards against disposed state', (done) => {
      const { pane: codePane } = m.tabs.get('code');
      const scrollable = document.createElement('div');
      scrollable.className = 'code-content';
      codePane.appendChild(scrollable);

      m._scrollPositions.set('code', 250);
      
      m._restoreScrollPosition('code');
      m.dispose(); // Dispose immediately after calling restore
      
      window.requestAnimationFrame(() => {
        // scrollTop should NOT be set because m._isDisposed is true
        expect(scrollable.scrollTop).not.toBe(250);
        done();
      });
    });
  });
});
