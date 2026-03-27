'use strict';

// ---------------------------------------------------------------------------
// Mock Electron screen API
// ---------------------------------------------------------------------------

const mockWorkArea = { x: 0, y: 0, width: 1920, height: 1080 };
const mockDisplay = {
  workArea: { ...mockWorkArea },
  scaleFactor: 2,
};
const mockSecondDisplay = {
  workArea: { x: 1920, y: 0, width: 1440, height: 900 },
  scaleFactor: 1,
};

jest.mock('electron', () => ({
  screen: {
    getDisplayMatching: jest.fn(() => mockDisplay),
    getAllDisplays: jest.fn(() => [mockDisplay]),
    getPrimaryDisplay: jest.fn(() => mockDisplay),
    getCursorScreenPoint: jest.fn(() => ({ x: 500, y: 300 })),
    getDisplayNearestPoint: jest.fn(() => mockDisplay),
  },
  app: { on: jest.fn(), getPath: jest.fn(() => '/tmp/test') },
  BrowserWindow: jest.fn(),
  ipcMain: { on: jest.fn(), handle: jest.fn(), removeHandler: jest.fn() },
  ipcRenderer: { send: jest.fn(), invoke: jest.fn(), on: jest.fn() },
}), { virtual: true });

jest.mock('../../../src/core/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  })),
}));

const { screen } = require('electron');
const {
  getDisplayForBounds,
  getAllDisplays,
  getPrimaryDisplay,
  getDisplayAtCursor,
  getCursorPosition,
  getWorkArea,
  calculateWidgetPosition,
  calculateCenteredPosition,
  calculateOffsetPosition,
  calculateOptimalPosition,
  ensureBoundsVisible,
  constrainToWorkArea,
  isWithinDisplay,
  getScaleFactor,
  toPhysicalPixels,
  toLogicalPixels,
} = require('../../../src/main/utils/display-utils');

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('display-utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mocks to default returns
    screen.getDisplayMatching.mockReturnValue(mockDisplay);
    screen.getAllDisplays.mockReturnValue([mockDisplay]);
    screen.getPrimaryDisplay.mockReturnValue(mockDisplay);
    screen.getCursorScreenPoint.mockReturnValue({ x: 500, y: 300 });
    screen.getDisplayNearestPoint.mockReturnValue(mockDisplay);
  });

  // =========================================================================
  // Display queries
  // =========================================================================

  describe('getDisplayForBounds()', () => {
    it('delegates to screen.getDisplayMatching', () => {
      const bounds = { x: 100, y: 100, width: 800, height: 600 };
      const result = getDisplayForBounds(bounds);
      expect(screen.getDisplayMatching).toHaveBeenCalledWith(bounds);
      expect(result).toBe(mockDisplay);
    });
  });

  describe('getAllDisplays()', () => {
    it('delegates to screen.getAllDisplays', () => {
      const result = getAllDisplays();
      expect(screen.getAllDisplays).toHaveBeenCalled();
      expect(result).toEqual([mockDisplay]);
    });
  });

  describe('getPrimaryDisplay()', () => {
    it('delegates to screen.getPrimaryDisplay', () => {
      const result = getPrimaryDisplay();
      expect(screen.getPrimaryDisplay).toHaveBeenCalled();
      expect(result).toBe(mockDisplay);
    });
  });

  describe('getCursorPosition()', () => {
    it('returns cursor screen point', () => {
      const result = getCursorPosition();
      expect(screen.getCursorScreenPoint).toHaveBeenCalled();
      expect(result).toEqual({ x: 500, y: 300 });
    });

    it('returns fallback {x:0,y:0} on error', () => {
      screen.getCursorScreenPoint.mockImplementation(() => { throw new Error('fail'); });
      const result = getCursorPosition();
      expect(result).toEqual({ x: 0, y: 0 });
    });
  });

  describe('getDisplayAtCursor()', () => {
    it('returns display nearest to cursor', () => {
      const result = getDisplayAtCursor();
      expect(screen.getCursorScreenPoint).toHaveBeenCalled();
      expect(screen.getDisplayNearestPoint).toHaveBeenCalledWith({ x: 500, y: 300 });
      expect(result).toBe(mockDisplay);
    });

    it('returns primary display on error', () => {
      screen.getCursorScreenPoint.mockImplementation(() => { throw new Error('fail'); });
      screen.getDisplayNearestPoint.mockImplementation(() => { throw new Error('fail'); });
      const result = getDisplayAtCursor();
      expect(result).toBe(mockDisplay);
    });
  });

  describe('getWorkArea()', () => {
    it('returns work area of primary display by default', () => {
      const result = getWorkArea();
      expect(result).toEqual(mockWorkArea);
    });

    it('returns work area of provided display', () => {
      const result = getWorkArea(mockSecondDisplay);
      expect(result).toEqual(mockSecondDisplay.workArea);
    });

    it('returns fallback on error', () => {
      screen.getPrimaryDisplay.mockImplementation(() => { throw new Error('fail'); });
      const result = getWorkArea();
      expect(result).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    });
  });

  // =========================================================================
  // Position calculations
  // =========================================================================

  describe('calculateWidgetPosition()', () => {
    it('positions widget in bottom-right with margin', () => {
      const result = calculateWidgetPosition({ x: 0, y: 0, width: 800, height: 600 }, 100);
      expect(result.x).toBe(1920 - 100 - 24);  // workArea.width - widgetSize - margin
      expect(result.y).toBe(1080 - 100 - 24);  // workArea.height - widgetSize - margin
      expect(result.width).toBe(100);
      expect(result.height).toBe(100);
    });

    it('respects custom margin', () => {
      const result = calculateWidgetPosition({ x: 0, y: 0, width: 800, height: 600 }, 100, 50);
      expect(result.x).toBe(1920 - 100 - 50);
      expect(result.y).toBe(1080 - 100 - 50);
    });

    it('returns fallback on error', () => {
      screen.getDisplayMatching.mockImplementation(() => { throw new Error('fail'); });
      const result = calculateWidgetPosition({ x: 0, y: 0, width: 800, height: 600 }, 100);
      expect(result).toEqual({ x: 100, y: 100, width: 100, height: 100 });
    });
  });

  describe('calculateCenteredPosition()', () => {
    it('centers window on primary display', () => {
      const result = calculateCenteredPosition(800, 600);
      expect(result.x).toBe(Math.round((1920 - 800) / 2));
      expect(result.y).toBe(Math.round((1080 - 600) / 2));
      expect(result.width).toBe(800);
      expect(result.height).toBe(600);
    });

    it('centers on provided display', () => {
      const result = calculateCenteredPosition(800, 600, mockSecondDisplay);
      expect(result.x).toBe(1920 + Math.round((1440 - 800) / 2));
      expect(result.y).toBe(Math.round((900 - 600) / 2));
    });

    it('clamps to work area x minimum', () => {
      // Window wider than display
      const result = calculateCenteredPosition(3000, 600);
      expect(result.x).toBe(0); // clamped to workArea.x
    });

    it('returns fallback on error', () => {
      screen.getPrimaryDisplay.mockImplementation(() => { throw new Error('fail'); });
      const result = calculateCenteredPosition(800, 600);
      expect(result).toEqual({ x: 100, y: 100, width: 800, height: 600 });
    });
  });

  describe('calculateOffsetPosition()', () => {
    it('calculates offset from anchor bounds', () => {
      const anchor = { x: 200, y: 100, width: 800, height: 600 };
      const result = calculateOffsetPosition(anchor, 400, 300);
      // Default offset is {x: 20, y: 20}
      // x = 200 + 20 = 220, y = 100 + 20 = 120
      // ensureBoundsVisible should confirm it's on-screen
      expect(result.x).toBe(220);
      expect(result.y).toBe(120);
      expect(result.width).toBe(400);
      expect(result.height).toBe(300);
    });

    it('accepts custom offset', () => {
      const anchor = { x: 0, y: 0, width: 800, height: 600 };
      const result = calculateOffsetPosition(anchor, 400, 300, { x: 50, y: 50 });
      expect(result.x).toBe(50);
      expect(result.y).toBe(50);
    });

    it('propagates through ensureBoundsVisible error fallback', () => {
      // ensureBoundsVisible catches its own error and returns original bounds
      // so calculateOffsetPosition never reaches its own catch block
      screen.getAllDisplays.mockImplementation(() => { throw new Error('fail'); });
      screen.getDisplayMatching.mockImplementation(() => { throw new Error('fail'); });
      screen.getPrimaryDisplay.mockImplementation(() => { throw new Error('fail'); });
      const result = calculateOffsetPosition({ x: 0, y: 0, width: 100, height: 100 }, 400, 300);
      // offset default is {x:20, y:20}; ensureBoundsVisible returns original bounds on error
      expect(result).toEqual({ x: 20, y: 20, width: 400, height: 300 });
    });
  });

  describe('calculateOptimalPosition()', () => {
    it('positions window near cursor', () => {
      const result = calculateOptimalPosition(400, 300);
      // cursor at (500, 300), offset default (10, 10)
      expect(result.x).toBe(510);
      expect(result.y).toBe(310);
      expect(result.width).toBe(400);
      expect(result.height).toBe(300);
    });

    it('adjusts when window would overflow right edge', () => {
      screen.getCursorScreenPoint.mockReturnValue({ x: 1800, y: 300 });
      const result = calculateOptimalPosition(400, 300);
      // x + width > workArea.width → adjust
      expect(result.x).toBeLessThanOrEqual(1920 - 400);
    });

    it('adjusts when window would overflow bottom edge', () => {
      screen.getCursorScreenPoint.mockReturnValue({ x: 500, y: 900 });
      const result = calculateOptimalPosition(400, 300);
      // y + height > workArea.height → adjust
      expect(result.y).toBeLessThanOrEqual(1080 - 300);
    });

    it('accepts custom offset', () => {
      const result = calculateOptimalPosition(400, 300, { x: 50, y: 50 });
      expect(result.x).toBe(550);
      expect(result.y).toBe(350);
    });

    it('returns centered position on error', () => {
      screen.getCursorScreenPoint.mockImplementation(() => { throw new Error('fail'); });
      screen.getDisplayNearestPoint.mockImplementation(() => { throw new Error('fail'); });
      const result = calculateOptimalPosition(800, 600);
      // Falls back to calculateCenteredPosition
      expect(result.width).toBe(800);
      expect(result.height).toBe(600);
    });
  });

  // =========================================================================
  // Bounds utilities
  // =========================================================================

  describe('ensureBoundsVisible()', () => {
    it('returns bounds unchanged when visible', () => {
      const bounds = { x: 100, y: 100, width: 800, height: 600 };
      const result = ensureBoundsVisible(bounds);
      expect(result).toEqual(bounds);
    });

    it('moves to primary display when completely off-screen', () => {
      const bounds = { x: -5000, y: -5000, width: 800, height: 600 };
      const result = ensureBoundsVisible(bounds);
      // Constrained to primary display work area
      expect(result.x).toBeGreaterThanOrEqual(0);
      expect(result.y).toBeGreaterThanOrEqual(0);
      expect(result.width).toBe(800);
      expect(result.height).toBe(600);
    });

    it('considers multiple displays', () => {
      screen.getAllDisplays.mockReturnValue([mockDisplay, mockSecondDisplay]);
      // Bounds visible on second display
      const bounds = { x: 2000, y: 100, width: 400, height: 300 };
      const result = ensureBoundsVisible(bounds);
      expect(result).toEqual(bounds);
    });

    it('returns original bounds on error', () => {
      screen.getAllDisplays.mockImplementation(() => { throw new Error('fail'); });
      const bounds = { x: 100, y: 100, width: 800, height: 600 };
      const result = ensureBoundsVisible(bounds);
      expect(result).toEqual(bounds);
    });
  });

  describe('constrainToWorkArea()', () => {
    it('constrains bounds that exceed work area', () => {
      const bounds = { x: -100, y: -100, width: 3000, height: 2000 };
      const result = constrainToWorkArea(bounds);
      expect(result.x).toBeGreaterThanOrEqual(0);
      expect(result.y).toBeGreaterThanOrEqual(0);
      expect(result.width).toBeLessThanOrEqual(1920);
      expect(result.height).toBeLessThanOrEqual(1080);
    });

    it('uses provided display', () => {
      const bounds = { x: 2000, y: 100, width: 400, height: 300 };
      const result = constrainToWorkArea(bounds, mockSecondDisplay);
      expect(result.x).toBeGreaterThanOrEqual(mockSecondDisplay.workArea.x);
    });

    it('returns bounds unchanged when already constrained', () => {
      const bounds = { x: 100, y: 100, width: 400, height: 300 };
      const result = constrainToWorkArea(bounds);
      expect(result).toEqual(bounds);
    });

    it('returns original bounds on error', () => {
      screen.getDisplayMatching.mockImplementation(() => { throw new Error('fail'); });
      const bounds = { x: 100, y: 100, width: 400, height: 300 };
      const result = constrainToWorkArea(bounds);
      expect(result).toEqual(bounds);
    });
  });

  describe('isWithinDisplay()', () => {
    it('returns true when bounds are fully within work area', () => {
      const bounds = { x: 100, y: 100, width: 400, height: 300 };
      expect(isWithinDisplay(bounds)).toBe(true);
    });

    it('returns false when bounds exceed work area right edge', () => {
      const bounds = { x: 1800, y: 100, width: 400, height: 300 };
      expect(isWithinDisplay(bounds)).toBe(false);
    });

    it('returns false when bounds exceed work area bottom edge', () => {
      const bounds = { x: 100, y: 900, width: 400, height: 300 };
      expect(isWithinDisplay(bounds)).toBe(false);
    });

    it('returns false when bounds are above work area', () => {
      const bounds = { x: 100, y: -100, width: 400, height: 300 };
      expect(isWithinDisplay(bounds)).toBe(false);
    });

    it('returns false when bounds are left of work area', () => {
      const bounds = { x: -100, y: 100, width: 400, height: 300 };
      expect(isWithinDisplay(bounds)).toBe(false);
    });

    it('uses provided display', () => {
      const bounds = { x: 1920, y: 0, width: 400, height: 300 };
      expect(isWithinDisplay(bounds, mockSecondDisplay)).toBe(true);
    });

    it('returns false on error', () => {
      screen.getDisplayMatching.mockImplementation(() => { throw new Error('fail'); });
      expect(isWithinDisplay({ x: 0, y: 0, width: 100, height: 100 })).toBe(false);
    });
  });

  // =========================================================================
  // Scale utilities
  // =========================================================================

  describe('getScaleFactor()', () => {
    it('returns scale factor of primary display', () => {
      expect(getScaleFactor()).toBe(2);
    });

    it('returns scale factor of provided display', () => {
      expect(getScaleFactor(mockSecondDisplay)).toBe(1);
    });

    it('returns 1.0 on error', () => {
      screen.getPrimaryDisplay.mockImplementation(() => { throw new Error('fail'); });
      expect(getScaleFactor()).toBe(1.0);
    });
  });

  describe('toPhysicalPixels()', () => {
    it('converts logical to physical using scale factor', () => {
      expect(toPhysicalPixels(100)).toBe(200); // 100 * 2
    });

    it('uses provided display scale factor', () => {
      expect(toPhysicalPixels(100, mockSecondDisplay)).toBe(100); // 100 * 1
    });

    it('rounds result', () => {
      // Scale factor 2, input 33 → 66 (exact)
      expect(toPhysicalPixels(33)).toBe(66);
    });
  });

  describe('toLogicalPixels()', () => {
    it('converts physical to logical using scale factor', () => {
      expect(toLogicalPixels(200)).toBe(100); // 200 / 2
    });

    it('uses provided display scale factor', () => {
      expect(toLogicalPixels(200, mockSecondDisplay)).toBe(200); // 200 / 1
    });

    it('rounds result', () => {
      expect(toLogicalPixels(33)).toBe(17); // Math.round(33/2) = Math.round(16.5) = 17
    });
  });

  // =========================================================================
  // Exports
  // =========================================================================

  describe('exports', () => {
    it('exports all expected functions', () => {
      const mod = require('../../../src/main/utils/display-utils');
      const expected = [
        'getDisplayForBounds', 'getAllDisplays', 'getPrimaryDisplay',
        'getDisplayAtCursor', 'getCursorPosition', 'getWorkArea',
        'calculateWidgetPosition', 'calculateCenteredPosition',
        'calculateOffsetPosition', 'calculateOptimalPosition',
        'ensureBoundsVisible', 'constrainToWorkArea', 'isWithinDisplay',
        'getScaleFactor', 'toPhysicalPixels', 'toLogicalPixels',
      ];
      for (const name of expected) {
        expect(typeof mod[name]).toBe('function');
      }
    });
  });
});
