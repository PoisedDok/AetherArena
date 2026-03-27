'use strict';

const UIConstants = require('../../../src/renderer/shared/constants/ui-constants');

// ============================================================================
// Top-level structure
// ============================================================================
describe('UIConstants', () => {

  it('is defined and non-null', () => {
    expect(UIConstants).toBeDefined();
    expect(UIConstants).not.toBeNull();
  });

  it('is frozen (immutable)', () => {
    expect(Object.isFrozen(UIConstants)).toBe(true);
  });

  it('exports to window.UIConstants in jsdom', () => {
    expect(window.UIConstants).toBe(UIConstants);
  });

  it('contains all 17 expected top-level categories', () => {
    const expected = [
      'ANIMATION', 'LAYOUT', 'BREAKPOINTS', 'Z_INDEX', 'SPACING', 'RADIUS',
      'TYPOGRAPHY', 'TRANSITION', 'OPACITY', 'INPUT', 'BUTTON', 'ICON',
      'LOADER', 'AVATAR', 'MEDIA', 'SCROLL', 'CURSOR', 'FILTER',
    ];
    for (const key of expected) {
      expect(UIConstants).toHaveProperty(key);
    }
  });

  it('every top-level category is frozen', () => {
    for (const key of Object.keys(UIConstants)) {
      expect(Object.isFrozen(UIConstants[key])).toBe(true);
    }
  });

  // ==========================================================================
  // ANIMATION
  // ==========================================================================
  describe('ANIMATION', () => {
    const { ANIMATION } = UIConstants;

    it('DURATION is frozen with correct values', () => {
      expect(Object.isFrozen(ANIMATION.DURATION)).toBe(true);
      expect(ANIMATION.DURATION).toEqual({
        INSTANT: 0,
        FAST: 150,
        NORMAL: 300,
        SLOW: 500,
        VERY_SLOW: 800,
      });
    });

    it('DURATION values are all non-negative numbers', () => {
      for (const v of Object.values(ANIMATION.DURATION)) {
        expect(typeof v).toBe('number');
        expect(v).toBeGreaterThanOrEqual(0);
      }
    });

    it('EASING is frozen with correct CSS timing functions', () => {
      expect(Object.isFrozen(ANIMATION.EASING)).toBe(true);
      expect(ANIMATION.EASING.LINEAR).toBe('linear');
      expect(ANIMATION.EASING.EASE).toBe('ease');
      expect(ANIMATION.EASING.EASE_IN).toBe('ease-in');
      expect(ANIMATION.EASING.EASE_OUT).toBe('ease-out');
      expect(ANIMATION.EASING.EASE_IN_OUT).toBe('ease-in-out');
      expect(ANIMATION.EASING.CUBIC_BEZIER).toMatch(/^cubic-bezier\(/);
      expect(ANIMATION.EASING.SPRING).toMatch(/^cubic-bezier\(/);
    });

    it('all EASING values are strings', () => {
      for (const v of Object.values(ANIMATION.EASING)) {
        expect(typeof v).toBe('string');
      }
    });
  });

  // ==========================================================================
  // LAYOUT
  // ==========================================================================
  describe('LAYOUT', () => {
    const { LAYOUT } = UIConstants;

    it('is frozen with correct dimension values', () => {
      expect(LAYOUT).toEqual({
        SIDEBAR_WIDTH: 250,
        HEADER_HEIGHT: 60,
        FOOTER_HEIGHT: 40,
        SCROLLBAR_WIDTH: 8,
        MIN_WINDOW_WIDTH: 400,
        MIN_WINDOW_HEIGHT: 300,
        MAX_CONTENT_WIDTH: 1200,
      });
    });

    it('all values are positive numbers', () => {
      for (const v of Object.values(LAYOUT)) {
        expect(typeof v).toBe('number');
        expect(v).toBeGreaterThan(0);
      }
    });
  });

  // ==========================================================================
  // BREAKPOINTS
  // ==========================================================================
  describe('BREAKPOINTS', () => {
    const { BREAKPOINTS } = UIConstants;

    it('has expected keys with correct values', () => {
      expect(BREAKPOINTS).toEqual({
        XS: 320, SM: 640, MD: 768, LG: 1024, XL: 1280, XXL: 1536,
      });
    });

    it('values are in strictly ascending order', () => {
      const values = Object.values(BREAKPOINTS);
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThan(values[i - 1]);
      }
    });
  });

  // ==========================================================================
  // Z_INDEX
  // ==========================================================================
  describe('Z_INDEX', () => {
    const { Z_INDEX } = UIConstants;

    it('has expected keys', () => {
      expect(Z_INDEX).toEqual({
        BASE: 1,
        DROPDOWN: 1000,
        STICKY: 1100,
        FIXED: 1200,
        MODAL_BACKDROP: 1300,
        MODAL: 1400,
        POPOVER: 1500,
        TOOLTIP: 1600,
        NOTIFICATION: 1700,
        LOADING: 9999,
        ERROR_BOUNDARY: 99999,
      });
    });

    it('MODAL is above MODAL_BACKDROP', () => {
      expect(Z_INDEX.MODAL).toBeGreaterThan(Z_INDEX.MODAL_BACKDROP);
    });

    it('TOOLTIP is above POPOVER', () => {
      expect(Z_INDEX.TOOLTIP).toBeGreaterThan(Z_INDEX.POPOVER);
    });

    it('ERROR_BOUNDARY is highest', () => {
      for (const [key, v] of Object.entries(Z_INDEX)) {
        if (key !== 'ERROR_BOUNDARY') {
          expect(Z_INDEX.ERROR_BOUNDARY).toBeGreaterThan(v);
        }
      }
    });
  });

  // ==========================================================================
  // SPACING
  // ==========================================================================
  describe('SPACING', () => {
    const { SPACING } = UIConstants;

    it('has expected values', () => {
      expect(SPACING).toEqual({
        XXS: 4, XS: 8, SM: 12, MD: 16, LG: 24, XL: 32, XXL: 48, XXXL: 64,
      });
    });

    it('values are in strictly ascending order', () => {
      const values = Object.values(SPACING);
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThan(values[i - 1]);
      }
    });
  });

  // ==========================================================================
  // RADIUS
  // ==========================================================================
  describe('RADIUS', () => {
    const { RADIUS } = UIConstants;

    it('has expected values', () => {
      expect(RADIUS).toEqual({
        NONE: 0, SM: 4, MD: 8, LG: 12, XL: 16, FULL: 9999,
      });
    });

    it('NONE is 0, FULL is very large', () => {
      expect(RADIUS.NONE).toBe(0);
      expect(RADIUS.FULL).toBeGreaterThanOrEqual(9999);
    });
  });

  // ==========================================================================
  // TYPOGRAPHY
  // ==========================================================================
  describe('TYPOGRAPHY', () => {
    const { TYPOGRAPHY } = UIConstants;

    it('all sub-objects are frozen', () => {
      expect(Object.isFrozen(TYPOGRAPHY.FONT_FAMILY)).toBe(true);
      expect(Object.isFrozen(TYPOGRAPHY.FONT_SIZE)).toBe(true);
      expect(Object.isFrozen(TYPOGRAPHY.FONT_WEIGHT)).toBe(true);
      expect(Object.isFrozen(TYPOGRAPHY.LINE_HEIGHT)).toBe(true);
    });

    it('FONT_FAMILY has sans, serif, mono', () => {
      expect(typeof TYPOGRAPHY.FONT_FAMILY.SANS).toBe('string');
      expect(typeof TYPOGRAPHY.FONT_FAMILY.SERIF).toBe('string');
      expect(typeof TYPOGRAPHY.FONT_FAMILY.MONO).toBe('string');
    });

    it('FONT_SIZE values are pixel strings', () => {
      for (const v of Object.values(TYPOGRAPHY.FONT_SIZE)) {
        expect(v).toMatch(/^\d+px$/);
      }
    });

    it('FONT_WEIGHT values are multiples of 100 from 100-900', () => {
      for (const v of Object.values(TYPOGRAPHY.FONT_WEIGHT)) {
        expect(typeof v).toBe('number');
        expect(v).toBeGreaterThanOrEqual(100);
        expect(v).toBeLessThanOrEqual(900);
        expect(v % 100).toBe(0);
      }
    });

    it('LINE_HEIGHT values are positive numbers', () => {
      for (const v of Object.values(TYPOGRAPHY.LINE_HEIGHT)) {
        expect(typeof v).toBe('number');
        expect(v).toBeGreaterThan(0);
      }
    });
  });

  // ==========================================================================
  // TRANSITION
  // ==========================================================================
  describe('TRANSITION', () => {
    const { TRANSITION } = UIConstants;

    it('has expected presets as CSS transition strings', () => {
      expect(typeof TRANSITION.ALL).toBe('string');
      expect(typeof TRANSITION.OPACITY).toBe('string');
      expect(typeof TRANSITION.TRANSFORM).toBe('string');
      expect(typeof TRANSITION.COLORS).toBe('string');
    });

    it('ALL transition targets "all"', () => {
      expect(TRANSITION.ALL).toMatch(/^all /);
    });

    it('OPACITY transition targets "opacity"', () => {
      expect(TRANSITION.OPACITY).toMatch(/^opacity /);
    });
  });

  // ==========================================================================
  // OPACITY
  // ==========================================================================
  describe('OPACITY', () => {
    const { OPACITY } = UIConstants;

    it('has expected values between 0 and 1', () => {
      expect(OPACITY.TRANSPARENT).toBe(0);
      expect(OPACITY.OPAQUE).toBe(1);
      for (const v of Object.values(OPACITY)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });

    it('values are in ascending order', () => {
      const values = Object.values(OPACITY);
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
      }
    });
  });

  // ==========================================================================
  // INPUT
  // ==========================================================================
  describe('INPUT', () => {
    const { INPUT } = UIConstants;

    it('HEIGHT sub-object is frozen with numeric values', () => {
      expect(Object.isFrozen(INPUT.HEIGHT)).toBe(true);
      expect(INPUT.HEIGHT).toEqual({ SM: 32, MD: 40, LG: 48 });
    });

    it('PADDING sub-object is frozen with CSS padding strings', () => {
      expect(Object.isFrozen(INPUT.PADDING)).toBe(true);
      for (const v of Object.values(INPUT.PADDING)) {
        expect(typeof v).toBe('string');
        expect(v).toMatch(/\d+px/);
      }
    });
  });

  // ==========================================================================
  // BUTTON
  // ==========================================================================
  describe('BUTTON', () => {
    const { BUTTON } = UIConstants;

    it('HEIGHT sub-object is frozen with numeric values', () => {
      expect(Object.isFrozen(BUTTON.HEIGHT)).toBe(true);
      expect(BUTTON.HEIGHT).toEqual({ SM: 32, MD: 40, LG: 48 });
    });

    it('PADDING sub-object is frozen with CSS padding strings', () => {
      expect(Object.isFrozen(BUTTON.PADDING)).toBe(true);
      for (const v of Object.values(BUTTON.PADDING)) {
        expect(typeof v).toBe('string');
        expect(v).toMatch(/\d+px/);
      }
    });
  });

  // ==========================================================================
  // ICON, LOADER, AVATAR
  // ==========================================================================
  describe('ICON', () => {
    it('has expected size values (all numbers)', () => {
      expect(UIConstants.ICON).toEqual({
        XS: 12, SM: 16, MD: 20, LG: 24, XL: 32, XXL: 48,
      });
    });
  });

  describe('LOADER', () => {
    it('has SM/MD/LG sizes (all numbers)', () => {
      expect(UIConstants.LOADER).toEqual({ SM: 20, MD: 40, LG: 60 });
    });
  });

  describe('AVATAR', () => {
    it('has expected size values (all numbers)', () => {
      expect(UIConstants.AVATAR).toEqual({
        XS: 24, SM: 32, MD: 40, LG: 48, XL: 64, XXL: 96,
      });
    });

    it('sizes are in ascending order', () => {
      const values = Object.values(UIConstants.AVATAR);
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThan(values[i - 1]);
      }
    });
  });

  // ==========================================================================
  // MEDIA
  // ==========================================================================
  describe('MEDIA', () => {
    const { MEDIA } = UIConstants;

    it('has expected media query strings', () => {
      expect(MEDIA.MOBILE).toMatch(/max-width/);
      expect(MEDIA.TABLET).toMatch(/min-width.*max-width/);
      expect(MEDIA.DESKTOP).toMatch(/min-width/);
      expect(MEDIA.LARGE_DESKTOP).toMatch(/min-width/);
      expect(MEDIA.RETINA).toMatch(/device-pixel-ratio|resolution/);
    });

    it('all values are strings', () => {
      for (const v of Object.values(MEDIA)) {
        expect(typeof v).toBe('string');
      }
    });
  });

  // ==========================================================================
  // SCROLL
  // ==========================================================================
  describe('SCROLL', () => {
    it('has expected scroll behavior values', () => {
      expect(UIConstants.SCROLL).toEqual({
        SMOOTH: 'smooth', AUTO: 'auto', INSTANT: 'instant',
      });
    });
  });

  // ==========================================================================
  // CURSOR
  // ==========================================================================
  describe('CURSOR', () => {
    const { CURSOR } = UIConstants;

    it('has expected CSS cursor values', () => {
      expect(CURSOR).toEqual({
        AUTO: 'auto',
        DEFAULT: 'default',
        POINTER: 'pointer',
        WAIT: 'wait',
        TEXT: 'text',
        MOVE: 'move',
        NOT_ALLOWED: 'not-allowed',
        GRAB: 'grab',
        GRABBING: 'grabbing',
      });
    });

    it('all values are strings', () => {
      for (const v of Object.values(CURSOR)) {
        expect(typeof v).toBe('string');
      }
    });
  });

  // ==========================================================================
  // FILTER
  // ==========================================================================
  describe('FILTER', () => {
    const { FILTER } = UIConstants;

    it('has expected CSS filter values', () => {
      expect(FILTER).toEqual({
        BLUR_SM: 'blur(4px)',
        BLUR_MD: 'blur(8px)',
        BLUR_LG: 'blur(16px)',
        GRAYSCALE: 'grayscale(100%)',
        BRIGHTNESS_HIGH: 'brightness(1.2)',
        BRIGHTNESS_LOW: 'brightness(0.8)',
      });
    });

    it('blur values are CSS blur() functions', () => {
      expect(FILTER.BLUR_SM).toMatch(/^blur\(\d+px\)$/);
      expect(FILTER.BLUR_MD).toMatch(/^blur\(\d+px\)$/);
      expect(FILTER.BLUR_LG).toMatch(/^blur\(\d+px\)$/);
    });
  });

  // ==========================================================================
  // Immutability verification
  // ==========================================================================
  describe('deep freeze enforcement', () => {
    it('cannot add properties to UIConstants', () => {
      expect(() => { UIConstants.NEW_PROP = 'test'; }).toThrow();
    });

    it('cannot modify existing values', () => {
      expect(() => { UIConstants.ANIMATION = {}; }).toThrow();
    });

    it('cannot modify nested values', () => {
      expect(() => { UIConstants.ANIMATION.DURATION.FAST = 999; }).toThrow();
    });

    it('cannot delete properties', () => {
      expect(() => { delete UIConstants.LAYOUT; }).toThrow();
    });
  });
});
