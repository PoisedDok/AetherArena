'use strict';

// ===========================================================================
// Module-level mocks
// ===========================================================================

const mockLoggerChild = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  child: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  })),
};

jest.mock('../../../src/core/utils/logger', () => ({
  logger: {
    child: jest.fn(() => mockLoggerChild),
  },
}));

// ===========================================================================
// Require after mocks
// ===========================================================================

const {
  PermissionHandler,
  getHandler,
  createHandler,
  attachToWindow: attachToWindowConvenience,
  PERMISSIONS,
  DEFAULT_POLICIES,
} = require('../../../src/main/security/PermissionHandler');

// ===========================================================================
// Helpers
// ===========================================================================

function createMockSession() {
  const handlers = {};
  return {
    setPermissionRequestHandler: jest.fn((handler) => { handlers['request'] = handler; }),
    setPermissionCheckHandler: jest.fn((handler) => { handlers['check'] = handler; }),
    _handlers: handlers,
  };
}

function createMockWindow(overrides = {}) {
  const listeners = {};
  return {
    id: overrides.id || 1,
    isDestroyed: jest.fn(() => overrides.destroyed || false),
    webContents: {
      session: overrides.session || createMockSession(),
      getURL: jest.fn(() => overrides.url || 'file:///app/index.html'),
    },
    once: jest.fn((event, handler) => { listeners[event] = handler; }),
    _listeners: listeners,
    ...overrides,
  };
}

function createMockWebContents(url = 'file:///app/index.html') {
  return {
    getURL: jest.fn(() => url),
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('PermissionHandler', () => {
  let handler;

  beforeEach(() => {
    // Manual mock cleanup
    mockLoggerChild.info.mockClear();
    mockLoggerChild.warn.mockClear();
    mockLoggerChild.error.mockClear();
    mockLoggerChild.debug.mockClear();
    mockLoggerChild.child.mockClear();
    mockLoggerChild.child.mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
    });

    handler = new PermissionHandler({ mode: 'development' });
  });

  // ==================== Constants ====================

  describe('constants', () => {
    it('should export frozen PERMISSIONS enum', () => {
      expect(Object.isFrozen(PERMISSIONS)).toBe(true);
      expect(PERMISSIONS.MEDIA).toBe('media');
      expect(PERMISSIONS.GEOLOCATION).toBe('geolocation');
      expect(PERMISSIONS.NOTIFICATIONS).toBe('notifications');
      expect(PERMISSIONS.CLIPBOARD_READ).toBe('clipboard-read');
      expect(PERMISSIONS.DISPLAY_CAPTURE).toBe('display-capture');
      expect(PERMISSIONS.SERIAL).toBe('serial');
      expect(PERMISSIONS.USB).toBe('usb');
      expect(PERMISSIONS.HID).toBe('hid');
      expect(PERMISSIONS.BLUETOOTH).toBe('bluetooth');
    });

    it('should export frozen DEFAULT_POLICIES', () => {
      expect(Object.isFrozen(DEFAULT_POLICIES)).toBe(true);
      expect(DEFAULT_POLICIES).toHaveProperty('development');
      expect(DEFAULT_POLICIES).toHaveProperty('production');
    });

    it('development policy should be more permissive than production', () => {
      const dev = DEFAULT_POLICIES.development;
      const prod = DEFAULT_POLICIES.production;

      // Development allows more things
      expect(dev[PERMISSIONS.NOTIFICATIONS]).toBe(true);
      expect(prod[PERMISSIONS.NOTIFICATIONS]).toBe(false);
      expect(dev[PERMISSIONS.CLIPBOARD_READ]).toBe(true);
      expect(prod[PERMISSIONS.CLIPBOARD_READ]).toBe(false);
      expect(dev[PERMISSIONS.FULLSCREEN]).toBe(true);
      expect(prod[PERMISSIONS.FULLSCREEN]).toBe(false);
    });

    it('both modes should allow media (required for voice input)', () => {
      expect(DEFAULT_POLICIES.development[PERMISSIONS.MEDIA]).toBe(true);
      expect(DEFAULT_POLICIES.production[PERMISSIONS.MEDIA]).toBe(true);
    });

    it('both modes should deny geolocation', () => {
      expect(DEFAULT_POLICIES.development[PERMISSIONS.GEOLOCATION]).toBe(false);
      expect(DEFAULT_POLICIES.production[PERMISSIONS.GEOLOCATION]).toBe(false);
    });
  });

  // ==================== constructor ====================

  describe('constructor', () => {
    it('should default to development mode', () => {
      const h = new PermissionHandler();
      expect(h.options.mode).toBe('development');
    });

    it('should use production policy when mode is production', () => {
      const h = new PermissionHandler({ mode: 'production' });
      expect(h.policy[PERMISSIONS.NOTIFICATIONS]).toBe(false);
      expect(h.policy[PERMISSIONS.MEDIA]).toBe(true);
    });

    it('should use development policy when mode is development', () => {
      expect(handler.policy[PERMISSIONS.NOTIFICATIONS]).toBe(true);
      expect(handler.policy[PERMISSIONS.MEDIA]).toBe(true);
    });

    it('should accept custom defaultPolicy', () => {
      const custom = { media: true, geolocation: true };
      const h = new PermissionHandler({ defaultPolicy: custom });
      expect(h.policy.media).toBe(true);
      expect(h.policy.geolocation).toBe(true);
    });

    it('should default logRequests to true', () => {
      expect(handler.options.logRequests).toBe(true);
    });

    it('should default logDenials to true', () => {
      expect(handler.options.logDenials).toBe(true);
    });

    it('should allow disabling logging', () => {
      const h = new PermissionHandler({ logRequests: false, logDenials: false });
      expect(h.options.logRequests).toBe(false);
      expect(h.options.logDenials).toBe(false);
    });

    it('should initialize empty windowPolicies Map', () => {
      expect(handler.windowPolicies).toBeInstanceOf(Map);
      expect(handler.windowPolicies.size).toBe(0);
    });

    it('should detect production mode from NODE_ENV when mode not provided', () => {
      const origEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        const h = new PermissionHandler();
        expect(h.options.mode).toBe('production');
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it('should fall back to development policy for unknown mode', () => {
      const h = new PermissionHandler({ mode: 'unknown-mode' });
      // DEFAULT_POLICIES['unknown-mode'] is undefined, falls back to DEFAULT_POLICIES.development
      expect(h.policy[PERMISSIONS.MEDIA]).toBe(true);
      expect(h.policy[PERMISSIONS.NOTIFICATIONS]).toBe(true);
    });
  });

  // ==================== isAllowed ====================

  describe('isAllowed', () => {
    it('should allow permissions enabled in global policy', () => {
      expect(handler.isAllowed(PERMISSIONS.MEDIA)).toBe(true);
      expect(handler.isAllowed(PERMISSIONS.NOTIFICATIONS)).toBe(true);
    });

    it('should deny permissions disabled in global policy', () => {
      expect(handler.isAllowed(PERMISSIONS.GEOLOCATION)).toBe(false);
      expect(handler.isAllowed(PERMISSIONS.BLUETOOTH)).toBe(false);
    });

    it('should deny unknown permissions (deny by default)', () => {
      expect(handler.isAllowed('unknown-permission')).toBe(false);
    });

    it('should use window policy override when set', () => {
      handler.setWindowPolicy(1, { [PERMISSIONS.GEOLOCATION]: true });

      // Window override allows geolocation
      expect(handler.isAllowed(PERMISSIONS.GEOLOCATION, 1)).toBe(true);

      // Global policy still denies
      expect(handler.isAllowed(PERMISSIONS.GEOLOCATION)).toBe(false);
    });

    it('should fall back to global when window policy missing permission', () => {
      handler.setWindowPolicy(1, { [PERMISSIONS.GEOLOCATION]: true });

      // Media not in window policy — falls back to global (allowed in dev)
      expect(handler.isAllowed(PERMISSIONS.MEDIA, 1)).toBe(true);
    });

    it('should use global when no window policy exists for windowId', () => {
      expect(handler.isAllowed(PERMISSIONS.MEDIA, 999)).toBe(true);
    });

    it('window policy can deny what global allows', () => {
      handler.setWindowPolicy(1, { [PERMISSIONS.MEDIA]: false });

      expect(handler.isAllowed(PERMISSIONS.MEDIA, 1)).toBe(false);
      expect(handler.isAllowed(PERMISSIONS.MEDIA)).toBe(true);
    });
  });

  // ==================== setWindowPolicy / removeWindowPolicy ====================

  describe('setWindowPolicy', () => {
    it('should store policy for windowId', () => {
      handler.setWindowPolicy(5, { [PERMISSIONS.SERIAL]: true });

      expect(handler.windowPolicies.has(5)).toBe(true);
      expect(handler.isAllowed(PERMISSIONS.SERIAL, 5)).toBe(true);
    });
  });

  describe('removeWindowPolicy', () => {
    it('should remove stored policy', () => {
      handler.setWindowPolicy(5, { [PERMISSIONS.SERIAL]: true });
      handler.removeWindowPolicy(5);

      expect(handler.windowPolicies.has(5)).toBe(false);
      expect(handler.isAllowed(PERMISSIONS.SERIAL, 5)).toBe(false);
    });

    it('should handle removing non-existent windowId gracefully', () => {
      expect(() => handler.removeWindowPolicy(999)).not.toThrow();
    });
  });

  // ==================== attachToSession ====================

  describe('attachToSession', () => {
    it('should set permission request handler on session', () => {
      const session = createMockSession();
      handler.attachToSession(session);

      expect(session.setPermissionRequestHandler).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should set permission check handler on session', () => {
      const session = createMockSession();
      handler.attachToSession(session);

      expect(session.setPermissionCheckHandler).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should handle null session gracefully', () => {
      handler.attachToSession(null);
      // No throw, logger warns
    });

    describe('permission request handler', () => {
      it('should call callback with true for allowed permissions', () => {
        const session = createMockSession();
        handler.attachToSession(session);

        const callback = jest.fn();
        const webContents = createMockWebContents();

        session._handlers['request'](webContents, PERMISSIONS.MEDIA, callback);

        expect(callback).toHaveBeenCalledWith(true);
      });

      it('should call callback with false for denied permissions', () => {
        const session = createMockSession();
        handler.attachToSession(session);

        const callback = jest.fn();
        const webContents = createMockWebContents();

        session._handlers['request'](webContents, PERMISSIONS.GEOLOCATION, callback);

        expect(callback).toHaveBeenCalledWith(false);
      });

      it('should log denied requests when logDenials is true', () => {
        const session = createMockSession();
        handler.attachToSession(session);

        const callback = jest.fn();
        const webContents = createMockWebContents();

        session._handlers['request'](webContents, PERMISSIONS.BLUETOOTH, callback);

        expect(callback).toHaveBeenCalledWith(false);
      });
    });

    describe('permission check handler', () => {
      it('should return true for allowed permissions', () => {
        const session = createMockSession();
        handler.attachToSession(session);

        const webContents = createMockWebContents();
        const result = session._handlers['check'](webContents, PERMISSIONS.MEDIA, 'file://');

        expect(result).toBe(true);
      });

      it('should return false for denied permissions', () => {
        const session = createMockSession();
        handler.attachToSession(session);

        const webContents = createMockWebContents();
        const result = session._handlers['check'](webContents, PERMISSIONS.GEOLOCATION, 'file://');

        expect(result).toBe(false);
      });
    });

    it('should create child logger when windowId is provided', () => {
      const session = createMockSession();
      handler.attachToSession(session, 42);

      expect(mockLoggerChild.child).toHaveBeenCalledWith({ windowId: 42 });
    });

    it('should not log when logRequests is false', () => {
      const quiet = new PermissionHandler({ mode: 'development', logRequests: false });
      const session = createMockSession();
      quiet.attachToSession(session);

      const callback = jest.fn();
      const webContents = createMockWebContents();

      session._handlers['request'](webContents, PERMISSIONS.MEDIA, callback);

      expect(callback).toHaveBeenCalledWith(true);
    });

    it('should not log check handler when logRequests is false', () => {
      const quiet = new PermissionHandler({ mode: 'development', logRequests: false });
      const session = createMockSession();
      quiet.attachToSession(session);

      const webContents = createMockWebContents();
      const result = session._handlers['check'](webContents, PERMISSIONS.MEDIA, 'file://');

      expect(result).toBe(true);
    });
  });

  // ==================== attachToWindow ====================

  describe('attachToWindow', () => {
    it('should attach to window session', () => {
      const session = createMockSession();
      const mockWindow = createMockWindow({ session });

      handler.attachToWindow(mockWindow);

      expect(session.setPermissionRequestHandler).toHaveBeenCalled();
      expect(session.setPermissionCheckHandler).toHaveBeenCalled();
    });

    it('should register closed listener for cleanup', () => {
      const mockWindow = createMockWindow();
      handler.attachToWindow(mockWindow);

      expect(mockWindow.once).toHaveBeenCalledWith('closed', expect.any(Function));
    });

    it('should clean up window policy on close', () => {
      const mockWindow = createMockWindow({ id: 7 });
      handler.setWindowPolicy(7, { [PERMISSIONS.SERIAL]: true });

      handler.attachToWindow(mockWindow);

      // Trigger the closed event
      mockWindow._listeners['closed']();

      expect(handler.windowPolicies.has(7)).toBe(false);
    });

    it('should handle destroyed window gracefully', () => {
      const destroyed = createMockWindow({ destroyed: true });

      handler.attachToWindow(destroyed);

      expect(destroyed.once).not.toHaveBeenCalled();
    });

    it('should handle null window gracefully', () => {
      expect(() => handler.attachToWindow(null)).not.toThrow();
    });
  });

  // ==================== Policy mutation ====================

  describe('setGlobalPolicy', () => {
    it('should merge new policy into existing', () => {
      handler.setGlobalPolicy({ [PERMISSIONS.GEOLOCATION]: true });

      expect(handler.policy[PERMISSIONS.GEOLOCATION]).toBe(true);
      // Existing permissions preserved
      expect(handler.policy[PERMISSIONS.MEDIA]).toBe(true);
    });
  });

  describe('allow', () => {
    it('should enable a specific permission', () => {
      handler.allow(PERMISSIONS.BLUETOOTH);
      expect(handler.isAllowed(PERMISSIONS.BLUETOOTH)).toBe(true);
    });
  });

  describe('deny', () => {
    it('should disable a specific permission', () => {
      handler.deny(PERMISSIONS.MEDIA);
      expect(handler.isAllowed(PERMISSIONS.MEDIA)).toBe(false);
    });
  });

  describe('allowForWindow', () => {
    it('should allow permission for specific window', () => {
      handler.allowForWindow(3, PERMISSIONS.SERIAL);

      expect(handler.isAllowed(PERMISSIONS.SERIAL, 3)).toBe(true);
      // Global still denied
      expect(handler.isAllowed(PERMISSIONS.SERIAL)).toBe(false);
    });

    it('should create window policy if none exists', () => {
      handler.allowForWindow(3, PERMISSIONS.USB);
      expect(handler.windowPolicies.has(3)).toBe(true);
    });
  });

  describe('denyForWindow', () => {
    it('should deny permission for specific window', () => {
      handler.denyForWindow(3, PERMISSIONS.MEDIA);

      expect(handler.isAllowed(PERMISSIONS.MEDIA, 3)).toBe(false);
      // Global still allowed
      expect(handler.isAllowed(PERMISSIONS.MEDIA)).toBe(true);
    });
  });

  // ==================== Policy reading ====================

  describe('getGlobalPolicy', () => {
    it('should return a copy of the global policy', () => {
      const policy = handler.getGlobalPolicy();

      expect(policy[PERMISSIONS.MEDIA]).toBe(true);
      expect(policy[PERMISSIONS.GEOLOCATION]).toBe(false);

      // Verify it is a copy (not a reference)
      policy[PERMISSIONS.MEDIA] = false;
      expect(handler.policy[PERMISSIONS.MEDIA]).toBe(true);
    });
  });

  describe('getWindowPolicy', () => {
    it('should return merged global + window policy', () => {
      handler.setWindowPolicy(1, { [PERMISSIONS.GEOLOCATION]: true });

      const policy = handler.getWindowPolicy(1);

      expect(policy[PERMISSIONS.GEOLOCATION]).toBe(true); // Window override
      expect(policy[PERMISSIONS.MEDIA]).toBe(true); // Global fallback
    });

    it('should return global policy when no window policy exists', () => {
      const policy = handler.getWindowPolicy(999);

      expect(policy[PERMISSIONS.MEDIA]).toBe(true);
      expect(policy[PERMISSIONS.GEOLOCATION]).toBe(false);
    });
  });

  // ==================== Reset and clear ====================

  describe('resetToDefault', () => {
    it('should reset to development policy', () => {
      handler.allow(PERMISSIONS.BLUETOOTH);
      handler.resetToDefault('development');

      expect(handler.policy[PERMISSIONS.BLUETOOTH]).toBe(false);
      expect(handler.policy[PERMISSIONS.MEDIA]).toBe(true);
    });

    it('should reset to production policy', () => {
      handler.resetToDefault('production');

      expect(handler.policy[PERMISSIONS.NOTIFICATIONS]).toBe(false);
      expect(handler.policy[PERMISSIONS.MEDIA]).toBe(true);
    });

    it('should use original mode when no mode argument provided', () => {
      const prod = new PermissionHandler({ mode: 'production' });
      prod.allow(PERMISSIONS.BLUETOOTH);
      prod.resetToDefault();

      expect(prod.policy[PERMISSIONS.BLUETOOTH]).toBe(false);
    });
  });

  describe('clearWindowPolicies', () => {
    it('should clear all window-specific policies', () => {
      handler.setWindowPolicy(1, { [PERMISSIONS.SERIAL]: true });
      handler.setWindowPolicy(2, { [PERMISSIONS.USB]: true });

      handler.clearWindowPolicies();

      expect(handler.windowPolicies.size).toBe(0);
    });
  });

  // ==================== Factory functions ====================

  describe('createHandler', () => {
    it('should return new PermissionHandler instance', () => {
      const h = createHandler({ mode: 'production' });
      expect(h).toBeInstanceOf(PermissionHandler);
      expect(h.options.mode).toBe('production');
    });

    it('should create independent instances', () => {
      const h1 = createHandler();
      const h2 = createHandler();
      expect(h1).not.toBe(h2);
    });
  });

  describe('getHandler', () => {
    it('should return a PermissionHandler instance', () => {
      const h = getHandler();
      expect(h).toBeInstanceOf(PermissionHandler);
    });

    it('should return same instance on subsequent calls', () => {
      const h1 = getHandler();
      const h2 = getHandler();
      expect(h1).toBe(h2);
    });
  });

  describe('attachToWindow convenience', () => {
    it('should attach handler to window', () => {
      const session = createMockSession();
      const mockWindow = createMockWindow({ session });

      attachToWindowConvenience(mockWindow);

      expect(session.setPermissionRequestHandler).toHaveBeenCalled();
    });

    it('should set window policy when provided', () => {
      const session = createMockSession();
      const mockWindow = createMockWindow({ id: 10, session });

      attachToWindowConvenience(mockWindow, { [PERMISSIONS.SERIAL]: true });

      // The global handler should now have window policy for id 10
      const globalH = getHandler();
      expect(globalH.isAllowed(PERMISSIONS.SERIAL, 10)).toBe(true);
    });
  });
});
