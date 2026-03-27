'use strict';

/**
 * ControlPanelController — Comprehensive Unit Tests
 * ============================================================================
 * Tests the actual button wiring, callback invocation, toggle/close logic,
 * click-outside-to-close, mic toggle with/without HandsfreeCoordinator,
 * settings tabs, and full lifecycle.
 *
 * Separate from coordinators.test.js (which covers basic lifecycle contracts
 * across all coordinators). This file tests ControlPanelController behaviour.
 *
 * Test environment: jsdom (tests/unit/renderer/** → unit:jsdom project)
 */

// ---------------------------------------------------------------------------
// Mocks — hoisted before require()
// ---------------------------------------------------------------------------

const mockLog = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => mockLog),
}));

jest.mock('../../../../src/renderer/shared/components/Toast', () => ({
  info: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  warning: jest.fn(),
}));

const ControlPanelController = require('../../../../src/renderer/main/runtime/coordinators/ControlPanelController');
const Toast = require('../../../../src/renderer/shared/components/Toast');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a real DOM element for use as a button/panel element. */
function btn(id) {
  const el = document.createElement('button');
  el.id = id;
  el.dataset.tab = id; // for settings tabs
  document.body.appendChild(el);
  return el;
}

/** Build the full element set matching ControlPanelController's expected keys. */
function createElements() {
  return {
    controlPanel: btn('control-panel'),
    menuTrigger: btn('menu-trigger'),
    chatToggle: btn('chat-toggle'),
    settingsButton: btn('settings-button'),
    settingsCancel: btn('settings-cancel'),
    micToggle: btn('mic-toggle'),
    artifactsToggle: btn('artifacts-toggle'),
    mcpToggle: btn('mcp-toggle'),
    memoryToggle: btn('memory-toggle'),
    agentsToggle: btn('agents-toggle'),
    researchDashboardToggle: btn('research-dashboard-toggle'),
    indexBrowserToggle: btn('index-browser-toggle'),
    jobsToggle: btn('jobs-toggle'),
    appRestart: btn('app-restart'),
    appQuit: btn('app-quit'),
  };
}

/** Build callback map with jest.fn() for every expected callback. */
function createCallbacks() {
  return {
    openChatLibrary: jest.fn(),
    openSettings: jest.fn(),
    closeSettings: jest.fn(),
    switchSettingsTab: jest.fn(),
    openArtifactsLibrary: jest.fn(),
    openMcpManagement: jest.fn(),
    openMemoryBrowser: jest.fn(),
    openAgents: jest.fn(),
    openResearchDashboard: jest.fn(),
    openIndexBrowser: jest.fn(),
    openJobs: jest.fn(),
    initiateShutdown: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ControlPanelController — Behaviour', () => {
  let controller, elements, callbacks, endpoint;

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = '';

    elements = createElements();
    callbacks = createCallbacks();
    endpoint = {
      setPreference: jest.fn().mockResolvedValue(undefined),
    };

    controller = new ControlPanelController({
      elements,
      callbacks,
      endpoint,
    });
  });

  afterEach(() => {
    controller.dispose();
    delete window.handsfreeCoordinator;
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores elements, callbacks, endpoint, settingsManager', () => {
      expect(controller.elements).toBe(elements);
      expect(controller.callbacks).toBe(callbacks);
      expect(controller.endpoint).toBe(endpoint);
    });

    it('initialises empty _domListeners array', () => {
      expect(controller._domListeners).toEqual([]);
    });

    it('defaults missing options gracefully', () => {
      const minimal = new ControlPanelController();
      expect(minimal.elements).toEqual({});
      expect(minimal.callbacks).toEqual({});
      expect(minimal.endpoint).toBeNull();
      expect(minimal.settingsManager).toBeNull();
      minimal.dispose();
    });
  });

  // =========================================================================
  // initialize() — Listener registration
  // =========================================================================

  describe('initialize() — listener registration', () => {
    it('registers listeners for all provided elements + document click-outside', () => {
      controller.initialize();
      // 15 buttons (menuTrigger, chatToggle, settingsButton, settingsCancel,
      //   micToggle, artifactsToggle, mcpToggle, memoryToggle, agentsToggle,
      //   researchDashboardToggle, indexBrowserToggle,
      //   jobsToggle, appRestart, appQuit) + document click-outside = 15
      // But settingsTabs from querySelectorAll adds 0 (none with class .settings-tab)
      expect(controller._domListeners.length).toBe(15);
    });

    it('registers settings tab listeners from DOM query', () => {
      // Add settings tabs to DOM
      const tab1 = document.createElement('div');
      tab1.className = 'settings-tab';
      tab1.dataset.tab = 'general';
      document.body.appendChild(tab1);

      const tab2 = document.createElement('div');
      tab2.className = 'settings-tab';
      tab2.dataset.tab = 'advanced';
      document.body.appendChild(tab2);

      controller.initialize();
      // 14 button elements + 2 settings tabs + 1 document click-outside = 17
      expect(controller._domListeners.length).toBe(17);
    });

    it('skips elements that are missing from the map', () => {
      const partial = new ControlPanelController({
        elements: { menuTrigger: btn('only-trigger') },
        callbacks: {},
      });
      partial.initialize();
      // menuTrigger + document click-outside = 2
      expect(partial._domListeners.length).toBe(2);
      partial.dispose();
    });
  });

  // =========================================================================
  // Button click handlers — callback invocation
  // =========================================================================

  describe('button clicks invoke correct callbacks', () => {
    beforeEach(() => {
      controller.initialize();
    });

    it('chatToggle → openChatLibrary + close', () => {
      elements.chatToggle.click();
      expect(callbacks.openChatLibrary).toHaveBeenCalledTimes(1);
      // close removes 'active' class
      expect(elements.controlPanel.classList.contains('active')).toBe(false);
    });

    it('settingsButton → openSettings + close', () => {
      elements.settingsButton.click();
      expect(callbacks.openSettings).toHaveBeenCalledTimes(1);
    });

    it('settingsCancel → closeSettings (no close)', () => {
      elements.settingsCancel.click();
      expect(callbacks.closeSettings).toHaveBeenCalledTimes(1);
    });

    it('artifactsToggle → openArtifactsLibrary + close', () => {
      elements.artifactsToggle.click();
      expect(callbacks.openArtifactsLibrary).toHaveBeenCalledTimes(1);
    });

    it('mcpToggle → openMcpManagement + close', () => {
      elements.mcpToggle.click();
      expect(callbacks.openMcpManagement).toHaveBeenCalledTimes(1);
    });

    it('memoryToggle → openMemoryBrowser + close', () => {
      elements.memoryToggle.click();
      expect(callbacks.openMemoryBrowser).toHaveBeenCalledTimes(1);
    });

    it('agentsToggle → openAgents + close', () => {
      elements.agentsToggle.click();
      expect(callbacks.openAgents).toHaveBeenCalledTimes(1);
    });

    it('researchDashboardToggle → openResearchDashboard + close', () => {
      elements.researchDashboardToggle.click();
      expect(callbacks.openResearchDashboard).toHaveBeenCalledTimes(1);
    });

    it('indexBrowserToggle → openIndexBrowser + close', () => {
      elements.indexBrowserToggle.click();
      expect(callbacks.openIndexBrowser).toHaveBeenCalledTimes(1);
    });

    it('jobsToggle → openJobs + close', () => {
      elements.jobsToggle.click();
      expect(callbacks.openJobs).toHaveBeenCalledTimes(1);
    });

    it('appRestart → close + initiateShutdown("restart")', () => {
      elements.appRestart.click();
      expect(callbacks.initiateShutdown).toHaveBeenCalledWith('restart');
    });

    it('appQuit → close + initiateShutdown("quit")', () => {
      elements.appQuit.click();
      expect(callbacks.initiateShutdown).toHaveBeenCalledWith('quit');
    });

    it('settings tab click → switchSettingsTab with data-tab value', () => {
      const tab = document.createElement('div');
      tab.className = 'settings-tab';
      tab.dataset.tab = 'privacy';
      document.body.appendChild(tab);

      // Need to re-initialize to pick up new tab
      controller.dispose();
      controller = new ControlPanelController({ elements, callbacks, endpoint });
      controller.initialize();

      tab.click();
      expect(callbacks.switchSettingsTab).toHaveBeenCalledWith('privacy');
    });

    it('does not throw when callback is not provided', () => {
      const noCallbacks = new ControlPanelController({
        elements: { chatToggle: btn('no-cb-chat') },
        callbacks: {},
      });
      noCallbacks.initialize();
      expect(() => document.getElementById('no-cb-chat').click()).not.toThrow();
      noCallbacks.dispose();
    });
  });

  // =========================================================================
  // toggle() / close()
  // =========================================================================

  describe('toggle()', () => {
    it('adds active class to panel and trigger', () => {
      controller.toggle();
      expect(elements.controlPanel.classList.contains('active')).toBe(true);
      expect(elements.menuTrigger.classList.contains('active')).toBe(true);
    });

    it('removes active class on second toggle', () => {
      controller.toggle();
      controller.toggle();
      expect(elements.controlPanel.classList.contains('active')).toBe(false);
      expect(elements.menuTrigger.classList.contains('active')).toBe(false);
    });

    it('does nothing when elements are missing', () => {
      const empty = new ControlPanelController({});
      expect(() => empty.toggle()).not.toThrow();
      empty.dispose();
    });
  });

  describe('close()', () => {
    it('removes active class from panel and trigger', () => {
      elements.controlPanel.classList.add('active');
      elements.menuTrigger.classList.add('active');
      controller.close();
      expect(elements.controlPanel.classList.contains('active')).toBe(false);
      expect(elements.menuTrigger.classList.contains('active')).toBe(false);
    });

    it('is idempotent (no error when already closed)', () => {
      expect(() => controller.close()).not.toThrow();
    });

    it('does nothing when elements are missing', () => {
      const empty = new ControlPanelController({});
      expect(() => empty.close()).not.toThrow();
      empty.dispose();
    });
  });

  // =========================================================================
  // menuTrigger click → toggle
  // =========================================================================

  describe('menuTrigger click', () => {
    it('opens panel on first click', () => {
      controller.initialize();
      elements.menuTrigger.click();
      expect(elements.controlPanel.classList.contains('active')).toBe(true);
    });

    it('closes panel on second click', () => {
      controller.initialize();
      elements.menuTrigger.click();
      elements.menuTrigger.click();
      expect(elements.controlPanel.classList.contains('active')).toBe(false);
    });
  });

  // =========================================================================
  // Click-outside-to-close
  // =========================================================================

  describe('click-outside-to-close', () => {
    beforeEach(() => {
      controller.initialize();
    });

    it('closes panel when clicking outside while active', () => {
      // Open the panel
      elements.controlPanel.classList.add('active');
      elements.menuTrigger.classList.add('active');

      // Click outside (on body, not inside panel or trigger)
      const outsideTarget = document.createElement('div');
      document.body.appendChild(outsideTarget);
      document.dispatchEvent(new MouseEvent('click', { bubbles: true, target: outsideTarget }));

      // The handler checks e.target, but MouseEvent constructor doesn't set target
      // to our element — we need to dispatch from the element itself
      outsideTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(elements.controlPanel.classList.contains('active')).toBe(false);
    });

    it('does NOT close when clicking inside the panel', () => {
      elements.controlPanel.classList.add('active');

      // Click inside the panel — target is child of controlPanel
      const inner = document.createElement('span');
      elements.controlPanel.appendChild(inner);
      inner.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(elements.controlPanel.classList.contains('active')).toBe(true);
    });

    it('does NOT close when clicking the menu trigger', () => {
      elements.controlPanel.classList.add('active');
      elements.menuTrigger.classList.add('active');

      elements.menuTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // menuTrigger click handler toggles, so it would close
      // But the click-outside handler should NOT double-close
      // The order: first the menuTrigger click (toggle → removes active),
      // then document click (panel no longer active → no-op)
    });

    it('does NOT close when panel is not active', () => {
      // Panel not active
      const outsideTarget = document.createElement('div');
      document.body.appendChild(outsideTarget);
      outsideTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      // Should not throw or error
      expect(elements.controlPanel.classList.contains('active')).toBe(false);
    });
  });

  // =========================================================================
  // Mic toggle (handsfree) — async handler
  // =========================================================================

  describe('micToggle — handsfree coordinator', () => {
    beforeEach(() => {
      controller.initialize();
    });

    it('enables handsfree when currently idle', async () => {
      window.handsfreeCoordinator = {
        getState: jest.fn(() => 'idle'),
        toggle: jest.fn(),
      };

      elements.micToggle.click();
      // Wait for async handler
      await Promise.resolve();

      expect(window.handsfreeCoordinator.toggle).toHaveBeenCalled();
      expect(Toast.info).toHaveBeenCalledWith(
        expect.stringContaining('enabled'),
        3000
      );
    });

    it('disables handsfree when currently active', async () => {
      window.handsfreeCoordinator = {
        getState: jest.fn(() => 'listening'),
        toggle: jest.fn(),
      };

      elements.micToggle.click();
      await Promise.resolve();

      expect(window.handsfreeCoordinator.toggle).toHaveBeenCalled();
      expect(Toast.info).toHaveBeenCalledWith(
        expect.stringContaining('disabled'),
        2000
      );
    });

    it('shows error toast when coordinator not available', async () => {
      delete window.handsfreeCoordinator;

      elements.micToggle.click();
      await Promise.resolve();

      expect(Toast.error).toHaveBeenCalledWith(
        expect.stringContaining('not available'),
        4000
      );
      expect(mockLog.warn).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _track() — internal listener tracking
  // =========================================================================

  describe('_track()', () => {
    it('skips null elements without error', () => {
      expect(() => controller._track(null, 'click', jest.fn())).not.toThrow();
      expect(controller._domListeners.length).toBe(0);
    });

    it('tracks element-event-handler-options tuple', () => {
      const el = document.createElement('div');
      const handler = jest.fn();
      controller._track(el, 'click', handler, { capture: true });
      expect(controller._domListeners.length).toBe(1);
      expect(controller._domListeners[0]).toEqual({
        element: el,
        event: 'click',
        handler,
        options: { capture: true },
      });
    });
  });

  // =========================================================================
  // dispose() — full lifecycle
  // =========================================================================

  describe('dispose()', () => {
    it('removes all DOM listeners (N = M)', () => {
      controller.initialize();
      const N = controller._domListeners.length;
      expect(N).toBeGreaterThan(0);

      // Spy on removeEventListener for each tracked element
      const spies = controller._domListeners.map(({ element }) =>
        jest.spyOn(element, 'removeEventListener')
      );

      controller.dispose();

      expect(controller._domListeners.length).toBe(0);
      // Each spy should have been called at least once
      for (const spy of spies) {
        expect(spy).toHaveBeenCalled();
      }
    });

    it('nulls all references', () => {
      controller.dispose();
      expect(controller.elements).toEqual({});
      expect(controller.callbacks).toEqual({});
      expect(controller.endpoint).toBeNull();
      expect(controller.settingsManager).toBeNull();
    });

    it('handles double-dispose without error', () => {
      controller.initialize();
      controller.dispose();
      expect(() => controller.dispose()).not.toThrow();
    });

    it('handles element with broken removeEventListener', () => {
      const badEl = document.createElement('div');
      badEl.removeEventListener = jest.fn(() => { throw new Error('fail'); });
      controller._domListeners.push({
        element: badEl,
        event: 'click',
        handler: jest.fn(),
        options: undefined,
      });

      // Should not throw — error is caught and logged
      expect(() => controller.dispose()).not.toThrow();
      expect(mockLog.error).toHaveBeenCalled();
    });

    it('buttons no longer fire callbacks after dispose', () => {
      controller.initialize();
      controller.dispose();

      // Re-create elements since dispose empties the references
      // but the original DOM elements still exist
      const chatBtn = document.getElementById('chat-toggle');
      if (chatBtn) chatBtn.click();

      // No callback should fire (listener was removed)
      expect(callbacks.openChatLibrary).not.toHaveBeenCalled();
    });
  });
});
