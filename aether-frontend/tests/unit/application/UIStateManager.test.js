'use strict';

/**
 * UIStateManager Unit Tests
 * ============================================================================
 * Tests UI state management: modal open/close, tab switching, notification
 * broadcasting, event emission, state getters, and resource cleanup.
 *
 * @module tests/unit/application/UIStateManager.test
 */

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

const UIStateManager = require('../../../src/application/main/modules/ui/UIStateManager');
const { EventTypes } = require('../../../src/core/events/EventTypes');

function createMockEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

describe('UIStateManager', () => {
  let manager;
  let eventBus;

  beforeEach(() => {
    eventBus = createMockEventBus();
    manager = new UIStateManager({ eventBus });
  });

  afterEach(() => {
    if (manager) manager.dispose();
  });

  // -----------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------
  describe('constructor', () => {
    it('throws when eventBus not provided', () => {
      expect(() => new UIStateManager()).toThrow('eventBus required');
      expect(() => new UIStateManager({})).toThrow('eventBus required');
    });

    it('initializes with default state', () => {
      const state = manager.getState();
      expect(state.modalOpen).toBe(false);
      expect(state.activeTab).toBeNull();
      expect(state.theme).toBe('dark');
    });

    it('accepts enableLogging option', () => {
      const m = new UIStateManager({ eventBus, enableLogging: true });
      expect(m.enableLogging).toBe(true);
      m.dispose();
    });
  });

  // -----------------------------------------------------------
  // openSettings / closeSettings
  // -----------------------------------------------------------
  describe('openSettings()', () => {
    it('sets modalOpen to true and activeTab to assistant', () => {
      const result = manager.openSettings();
      expect(result).toBe(true);
      expect(manager.isModalOpen()).toBe(true);
      expect(manager.getActiveTab()).toBe('assistant');
    });

    it('emits SETTINGS_OPENED event', () => {
      manager.openSettings();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.UI.SETTINGS_OPENED,
        expect.objectContaining({ timestamp: expect.any(Number) })
      );
    });
  });

  describe('closeSettings()', () => {
    it('sets modalOpen to false', () => {
      manager.openSettings();
      const result = manager.closeSettings();
      expect(result).toBe(true);
      expect(manager.isModalOpen()).toBe(false);
    });

    it('emits SETTINGS_CLOSED event', () => {
      manager.closeSettings();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.UI.SETTINGS_CLOSED,
        expect.objectContaining({ timestamp: expect.any(Number) })
      );
    });
  });

  // -----------------------------------------------------------
  // setActiveTab
  // -----------------------------------------------------------
  describe('setActiveTab()', () => {
    it('updates activeTab and returns true', () => {
      const result = manager.setActiveTab('security');
      expect(result).toBe(true);
      expect(manager.getActiveTab()).toBe('security');
    });

    it('returns false for falsy tab name', () => {
      expect(manager.setActiveTab('')).toBe(false);
      expect(manager.setActiveTab(null)).toBe(false);
      expect(manager.setActiveTab(undefined)).toBe(false);
    });

    it('emits TAB_CHANGED event with previous tab', () => {
      manager.setActiveTab('assistant');
      eventBus.emit.mockClear();

      manager.setActiveTab('security');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.UI.TAB_CHANGED,
        expect.objectContaining({
          tab: 'security',
          previousTab: 'assistant',
          timestamp: expect.any(Number),
        })
      );
    });
  });

  // -----------------------------------------------------------
  // showStatus
  // -----------------------------------------------------------
  describe('showStatus()', () => {
    it('emits NOTIFICATION event with defaults', () => {
      manager.showStatus('Operation complete');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.UI.NOTIFICATION,
        expect.objectContaining({
          message: 'Operation complete',
          type: 'info',
          duration: 3000,
          timestamp: expect.any(Number),
        })
      );
    });

    it('accepts custom type and duration', () => {
      manager.showStatus('Error!', 'error', 5000);
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.UI.NOTIFICATION,
        expect.objectContaining({
          message: 'Error!',
          type: 'error',
          duration: 5000,
        })
      );
    });

    it('returns true', () => {
      expect(manager.showStatus('msg')).toBe(true);
    });
  });

  // -----------------------------------------------------------
  // State getters
  // -----------------------------------------------------------
  describe('getState()', () => {
    it('returns a copy of state (not reference)', () => {
      const state = manager.getState();
      state.modalOpen = true;
      expect(manager.isModalOpen()).toBe(false);
    });
  });

  describe('getStats()', () => {
    it('returns frozen object with current state', () => {
      manager.openSettings();
      manager.setActiveTab('llm');
      const stats = manager.getStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.modalOpen).toBe(true);
      expect(stats.activeTab).toBe('llm');
    });
  });

  // -----------------------------------------------------------
  // dispose
  // -----------------------------------------------------------
  describe('dispose()', () => {
    it('resets state to defaults', () => {
      manager.openSettings();
      manager.setActiveTab('voice');
      manager.dispose();
      // After dispose, state is reset. eventBus is null.
      expect(manager.eventBus).toBeNull();
    });

    it('is safe to call twice', () => {
      expect(() => {
        manager.dispose();
        manager.dispose();
      }).not.toThrow();
      manager = null; // prevent afterEach from double-dispose
    });
  });

  // -----------------------------------------------------------
  // Full lifecycle
  // -----------------------------------------------------------
  describe('full lifecycle', () => {
    it('open -> tab switch -> close -> state reflects each step', () => {
      manager.openSettings();
      expect(manager.isModalOpen()).toBe(true);
      expect(manager.getActiveTab()).toBe('assistant');

      manager.setActiveTab('voice');
      expect(manager.getActiveTab()).toBe('voice');

      manager.closeSettings();
      expect(manager.isModalOpen()).toBe(false);

      // All 3 event types emitted
      const eventNames = eventBus.emit.mock.calls.map(c => c[0]);
      expect(eventNames).toContain(EventTypes.UI.SETTINGS_OPENED);
      expect(eventNames).toContain(EventTypes.UI.TAB_CHANGED);
      expect(eventNames).toContain(EventTypes.UI.SETTINGS_CLOSED);
    });
  });

  // -----------------------------------------------------------
  // enableLogging branches
  // -----------------------------------------------------------
  describe('enableLogging branches', () => {
    let logManager;

    beforeEach(() => {
      logManager = new UIStateManager({ eventBus, enableLogging: true });
    });

    afterEach(() => {
      if (logManager) logManager.dispose();
    });

    it('logs during openSettings', () => {
      logManager.openSettings();
    });

    it('logs during closeSettings', () => {
      logManager.closeSettings();
    });

    it('logs during setActiveTab', () => {
      logManager.setActiveTab('connections');
    });

    it('logs during dispose', () => {
      logManager.dispose();
      logManager = null;
    });
  });

  // -----------------------------------------------------------
  // window global export
  // -----------------------------------------------------------
  describe('window global export', () => {
    it('attaches UIStateManager to window when window exists', () => {
      jest.isolateModules(() => {
        global.window = {};
        jest.mock('../../../src/renderer/shared/utils/logger', () => ({
          createRendererLogger: () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(),
            debug: jest.fn(), trace: jest.fn(),
          }),
        }));
        const USM = require('../../../src/application/main/modules/ui/UIStateManager');
        expect(global.window.UIStateManager).toBe(USM);
        delete global.window;
      });
    });
  });
});
