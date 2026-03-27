'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: () => {},
  trace: () => {},
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const { EventTypes } = require('../../../../src/core/events/EventTypes');

const { CodeExecutionHandler } = require(
  '../../../../src/renderer/artifacts/controllers/modules/CodeExecutionHandler'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createHandler(overrides = {}) {
  const eventBus = { emit: jest.fn() };
  const ipcSend = jest.fn();
  const aether = { ipc: { send: ipcSend } };
  const cache = overrides.cache || new Map();
  const sessionStore = { addArtifact: jest.fn() };
  const codeExecutor = {
    executeJavaScript: jest.fn().mockResolvedValue({ output: 'result', exitCode: 0 }),
  };
  const switchTab = jest.fn();
  const loadArtifact = jest.fn();
  const persistArtifact = jest.fn().mockResolvedValue({ id: 'saved-1' });

  const handler = new CodeExecutionHandler({
    eventBus,
    aether: overrides.aether || aether,
    getArtifactCache: () => cache,
    getCurrentChatId: () => ('chatId' in overrides ? overrides.chatId : 'chat-001'),
    getSessionStore: () => sessionStore,
    getCodeExecutor: () => codeExecutor,
    switchTab,
    loadArtifact,
    persistArtifact,
  });

  return {
    handler, eventBus, aether, ipcSend, cache,
    sessionStore, codeExecutor, switchTab, loadArtifact, persistArtifact,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodeExecutionHandler', () => {
  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });

  // =========================================================================
  // requestBackendExecution
  // =========================================================================

  describe('requestBackendExecution', () => {
    it('sends IPC message with correct payload', async () => {
      const { handler, ipcSend } = createHandler();

      await handler.requestBackendExecution({
        code: 'console.log(1)',
        language: 'javascript',
        artifactId: 'art-1',
      });

      expect(ipcSend).toHaveBeenCalledWith('artifacts:execute-code', {
        chatId: 'chat-001',
        code: 'console.log(1)',
        language: 'javascript',
        artifactId: 'art-1',
      });
    });

    it('resolves chatId from cache when currentChatId is null', async () => {
      const cache = new Map([['art-1', { chatId: 'cached-chat' }]]);
      const { handler, ipcSend } = createHandler({ chatId: null, cache });

      await handler.requestBackendExecution({
        code: 'x',
        language: 'js',
        artifactId: 'art-1',
      });

      expect(ipcSend).toHaveBeenCalledWith('artifacts:execute-code', expect.objectContaining({
        chatId: 'cached-chat',
      }));
    });

    it('throws when payload is not an object', async () => {
      const { handler } = createHandler();
      await expect(handler.requestBackendExecution(null))
        .rejects.toThrow('requires payload object');
    });

    it('throws when code is missing', async () => {
      const { handler } = createHandler();
      await expect(handler.requestBackendExecution({ language: 'js' }))
        .rejects.toThrow('requires code (string)');
    });

    it('throws when language is missing', async () => {
      const { handler } = createHandler();
      await expect(handler.requestBackendExecution({ code: 'x' }))
        .rejects.toThrow('requires language (string)');
    });

    it('resolves chatId from cache using chat_id (snake_case) fallback', async () => {
      const cache = new Map([['art-1', { chat_id: 'snake-chat' }]]);
      const { handler, ipcSend } = createHandler({ chatId: null, cache });

      await handler.requestBackendExecution({
        code: 'y',
        language: 'python',
        artifactId: 'art-1',
      });

      expect(ipcSend).toHaveBeenCalledWith('artifacts:execute-code', expect.objectContaining({
        chatId: 'snake-chat',
      }));
    });

    it('throws CONTRACT VIOLATION when no chatId resolvable', async () => {
      const { handler } = createHandler({ chatId: null });
      await expect(handler.requestBackendExecution({ code: 'x', language: 'js' }))
        .rejects.toThrow('CONTRACT VIOLATION');
    });

    it('throws CONTRACT VIOLATION when aether.ipc.send is missing', async () => {
      const { handler } = createHandler({ aether: {} });
      await expect(handler.requestBackendExecution({ code: 'x', language: 'js' }))
        .rejects.toThrow('CONTRACT VIOLATION');
    });
  });

  // =========================================================================
  // executeHtmlInPlace
  // =========================================================================

  describe('executeHtmlInPlace', () => {
    function setupHtmlArtifacts() {
      const codeArtifact = {
        id: 'code-1',
        chatId: 'chat-001',
        executionGroup: 'exec-1',
        type: 'code',
        role: 'assistant',
        content: 'old-html',
        filename: 'code.html',
      };
      const outputArtifact = {
        id: 'out-1',
        type: 'output',
        role: 'computer',
        format: 'html',
        executionGroup: 'exec-1',
        content: 'old-html',
        filename: 'output.html',
      };
      const cache = new Map([
        ['code-1', codeArtifact],
        ['out-1', outputArtifact],
      ]);
      return { codeArtifact, outputArtifact, cache };
    }

    it('updates both artifacts in-memory and persists both', async () => {
      const { cache } = setupHtmlArtifacts();
      const { handler, persistArtifact, switchTab, loadArtifact } = createHandler({ cache });

      await handler.executeHtmlInPlace({ code: '<h1>New</h1>', codeArtifactId: 'code-1' });

      // In-memory update
      expect(cache.get('code-1').content).toBe('<h1>New</h1>');
      expect(cache.get('out-1').content).toBe('<h1>New</h1>');

      // Persist both with full payload verification
      expect(persistArtifact).toHaveBeenCalledTimes(2);

      const codePersist = persistArtifact.mock.calls[0][0];
      expect(codePersist.type).toBe('code');
      expect(codePersist.content).toBe('<h1>New</h1>');
      expect(codePersist.language).toBe('html');
      expect(codePersist.artifact_id).toBe('code-1');
      expect(codePersist.chat_id).toBe('chat-001');
      expect(codePersist.filename).toBe('code.html');

      const outputPersist = persistArtifact.mock.calls[1][0];
      expect(outputPersist.type).toBe('output');
      expect(outputPersist.content).toBe('<h1>New</h1>');
      expect(outputPersist.language).toBe('html');
      expect(outputPersist.artifact_id).toBe('out-1');
      expect(outputPersist.chat_id).toBe('chat-001');
      expect(outputPersist.filename).toBe('output.html');

      // Display
      expect(switchTab).toHaveBeenCalledWith('output');
      expect(loadArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'out-1' }),
        expect.objectContaining({ origin: 'html-execute-in-place' })
      );
    });

    it('throws when req is not an object', async () => {
      const { handler } = createHandler();
      await expect(handler.executeHtmlInPlace(null))
        .rejects.toThrow('requires payload object');
    });

    it('throws when code is missing', async () => {
      const { handler } = createHandler();
      await expect(handler.executeHtmlInPlace({ codeArtifactId: 'x' }))
        .rejects.toThrow('requires code (string)');
    });

    it('throws when codeArtifactId is missing', async () => {
      const { handler } = createHandler();
      await expect(handler.executeHtmlInPlace({ code: 'x' }))
        .rejects.toThrow('requires codeArtifactId (string)');
    });

    it('throws when code artifact not in cache', async () => {
      const { handler } = createHandler();
      await expect(handler.executeHtmlInPlace({ code: 'x', codeArtifactId: 'missing' }))
        .rejects.toThrow('could not resolve code artifact');
    });

    it('throws when executionGroup is missing from code artifact', async () => {
      const cache = new Map([['c1', { id: 'c1', chatId: 'chat-001' }]]);
      const { handler } = createHandler({ cache });
      await expect(handler.executeHtmlInPlace({ code: 'x', codeArtifactId: 'c1' }))
        .rejects.toThrow('requires executionGroup');
    });

    it('throws when no matching output artifact found', async () => {
      const cache = new Map([['c1', {
        id: 'c1', chatId: 'chat-001', executionGroup: 'eg-1',
      }]]);
      const { handler } = createHandler({ cache });
      await expect(handler.executeHtmlInPlace({ code: 'x', codeArtifactId: 'c1' }))
        .rejects.toThrow('could not find matching html output artifact');
    });
  });

  // =========================================================================
  // executeCode
  // =========================================================================

  describe('executeCode', () => {
    it('executes JS, creates output artifact with correct structure', async () => {
      const { handler, codeExecutor, switchTab, loadArtifact, sessionStore, eventBus } = createHandler();

      const result = await handler.executeCode('console.log(1)', 'javascript');

      expect(codeExecutor.executeJavaScript).toHaveBeenCalledWith('console.log(1)');
      expect(switchTab).toHaveBeenCalledWith('output');

      // Verify output artifact structure deeply
      const outputArtifact = loadArtifact.mock.calls[0][0];
      expect(outputArtifact.type).toBe('console');
      expect(outputArtifact.format).toBe('text');
      expect(outputArtifact.role).toBe('computer');
      expect(outputArtifact.chatId).toBe('chat-001');
      expect(outputArtifact.id).toMatch(/^output_\d+$/);
      expect(typeof outputArtifact.content).toBe('string');
      expect(outputArtifact.content.length).toBeGreaterThan(0);
      expect(outputArtifact.executionResult).toEqual({ output: 'result', exitCode: 0 });

      // Verify load options
      const loadOpts = loadArtifact.mock.calls[0][1];
      expect(loadOpts).toEqual({
        autoSwitch: false,
        forceAutoSwitch: false,
        forceOutput: true,
        origin: 'execution',
        isFinal: true,
      });

      // Verify session store
      expect(sessionStore.addArtifact).toHaveBeenCalledWith(outputArtifact);

      // Verify ALL events
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.ARTIFACTS.EXECUTION_STARTED,
        { language: 'javascript' }
      );
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.ARTIFACTS.EXECUTION_COMPLETE,
        { result, artifact: outputArtifact }
      );
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.ARTIFACTS.ARTIFACT_ADDED,
        { artifact: outputArtifact, chatId: 'chat-001' }
      );

      expect(result).toEqual({ output: 'result', exitCode: 0 });
    });

    it('creates error artifact with correct structure and rethrows', async () => {
      const { handler, codeExecutor, switchTab, loadArtifact, sessionStore, eventBus } = createHandler();
      codeExecutor.executeJavaScript.mockRejectedValue(new Error('SyntaxError'));

      await expect(handler.executeCode('bad(', 'javascript'))
        .rejects.toThrow('SyntaxError');

      expect(switchTab).toHaveBeenCalledWith('output');

      // Verify error artifact structure deeply
      const errorArtifact = loadArtifact.mock.calls[0][0];
      expect(errorArtifact.isError).toBe(true);
      expect(errorArtifact.type).toBe('console');
      expect(errorArtifact.format).toBe('text');
      expect(errorArtifact.role).toBe('computer');
      expect(errorArtifact.chatId).toBe('chat-001');
      expect(errorArtifact.id).toMatch(/^error_\d+$/);
      expect(errorArtifact.content).toContain('Execution Error');
      expect(errorArtifact.content).toContain('SyntaxError');

      // Error artifact also added to session
      expect(sessionStore.addArtifact).toHaveBeenCalledWith(errorArtifact);

      // Both error events emitted
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.ARTIFACTS.EXECUTION_ERROR,
        { error: expect.any(Error), artifact: errorArtifact }
      );
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.ARTIFACTS.ARTIFACT_ADDED,
        { artifact: errorArtifact, chatId: 'chat-001' }
      );
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('nulls all references', () => {
      const { handler } = createHandler();
      handler.dispose();

      expect(handler.eventBus).toBeNull();
      expect(handler.aether).toBeNull();
      expect(handler.getArtifactCache).toBeNull();
      expect(handler.getCurrentChatId).toBeNull();
      expect(handler.getSessionStore).toBeNull();
      expect(handler.getCodeExecutor).toBeNull();
      expect(handler.switchTab).toBeNull();
      expect(handler.loadArtifact).toBeNull();
      expect(handler.persistArtifact).toBeNull();
    });
  });
});
