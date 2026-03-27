'use strict';

// ---------------------------------------------------------------------------
// Mocks — plain functions survive resetMocks: true
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

const TrailStyleManager = require(
  '../../../../src/renderer/chat/modules/trail/TrailStyleManager'
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrailStyleManager', () => {
  let manager;

  beforeEach(() => {
    mockLog.trace.mockClear();
    mockLog.debug.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    manager = new TrailStyleManager();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('sets default styleId to "artifact-trail-styles"', () => {
      expect(manager.styleId).toBe('artifact-trail-styles');
    });

    it('accepts custom styleId via options', () => {
      const custom = new TrailStyleManager({ styleId: 'custom-styles' });
      expect(custom.styleId).toBe('custom-styles');
    });

    it('initializes injected to false', () => {
      expect(manager.injected).toBe(false);
    });

    it('stores logger reference', () => {
      expect(manager.log).toBe(mockLog);
    });

    it('handles empty options object', () => {
      const m = new TrailStyleManager({});
      expect(m.styleId).toBe('artifact-trail-styles');
    });

    it('handles no options argument (defaults)', () => {
      const m = new TrailStyleManager();
      expect(m.styleId).toBe('artifact-trail-styles');
      expect(m.injected).toBe(false);
    });
  });

  // =========================================================================
  // inject
  // =========================================================================

  describe('inject', () => {
    it('sets injected to true on first call', () => {
      manager.inject();
      expect(manager.injected).toBe(true);
    });

    it('logs trace on first injection', () => {
      manager.inject();
      expect(mockLog.trace).toHaveBeenCalledWith('styles loaded from external CSS');
    });

    it('is idempotent — second call does not log again', () => {
      manager.inject();
      mockLog.trace.mockClear();
      manager.inject();
      expect(mockLog.trace).not.toHaveBeenCalled();
    });

    it('remains injected=true after multiple calls', () => {
      manager.inject();
      manager.inject();
      manager.inject();
      expect(manager.injected).toBe(true);
    });

    it('can be re-injected after remove()', () => {
      manager.inject();
      manager.remove();
      expect(manager.injected).toBe(false);
      manager.inject();
      expect(manager.injected).toBe(true);
    });
  });

  // =========================================================================
  // remove
  // =========================================================================

  describe('remove', () => {
    it('sets injected to false', () => {
      manager.inject();
      manager.remove();
      expect(manager.injected).toBe(false);
    });

    it('logs trace message', () => {
      manager.remove();
      expect(mockLog.trace).toHaveBeenCalledWith(
        'styles managed via external CSS; no cleanup required'
      );
    });

    it('can be called when already not injected', () => {
      expect(manager.injected).toBe(false);
      manager.remove();
      expect(manager.injected).toBe(false);
    });

    it('sets injected to false even if never injected', () => {
      manager.remove();
      expect(manager.injected).toBe(false);
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('delegates to remove()', () => {
      manager.inject();
      manager.dispose();
      expect(manager.injected).toBe(false);
    });

    it('logs the same trace as remove()', () => {
      manager.dispose();
      expect(mockLog.trace).toHaveBeenCalledWith(
        'styles managed via external CSS; no cleanup required'
      );
    });

    it('can be called multiple times without error', () => {
      manager.dispose();
      manager.dispose();
      expect(manager.injected).toBe(false);
    });
  });

  // =========================================================================
  // Full lifecycle
  // =========================================================================

  describe('full lifecycle', () => {
    it('inject → remove → re-inject → dispose cycle', () => {
      manager.inject();
      expect(manager.injected).toBe(true);

      manager.remove();
      expect(manager.injected).toBe(false);

      manager.inject();
      expect(manager.injected).toBe(true);

      manager.dispose();
      expect(manager.injected).toBe(false);
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports TrailStyleManager constructor', () => {
      expect(typeof TrailStyleManager).toBe('function');
    });

    it('instances have inject, remove, dispose methods', () => {
      expect(typeof manager.inject).toBe('function');
      expect(typeof manager.remove).toBe('function');
      expect(typeof manager.dispose).toBe('function');
    });
  });
});
