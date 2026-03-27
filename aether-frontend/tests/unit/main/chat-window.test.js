'use strict';

// =============================================================================
// Mocks (before require)
// =============================================================================

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

const mockWin = {
  on: jest.fn(),
  loadFile: jest.fn().mockResolvedValue(undefined),
  webContents: {
    send: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    openDevTools: jest.fn(),
    isLoading: jest.fn(() => false),
    isFocused: jest.fn(() => false),
    id: 2,
  },
  show: jest.fn(),
  hide: jest.fn(),
  close: jest.fn(),
  focus: jest.fn(),
  destroy: jest.fn(),
  minimize: jest.fn(),
  maximize: jest.fn(),
  unmaximize: jest.fn(),
  isDestroyed: jest.fn(() => false),
  isVisible: jest.fn(() => true),
  isMaximized: jest.fn(() => false),
  isFocused: jest.fn(() => false),
  getBounds: jest.fn(() => ({ x: 100, y: 100, width: 700, height: 500 })),
  setBounds: jest.fn(),
  setOpacity: jest.fn(),
  setBackgroundColor: jest.fn(),
  setBackgroundMaterial: jest.fn(),
};
const MockBrowserWindow = jest.fn(() => mockWin);

const mockScreen = {
  getPrimaryDisplay: jest.fn(() => ({
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  })),
  getDisplayMatching: jest.fn(() => ({
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  })),
  getCursorScreenPoint: jest.fn(() => ({ x: 0, y: 0 })),
};
jest.mock('electron', () => ({ BrowserWindow: MockBrowserWindow, screen: mockScreen }), { virtual: true });
jest.mock('../../../src/core/utils/logger', () => ({
  logger: { child: jest.fn(() => mockLog) },
}));

const mockConfig = {
  ui: {
    chatWindowBackgroundColor: '#00000000',
    enableNativeWindowEffects: false,
    macVibrancy: 'under-window',
    macVisualEffectState: 'active',
    windowsBackgroundMaterial: 'mica',
  },
  dev: { openDevToolsAux: false },
};
jest.mock('../../../src/core/config', () => mockConfig);
jest.mock('../../../src/main/utils/preload-utils', () => ({
  resolvePreloadPath: jest.fn(() => '/mock/preload/chat-preload.js'),
}));

const mockAttachExternal = jest.fn();
const mockAttachPermission = jest.fn();
jest.mock('../../../src/main/security/ExternalLinkHandler', () => ({ attachToWindow: mockAttachExternal }));
jest.mock('../../../src/main/security/PermissionHandler', () => ({
  attachToWindow: mockAttachPermission,
  PERMISSIONS: { CLIPBOARD_SANITIZED_WRITE: 'clipboard-sanitized-write' },
}));

const ChatWindow = require('../../../src/main/windows/ChatWindow');

// =============================================================================
// Helpers
// =============================================================================

function resetWin() {
  Object.values(mockWin).forEach(fn => { if (typeof fn === 'function' && fn.mockClear) fn.mockClear(); });
  Object.values(mockWin.webContents).forEach(fn => { if (typeof fn === 'function' && fn.mockClear) fn.mockClear(); });
  MockBrowserWindow.mockClear();
  mockWin.isDestroyed.mockReturnValue(false);
  mockWin.isVisible.mockReturnValue(true);
  mockWin.isMaximized.mockReturnValue(false);
  mockWin.isFocused.mockReturnValue(false);
  mockWin.getBounds.mockReturnValue({ x: 100, y: 100, width: 700, height: 500 });
  mockWin.loadFile.mockResolvedValue(undefined);
}

// =============================================================================
// Tests
// =============================================================================

describe('ChatWindow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetWin();
    mockConfig.ui.enableNativeWindowEffects = false;
    mockConfig.dev.openDevToolsAux = false;
    process.env.ELECTRON_DEV = 'false';
    process.env.NODE_ENV = 'test';
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('sets default dimensions', () => {
      const cw = new ChatWindow();
      expect(cw.options.width).toBe(520);
      expect(cw.options.height).toBe(640);
      expect(cw.options.isQuitting).toBe(false);
    });

    it('allows custom dimensions', () => {
      const cw = new ChatWindow({ width: 600, height: 800 });
      expect(cw.options.width).toBe(600);
      expect(cw.options.height).toBe(800);
    });

    it('initializes window as null', () => {
      expect(new ChatWindow().window).toBeNull();
    });

    it('initializes fade animation state', () => {
      const cw = new ChatWindow();
      expect(cw._fadeTimeoutId).toBeNull();
      expect(cw._isFading).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // setQuitting
  // ---------------------------------------------------------------------------

  describe('setQuitting()', () => {
    it('sets the isQuitting flag', () => {
      const cw = new ChatWindow();
      cw.setQuitting(true);
      expect(cw.options.isQuitting).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------

  describe('create()', () => {
    it('creates BrowserWindow with correct options', () => {
      const cw = new ChatWindow();
      const win = cw.create();

      expect(MockBrowserWindow).toHaveBeenCalledTimes(1);
      const opts = MockBrowserWindow.mock.calls[0][0];
      expect(opts.width).toBe(520);
      expect(opts.height).toBe(640);
      expect(opts.frame).toBe(false);
      expect(opts.transparent).toBe(true);
      expect(opts.resizable).toBe(true);
      expect(opts.webPreferences.contextIsolation).toBe(true);
      expect(opts.webPreferences.preload).toBe('/mock/preload/chat-preload.js');
      expect(win).toBe(mockWin);
    });

    it('returns existing window on double-create and shows it', () => {
      const cw = new ChatWindow();
      cw.create();
      mockWin.show.mockClear();
      const win2 = cw.create();
      expect(MockBrowserWindow).toHaveBeenCalledTimes(1);
      expect(mockWin.show).toHaveBeenCalledTimes(1);
      expect(win2).toBe(mockWin);
    });

    it('attaches security handlers', () => {
      const cw = new ChatWindow();
      cw.create();
      expect(mockAttachExternal).toHaveBeenCalledWith(mockWin);
      expect(mockAttachPermission).toHaveBeenCalledWith(mockWin, { 'clipboard-sanitized-write': true });
    });

    it('loads HTML file', () => {
      const cw = new ChatWindow();
      cw.create();
      expect(mockWin.loadFile).toHaveBeenCalledTimes(1);
    });

    it('logs error on HTML load failure', async () => {
      mockWin.loadFile.mockRejectedValueOnce(new Error('load fail'));
      const cw = new ChatWindow();
      cw.create();
      await new Promise(r => setTimeout(r, 10));
      expect(mockLog.error).toHaveBeenCalledWith('Failed to load HTML', expect.objectContaining({ error: 'load fail' }));
    });

    it('registers did-finish-load handler', () => {
      const cw = new ChatWindow();
      cw.create();
      expect(mockWin.webContents.once).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
    });

    it('sends chat:ensure-visible on did-finish-load', () => {
      const cw = new ChatWindow();
      cw.create();
      const handler = mockWin.webContents.once.mock.calls.find(c => c[0] === 'did-finish-load')[1];
      handler();
      expect(mockWin.webContents.send).toHaveBeenCalledWith('chat:ensure-visible');
    });

    it('handles IPC send failure on did-finish-load', () => {
      mockWin.webContents.send.mockImplementation(() => { throw new Error('ipc fail'); });
      const cw = new ChatWindow();
      cw.create();
      const handler = mockWin.webContents.once.mock.calls.find(c => c[0] === 'did-finish-load')[1];
      expect(() => handler()).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith('Failed to send ensure-visible', { error: 'ipc fail' });
    });

    it('registers close and closed event handlers', () => {
      const cw = new ChatWindow();
      cw.create();
      const events = mockWin.on.mock.calls.map(c => c[0]);
      expect(events).toContain('close');
      expect(events).toContain('closed');
    });

    it('fade-hides on close when not quitting', () => {
      jest.useFakeTimers();
      const cw = new ChatWindow();
      cw.create();
      const closeHandler = mockWin.on.mock.calls.find(c => c[0] === 'close')[1];
      const event = { preventDefault: jest.fn() };
      cw.send = jest.fn();
      closeHandler(event);
      expect(event.preventDefault).toHaveBeenCalled();
      jest.advanceTimersByTime(450);
      expect(mockWin.hide).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('allows close when quitting', () => {
      const cw = new ChatWindow();
      cw.setQuitting(true);
      cw.create();
      const closeHandler = mockWin.on.mock.calls.find(c => c[0] === 'close')[1];
      const event = { preventDefault: jest.fn() };
      closeHandler(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('nulls window reference on closed', () => {
      const cw = new ChatWindow();
      cw.create();
      const closedHandler = mockWin.on.mock.calls.find(c => c[0] === 'closed')[1];
      closedHandler();
      expect(cw.window).toBeNull();
    });

    it('opens DevTools in development when configured', () => {
      process.env.ELECTRON_DEV = 'true';
      mockConfig.dev.openDevToolsAux = true;
      const cw = new ChatWindow();
      cw.create();
      expect(mockWin.webContents.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
    });

    it('enables vibrancy on macOS when native effects enabled', () => {
      const orig = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockConfig.ui.enableNativeWindowEffects = true;
      const cw = new ChatWindow();
      cw.create();
      const opts = MockBrowserWindow.mock.calls[0][0];
      expect(opts.vibrancy).toBe('under-window');
      Object.defineProperty(process, 'platform', { value: orig });
    });

    it('sets background material on Windows when native effects enabled', () => {
      const orig = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockConfig.ui.enableNativeWindowEffects = true;
      const cw = new ChatWindow();
      cw.create();
      expect(mockWin.setBackgroundMaterial).toHaveBeenCalledWith('mica');
      Object.defineProperty(process, 'platform', { value: orig });
    });

    it('handles setBackgroundMaterial failure gracefully', () => {
      const orig = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockConfig.ui.enableNativeWindowEffects = true;
      mockWin.setBackgroundMaterial.mockImplementation(() => { throw new Error('fail'); });
      const cw = new ChatWindow();
      expect(() => cw.create()).not.toThrow();
      Object.defineProperty(process, 'platform', { value: orig });
    });

    it('registers console-message handler in development', () => {
      process.env.ELECTRON_DEV = 'true';
      const cw = new ChatWindow();
      cw.create();
      const handler = mockWin.webContents.on.mock.calls.find(c => c[0] === 'console-message');
      expect(handler).toBeDefined();

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      handler[1]({}, 2, 'test warn', 10, '/src/file.js');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[ChatWindow:WARN]'));

      consoleSpy.mockClear();
      handler[1]({}, 0, 'debug', 1, '');
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Utility methods
  // ---------------------------------------------------------------------------

  describe('getWindow()', () => {
    it('returns null before create', () => {
      expect(new ChatWindow().getWindow()).toBeNull();
    });
    it('returns window after create', () => {
      const cw = new ChatWindow();
      cw.create();
      expect(cw.getWindow()).toBe(mockWin);
    });
  });

  describe('exists()', () => {
    it('returns falsy when no window', () => {
      expect(new ChatWindow().exists()).toBeFalsy();
    });
    it('returns true when window exists', () => {
      const cw = new ChatWindow();
      cw.create();
      expect(cw.exists()).toBe(true);
    });
    it('returns false when destroyed', () => {
      const cw = new ChatWindow();
      cw.create();
      mockWin.isDestroyed.mockReturnValue(true);
      expect(cw.exists()).toBe(false);
    });
  });

  describe('show()', () => {
    it('shows and focuses existing window', () => {
      const cw = new ChatWindow();
      cw.create();
      mockWin.show.mockClear();
      mockWin.focus.mockClear();
      cw.show();
      expect(mockWin.show).toHaveBeenCalled();
      expect(mockWin.focus).toHaveBeenCalled();
    });

    it('creates window if none exists', () => {
      const cw = new ChatWindow();
      cw.show();
      expect(MockBrowserWindow).toHaveBeenCalledTimes(1);
    });

    it('clears one-shot show:false flag so future re-creates are visible', () => {
      const cw = new ChatWindow({ show: false });
      expect(cw.options.show).toBe(false);
      cw.show();
      expect(cw.options.show).toBeUndefined();
    });
  });

  describe('hide()', () => {
    it('fade-hides existing window', () => {
      jest.useFakeTimers();
      const cw = new ChatWindow();
      cw.create();
      cw.send = jest.fn();
      cw.hide();
      jest.advanceTimersByTime(450);
      expect(mockWin.hide).toHaveBeenCalled();
      jest.useRealTimers();
    });
    it('no-op when no window', () => {
      new ChatWindow().hide();
      expect(mockWin.hide).not.toHaveBeenCalled();
    });
  });

  describe('focus()', () => {
    it('focuses existing window', () => {
      const cw = new ChatWindow();
      cw.create();
      mockWin.focus.mockClear();
      cw.focus();
      expect(mockWin.focus).toHaveBeenCalled();
    });
  });

  describe('toggleVisibility()', () => {
    it('fade-hides visible window', () => {
      jest.useFakeTimers();
      const cw = new ChatWindow();
      cw.create();
      mockWin.isVisible.mockReturnValue(true);
      cw.send = jest.fn();
      cw.toggleVisibility();
      jest.advanceTimersByTime(450);
      expect(mockWin.hide).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('shows hidden window', () => {
      const cw = new ChatWindow();
      cw.create();
      mockWin.isVisible.mockReturnValue(false);
      mockWin.show.mockClear();
      cw.toggleVisibility();
      expect(mockWin.show).toHaveBeenCalled();
    });

    it('creates window via show() if none exists', () => {
      const cw = new ChatWindow();
      cw.toggleVisibility();
      expect(MockBrowserWindow).toHaveBeenCalledTimes(1);
    });
  });

  describe('minimize()', () => {
    it('minimizes existing window', () => {
      const cw = new ChatWindow();
      cw.create();
      cw.minimize();
      expect(mockWin.minimize).toHaveBeenCalled();
    });
    it('no-op when no window', () => {
      new ChatWindow().minimize();
      expect(mockWin.minimize).not.toHaveBeenCalled();
    });
  });

  describe('maximize()', () => {
    it('maximizes non-maximized window', () => {
      const cw = new ChatWindow();
      cw.create();
      cw.maximize();
      expect(mockWin.maximize).toHaveBeenCalled();
    });

    it('unmaximizes already maximized window', () => {
      const cw = new ChatWindow();
      cw.create();
      mockWin.isMaximized.mockReturnValue(true);
      cw.maximize();
      expect(mockWin.unmaximize).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // control
  // ---------------------------------------------------------------------------

  describe('control()', () => {
    let cw;
    beforeEach(() => {
      cw = new ChatWindow();
      cw.create();
    });

    it('handles minimize action', () => {
      cw.control('minimize');
      expect(mockWin.minimize).toHaveBeenCalled();
    });

    it('handles maximize action', () => {
      cw.control('maximize');
      expect(mockWin.maximize).toHaveBeenCalled();
    });

    it('handles close action (fade-hides)', () => {
      jest.useFakeTimers();
      cw.send = jest.fn();
      cw.control('close');
      jest.advanceTimersByTime(450);
      expect(mockWin.hide).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('handles toggle-visibility action', () => {
      mockWin.isVisible.mockReturnValue(false);
      cw.control('toggle-visibility');
      expect(mockWin.show).toHaveBeenCalled();
    });

    it('logs warning for unknown action', () => {
      cw.control('unknown');
      expect(mockLog.warn).toHaveBeenCalledWith('Unknown control action', { action: 'unknown' });
    });
  });

  // ---------------------------------------------------------------------------
  // destroy
  // ---------------------------------------------------------------------------

  describe('destroy()', () => {
    it('destroys and nulls window', () => {
      const cw = new ChatWindow();
      cw.create();
      cw.destroy();
      expect(mockWin.destroy).toHaveBeenCalled();
      expect(cw.window).toBeNull();
    });

    it('no-op when no window', () => {
      new ChatWindow().destroy();
      expect(mockWin.destroy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Branch coverage additions
  // =========================================================================

  describe('focus() — window existence guard', () => {
    it('is no-op when window does not exist', () => {
      const cw = new ChatWindow();
      cw.focus();
      expect(mockWin.focus).not.toHaveBeenCalled();
    });
  });

  describe('maximize() — toggle behavior', () => {
    it('unmaximizes when already maximized', () => {
      const cw = new ChatWindow();
      cw.create();
      mockWin.isMaximized.mockReturnValue(true);
      cw.maximize();
      expect(mockWin.unmaximize).toHaveBeenCalled();
      expect(mockWin.maximize).not.toHaveBeenCalled();
    });

    it('maximizes when not maximized', () => {
      const cw = new ChatWindow();
      cw.create();
      mockWin.isMaximized.mockReturnValue(false);
      cw.maximize();
      expect(mockWin.maximize).toHaveBeenCalled();
    });

    it('is no-op when window does not exist', () => {
      const cw = new ChatWindow();
      cw.maximize();
      expect(mockWin.maximize).not.toHaveBeenCalled();
    });
  });

  describe('Windows native background material', () => {
    it('applies setBackgroundMaterial on win32 when enabled', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      mockConfig.ui.enableNativeWindowEffects = true;
      mockWin.setBackgroundMaterial = jest.fn();

      try {
        const cw = new ChatWindow();
        cw.create();
        expect(mockWin.setBackgroundMaterial).toHaveBeenCalledWith('mica');
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
        mockConfig.ui.enableNativeWindowEffects = false;
      }
    });
  });

  describe('console-message handler (dev mode)', () => {
    const origElectronDev = process.env.ELECTRON_DEV;
    afterEach(() => { process.env.ELECTRON_DEV = origElectronDev; });

    it('logs WARN/ERROR messages and handles missing sourceId', () => {
      process.env.ELECTRON_DEV = 'true';
      const cw = new ChatWindow();
      cw.create();

      const consoleHandler = mockWin.webContents.on.mock.calls
        .find(c => c[0] === 'console-message');
      expect(consoleHandler).toBeDefined();
      const handler = consoleHandler[1];

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        // WARN with source
        handler({}, 2, 'test', 10, '/some/file.js');
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[ChatWindow:WARN]'));

        logSpy.mockClear();

        // ERROR without source (empty string)
        handler({}, 3, 'err', 0, '');
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[ChatWindow:ERROR]'));

        logSpy.mockClear();

        // Unknown level → 'LOG' fallback
        handler({}, 5, 'high', 0, '');
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[ChatWindow:LOG]'));
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  // =========================================================================
  // Fade animation
  // =========================================================================

  describe('fadeHide()', () => {
    it('sets isFading and triggers initiate-hide', () => {
      jest.useFakeTimers();
      const cw = new ChatWindow();
      cw.create();
      cw.send = jest.fn();
      cw.fadeHide();
      expect(cw._isFading).toBe(true);
      expect(cw.send).toHaveBeenCalledWith('chat:initiate-hide');
      jest.advanceTimersByTime(450);
      expect(cw._isFading).toBe(false);
      expect(mockWin.hide).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('is no-op when already fading', () => {
      jest.useFakeTimers();
      const cw = new ChatWindow();
      cw.create();
      cw.fadeHide();
      const firstTimeoutId = cw._fadeTimeoutId;
      cw.fadeHide(); // double-call
      expect(cw._fadeTimeoutId).toBe(firstTimeoutId);
      jest.advanceTimersByTime(450);
      jest.useRealTimers();
    });

    it('is no-op when window is not visible', () => {
      const cw = new ChatWindow();
      cw.create();
      mockWin.isVisible.mockReturnValue(false);
      cw.fadeHide();
      expect(cw._isFading).toBe(false);
    });

    it('hides immediately when isQuitting', () => {
      const cw = new ChatWindow();
      cw.setQuitting(true);
      cw.create();
      cw.fadeHide();
      expect(mockWin.hide).toHaveBeenCalled();
      expect(cw._isFading).toBe(false);
    });
  });

  describe('cancelFade()', () => {
    it('sends cancel-hide IPC and clears fading state', () => {
      jest.useFakeTimers();
      const cw = new ChatWindow();
      cw.create();
      cw.send = jest.fn();
      cw.fadeHide();
      jest.advanceTimersByTime(100);
      expect(cw._isFading).toBe(true);
      cw.send.mockClear();
      cw.cancelFade();
      expect(cw._isFading).toBe(false);
      expect(cw.send).toHaveBeenCalledWith('chat:cancel-hide');
      jest.useRealTimers();
    });

    it('is no-op when not fading', () => {
      const cw = new ChatWindow();
      cw.create();
      cw.send = jest.fn();
      cw.cancelFade();
      expect(cw.send).not.toHaveBeenCalled();
    });
  });

  describe('show() during fade', () => {
    it('cancels fade before showing', () => {
      jest.useFakeTimers();
      const cw = new ChatWindow();
      cw.create();
      cw.send = jest.fn();
      cw.fadeHide();
      jest.advanceTimersByTime(100);
      cw.send.mockClear();
      mockWin.show.mockClear();
      cw.show();
      expect(cw._isFading).toBe(false);
      expect(cw.send).toHaveBeenCalledWith('chat:cancel-hide');
      expect(mockWin.show).toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  describe('destroy() during fade', () => {
    it('cancels fade before destroying', () => {
      jest.useFakeTimers();
      const cw = new ChatWindow();
      cw.create();
      cw.send = jest.fn();
      cw.fadeHide();
      jest.advanceTimersByTime(100);
      expect(cw._isFading).toBe(true);
      cw.destroy();
      expect(cw._isFading).toBe(false);
      expect(cw._fadeTimeoutId).toBeNull();
      jest.useRealTimers();
    });
  });

  // =========================================================================
  // Notch Mode
  // =========================================================================

  describe('toggleNotchMode()', () => {
    it('enters notch mode correctly', () => {
      const cw = new ChatWindow();
      cw.create();
      cw.send = jest.fn();
      cw.toggleNotchMode();
      expect(cw._isNotchMode).toBe(true);
      expect(mockWin.setBounds).toHaveBeenCalledWith(
        expect.objectContaining({ height: 300 }),
        true
      );
    });

    it('exits notch mode correctly and restores bounds', () => {
      jest.useFakeTimers();
      const cw = new ChatWindow();
      cw.create();
      const initialBounds = { x: 50, y: 50, width: 400, height: 500 };
      mockWin.getBounds.mockReturnValue(initialBounds);
      
      // Enter
      cw.send = jest.fn();
      cw.toggleNotchMode();
      expect(cw._isNotchMode).toBe(true);
      
      jest.advanceTimersByTime(350);
      
      // Exit
      cw.toggleNotchMode();
      expect(cw._isNotchMode).toBe(false);
      expect(mockWin.setBounds).toHaveBeenCalledWith(initialBounds, true);
      
      jest.useRealTimers();
    });

    it('does not idle timeout if streaming', () => {
      jest.useFakeTimers();
      const cw = new ChatWindow();
      cw.create();
      cw.window.removeListener = jest.fn();
      cw.window.on = jest.fn();
      // Extend webContents mock with isFocused for the notch proximity check
      cw.window.webContents.isFocused = jest.fn().mockReturnValue(false);
      cw.send = jest.fn();
      cw.toggleNotchMode();
      cw.setStreamingState(true);
      
      mockWin.isFocused.mockReturnValue(false);
      
      // Since it's streaming, _evaluateNotchState thinks it's active.
      // Call evaluate again to clear any pending collapse timer and simulate active state
      cw._evaluateNotchState();
      
      // The bounds should be expanded or stay expanded, not the 46px idle height
      
      // Advance idle timeout 
      jest.advanceTimersByTime(3500);
      
      expect(mockWin.setBounds).not.toHaveBeenCalledWith(
        expect.objectContaining({ height: 46 }),
        true
      );
      
      jest.useRealTimers();
    });
    
    it('does not idle timeout if focused', () => {
      jest.useFakeTimers();
      const cw = new ChatWindow();
      cw.create();
      cw.window.removeListener = jest.fn();
      cw.window.on = jest.fn();
      // Extend webContents mock with isFocused for the notch proximity check
      cw.window.webContents.isFocused = jest.fn().mockReturnValue(true);
      cw.send = jest.fn();
      cw.toggleNotchMode();
      
      mockWin.isFocused.mockReturnValue(true);
      
      cw._evaluateNotchState();
      
      jest.advanceTimersByTime(3500);
      
      expect(mockWin.setBounds).not.toHaveBeenCalledWith(
        expect.objectContaining({ height: 46 }),
        true
      );
      
      jest.useRealTimers();
    });
  });
});
