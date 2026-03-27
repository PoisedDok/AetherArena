'use strict';

// ============================================================================
// Mock objects — prefixed with "mock" for jest.mock hoisting compatibility.
// These are created ONCE and captured by closures in the API object during
// the single module-level require() of artifacts-preload.js.
// ============================================================================

const mockBridge = {
  send: jest.fn(),
  on: jest.fn(() => jest.fn()),
  once: jest.fn(),
  invoke: jest.fn().mockResolvedValue({ id: 'mock-id-123' }),
  removeListener: jest.fn(),
  removeAllListeners: jest.fn(),
  getMetadata: jest.fn().mockReturnValue({ context: 'artifactsWindow' }),
  getStats: jest.fn().mockReturnValue({ rateLimiter: {}, sizeValidator: {} }),
};

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const mockHljs = {
  registerLanguage: jest.fn(),
  configure: jest.fn(),
};

const mockMarked = {
  setOptions: jest.fn(),
};

const mockDOMPurify = {
  sanitize: jest.fn((html) => html),
  version: '3.0.0',
};

// All 21 unique hljs language module names used by artifacts-preload.
// 22 registerLanguage calls total because 'html' reuses the 'xml' module.
const HLJS_LANG_MODULES = [
  'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'csharp',
  'go', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'bash', 'shell',
  'sql', 'json', 'yaml', 'xml', 'css', 'markdown',
];

// ============================================================================
// Module mocks — jest.mock is hoisted before any require().
// artifacts-preload.js runs ALL side effects on require: createLogger,
// injectCspMeta, load hljs(21 langs)/marked/DOMPurify, createBridge,
// storageAPI, Object.freeze(aetherAPI), contextBridge.exposeInMainWorld (×5).
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

// Library mocks — happy-path factories for the main test suite.
// Error-path testing uses resetModules + doMock in the library failure describe block.
jest.mock('highlight.js/lib/core', () => mockHljs);
jest.mock('highlight.js/lib/languages/javascript', () => jest.fn());
jest.mock('highlight.js/lib/languages/typescript', () => jest.fn());
jest.mock('highlight.js/lib/languages/python', () => jest.fn());
jest.mock('highlight.js/lib/languages/java', () => jest.fn());
jest.mock('highlight.js/lib/languages/c', () => jest.fn());
jest.mock('highlight.js/lib/languages/cpp', () => jest.fn());
jest.mock('highlight.js/lib/languages/csharp', () => jest.fn());
jest.mock('highlight.js/lib/languages/go', () => jest.fn());
jest.mock('highlight.js/lib/languages/rust', () => jest.fn());
jest.mock('highlight.js/lib/languages/ruby', () => jest.fn());
jest.mock('highlight.js/lib/languages/php', () => jest.fn());
jest.mock('highlight.js/lib/languages/swift', () => jest.fn());
jest.mock('highlight.js/lib/languages/kotlin', () => jest.fn());
jest.mock('highlight.js/lib/languages/bash', () => jest.fn());
jest.mock('highlight.js/lib/languages/shell', () => jest.fn());
jest.mock('highlight.js/lib/languages/sql', () => jest.fn());
jest.mock('highlight.js/lib/languages/json', () => jest.fn());
jest.mock('highlight.js/lib/languages/yaml', () => jest.fn());
jest.mock('highlight.js/lib/languages/xml', () => jest.fn());
jest.mock('highlight.js/lib/languages/css', () => jest.fn());
jest.mock('highlight.js/lib/languages/markdown', () => jest.fn());
jest.mock('marked', () => mockMarked);
jest.mock('dompurify', () => mockDOMPurify);

// ============================================================================
// References to mocked modules (for per-test assertion and re-configuration)
// ============================================================================

const { contextBridge } = require('electron');
const { createBridge } = require('../../../src/preload/common/bridge-factory');
const { createLogger } = require('../../../src/core/utils/logger');
const rendererConfig = require('../../../src/core/config/renderer-config');
const { injectCspMeta } = require('../../../src/preload/common/csp-injector');

// ============================================================================
// Load artifacts-preload — triggers all module-level initialization exactly once.
// After this line, aetherAPI exists and is frozen.
// ============================================================================

require('../../../src/preload/artifacts-preload');

// Save initialization call data before any beforeEach clears mock history.
const initCalls = {
  createLogger: createLogger.mock.calls.slice(),
  createBridge: createBridge.mock.calls.slice(),
  injectCspMeta: injectCspMeta.mock.calls.slice(),
  exposeInMainWorld: contextBridge.exposeInMainWorld.mock.calls.slice(),
  logInfo: mockLog.info.mock.calls.slice(),
  hljsRegisterLanguage: mockHljs.registerLanguage.mock.calls.slice(),
  hljsConfigure: mockHljs.configure.mock.calls.slice(),
  markedSetOptions: mockMarked.setOptions.mock.calls.slice(),
};

const aetherAPI = initCalls.exposeInMainWorld[0][1];

// ============================================================================
// Test Suite
// ============================================================================

describe('artifacts-preload', () => {
  beforeEach(() => {
    // Projects do not inherit top-level clearMocks/resetMocks from jest.config.js.
    jest.clearAllMocks();
    // Re-establish implementations that API methods depend on at call time.
    mockBridge.invoke.mockResolvedValue({ id: 'mock-id-123' });
    mockBridge.on.mockReturnValue(jest.fn());
    mockBridge.getMetadata.mockReturnValue({ context: 'artifactsWindow' });
    mockBridge.getStats.mockReturnValue({ rateLimiter: {}, sizeValidator: {} });
    mockDOMPurify.sanitize.mockImplementation((html) => html);
  });

  // --------------------------------------------------------------------------
  // Module initialization
  // --------------------------------------------------------------------------

  describe('module initialization', () => {
    it('creates logger with component ArtifactsPreload', () => {
      expect(initCalls.createLogger).toHaveLength(1);
      expect(initCalls.createLogger[0][0]).toEqual({ component: 'ArtifactsPreload' });
    });

    it('injects CSP meta with rendererConfig', () => {
      expect(initCalls.injectCspMeta).toHaveLength(1);
      const arg = initCalls.injectCspMeta[0][0];
      expect(arg).toHaveProperty('getConfigSnapshot');
      expect(typeof arg.getConfigSnapshot).toBe('function');
    });

    it('creates bridge with artifactsWindow context', () => {
      expect(initCalls.createBridge).toHaveLength(1);
      expect(initCalls.createBridge[0][0]).toMatchObject({
        context: 'artifactsWindow',
      });
    });

    it('enables rate limiting, size validation, and payload validation', () => {
      const cfg = initCalls.createBridge[0][0];
      expect(cfg.enableRateLimiting).toBe(true);
      expect(cfg.enableSizeValidation).toBe(true);
      expect(cfg.enablePayloadValidation).toBe(true);
    });

    it('passes ipcRenderer to bridge', () => {
      const cfg = initCalls.createBridge[0][0];
      expect(cfg).toHaveProperty('ipcRenderer');
    });

    it('bridge onError callback logs with context', () => {
      const onError = initCalls.createBridge[0][0].onError;
      expect(typeof onError).toBe('function');
      onError(new Error('test IPC failure'), { channel: 'test' });
      expect(mockLog.error).toHaveBeenCalledWith('IPC error', {
        error: 'test IPC failure',
        details: { channel: 'test' },
      });
    });
  });

  // --------------------------------------------------------------------------
  // Library loading — highlight.js
  // --------------------------------------------------------------------------

  describe('library loading — highlight.js', () => {
    it('registers 22 language aliases (21 unique modules, html reuses xml)', () => {
      expect(initCalls.hljsRegisterLanguage).toHaveLength(22);
    });

    it('registers all expected language names in order', () => {
      const registeredNames = initCalls.hljsRegisterLanguage.map(call => call[0]);
      const expected = [
        'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'csharp',
        'go', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'bash', 'shell',
        'sql', 'json', 'yaml', 'xml', 'html', 'css', 'markdown',
      ];
      expect(registeredNames).toEqual(expected);
    });

    it('configures hljs with ignoreUnescapedHTML', () => {
      expect(initCalls.hljsConfigure).toHaveLength(1);
      expect(initCalls.hljsConfigure[0][0]).toEqual({ ignoreUnescapedHTML: true });
    });

    it('logs success after loading', () => {
      const hljsLog = initCalls.logInfo.find(c => c[0] === 'highlight.js loaded with 21 languages');
      expect(hljsLog).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Library loading — marked
  // --------------------------------------------------------------------------

  describe('library loading — marked', () => {
    it('configures marked with expected options', () => {
      expect(initCalls.markedSetOptions).toHaveLength(1);
      expect(initCalls.markedSetOptions[0][0]).toEqual({
        breaks: true,
        gfm: true,
        headerIds: false,
        mangle: false,
      });
    });

    it('logs success after loading', () => {
      const markedLog = initCalls.logInfo.find(c => c[0] === 'marked loaded successfully');
      expect(markedLog).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Library loading — sanitizer (DOMPurify)
  // --------------------------------------------------------------------------

  describe('library loading — sanitizer (DOMPurify)', () => {
    it('creates sanitizer with expected API shape', () => {
      expect(aetherAPI.sanitizer).toBeDefined();
      expect(typeof aetherAPI.sanitizer.isAvailable).toBe('function');
      expect(typeof aetherAPI.sanitizer.getInfo).toBe('function');
      expect(typeof aetherAPI.sanitizer.sanitizeHTML).toBe('function');
    });

    it('logs success after loading', () => {
      const sanitizerLog = initCalls.logInfo.find(c => c[0] === 'DOMPurify sanitizer loaded');
      expect(sanitizerLog).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // contextBridge.exposeInMainWorld
  // --------------------------------------------------------------------------

  describe('contextBridge.exposeInMainWorld', () => {
    it('makes exactly 5 exposeInMainWorld calls when all libraries loaded', () => {
      expect(initCalls.exposeInMainWorld).toHaveLength(5);
    });

    it('exposes aether API as first call', () => {
      expect(initCalls.exposeInMainWorld[0][0]).toBe('aether');
      expect(initCalls.exposeInMainWorld[0][1]).toBeDefined();
    });

    it('exposes hljs as second call', () => {
      expect(initCalls.exposeInMainWorld[1][0]).toBe('hljs');
      expect(initCalls.exposeInMainWorld[1][1]).toBe(mockHljs);
    });

    it('exposes marked as third call', () => {
      expect(initCalls.exposeInMainWorld[2][0]).toBe('marked');
      expect(initCalls.exposeInMainWorld[2][1]).toBe(mockMarked);
    });

    it('exposes sanitizer as fourth call', () => {
      expect(initCalls.exposeInMainWorld[3][0]).toBe('sanitizer');
      expect(initCalls.exposeInMainWorld[3][1]).toBeDefined();
      expect(typeof initCalls.exposeInMainWorld[3][1].sanitizeHTML).toBe('function');
    });

    it('exposes storageAPI as fifth call', () => {
      expect(initCalls.exposeInMainWorld[4][0]).toBe('storageAPI');
      expect(initCalls.exposeInMainWorld[4][1]).toBeDefined();
    });

    it('logs success with library availability flags', () => {
      const logCall = initCalls.logInfo.find(c => c[0] === 'artifacts window API exposed');
      expect(logCall).toBeDefined();
      expect(logCall[1]).toEqual({
        hljs: true,
        marked: true,
        sanitizer: true,
        storage: true,
      });
    });
  });

  // --------------------------------------------------------------------------
  // Frozen API objects
  // --------------------------------------------------------------------------

  describe('frozen API objects', () => {
    it('aetherAPI is frozen', () => {
      expect(Object.isFrozen(aetherAPI)).toBe(true);
    });

    it('config is frozen', () => {
      expect(Object.isFrozen(aetherAPI.config)).toBe(true);
    });

    it('ipc is frozen', () => {
      expect(Object.isFrozen(aetherAPI.ipc)).toBe(true);
    });

    it('windowControl is frozen', () => {
      expect(Object.isFrozen(aetherAPI.windowControl)).toBe(true);
    });

    it('artifacts is frozen', () => {
      expect(Object.isFrozen(aetherAPI.artifacts)).toBe(true);
    });

    it('session is frozen', () => {
      expect(Object.isFrozen(aetherAPI.session)).toBe(true);
    });

    it('log is frozen', () => {
      expect(Object.isFrozen(aetherAPI.log)).toBe(true);
    });

    it('versions is frozen', () => {
      expect(Object.isFrozen(aetherAPI.versions)).toBe(true);
    });

    it('jobTracer is frozen', () => {
      expect(Object.isFrozen(aetherAPI.jobTracer)).toBe(true);
    });

    it('sanitizer is frozen', () => {
      expect(Object.isFrozen(aetherAPI.sanitizer)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Static properties
  // --------------------------------------------------------------------------

  describe('static properties', () => {
    it('window identifier is artifacts', () => {
      expect(aetherAPI.window).toBe('artifacts');
    });

    it('versions contains node, chrome, electron', () => {
      expect(aetherAPI.versions).toEqual({
        node: process.versions.node,
        chrome: process.versions.chrome,
        electron: process.versions.electron,
      });
    });

    it('hljs reference matches loaded library mock', () => {
      expect(aetherAPI.hljs).toBe(mockHljs);
    });

    it('marked reference matches loaded library mock', () => {
      expect(aetherAPI.marked).toBe(mockMarked);
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.config
  // --------------------------------------------------------------------------

  describe('aetherAPI.config', () => {
    it('getSnapshot returns config from rendererConfig', () => {
      rendererConfig.getConfigSnapshot.mockReturnValue({ apiUrl: 'http://test:3000' });
      const snapshot = aetherAPI.config.getSnapshot();
      expect(snapshot).toEqual({ apiUrl: 'http://test:3000' });
    });

    it('getSnapshot returns null when rendererConfig throws', () => {
      rendererConfig.getConfigSnapshot.mockImplementation(() => {
        throw new Error('config unavailable');
      });
      const snapshot = aetherAPI.config.getSnapshot();
      expect(snapshot).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.ipc
  // --------------------------------------------------------------------------

  describe('aetherAPI.ipc', () => {
    it('send delegates to bridge', () => {
      aetherAPI.ipc.send('test-channel', { data: 1 });
      expect(mockBridge.send).toHaveBeenCalledWith('test-channel', { data: 1 });
    });

    it('on delegates to bridge and returns cleanup function', () => {
      const cleanup = jest.fn();
      mockBridge.on.mockReturnValue(cleanup);
      const result = aetherAPI.ipc.on('test-event', jest.fn());
      expect(mockBridge.on).toHaveBeenCalledWith('test-event', expect.any(Function));
      expect(result).toBe(cleanup);
    });

    it('once delegates to bridge', () => {
      const cb = jest.fn();
      aetherAPI.ipc.once('once-event', cb);
      expect(mockBridge.once).toHaveBeenCalledWith('once-event', cb);
    });

    it('removeListener delegates to bridge', () => {
      const cb = jest.fn();
      aetherAPI.ipc.removeListener('channel', cb);
      expect(mockBridge.removeListener).toHaveBeenCalledWith('channel', cb);
    });

    it('removeAllListeners delegates to bridge', () => {
      aetherAPI.ipc.removeAllListeners('channel');
      expect(mockBridge.removeAllListeners).toHaveBeenCalledWith('channel');
    });

    it('invoke delegates to bridge and returns result', async () => {
      mockBridge.invoke.mockResolvedValue({ result: 'ok' });
      const result = await aetherAPI.ipc.invoke('invoke-channel', { arg: 1 });
      expect(mockBridge.invoke).toHaveBeenCalledWith('invoke-channel', { arg: 1 });
      expect(result).toEqual({ result: 'ok' });
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.windowControl
  // --------------------------------------------------------------------------

  describe('aetherAPI.windowControl', () => {
    it('control sends artifacts:window-control with action', () => {
      aetherAPI.windowControl.control('minimize');
      expect(mockBridge.send).toHaveBeenCalledWith('artifacts:window-control', 'minimize');
    });

    it('control forwards different action strings', () => {
      const actions = ['minimize', 'maximize', 'close', 'toggle-visibility'];
      actions.forEach((action) => {
        jest.clearAllMocks();
        aetherAPI.windowControl.control(action);
        expect(mockBridge.send).toHaveBeenCalledWith('artifacts:window-control', action);
      });
    });

    it('setState sends artifacts:window-state with boolean flag', () => {
      aetherAPI.windowControl.setState(true);
      expect(mockBridge.send).toHaveBeenCalledWith('artifacts:window-state', true);
    });

    it('setState sends false when window inactive', () => {
      aetherAPI.windowControl.setState(false);
      expect(mockBridge.send).toHaveBeenCalledWith('artifacts:window-state', false);
    });

    it('setMode sends artifacts:mode-changed with mode string', () => {
      aetherAPI.windowControl.setMode('code');
      expect(mockBridge.send).toHaveBeenCalledWith('artifacts:mode-changed', 'code');
    });

    it('setMode forwards all mode types', () => {
      const modes = ['code', 'output', 'files', 'storage', 'legal-news'];
      modes.forEach((mode) => {
        jest.clearAllMocks();
        aetherAPI.windowControl.setMode(mode);
        expect(mockBridge.send).toHaveBeenCalledWith('artifacts:mode-changed', mode);
      });
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.artifacts
  // --------------------------------------------------------------------------

  describe('aetherAPI.artifacts', () => {
    it('exportFile sends artifacts:file-export with content, name, extension', () => {
      aetherAPI.artifacts.exportFile('console.log("hi")', 'script', 'js');
      expect(mockBridge.send).toHaveBeenCalledWith('artifacts:file-export', {
        content: 'console.log("hi")',
        name: 'script',
        extension: 'js',
      });
    });

    it('openFile sends artifacts:open-file with path', () => {
      aetherAPI.artifacts.openFile('/tmp/test.js');
      expect(mockBridge.send).toHaveBeenCalledWith('artifacts:open-file', {
        path: '/tmp/test.js',
      });
    });

    describe('event listeners', () => {
      const listenerTests = [
        ['onEnsureVisible', 'artifacts:ensure-visible'],
        ['onSetMode', 'artifacts:set-mode'],
        ['onStream', 'artifacts:stream'],
        ['onFocus', 'artifacts:focus-artifacts'],
        ['onSwitchTab', 'artifacts:switch-tab'],
        ['onSwitchChat', 'artifacts:switch-chat'],
        ['onLoadCode', 'artifacts:load-code'],
        ['onLoadOutput', 'artifacts:load-output'],
        ['onShowArtifact', 'artifacts:show-artifact'],
      ];

      it.each(listenerTests)('%s registers on %s and returns cleanup', (method, channel) => {
        const cleanup = jest.fn();
        mockBridge.on.mockReturnValue(cleanup);
        const cb = jest.fn();
        const result = aetherAPI.artifacts[method](cb);
        expect(mockBridge.on).toHaveBeenCalledWith(channel, cb);
        expect(result).toBe(cleanup);
      });
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.storage / storageAPI
  // --------------------------------------------------------------------------

  describe('aetherAPI.storage / storageAPI', () => {
    it('storage and storageAPI are the same reference', () => {
      expect(aetherAPI.storage).toBe(aetherAPI.storageAPI);
    });

    it('storage is not null', () => {
      expect(aetherAPI.storage).not.toBeNull();
    });

    describe('chat operations', () => {
      it('loadChats invokes storage:load-chats', async () => {
        await aetherAPI.storage.loadChats();
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:load-chats');
      });

      it('loadChat invokes storage:load-chat with chatId', async () => {
        await aetherAPI.storage.loadChat('chat-1');
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:load-chat', { chatId: 'chat-1' });
      });

      it('createChat invokes storage:create-chat with title', async () => {
        await aetherAPI.storage.createChat('New Chat');
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:create-chat', { title: 'New Chat' });
      });

      it('updateChatTitle invokes storage:update-chat-title', async () => {
        await aetherAPI.storage.updateChatTitle('chat-1', 'Updated Title');
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:update-chat-title', {
          chatId: 'chat-1',
          title: 'Updated Title',
        });
      });

      it('deleteChat invokes storage:delete-chat', async () => {
        await aetherAPI.storage.deleteChat('chat-1');
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:delete-chat', { chatId: 'chat-1' });
      });
    });

    describe('message operations', () => {
      it('loadMessages invokes storage:load-messages', async () => {
        await aetherAPI.storage.loadMessages('chat-1');
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:load-messages', { chatId: 'chat-1' });
      });

      it('saveMessage invokes storage:save-message', async () => {
        const msg = { role: 'user', content: 'Hello' };
        await aetherAPI.storage.saveMessage('chat-1', msg);
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:save-message', {
          chatId: 'chat-1',
          message: msg,
        });
      });
    });

    describe('artifact operations', () => {
      it('loadArtifacts invokes storage:load-artifacts', async () => {
        await aetherAPI.storage.loadArtifacts('chat-1');
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:load-artifacts', { chatId: 'chat-1' });
      });

      it('saveArtifact invokes storage:save-artifact', async () => {
        const artifact = { type: 'code', content: 'console.log(1)' };
        await aetherAPI.storage.saveArtifact('chat-1', artifact);
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:save-artifact', {
          chatId: 'chat-1',
          artifact,
        });
      });

      it('updateArtifactMessageId invokes storage:update-artifact-message-id', async () => {
        await aetherAPI.storage.updateArtifactMessageId('art-1', 'msg-1', 'chat-1');
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:update-artifact-message-id', {
          artifactId: 'art-1',
          messageId: 'msg-1',
          chatId: 'chat-1',
        });
      });

      it('deleteArtifact invokes storage:delete-artifact', async () => {
        await aetherAPI.storage.deleteArtifact('art-1');
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:delete-artifact', { artifactId: 'art-1' });
      });
    });

    describe('traceability operations', () => {
      it('getMessageArtifacts invokes storage:get-message-artifacts', async () => {
        await aetherAPI.storage.getMessageArtifacts('msg-1');
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:get-message-artifacts', { messageId: 'msg-1' });
      });

      it('getArtifactSource invokes storage:get-artifact-source', async () => {
        await aetherAPI.storage.getArtifactSource('art-1');
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:get-artifact-source', { artifactId: 'art-1' });
      });

      it('getLLMMetadata invokes storage:get-llm-metadata', async () => {
        await aetherAPI.storage.getLLMMetadata('msg-1');
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:get-llm-metadata', { messageId: 'msg-1' });
      });

      it('getArtifact is alias for getArtifactSource — both invoke storage:get-artifact-source', async () => {
        await aetherAPI.storage.getArtifact('art-2');
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:get-artifact-source', { artifactId: 'art-2' });
      });
    });

    describe('health / diagnostics', () => {
      it('healthCheck invokes storage:health-check', async () => {
        await aetherAPI.storage.healthCheck();
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:health-check');
      });

      it('testConnection invokes storage:test-connection', async () => {
        await aetherAPI.storage.testConnection();
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:test-connection');
      });

      it('getStats invokes storage:get-stats', async () => {
        await aetherAPI.storage.getStats();
        expect(mockBridge.invoke).toHaveBeenCalledWith('storage:get-stats');
      });
    });

    describe('utility no-ops', () => {
      it('resetCircuitBreaker resolves immediately without IPC call', async () => {
        const result = await aetherAPI.storage.resetCircuitBreaker();
        expect(result).toBeUndefined();
        expect(mockBridge.invoke).not.toHaveBeenCalled();
      });

      it('resetRateLimiter resolves immediately without IPC call', async () => {
        const result = await aetherAPI.storage.resetRateLimiter();
        expect(result).toBeUndefined();
        expect(mockBridge.invoke).not.toHaveBeenCalled();
      });
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.session
  // --------------------------------------------------------------------------

  describe('aetherAPI.session', () => {
    it('setActiveChat invokes session:set-active', async () => {
      await aetherAPI.session.setActiveChat('chat-1');
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:set-active', { chatId: 'chat-1' });
    });

    it('nextUserMessageId invokes session:next-id with kind user_message and returns id', async () => {
      const id = await aetherAPI.session.nextUserMessageId({ chatId: 'chat-1' });
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'user_message',
        chatId: 'chat-1',
      });
      expect(id).toBe('mock-id-123');
    });

    it('nextUserMessageId defaults options to empty object', async () => {
      await aetherAPI.session.nextUserMessageId();
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'user_message',
        chatId: undefined,
      });
    });

    it('nextAssistantMessageId invokes with kind assistant_message, parentId, chatId', async () => {
      const id = await aetherAPI.session.nextAssistantMessageId({
        parentId: 'parent-1',
        chatId: 'chat-1',
      });
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'assistant_message',
        parentId: 'parent-1',
        chatId: 'chat-1',
      });
      expect(id).toBe('mock-id-123');
    });

    it('nextCodeArtifactId invokes with kind assistant_code', async () => {
      const id = await aetherAPI.session.nextCodeArtifactId({
        parentId: 'parent-1',
        chatId: 'chat-1',
      });
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'assistant_code',
        parentId: 'parent-1',
        chatId: 'chat-1',
      });
      expect(id).toBe('mock-id-123');
    });

    it('nextOutputArtifactId invokes with kind assistant_output', async () => {
      const id = await aetherAPI.session.nextOutputArtifactId({
        parentId: 'parent-1',
        chatId: 'chat-1',
      });
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'assistant_output',
        parentId: 'parent-1',
        chatId: 'chat-1',
      });
      expect(id).toBe('mock-id-123');
    });

    it('nextHtmlArtifactId invokes with kind assistant_html', async () => {
      const id = await aetherAPI.session.nextHtmlArtifactId({
        parentId: 'parent-1',
        chatId: 'chat-1',
      });
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'assistant_html',
        parentId: 'parent-1',
        chatId: 'chat-1',
      });
      expect(id).toBe('mock-id-123');
    });

    it('nextAttachmentId invokes with kind user_attachment', async () => {
      const id = await aetherAPI.session.nextAttachmentId({
        parentId: 'parent-1',
        chatId: 'chat-1',
      });
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:next-id', {
        kind: 'user_attachment',
        parentId: 'parent-1',
        chatId: 'chat-1',
      });
      expect(id).toBe('mock-id-123');
    });

    it('parseId invokes session:parse-id with id', async () => {
      await aetherAPI.session.parseId('some-id-string');
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:parse-id', { id: 'some-id-string' });
    });

    it('getStats invokes session:get-stats', async () => {
      await aetherAPI.session.getStats();
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:get-stats');
    });

    it('clearChatSession invokes session:clear with chatId', async () => {
      await aetherAPI.session.clearChatSession('chat-1');
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:clear', { chatId: 'chat-1' });
    });

    it('clearAll invokes session:clear-all', async () => {
      await aetherAPI.session.clearAll();
      expect(mockBridge.invoke).toHaveBeenCalledWith('session:clear-all');
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.log
  // --------------------------------------------------------------------------

  describe('aetherAPI.log', () => {
    it('send dispatches valid string message via renderer-log', () => {
      aetherAPI.log.send('test message');
      expect(mockBridge.send).toHaveBeenCalledWith('renderer-log', 'test message');
    });

    it('send ignores non-string values', () => {
      aetherAPI.log.send(123);
      aetherAPI.log.send(null);
      aetherAPI.log.send(undefined);
      aetherAPI.log.send({ msg: 'obj' });
      aetherAPI.log.send(['arr']);
      expect(mockBridge.send).not.toHaveBeenCalled();
    });

    it('send ignores messages longer than 10000 characters', () => {
      aetherAPI.log.send('x'.repeat(10001));
      expect(mockBridge.send).not.toHaveBeenCalled();
    });

    it('send allows messages of exactly 10000 characters', () => {
      const msg = 'y'.repeat(10000);
      aetherAPI.log.send(msg);
      expect(mockBridge.send).toHaveBeenCalledWith('renderer-log', msg);
    });

    it('send allows empty string (valid string, within length)', () => {
      // empty string is falsy — the check is typeof + length only
      // Source: if (typeof message === 'string' && message.length <= 10000)
      // Empty string has length 0 which is <= 10000, so it should pass
      aetherAPI.log.send('');
      expect(mockBridge.send).toHaveBeenCalledWith('renderer-log', '');
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.jobTracer
  // --------------------------------------------------------------------------

  describe('aetherAPI.jobTracer', () => {
    const origNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = origNodeEnv;
    });

    it('record logs debug in development mode', () => {
      process.env.NODE_ENV = 'development';
      aetherAPI.jobTracer.record('test-job', { key: 'val' });
      expect(mockLog.debug).toHaveBeenCalledWith('job trace', {
        jobType: 'test-job',
        context: { key: 'val' },
      });
    });

    it('record is silent in non-development mode', () => {
      process.env.NODE_ENV = 'test';
      aetherAPI.jobTracer.record('test-job', { key: 'val' });
      expect(mockLog.debug).not.toHaveBeenCalled();
    });

    it('record is silent in production mode', () => {
      process.env.NODE_ENV = 'production';
      aetherAPI.jobTracer.record('test-job', { key: 'val' });
      expect(mockLog.debug).not.toHaveBeenCalled();
    });

    it('record defaults context to empty object', () => {
      process.env.NODE_ENV = 'development';
      aetherAPI.jobTracer.record('test-job');
      expect(mockLog.debug).toHaveBeenCalledWith('job trace', {
        jobType: 'test-job',
        context: {},
      });
    });

    it('flush returns a resolved promise', async () => {
      const result = await aetherAPI.jobTracer.flush();
      expect(result).toBeUndefined();
    });

    it('getStats returns empty stats object', () => {
      const stats = aetherAPI.jobTracer.getStats();
      expect(stats).toEqual({ totalJobs: 0, jobTypes: {} });
    });
  });

  // --------------------------------------------------------------------------
  // aetherAPI.getMetadata / getStats
  // --------------------------------------------------------------------------

  describe('aetherAPI.getMetadata / getStats', () => {
    it('getMetadata delegates to bridge.getMetadata', () => {
      const result = aetherAPI.getMetadata();
      expect(mockBridge.getMetadata).toHaveBeenCalled();
      expect(result).toEqual({ context: 'artifactsWindow' });
    });

    it('getStats delegates to bridge.getStats', () => {
      const result = aetherAPI.getStats();
      expect(mockBridge.getStats).toHaveBeenCalled();
      expect(result).toEqual({ rateLimiter: {}, sizeValidator: {} });
    });
  });

  // --------------------------------------------------------------------------
  // Sanitizer API (detailed)
  // --------------------------------------------------------------------------

  describe('sanitizer API', () => {
    it('isAvailable returns true', () => {
      expect(aetherAPI.sanitizer.isAvailable()).toBe(true);
    });

    it('getInfo returns version and profiles', () => {
      const info = aetherAPI.sanitizer.getInfo();
      expect(info).toEqual({
        available: true,
        version: '3.0.0',
        profiles: ['strict', 'default', 'permissive'],
      });
    });

    describe('sanitizeHTML', () => {
      it('returns empty string for empty string input', () => {
        expect(aetherAPI.sanitizer.sanitizeHTML('')).toBe('');
      });

      it('returns empty string for falsy input (null, undefined, 0, false)', () => {
        expect(aetherAPI.sanitizer.sanitizeHTML(null)).toBe('');
        expect(aetherAPI.sanitizer.sanitizeHTML(undefined)).toBe('');
        expect(aetherAPI.sanitizer.sanitizeHTML(0)).toBe('');
        expect(aetherAPI.sanitizer.sanitizeHTML(false)).toBe('');
      });

      it('returns empty string for non-string input', () => {
        expect(aetherAPI.sanitizer.sanitizeHTML(123)).toBe('');
        expect(aetherAPI.sanitizer.sanitizeHTML({ html: '<b>' })).toBe('');
        expect(aetherAPI.sanitizer.sanitizeHTML(['arr'])).toBe('');
      });

      it('uses strict profile by default when no opts provided', () => {
        aetherAPI.sanitizer.sanitizeHTML('<b>test</b>');
        const [, cfg] = mockDOMPurify.sanitize.mock.calls[0];
        expect(cfg.ALLOWED_TAGS).toEqual(['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'code', 'pre']);
        expect(cfg.ALLOWED_ATTR).toEqual(['href', 'title', 'target']);
      });

      it('uses strict profile when explicitly specified', () => {
        aetherAPI.sanitizer.sanitizeHTML('<b>test</b>', { profile: 'strict' });
        const [, cfg] = mockDOMPurify.sanitize.mock.calls[0];
        expect(cfg.ALLOWED_TAGS).toEqual(['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'code', 'pre']);
        expect(cfg.ALLOWED_ATTR).toEqual(['href', 'title', 'target']);
      });

      it('uses default profile with expanded tag/attr sets', () => {
        aetherAPI.sanitizer.sanitizeHTML('<div>test</div>', { profile: 'default' });
        const [, cfg] = mockDOMPurify.sanitize.mock.calls[0];
        expect(cfg.ALLOWED_TAGS).toEqual([
          'b', 'i', 'em', 'strong', 'a', 'p', 'ul', 'ol', 'li',
          'code', 'pre', 'br', 'span', 'div', 'img',
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
        ]);
        expect(cfg.ALLOWED_ATTR).toEqual(['href', 'src', 'alt', 'title', 'target', 'style', 'class']);
      });

      it('uses permissive profile (no tag/attr restrictions)', () => {
        aetherAPI.sanitizer.sanitizeHTML('<script>x</script>', { profile: 'permissive' });
        const [, cfg] = mockDOMPurify.sanitize.mock.calls[0];
        expect(cfg.ALLOWED_TAGS).toBe(false);
        expect(cfg.ALLOWED_ATTR).toBe(false);
      });

      it('handles case-insensitive profile names', () => {
        aetherAPI.sanitizer.sanitizeHTML('<b>test</b>', { profile: 'STRICT' });
        const [, cfg] = mockDOMPurify.sanitize.mock.calls[0];
        expect(cfg.ALLOWED_TAGS).toEqual(['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'code', 'pre']);
      });

      it('unknown profile falls through to strict (default case)', () => {
        aetherAPI.sanitizer.sanitizeHTML('<b>test</b>', { profile: 'nonexistent' });
        const [, cfg] = mockDOMPurify.sanitize.mock.calls[0];
        expect(cfg.ALLOWED_TAGS).toEqual(['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'code', 'pre']);
      });

      it('preserves extra options alongside profile configuration', () => {
        aetherAPI.sanitizer.sanitizeHTML('<b>test</b>', { profile: 'strict', RETURN_DOM: true });
        const [, cfg] = mockDOMPurify.sanitize.mock.calls[0];
        expect(cfg.RETURN_DOM).toBe(true);
        expect(cfg.ALLOWED_TAGS).toBeDefined();
      });

      it('returns sanitized HTML from DOMPurify', () => {
        mockDOMPurify.sanitize.mockReturnValue('<b>clean</b>');
        const result = aetherAPI.sanitizer.sanitizeHTML('<b>test</b><script>evil</script>');
        expect(result).toBe('<b>clean</b>');
      });

      it('falls back to regex escape when DOMPurify.sanitize throws', () => {
        mockDOMPurify.sanitize.mockImplementation(() => {
          throw new Error('purify error');
        });
        const result = aetherAPI.sanitizer.sanitizeHTML('<b>"test"&\'x\'</b>');
        expect(result).toBe('&lt;b&gt;&quot;test&quot;&amp;&#39;x&#39;&lt;/b&gt;');
      });

      it('regex fallback handles ampersand correctly', () => {
        mockDOMPurify.sanitize.mockImplementation(() => {
          throw new Error('fail');
        });
        expect(aetherAPI.sanitizer.sanitizeHTML('a & b')).toBe('a &amp; b');
      });

      it('regex fallback handles all 5 special characters', () => {
        mockDOMPurify.sanitize.mockImplementation(() => {
          throw new Error('fail');
        });
        const result = aetherAPI.sanitizer.sanitizeHTML('&<>"\' end');
        expect(result).toBe('&amp;&lt;&gt;&quot;&#39; end');
      });
    });
  });

  // --------------------------------------------------------------------------
  // Library load failure paths (resetModules + doMock pattern)
  // --------------------------------------------------------------------------

  describe('library load failure paths', () => {
    /**
     * Helper: reset modules and re-mock ALL dependencies with doMock.
     * doMock overrides the top-level jest.mock after resetModules.
     * @param {Object} overrides - library overrides: { hljs, marked, dompurify }
     *   Set to 'THROW' to simulate require failure.
     *   Set to 'NULL' to simulate require returning null (module exists but valueless).
     *   Set to an object to provide custom library mock.
     * @returns {{ log, exposeCalls }}
     */
    function requireFresh(overrides = {}) {
      jest.resetModules();

      // Core dependency mocks (doMock overrides top-level jest.mock after resetModules)
      const testLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

      jest.doMock('electron', () => ({
        contextBridge: { exposeInMainWorld: jest.fn() },
        ipcRenderer: {},
      }));
      jest.doMock('../../../src/preload/common/bridge-factory', () => ({
        createBridge: jest.fn(() => ({
          send: jest.fn(), on: jest.fn(() => jest.fn()), once: jest.fn(),
          invoke: jest.fn().mockResolvedValue(undefined),
          removeListener: jest.fn(), removeAllListeners: jest.fn(),
          getMetadata: jest.fn(), getStats: jest.fn(),
        })),
      }));
      jest.doMock('../../../src/core/utils/logger', () => ({
        createLogger: jest.fn(() => testLog),
      }));
      jest.doMock('../../../src/core/config/renderer-config', () => ({
        getConfigSnapshot: jest.fn(() => ({})),
      }));
      jest.doMock('../../../src/preload/common/csp-injector', () => ({
        injectCspMeta: jest.fn(),
      }));

      // Library mocks — use overrides or provide defaults
      if (overrides.hljs === 'THROW') {
        jest.doMock('highlight.js/lib/core', () => { throw new Error('hljs not found'); });
      } else {
        jest.doMock('highlight.js/lib/core', () => overrides.hljs || { registerLanguage: jest.fn(), configure: jest.fn() });
      }
      // Mock all 21 unique language modules
      for (const lang of HLJS_LANG_MODULES) {
        jest.doMock(`highlight.js/lib/languages/${lang}`, () => jest.fn());
      }

      if (overrides.marked === 'THROW') {
        jest.doMock('marked', () => { throw new Error('marked not found'); });
      } else if (overrides.marked === 'NULL') {
        jest.doMock('marked', () => null);
      } else {
        jest.doMock('marked', () => overrides.marked || { setOptions: jest.fn() });
      }

      if (overrides.dompurify === 'THROW') {
        jest.doMock('dompurify', () => { throw new Error('dompurify not found'); });
      } else if (overrides.dompurify === 'NULL') {
        jest.doMock('dompurify', () => null);
      } else {
        jest.doMock('dompurify', () => overrides.dompurify || { sanitize: jest.fn((h) => h), version: '3.0.0' });
      }

      require('../../../src/preload/artifacts-preload');

      const { contextBridge: ctxBridge } = require('electron');
      return { log: testLog, exposeCalls: ctxBridge.exposeInMainWorld.mock.calls.slice() };
    }

    afterEach(() => {
      jest.resetModules();
    });

    it('logs error and continues when highlight.js fails to load', () => {
      const { log, exposeCalls } = requireFresh({ hljs: 'THROW' });
      expect(log.error).toHaveBeenCalledWith('failed to load highlight.js', {
        error: 'hljs not found',
      });
      // hljs should NOT be exposed when load fails
      const hljsExpose = exposeCalls.find(c => c[0] === 'hljs');
      expect(hljsExpose).toBeUndefined();
    });

    it('logs error and continues when marked fails to load', () => {
      const { log, exposeCalls } = requireFresh({ marked: 'THROW' });
      expect(log.error).toHaveBeenCalledWith('failed to load marked', {
        error: 'marked not found',
      });
      const markedExpose = exposeCalls.find(c => c[0] === 'marked');
      expect(markedExpose).toBeUndefined();
    });

    it('logs error and continues when DOMPurify fails to load', () => {
      const { log, exposeCalls } = requireFresh({ dompurify: 'THROW' });
      expect(log.error).toHaveBeenCalledWith('failed to load sanitizer', {
        error: 'dompurify not found',
      });
      const sanitizerExpose = exposeCalls.find(c => c[0] === 'sanitizer');
      expect(sanitizerExpose).toBeUndefined();
    });

    it('handles DOMPurify with .default export (ESM compat)', () => {
      const innerDOMPurify = { sanitize: jest.fn((h) => h), version: '4.0.0' };
      const { log, exposeCalls } = requireFresh({ dompurify: { default: innerDOMPurify } });
      expect(log.info).toHaveBeenCalledWith('DOMPurify sanitizer loaded');
      const sanitizerCall = exposeCalls.find(c => c[0] === 'sanitizer');
      expect(sanitizerCall).toBeDefined();
      expect(sanitizerCall[1].getInfo().version).toBe('4.0.0');
    });

    it('handles marked without setOptions method', () => {
      const { log } = requireFresh({ marked: { parse: jest.fn() } });
      expect(log.info).toHaveBeenCalledWith('marked loaded successfully');
    });

    it('handles marked module returning null (not exposed, still logs success)', () => {
      const { log, exposeCalls } = requireFresh({ marked: 'NULL' });
      // marked is null → setOptions not called, log.info still fires
      expect(log.info).toHaveBeenCalledWith('marked loaded successfully');
      // null marked should not be exposed via contextBridge
      const markedExpose = exposeCalls.find(c => c[0] === 'marked');
      expect(markedExpose).toBeUndefined();
    });

    it('handles DOMPurify module returning null (sanitizer stays null, not exposed)', () => {
      const { exposeCalls } = requireFresh({ dompurify: 'NULL' });
      // DOMPurify is null → if (DOMPurify) is false → sanitizer stays null
      const sanitizerExpose = exposeCalls.find(c => c[0] === 'sanitizer');
      expect(sanitizerExpose).toBeUndefined();
      // aether API should still have sanitizer as null
      const aetherExpose = exposeCalls.find(c => c[0] === 'aether');
      expect(aetherExpose[1].sanitizer).toBeNull();
    });

    it('handles DOMPurify without version property (returns unknown)', () => {
      const { exposeCalls } = requireFresh({ dompurify: { sanitize: jest.fn((h) => h) } });
      const sanitizerCall = exposeCalls.find(c => c[0] === 'sanitizer');
      expect(sanitizerCall).toBeDefined();
      expect(sanitizerCall[1].getInfo().version).toBe('unknown');
    });

    it('still exposes aether API even when all libraries fail', () => {
      const { exposeCalls } = requireFresh({
        hljs: 'THROW',
        marked: 'THROW',
        dompurify: 'THROW',
      });
      const aetherExpose = exposeCalls.find(c => c[0] === 'aether');
      expect(aetherExpose).toBeDefined();
      // hljs, marked, sanitizer on the API should be null
      expect(aetherExpose[1].hljs).toBeNull();
      expect(aetherExpose[1].marked).toBeNull();
      expect(aetherExpose[1].sanitizer).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Storage API creation failure
  // --------------------------------------------------------------------------

  describe('storageAPI creation failure', () => {
    it('normal path produces non-null storage', () => {
      jest.isolateModules(() => {
        const { contextBridge: ctxBridge } = require('electron');
        const { createBridge: cbMock } = require('../../../src/preload/common/bridge-factory');
        const { createLogger: clMock } = require('../../../src/core/utils/logger');
        const rcMock = require('../../../src/core/config/renderer-config');
        const testLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
        clMock.mockReturnValue(testLog);
        rcMock.getConfigSnapshot.mockReturnValue({});
        cbMock.mockReturnValue({
          send: jest.fn(), on: jest.fn(() => jest.fn()), once: jest.fn(),
          invoke: jest.fn().mockResolvedValue(undefined),
          removeListener: jest.fn(), removeAllListeners: jest.fn(),
          getMetadata: jest.fn(), getStats: jest.fn(),
        });

        require('../../../src/preload/artifacts-preload');
        const api = ctxBridge.exposeInMainWorld.mock.calls.find(c => c[0] === 'aether');
        expect(api[1].storage).not.toBeNull();
        expect(api[1].storageAPI).not.toBeNull();
      });
    });
  });

  // --------------------------------------------------------------------------
  // Error during contextBridge.exposeInMainWorld
  // --------------------------------------------------------------------------

  describe('error during exposeInMainWorld', () => {
    afterEach(() => {
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
          send: jest.fn(), on: jest.fn(() => jest.fn()), once: jest.fn(),
          invoke: jest.fn().mockResolvedValue(undefined),
          removeListener: jest.fn(), removeAllListeners: jest.fn(),
          getMetadata: jest.fn(), getStats: jest.fn(),
        });

        ctxBridge.exposeInMainWorld.mockImplementation(() => {
          throw new Error('context bridge test failure');
        });

        expect(() => require('../../../src/preload/artifacts-preload')).toThrow('context bridge test failure');
        expect(errorLog.error).toHaveBeenCalledWith('failed to expose API', {
          error: 'context bridge test failure',
        });
      });
    });
  });
});
