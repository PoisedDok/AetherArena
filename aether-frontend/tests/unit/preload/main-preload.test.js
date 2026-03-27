'use strict';

// ============================================================================
// Mock objects — prefixed with "mock" for jest.mock hoisting compatibility.
// These are created ONCE and captured by closures in the API object during
// the single module-level require() of main-preload.js.
// ============================================================================

const mockBridge = {
  send: jest.fn(),
  on: jest.fn(() => jest.fn()),
  once: jest.fn(),
  invoke: jest.fn().mockResolvedValue({ id: 'mock-id-123' }),
  removeListener: jest.fn(),
  removeAllListeners: jest.fn(),
  getMetadata: jest.fn().mockReturnValue({ context: 'mainWindow' }),
  getStats: jest.fn().mockReturnValue({ rateLimiter: {}, sizeValidator: {} }),
};

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

// ============================================================================
// Module mocks — jest.mock is hoisted before any require().
// main-preload.js runs ALL side effects on require: createLogger, injectCspMeta,
// createBridge, Object.freeze(aetherAPI), contextBridge.exposeInMainWorld.
// ============================================================================

jest.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: jest.fn() },
  ipcRenderer: {},
}));

jest.mock('../../../src/preload/common/bridge-factory', () => ({
  createBridge: jest.fn(() => mockBridge),
}));

jest.mock('../../../src/core/utils/logger', () => ({
  createLogger: jest.fn(() => mockLog),
}));

jest.mock('../../../src/core/config/renderer-config', () => ({
  getConfigSnapshot: jest.fn(() => ({ apiUrl: 'http://localhost:3001' })),
}));

jest.mock('../../../src/preload/common/csp-injector', () => ({
  injectCspMeta: jest.fn(),
}));

// ============================================================================
// References to mocked modules (for per-test assertion and re-configuration)
// ============================================================================

const { contextBridge } = require('electron');
const { createBridge } = require('../../../src/preload/common/bridge-factory');
const { createLogger } = require('../../../src/core/utils/logger');
const rendererConfig = require('../../../src/core/config/renderer-config');
const { injectCspMeta } = require('../../../src/preload/common/csp-injector');

// ============================================================================
// Load main-preload — triggers all module-level initialization exactly once.
// After this line, aetherAPI exists and is frozen.
// ============================================================================

require('../../../src/preload/main-preload');

// Save initialization call data before any beforeEach clears mock history.
const initCalls = {
  createLogger: createLogger.mock.calls.slice(),
  createBridge: createBridge.mock.calls.slice(),
  injectCspMeta: injectCspMeta.mock.calls.slice(),
  exposeInMainWorld: contextBridge.exposeInMainWorld.mock.calls.slice(),
  logInfo: mockLog.info.mock.calls.slice(),
};

const aetherAPI = initCalls.exposeInMainWorld[0][1];

// ============================================================================
// Test Suite
// ============================================================================

describe('main-preload', () => {
  beforeEach(() => {
    // Projects do not inherit top-level clearMocks/resetMocks from jest.config.js.
    jest.clearAllMocks();
    // Re-establish implementations that API methods depend on at call time.
    mockBridge.on.mockImplementation(() => jest.fn());
    mockBridge.invoke.mockResolvedValue({ id: 'mock-id-123' });
    mockBridge.getMetadata.mockReturnValue({ context: 'mainWindow' });
    mockBridge.getStats.mockReturnValue({ rateLimiter: {}, sizeValidator: {} });
    rendererConfig.getConfigSnapshot.mockReturnValue({ apiUrl: 'http://localhost:3001' });
  });

  // --------------------------------------------------------------------------
  // Module initialization (verified from saved init call data)
  // --------------------------------------------------------------------------

  describe('module initialization', () => {
    it('creates logger with component MainPreload', () => {
      expect(initCalls.createLogger).toHaveLength(1);
      expect(initCalls.createLogger[0]).toEqual([{ component: 'MainPreload' }]);
    });

    it('injects CSP meta with rendererConfig.getConfigSnapshot reference', () => {
      expect(initCalls.injectCspMeta).toHaveLength(1);
      const arg = initCalls.injectCspMeta[0][0];
      expect(arg).toHaveProperty('getConfigSnapshot');
      expect(arg.getConfigSnapshot).toBe(rendererConfig.getConfigSnapshot);
    });

    it('creates bridge with correct security options', () => {
      expect(initCalls.createBridge).toHaveLength(1);
      const opts = initCalls.createBridge[0][0];
      expect(opts.context).toBe('mainWindow');
      expect(opts.enableRateLimiting).toBe(true);
      expect(opts.enableSizeValidation).toBe(true);
      expect(opts.enablePayloadValidation).toBe(true);
      expect(opts.ipcRenderer).toBeDefined();
      expect(typeof opts.onError).toBe('function');
    });

    it('bridge onError callback logs error with details', () => {
      const onError = initCalls.createBridge[0][0].onError;
      const err = new Error('test IPC error');
      const details = { channel: 'test:ch', reason: 'validation' };
      onError(err, details);
      expect(mockLog.error).toHaveBeenCalledWith('IPC error', {
        error: 'test IPC error',
        details: { channel: 'test:ch', reason: 'validation' },
      });
    });

    it('exposes API via contextBridge with key "aether"', () => {
      expect(initCalls.exposeInMainWorld).toHaveLength(1);
      expect(initCalls.exposeInMainWorld[0][0]).toBe('aether');
    });

    it('logs successful API exposure', () => {
      const infoMessages = initCalls.logInfo.map(call => call[0]);
      expect(infoMessages).toContain('main window API exposed');
    });

    it('aetherAPI is defined and is an object', () => {
      expect(aetherAPI).toBeDefined();
      expect(typeof aetherAPI).toBe('object');
    });
  });

  // --------------------------------------------------------------------------
  // Frozen API objects — Object.freeze verification
  // --------------------------------------------------------------------------

  describe('frozen API objects', () => {
    it('aetherAPI is frozen', () => {
      expect(Object.isFrozen(aetherAPI)).toBe(true);
    });

    it('aetherAPI.config is frozen', () => {
      expect(Object.isFrozen(aetherAPI.config)).toBe(true);
    });

    it('aetherAPI.ipc is frozen', () => {
      expect(Object.isFrozen(aetherAPI.ipc)).toBe(true);
    });

    it('aetherAPI.window is frozen', () => {
      expect(Object.isFrozen(aetherAPI.window)).toBe(true);
    });

    it('aetherAPI.chat is frozen', () => {
      expect(Object.isFrozen(aetherAPI.chat)).toBe(true);
    });

    it('aetherAPI.memories is frozen', () => {
      expect(Object.isFrozen(aetherAPI.memories)).toBe(true);
    });

    it('aetherAPI.chatSummaries is frozen', () => {
      expect(Object.isFrozen(aetherAPI.chatSummaries)).toBe(true);
    });

    it('aetherAPI.artifacts is frozen', () => {
      expect(Object.isFrozen(aetherAPI.artifacts)).toBe(true);
    });

    it('aetherAPI.log is frozen', () => {
      expect(Object.isFrozen(aetherAPI.log)).toBe(true);
    });

    it('aetherAPI.system is frozen', () => {
      expect(Object.isFrozen(aetherAPI.system)).toBe(true);
    });

    it('aetherAPI.versions is frozen', () => {
      expect(Object.isFrozen(aetherAPI.versions)).toBe(true);
    });

    it('aetherAPI.session is frozen', () => {
      expect(Object.isFrozen(aetherAPI.session)).toBe(true);
    });

    it('aetherAPI.dialog is frozen', () => {
      expect(Object.isFrozen(aetherAPI.dialog)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.config
  // --------------------------------------------------------------------------

  describe('aetherAPI.config', () => {
    it('getSnapshot returns config object on success', () => {
      rendererConfig.getConfigSnapshot.mockReturnValue({ apiUrl: 'http://test:9000' });
      const result = aetherAPI.config.getSnapshot();
      expect(result).toEqual({ apiUrl: 'http://test:9000' });
      expect(rendererConfig.getConfigSnapshot).toHaveBeenCalledTimes(1);
    });

    it('getSnapshot returns null when getConfigSnapshot throws', () => {
      rendererConfig.getConfigSnapshot.mockImplementation(() => {
        throw new Error('config not ready');
      });
      const result = aetherAPI.config.getSnapshot();
      expect(result).toBeNull();
    });

    it('getSnapshot swallows the error silently (no re-throw)', () => {
      rendererConfig.getConfigSnapshot.mockImplementation(() => {
        throw new Error('boot error');
      });
      expect(() => aetherAPI.config.getSnapshot()).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.ipc — thin delegates to bridge methods via .bind()
  // --------------------------------------------------------------------------

  describe('aetherAPI.ipc', () => {
    it('send delegates to ipcBridge.send', () => {
      aetherAPI.ipc.send('test:channel', { data: 123 });
      expect(mockBridge.send).toHaveBeenCalledWith('test:channel', { data: 123 });
    });

    it('on delegates to ipcBridge.on', () => {
      const callback = jest.fn();
      aetherAPI.ipc.on('test:event', callback);
      expect(mockBridge.on).toHaveBeenCalledWith('test:event', callback);
    });

    it('once delegates to ipcBridge.once', () => {
      const callback = jest.fn();
      aetherAPI.ipc.once('test:event', callback);
      expect(mockBridge.once).toHaveBeenCalledWith('test:event', callback);
    });

    it('invoke delegates to ipcBridge.invoke', () => {
      aetherAPI.ipc.invoke('test:query', { key: 'val' });
      expect(mockBridge.invoke).toHaveBeenCalledWith('test:query', { key: 'val' });
    });

    it('removeListener delegates to ipcBridge.removeListener', () => {
      const fn = jest.fn();
      aetherAPI.ipc.removeListener('test:event', fn);
      expect(mockBridge.removeListener).toHaveBeenCalledWith('test:event', fn);
    });

    it('removeAllListeners delegates to ipcBridge.removeAllListeners', () => {
      aetherAPI.ipc.removeAllListeners('test:event');
      expect(mockBridge.removeAllListeners).toHaveBeenCalledWith('test:event');
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.window
  // --------------------------------------------------------------------------

  describe('aetherAPI.window', () => {
    it('toggleWidgetMode sends toggle-widget-mode with empty payload', () => {
      aetherAPI.window.toggleWidgetMode();
      expect(mockBridge.send).toHaveBeenCalledWith('toggle-widget-mode', {});
    });

    it('onDoubleClick sends window-double-clicked with empty payload', () => {
      aetherAPI.window.onDoubleClick();
      expect(mockBridge.send).toHaveBeenCalledWith('window-double-clicked', {});
    });

    it('zoomIn sends zoom-in with empty payload', () => {
      aetherAPI.window.zoomIn();
      expect(mockBridge.send).toHaveBeenCalledWith('zoom-in', {});
    });

    it('zoomOut sends zoom-out with empty payload', () => {
      aetherAPI.window.zoomOut();
      expect(mockBridge.send).toHaveBeenCalledWith('zoom-out', {});
    });

    it('onWheel sends deltaY and ctrlKey', () => {
      aetherAPI.window.onWheel(-120, true);
      expect(mockBridge.send).toHaveBeenCalledWith('wheel-event', { deltaY: -120, ctrlKey: true });
    });

    it('onWheel defaults ctrlKey to false', () => {
      aetherAPI.window.onWheel(50);
      expect(mockBridge.send).toHaveBeenCalledWith('wheel-event', { deltaY: 50, ctrlKey: false });
    });

    describe('onWidgetModeChange', () => {
      it('registers two listeners: enter-widget-mode and exit-widget-mode', () => {
        aetherAPI.window.onWidgetModeChange(jest.fn());
        expect(mockBridge.on).toHaveBeenCalledTimes(2);
        expect(mockBridge.on.mock.calls[0][0]).toBe('enter-widget-mode');
        expect(mockBridge.on.mock.calls[1][0]).toBe('exit-widget-mode');
      });

      it('enter-widget-mode wrapper calls callback with true', () => {
        const callback = jest.fn();
        aetherAPI.window.onWidgetModeChange(callback);
        const enterHandler = mockBridge.on.mock.calls[0][1];
        enterHandler();
        expect(callback).toHaveBeenCalledWith(true);
      });

      it('exit-widget-mode wrapper calls callback with false', () => {
        const callback = jest.fn();
        aetherAPI.window.onWidgetModeChange(callback);
        const exitHandler = mockBridge.on.mock.calls[1][1];
        exitHandler();
        expect(callback).toHaveBeenCalledWith(false);
      });

      it('returns cleanup function that invokes both inner cleanup functions', () => {
        const enterCleanup = jest.fn();
        const exitCleanup = jest.fn();
        mockBridge.on
          .mockReturnValueOnce(enterCleanup)
          .mockReturnValueOnce(exitCleanup);

        const cleanup = aetherAPI.window.onWidgetModeChange(jest.fn());
        expect(typeof cleanup).toBe('function');

        cleanup();
        expect(enterCleanup).toHaveBeenCalledTimes(1);
        expect(exitCleanup).toHaveBeenCalledTimes(1);
      });
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.chat
  // --------------------------------------------------------------------------

  describe('aetherAPI.chat', () => {
    it('send sends message with spread metadata', () => {
      aetherAPI.chat.send('hello world', { source: 'keyboard' });
      expect(mockBridge.send).toHaveBeenCalledWith('chat:send', {
        message: 'hello world',
        source: 'keyboard',
      });
    });

    it('send defaults metadata to empty object', () => {
      aetherAPI.chat.send('hello');
      expect(mockBridge.send).toHaveBeenCalledWith('chat:send', { message: 'hello' });
    });

    it('streamUserInput sends STT stream data on chat:stt-stream', () => {
      const data = { text: 'testing', isFinal: false, source: 'stt' };
      aetherAPI.chat.streamUserInput(data);
      expect(mockBridge.send).toHaveBeenCalledWith('chat:stt-stream', data);
    });

    it('sendMessage transforms data into chat:send with nested metadata', () => {
      aetherAPI.chat.sendMessage({ text: 'voice message', source: 'stt' });
      expect(mockBridge.send).toHaveBeenCalledWith('chat:send', {
        message: 'voice message',
        metadata: { source: 'stt' },
      });
    });

    it('onAssistantStream registers listener on chat:assistant-stream', () => {
      const cleanup = jest.fn();
      mockBridge.on.mockReturnValue(cleanup);
      const callback = jest.fn();
      const result = aetherAPI.chat.onAssistantStream(callback);
      expect(mockBridge.on).toHaveBeenCalledWith('chat:assistant-stream', callback);
      expect(result).toBe(cleanup);
    });

    it('onRequestComplete registers listener on chat:request-complete', () => {
      const cleanup = jest.fn();
      mockBridge.on.mockReturnValue(cleanup);
      const callback = jest.fn();
      const result = aetherAPI.chat.onRequestComplete(callback);
      expect(mockBridge.on).toHaveBeenCalledWith('chat:request-complete', callback);
      expect(result).toBe(cleanup);
    });

    it('stop sends chat:stop with requestId payload when requestId provided', () => {
      aetherAPI.chat.stop('req-abc-123');
      expect(mockBridge.send).toHaveBeenCalledWith('chat:stop', { requestId: 'req-abc-123' });
    });

    it('stop sends chat:stop with empty payload when requestId is null', () => {
      aetherAPI.chat.stop(null);
      expect(mockBridge.send).toHaveBeenCalledWith('chat:stop', {});
    });

    it('stop sends chat:stop with empty payload when called without args', () => {
      aetherAPI.chat.stop();
      expect(mockBridge.send).toHaveBeenCalledWith('chat:stop', {});
    });

    it('open sends chat:window-control toggle-visibility', () => {
      aetherAPI.chat.open();
      expect(mockBridge.send).toHaveBeenCalledWith('chat:window-control', 'toggle-visibility');
    });

    it('controlWindow sends chat:window-control with action string', () => {
      aetherAPI.chat.controlWindow('minimize');
      expect(mockBridge.send).toHaveBeenCalledWith('chat:window-control', 'minimize');
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.memories
  // --------------------------------------------------------------------------

  describe('aetherAPI.memories', () => {
    it('create invokes memories:create with data wrapper', async () => {
      const data = { content: 'test memory', memory_type: 'note', importance_score: 0.8 };
      await aetherAPI.memories.create(data);
      expect(mockBridge.invoke).toHaveBeenCalledWith('memories:create', { data });
    });

    it('list invokes memories:list with filters wrapper', async () => {
      const filters = { memory_type: 'note', limit: 10, offset: 0 };
      await aetherAPI.memories.list(filters);
      expect(mockBridge.invoke).toHaveBeenCalledWith('memories:list', { filters });
    });

    it('list defaults filters to empty object', async () => {
      await aetherAPI.memories.list();
      expect(mockBridge.invoke).toHaveBeenCalledWith('memories:list', { filters: {} });
    });

    it('get invokes memories:get with memoryId', async () => {
      await aetherAPI.memories.get('mem-123');
      expect(mockBridge.invoke).toHaveBeenCalledWith('memories:get', { memoryId: 'mem-123' });
    });

    it('update invokes memories:update with memoryId and updates', async () => {
      await aetherAPI.memories.update('mem-123', { content: 'updated content' });
      expect(mockBridge.invoke).toHaveBeenCalledWith('memories:update', {
        memoryId: 'mem-123',
        updates: { content: 'updated content' },
      });
    });

    it('delete invokes memories:delete with memoryId', async () => {
      await aetherAPI.memories.delete('mem-123');
      expect(mockBridge.invoke).toHaveBeenCalledWith('memories:delete', { memoryId: 'mem-123' });
    });

    it('search invokes memories:search with query and options', async () => {
      await aetherAPI.memories.search('find this', { searchType: 'hybrid', limit: 5 });
      expect(mockBridge.invoke).toHaveBeenCalledWith('memories:search', {
        query: 'find this',
        options: { searchType: 'hybrid', limit: 5 },
      });
    });

    it('search defaults options to empty object', async () => {
      await aetherAPI.memories.search('query');
      expect(mockBridge.invoke).toHaveBeenCalledWith('memories:search', {
        query: 'query',
        options: {},
      });
    });

    it('getRelations invokes memories:get-relations', async () => {
      await aetherAPI.memories.getRelations('mem-123');
      expect(mockBridge.invoke).toHaveBeenCalledWith('memories:get-relations', { memoryId: 'mem-123' });
    });

    it('createRelation invokes memories:create-relation with all params', async () => {
      await aetherAPI.memories.createRelation('mem-1', 'mem-2', { relationType: 'related', strength: 0.8 });
      expect(mockBridge.invoke).toHaveBeenCalledWith('memories:create-relation', {
        memoryId: 'mem-1',
        relatedMemoryId: 'mem-2',
        data: { relationType: 'related', strength: 0.8 },
      });
    });

    it('createRelation defaults data to empty object', async () => {
      await aetherAPI.memories.createRelation('mem-1', 'mem-2');
      expect(mockBridge.invoke).toHaveBeenCalledWith('memories:create-relation', {
        memoryId: 'mem-1',
        relatedMemoryId: 'mem-2',
        data: {},
      });
    });

    it('deleteRelation invokes memories:delete-relation', async () => {
      await aetherAPI.memories.deleteRelation('rel-456');
      expect(mockBridge.invoke).toHaveBeenCalledWith('memories:delete-relation', { relationId: 'rel-456' });
    });

    it('promote invokes memories:promote', async () => {
      await aetherAPI.memories.promote('mem-123');
      expect(mockBridge.invoke).toHaveBeenCalledWith('memories:promote', { memoryId: 'mem-123' });
    });

    it('demote invokes memories:demote with memoryId and chatId', async () => {
      await aetherAPI.memories.demote('mem-123', 'chat-abc');
      expect(mockBridge.invoke).toHaveBeenCalledWith('memories:demote', {
        memoryId: 'mem-123',
        chatId: 'chat-abc',
      });
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.chatSummaries
  // --------------------------------------------------------------------------

  describe('aetherAPI.chatSummaries', () => {
    it('generate invokes storage:summarize-chat with summaryType', async () => {
      await aetherAPI.chatSummaries.generate('chat-abc', 'technical');
      expect(mockBridge.invoke).toHaveBeenCalledWith('storage:summarize-chat', {
        chatId: 'chat-abc',
        summaryType: 'technical',
      });
    });

    it('generate defaults summaryType to "full"', async () => {
      await aetherAPI.chatSummaries.generate('chat-abc');
      expect(mockBridge.invoke).toHaveBeenCalledWith('storage:summarize-chat', {
        chatId: 'chat-abc',
        summaryType: 'full',
      });
    });

    it('get invokes storage:get-chat-summaries with chatId', async () => {
      await aetherAPI.chatSummaries.get('chat-abc');
      expect(mockBridge.invoke).toHaveBeenCalledWith('storage:get-chat-summaries', { chatId: 'chat-abc' });
    });

    it('search invokes storage:search-chats with query and options', async () => {
      await aetherAPI.chatSummaries.search('keyword', { limit: 10, minScore: 0.5 });
      expect(mockBridge.invoke).toHaveBeenCalledWith('storage:search-chats', {
        query: 'keyword',
        options: { limit: 10, minScore: 0.5 },
      });
    });

    it('search defaults options to empty object', async () => {
      await aetherAPI.chatSummaries.search('keyword');
      expect(mockBridge.invoke).toHaveBeenCalledWith('storage:search-chats', {
        query: 'keyword',
        options: {},
      });
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.artifacts
  // --------------------------------------------------------------------------

  describe('aetherAPI.artifacts', () => {
    it('stream sends artifacts:stream with data', () => {
      const data = { type: 'code', content: 'console.log("hello")' };
      aetherAPI.artifacts.stream(data);
      expect(mockBridge.send).toHaveBeenCalledWith('artifacts:stream', data);
    });

    it('open sends artifacts:window-control toggle-visibility', () => {
      aetherAPI.artifacts.open();
      expect(mockBridge.send).toHaveBeenCalledWith('artifacts:window-control', 'toggle-visibility');
    });

    it('controlWindow sends artifacts:window-control with action', () => {
      aetherAPI.artifacts.controlWindow('maximize');
      expect(mockBridge.send).toHaveBeenCalledWith('artifacts:window-control', 'maximize');
    });

    it('exportFile sends content, name, and extension', () => {
      aetherAPI.artifacts.exportFile('const x = 1;', 'script', 'js');
      expect(mockBridge.send).toHaveBeenCalledWith('artifacts:file-export', {
        content: 'const x = 1;',
        name: 'script',
        extension: 'js',
      });
    });

    it('openFile sends file path', () => {
      aetherAPI.artifacts.openFile('/tmp/output.txt');
      expect(mockBridge.send).toHaveBeenCalledWith('artifacts:open-file', { path: '/tmp/output.txt' });
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.log — type and length validation
  // --------------------------------------------------------------------------

  describe('aetherAPI.log', () => {
    it('send dispatches valid string message', () => {
      aetherAPI.log.send('test log message');
      expect(mockBridge.send).toHaveBeenCalledWith('renderer-log', 'test log message');
    });

    it('send dispatches empty string', () => {
      aetherAPI.log.send('');
      expect(mockBridge.send).toHaveBeenCalledWith('renderer-log', '');
    });

    it('send dispatches string of exactly 10000 characters (boundary)', () => {
      const msg = 'x'.repeat(10000);
      aetherAPI.log.send(msg);
      expect(mockBridge.send).toHaveBeenCalledWith('renderer-log', msg);
    });

    it('send rejects string of 10001 characters (over boundary)', () => {
      aetherAPI.log.send('x'.repeat(10001));
      expect(mockBridge.send).not.toHaveBeenCalled();
    });

    it('send rejects non-string: number', () => {
      aetherAPI.log.send(42);
      expect(mockBridge.send).not.toHaveBeenCalled();
    });

    it('send rejects non-string: null', () => {
      aetherAPI.log.send(null);
      expect(mockBridge.send).not.toHaveBeenCalled();
    });

    it('send rejects non-string: undefined', () => {
      aetherAPI.log.send(undefined);
      expect(mockBridge.send).not.toHaveBeenCalled();
    });

    it('send rejects non-string: object', () => {
      aetherAPI.log.send({ msg: 'test' });
      expect(mockBridge.send).not.toHaveBeenCalled();
    });

    it('send rejects non-string: array', () => {
      aetherAPI.log.send(['test']);
      expect(mockBridge.send).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.system
  // --------------------------------------------------------------------------

  describe('aetherAPI.system', () => {
    it('getStats invokes system:get-stats and returns result', async () => {
      mockBridge.invoke.mockResolvedValue({ cpu: 45, memory: 60 });
      const result = await aetherAPI.system.getStats();
      expect(mockBridge.invoke).toHaveBeenCalledWith('system:get-stats');
      expect(result).toEqual({ cpu: 45, memory: 60 });
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.versions
  // --------------------------------------------------------------------------

  describe('aetherAPI.versions', () => {
    it('node version matches process.versions.node', () => {
      expect(aetherAPI.versions.node).toBe(process.versions.node);
    });

    it('has chrome and electron properties', () => {
      expect(aetherAPI.versions).toHaveProperty('chrome');
      expect(aetherAPI.versions).toHaveProperty('electron');
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.session — invokeSession wrapper + .id extraction
  // --------------------------------------------------------------------------

  describe('aetherAPI.session', () => {
    it('setActiveChat invokes session:set-active and returns full response', async () => {
      mockBridge.invoke.mockResolvedValue({ ok: true, chatId: 'chat-001' });
      const result = await aetherAPI.session.setActiveChat('chat-001');
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:set-active', { chatId: 'chat-001' });
      expect(result).toEqual({ ok: true, chatId: 'chat-001' });
    });

    it('nextUserMessageId extracts response.id', async () => {
      mockBridge.invoke.mockResolvedValue({ id: 'UM-001' });
      const id = await aetherAPI.session.nextUserMessageId({ chatId: 'chat-001' });
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'user_message',
        chatId: 'chat-001',
      });
      expect(id).toBe('UM-001');
    });

    it('nextUserMessageId defaults chatId to undefined when no options', async () => {
      mockBridge.invoke.mockResolvedValue({ id: 'UM-002' });
      const id = await aetherAPI.session.nextUserMessageId();
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'user_message',
        chatId: undefined,
      });
      expect(id).toBe('UM-002');
    });

    it('nextAssistantMessageId passes parentId and chatId', async () => {
      mockBridge.invoke.mockResolvedValue({ id: 'AM-001' });
      const id = await aetherAPI.session.nextAssistantMessageId({
        parentId: 'UM-001',
        chatId: 'chat-001',
      });
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'assistant_message',
        parentId: 'UM-001',
        chatId: 'chat-001',
      });
      expect(id).toBe('AM-001');
    });

    it('nextAssistantMessageId defaults options to empty', async () => {
      mockBridge.invoke.mockResolvedValue({ id: 'AM-002' });
      const id = await aetherAPI.session.nextAssistantMessageId();
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'assistant_message',
        parentId: undefined,
        chatId: undefined,
      });
      expect(id).toBe('AM-002');
    });

    it('nextCodeArtifactId invokes with kind assistant_code', async () => {
      mockBridge.invoke.mockResolvedValue({ id: 'AC-001' });
      const id = await aetherAPI.session.nextCodeArtifactId({ parentId: 'AM-001' });
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'assistant_code',
        parentId: 'AM-001',
        chatId: undefined,
      });
      expect(id).toBe('AC-001');
    });

    it('nextCodeArtifactId defaults options to empty', async () => {
      mockBridge.invoke.mockResolvedValue({ id: 'AC-002' });
      const id = await aetherAPI.session.nextCodeArtifactId();
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'assistant_code',
        parentId: undefined,
        chatId: undefined,
      });
      expect(id).toBe('AC-002');
    });

    it('nextOutputArtifactId invokes with kind assistant_output', async () => {
      mockBridge.invoke.mockResolvedValue({ id: 'AO-001' });
      const id = await aetherAPI.session.nextOutputArtifactId({
        parentId: 'AM-001',
        chatId: 'chat-001',
      });
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'assistant_output',
        parentId: 'AM-001',
        chatId: 'chat-001',
      });
      expect(id).toBe('AO-001');
    });

    it('nextOutputArtifactId defaults options to empty', async () => {
      mockBridge.invoke.mockResolvedValue({ id: 'AO-002' });
      const id = await aetherAPI.session.nextOutputArtifactId();
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'assistant_output',
        parentId: undefined,
        chatId: undefined,
      });
      expect(id).toBe('AO-002');
    });

    it('nextHtmlArtifactId invokes with kind assistant_html', async () => {
      mockBridge.invoke.mockResolvedValue({ id: 'AH-001' });
      const id = await aetherAPI.session.nextHtmlArtifactId({ parentId: 'AM-001' });
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'assistant_html',
        parentId: 'AM-001',
        chatId: undefined,
      });
      expect(id).toBe('AH-001');
    });

    it('nextHtmlArtifactId defaults options to empty', async () => {
      mockBridge.invoke.mockResolvedValue({ id: 'AH-002' });
      const id = await aetherAPI.session.nextHtmlArtifactId();
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'assistant_html',
        parentId: undefined,
        chatId: undefined,
      });
      expect(id).toBe('AH-002');
    });

    it('nextAttachmentId invokes with kind user_attachment', async () => {
      mockBridge.invoke.mockResolvedValue({ id: 'UA-001' });
      const id = await aetherAPI.session.nextAttachmentId({
        parentId: 'UM-001',
        chatId: 'chat-001',
      });
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'user_attachment',
        parentId: 'UM-001',
        chatId: 'chat-001',
      });
      expect(id).toBe('UA-001');
    });

    it('nextAttachmentId defaults options to empty', async () => {
      mockBridge.invoke.mockResolvedValue({ id: 'UA-002' });
      const id = await aetherAPI.session.nextAttachmentId();
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'user_attachment',
        parentId: undefined,
        chatId: undefined,
      });
      expect(id).toBe('UA-002');
    });

    it('parseId invokes session:parse-id and returns full response', async () => {
      mockBridge.invoke.mockResolvedValue({ kind: 'user_message', sequence: 1, chatId: 'abc' });
      const result = await aetherAPI.session.parseId('UM-001');
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:parse-id', { id: 'UM-001' });
      expect(result).toEqual({ kind: 'user_message', sequence: 1, chatId: 'abc' });
    });

    it('getStats invokes session:get-stats with default empty payload', async () => {
      mockBridge.invoke.mockResolvedValue({ activeSessions: 2, totalIds: 15 });
      const result = await aetherAPI.session.getStats();
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:get-stats', {});
      expect(result).toEqual({ activeSessions: 2, totalIds: 15 });
    });

    it('clearChatSession invokes session:clear with chatId', async () => {
      mockBridge.invoke.mockResolvedValue({ cleared: true });
      const result = await aetherAPI.session.clearChatSession('chat-001');
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:clear', { chatId: 'chat-001' });
      expect(result).toEqual({ cleared: true });
    });

    it('clearAll invokes session:clear-all with default empty payload', async () => {
      mockBridge.invoke.mockResolvedValue({ cleared: true, count: 5 });
      const result = await aetherAPI.session.clearAll();
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:clear-all', {});
      expect(result).toEqual({ cleared: true, count: 5 });
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.dialog — try/catch error handling
  // --------------------------------------------------------------------------

  describe('aetherAPI.dialog', () => {
    it('showDirectoryPicker returns selected path on success', async () => {
      mockBridge.invoke.mockResolvedValue('/Users/test/Documents');
      const result = await aetherAPI.dialog.showDirectoryPicker();
      expect(mockBridge.invoke).toHaveBeenCalledWith('dialog:show-directory-picker', {});
      expect(result).toBe('/Users/test/Documents');
    });

    it('showDirectoryPicker returns null and logs error on failure', async () => {
      mockBridge.invoke.mockRejectedValue(new Error('dialog canceled'));
      const result = await aetherAPI.dialog.showDirectoryPicker();
      expect(result).toBeNull();
      expect(mockLog.error).toHaveBeenCalledWith('directory picker failed', { error: 'dialog canceled' });
    });

    it('showFilePicker returns selected files on success', async () => {
      mockBridge.invoke.mockResolvedValue(['/tmp/file.txt', '/tmp/other.txt']);
      const result = await aetherAPI.dialog.showFilePicker({
        filters: [{ name: 'Text', extensions: ['txt'] }],
      });
      expect(mockBridge.invoke).toHaveBeenCalledWith('dialog:show-file-picker', {
        filters: [{ name: 'Text', extensions: ['txt'] }],
      });
      expect(result).toEqual(['/tmp/file.txt', '/tmp/other.txt']);
    });

    it('showFilePicker defaults options to empty object', async () => {
      mockBridge.invoke.mockResolvedValue([]);
      await aetherAPI.dialog.showFilePicker();
      expect(mockBridge.invoke).toHaveBeenCalledWith('dialog:show-file-picker', {});
    });

    it('showFilePicker returns null and logs error on failure', async () => {
      mockBridge.invoke.mockRejectedValue(new Error('file picker error'));
      const result = await aetherAPI.dialog.showFilePicker();
      expect(result).toBeNull();
      expect(mockLog.error).toHaveBeenCalledWith('file picker failed', { error: 'file picker error' });
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.getMetadata / aetherAPI.getStats — bridge method delegates
  // --------------------------------------------------------------------------

  describe('aetherAPI.getMetadata', () => {
    it('delegates to ipcBridge.getMetadata and returns result', () => {
      const result = aetherAPI.getMetadata();
      expect(mockBridge.getMetadata).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ context: 'mainWindow' });
    });
  });

  describe('aetherAPI.getStats', () => {
    it('delegates to ipcBridge.getStats and returns result', () => {
      const result = aetherAPI.getStats();
      expect(mockBridge.getStats).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ rateLimiter: {}, sizeValidator: {} });
    });
  });

  // --------------------------------------------------------------------------
  // Error during contextBridge.exposeInMainWorld
  // --------------------------------------------------------------------------

  describe('error during exposeInMainWorld', () => {
    afterEach(() => {
      // Restore to prevent leaking throwing implementation to other suites
      contextBridge.exposeInMainWorld.mockReset();
    });

    it('logs error and re-throws when exposeInMainWorld fails', () => {
      jest.isolateModules(() => {
        const { contextBridge: ctxBridge } = require('electron');
        const { createBridge: cbMock } = require('../../../src/preload/common/bridge-factory');
        const { createLogger: clMock } = require('../../../src/core/utils/logger');
        const rcMock = require('../../../src/core/config/renderer-config');

        const errorLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
        clMock.mockReturnValue(errorLog);
        rcMock.getConfigSnapshot.mockReturnValue({});
        cbMock.mockReturnValue({
          send: jest.fn(),
          on: jest.fn(() => jest.fn()),
          once: jest.fn(),
          invoke: jest.fn(),
          removeListener: jest.fn(),
          removeAllListeners: jest.fn(),
          getMetadata: jest.fn(),
          getStats: jest.fn(),
        });

        ctxBridge.exposeInMainWorld.mockImplementation(() => {
          throw new Error('context bridge test failure');
        });

        expect(() => require('../../../src/preload/main-preload')).toThrow('context bridge test failure');
        expect(errorLog.error).toHaveBeenCalledWith('failed to expose API', {
          error: 'context bridge test failure',
        });
      });
    });
  });
});
