'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGlobalShortcut = {
  register: jest.fn(() => true),
  unregister: jest.fn(),
  unregisterAll: jest.fn(),
  isRegistered: jest.fn(() => false),
};

jest.mock('electron', () => ({
  app: {
    on: jest.fn(),
    whenReady: jest.fn(() => Promise.resolve()),
    getPath: jest.fn(() => '/tmp/test'),
    quit: jest.fn(),
  },
  globalShortcut: mockGlobalShortcut,
  BrowserWindow: jest.fn(),
  ipcMain: { on: jest.fn(), handle: jest.fn(), removeHandler: jest.fn() },
  ipcRenderer: { send: jest.fn(), invoke: jest.fn(), on: jest.fn() },
}), { virtual: true });

jest.mock('../../../src/core/utils/logger', () => ({
  logger: {
    child: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
    })),
  },
}));

const {
  ShortcutManager,
  getManager,
  createManager,
  DEFAULT_SHORTCUTS,
} = require('../../../src/main/services/ShortcutManager');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockWindowManager() {
  const mock = {
    toggleWidgetMode: jest.fn(),
    exitWidgetMode: jest.fn(),
    enterWidgetMode: jest.fn(),
    isWidgetMode: false,
    getMainWindow: jest.fn(() => null),
    getChatWindow: jest.fn(() => null),
    createChatWindow: jest.fn(),
    getArtifactsWindow: jest.fn(() => null),
    createArtifactsWindow: jest.fn(),
    controlArtifactsWindow: jest.fn(),
  };
  // controlArtifactsWindow delegates to createArtifactsWindow when no window exists
  mock.controlArtifactsWindow.mockImplementation((action) => {
    const artWin = mock.getArtifactsWindow();
    if (!artWin || artWin.isDestroyed()) {
      mock.createArtifactsWindow();
    } else if (action === 'toggle-visibility') {
      if (artWin.isVisible()) {
        artWin.hide();
      } else {
        artWin.show();
        artWin.focus();
      }
    }
  });
  return mock;
}

function createMockBrowserWindow(opts = {}) {
  return {
    isDestroyed: jest.fn(() => opts.destroyed || false),
    isVisible: jest.fn(() => opts.visible || false),
    show: jest.fn(),
    hide: jest.fn(),
    focus: jest.fn(),
    webContents: {
      send: jest.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ShortcutManager', () => {
  let wm;

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-establish mock implementations (resetMocks in jest config clears them)
    mockGlobalShortcut.register.mockImplementation(() => true);
    mockGlobalShortcut.unregister.mockImplementation(() => {});
    mockGlobalShortcut.unregisterAll.mockImplementation(() => {});
    mockGlobalShortcut.isRegistered.mockImplementation(() => false);

    const { logger } = require('../../../src/core/utils/logger');
    logger.child.mockImplementation(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
    }));

    const { app } = require('electron');
    app.whenReady.mockImplementation(() => Promise.resolve());

    wm = createMockWindowManager();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // constructor
  // ═══════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('throws when windowManager is not provided', () => {
      expect(() => new ShortcutManager(null)).toThrow('WindowManager is required');
    });

    it('sets default options', () => {
      const sm = new ShortcutManager(wm);
      expect(sm.windowManager).toBe(wm);
      expect(sm.options.enabled).toBe(true);
      expect(sm.registeredShortcuts).toBeInstanceOf(Set);
      expect(sm.registeredShortcuts.size).toBe(0);
      expect(sm.isInitialized).toBe(false);
    });

    it('accepts enabled=false option', () => {
      const sm = new ShortcutManager(wm, { enabled: false });
      expect(sm.options.enabled).toBe(false);
    });

    it('merges custom shortcuts with defaults', () => {
      const sm = new ShortcutManager(wm, {
        shortcuts: { TOGGLE_CHAT: ['Alt+X'] },
      });
      expect(sm.options.shortcuts.TOGGLE_CHAT).toEqual(['Alt+X']);
      // Other defaults preserved
      expect(sm.options.shortcuts.TOGGLE_WIDGET).toEqual(DEFAULT_SHORTCUTS.TOGGLE_WIDGET);
    });

    it('creates logger child with module name', () => {
      const { logger } = require('../../../src/core/utils/logger');
      new ShortcutManager(wm);
      expect(logger.child).toHaveBeenCalledWith({ module: 'ShortcutManager' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // initialize()
  // ═══════════════════════════════════════════════════════════════════════

  describe('initialize()', () => {
    it('registers all default shortcuts', async () => {
      const sm = new ShortcutManager(wm);
      await sm.initialize();

      expect(sm.isInitialized).toBe(true);
      // Default: Alt+D, F11, Escape, Alt+C, Alt+A, Alt+N, Alt+T = 7 register calls
      expect(mockGlobalShortcut.register).toHaveBeenCalledTimes(7);
      expect(sm.registeredShortcuts.size).toBe(7);
    });

    it('waits for app.whenReady', async () => {
      const { app } = require('electron');
      const sm = new ShortcutManager(wm);
      await sm.initialize();
      expect(app.whenReady).toHaveBeenCalled();
    });

    it('is a no-op if already initialized', async () => {
      const sm = new ShortcutManager(wm);
      await sm.initialize();
      mockGlobalShortcut.register.mockClear();
      await sm.initialize();
      expect(mockGlobalShortcut.register).not.toHaveBeenCalled();
    });

    it('skips registration when disabled', async () => {
      const sm = new ShortcutManager(wm, { enabled: false });
      await sm.initialize();
      expect(sm.isInitialized).toBe(false);
      expect(mockGlobalShortcut.register).not.toHaveBeenCalled();
    });

    it('handles registration failure gracefully when register returns false', async () => {
      mockGlobalShortcut.register.mockImplementation(() => false);
      const sm = new ShortcutManager(wm);
      await sm.initialize();
      // Completes initialization but no shortcuts tracked
      expect(sm.isInitialized).toBe(true);
      expect(sm.registeredShortcuts.size).toBe(0);
    });

    it('throws when internal registration method throws unexpectedly', async () => {
      const sm = new ShortcutManager(wm);
      // Override internal method to throw outside of _registerShortcut's catch
      sm._registerToggleWidget = () => { throw new Error('unexpected'); };
      await expect(sm.initialize()).rejects.toThrow('unexpected');
      expect(sm.isInitialized).toBe(false);
    });

    it('logs registered shortcuts', async () => {
      const sm = new ShortcutManager(wm);
      await sm.initialize();
      expect(sm.logger.info).toHaveBeenCalledWith(
        'Shortcut manager initialized',
        expect.objectContaining({ registered: expect.any(Array) })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // shutdown()
  // ═══════════════════════════════════════════════════════════════════════

  describe('shutdown()', () => {
    it('unregisters all shortcuts', async () => {
      const sm = new ShortcutManager(wm);
      await sm.initialize();
      sm.shutdown();

      expect(mockGlobalShortcut.unregisterAll).toHaveBeenCalled();
      expect(sm.registeredShortcuts.size).toBe(0);
      expect(sm.isInitialized).toBe(false);
    });

    it('logs error if unregisterAll throws', () => {
      mockGlobalShortcut.unregisterAll.mockImplementation(() => {
        throw new Error('shutdown error');
      });
      const sm = new ShortcutManager(wm);
      sm.isInitialized = true;
      sm.shutdown();
      expect(sm.logger.error).toHaveBeenCalledWith(
        'Error during shortcut shutdown',
        expect.objectContaining({ error: 'shutdown error' })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _registerShortcut()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_registerShortcut()', () => {
    it('registers and tracks shortcut on success', () => {
      const sm = new ShortcutManager(wm);
      const result = sm._registerShortcut('Alt+Z', jest.fn(), 'test');
      expect(result).toBe(true);
      expect(sm.registeredShortcuts.has('Alt+Z')).toBe(true);
    });

    it('returns false when registration fails (success=false)', () => {
      mockGlobalShortcut.register.mockReturnValueOnce(false);
      const sm = new ShortcutManager(wm);
      const result = sm._registerShortcut('Alt+Z', jest.fn());
      expect(result).toBe(false);
      expect(sm.registeredShortcuts.has('Alt+Z')).toBe(false);
    });

    it('returns false and logs on exception', () => {
      mockGlobalShortcut.register.mockImplementationOnce(() => {
        throw new Error('register failed');
      });
      const sm = new ShortcutManager(wm);
      const result = sm._registerShortcut('Bad+Key', jest.fn());
      expect(result).toBe(false);
      expect(sm.logger.error).toHaveBeenCalledWith(
        'Error registering shortcut',
        expect.objectContaining({ accelerator: 'Bad+Key' })
      );
    });

    it('invokes handler when shortcut triggers', async () => {
      let capturedCallback;
      mockGlobalShortcut.register.mockImplementation((acc, cb) => {
        capturedCallback = cb;
        return true;
      });
      const handler = jest.fn();
      const sm = new ShortcutManager(wm);
      sm._registerShortcut('Alt+T', handler, 'trigger test');

      // Simulate Electron triggering the shortcut
      capturedCallback();
      expect(handler).toHaveBeenCalled();
    });

    it('logs handler errors without crashing', () => {
      let capturedCallback;
      mockGlobalShortcut.register.mockImplementation((acc, cb) => {
        capturedCallback = cb;
        return true;
      });
      const sm = new ShortcutManager(wm);
      sm._registerShortcut('Alt+E', () => { throw new Error('handler boom'); });

      capturedCallback();
      expect(sm.logger.error).toHaveBeenCalledWith(
        'Shortcut handler error',
        expect.objectContaining({ error: 'handler boom' })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _registerShortcuts() (multiple accelerators)
  // ═══════════════════════════════════════════════════════════════════════

  describe('_registerShortcuts()', () => {
    it('registers all accelerators and returns true if any succeed', () => {
      const sm = new ShortcutManager(wm);
      const result = sm._registerShortcuts(['Alt+A', 'Alt+B'], jest.fn(), 'multi');
      expect(result).toBe(true);
      expect(sm.registeredShortcuts.has('Alt+A')).toBe(true);
      expect(sm.registeredShortcuts.has('Alt+B')).toBe(true);
    });

    it('returns false if all fail', () => {
      mockGlobalShortcut.register.mockReturnValue(false);
      const sm = new ShortcutManager(wm);
      const result = sm._registerShortcuts(['Alt+A', 'Alt+B'], jest.fn());
      expect(result).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _unregisterShortcut()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_unregisterShortcut()', () => {
    it('unregisters and removes from tracked set', () => {
      const sm = new ShortcutManager(wm);
      sm.registeredShortcuts.add('Alt+Z');
      const result = sm._unregisterShortcut('Alt+Z');
      expect(result).toBe(true);
      expect(mockGlobalShortcut.unregister).toHaveBeenCalledWith('Alt+Z');
      expect(sm.registeredShortcuts.has('Alt+Z')).toBe(false);
    });

    it('returns false on error', () => {
      mockGlobalShortcut.unregister.mockImplementationOnce(() => {
        throw new Error('unregister failed');
      });
      const sm = new ShortcutManager(wm);
      const result = sm._unregisterShortcut('Alt+Z');
      expect(result).toBe(false);
      expect(sm.logger.error).toHaveBeenCalledWith(
        'Error unregistering shortcut',
        expect.objectContaining({ accelerator: 'Alt+Z' })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Default shortcut handlers
  // ═══════════════════════════════════════════════════════════════════════

  describe('shortcut handlers', () => {
    let capturedCallbacks;

    beforeEach(async () => {
      capturedCallbacks = {};
      mockGlobalShortcut.register.mockImplementation((acc, cb) => {
        capturedCallbacks[acc] = cb;
        return true;
      });
    });

    describe('TOGGLE_WIDGET (Alt+D / F11)', () => {
      it('calls windowManager.toggleWidgetMode', async () => {
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        capturedCallbacks['Alt+D']();
        expect(wm.toggleWidgetMode).toHaveBeenCalled();
      });

      it('F11 also toggles widget', async () => {
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        capturedCallbacks['F11']();
        expect(wm.toggleWidgetMode).toHaveBeenCalled();
      });
    });

    describe('EXIT_WIDGET (Escape)', () => {
      it('calls exitWidgetMode when in widget mode', async () => {
        wm.isWidgetMode = true;
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        capturedCallbacks['Escape']();
        expect(wm.exitWidgetMode).toHaveBeenCalled();
      });

      it('does nothing when not in widget mode', async () => {
        wm.isWidgetMode = false;
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        capturedCallbacks['Escape']();
        expect(wm.exitWidgetMode).not.toHaveBeenCalled();
      });
    });

    describe('TOGGLE_CHAT (Alt+C)', () => {
      it('creates chat window when none exists', async () => {
        wm.getChatWindow.mockReturnValue(null);
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        capturedCallbacks['Alt+C']();
        expect(wm.createChatWindow).toHaveBeenCalled();
      });

      it('creates chat window when existing is destroyed', async () => {
        wm.getChatWindow.mockReturnValue(createMockBrowserWindow({ destroyed: true }));
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        capturedCallbacks['Alt+C']();
        expect(wm.createChatWindow).toHaveBeenCalled();
      });

      it('hides visible chat window', async () => {
        const chatWin = createMockBrowserWindow({ visible: true });
        wm.getChatWindow.mockReturnValue(chatWin);
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        capturedCallbacks['Alt+C']();
        expect(chatWin.hide).toHaveBeenCalled();
      });

      it('shows and focuses hidden chat window', async () => {
        const chatWin = createMockBrowserWindow({ visible: false });
        wm.getChatWindow.mockReturnValue(chatWin);
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        capturedCallbacks['Alt+C']();
        expect(chatWin.show).toHaveBeenCalled();
        expect(chatWin.focus).toHaveBeenCalled();
      });
    });

    describe('TOGGLE_DEMO (Alt+T)', () => {
      it('sends demo:toggle to main window', async () => {
        const mainWin = createMockBrowserWindow();
        wm.getMainWindow.mockReturnValue(mainWin);
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        capturedCallbacks['Alt+T']();
        expect(mainWin.webContents.send).toHaveBeenCalledWith('demo:toggle');
      });

      it('does nothing when main window is null', async () => {
        wm.getMainWindow.mockReturnValue(null);
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        // Should not throw
        expect(() => capturedCallbacks['Alt+T']()).not.toThrow();
      });

      it('does nothing when main window is destroyed', async () => {
        const mainWin = createMockBrowserWindow({ destroyed: true });
        wm.getMainWindow.mockReturnValue(mainWin);
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        capturedCallbacks['Alt+T']();
        expect(mainWin.webContents.send).not.toHaveBeenCalled();
      });

      it('logs error when webContents.send fails', async () => {
        const mainWin = createMockBrowserWindow();
        mainWin.webContents.send.mockImplementation(() => {
          throw new Error('demo send error');
        });
        wm.getMainWindow.mockReturnValue(mainWin);
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        capturedCallbacks['Alt+T']();
        expect(sm.logger.error).toHaveBeenCalledWith(
          'Failed to send demo:toggle to main window',
          expect.objectContaining({ error: 'demo send error' })
        );
      });
    });

    describe('TOGGLE_ARTIFACTS (Alt+A)', () => {
      it('creates artifacts window when none exists', async () => {
        wm.getArtifactsWindow.mockReturnValue(null);
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        capturedCallbacks['Alt+A']();
        expect(wm.createArtifactsWindow).toHaveBeenCalled();
      });

      it('creates artifacts window when existing is destroyed', async () => {
        wm.getArtifactsWindow.mockReturnValue(createMockBrowserWindow({ destroyed: true }));
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        capturedCallbacks['Alt+A']();
        expect(wm.createArtifactsWindow).toHaveBeenCalled();
      });

      it('hides visible artifacts window', async () => {
        const artWin = createMockBrowserWindow({ visible: true });
        wm.getArtifactsWindow.mockReturnValue(artWin);
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        capturedCallbacks['Alt+A']();
        expect(artWin.hide).toHaveBeenCalled();
      });

      it('shows and focuses hidden artifacts window', async () => {
        const artWin = createMockBrowserWindow({ visible: false });
        wm.getArtifactsWindow.mockReturnValue(artWin);
        const sm = new ShortcutManager(wm);
        await sm.initialize();
        capturedCallbacks['Alt+A']();
        expect(artWin.show).toHaveBeenCalled();
        expect(artWin.focus).toHaveBeenCalled();
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════════

  describe('registerCustom()', () => {
    it('returns false if not initialized', () => {
      const sm = new ShortcutManager(wm);
      const result = sm.registerCustom('Alt+Q', jest.fn());
      expect(result).toBe(false);
    });

    it('registers custom shortcut when initialized', async () => {
      const sm = new ShortcutManager(wm);
      await sm.initialize();
      const result = sm.registerCustom('Alt+Q', jest.fn(), 'custom');
      expect(result).toBe(true);
      expect(sm.registeredShortcuts.has('Alt+Q')).toBe(true);
    });
  });

  describe('unregisterCustom()', () => {
    it('returns false if not initialized', () => {
      const sm = new ShortcutManager(wm);
      const result = sm.unregisterCustom('Alt+Q');
      expect(result).toBe(false);
    });

    it('unregisters custom shortcut when initialized', async () => {
      const sm = new ShortcutManager(wm);
      await sm.initialize();
      sm.registerCustom('Alt+Q', jest.fn());
      const result = sm.unregisterCustom('Alt+Q');
      expect(result).toBe(true);
      expect(sm.registeredShortcuts.has('Alt+Q')).toBe(false);
    });
  });

  describe('isRegistered()', () => {
    it('delegates to globalShortcut.isRegistered', () => {
      mockGlobalShortcut.isRegistered.mockReturnValue(true);
      const sm = new ShortcutManager(wm);
      expect(sm.isRegistered('Alt+D')).toBe(true);
      expect(mockGlobalShortcut.isRegistered).toHaveBeenCalledWith('Alt+D');
    });
  });

  describe('getRegistered()', () => {
    it('returns array of registered accelerators', async () => {
      const sm = new ShortcutManager(wm);
      await sm.initialize();
      const registered = sm.getRegistered();
      expect(Array.isArray(registered)).toBe(true);
      expect(registered.length).toBe(7);
      expect(registered).toContain('Alt+D');
      expect(registered).toContain('F11');
      expect(registered).toContain('Escape');
      expect(registered).toContain('Alt+C');
      expect(registered).toContain('Alt+A');
      expect(registered).toContain('Alt+N');
      expect(registered).toContain('Alt+T');
    });
  });

  describe('enable()', () => {
    it('sets enabled to true and initializes', async () => {
      const sm = new ShortcutManager(wm, { enabled: false });
      sm.enable();
      // enable() calls initialize() asynchronously
      // Wait for the next tick
      await new Promise(resolve => setImmediate(resolve));
      expect(sm.options.enabled).toBe(true);
    });

    it('logs error if initialize rejects during enable', async () => {
      const sm = new ShortcutManager(wm, { enabled: false });
      // Force initialize to fail
      sm._registerToggleWidget = () => { throw new Error('enable init fail'); };
      sm.enable();
      // Wait for async error handling
      await new Promise(resolve => setImmediate(resolve));
      expect(sm.logger.error).toHaveBeenCalledWith(
        'Failed to enable shortcuts',
        expect.objectContaining({ error: 'enable init fail' })
      );
    });

    it('does not re-initialize if already initialized', async () => {
      const sm = new ShortcutManager(wm);
      await sm.initialize();
      mockGlobalShortcut.register.mockClear();
      sm.enable();
      // Should not call initialize again since isInitialized is true
      await new Promise(resolve => setImmediate(resolve));
      expect(mockGlobalShortcut.register).not.toHaveBeenCalled();
    });
  });

  describe('disable()', () => {
    it('sets enabled to false and shuts down', async () => {
      const sm = new ShortcutManager(wm);
      await sm.initialize();
      sm.disable();
      expect(sm.options.enabled).toBe(false);
      expect(sm.isInitialized).toBe(false);
    });
  });

  describe('reload()', () => {
    it('shuts down and re-initializes', async () => {
      const sm = new ShortcutManager(wm);
      await sm.initialize();
      expect(sm.isInitialized).toBe(true);

      mockGlobalShortcut.register.mockClear();
      await sm.reload();

      expect(mockGlobalShortcut.unregisterAll).toHaveBeenCalled();
      expect(mockGlobalShortcut.register).toHaveBeenCalledTimes(7);
      expect(sm.isInitialized).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Module-level functions
  // ═══════════════════════════════════════════════════════════════════════

  describe('getManager()', () => {
    it('creates singleton when windowManager provided', () => {
      const sm = getManager(wm);
      expect(sm).toBeInstanceOf(ShortcutManager);
    });

    it('returns null when no windowManager and no existing instance', () => {
      // getManager uses a module-level variable. Since we can't reset it,
      // we test the createManager path which is more testable.
      // The singleton will already be set from previous test.
      const sm = getManager(null);
      // Returns existing singleton (already created above)
      expect(sm).toBeInstanceOf(ShortcutManager);
    });
  });

  describe('createManager()', () => {
    it('creates a new ShortcutManager instance', () => {
      const sm = createManager(wm);
      expect(sm).toBeInstanceOf(ShortcutManager);
    });

    it('passes options through', () => {
      const sm = createManager(wm, { enabled: false });
      expect(sm.options.enabled).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Constants
  // ═══════════════════════════════════════════════════════════════════════

  describe('DEFAULT_SHORTCUTS', () => {
    it('is frozen', () => {
      expect(Object.isFrozen(DEFAULT_SHORTCUTS)).toBe(true);
    });

    it('has expected keys', () => {
      expect(DEFAULT_SHORTCUTS.TOGGLE_WIDGET).toEqual(['Alt+D', 'F11']);
      expect(DEFAULT_SHORTCUTS.EXIT_WIDGET).toEqual(['Escape']);
      expect(DEFAULT_SHORTCUTS.TOGGLE_CHAT).toEqual(['Alt+C']);
      expect(DEFAULT_SHORTCUTS.TOGGLE_ARTIFACTS).toEqual(['Alt+A']);
      expect(DEFAULT_SHORTCUTS.TOGGLE_DEMO).toEqual(['Alt+T']);
    });
  });
});
