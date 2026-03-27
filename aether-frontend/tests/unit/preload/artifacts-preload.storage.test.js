'use strict';

describe('artifacts preload storage bridge', () => {
  let invokeMock;
  let sendMock;
  let onMock;
  let exposeMock;

  beforeEach(() => {
    jest.resetModules();

    // Unit test should not depend on (or hardcode) backend URLs.
    // Preload injects CSP using rendererConfig.getConfigSnapshot(), which fail-fast requires a backend baseUrl.
    // For this storage-bridge unit test, CSP injection is out of scope, so we mock it to a no-op.
    jest.doMock('../../../src/preload/common/csp-injector', () => ({
      injectCspMeta: jest.fn(),
      buildFileCspPolicy: jest.fn(() => "default-src 'self'"),
    }));

    invokeMock = jest.fn().mockResolvedValue(undefined);
    sendMock = jest.fn();
    onMock = jest.fn();
    exposeMock = jest.fn((key, value) => {
      Object.defineProperty(window, key, {
        value,
        configurable: true,
        writable: true,
      });
    });

    jest.doMock('electron', () => ({
      contextBridge: {
        exposeInMainWorld: exposeMock,
      },
      ipcRenderer: {
        invoke: invokeMock,
        on: onMock,
        once: jest.fn(),
        removeListener: jest.fn(),
        removeAllListeners: jest.fn(),
        send: sendMock,
      },
    }));

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.resetModules();
    jest.dontMock('electron');
    jest.restoreAllMocks();
    delete window.aether;
    delete window.hljs;
    delete window.marked;
    delete window.sanitizer;
  });

  test('exposes storage API that proxies persistence calls through ipcRenderer', async () => {
    require('../../../src/preload/artifacts-preload');

    expect(exposeMock).toHaveBeenCalled();
    expect(window.aether).toBeDefined();
    expect(typeof window.aether.storage).toBe('object');
    expect(typeof window.aether.storage.saveArtifact).toBe('function');

    // CONTRACT: chatId must be a UUID (validated by preload IPC payload schema)
    const chatId = '550e8400-e29b-41d4-a716-446655440000';
    await window.aether.storage.saveArtifact(chatId, { foo: 'bar' });

    expect(invokeMock).toHaveBeenCalledWith('storage:save-artifact', {
      chatId,
      artifact: { foo: 'bar' },
    });
  });

  test('exposes storage API on both storage and storageAPI aliases', () => {
    require('../../../src/preload/artifacts-preload');

    expect(window.aether.storage).toBeDefined();
    expect(window.aether.storageAPI).toBe(window.aether.storage);
  });
});


