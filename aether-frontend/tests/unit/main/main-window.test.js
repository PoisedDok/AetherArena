'use strict';

// =============================================================================
// Mocks (before require)
// =============================================================================

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockWindowInstance = {
  on: jest.fn(),
  loadFile: jest.fn().mockResolvedValue(undefined),
  webContents: {
    send: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    setVisualZoomLevelLimits: jest.fn(),
    openDevTools: jest.fn(),
    isDevToolsFocused: jest.fn(() => false),
    getZoomFactor: jest.fn(() => 1.0),
    setZoomFactor: jest.fn(),
    id: 1,
  },
  show: jest.fn(),
  hide: jest.fn(),
  close: jest.fn(),
  focus: jest.fn(),
  destroy: jest.fn(),
  isDestroyed: jest.fn(() => false),
  getBounds: jest.fn(() => ({ x: 100, y: 100, width: 800, height: 600 })),
  setBounds: jest.fn(),
  setAlwaysOnTop: jest.fn(),
  setSkipTaskbar: jest.fn(),
  setAspectRatio: jest.fn(),
  setOpacity: jest.fn(),
  setBackgroundColor: jest.fn(),
  setVibrancy: jest.fn(),
  setVisualEffectState: jest.fn(),
  setBackgroundMaterial: jest.fn(),
};
const MockBrowserWindow = jest.fn(() => mockWindowInstance);

jest.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
}), { virtual: true });

jest.mock('../../../src/core/utils/logger', () => ({
  logger: { child: jest.fn(() => mockLog) },
}));

const mockConfig = {
  ui: {
    normalWidth: 800,
    normalHeight: 600,
    widgetSize: 180,
    widgetMargin: 24,
    mainWindowBackgroundColor: '#00000000',
    enableNativeWindowEffects: false,
    disableNativeWindowEffectsInWidgetMode: false,
    macVibrancy: 'under-window',
    macVisualEffectState: 'active',
    windowsBackgroundMaterial: 'mica',
  },
  dev: {
    openDevToolsMain: false,
  },
};
jest.mock('../../../src/core/config', () => mockConfig);

jest.mock('../../../src/main/utils/preload-utils', () => ({
  resolvePreloadPath: jest.fn(() => '/mock/preload/main-preload.js'),
}));

const mockAttachExternalLink = jest.fn();
const mockAttachPermission = jest.fn();
jest.mock('../../../src/main/security/ExternalLinkHandler', () => ({
  attachToWindow: mockAttachExternalLink,
}));
jest.mock('../../../src/main/security/PermissionHandler', () => ({
  attachToWindow: mockAttachPermission,
  PERMISSIONS: { MEDIA: 'media', CLIPBOARD_SANITIZED_WRITE: 'clipboard-sanitized-write' },
}));

const mockCalculateWidgetPosition = jest.fn(() => ({ x: 200, y: 200 }));
jest.mock('../../../src/main/utils/display-utils', () => ({
  calculateWidgetPosition: mockCalculateWidgetPosition,
}));

const MainWindow = require('../../../src/main/windows/MainWindow');

// =============================================================================
// Helpers
// =============================================================================

function createMainWindow(overrides = {}) {
  return new MainWindow(overrides);
}

function resetWindowMocks() {
  Object.values(mockWindowInstance).forEach(fn => {
    if (typeof fn === 'function' && fn.mockClear) fn.mockClear();
  });
  Object.values(mockWindowInstance.webContents).forEach(fn => {
    if (typeof fn === 'function' && fn.mockClear) fn.mockClear();
  });
  MockBrowserWindow.mockClear();
  mockWindowInstance.isDestroyed.mockReturnValue(false);
  mockWindowInstance.webContents.getZoomFactor.mockReturnValue(1.0);
  mockWindowInstance.webContents.isDevToolsFocused.mockReturnValue(false);
  mockWindowInstance.getBounds.mockReturnValue({ x: 100, y: 100, width: 800, height: 600 });
  mockWindowInstance.loadFile.mockResolvedValue(undefined);
}

// =============================================================================
// Tests
// =============================================================================

describe('MainWindow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetWindowMocks();
    mockConfig.ui.enableNativeWindowEffects = false;
    mockConfig.ui.disableNativeWindowEffectsInWidgetMode = false;
    mockConfig.dev.openDevToolsMain = false;
    process.env.ELECTRON_DEV = 'false';
    process.env.NODE_ENV = 'test';
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('sets default options from config', () => {
      const mw = createMainWindow();
      expect(mw.options.width).toBe(800);
      expect(mw.options.height).toBe(600);
      expect(mw.options.widgetSize).toBe(180);
    });

    it('allows options overrides', () => {
      const mw = createMainWindow({ width: 1024, height: 768, widgetSize: 200 });
      expect(mw.options.width).toBe(1024);
      expect(mw.options.height).toBe(768);
      expect(mw.options.widgetSize).toBe(200);
    });

    it('initializes state correctly', () => {
      const mw = createMainWindow();
      expect(mw.window).toBeNull();
      expect(mw.isWidgetMode).toBe(false);
      expect(mw.previousBounds).toBeNull();
      expect(mw.widgetBounds).toBeNull();
      expect(mw._nativeEffectsState).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // create()
  // ---------------------------------------------------------------------------

  describe('create()', () => {
    it('creates a BrowserWindow with correct options', () => {
      const mw = createMainWindow();
      const win = mw.create();

      expect(MockBrowserWindow).toHaveBeenCalledTimes(1);
      const opts = MockBrowserWindow.mock.calls[0][0];
      expect(opts.width).toBe(800);
      expect(opts.height).toBe(600);
      expect(opts.frame).toBe(false);
      expect(opts.transparent).toBe(true);
      expect(opts.alwaysOnTop).toBe(true);
      expect(opts.webPreferences.nodeIntegration).toBe(false);
      expect(opts.webPreferences.contextIsolation).toBe(true);
      expect(opts.webPreferences.preload).toBe('/mock/preload/main-preload.js');
      expect(win).toBe(mockWindowInstance);
    });

    it('returns existing window on double-create', () => {
      const mw = createMainWindow();
      mw.create();
      const win2 = mw.create();

      expect(MockBrowserWindow).toHaveBeenCalledTimes(1);
      expect(win2).toBe(mockWindowInstance);
      expect(mockLog.warn).toHaveBeenCalledWith('Main window already exists');
    });

    it('creates new window if previous was destroyed', () => {
      const mw = createMainWindow();
      mw.create();
      mockWindowInstance.isDestroyed.mockReturnValue(true);
      mw.create();

      expect(MockBrowserWindow).toHaveBeenCalledTimes(2);
    });

    it('sets visual zoom limits', () => {
      const mw = createMainWindow();
      mw.create();

      expect(mockWindowInstance.webContents.setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 5);
    });

    it('sets opacity to 1.0', () => {
      const mw = createMainWindow();
      mw.create();

      expect(mockWindowInstance.setOpacity).toHaveBeenCalledWith(1.0);
    });

    it('sets transparent background', () => {
      const mw = createMainWindow();
      mw.create();

      expect(mockWindowInstance.setBackgroundColor).toHaveBeenCalledWith('#00000000');
    });

    it('attaches security handlers', () => {
      const mw = createMainWindow();
      mw.create();

      expect(mockAttachExternalLink).toHaveBeenCalledWith(mockWindowInstance);
      expect(mockAttachPermission).toHaveBeenCalledWith(mockWindowInstance, {
        media: true,
        'clipboard-sanitized-write': true,
      });
    });

    it('loads HTML file', () => {
      const mw = createMainWindow();
      mw.create();

      expect(mockWindowInstance.loadFile).toHaveBeenCalledTimes(1);
    });

    it('logs error on HTML load failure', async () => {
      mockWindowInstance.loadFile.mockRejectedValueOnce(new Error('load failed'));
      const mw = createMainWindow();
      mw.create();

      // Wait for the promise rejection to be handled
      await new Promise(r => setTimeout(r, 10));
      expect(mockLog.error).toHaveBeenCalledWith('Failed to load HTML', expect.objectContaining({
        error: 'load failed',
      }));
    });

    it('registers event handlers (blur, will-minimize, move, closed)', () => {
      const mw = createMainWindow();
      mw.create();

      const events = mockWindowInstance.on.mock.calls.map(c => c[0]);
      expect(events).toContain('blur');
      expect(events).toContain('will-minimize');
      expect(events).toContain('move');
      expect(events).toContain('closed');
    });

    it('captures native effects state', () => {
      const mw = createMainWindow();
      mw.create();

      expect(mw._nativeEffectsState).toEqual({
        macVibrancy: null, // Not set because enableNativeWindowEffects is false
        macVisualEffectState: null,
        windowsBackgroundMaterial: 'mica',
      });
    });

    it('opens DevTools in development mode when configured', () => {
      process.env.ELECTRON_DEV = 'true';
      mockConfig.dev.openDevToolsMain = true;
      const mw = createMainWindow();
      mw.create();

      expect(mockWindowInstance.webContents.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
    });

    it('does NOT open DevTools in production', () => {
      process.env.ELECTRON_DEV = 'false';
      process.env.NODE_ENV = 'production';
      mockConfig.dev.openDevToolsMain = false;
      const mw = createMainWindow();
      mw.create();

      expect(mockWindowInstance.webContents.openDevTools).not.toHaveBeenCalled();
    });

    it('enables vibrancy on macOS when native effects enabled', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockConfig.ui.enableNativeWindowEffects = true;

      const mw = createMainWindow();
      mw.create();

      const opts = MockBrowserWindow.mock.calls[0][0];
      expect(opts.vibrancy).toBe('under-window');
      expect(opts.visualEffectState).toBe('active');

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('sets background material on Windows when native effects enabled', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockConfig.ui.enableNativeWindowEffects = true;

      const mw = createMainWindow();
      mw.create();

      expect(mockWindowInstance.setBackgroundMaterial).toHaveBeenCalledWith('mica');

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('handles setBackgroundMaterial failure on Windows gracefully', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockConfig.ui.enableNativeWindowEffects = true;
      mockWindowInstance.setBackgroundMaterial.mockImplementation(() => { throw new Error('not supported'); });

      const mw = createMainWindow();
      expect(() => mw.create()).not.toThrow();
      expect(mockLog.debug).toHaveBeenCalledWith(
        'Background material not supported or failed to apply',
        expect.objectContaining({ error: 'not supported' })
      );

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('registers console-message handler in development mode', () => {
      process.env.ELECTRON_DEV = 'true';
      const mw = createMainWindow();
      mw.create();

      const consoleHandler = mockWindowInstance.webContents.on.mock.calls.find(c => c[0] === 'console-message');
      expect(consoleHandler).toBeDefined();

      // Trigger with WARN level (2) — should log
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      consoleHandler[1]({}, 2, 'test warning', 10, '/path/to/file.js');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[MainWindow:WARN]'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('test warning'));

      // Trigger with ERROR level (3)
      consoleHandler[1]({}, 3, 'test error', 20, '');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[MainWindow:ERROR]'));

      // Trigger with DEBUG level (0) — should NOT log
      consoleSpy.mockClear();
      consoleHandler[1]({}, 0, 'debug msg', 1, '/src/test.js');
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  describe('event handlers', () => {
    let mw;
    let handlers;

    beforeEach(() => {
      mw = createMainWindow();
      mw.create();
      handlers = {};
      mockWindowInstance.on.mock.calls.forEach(([event, handler]) => {
        handlers[event] = handler;
      });
    });

    it('blur handler enters widget mode', () => {
      const spy = jest.spyOn(mw, 'enterWidgetMode').mockImplementation(() => {});
      handlers.blur();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('blur handler skips if DevTools focused', () => {
      mockWindowInstance.webContents.isDevToolsFocused.mockReturnValue(true);
      const spy = jest.spyOn(mw, 'enterWidgetMode').mockImplementation(() => {});
      handlers.blur();
      expect(spy).not.toHaveBeenCalled();
    });

    it('will-minimize handler prevents default and enters widget mode', () => {
      const event = { preventDefault: jest.fn() };
      const spy = jest.spyOn(mw, 'enterWidgetMode').mockImplementation(() => {});
      handlers['will-minimize'](event);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('move handler tracks widget position when in widget mode', () => {
      mw.isWidgetMode = true;
      mockWindowInstance.getBounds.mockReturnValue({ x: 300, y: 400, width: 180, height: 245 });
      handlers.move();
      expect(mw.widgetBounds).toEqual({ x: 300, y: 400 });
    });

    it('move handler does NOT track when NOT in widget mode', () => {
      mw.isWidgetMode = false;
      handlers.move();
      expect(mw.widgetBounds).toBeNull();
    });

    it('closed handler nulls window reference', () => {
      handlers.closed();
      expect(mw.window).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // enterWidgetMode
  // ---------------------------------------------------------------------------

  describe('enterWidgetMode()', () => {
    let mw;

    beforeEach(() => {
      mw = createMainWindow();
      mw.create();
    });

    it('sets isWidgetMode to true', () => {
      mw.enterWidgetMode();
      expect(mw.isWidgetMode).toBe(true);
    });

    it('is idempotent (no-op if already widget)', () => {
      mw.enterWidgetMode();
      const callCount = mockWindowInstance.setBounds.mock.calls.length;
      mw.enterWidgetMode();
      expect(mockWindowInstance.setBounds.mock.calls.length).toBe(callCount);
    });

    it('saves previous bounds', () => {
      mw.enterWidgetMode();
      expect(mw.previousBounds).toEqual({ x: 100, y: 100, width: 800, height: 600 });
    });

    it('sets aspect ratio for widget mode', () => {
      mw.enterWidgetMode();
      expect(mockWindowInstance.setAspectRatio).toHaveBeenCalledWith(180 / (180 + 65));
    });

    it('calculates widget position using display-utils', () => {
      mw.enterWidgetMode();
      expect(mockCalculateWidgetPosition).toHaveBeenCalledWith(
        { x: 100, y: 100, width: 800, height: 600 },
        180,
        24
      );
    });

    it('uses cached widgetBounds if available', () => {
      mw.widgetBounds = { x: 500, y: 500 };
      mw.enterWidgetMode();
      expect(mockCalculateWidgetPosition).not.toHaveBeenCalled();
      expect(mockWindowInstance.setBounds).toHaveBeenCalledWith(
        expect.objectContaining({ x: 500, y: 500 })
      );
    });

    it('applies widget window properties', () => {
      mw.enterWidgetMode();
      expect(mockWindowInstance.setSkipTaskbar).toHaveBeenCalledWith(true);
      expect(mockWindowInstance.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
      expect(mockWindowInstance.setBackgroundColor).toHaveBeenCalledWith('#00000000');
    });

    it('sends enter-widget-mode IPC to renderer', () => {
      mw.enterWidgetMode();
      expect(mockWindowInstance.webContents.send).toHaveBeenCalledWith('enter-widget-mode');
    });

    it('handles IPC send failure gracefully', () => {
      mockWindowInstance.webContents.send.mockImplementation(() => { throw new Error('IPC fail'); });
      expect(() => mw.enterWidgetMode()).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith('Failed to notify renderer', { error: 'IPC fail' });
    });

    it('disables vibrancy on macOS when configured', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockConfig.ui.enableNativeWindowEffects = true;
      mockConfig.ui.disableNativeWindowEffectsInWidgetMode = true;

      mw.enterWidgetMode();
      expect(mockWindowInstance.setVibrancy).toHaveBeenCalledWith(null);

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('handles setVibrancy failure on macOS gracefully', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockConfig.ui.enableNativeWindowEffects = true;
      mockConfig.ui.disableNativeWindowEffectsInWidgetMode = true;
      mockWindowInstance.setVibrancy.mockImplementation(() => { throw new Error('vibrancy fail'); });

      expect(() => mw.enterWidgetMode()).not.toThrow();
      expect(mockLog.debug).toHaveBeenCalledWith(
        'Failed to disable vibrancy for widget mode',
        { error: 'vibrancy fail' }
      );

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('disables background material on Windows when configured', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockConfig.ui.enableNativeWindowEffects = true;
      mockConfig.ui.disableNativeWindowEffectsInWidgetMode = true;

      mw.enterWidgetMode();
      expect(mockWindowInstance.setBackgroundMaterial).toHaveBeenCalledWith('none');

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('handles setBackgroundMaterial failure on Windows widget mode gracefully', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockConfig.ui.enableNativeWindowEffects = true;
      mockConfig.ui.disableNativeWindowEffectsInWidgetMode = true;
      mockWindowInstance.setBackgroundMaterial.mockImplementation(() => { throw new Error('mat fail'); });

      expect(() => mw.enterWidgetMode()).not.toThrow();
      expect(mockLog.debug).toHaveBeenCalledWith(
        'Failed to disable background material for widget mode',
        { error: 'mat fail' }
      );

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('sets transparent background after 300ms delay', () => {
      jest.useFakeTimers();
      mw.enterWidgetMode();

      // Before timer fires
      mockWindowInstance.setBackgroundColor.mockClear();
      jest.advanceTimersByTime(299);
      expect(mockWindowInstance.setBackgroundColor).not.toHaveBeenCalled();

      // After timer fires
      jest.advanceTimersByTime(1);
      expect(mockWindowInstance.setBackgroundColor).toHaveBeenCalledWith('#00000000');

      jest.useRealTimers();
    });

    it('skips delayed background set if window destroyed', () => {
      jest.useFakeTimers();
      mw.enterWidgetMode();
      mockWindowInstance.isDestroyed.mockReturnValue(true);

      mockWindowInstance.setBackgroundColor.mockClear();
      jest.advanceTimersByTime(300);
      expect(mockWindowInstance.setBackgroundColor).not.toHaveBeenCalled();

      jest.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // exitWidgetMode
  // ---------------------------------------------------------------------------

  describe('exitWidgetMode()', () => {
    let mw;

    beforeEach(() => {
      mw = createMainWindow();
      mw.create();
      mw.enterWidgetMode();
      jest.clearAllMocks();
      resetWindowMocks();
    });

    it('sets isWidgetMode to false', () => {
      mw.exitWidgetMode();
      expect(mw.isWidgetMode).toBe(false);
    });

    it('is idempotent (no-op if not widget)', () => {
      mw.exitWidgetMode();
      mw.exitWidgetMode();
      // Only first call does work
      expect(mockWindowInstance.setAspectRatio).toHaveBeenCalledTimes(1);
    });

    it('resets aspect ratio to 0', () => {
      mw.exitWidgetMode();
      expect(mockWindowInstance.setAspectRatio).toHaveBeenCalledWith(0);
    });

    it('restores previous bounds', () => {
      mw.previousBounds = { x: 100, y: 100, width: 800, height: 600 };
      mw.exitWidgetMode();
      expect(mockWindowInstance.setBounds).toHaveBeenCalledWith({ x: 100, y: 100, width: 800, height: 600 });
    });

    it('uses default size if no previous bounds', () => {
      mw.previousBounds = null;
      mw.exitWidgetMode();
      expect(mockWindowInstance.setBounds).toHaveBeenCalledWith({
        width: 800,
        height: 600,
      });
    });

    it('nulls previousBounds after restore', () => {
      mw.previousBounds = { x: 0, y: 0, width: 800, height: 600 };
      mw.exitWidgetMode();
      expect(mw.previousBounds).toBeNull();
    });

    it('updates window properties for normal mode', () => {
      mw.exitWidgetMode();
      expect(mockWindowInstance.setSkipTaskbar).toHaveBeenCalledWith(false);
      expect(mockWindowInstance.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
    });

    it('sends exit-widget-mode IPC to renderer', () => {
      mw.exitWidgetMode();
      expect(mockWindowInstance.webContents.send).toHaveBeenCalledWith('exit-widget-mode');
    });

    it('handles IPC send failure gracefully', () => {
      mockWindowInstance.webContents.send.mockImplementation(() => { throw new Error('IPC fail'); });
      expect(() => mw.exitWidgetMode()).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith('Failed to notify renderer', { error: 'IPC fail' });
    });

    it('restores vibrancy on macOS when native effects enabled', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockConfig.ui.enableNativeWindowEffects = true;
      mw._nativeEffectsState = {
        macVibrancy: 'under-window',
        macVisualEffectState: 'active',
        windowsBackgroundMaterial: null,
      };
      // Ensure setVibrancy is a callable function (not removed by mock reset)
      mockWindowInstance.setVibrancy = jest.fn();
      mockWindowInstance.setVisualEffectState = jest.fn();

      mw.exitWidgetMode();
      expect(mockWindowInstance.setVibrancy).toHaveBeenCalledWith('under-window');
      expect(mockWindowInstance.setVisualEffectState).toHaveBeenCalledWith('active');

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('handles vibrancy restore failure on macOS gracefully', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      mockConfig.ui.enableNativeWindowEffects = true;
      mw._nativeEffectsState = {
        macVibrancy: 'under-window',
        macVisualEffectState: 'active',
        windowsBackgroundMaterial: null,
      };
      mockWindowInstance.setVibrancy.mockImplementation(() => { throw new Error('restore fail'); });

      expect(() => mw.exitWidgetMode()).not.toThrow();
      expect(mockLog.debug).toHaveBeenCalledWith(
        'Failed to restore vibrancy for normal mode',
        { error: 'restore fail' }
      );

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('restores background material on Windows when native effects enabled', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockConfig.ui.enableNativeWindowEffects = true;
      mw._nativeEffectsState = {
        macVibrancy: null,
        macVisualEffectState: null,
        windowsBackgroundMaterial: 'mica',
      };

      mw.exitWidgetMode();
      expect(mockWindowInstance.setBackgroundMaterial).toHaveBeenCalledWith('mica');

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('handles background material restore failure on Windows gracefully', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockConfig.ui.enableNativeWindowEffects = true;
      mw._nativeEffectsState = {
        macVibrancy: null,
        macVisualEffectState: null,
        windowsBackgroundMaterial: 'mica',
      };
      mockWindowInstance.setBackgroundMaterial.mockImplementation(() => { throw new Error('mat fail'); });

      expect(() => mw.exitWidgetMode()).not.toThrow();
      expect(mockLog.debug).toHaveBeenCalledWith(
        'Failed to restore background material for normal mode',
        { error: 'mat fail' }
      );

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });
  });

  // ---------------------------------------------------------------------------
  // toggleWidgetMode
  // ---------------------------------------------------------------------------

  describe('toggleWidgetMode()', () => {
    it('enters widget mode when in normal mode', () => {
      const mw = createMainWindow();
      mw.create();
      const spy = jest.spyOn(mw, 'enterWidgetMode').mockImplementation(() => {});
      mw.toggleWidgetMode();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('exits widget mode when in widget mode', () => {
      const mw = createMainWindow();
      mw.create();
      mw.isWidgetMode = true;
      const spy = jest.spyOn(mw, 'exitWidgetMode').mockImplementation(() => {});
      mw.toggleWidgetMode();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // startWidgetDrag / moveWidgetDrag / endWidgetDrag
  // ---------------------------------------------------------------------------

  describe('startWidgetDrag()', () => {
    it('snapshots window position and cursor screen coords', () => {
      const mw = createMainWindow();
      mw.create();
      mw.isWidgetMode = true;
      mockWindowInstance.getPosition = jest.fn(() => [100, 200]);
      mw.startWidgetDrag({ screenX: 500, screenY: 300 });
      expect(mw._dragState).toEqual({
        startScreenX: 500,
        startScreenY: 300,
        startWinX: 100,
        startWinY: 200,
      });
    });

    it('ignores when not in widget mode', () => {
      const mw = createMainWindow();
      mw.create();
      mw.isWidgetMode = false;
      mw.startWidgetDrag({ screenX: 500, screenY: 300 });
      expect(mw._dragState).toBeUndefined();
    });

    it('ignores when window is destroyed', () => {
      const mw = createMainWindow();
      mw.create();
      mw.isWidgetMode = true;
      mockWindowInstance.isDestroyed.mockReturnValue(true);
      mw.startWidgetDrag({ screenX: 500, screenY: 300 });
      expect(mw._dragState).toBeUndefined();
    });
  });

  describe('moveWidgetDrag()', () => {
    it('repositions window by screen delta', () => {
      const mw = createMainWindow();
      mw.create();
      mw.isWidgetMode = true;
      mockWindowInstance.getPosition = jest.fn(() => [100, 200]);
      mockWindowInstance.setPosition = jest.fn();
      mw.startWidgetDrag({ screenX: 500, screenY: 300 });

      mw.moveWidgetDrag({ screenX: 520, screenY: 310 });
      expect(mockWindowInstance.setPosition).toHaveBeenCalledWith(120, 210);
      expect(mw.widgetBounds).toEqual({ x: 120, y: 210 });
    });

    it('ignores when no drag state', () => {
      const mw = createMainWindow();
      mw.create();
      mockWindowInstance.setPosition = jest.fn();
      mw.moveWidgetDrag({ screenX: 520, screenY: 310 });
      expect(mockWindowInstance.setPosition).not.toHaveBeenCalled();
    });

    it('ignores when window is destroyed', () => {
      const mw = createMainWindow();
      mw.create();
      mw.isWidgetMode = true;
      mockWindowInstance.getPosition = jest.fn(() => [100, 200]);
      mockWindowInstance.setPosition = jest.fn();
      mw.startWidgetDrag({ screenX: 500, screenY: 300 });
      mockWindowInstance.isDestroyed.mockReturnValue(true);
      mw.moveWidgetDrag({ screenX: 520, screenY: 310 });
      expect(mockWindowInstance.setPosition).not.toHaveBeenCalled();
    });
  });

  describe('endWidgetDrag()', () => {
    it('clears drag state', () => {
      const mw = createMainWindow();
      mw.create();
      mw.isWidgetMode = true;
      mockWindowInstance.getPosition = jest.fn(() => [100, 200]);
      mw.startWidgetDrag({ screenX: 500, screenY: 300 });
      expect(mw._dragState).not.toBeNull();

      mw.endWidgetDrag();
      expect(mw._dragState).toBeNull();
    });

    it('no-op when no drag state', () => {
      const mw = createMainWindow();
      mw.create();
      expect(() => mw.endWidgetDrag()).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Zoom
  // ---------------------------------------------------------------------------

  describe('handleWheelEvent()', () => {
    let mw;

    beforeEach(() => {
      mw = createMainWindow();
      mw.create();
    });

    it('ignores non-ctrl wheel events', () => {
      mw.handleWheelEvent({ ctrlKey: false, deltaY: -100 });
      expect(mockWindowInstance.webContents.setZoomFactor).not.toHaveBeenCalled();
    });

    it('zooms in on ctrl+scroll up (negative deltaY)', () => {
      mw.handleWheelEvent({ ctrlKey: true, deltaY: -100 });
      expect(mockWindowInstance.webContents.setZoomFactor).toHaveBeenCalledWith(1.1);
    });

    it('zooms out on ctrl+scroll down (positive deltaY)', () => {
      mw.handleWheelEvent({ ctrlKey: true, deltaY: 100 });
      expect(mockWindowInstance.webContents.setZoomFactor).toHaveBeenCalledWith(0.9);
    });

    it('clamps zoom to max 2.0', () => {
      mockWindowInstance.webContents.getZoomFactor.mockReturnValue(2.0);
      mw.handleWheelEvent({ ctrlKey: true, deltaY: -100 });
      expect(mockWindowInstance.webContents.setZoomFactor).toHaveBeenCalledWith(2.0);
    });

    it('clamps zoom to min 0.5', () => {
      mockWindowInstance.webContents.getZoomFactor.mockReturnValue(0.5);
      mw.handleWheelEvent({ ctrlKey: true, deltaY: 100 });
      expect(mockWindowInstance.webContents.setZoomFactor).toHaveBeenCalledWith(0.5);
    });
  });

  describe('zoomIn()', () => {
    it('increases zoom by 0.1', () => {
      const mw = createMainWindow();
      mw.create();
      mw.zoomIn();
      expect(mockWindowInstance.webContents.setZoomFactor).toHaveBeenCalledWith(1.1);
    });

    it('clamps at max 2.0', () => {
      const mw = createMainWindow();
      mw.create();
      mockWindowInstance.webContents.getZoomFactor.mockReturnValue(2.0);
      mw.zoomIn();
      expect(mockWindowInstance.webContents.setZoomFactor).toHaveBeenCalledWith(2.0);
    });
  });

  describe('zoomOut()', () => {
    it('decreases zoom by 0.1', () => {
      const mw = createMainWindow();
      mw.create();
      mw.zoomOut();
      expect(mockWindowInstance.webContents.setZoomFactor).toHaveBeenCalledWith(0.9);
    });

    it('clamps at min 0.5', () => {
      const mw = createMainWindow();
      mw.create();
      mockWindowInstance.webContents.getZoomFactor.mockReturnValue(0.5);
      mw.zoomOut();
      expect(mockWindowInstance.webContents.setZoomFactor).toHaveBeenCalledWith(0.5);
    });
  });

  // ---------------------------------------------------------------------------
  // Utility methods
  // ---------------------------------------------------------------------------

  describe('getWindow()', () => {
    it('returns null before create', () => {
      expect(createMainWindow().getWindow()).toBeNull();
    });

    it('returns window after create', () => {
      const mw = createMainWindow();
      mw.create();
      expect(mw.getWindow()).toBe(mockWindowInstance);
    });
  });

  describe('exists()', () => {
    it('returns falsy when no window', () => {
      expect(createMainWindow().exists()).toBeFalsy();
    });

    it('returns true when window exists and not destroyed', () => {
      const mw = createMainWindow();
      mw.create();
      expect(mw.exists()).toBe(true);
    });

    it('returns false when window is destroyed', () => {
      const mw = createMainWindow();
      mw.create();
      mockWindowInstance.isDestroyed.mockReturnValue(true);
      expect(mw.exists()).toBe(false);
    });
  });

  describe('show()', () => {
    it('shows window when it exists', () => {
      const mw = createMainWindow();
      mw.create();
      mw.show();
      expect(mockWindowInstance.show).toHaveBeenCalledTimes(1);
    });

    it('no-op when window does not exist', () => {
      const mw = createMainWindow();
      mw.show();
      expect(mockWindowInstance.show).not.toHaveBeenCalled();
    });
  });

  describe('hide()', () => {
    it('hides window when it exists', () => {
      const mw = createMainWindow();
      mw.create();
      mw.hide();
      expect(mockWindowInstance.hide).toHaveBeenCalledTimes(1);
    });

    it('no-op when window does not exist', () => {
      const mw = createMainWindow();
      mw.hide();
      expect(mockWindowInstance.hide).not.toHaveBeenCalled();
    });
  });

  describe('focus()', () => {
    it('focuses window when it exists', () => {
      const mw = createMainWindow();
      mw.create();
      mw.focus();
      expect(mockWindowInstance.focus).toHaveBeenCalledTimes(1);
    });

    it('no-op when window does not exist', () => {
      const mw = createMainWindow();
      mw.focus();
      expect(mockWindowInstance.focus).not.toHaveBeenCalled();
    });
  });

  describe('destroy()', () => {
    it('destroys window and nulls reference', () => {
      const mw = createMainWindow();
      mw.create();
      mw.destroy();
      expect(mockWindowInstance.destroy).toHaveBeenCalledTimes(1);
      expect(mw.window).toBeNull();
    });

    it('no-op when window does not exist', () => {
      const mw = createMainWindow();
      mw.destroy();
      expect(mockWindowInstance.destroy).not.toHaveBeenCalled();
    });

    it('no-op when window already destroyed', () => {
      const mw = createMainWindow();
      mw.create();
      mockWindowInstance.isDestroyed.mockReturnValue(true);
      mw.destroy();
      expect(mockWindowInstance.destroy).not.toHaveBeenCalled();
    });
  });
});
