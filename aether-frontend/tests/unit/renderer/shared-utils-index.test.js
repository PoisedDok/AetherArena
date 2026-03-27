'use strict';

/**
 * @jest-environment jsdom
 */

// Mock the heavy dependencies at boundary
jest.mock('../../../src/renderer/shared/utils/theme-manager', () => ({
  themeManager: { apply: jest.fn() },
  ThemeManager: class MockThemeManager {},
}));

jest.mock('../../../src/renderer/shared/utils/accessibility', () => ({
  accessibilityManager: { init: jest.fn() },
  AccessibilityManager: class MockAccessibilityManager {},
  KeyboardNavigationHelper: class MockKeyboardNavHelper {},
}));

describe('shared/utils barrel export', () => {
  it('exports all expected modules and assigns to window.AetherUtils', () => {
    const utils = require('../../../src/renderer/shared/utils/index');

    // Verify exports exist with correct shape
    expect(utils.themeManager).toBeDefined();
    expect(utils.ThemeManager).toBeDefined();
    expect(utils.accessibilityManager).toBeDefined();
    expect(utils.AccessibilityManager).toBeDefined();
    expect(utils.KeyboardNavigationHelper).toBeDefined();

    // Verify window assignment (jsdom branch — typeof window !== 'undefined')
    expect(window.AetherUtils).toBe(utils);
  });

  it('skips window assignment when window is absent', () => {
    // Cover the false branch of typeof window !== 'undefined'
    jest.resetModules();
    const origWindow = global.window;
    delete global.window;
    try {
      const utils = require('../../../src/renderer/shared/utils/index');
      expect(utils.themeManager).toBeDefined();
      // window.AetherUtils was NOT set because window didn't exist
    } finally {
      global.window = origWindow;
    }
  });
});
