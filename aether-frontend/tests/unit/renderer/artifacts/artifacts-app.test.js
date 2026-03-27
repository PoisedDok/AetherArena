'use strict';

// =============================================================================
// Mocks (before require)
// =============================================================================

const mockInit = jest.fn().mockResolvedValue(undefined);
const mockDispose = jest.fn();
const mockGetPane = jest.fn((name) => document.createElement('div'));

const MockArtifactsWindow = jest.fn(() => ({ init: mockInit, dispose: mockDispose }));
const MockTabManager = jest.fn(() => ({ init: mockInit, getPane: mockGetPane, dispose: mockDispose }));
const MockCodeViewer = jest.fn(() => ({ init: mockInit, dispose: mockDispose }));
const MockOutputViewer = jest.fn(() => ({ init: mockInit, dispose: mockDispose }));
const MockSafeCodeExecutor = jest.fn(() => ({ dispose: mockDispose }));
const MockFileManager = jest.fn(() => ({ init: mockInit, dispose: mockDispose }));

const mockResolveStorageAPI = jest.fn(() => ({ get: jest.fn(), set: jest.fn() }));

jest.mock('../../../../src/renderer/artifacts/modules/window/ArtifactsWindow', () => MockArtifactsWindow);
jest.mock('../../../../src/renderer/artifacts/modules/tabs/TabManager', () => MockTabManager);
jest.mock('../../../../src/renderer/artifacts/modules/code/CodeViewer', () => MockCodeViewer);
jest.mock('../../../../src/renderer/artifacts/modules/output/OutputViewer', () => MockOutputViewer);
jest.mock('../../../../src/renderer/artifacts/modules/execution/SafeCodeExecutor', () => MockSafeCodeExecutor);
jest.mock('../../../../src/renderer/artifacts/modules/files/FileManager', () => MockFileManager);
jest.mock('../../../../src/shared/utils/storage-resolver', () => ({
  resolveStorageAPI: mockResolveStorageAPI,
}));

const ArtifactsApp = require('../../../../src/renderer/artifacts/runtime/ArtifactsApp');

// =============================================================================
// Helpers
// =============================================================================

function createMockContainer() {
  const store = new Map();
  return {
    has: jest.fn((token) => store.has(token)),
    register: jest.fn((token, factory, opts) => { store.set(token, { factory, opts }); }),
    resolve: jest.fn((token) => {
      if (!store.has(token)) throw new Error(`Token ${token} not found`);
      return store.get(token).factory();
    }),
    _store: store,
  };
}

function createApp(overrides = {}) {
  const container = overrides.container || createMockContainer();
  const eventBus = overrides.eventBus || { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
  return new ArtifactsApp({ container, eventBus, ...overrides });
}

// =============================================================================
// Tests
// =============================================================================

describe('ArtifactsApp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('throws when container is missing', () => {
      expect(() => new ArtifactsApp({ eventBus: {} }))
        .toThrow('[ArtifactsApp] DI container required');
    });

    it('throws when eventBus is missing', () => {
      expect(() => new ArtifactsApp({ container: {} }))
        .toThrow('[ArtifactsApp] EventBus required');
    });

    it('initializes with default state', () => {
      const app = createApp();
      expect(app.controller).toBeNull();
      expect(app.modules).toEqual({});
      expect(app._isDisposed).toBe(false);
      expect(app.initialized).toBe(false);
      expect(app.storageAPI).toBeNull();
    });

    it('freezes the config option', () => {
      const config = { theme: 'dark' };
      const app = createApp({ config });
      expect(Object.isFrozen(app.config)).toBe(true);
      expect(app.config.theme).toBe('dark');
    });

    it('accepts optional ipc and storageAPI', () => {
      const ipc = { invoke: jest.fn() };
      const storageAPI = { get: jest.fn() };
      const app = createApp({ ipc, storageAPI });
      expect(app.ipc).toBe(ipc);
      expect(app.storageAPI).toBe(storageAPI);
    });

    it('defaults ipc to null', () => {
      const app = createApp();
      expect(app.ipc).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // setController
  // ---------------------------------------------------------------------------

  describe('setController()', () => {
    it('stores the controller reference', () => {
      const app = createApp();
      const controller = { init: jest.fn() };
      app.setController(controller);
      expect(app.controller).toBe(controller);
    });
  });

  // ---------------------------------------------------------------------------
  // initialize
  // ---------------------------------------------------------------------------

  describe('initialize()', () => {
    it('throws if controller not set', async () => {
      const app = createApp();
      await expect(app.initialize()).rejects.toThrow(
        '[ArtifactsApp] Controller must be provided before initialization'
      );
    });

    it('creates all 6 modules in correct order', async () => {
      const app = createApp();
      app.setController({ name: 'ctrl' });

      const result = await app.initialize();

      expect(MockArtifactsWindow).toHaveBeenCalledTimes(1);
      expect(MockTabManager).toHaveBeenCalledTimes(1);
      expect(MockCodeViewer).toHaveBeenCalledTimes(1);
      expect(MockOutputViewer).toHaveBeenCalledTimes(1);
      expect(MockSafeCodeExecutor).toHaveBeenCalledTimes(1);
      expect(MockFileManager).toHaveBeenCalledTimes(1);

      // Verify all 6 modules created (order is implicit from sequential await calls)
      const moduleKeys = Object.keys(result);
      expect(moduleKeys).toEqual([
        'artifactsWindow', 'tabManager', 'codeViewer',
        'outputViewer', 'codeExecutor', 'fileManager',
      ]);

      expect(result).toHaveProperty('artifactsWindow');
      expect(result).toHaveProperty('tabManager');
      expect(result).toHaveProperty('codeViewer');
      expect(result).toHaveProperty('outputViewer');
      expect(result).toHaveProperty('codeExecutor');
      expect(result).toHaveProperty('fileManager');
    });

    it('passes controller and eventBus to modules', async () => {
      const eventBus = { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
      const controller = { name: 'ctrl' };
      const app = createApp({ eventBus });
      app.setController(controller);

      await app.initialize();

      expect(MockArtifactsWindow).toHaveBeenCalledWith(
        expect.objectContaining({ controller, eventBus })
      );
      expect(MockCodeViewer).toHaveBeenCalledWith(
        expect.objectContaining({ controller, eventBus })
      );
    });

    it('calls init on each module that has one', async () => {
      const app = createApp();
      app.setController({ name: 'ctrl' });
      await app.initialize();

      // init is called for: artifactsWindow, tabManager, codeViewer, outputViewer, fileManager (5 times)
      // SafeCodeExecutor does NOT have init
      expect(mockInit).toHaveBeenCalledTimes(5);
    });

    it('calls getPane for code, output, files tabs', async () => {
      const app = createApp();
      app.setController({ name: 'ctrl' });
      await app.initialize();

      expect(mockGetPane).toHaveBeenCalledWith('code');
      expect(mockGetPane).toHaveBeenCalledWith('output');
      expect(mockGetPane).toHaveBeenCalledWith('files');
    });

    it('registers all 6 modules as singletons in container', async () => {
      const container = createMockContainer();
      const app = new ArtifactsApp({ container, eventBus: { emit: jest.fn(), on: jest.fn() } });
      app.setController({ name: 'ctrl' });
      await app.initialize();

      expect(container.register).toHaveBeenCalledTimes(6);
      const registeredTokens = container.register.mock.calls.map(c => c[0]);
      expect(registeredTokens).toEqual([
        'artifactsWindow', 'tabManager', 'codeViewer',
        'outputViewer', 'codeExecutor', 'fileManager',
      ]);
    });

    it('skips registration if token already exists in container', async () => {
      const container = createMockContainer();
      // Pre-register one token
      container._store.set('tabManager', { factory: () => 'existing' });
      const app = new ArtifactsApp({ container, eventBus: { emit: jest.fn(), on: jest.fn() } });
      app.setController({ name: 'ctrl' });
      await app.initialize();

      // tabManager already existed, so register is called 5 times not 6
      expect(container.register).toHaveBeenCalledTimes(5);
    });

    it('sets initialized = true after successful init', async () => {
      const app = createApp();
      app.setController({ name: 'ctrl' });
      await app.initialize();

      expect(app.initialized).toBe(true);
    });

    it('returns cached modules on double-init (guard)', async () => {
      const app = createApp();
      app.setController({ name: 'ctrl' });
      const first = await app.initialize();
      const second = await app.initialize();

      expect(second).toBe(first);
      // Constructors called only once
      expect(MockArtifactsWindow).toHaveBeenCalledTimes(1);
    });

    it('returns empty modules if disposed before init', async () => {
      const app = createApp();
      app.setController({ name: 'ctrl' });
      app._isDisposed = true;

      const result = await app.initialize();
      expect(result).toEqual({});
      expect(MockArtifactsWindow).not.toHaveBeenCalled();
    });

    it('uses provided storageAPI over resolved one', async () => {
      const customStorage = { get: jest.fn(), set: jest.fn() };
      const app = createApp();
      app.setController({ name: 'ctrl' });
      await app.initialize({ storageAPI: customStorage });

      expect(app.storageAPI).toBe(customStorage);
      expect(mockResolveStorageAPI).not.toHaveBeenCalled();
    });

    it('resolves storageAPI via _resolveStorageAPI when not provided', async () => {
      const app = createApp();
      app.setController({ name: 'ctrl' });
      await app.initialize();

      expect(mockResolveStorageAPI).toHaveBeenCalledTimes(1);
    });

    it('passes sessionStore and storageAPI to FileManager', async () => {
      const sessionStore = { get: jest.fn() };
      const app = createApp();
      app.setController({ name: 'ctrl' });
      await app.initialize({ sessionStore });

      expect(MockFileManager).toHaveBeenCalledWith(
        expect.objectContaining({ sessionManager: sessionStore })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // _resolveStorageAPI
  // ---------------------------------------------------------------------------

  describe('_resolveStorageAPI()', () => {
    it('resolves from container when available', async () => {
      const containerStorage = { get: jest.fn() };
      const container = createMockContainer();
      container._store.set('storageAPI', { factory: () => containerStorage });
      const app = new ArtifactsApp({ container, eventBus: { emit: jest.fn(), on: jest.fn() } });

      const result = app._resolveStorageAPI();
      expect(result).toBe(containerStorage);
    });

    it('falls back to resolveStorageAPI() when container resolve throws', async () => {
      const fallbackStorage = { get: jest.fn(), set: jest.fn() };
      mockResolveStorageAPI.mockReturnValueOnce(fallbackStorage);

      const container = createMockContainer();
      container._store.set('storageAPI', { factory: () => { throw new Error('fail'); } });
      const app = new ArtifactsApp({ container, eventBus: { emit: jest.fn(), on: jest.fn() } });

      const result = app._resolveStorageAPI();
      expect(mockResolveStorageAPI).toHaveBeenCalledTimes(1);
      expect(result).toBe(fallbackStorage);
    });

    it('falls back to resolveStorageAPI() when container lacks token', async () => {
      const container = createMockContainer();
      const app = new ArtifactsApp({ container, eventBus: { emit: jest.fn(), on: jest.fn() } });

      const result = app._resolveStorageAPI();
      expect(mockResolveStorageAPI).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // getModules / getStorageAPI
  // ---------------------------------------------------------------------------

  describe('getModules()', () => {
    it('returns a shallow copy of modules', async () => {
      const app = createApp();
      app.setController({ name: 'ctrl' });
      await app.initialize();

      const modules = app.getModules();
      expect(modules).not.toBe(app.modules);
      expect(Object.keys(modules)).toEqual(Object.keys(app.modules));
    });

    it('returns empty object before initialization', () => {
      const app = createApp();
      expect(app.getModules()).toEqual({});
    });
  });

  describe('getStorageAPI()', () => {
    it('returns null before initialization', () => {
      const app = createApp();
      expect(app.getStorageAPI()).toBeNull();
    });

    it('returns storageAPI after initialization', async () => {
      const app = createApp();
      app.setController({ name: 'ctrl' });
      await app.initialize();
      expect(app.getStorageAPI()).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // dispose
  // ---------------------------------------------------------------------------

  describe('dispose()', () => {
    it('disposes all modules in reverse creation order', async () => {
      const disposeCalls = [];
      const makeDispose = (name) => jest.fn(() => disposeCalls.push(name));

      MockArtifactsWindow.mockImplementationOnce(() => ({ init: mockInit, dispose: makeDispose('artifactsWindow') }));
      MockTabManager.mockImplementationOnce(() => ({ init: mockInit, getPane: mockGetPane, dispose: makeDispose('tabManager') }));
      MockCodeViewer.mockImplementationOnce(() => ({ init: mockInit, dispose: makeDispose('codeViewer') }));
      MockOutputViewer.mockImplementationOnce(() => ({ init: mockInit, dispose: makeDispose('outputViewer') }));
      MockSafeCodeExecutor.mockImplementationOnce(() => ({ dispose: makeDispose('codeExecutor') }));
      MockFileManager.mockImplementationOnce(() => ({ init: mockInit, dispose: makeDispose('fileManager') }));

      const app = createApp();
      app.setController({ name: 'ctrl' });
      await app.initialize();
      app.dispose();

      expect(disposeCalls).toEqual([
        'fileManager', 'codeExecutor', 'outputViewer',
        'codeViewer', 'tabManager', 'artifactsWindow',
      ]);
    });

    it('clears modules, controller, storageAPI, and initialized flag', async () => {
      const app = createApp();
      app.setController({ name: 'ctrl' });
      await app.initialize();
      app.dispose();

      expect(app.modules).toEqual({});
      expect(app.controller).toBeNull();
      expect(app.storageAPI).toBeNull();
      expect(app.initialized).toBe(false);
    });

    it('sets _isDisposed flag', async () => {
      const app = createApp();
      app.setController({ name: 'ctrl' });
      await app.initialize();
      app.dispose();

      expect(app._isDisposed).toBe(true);
    });

    it('is idempotent (double-dispose)', async () => {
      const app = createApp();
      app.setController({ name: 'ctrl' });
      await app.initialize();
      app.dispose();
      app.dispose(); // Should not throw

      expect(app._isDisposed).toBe(true);
    });

    it('handles modules without dispose method', async () => {
      MockSafeCodeExecutor.mockImplementationOnce(() => ({ /* no dispose */ }));

      const app = createApp();
      app.setController({ name: 'ctrl' });
      await app.initialize();

      expect(() => app.dispose()).not.toThrow();
    });

    it('catches and swallows dispose errors from individual modules', async () => {
      MockArtifactsWindow.mockImplementationOnce(() => ({
        init: mockInit,
        dispose: jest.fn(() => { throw new Error('dispose boom'); }),
      }));

      const app = createApp();
      app.setController({ name: 'ctrl' });
      await app.initialize();

      expect(() => app.dispose()).not.toThrow();
    });
  });
});
