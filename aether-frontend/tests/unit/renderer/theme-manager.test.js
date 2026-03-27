'use strict';

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  })),
}));

// jsdom does not support window.matchMedia — mock before module load.
const mockMatchMediaResult = {
  matches: false,
  addEventListener: jest.fn(),
  addListener: jest.fn(),
  removeEventListener: jest.fn(),
  removeListener: jest.fn(),
};
window.matchMedia = jest.fn(() => mockMatchMediaResult);

const { ThemeManager, themeManager } = require('../../../src/renderer/shared/utils/theme-manager');

// ============================================================================
// ThemeManager
// ============================================================================
describe('ThemeManager', () => {
  let manager;

  beforeEach(() => {
    jest.clearAllMocks();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.remove('dark', 'light', 'theme-transitioning');
    mockMatchMediaResult.matches = false;
    // Re-assign addEventListener (may have been deleted in legacy test)
    mockMatchMediaResult.addEventListener = jest.fn();
    manager = new ThemeManager();
  });

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------
  describe('constructor', () => {
    it('detects light system preference when matches=false', () => {
      expect(manager.systemPreference).toBe('light');
    });

    it('detects dark system preference when matches=true', () => {
      mockMatchMediaResult.matches = true;
      const m = new ThemeManager();
      expect(m.systemPreference).toBe('dark');
    });

    it('defaults currentTheme to system preference', () => {
      expect(manager.currentTheme).toBe('light');
    });

    it('defaults preference to system', () => {
      expect(manager.preference).toBe('system');
    });

    it('initializes listeners as empty array', () => {
      expect(manager.listeners).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // init()
  // --------------------------------------------------------------------------
  describe('init()', () => {
    it('applies current theme to document', () => {
      manager.init();
      expect(document.documentElement.getAttribute('data-theme')).toBe(manager.currentTheme);
    });

    it('sets up matchMedia change listener via addEventListener', () => {
      manager.init();
      expect(mockMatchMediaResult.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    });

    it('falls back to addListener when addEventListener is not available', () => {
      const savedFn = mockMatchMediaResult.addEventListener;
      mockMatchMediaResult.addEventListener = undefined;

      manager.init();
      expect(mockMatchMediaResult.addListener).toHaveBeenCalledWith(expect.any(Function));

      mockMatchMediaResult.addEventListener = savedFn;
    });
  });

  // --------------------------------------------------------------------------
  // getTheme()
  // --------------------------------------------------------------------------
  describe('getTheme()', () => {
    it('returns current theme', () => {
      expect(manager.getTheme()).toBe(manager.currentTheme);
    });

    it('reflects setTheme changes', () => {
      manager.setTheme('dark');
      expect(manager.getTheme()).toBe('dark');
    });
  });

  // --------------------------------------------------------------------------
  // setTheme()
  // --------------------------------------------------------------------------
  describe('setTheme()', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('sets theme to dark', () => {
      manager.setTheme('dark');
      expect(manager.currentTheme).toBe('dark');
      expect(manager.preference).toBe('dark');
    });

    it('sets theme to light', () => {
      manager.setTheme('light');
      expect(manager.currentTheme).toBe('light');
      expect(manager.preference).toBe('light');
    });

    it('resolves system to detected preference', () => {
      mockMatchMediaResult.matches = true;
      const m = new ThemeManager();
      m.setTheme('system');
      expect(m.currentTheme).toBe('dark');
      expect(m.preference).toBe('system');
    });

    it('rejects invalid theme string', () => {
      const before = manager.currentTheme;
      manager.setTheme('pink');
      expect(manager.currentTheme).toBe(before);
    });

    it('applies dark theme classes to document', () => {
      manager.setTheme('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.classList.contains('light')).toBe(false);
    });

    it('applies light theme classes to document', () => {
      manager.setTheme('light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      expect(document.documentElement.classList.contains('light')).toBe(true);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('adds theme-transitioning class during transition', () => {
      manager.setTheme('dark');
      expect(document.documentElement.classList.contains('theme-transitioning')).toBe(true);

      jest.advanceTimersByTime(300);
      expect(document.documentElement.classList.contains('theme-transitioning')).toBe(false);
    });

    it('notifies listeners with resolved theme', () => {
      const listener = jest.fn();
      manager.onChange(listener);
      manager.setTheme('dark');
      expect(listener).toHaveBeenCalledWith('dark');
    });
  });

  // --------------------------------------------------------------------------
  // toggleTheme()
  // --------------------------------------------------------------------------
  describe('toggleTheme()', () => {
    it('toggles from light to dark', () => {
      manager.currentTheme = 'light';
      manager.toggleTheme();
      expect(manager.currentTheme).toBe('dark');
    });

    it('toggles from dark to light', () => {
      manager.currentTheme = 'dark';
      manager.toggleTheme();
      expect(manager.currentTheme).toBe('light');
    });
  });

  // --------------------------------------------------------------------------
  // isDarkMode() / isLightMode()
  // --------------------------------------------------------------------------
  describe('isDarkMode() / isLightMode()', () => {
    it('isDarkMode returns true when theme is dark', () => {
      manager.currentTheme = 'dark';
      expect(manager.isDarkMode()).toBe(true);
      expect(manager.isLightMode()).toBe(false);
    });

    it('isLightMode returns true when theme is light', () => {
      manager.currentTheme = 'light';
      expect(manager.isLightMode()).toBe(true);
      expect(manager.isDarkMode()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // onChange()
  // --------------------------------------------------------------------------
  describe('onChange()', () => {
    it('throws if callback is not a function', () => {
      expect(() => manager.onChange('not-a-fn'))
        .toThrow('[ThemeManager] onChange callback must be a function');
    });

    it('returns unsubscribe function', () => {
      const unsub = manager.onChange(jest.fn());
      expect(typeof unsub).toBe('function');
    });

    it('unsubscribe removes the listener', () => {
      const listener = jest.fn();
      const unsub = manager.onChange(listener);
      unsub();
      manager.setTheme('dark');
      expect(listener).not.toHaveBeenCalled();
    });

    it('double unsubscribe is safe', () => {
      const listener = jest.fn();
      const unsub = manager.onChange(listener);
      unsub();
      expect(() => unsub()).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // getStats()
  // --------------------------------------------------------------------------
  describe('getStats()', () => {
    it('returns frozen stats object with correct values', () => {
      manager.currentTheme = 'dark';
      manager.systemPreference = 'light';
      const stats = manager.getStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats).toEqual({
        currentTheme: 'dark',
        systemPreference: 'light',
        listenerCount: 0,
        isDarkMode: true,
        isLightMode: false,
      });
    });

    it('reflects listener count', () => {
      manager.onChange(jest.fn());
      manager.onChange(jest.fn());
      expect(manager.getStats().listenerCount).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // _handleSystemPreferenceChange()
  // --------------------------------------------------------------------------
  describe('_handleSystemPreferenceChange()', () => {
    it('updates systemPreference from event', () => {
      manager._handleSystemPreferenceChange({ matches: true });
      expect(manager.systemPreference).toBe('dark');

      manager._handleSystemPreferenceChange({ matches: false });
      expect(manager.systemPreference).toBe('light');
    });

    it('applies new theme when preference is system', () => {
      manager.preference = 'system';
      manager._handleSystemPreferenceChange({ matches: true });
      expect(manager.currentTheme).toBe('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('does NOT apply theme when preference is explicit', () => {
      manager.preference = 'light';
      const before = manager.currentTheme;
      manager._handleSystemPreferenceChange({ matches: true });
      expect(manager.systemPreference).toBe('dark');
      expect(manager.currentTheme).toBe(before);
    });

    it('notifies listeners when preference is system', () => {
      const listener = jest.fn();
      manager.onChange(listener);
      manager.preference = 'system';
      manager._handleSystemPreferenceChange({ matches: true });
      expect(listener).toHaveBeenCalledWith('dark');
    });
  });

  // --------------------------------------------------------------------------
  // _notifyListeners()
  // --------------------------------------------------------------------------
  describe('_notifyListeners()', () => {
    it('catches and logs errors from listeners without throwing', () => {
      manager.onChange(() => { throw new Error('boom'); });
      expect(() => manager._notifyListeners('dark')).not.toThrow();
      expect(manager.log.error).toHaveBeenCalled();
    });

    it('continues notifying remaining listeners after error', () => {
      const good1 = jest.fn();
      const bad = jest.fn(() => { throw new Error('fail'); });
      const good2 = jest.fn();
      manager.onChange(good1);
      manager.onChange(bad);
      manager.onChange(good2);

      manager._notifyListeners('dark');

      expect(good1).toHaveBeenCalledWith('dark');
      expect(bad).toHaveBeenCalledWith('dark');
      expect(good2).toHaveBeenCalledWith('dark');
    });
  });

  // --------------------------------------------------------------------------
  // Exports
  // --------------------------------------------------------------------------
  describe('exports', () => {
    it('singleton is instance of ThemeManager', () => {
      expect(themeManager).toBeInstanceOf(ThemeManager);
    });

    it('sets window.themeManager', () => {
      expect(window.themeManager).toBe(themeManager);
    });
  });
});
