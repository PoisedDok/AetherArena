'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, data_model}
 * Processing: Define frozen UI constants (17 categories: ANIMATION/LAYOUT/BREAKPOINTS/Z_INDEX/SPACING/RADIUS/SHADOW/COLORS/TYPOGRAPHY/TRANSITION/OPACITY/GLASS/INPUT/BUTTON/ICON/LOADER/AVATAR/MEDIA/SCROLL/CURSOR/FILTER) --- {1 jobs: JOB_INITIALIZE}
 * Outgoing: Export frozen UIConstants object for import by all renderer modules --- {ui_constants_types.*, frozen_object}
 * 
 * 
 * @module renderer/shared/constants/ui-constants
 * 
 * UIConstants - Shared UI Constants
 * ============================================================================
 * Centralized UI constants shared across renderer processes:
 * - Animation durations and easing
 * - Layout dimensions and breakpoints
 * - Z-index layers
 * - Color palette
 * - Typography scales
 * - Common CSS values
 * 
 * Responsibilities:
 * - Provide consistent UI values
 * - Define animation constants
 * - Standardize spacing and sizing
 * - Define color scheme
 * - Typography configuration
 * 
 * Architecture:
 * - Frozen constants (immutable)
 * - No runtime state
 * - Framework-agnostic
 * - Production-ready
 */

const { freeze } = Object;

/**
 * UI Constants
 */
const UIConstants = freeze({
  /**
   * Animation durations (in milliseconds)
   */
  ANIMATION: freeze({
    DURATION: freeze({
      INSTANT: 0,
      FAST: 150,
      NORMAL: 300,
      SLOW: 500,
      VERY_SLOW: 800,
    }),
    EASING: freeze({
      LINEAR: 'linear',
      EASE: 'ease',
      EASE_IN: 'ease-in',
      EASE_OUT: 'ease-out',
      EASE_IN_OUT: 'ease-in-out',
      CUBIC_BEZIER: 'cubic-bezier(0.4, 0, 0.2, 1)',
      SPRING: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    }),
  }),

  /**
   * Layout dimensions
   */
  LAYOUT: freeze({
    SIDEBAR_WIDTH: 250,
    HEADER_HEIGHT: 60,
    FOOTER_HEIGHT: 40,
    SCROLLBAR_WIDTH: 8,
    MIN_WINDOW_WIDTH: 400,
    MIN_WINDOW_HEIGHT: 300,
    MAX_CONTENT_WIDTH: 1200,
  }),

  /**
   * Breakpoints for responsive design
   */
  BREAKPOINTS: freeze({
    XS: 320,
    SM: 640,
    MD: 768,
    LG: 1024,
    XL: 1280,
    XXL: 1536,
  }),

  /**
   * Z-index layers
   */
  Z_INDEX: freeze({
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
  }),

  /**
   * Spacing scale (in pixels)
   */
  SPACING: freeze({
    XXS: 4,
    XS: 8,
    SM: 12,
    MD: 16,
    LG: 24,
    XL: 32,
    XXL: 48,
    XXXL: 64,
  }),

  /**
   * Border radius scale (in pixels)
   */
  RADIUS: freeze({
    NONE: 0,
    SM: 4,
    MD: 8,
    LG: 12,
    XL: 16,
    FULL: 9999,
  }),

  /**
   * Shadow definitions
   */
  SHADOW: freeze({
    NONE: 'none',
    SM: '0 1px 2px rgba(0, 0, 0, 0.05)',
    MD: '0 4px 6px rgba(0, 0, 0, 0.1)',
    LG: '0 10px 15px rgba(0, 0, 0, 0.1)',
    XL: '0 20px 25px rgba(0, 0, 0, 0.15)',
    INNER: 'inset 0 2px 4px rgba(0, 0, 0, 0.06)',
  }),

  /**
   * Color palette
   */
  COLORS: freeze({
    // Primary colors
    PRIMARY: 'rgba(255, 100, 0, 1)',
    PRIMARY_LIGHT: 'rgba(255, 150, 50, 1)',
    PRIMARY_DARK: 'rgba(200, 80, 0, 1)',

    // Semantic colors
    SUCCESS: 'rgba(34, 197, 94, 1)',
    WARNING: 'rgba(251, 191, 36, 1)',
    ERROR: 'rgba(239, 68, 68, 1)',
    INFO: 'rgba(59, 130, 246, 1)',

    // Neutral colors
    WHITE: 'rgba(255, 255, 255, 1)',
    BLACK: 'rgba(0, 0, 0, 1)',
    GRAY_50: 'rgba(249, 250, 251, 1)',
    GRAY_100: 'rgba(243, 244, 246, 1)',
    GRAY_200: 'rgba(229, 231, 235, 1)',
    GRAY_300: 'rgba(209, 213, 219, 1)',
    GRAY_400: 'rgba(156, 163, 175, 1)',
    GRAY_500: 'rgba(107, 114, 128, 1)',
    GRAY_600: 'rgba(75, 85, 99, 1)',
    GRAY_700: 'rgba(55, 65, 81, 1)',
    GRAY_800: 'rgba(31, 41, 55, 1)',
    GRAY_900: 'rgba(17, 24, 39, 1)',

    // Transparent variations
    TRANSPARENT: 'transparent',
    CURRENT: 'currentColor',
  }),

  /**
   * Typography scale
   */
  TYPOGRAPHY: freeze({
    FONT_FAMILY: freeze({
      SANS: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      SERIF: 'Georgia, Cambria, "Times New Roman", Times, serif',
      MONO: '"Courier New", Courier, monospace, "SF Mono", Monaco, "Cascadia Code"',
    }),
    FONT_SIZE: freeze({
      XS: '12px',
      SM: '14px',
      BASE: '16px',
      LG: '18px',
      XL: '20px',
      '2XL': '24px',
      '3XL': '30px',
      '4XL': '36px',
      '5XL': '48px',
      '6XL': '60px',
    }),
    FONT_WEIGHT: freeze({
      THIN: 100,
      EXTRA_LIGHT: 200,
      LIGHT: 300,
      NORMAL: 400,
      MEDIUM: 500,
      SEMI_BOLD: 600,
      BOLD: 700,
      EXTRA_BOLD: 800,
      BLACK: 900,
    }),
    LINE_HEIGHT: freeze({
      NONE: 1,
      TIGHT: 1.25,
      SNUG: 1.375,
      NORMAL: 1.5,
      RELAXED: 1.625,
      LOOSE: 2,
    }),
  }),

  /**
   * Transition presets
   */
  TRANSITION: freeze({
    ALL: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
    OPACITY: 'opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
    TRANSFORM: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
    COLORS: 'background-color 0.3s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.3s cubic-bezier(0.4, 0, 0.2, 1), color 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
  }),

  /**
   * Opacity values
   */
  OPACITY: freeze({
    TRANSPARENT: 0,
    NEARLY_TRANSPARENT: 0.1,
    LIGHT: 0.3,
    MEDIUM: 0.5,
    HEAVY: 0.7,
    NEARLY_OPAQUE: 0.9,
    OPAQUE: 1,
  }),

  /**
   * Glassmorphism effect values
   */
  GLASS: freeze({
    BACKGROUND: 'rgba(255, 255, 255, 0.1)',
    BACKDROP_BLUR: 'blur(10px)',
    BORDER: '1px solid rgba(255, 255, 255, 0.2)',
    SHADOW: '0 8px 32px rgba(0, 0, 0, 0.1)',
  }),

  /**
   * Input dimensions
   */
  INPUT: freeze({
    HEIGHT: freeze({
      SM: 32,
      MD: 40,
      LG: 48,
    }),
    PADDING: freeze({
      SM: '6px 12px',
      MD: '8px 16px',
      LG: '12px 20px',
    }),
  }),

  /**
   * Button dimensions
   */
  BUTTON: freeze({
    HEIGHT: freeze({
      SM: 32,
      MD: 40,
      LG: 48,
    }),
    PADDING: freeze({
      SM: '6px 16px',
      MD: '10px 20px',
      LG: '12px 24px',
    }),
  }),

  /**
   * Icon sizes
   */
  ICON: freeze({
    XS: 12,
    SM: 16,
    MD: 20,
    LG: 24,
    XL: 32,
    XXL: 48,
  }),

  /**
   * Loading indicator sizes
   */
  LOADER: freeze({
    SM: 20,
    MD: 40,
    LG: 60,
  }),

  /**
   * Avatar sizes
   */
  AVATAR: freeze({
    XS: 24,
    SM: 32,
    MD: 40,
    LG: 48,
    XL: 64,
    XXL: 96,
  }),

  /**
   * Media query helpers
   */
  MEDIA: freeze({
    MOBILE: '(max-width: 767px)',
    TABLET: '(min-width: 768px) and (max-width: 1023px)',
    DESKTOP: '(min-width: 1024px)',
    LARGE_DESKTOP: '(min-width: 1280px)',
    RETINA: '(-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi)',
  }),

  /**
   * Scroll behavior
   */
  SCROLL: freeze({
    SMOOTH: 'smooth',
    AUTO: 'auto',
    INSTANT: 'instant',
  }),

  /**
   * Cursor types
   */
  CURSOR: freeze({
    AUTO: 'auto',
    DEFAULT: 'default',
    POINTER: 'pointer',
    WAIT: 'wait',
    TEXT: 'text',
    MOVE: 'move',
    NOT_ALLOWED: 'not-allowed',
    GRAB: 'grab',
    GRABBING: 'grabbing',
  }),

  /**
   * Common CSS filters
   */
  FILTER: freeze({
    BLUR_SM: 'blur(4px)',
    BLUR_MD: 'blur(8px)',
    BLUR_LG: 'blur(16px)',
    GRAYSCALE: 'grayscale(100%)',
    BRIGHTNESS_HIGH: 'brightness(1.2)',
    BRIGHTNESS_LOW: 'brightness(0.8)',
  }),
});

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = UIConstants;
}

if (typeof window !== 'undefined') {
  window.UIConstants = UIConstants;
  console.log('📦 UIConstants loaded');
}

