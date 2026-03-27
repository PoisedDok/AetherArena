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

const CircularRingButton = require(
  '../../../../src/renderer/chat/components/CircularRingButton'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createButton(overrides = {}) {
  return new CircularRingButton(overrides);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CircularRingButton', () => {
  let btn;

  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
  });

  afterEach(() => {
    if (btn) {
      try { btn.dispose(); } catch (e) { /* noop */ }
      btn = null;
    }
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('creates button element with correct class names', () => {
      btn = createButton();
      expect(btn.button).toBeInstanceOf(HTMLElement);
      expect(btn.button.classList.contains('context-ring-button')).toBe(true);
      expect(btn.button.classList.contains('circular-ring-btn')).toBe(true);
    });

    it('sets default onClick to noop', () => {
      btn = createButton();
      expect(typeof btn.onClick).toBe('function');
      // Should not throw
      expect(() => btn.onClick()).not.toThrow();
    });

    it('accepts custom onClick callback', () => {
      const spy = jest.fn();
      btn = createButton({ onClick: spy });
      expect(btn.onClick).toBe(spy);
    });

    it('initializes state to zero values', () => {
      btn = createButton();
      expect(btn.usagePercent).toBe(0);
      expect(btn.tokenCount).toBe(0);
      expect(btn.tokenLimit).toBe(0);
    });

    it('sets default thresholds', () => {
      btn = createButton();
      expect(btn.thresholds).toEqual({ warning: 0.8, high: 0.9, critical: 0.95 });
    });

    it('creates SVG progress ring', () => {
      btn = createButton();
      expect(btn.progressRing).toBeDefined();
      expect(btn.progressRing.classList.contains('progress-ring')).toBe(true);
    });

    it('creates usage text element', () => {
      btn = createButton();
      expect(btn.usageText).toBeDefined();
      expect(btn.usageText.textContent).toBe('0%');
    });

    it('sets aria-label for accessibility', () => {
      btn = createButton();
      expect(btn.button.getAttribute('aria-label')).toBe('View current context and token usage');
    });

    it('sets initial title', () => {
      btn = createButton();
      expect(btn.button.title).toBe('View Current Context');
    });

    it('fires onClick when button is clicked', () => {
      const spy = jest.fn();
      btn = createButton({ onClick: spy });
      btn.button.click();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // updateDisplay
  // =========================================================================

  describe('updateDisplay', () => {
    beforeEach(() => {
      btn = createButton();
    });

    it('no-ops when contextStatus is null', () => {
      btn.updateDisplay(null);
      expect(btn.usagePercent).toBe(0);
    });

    it('no-ops when contextStatus is undefined', () => {
      btn.updateDisplay(undefined);
      expect(btn.usagePercent).toBe(0);
    });

    it('reads snake_case fields from backend', () => {
      btn.updateDisplay({
        usage_percent: 42,
        token_count: 4200,
        token_limit: 10000,
      });
      expect(btn.usagePercent).toBe(42);
      expect(btn.tokenCount).toBe(4200);
      expect(btn.tokenLimit).toBe(10000);
    });

    it('reads camelCase fields as fallback', () => {
      btn.updateDisplay({
        usagePercent: 55,
        tokenCount: 5500,
        tokenLimit: 10000,
      });
      expect(btn.usagePercent).toBe(55);
      expect(btn.tokenCount).toBe(5500);
      expect(btn.tokenLimit).toBe(10000);
    });

    it('prefers snake_case over camelCase when both present', () => {
      btn.updateDisplay({
        usage_percent: 30,
        usagePercent: 99,
        token_count: 3000,
        tokenCount: 9900,
        token_limit: 10000,
        tokenLimit: 50000,
      });
      expect(btn.usagePercent).toBe(30);
      expect(btn.tokenCount).toBe(3000);
      expect(btn.tokenLimit).toBe(10000);
    });

    it('defaults missing fields to 0', () => {
      btn.updateDisplay({});
      expect(btn.usagePercent).toBe(0);
      expect(btn.tokenCount).toBe(0);
      expect(btn.tokenLimit).toBe(0);
    });

    it('converts absolute threshold counts (>100) to fractions', () => {
      btn.updateDisplay({
        usage_percent: 50,
        token_count: 5000,
        token_limit: 10000,
        thresholds: { warning: 8000, high: 9000, critical: 9500 },
      });
      expect(btn.thresholds.warning).toBe(0.8);
      expect(btn.thresholds.high).toBe(0.9);
      expect(btn.thresholds.critical).toBe(0.95);
    });

    it('converts percentage thresholds (<=100) to fractions', () => {
      btn.updateDisplay({
        usage_percent: 50,
        token_count: 5000,
        token_limit: 10000,
        thresholds: { warning: 80, high: 90, critical: 95 },
      });
      expect(btn.thresholds.warning).toBe(0.8);
      expect(btn.thresholds.high).toBe(0.9);
      expect(btn.thresholds.critical).toBe(0.95);
    });

    it('uses default threshold values when threshold field is falsy (0)', () => {
      btn.updateDisplay({
        usage_percent: 50,
        token_count: 5000,
        token_limit: 10000,
        thresholds: { warning: 0, high: 0, critical: 0 },
      });
      // (0 || 80) / 100 = 0.8
      expect(btn.thresholds.warning).toBe(0.8);
      expect(btn.thresholds.high).toBe(0.9);
      expect(btn.thresholds.critical).toBe(0.95);
    });

    it('does not update thresholds when thresholds field absent', () => {
      const originalThresholds = { ...btn.thresholds };
      btn.updateDisplay({ usage_percent: 50 });
      expect(btn.thresholds).toEqual(originalThresholds);
    });

    it('prevents division by zero in threshold conversion when tokenLimit is 0', () => {
      btn.updateDisplay({
        usage_percent: 50,
        token_limit: 0,
        thresholds: { warning: 80, high: 90, critical: 95 },
      });
      // limit fallback is 1, so 80/100=0.8 (<=100 path)
      expect(btn.thresholds.warning).toBe(0.8);
    });
  });

  // =========================================================================
  // _updateVisuals
  // =========================================================================

  describe('_updateVisuals (via updateDisplay)', () => {
    beforeEach(() => {
      btn = createButton();
    });

    it('sets progress ring stroke-dashoffset for 50% usage', () => {
      btn.updateDisplay({ usage_percent: 50 });
      const offset = parseFloat(btn.progressRing.style.strokeDashoffset);
      // circumference * (1 - 0.5) = 94.25 * 0.5 = 47.125
      expect(offset).toBeCloseTo(47.125, 2);
    });

    it('sets progress ring stroke-dashoffset for 0% usage', () => {
      btn.updateDisplay({ usage_percent: 0 });
      const offset = parseFloat(btn.progressRing.style.strokeDashoffset);
      expect(offset).toBeCloseTo(94.25, 2);
    });

    it('sets progress ring stroke-dashoffset for 100% usage', () => {
      btn.updateDisplay({ usage_percent: 100 });
      const offset = parseFloat(btn.progressRing.style.strokeDashoffset);
      expect(offset).toBeCloseTo(0, 2);
    });

    // NOTE: JSDOM does not support CSS custom properties (var(--...)) in
    // element.style assignments. We verify the color-selection branches execute
    // without error and that the correct offset/text values are set. The actual
    // ring colors are exercised but cannot be asserted in jsdom.

    it('exercises success color branch for usage below warning', () => {
      btn.updateDisplay({ usage_percent: 50 });
      // Branch: usageDecimal < warning (0.8) → success path executed
      expect(btn.usageText.textContent).toBe('50%');
    });

    it('exercises info color branch for usage at warning threshold', () => {
      btn.updateDisplay({ usage_percent: 80 });
      expect(btn.usageText.textContent).toBe('80%');
    });

    it('exercises warning color branch for usage at high threshold', () => {
      btn.updateDisplay({ usage_percent: 90 });
      expect(btn.usageText.textContent).toBe('90%');
    });

    it('exercises error color branch for usage at critical threshold', () => {
      btn.updateDisplay({ usage_percent: 95 });
      expect(btn.usageText.textContent).toBe('95%');
    });

    it('updates usage text with rounded percentage for >= 1%', () => {
      btn.updateDisplay({ usage_percent: 42.7 });
      expect(btn.usageText.textContent).toBe('43%');
    });

    it('updates usage text with one decimal for < 1%', () => {
      btn.updateDisplay({ usage_percent: 0.3 });
      expect(btn.usageText.textContent).toBe('0.3%');
    });

    it('exercises usage text color assignment (jsdom drops CSS vars)', () => {
      // Verifies the usageText.style.color assignment path runs
      btn.updateDisplay({ usage_percent: 95 });
      // Can't assert CSS var value in jsdom; verify text updated instead
      expect(btn.usageText.textContent).toBe('95%');
    });

    it('updates tooltip with token counts when limit > 0', () => {
      btn.updateDisplay({
        usage_percent: 42,
        token_count: 4200,
        token_limit: 10000,
      });
      expect(btn.button.title).toContain('4,200');
      expect(btn.button.title).toContain('10,000');
      expect(btn.button.title).toContain('42.0%');
    });

    it('shows default tooltip when limit is 0', () => {
      btn.updateDisplay({
        usage_percent: 50,
        token_count: 5000,
        token_limit: 0,
      });
      expect(btn.button.title).toBe('View Current Context');
    });
  });

  // =========================================================================
  // getElement
  // =========================================================================

  describe('getElement', () => {
    it('returns the button element', () => {
      btn = createButton();
      expect(btn.getElement()).toBe(btn.button);
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('removes button from DOM when it has a parent', () => {
      btn = createButton();
      const parent = document.createElement('div');
      parent.appendChild(btn.button);
      expect(parent.children.length).toBe(1);

      btn.dispose();
      expect(parent.children.length).toBe(0);
    });

    it('nulls out button reference', () => {
      btn = createButton();
      btn.dispose();
      expect(btn.button).toBeNull();
    });

    it('is safe when button has no parent', () => {
      btn = createButton();
      // button not appended to any parent
      expect(() => btn.dispose()).not.toThrow();
      expect(btn.button).toBeNull();
    });

    it('is safe to call twice', () => {
      btn = createButton();
      btn.dispose();
      expect(() => btn.dispose()).not.toThrow();
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('handles progressRing being null (defensive)', () => {
      btn = createButton();
      btn.progressRing = null;
      // Should not throw
      expect(() => btn.updateDisplay({ usage_percent: 50 })).not.toThrow();
    });

    it('handles usageText being null (defensive)', () => {
      btn = createButton();
      btn.usageText = null;
      // Should not throw
      expect(() => btn.updateDisplay({ usage_percent: 50 })).not.toThrow();
    });
  });
});
