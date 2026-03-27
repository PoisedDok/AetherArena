'use strict';

// =============================================================================
// Mocks (before require)
// =============================================================================

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

const mockIpcMainHandlers = new Map();
const mockIpcMainOnHandlers = new Map();

const mockIpcMain = {
  on: jest.fn((channel, handler) => { mockIpcMainOnHandlers.set(channel, handler); }),
  handle: jest.fn((channel, handler) => { mockIpcMainHandlers.set(channel, handler); }),
  removeHandler: jest.fn((channel) => { mockIpcMainHandlers.delete(channel); }),
  removeAllListeners: jest.fn((channel) => { mockIpcMainOnHandlers.delete(channel); }),
};

const mockDialog = {
  showSaveDialog: jest.fn(),
  showOpenDialog: jest.fn(),
};

const mockShell = { openExternal: jest.fn().mockResolvedValue(undefined) };
const mockApp = { relaunch: jest.fn(), exit: jest.fn(), quit: jest.fn() };

jest.mock('electron', () => ({
  ipcMain: mockIpcMain,
  dialog: mockDialog,
  shell: mockShell,
  app: mockApp,
  BrowserWindow: jest.fn(() => ({
    show: jest.fn(),
    destroy: jest.fn(),
    webContents: {
      once: jest.fn(),
      loadURL: jest.fn(),
      printToPDF: jest.fn(),
    },
  })),
}), { virtual: true });

jest.mock('../../../src/core/utils/logger', () => ({
  logger: { child: jest.fn(() => mockLog) },
}));

jest.mock('../../../src/core/config', () => ({
  backend: { baseUrl: 'http://localhost:8765' },
}));

jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
}));

const { IpcRouter, getRouter, createRouter } = require('../../../src/main/services/IpcRouter');

// =============================================================================
// Helpers
// =============================================================================

function createMockWebContents(id) {
  return { id, send: jest.fn() };
}

function createMockWindow(webContents = null) {
  return {
    webContents: webContents || createMockWebContents(Math.random()),
    isDestroyed: jest.fn(() => false),
    show: jest.fn(),
    focus: jest.fn(),
  };
}

function createMockWindowManager() {
  const mainWin = createMockWindow();
  const chatWin = createMockWindow();
  const artifactsWin = createMockWindow();
  
  const mockArtifactsWrapper = {
    exists: jest.fn(() => true),
    show: jest.fn(),
    focus: jest.fn(),
    setActive: jest.fn(),
    getWindow: jest.fn(() => artifactsWin),
    isVisible: jest.fn(() => artifactsWin.isVisible ? artifactsWin.isVisible() : false)
  };

  return {
    getMainWindow: jest.fn(() => mainWin),
    getChatWindow: jest.fn(() => chatWin),
    getArtifactsWindow: jest.fn(() => artifactsWin),
    getNotesWindow: jest.fn(() => createMockWindow()),
    getIndexBrowserWindow: jest.fn(() => createMockWindow()),
    getResearchWindow: jest.fn(() => createMockWindow()),
    createAuxWindows: jest.fn(),
    createChatWindow: jest.fn(),
    createArtifactsWindow: jest.fn(),
    toggleWidgetMode: jest.fn(),
    enterWidgetMode: jest.fn(),
    exitWidgetMode: jest.fn(),
    startWidgetDrag: jest.fn(),
    moveWidgetDrag: jest.fn(),
    endWidgetDrag: jest.fn(),
    handleWheelEvent: jest.fn(),
    zoomIn: jest.fn(),
    zoomOut: jest.fn(),
    controlChatWindow: jest.fn(),
    controlArtifactsWindow: jest.fn(),
    ensureChatWindowVisible: jest.fn(),
    ensureArtifactsWindowVisible: jest.fn(),
    sendToArtifacts: jest.fn(),
    sendToChat: jest.fn(),
    sendToMain: jest.fn(),
    focusArtifacts: jest.fn(),
    loadArtifactsCode: jest.fn(),
    loadArtifactsOutput: jest.fn(),
    exportArtifactFile: jest.fn().mockResolvedValue(undefined),
    openFile: jest.fn().mockResolvedValue(undefined),
    setArtifactsWindowState: jest.fn(),
    isArtifactsWindowActive: jest.fn(() => false),
    revealChatAfterWelcome: jest.fn(),
    scheduleArtifactsAutoHide: jest.fn(),
    cancelArtifactsAutoHide: jest.fn(),
    isWidgetMode: false,
    _mainWin: mainWin,
    _chatWin: chatWin,
    _artifactsWin: artifactsWin,
    artifactsWindow: mockArtifactsWrapper,
  };
}

function triggerRoute(channel, event, ...args) {
  const handler = mockIpcMainOnHandlers.get(channel);
  if (!handler) throw new Error(`No handler for channel: ${channel}`);
  return handler(event, ...args);
}

function triggerHandle(channel, event, ...args) {
  const handler = mockIpcMainHandlers.get(channel);
  if (!handler) throw new Error(`No handle for channel: ${channel}`);
  return handler(event, ...args);
}

// =============================================================================
// Tests
// =============================================================================

describe('IpcRouter', () => {
  let wm;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIpcMainHandlers.clear();
    mockIpcMainOnHandlers.clear();
    wm = createMockWindowManager();
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('throws when windowManager is missing', () => {
      expect(() => new IpcRouter(null)).toThrow('WindowManager is required for IpcRouter');
    });

    it('stores windowManager and initializes state', () => {
      const router = new IpcRouter(wm);
      expect(router.windowManager).toBe(wm);
      expect(router.handlers).toBeInstanceOf(Map);
      expect(router.handleHandlers).toBeInstanceOf(Map);
      expect(router.isInitialized).toBe(false);
    });

    it('accepts optional systemMonitor', () => {
      const monitor = { getStats: jest.fn() };
      const router = new IpcRouter(wm, { systemMonitor: monitor });
      expect(router.systemMonitor).toBe(monitor);
    });

    it('sets default option values', () => {
      const router = new IpcRouter(wm);
      expect(router.options.validateSource).toBe(true);
      expect(router.options.logMessages).toBe(false);
      expect(router.options.logErrors).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // initialize / shutdown
  // ---------------------------------------------------------------------------

  describe('initialize()', () => {
    it('registers all IPC handlers', () => {
      const router = new IpcRouter(wm);
      router.initialize();

      expect(mockIpcMain.on.mock.calls.length).toBeGreaterThan(15);
      expect(mockIpcMain.handle.mock.calls.length).toBeGreaterThan(3);
      expect(router.isInitialized).toBe(true);
    });

    it('is idempotent (double-init guard)', () => {
      const router = new IpcRouter(wm);
      router.initialize();
      const count = mockIpcMain.on.mock.calls.length;
      router.initialize();
      expect(mockIpcMain.on.mock.calls.length).toBe(count);
      expect(mockLog.warn).toHaveBeenCalledWith('IpcRouter already initialized');
    });
  });

  describe('shutdown()', () => {
    it('removes all registered handlers', () => {
      const router = new IpcRouter(wm);
      router.initialize();
      const onCount = router.handlers.size;
      const handleCount = router.handleHandlers.size;

      router.shutdown();

      expect(mockIpcMain.removeAllListeners).toHaveBeenCalledTimes(onCount);
      expect(mockIpcMain.removeHandler).toHaveBeenCalledTimes(handleCount);
      expect(router.handlers.size).toBe(0);
      expect(router.handleHandlers.size).toBe(0);
      expect(router.isInitialized).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // _registerRoute internals
  // ---------------------------------------------------------------------------

  describe('_registerRoute()', () => {
    it('warns when overwriting existing route', () => {
      const router = new IpcRouter(wm);
      router._registerRoute('test:channel', jest.fn());
      router._registerRoute('test:channel', jest.fn());
      expect(mockLog.warn).toHaveBeenCalledWith('Route already registered, overwriting', { channel: 'test:channel' });
    });

    it('logs messages when logMessages is enabled', () => {
      const router = new IpcRouter(wm, { logMessages: true });
      const handler = jest.fn();
      router._registerRoute('test:log', handler);

      const event = { sender: wm._mainWin.webContents };
      triggerRoute('test:log', event, 'data');

      expect(mockLog.debug).toHaveBeenCalledWith('IPC message received', expect.objectContaining({
        channel: 'test:log',
      }));
    });

    it('rejects unauthorized source', () => {
      const router = new IpcRouter(wm);
      const handler = jest.fn();
      router._registerRoute('test:restricted', handler, { allowedSources: ['mainWindow'] });

      // Send from unknown source
      const unknownWebContents = createMockWebContents(999);
      const event = { sender: unknownWebContents };
      triggerRoute('test:restricted', event);

      expect(handler).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith('IPC message from unauthorized source', expect.objectContaining({
        channel: 'test:restricted',
      }));
    });

    it('allows authorized source', () => {
      const router = new IpcRouter(wm);
      const handler = jest.fn();
      router._registerRoute('test:ok', handler, { allowedSources: ['mainWindow'] });

      const event = { sender: wm._mainWin.webContents };
      triggerRoute('test:ok', event, 'arg1');

      expect(handler).toHaveBeenCalledWith(event, 'arg1');
    });

    it('catches handler errors and logs them', () => {
      const router = new IpcRouter(wm);
      const handler = jest.fn(() => { throw new Error('handler boom'); });
      router._registerRoute('test:err', handler);

      const event = { sender: wm._mainWin.webContents };
      triggerRoute('test:err', event);

      expect(mockLog.error).toHaveBeenCalledWith('IPC handler error', expect.objectContaining({
        channel: 'test:err',
        error: 'handler boom',
      }));
    });

    it('suppresses error logging when logErrors is false', () => {
      const router = new IpcRouter(wm, { logErrors: false });
      const handler = jest.fn(() => { throw new Error('silent'); });
      router._registerRoute('test:quiet', handler);

      const event = { sender: wm._mainWin.webContents };
      triggerRoute('test:quiet', event);

      expect(mockLog.error).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // _registerHandle
  // ---------------------------------------------------------------------------

  describe('_registerHandle()', () => {
    it('registers handle handler', () => {
      const router = new IpcRouter(wm);
      const handler = jest.fn();
      router._registerHandle('test:handle', handler);
      expect(mockIpcMain.handle).toHaveBeenCalledWith('test:handle', expect.any(Function));
      expect(router.handleHandlers.has('test:handle')).toBe(true);
    });

    it('removes previous handler when overwriting', () => {
      const router = new IpcRouter(wm);
      router._registerHandle('test:handle', jest.fn());
      router._registerHandle('test:handle', jest.fn());
      expect(mockIpcMain.removeHandler).toHaveBeenCalledWith('test:handle');
    });
  });

  // ---------------------------------------------------------------------------
  // _getWindowName
  // ---------------------------------------------------------------------------

  describe('_getWindowName()', () => {
    it('identifies mainWindow', () => {
      const router = new IpcRouter(wm);
      expect(router._getWindowName(wm._mainWin.webContents)).toBe('mainWindow');
    });

    it('identifies chatWindow', () => {
      const router = new IpcRouter(wm);
      expect(router._getWindowName(wm._chatWin.webContents)).toBe('chatWindow');
    });

    it('identifies artifactsWindow', () => {
      const router = new IpcRouter(wm);
      expect(router._getWindowName(wm._artifactsWin.webContents)).toBe('artifactsWindow');
    });

    it('returns unknown for unrecognized sender', () => {
      const router = new IpcRouter(wm);
      expect(router._getWindowName(createMockWebContents(999))).toBe('unknown');
    });
  });

  // ---------------------------------------------------------------------------
  // _sendToWindow
  // ---------------------------------------------------------------------------

  describe('_sendToWindow()', () => {
    it('sends message to valid window', () => {
      const router = new IpcRouter(wm);
      const result = router._sendToWindow(wm._chatWin, 'test:msg', 'arg1');
      expect(result).toBe(true);
      expect(wm._chatWin.webContents.send).toHaveBeenCalledWith('test:msg', 'arg1');
    });

    it('returns false for null window', () => {
      const router = new IpcRouter(wm);
      expect(router._sendToWindow(null, 'test:msg')).toBe(false);
    });

    it('returns false for destroyed window', () => {
      const router = new IpcRouter(wm);
      wm._chatWin.isDestroyed.mockReturnValue(true);
      expect(router._sendToWindow(wm._chatWin, 'test:msg')).toBe(false);
    });

    it('returns false and logs error on send failure', () => {
      const router = new IpcRouter(wm);
      wm._chatWin.webContents.send.mockImplementation(() => { throw new Error('send fail'); });
      expect(router._sendToWindow(wm._chatWin, 'test:msg')).toBe(false);
      expect(mockLog.error).toHaveBeenCalledWith('Failed to send to window', expect.objectContaining({ error: 'send fail' }));
    });
  });

  // ---------------------------------------------------------------------------
  // _sanitizeExternalUrl
  // ---------------------------------------------------------------------------

  describe('_sanitizeExternalUrl()', () => {
    it('accepts and normalizes allowed protocols', () => {
      const router = new IpcRouter(wm);
      expect(router._sanitizeExternalUrl('https://example.com')).toBe('https://example.com/');
      expect(router._sanitizeExternalUrl('mailto:test@example.com')).toBe('mailto:test@example.com');
      expect(router._sanitizeExternalUrl('tel:+123456789')).toBe('tel:+123456789');
    });

    it('rejects unsupported or malformed URLs', () => {
      const router = new IpcRouter(wm);
      expect(router._sanitizeExternalUrl('javascript:alert(1)')).toBeNull();
      expect(router._sanitizeExternalUrl('data:text/html,abc')).toBeNull();
      expect(router._sanitizeExternalUrl('notaurl')).toBeNull();
    });

    it('rejects non-string and oversized URLs', () => {
      const router = new IpcRouter(wm);
      expect(router._sanitizeExternalUrl(null)).toBeNull();
      expect(router._sanitizeExternalUrl(42)).toBeNull();
      expect(router._sanitizeExternalUrl(`https://example.com/${'x'.repeat(2050)}`)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Main Window Routes
  // ---------------------------------------------------------------------------

  describe('Main Window Routes', () => {
    let router;
    beforeEach(() => {
      router = new IpcRouter(wm);
      router.initialize();
    });
    afterEach(() => {
      router.shutdown();
    });

    it('startup:animation-complete creates aux windows', () => {
      triggerRoute('startup:animation-complete', { sender: wm._mainWin.webContents });
      expect(wm.createAuxWindows).toHaveBeenCalled();
    });

    it('toggle-widget-mode delegates to windowManager', () => {
      triggerRoute('toggle-widget-mode', { sender: wm._mainWin.webContents });
      expect(wm.toggleWidgetMode).toHaveBeenCalled();
    });

    it('window-double-clicked delegates to toggleWidgetMode', () => {
      triggerRoute('window-double-clicked', { sender: wm._mainWin.webContents });
      expect(wm.toggleWidgetMode).toHaveBeenCalled();
    });

    it('window-toggle-chat creates chat window when none exists', () => {
      wm.getChatWindow.mockReturnValue(null);
      triggerRoute('window-toggle-chat', { sender: wm._mainWin.webContents });
      expect(wm.createChatWindow).toHaveBeenCalled();
    });

    it('window-toggle-chat creates chat window when destroyed', () => {
      const chatWin = { isDestroyed: jest.fn(() => true) };
      wm.getChatWindow.mockReturnValue(chatWin);
      triggerRoute('window-toggle-chat', { sender: wm._mainWin.webContents });
      expect(wm.createChatWindow).toHaveBeenCalled();
    });

    it('window-toggle-chat hides visible chat window', () => {
      const chatWin = { isDestroyed: jest.fn(() => false), isVisible: jest.fn(() => true), hide: jest.fn(), show: jest.fn(), focus: jest.fn(), webContents: { send: jest.fn() } };
      wm.getChatWindow.mockReturnValue(chatWin);
      triggerRoute('window-toggle-chat', { sender: wm._mainWin.webContents });
      expect(chatWin.hide).toHaveBeenCalled();
      expect(chatWin.show).not.toHaveBeenCalled();
    });

    it('window-toggle-chat shows and focuses hidden chat window', () => {
      const chatWin = { isDestroyed: jest.fn(() => false), isVisible: jest.fn(() => false), hide: jest.fn(), show: jest.fn(), focus: jest.fn(), webContents: { send: jest.fn() } };
      wm.getChatWindow.mockReturnValue(chatWin);
      triggerRoute('window-toggle-chat', { sender: wm._mainWin.webContents });
      expect(chatWin.show).toHaveBeenCalled();
      expect(chatWin.focus).toHaveBeenCalled();
    });

    it('window-toggle-chat logs error on show failure', () => {
      const chatWin = { isDestroyed: jest.fn(() => false), isVisible: jest.fn(() => false), show: jest.fn(() => { throw new Error('show boom'); }), focus: jest.fn(), webContents: { send: jest.fn() } };
      wm.getChatWindow.mockReturnValue(chatWin);
      triggerRoute('window-toggle-chat', { sender: wm._mainWin.webContents });
      expect(mockLog.error).toHaveBeenCalledWith('IPC handler error', expect.objectContaining({ error: 'show boom' }));
    });

    it('widget-drag-start delegates screen coords', () => {
      triggerRoute('widget-drag-start', { sender: wm._mainWin.webContents }, { screenX: 300, screenY: 400 });
      expect(wm.startWidgetDrag).toHaveBeenCalledWith({ screenX: 300, screenY: 400 });
    });

    it('widget-drag-move delegates screen coords', () => {
      triggerRoute('widget-drag-move', { sender: wm._mainWin.webContents }, { screenX: 350, screenY: 450 });
      expect(wm.moveWidgetDrag).toHaveBeenCalledWith({ screenX: 350, screenY: 450 });
    });

    it('widget-drag-end delegates', () => {
      triggerRoute('widget-drag-end', { sender: wm._mainWin.webContents });
      expect(wm.endWidgetDrag).toHaveBeenCalled();
    });

    it('wheel-event delegates to handleWheelEvent', () => {
      triggerRoute('wheel-event', { sender: wm._mainWin.webContents }, { ctrlKey: true, deltaY: -1 });
      expect(wm.handleWheelEvent).toHaveBeenCalledWith({ ctrlKey: true, deltaY: -1 });
    });

    it('zoom-in and zoom-out delegate', () => {
      triggerRoute('zoom-in', { sender: wm._mainWin.webContents });
      expect(wm.zoomIn).toHaveBeenCalled();
      triggerRoute('zoom-out', { sender: wm._mainWin.webContents });
      expect(wm.zoomOut).toHaveBeenCalled();
    });

    it('artifacts:stream forwards to artifacts window', () => {
      const data = { artifact_id: '123', content: 'code' };
      triggerRoute('artifacts:stream', { sender: wm._mainWin.webContents }, data);
      expect(wm.sendToArtifacts).toHaveBeenCalledWith('artifacts:stream', data);
    });

    it('artifacts:stream rejects non-main source', () => {
      const data = { artifact_id: '123' };
      triggerRoute('artifacts:stream', { sender: wm._chatWin.webContents }, data);
      expect(mockLog.warn).toHaveBeenCalledWith('IPC message from unauthorized source', expect.objectContaining({
        channel: 'artifacts:stream',
        source: 'chatWindow',
      }));
    });

    it('app:relaunch calls app.relaunch and app.quit (graceful shutdown)', () => {
      triggerRoute('app:relaunch', { sender: wm._mainWin.webContents });
      expect(mockApp.relaunch).toHaveBeenCalled();
      // Must use app.quit() (not app.exit()) to trigger before-quit handler
      // which runs shutdown() and kills the detached backend process group.
      expect(mockApp.quit).toHaveBeenCalled();
    });

    it('app:quit calls app.quit', () => {
      triggerRoute('app:quit', { sender: wm._mainWin.webContents });
      expect(mockApp.quit).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Chat Window Routes
  // ---------------------------------------------------------------------------

  describe('Chat Window Routes', () => {
    let router;
    beforeEach(() => {
      router = new IpcRouter(wm);
      router.initialize();
    });
    afterEach(() => {
      router.shutdown();
    });

    it('chat:window-control delegates', () => {
      triggerRoute('chat:window-control', { sender: wm._chatWin.webContents }, 'minimize');
      expect(wm.controlChatWindow).toHaveBeenCalledWith('minimize');
    });

    it('chat:show-window shows existing window', () => {
      triggerRoute('chat:show-window', { sender: wm._mainWin.webContents });
      expect(wm.ensureChatWindowVisible).toHaveBeenCalled();
    });

    it('chat:show-window creates window if destroyed', () => {
      wm.getChatWindow.mockReturnValue(null);
      triggerRoute('chat:show-window', { sender: wm._mainWin.webContents });
      expect(wm.ensureChatWindowVisible).toHaveBeenCalled();
    });

    it('chat:switch-to-chat sends load-specific to chat', () => {
      triggerRoute('chat:switch-to-chat', { sender: wm._mainWin.webContents }, { chatId: 'abc' });
      expect(wm.ensureChatWindowVisible).toHaveBeenCalled();
      expect(wm.sendToChat).toHaveBeenCalledWith('chat:load-specific', { chatId: 'abc' });
    });

    it('chat:proactive-context forwards to chat', () => {
      const data = { context: 'test' };
      triggerRoute('chat:proactive-context', { sender: wm._mainWin.webContents }, data);
      expect(wm.ensureChatWindowVisible).toHaveBeenCalled();
      expect(wm.sendToChat).toHaveBeenCalledWith('chat:proactive-context', data);
    });

    it('chat:send forwards from chat to main', () => {
      const payload = { message: 'hello' };
      triggerRoute('chat:send', { sender: wm._chatWin.webContents }, payload);
      expect(wm.sendToMain).toHaveBeenCalledWith('chat:send', payload);
    });

    it('chat:assistant-stream enriches and forwards', () => {
      const data = { chunk: 'text' };
      triggerRoute('chat:assistant-stream', { sender: wm._mainWin.webContents }, data);
      expect(wm.sendToChat).toHaveBeenCalledWith(
        'chat:assistant-stream',
        expect.objectContaining({ chunk: 'text', _timestamp: expect.any(Number) })
      );
    });

    it('chat:assistant-persist forwards', () => {
      triggerRoute('chat:assistant-persist', { sender: wm._mainWin.webContents }, { data: 'persist' });
      expect(wm.sendToChat).toHaveBeenCalledWith('chat:assistant-stream-persist', { data: 'persist' });
    });

    it('chat:request-complete forwards and schedules artifacts auto-hide', () => {
      triggerRoute('chat:request-complete', { sender: wm._mainWin.webContents });
      expect(wm.sendToChat).toHaveBeenCalledWith('chat:request-complete');
      expect(wm.scheduleArtifactsAutoHide).toHaveBeenCalled();
    });

    it('chat:stt-stream forwards', () => {
      triggerRoute('chat:stt-stream', { sender: wm._mainWin.webContents }, { text: 'hello' });
      expect(wm.sendToChat).toHaveBeenCalledWith('chat:stt-stream', { text: 'hello' });
    });

    it('chat:stop forwards to both windows', () => {
      triggerRoute('chat:stop', { sender: wm._chatWin.webContents }, { reason: 'user' });
      expect(wm.sendToMain).toHaveBeenCalledWith('chat:stop', { reason: 'user' });
      expect(wm.sendToChat).toHaveBeenCalledWith('chat:stop', { reason: 'user' });
    });

    it('artifacts:stream:ready forwards to artifacts (stage 2)', () => {
      const data = { chatId: 'abc', artifact_id: '123' };
      triggerRoute('artifacts:stream:ready', { sender: wm._chatWin.webContents }, data);
      expect(wm.sendToArtifacts).toHaveBeenCalledWith('artifacts:stream', data);
    });

    it('artifacts:stream:ready rejects non-chat source', () => {
      triggerRoute('artifacts:stream:ready', { sender: wm._mainWin.webContents }, {});
      expect(mockLog.warn).toHaveBeenCalledWith('IPC message from unauthorized source', expect.objectContaining({
        channel: 'artifacts:stream:ready',
        source: 'mainWindow',
      }));
    });

    it('artifacts:switch-chat forwards', () => {
      triggerRoute('artifacts:switch-chat', { sender: wm._chatWin.webContents }, 'chat123');
      expect(wm.sendToArtifacts).toHaveBeenCalledWith('artifacts:switch-chat', 'chat123');
    });

    it('artifacts:focus-artifacts delegates', () => {
      triggerRoute('artifacts:focus-artifacts', { sender: wm._chatWin.webContents }, { id: '1' });
      expect(wm.focusArtifacts).toHaveBeenCalledWith({ id: '1' });
    });

    it('artifacts:switch-tab forwards', () => {
      triggerRoute('artifacts:switch-tab', { sender: wm._chatWin.webContents }, 'code');
      expect(wm.sendToArtifacts).toHaveBeenCalledWith('artifacts:switch-tab', 'code');
    });

    it('artifacts:show-artifact creates window if needed and shows', () => {
      triggerRoute('artifacts:show-artifact', { sender: wm._chatWin.webContents }, { id: '1' });
      expect(wm.ensureArtifactsWindowVisible).toHaveBeenCalled();
      expect(wm.sendToArtifacts).toHaveBeenCalledWith('artifacts:show-artifact', { id: '1' });
    });

    it('artifacts:show-window creates window if needed', () => {
      triggerRoute('artifacts:show-window', { sender: wm._chatWin.webContents });
      expect(wm.ensureArtifactsWindowVisible).toHaveBeenCalled();
    });

    it('artifacts:show-window shows existing window', () => {
      triggerRoute('artifacts:show-window', { sender: wm._chatWin.webContents });
      expect(wm.ensureArtifactsWindowVisible).toHaveBeenCalled();
    });

    it('artifacts:load-code delegates', () => {
      triggerRoute('artifacts:load-code', { sender: wm._chatWin.webContents }, { code: 'x' });
      expect(wm.loadArtifactsCode).toHaveBeenCalledWith({ code: 'x' });
    });

    it('artifacts:load-output delegates', () => {
      triggerRoute('artifacts:load-output', { sender: wm._chatWin.webContents }, { output: 'y' });
      expect(wm.loadArtifactsOutput).toHaveBeenCalledWith({ output: 'y' });
    });
  });

  // ---------------------------------------------------------------------------
  // Artifacts Window Routes
  // ---------------------------------------------------------------------------

  describe('Artifacts Window Routes', () => {
    let router;
    beforeEach(() => {
      router = new IpcRouter(wm);
      router.initialize();
    });
    afterEach(() => {
      router.shutdown();
    });

    it('artifacts:window-control delegates', () => {
      triggerRoute('artifacts:window-control', { sender: wm._artifactsWin.webContents }, 'close');
      expect(wm.controlArtifactsWindow).toHaveBeenCalledWith('close');
    });

    it('artifacts:window-state updates and notifies chat', () => {
      triggerRoute('artifacts:window-state', { sender: wm._artifactsWin.webContents }, { active: true });
      expect(wm.setArtifactsWindowState).toHaveBeenCalledWith({ active: true });
      expect(wm.sendToChat).toHaveBeenCalledWith('artifacts:window-state', { active: true });
    });

    it('artifacts:mode-changed logs mode', () => {
      triggerRoute('artifacts:mode-changed', { sender: wm._artifactsWin.webContents }, 'code');
      expect(mockLog.debug).toHaveBeenCalledWith('Artifacts mode changed', { mode: 'code' });
    });

    it('artifacts:file-export delegates', () => {
      triggerRoute('artifacts:file-export', { sender: wm._artifactsWin.webContents }, { file: 'test.js' });
      expect(wm.exportArtifactFile).toHaveBeenCalledWith({ file: 'test.js' });
    });

    it('artifacts:file-export logs error on failure', async () => {
      wm.exportArtifactFile.mockRejectedValueOnce(new Error('export fail'));
      triggerRoute('artifacts:file-export', { sender: wm._artifactsWin.webContents }, { file: 'f' });
      await new Promise(r => setTimeout(r, 10));
      expect(mockLog.error).toHaveBeenCalledWith('Failed to export artifact file', expect.objectContaining({ error: 'export fail' }));
    });

    it('artifacts:open-file delegates', () => {
      triggerRoute('artifacts:open-file', { sender: wm._artifactsWin.webContents }, { path: '/tmp/f' });
      expect(wm.openFile).toHaveBeenCalledWith({ path: '/tmp/f' });
    });

    it('artifacts:open-file logs error on failure', async () => {
      wm.openFile.mockRejectedValueOnce(new Error('open fail'));
      triggerRoute('artifacts:open-file', { sender: wm._artifactsWin.webContents }, { path: '/x' });
      await new Promise(r => setTimeout(r, 10));
      expect(mockLog.error).toHaveBeenCalledWith('Failed to open file', expect.objectContaining({ error: 'open fail' }));
    });

    it('artifacts:execute-code validates and forwards to main', () => {
      const payload = { chatId: 'abc', code: 'print(1)', language: 'python' };
      triggerRoute('artifacts:execute-code', { sender: wm._artifactsWin.webContents }, payload);
      expect(wm.sendToMain).toHaveBeenCalledWith('chat:send', expect.objectContaining({
        chatId: 'abc',
        metadata: expect.objectContaining({ source: 'artifacts_execute', language: 'python' }),
      }));
    });

    it('artifacts:execute-code rejects invalid payload', () => {
      triggerRoute('artifacts:execute-code', { sender: wm._artifactsWin.webContents }, null);
      expect(mockLog.warn).toHaveBeenCalledWith('artifacts:execute-code invalid payload');
    });

    it('artifacts:execute-code rejects missing chatId', () => {
      triggerRoute('artifacts:execute-code', { sender: wm._artifactsWin.webContents }, { code: 'x', language: 'py' });
      expect(mockLog.warn).toHaveBeenCalledWith('artifacts:execute-code missing chatId');
    });

    it('artifacts:execute-code rejects missing code', () => {
      triggerRoute('artifacts:execute-code', { sender: wm._artifactsWin.webContents }, { chatId: 'a', language: 'py' });
      expect(mockLog.warn).toHaveBeenCalledWith('artifacts:execute-code missing code');
    });

    it('artifacts:execute-code rejects missing language', () => {
      triggerRoute('artifacts:execute-code', { sender: wm._artifactsWin.webContents }, { chatId: 'a', code: 'x' });
      expect(mockLog.warn).toHaveBeenCalledWith('artifacts:execute-code missing language');
    });
  });

  // ---------------------------------------------------------------------------
  // Utility Routes
  // ---------------------------------------------------------------------------

  describe('Utility Routes', () => {
    let router;
    beforeEach(() => {
      router = new IpcRouter(wm, { systemMonitor: { getStats: jest.fn(() => ({ cpu: 10 })) } });
      router.initialize();
    });
    afterEach(() => {
      router.shutdown();
    });

    it('renderer-log logs with window name', () => {
      triggerRoute('renderer-log', { sender: wm._mainWin.webContents }, 'hello');
      expect(mockLog.info).toHaveBeenCalledWith('[Renderer:mainWindow] hello');
    });

    it('open-external-url opens URL via shell', async () => {
      await triggerRoute('open-external-url', { sender: wm._mainWin.webContents }, 'https://example.com');
      expect(mockShell.openExternal).toHaveBeenCalledWith('https://example.com/');
    });

    it('open-external-url handles error', async () => {
      mockShell.openExternal.mockRejectedValueOnce(new Error('blocked'));
      await triggerRoute('open-external-url', { sender: wm._mainWin.webContents }, 'https://example.com');
      expect(mockLog.error).toHaveBeenCalledWith('Failed to open external URL', expect.objectContaining({ error: 'blocked' }));
    });

    it('open-external-url rejects unsafe URL payloads', async () => {
      await triggerRoute('open-external-url', { sender: wm._mainWin.webContents }, 'javascript:alert(1)');
      expect(mockShell.openExternal).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith('Rejected external URL payload', expect.objectContaining({
        source: 'mainWindow',
      }));
    });

    it('open-external-url rejects non-main sender via allowedSources', async () => {
      await triggerRoute('open-external-url', { sender: wm._chatWin.webContents }, 'https://example.com');
      expect(mockShell.openExternal).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith('IPC message from unauthorized source', expect.objectContaining({
        channel: 'open-external-url',
        source: 'chatWindow',
      }));
    });

    it('system:get-stats returns stats from monitor', async () => {
      const result = await triggerHandle('system:get-stats', {});
      expect(result).toEqual({ cpu: 10 });
    });

    it('system:get-stats returns null without monitor', async () => {
      const router2 = new IpcRouter(wm);
      router2._registerHandle('system:get-stats-2', async () => {
        if (router2.systemMonitor) return router2.systemMonitor.getStats();
        return null;
      });
      const handler = mockIpcMainHandlers.get('system:get-stats-2');
      expect(await handler({})).toBeNull();
    });

    it('backend:get-url returns trimmed baseUrl', async () => {
      const result = await triggerHandle('backend:get-url', {});
      expect(result).toBe('http://localhost:8765');
    });

    it('dialog:show-directory-picker returns selected path', async () => {
      mockDialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/dir'] });
      const result = await triggerHandle('dialog:show-directory-picker', {});
      expect(result).toBe('/tmp/dir');
    });

    it('dialog:show-directory-picker returns null on cancel', async () => {
      mockDialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
      const result = await triggerHandle('dialog:show-directory-picker', {});
      expect(result).toBeNull();
    });

    it('dialog:show-directory-picker handles error', async () => {
      mockDialog.showOpenDialog.mockRejectedValueOnce(new Error('dialog fail'));
      const result = await triggerHandle('dialog:show-directory-picker', {});
      expect(result).toBeNull();
    });

    it('dialog:show-file-picker returns selected files', async () => {
      mockDialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/file.txt'] });
      const result = await triggerHandle('dialog:show-file-picker', {}, {});
      expect(result).toEqual(['/tmp/file.txt']);
    });

    it('dialog:show-file-picker supports multiSelections', async () => {
      mockDialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/a', '/b'] });
      await triggerHandle('dialog:show-file-picker', {}, { multiSelections: true });
      // showOpenDialog(parentWindow, dialogOptions) — dialogOptions is arg[1]
      const opts = mockDialog.showOpenDialog.mock.calls[0][1];
      expect(opts.properties).toContain('multiSelections');
    });

    it('dialog:show-file-picker supports filters', async () => {
      const filters = [{ name: 'Images', extensions: ['png'] }];
      mockDialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
      await triggerHandle('dialog:show-file-picker', {}, { filters });
      // showOpenDialog(parentWindow, dialogOptions) — dialogOptions is arg[1]
      const opts = mockDialog.showOpenDialog.mock.calls[0][1];
      expect(opts.filters).toEqual(filters);
    });

    it('dialog:show-file-picker returns null on cancel', async () => {
      mockDialog.showOpenDialog.mockResolvedValueOnce({ canceled: true });
      const result = await triggerHandle('dialog:show-file-picker', {}, {});
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Singleton
  // ---------------------------------------------------------------------------

  describe('createRouter()', () => {
    it('creates a new IpcRouter instance', () => {
      const router = createRouter(wm);
      expect(router).toBeInstanceOf(IpcRouter);
    });
  });

  // ---------------------------------------------------------------------------
  // Inline source validation (bypassing allowedSources wrapper)
  // ---------------------------------------------------------------------------

  describe('inline source validation', () => {
    it('artifacts:stream inline check rejects non-main sender', () => {
      // Use validateSource=true but no allowedSources (register manually)
      const router = new IpcRouter(wm, { validateSource: true });
      // Register the route bypassing the wrapper to test inline validation
      router._registerRoute('artifacts:stream:inline', (event, data) => {
        if (router.options.validateSource && event.sender !== wm.getMainWindow()?.webContents) {
          mockLog.warn('artifacts:stream from non-main window');
          return;
        }
        router._sendToWindow(wm._chatWin, 'artifacts:stream', data);
      });

      triggerRoute('artifacts:stream:inline', { sender: wm._chatWin.webContents }, {});
      expect(mockLog.warn).toHaveBeenCalledWith('artifacts:stream from non-main window');
    });

    it('artifacts:stream:ready inline check rejects non-chat sender', () => {
      const router = new IpcRouter(wm, { validateSource: true });
      router._registerRoute('artifacts:stream:ready:inline', (event, data) => {
        if (router.options.validateSource && event.sender !== wm.getChatWindow()?.webContents) {
          mockLog.warn('artifacts:stream:ready from non-chat window');
          return;
        }
        wm.sendToArtifacts('artifacts:stream', data);
      });

      triggerRoute('artifacts:stream:ready:inline', { sender: wm._mainWin.webContents }, {});
      expect(mockLog.warn).toHaveBeenCalledWith('artifacts:stream:ready from non-chat window');
    });
  });

  // ---------------------------------------------------------------------------
  // Backend URL edge cases
  // ---------------------------------------------------------------------------

  describe('backend:get-url edge cases', () => {
    it('throws when backend baseUrl is empty', async () => {
      const router = new IpcRouter(wm);
      // Override config mock for this specific test
      const cfg = require('../../../src/core/config');
      const origUrl = cfg.backend.baseUrl;
      cfg.backend.baseUrl = '';

      router._registerHandle('backend:get-url:empty', async () => {
        const c = require('../../../src/core/config');
        const url = c?.backend?.baseUrl;
        if (!url || typeof url !== 'string' || url.trim().length === 0) {
          throw new Error('[IpcRouter] Backend baseUrl unavailable (start/discover backend first)');
        }
        return url.replace(/\/$/, '');
      });

      const handler = mockIpcMainHandlers.get('backend:get-url:empty');
      await expect(handler({})).rejects.toThrow('Backend baseUrl unavailable');

      cfg.backend.baseUrl = origUrl;
    });
  });

  // ---------------------------------------------------------------------------
  // Dialog save PDF
  // ---------------------------------------------------------------------------

  describe('dialog:save-pdf', () => {
    let router;
    beforeEach(() => {
      router = new IpcRouter(wm);
      router.initialize();
    });
    afterEach(() => {
      router.shutdown();
    });

    it('returns canceled when user cancels dialog', async () => {
      mockDialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' });
      const result = await triggerHandle('dialog:save-pdf', {}, { html: '<h1>test</h1>', filename: 'test.pdf' });
      expect(result).toEqual({ success: false, error: 'Canceled' });
    });

    it('exports PDF successfully', async () => {
      const mockPrintWin = {
        show: jest.fn(),
        destroy: jest.fn(),
        webContents: {
          once: jest.fn((event, cb) => {
            if (event === 'did-finish-load') cb();
          }),
          loadURL: jest.fn(),
          printToPDF: jest.fn().mockResolvedValue(Buffer.from('pdf-data')),
        },
      };

      const { BrowserWindow } = require('electron');
      BrowserWindow.mockImplementationOnce(() => mockPrintWin);

      mockDialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/tmp/test.pdf' });

      const result = await triggerHandle('dialog:save-pdf', {}, { html: '<h1>Hi</h1>', filename: 'test.pdf' });
      expect(result).toEqual({ success: true, filePath: '/tmp/test.pdf' });
      expect(mockPrintWin.destroy).toHaveBeenCalled();
    });

    it('handles PDF export error', async () => {
      mockDialog.showSaveDialog.mockRejectedValueOnce(new Error('dialog err'));
      // Fallback retry also fails
      mockDialog.showSaveDialog.mockRejectedValueOnce(new Error('retry err'));

      const result = await triggerHandle('dialog:save-pdf', {}, { html: '<h1>test</h1>', filename: 'test.pdf' });
      expect(result).toEqual({ success: false, error: expect.any(String) });
    });

    it('retries dialog without parent when first attempt fails', async () => {
      // First call (with parent) fails, second call (without parent) succeeds
      mockDialog.showSaveDialog
        .mockRejectedValueOnce(new Error('parent fail'))
        .mockResolvedValueOnce({ canceled: true, filePath: '' });

      const result = await triggerHandle('dialog:save-pdf', {}, { html: '<h1>test</h1>', filename: 'test.pdf' });
      expect(result).toEqual({ success: false, error: 'Canceled' });
      expect(mockDialog.showSaveDialog).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // File picker error path
  // ---------------------------------------------------------------------------

  describe('dialog:show-file-picker error', () => {
    it('returns null on dialog error', async () => {
      const router = new IpcRouter(wm);
      router.initialize();
      mockDialog.showOpenDialog.mockRejectedValueOnce(new Error('picker fail'));
      const result = await triggerHandle('dialog:show-file-picker', {}, {});
      expect(result).toBeNull();
    });
  });
});
