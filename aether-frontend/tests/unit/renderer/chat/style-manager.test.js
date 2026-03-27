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

const StyleManager = require(
  '../../../../src/renderer/chat/modules/window/StyleManager'
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StyleManager', () => {
  let sm;

  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
    sm = new StyleManager();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('initializes stylesLoaded to false', () => {
      expect(sm.stylesLoaded).toBe(false);
    });

    it('creates a logger instance', () => {
      // logger is assigned in constructor; verify it exists
      expect(sm.log).toBeDefined();
      expect(sm.log.trace).toBeDefined();
    });
  });

  // =========================================================================
  // injectStyles
  // =========================================================================

  describe('injectStyles', () => {
    it('sets stylesLoaded to true on first call', () => {
      sm.injectStyles();
      expect(sm.stylesLoaded).toBe(true);
    });

    it('logs trace message on first call', () => {
      sm.injectStyles();
      expect(mockLog.trace).toHaveBeenCalledWith('global styles loaded from external CSS');
    });

    it('is idempotent — second call does not re-inject', () => {
      sm.injectStyles();
      mockLog.trace.mockClear();

      sm.injectStyles();
      // Second call logs the "already loaded" message, not the "loaded" message
      expect(mockLog.trace).toHaveBeenCalledWith('styles already loaded from CSS files');
      expect(sm.stylesLoaded).toBe(true);
    });

    it('returns undefined (no return value)', () => {
      expect(sm.injectStyles()).toBeUndefined();
    });
  });

  // =========================================================================
  // removeStyles
  // =========================================================================

  describe('removeStyles', () => {
    it('logs that styles are managed externally', () => {
      sm.removeStyles();
      expect(mockLog.trace).toHaveBeenCalledWith('styles managed via external CSS; no cleanup required');
    });

    it('does not change stylesLoaded flag', () => {
      sm.injectStyles();
      expect(sm.stylesLoaded).toBe(true);

      sm.removeStyles();
      expect(sm.stylesLoaded).toBe(true);
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('resets stylesLoaded to false', () => {
      sm.injectStyles();
      expect(sm.stylesLoaded).toBe(true);

      sm.dispose();
      expect(sm.stylesLoaded).toBe(false);
    });

    it('allows re-injection after dispose', () => {
      sm.injectStyles();
      sm.dispose();
      expect(sm.stylesLoaded).toBe(false);

      sm.injectStyles();
      expect(sm.stylesLoaded).toBe(true);
      expect(mockLog.trace).toHaveBeenCalledWith('global styles loaded from external CSS');
    });

    it('is safe to call multiple times', () => {
      sm.dispose();
      sm.dispose();
      expect(sm.stylesLoaded).toBe(false);
    });
  });

  // =========================================================================
  // Full lifecycle
  // =========================================================================

  describe('full lifecycle', () => {
    it('supports create -> inject -> dispose -> re-inject cycle', () => {
      // 1. Fresh state
      expect(sm.stylesLoaded).toBe(false);

      // 2. First inject
      sm.injectStyles();
      expect(sm.stylesLoaded).toBe(true);

      // 3. Dispose
      sm.dispose();
      expect(sm.stylesLoaded).toBe(false);

      // 4. Re-inject after dispose
      sm.injectStyles();
      expect(sm.stylesLoaded).toBe(true);

      // 5. Final cleanup
      sm.dispose();
      expect(sm.stylesLoaded).toBe(false);
    });
  });

  // =========================================================================
  // Module export guard (typeof module !== 'undefined')
  // =========================================================================

  describe('module exports', () => {
    it('exports the StyleManager class', () => {
      expect(StyleManager).toBeDefined();
      expect(typeof StyleManager).toBe('function');
      expect(new StyleManager()).toBeInstanceOf(StyleManager);
    });
  });
});
