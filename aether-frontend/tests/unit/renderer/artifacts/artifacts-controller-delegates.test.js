'use strict';

// ---------------------------------------------------------------------------
// Module mocks — MUST precede require() calls
// ---------------------------------------------------------------------------

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const mockAether = {
  ipc: { send: jest.fn() },
  artifacts: {
    streamReady: jest.fn(),
    exportFile: jest.fn().mockResolvedValue(undefined),
  },
  windowControl: { setState: jest.fn() },
  isDetachedWindow: false,
};
jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => mockAether,
}));

jest.mock('../../../../src/shared/utils/storage-resolver', () => ({
  resolveStorageAPI: () => ({}),
}));

const mockSessionBridge = { setActiveChat: jest.fn().mockResolvedValue(undefined) };
jest.mock('../../../../src/renderer/shared/adapters/session', () => mockSessionBridge);

// ArtifactSessionStore mock
const mockSessionStore = {
  init: jest.fn().mockResolvedValue(undefined),
  switchSession: jest.fn().mockResolvedValue(null),
  cacheArtifacts: jest.fn(),
  getArtifact: jest.fn(() => null),
  getSessionArtifacts: jest.fn(() => ({ artifacts: [] })),
  dispose: jest.fn(),
};
jest.mock('../../../../src/renderer/shared/state/artifactSessionStore', () => ({
  ArtifactSessionStore: jest.fn(() => mockSessionStore),
}));

// *** Extracted module constructor mocks ***
const mockArtifactDeletionHandler = {
  handleFileDeleted: jest.fn(),
  showDeletedArtifactMessage: jest.fn(),
  dispose: jest.fn(),
};
jest.mock(
  '../../../../src/renderer/artifacts/controllers/modules/ArtifactDeletionHandler',
  () => ({ ArtifactDeletionHandler: jest.fn(() => mockArtifactDeletionHandler) })
);

const mockArtifactLookupService = {
  handleShowArtifact: jest.fn(),
  primeArtifactCache: jest.fn(() => false),
  trackBackendIndex: jest.fn(),
  dispose: jest.fn(),
};
jest.mock(
  '../../../../src/renderer/artifacts/controllers/modules/ArtifactLookupService',
  () => ({ ArtifactLookupService: jest.fn(() => mockArtifactLookupService) })
);

const mockCodeExecutionHandler = {
  executeCode: jest.fn().mockResolvedValue({ success: true }),
  requestBackendExecution: jest.fn().mockResolvedValue({ queued: true }),
  executeHtmlInPlace: jest.fn().mockResolvedValue({ rendered: true }),
  dispose: jest.fn(),
};
jest.mock(
  '../../../../src/renderer/artifacts/controllers/modules/CodeExecutionHandler',
  () => ({ CodeExecutionHandler: jest.fn(() => mockCodeExecutionHandler) })
);

// Application services
const mockArtifactService = {
  getByChat: jest.fn().mockResolvedValue([]),
  saveArtifact: jest.fn().mockResolvedValue({ id: 'saved-1' }),
};
const mockArtifactCache = {
  set: jest.fn(),
  get: jest.fn(),
  has: jest.fn(() => false),
  delete: jest.fn(),
  clear: jest.fn(),
  values: jest.fn(() => []),
  size: 0,
};
const mockArtifactIndexService = {
  track: jest.fn(),
  getVariants: jest.fn(() => null),
  clear: jest.fn(),
};
const mockBackendHealthProbe = {
  probe: jest.fn().mockResolvedValue({ healthy: true }),
};

// Mock ArtifactRouter, ArtifactEnricher, FileExportValidator
const mockRoute = jest.fn(() => ({
  viewer: 'codeViewer',
  tab: 'code',
  shouldAutoSwitch: false,
}));
const mockEnrich = jest.fn((artifact) => ({ ...artifact, enriched: true }));
const mockValidate = jest.fn(() => ({
  sanitizedFilename: 'clean.js',
  validExtension: 'js',
  contentSize: 42,
}));

jest.mock('../../../../src/application/artifacts/ArtifactsServices', () => ({
  ArtifactsServices: jest.fn(() => ({
    artifactService: mockArtifactService,
    artifactCache: mockArtifactCache,
    artifactIndexService: mockArtifactIndexService,
    backendHealthProbe: mockBackendHealthProbe,
  })),
  FileExportValidator: { validate: mockValidate },
  ArtifactRouter: { route: mockRoute },
  ArtifactEnricher: { enrich: mockEnrich },
}));

// ModuleCoordinator mock
const mockModuleCoordinator = {
  loadToViewer: jest.fn(() => true),
  highlightArtifact: jest.fn(),
};
jest.mock('../../../../src/renderer/artifacts/services/ModuleCoordinator', () => ({
  ModuleCoordinator: jest.fn(() => mockModuleCoordinator),
}));

// EventTypes
jest.mock('../../../../src/core/events/EventTypes', () => ({
  EventTypes: {
    SYSTEM: { READY: 'system:ready', ERROR: 'system:error' },
    UI: {
      NOTIFICATION: 'ui:notification',
      WINDOW_FOCUSED: 'ui:window-focused',
      WINDOW_VISIBILITY_REQUESTED: 'ui:window-visibility-requested',
    },
    CONNECTION: { BACKEND_ONLINE: 'connection:backend-online', BACKEND_OFFLINE: 'connection:backend-offline' },
    ARTIFACTS: {
      LOADED: 'artifacts:loaded',
      FILE_DELETED: 'artifacts:file-deleted',
      FILE_EXPORT_STARTED: 'artifacts:file-export-started',
      FILE_EXPORTED: 'artifacts:file-exported',
      FILE_EXPORT_ERROR: 'artifacts:file-export-error',
      TAB_CHANGED: 'artifacts:tab-changed',
      CHAT_SWITCHED: 'artifacts:chat-switched',
      MODE_CHANGED: 'artifacts:mode-changed',
    },
  },
  EventPriority: { HIGH: 'high', NORMAL: 'normal' },
}));

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------
const ArtifactsController = require(
  '../../../../src/renderer/artifacts/controllers/ArtifactsController'
);

// Access mock constructors for closure verification tests
const { ArtifactDeletionHandler: MockDeletionCtor } = require(
  '../../../../src/renderer/artifacts/controllers/modules/ArtifactDeletionHandler'
);
const { ArtifactLookupService: MockLookupCtor } = require(
  '../../../../src/renderer/artifacts/controllers/modules/ArtifactLookupService'
);
const { CodeExecutionHandler: MockCodeExecCtor } = require(
  '../../../../src/renderer/artifacts/controllers/modules/CodeExecutionHandler'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createController(overrides = {}) {
  const eventBus = {
    emit: jest.fn(),
    on: jest.fn(() => jest.fn()),
    off: jest.fn(),
  };
  const container = {
    resolve: jest.fn(),
    register: jest.fn(),
    has: jest.fn(() => false),
  };
  const config = {
    API_BASE_URL: 'http://localhost:8765',
    NODE_ENV: 'test',
  };

  const controller = new ArtifactsController({
    container,
    eventBus,
    config,
    aether: mockAether,
    ...overrides,
  });

  return { controller, eventBus, container, config };
}

function clearAllMocks() {
  jest.clearAllMocks();
}

/**
 * Creates a fully initialized ArtifactsController with all IPC and event
 * callbacks captured. Use for tests that need to invoke IPC/event handlers.
 */
async function initWithCallbacks(extraOverrides = {}) {
  const mockArtifactsApp = {
    setController: jest.fn(),
    initialize: jest.fn().mockResolvedValue({ artifactsWindow: { show: jest.fn() } }),
    getStorageAPI: jest.fn(() => null),
  };

  const ipcCallbacks = {};
  const ipcCleanupFn = jest.fn();
  const eventCallbacks = {};

  const eventBus = {
    emit: jest.fn(),
    on: jest.fn((event, cb) => {
      eventCallbacks[event] = cb;
      return jest.fn();
    }),
    off: jest.fn(),
  };

  const extAether = {
    ...mockAether,
    artifacts: {
      ...mockAether.artifacts,
      onStream: jest.fn((cb) => { ipcCallbacks.stream = cb; return ipcCleanupFn; }),
      onLoadCode: jest.fn((cb) => { ipcCallbacks.loadCode = cb; return ipcCleanupFn; }),
      onLoadOutput: jest.fn((cb) => { ipcCallbacks.loadOutput = cb; return ipcCleanupFn; }),
      onSwitchTab: jest.fn((cb) => { ipcCallbacks.switchTab = cb; return ipcCleanupFn; }),
      onSwitchChat: jest.fn((cb) => { ipcCallbacks.switchChat = cb; return ipcCleanupFn; }),
      onFocus: jest.fn((cb) => { ipcCallbacks.focus = cb; return ipcCleanupFn; }),
      onEnsureVisible: jest.fn((cb) => { ipcCallbacks.ensureVisible = cb; return ipcCleanupFn; }),
      onSetMode: jest.fn((cb) => { ipcCallbacks.setMode = cb; return ipcCleanupFn; }),
      onShowArtifact: jest.fn((cb) => { ipcCallbacks.showArtifact = cb; return ipcCleanupFn; }),
    },
    log: { send: jest.fn() },
    windowControl: { setState: jest.fn() },
    isDetachedWindow: false,
  };

  const container = {
    resolve: jest.fn((name) => name === 'artifactsApp' ? mockArtifactsApp : null),
    register: jest.fn(),
    has: jest.fn((name) => name === 'artifactsApp'),
  };

  const controller = new ArtifactsController({
    container,
    eventBus,
    config: { API_BASE_URL: 'http://localhost:8765', NODE_ENV: 'test' },
    aether: extAether,
    ...extraOverrides,
  });

  await controller.init();

  return {
    controller,
    eventBus,
    container,
    extAether,
    ipcCallbacks,
    eventCallbacks,
    ipcCleanupFn,
    mockArtifactsApp,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ArtifactsController', () => {
  beforeEach(() => {
    clearAllMocks();
    // Reset default return values after clearAllMocks
    mockArtifactLookupService.primeArtifactCache.mockReturnValue(false);
    mockCodeExecutionHandler.executeCode.mockResolvedValue({ success: true });
    mockCodeExecutionHandler.requestBackendExecution.mockResolvedValue({ queued: true });
    mockCodeExecutionHandler.executeHtmlInPlace.mockResolvedValue({ rendered: true });
    mockArtifactService.getByChat.mockResolvedValue([]);
    mockArtifactService.saveArtifact.mockResolvedValue({ id: 'saved-1' });
    mockSessionStore.switchSession.mockResolvedValue(null);
    mockSessionBridge.setActiveChat.mockResolvedValue(undefined);
  });

  // =========================================================================
  // Constructor — validation and wiring
  // =========================================================================

  describe('constructor', () => {
    it('throws when container is missing', () => {
      expect(() => new ArtifactsController({ eventBus: {}, config: {} }))
        .toThrow('[ArtifactsController] DI container required');
    });

    it('throws when eventBus is missing', () => {
      expect(() => new ArtifactsController({ container: {}, config: {} }))
        .toThrow('[ArtifactsController] EventBus required');
    });

    it('throws when config is missing', () => {
      expect(() => new ArtifactsController({ container: {}, eventBus: {} }))
        .toThrow('[ArtifactsController] Config required');
    });

    it('assigns extracted module instances', () => {
      const { controller } = createController();
      expect(controller.artifactDeletionHandler).toBe(mockArtifactDeletionHandler);
      expect(controller.artifactLookupService).toBe(mockArtifactLookupService);
      expect(controller.codeExecutionHandler).toBe(mockCodeExecutionHandler);
    });

    it('initializes state to correct defaults', () => {
      const { controller } = createController();
      expect(controller.initialized).toBe(false);
      expect(controller.backendConnected).toBe(false);
      expect(controller.currentTab).toBe('output');
      expect(controller.currentChatId).toBeNull();
      expect(controller.currentArtifact).toBeNull();
      expect(controller.hasContent).toBe(false);
    });
  });

  // =========================================================================
  // Thin delegates — wiring proof (parameterized)
  // =========================================================================

  describe.each([
    ['_handleFileDeleted', mockArtifactDeletionHandler, 'handleFileDeleted', { artifactId: 'a1' }],
    ['_showDeletedArtifactMessage', mockArtifactDeletionHandler, 'showDeletedArtifactMessage', 'art-del-1'],
    ['_handleShowArtifact', mockArtifactLookupService, 'handleShowArtifact', { artifactId: 'a2', tab: 'code' }],
  ])('%s → module.%s', (delegateMethod, mockModule, moduleMethod, testPayload) => {
    it('forwards argument by reference and calls exactly once', () => {
      const { controller } = createController();
      controller[delegateMethod](testPayload);

      expect(mockModule[moduleMethod]).toHaveBeenCalledTimes(1);
      expect(mockModule[moduleMethod]).toHaveBeenCalledWith(testPayload);
    });
  });

  // =========================================================================
  // Return value forwarding (async public API)
  // =========================================================================

  describe('executeCode → codeExecutionHandler.executeCode', () => {
    it('returns the handler result', async () => {
      const { controller } = createController();
      const result = await controller.executeCode('console.log(1)', 'javascript');

      expect(mockCodeExecutionHandler.executeCode).toHaveBeenCalledWith('console.log(1)', 'javascript');
      expect(result).toEqual({ success: true });
    });

    it('propagates handler errors', async () => {
      const { controller } = createController();
      mockCodeExecutionHandler.executeCode.mockRejectedValueOnce(new Error('exec failed'));

      await expect(controller.executeCode('bad', 'js')).rejects.toThrow('exec failed');
    });
  });

  describe('requestBackendExecution → codeExecutionHandler.requestBackendExecution', () => {
    it('returns the handler result', async () => {
      const { controller } = createController();
      const req = { code: 'x', language: 'python' };
      const result = await controller.requestBackendExecution(req);

      expect(mockCodeExecutionHandler.requestBackendExecution).toHaveBeenCalledWith(req);
      expect(result).toEqual({ queued: true });
    });
  });

  describe('executeHtmlInPlace → codeExecutionHandler.executeHtmlInPlace', () => {
    it('returns the handler result', async () => {
      const { controller } = createController();
      const req = { html: '<p>hi</p>', artifactId: 'a1' };
      const result = await controller.executeHtmlInPlace(req);

      expect(mockCodeExecutionHandler.executeHtmlInPlace).toHaveBeenCalledWith(req);
      expect(result).toEqual({ rendered: true });
    });
  });

  // =========================================================================
  // _primeArtifactCache — captures return value into controller state
  // =========================================================================

  describe('_primeArtifactCache → artifactLookupService.primeArtifactCache', () => {
    it('sets hasContent to true when service returns true', () => {
      const { controller } = createController();
      mockArtifactLookupService.primeArtifactCache.mockReturnValueOnce(true);

      controller._primeArtifactCache([{ id: 'a1' }]);

      expect(controller.hasContent).toBe(true);
      expect(mockArtifactLookupService.primeArtifactCache).toHaveBeenCalledWith([{ id: 'a1' }]);
    });

    it('sets hasContent to false when service returns false', () => {
      const { controller } = createController();
      controller.hasContent = true; // pre-set

      controller._primeArtifactCache([]);

      expect(controller.hasContent).toBe(false);
    });

    it('defaults to empty array when called with no args', () => {
      const { controller } = createController();
      controller._primeArtifactCache();

      expect(mockArtifactLookupService.primeArtifactCache).toHaveBeenCalledWith([]);
    });
  });

  // =========================================================================
  // _trackBackendIndex — default parameter forwarding
  // =========================================================================

  describe('_trackBackendIndex → artifactLookupService.trackBackendIndex', () => {
    it('forwards both arguments', () => {
      const { controller } = createController();
      const artifact = { id: 'a1', role: 'assistant', type: 'code' };
      controller._trackBackendIndex(artifact, 'custom:variant');

      expect(mockArtifactLookupService.trackBackendIndex).toHaveBeenCalledWith(artifact, 'custom:variant');
    });

    it('passes null as default variantKeyOverride', () => {
      const { controller } = createController();
      const artifact = { id: 'a2' };
      controller._trackBackendIndex(artifact);

      expect(mockArtifactLookupService.trackBackendIndex).toHaveBeenCalledWith(artifact, null);
    });
  });

  // =========================================================================
  // switchTab — validation, state, delegation, error propagation
  // =========================================================================

  describe('switchTab', () => {
    it('throws on invalid tab name', () => {
      const { controller } = createController();
      expect(() => controller.switchTab('console')).toThrow('Invalid tab: console');
      expect(() => controller.switchTab('')).toThrow('Invalid tab: ');
      expect(() => controller.switchTab(null)).toThrow('Invalid tab: null');
    });

    it('accepts code, output, and files as valid tabs', () => {
      const { controller } = createController();
      expect(() => controller.switchTab('code')).not.toThrow();
      expect(() => controller.switchTab('output')).not.toThrow();
      expect(() => controller.switchTab('files')).not.toThrow();
    });

    it('updates currentTab state', () => {
      const { controller } = createController();
      expect(controller.currentTab).toBe('output');
      controller.switchTab('code');
      expect(controller.currentTab).toBe('code');
    });

    it('delegates to tabManager.setActiveTab when available', () => {
      const { controller } = createController();
      const setActiveTab = jest.fn();
      controller.modules = { tabManager: { setActiveTab } };

      controller.switchTab('files');

      expect(setActiveTab).toHaveBeenCalledWith('files');
    });

    it('logs warning when tabManager is missing', () => {
      const { controller } = createController();
      controller.modules = {};

      controller.switchTab('code');

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('TabManager not available')
      );
    });

    it('propagates tabManager errors (fail-fast)', () => {
      const { controller } = createController();
      controller.modules = {
        tabManager: {
          setActiveTab: jest.fn(() => { throw new Error('TabManager broke'); }),
        },
      };

      expect(() => controller.switchTab('code')).toThrow('TabManager broke');
    });

    it('still updates currentTab before calling tabManager', () => {
      const { controller } = createController();
      let tabDuringCall = null;
      controller.modules = {
        tabManager: {
          setActiveTab: jest.fn(() => { tabDuringCall = controller.currentTab; }),
        },
      };

      controller.switchTab('files');
      expect(tabDuringCall).toBe('files');
    });
  });

  // =========================================================================
  // loadArtifactsForChat — validation + delegation
  // =========================================================================

  describe('loadArtifactsForChat', () => {
    it('throws on null chatId', async () => {
      const { controller } = createController();
      await expect(controller.loadArtifactsForChat(null)).rejects.toThrow('chatId required');
    });

    it('throws on empty string', async () => {
      const { controller } = createController();
      await expect(controller.loadArtifactsForChat('')).rejects.toThrow('chatId required');
    });

    it('throws on non-string chatId', async () => {
      const { controller } = createController();
      await expect(controller.loadArtifactsForChat(123)).rejects.toThrow('chatId required');
    });

    it('delegates to artifactService.getByChat and returns result', async () => {
      const { controller } = createController();
      const artifacts = [{ id: 'a1' }, { id: 'a2' }];
      mockArtifactService.getByChat.mockResolvedValueOnce(artifacts);

      const result = await controller.loadArtifactsForChat('chat-1');

      expect(mockArtifactService.getByChat).toHaveBeenCalledWith('chat-1');
      expect(result).toBe(artifacts);
    });

    it('propagates service errors (fail-fast)', async () => {
      const { controller } = createController();
      mockArtifactService.getByChat.mockRejectedValueOnce(new Error('DB down'));

      await expect(controller.loadArtifactsForChat('chat-1')).rejects.toThrow('DB down');
    });
  });

  // =========================================================================
  // persistArtifact — validation + delegation
  // =========================================================================

  describe('persistArtifact', () => {
    it('throws on null payload', async () => {
      const { controller } = createController();
      await expect(controller.persistArtifact(null)).rejects.toThrow('artifact payload required');
    });

    it('throws on non-object payload', async () => {
      const { controller } = createController();
      await expect(controller.persistArtifact('string')).rejects.toThrow('artifact payload required');
    });

    it('throws when chat_id is missing (backend contract enforcement)', async () => {
      const { controller } = createController();
      await expect(controller.persistArtifact({ id: 'a1' })).rejects.toThrow('payload.chat_id required');
    });

    it('delegates to artifactService.saveArtifact and returns result', async () => {
      const { controller } = createController();
      const payload = { chat_id: 'c1', content: 'x' };
      const saved = { id: 'saved-1' };
      mockArtifactService.saveArtifact.mockResolvedValueOnce(saved);

      const result = await controller.persistArtifact(payload);

      expect(mockArtifactService.saveArtifact).toHaveBeenCalledWith(payload);
      expect(result).toBe(saved);
    });

    it('propagates service errors (fail-fast)', async () => {
      const { controller } = createController();
      mockArtifactService.saveArtifact.mockRejectedValueOnce(new Error('Save failed'));

      await expect(controller.persistArtifact({ chat_id: 'c1' })).rejects.toThrow('Save failed');
    });
  });

  // =========================================================================
  // _handleLoadCode — artifact object construction
  // =========================================================================

  describe('_handleLoadCode', () => {
    it('constructs code artifact with correct structure and calls loadArtifact', () => {
      const { controller } = createController();
      // Mock loadArtifact to capture the artifact object
      const loadSpy = jest.fn();
      controller.loadArtifact = loadSpy;

      const now = Date.now();
      controller._handleLoadCode('const x = 1;', 'javascript', 'test.js');

      expect(loadSpy).toHaveBeenCalledTimes(1);
      const [artifact, options] = loadSpy.mock.calls[0];

      // Verify artifact structure
      expect(artifact.id).toMatch(/^code_\d+$/);
      expect(artifact.type).toBe('code');
      expect(artifact.content).toBe('const x = 1;');
      expect(artifact.language).toBe('javascript');
      expect(artifact.filename).toBe('test.js');
      expect(artifact.timestamp).toBeGreaterThanOrEqual(now);

      // Verify options
      expect(options).toEqual({
        autoSwitch: true,
        origin: 'manual',
        isFinal: true,
      });
    });

    it('defaults language to text when null', () => {
      const { controller } = createController();
      const loadSpy = jest.fn();
      controller.loadArtifact = loadSpy;

      controller._handleLoadCode('hello', null, 'readme');

      expect(loadSpy.mock.calls[0][0].language).toBe('text');
    });

    it('defaults filename to untitled when null', () => {
      const { controller } = createController();
      const loadSpy = jest.fn();
      controller.loadArtifact = loadSpy;

      controller._handleLoadCode('hello', 'text', null);

      expect(loadSpy.mock.calls[0][0].filename).toBe('untitled');
    });

    it('catches and logs loadArtifact errors without throwing', () => {
      const { controller } = createController();
      controller.loadArtifact = jest.fn(() => { throw new Error('load boom'); });

      expect(() => controller._handleLoadCode('x', 'js', 'f')).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Handle load code failed',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  // =========================================================================
  // _handleLoadOutput — artifact object construction with fallbacks
  // =========================================================================

  describe('_handleLoadOutput', () => {
    it('constructs output artifact with correct structure', () => {
      const { controller } = createController();
      const loadSpy = jest.fn();
      controller.loadArtifact = loadSpy;
      controller.currentChatId = 'chat-42';

      controller._handleLoadOutput({ output: '<p>result</p>', format: 'html' });

      expect(loadSpy).toHaveBeenCalledTimes(1);
      const [artifact, options] = loadSpy.mock.calls[0];

      expect(artifact.id).toMatch(/^output_\d+$/);
      expect(artifact.type).toBe('output');
      expect(artifact.content).toBe('<p>result</p>');
      expect(artifact.format).toBe('html');
      expect(artifact.role).toBe('computer');
      expect(artifact.chatId).toBe('chat-42');
      expect(artifact.language).toBe('html');
      expect(artifact.end).toBe(true);
      expect(artifact.start).toBe(false);

      expect(options).toEqual({
        autoSwitch: true,
        forceAutoSwitch: true,
        forceOutput: true,
        origin: 'load-output',
        isFinal: true,
      });
    });

    it('falls back to data.content when data.output is missing', () => {
      const { controller } = createController();
      const loadSpy = jest.fn();
      controller.loadArtifact = loadSpy;

      controller._handleLoadOutput({ content: 'fallback content' });

      expect(loadSpy.mock.calls[0][0].content).toBe('fallback content');
    });

    it('falls back to raw data when both output and content are missing', () => {
      const { controller } = createController();
      const loadSpy = jest.fn();
      controller.loadArtifact = loadSpy;

      const rawData = 'raw string data';
      controller._handleLoadOutput(rawData);

      expect(loadSpy.mock.calls[0][0].content).toBe(rawData);
    });

    it('sets language to json when format is json', () => {
      const { controller } = createController();
      const loadSpy = jest.fn();
      controller.loadArtifact = loadSpy;

      controller._handleLoadOutput({ output: '{}', format: 'json' });

      expect(loadSpy.mock.calls[0][0].language).toBe('json');
    });

    it('defaults format to text when not provided', () => {
      const { controller } = createController();
      const loadSpy = jest.fn();
      controller.loadArtifact = loadSpy;

      controller._handleLoadOutput({ output: 'plain' });

      expect(loadSpy.mock.calls[0][0].format).toBe('text');
      expect(loadSpy.mock.calls[0][0].language).toBe('text');
    });

    it('catches and logs errors without throwing', () => {
      const { controller } = createController();
      controller.loadArtifact = jest.fn(() => { throw new Error('load output boom'); });

      expect(() => controller._handleLoadOutput({ output: 'x' })).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Handle load output failed',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  // =========================================================================
  // _handleSwitchChat — complex async state management
  // =========================================================================

  describe('_handleSwitchChat', () => {
    it('caches previous chat artifacts before switching', async () => {
      const { controller } = createController();
      controller.currentChatId = 'old-chat';
      const cachedValues = [{ id: 'a1' }, { id: 'a2' }];
      mockArtifactCache.values.mockReturnValueOnce(cachedValues);

      await controller._handleSwitchChat('new-chat');

      expect(mockSessionStore.cacheArtifacts).toHaveBeenCalledWith(
        'old-chat',
        expect.any(Array)
      );
    });

    it('does NOT cache when no previous chatId', async () => {
      const { controller } = createController();
      controller.currentChatId = null;

      await controller._handleSwitchChat('new-chat');

      expect(mockSessionStore.cacheArtifacts).not.toHaveBeenCalled();
    });

    it('resets controller state before switching', async () => {
      const { controller } = createController();
      controller.currentChatId = 'old';
      controller.currentArtifact = { id: 'stale' };
      controller.hasContent = true;

      await controller._handleSwitchChat('new-chat');

      expect(controller.currentChatId).toBe('new-chat');
      expect(controller.currentArtifact).toBeNull();
      expect(controller.hasContent).toBe(false);
      expect(mockArtifactCache.clear).toHaveBeenCalled();
      expect(mockArtifactIndexService.clear).toHaveBeenCalled();
    });

    it('calls sessionBridge.setActiveChat', async () => {
      const { controller } = createController();
      await controller._handleSwitchChat('chat-99');

      expect(mockSessionBridge.setActiveChat).toHaveBeenCalledWith('chat-99');
    });

    it('continues even when sessionBridge.setActiveChat fails', async () => {
      const { controller } = createController();
      mockSessionBridge.setActiveChat.mockRejectedValueOnce(new Error('session fail'));

      await controller._handleSwitchChat('chat-99');

      // Should still update state and emit
      expect(controller.currentChatId).toBe('chat-99');
      expect(mockLog.warn).toHaveBeenCalledWith(
        'Failed to set active session for artifacts',
        expect.objectContaining({ chatId: 'chat-99' })
      );
    });

    it('primes cache from session data when artifacts exist', async () => {
      const { controller } = createController();
      const sessionArtifacts = [{ id: 'sa-1' }, { id: 'sa-2' }];
      mockSessionStore.switchSession.mockResolvedValueOnce({ artifacts: sessionArtifacts });

      await controller._handleSwitchChat('chat-77');

      expect(mockArtifactLookupService.primeArtifactCache).toHaveBeenCalledWith(sessionArtifacts);
    });

    it('does NOT prime cache when session has no artifacts', async () => {
      const { controller } = createController();
      mockSessionStore.switchSession.mockResolvedValueOnce({ artifacts: null });

      await controller._handleSwitchChat('chat-55');

      expect(mockArtifactLookupService.primeArtifactCache).not.toHaveBeenCalled();
    });

    it('emits CHAT_SWITCHED event', async () => {
      const { controller, eventBus } = createController();
      await controller._handleSwitchChat('chat-33');

      expect(eventBus.emit).toHaveBeenCalledWith(
        'artifacts:chat-switched',
        { chatId: 'chat-33' }
      );
    });

    it('loads files when fileManager is available', async () => {
      const { controller } = createController();
      const loadFiles = jest.fn().mockResolvedValue(undefined);
      controller.modules = { fileManager: { loadFiles } };

      await controller._handleSwitchChat('chat-22');

      expect(loadFiles).toHaveBeenCalledWith('chat-22');
    });

    it('catches and logs top-level errors without throwing', async () => {
      const { controller } = createController();
      mockSessionStore.switchSession.mockRejectedValueOnce(new Error('switch boom'));

      await expect(controller._handleSwitchChat('chat-err')).resolves.not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Handle switch chat failed',
        expect.objectContaining({ error: expect.any(Error), chatId: 'chat-err' })
      );
    });
  });

  // =========================================================================
  // IPC handler wrappers — error handling
  // =========================================================================

  describe('_handleSwitchTab', () => {
    it('delegates to switchTab', () => {
      const { controller } = createController();
      const spy = jest.spyOn(controller, 'switchTab');
      controller._handleSwitchTab('code');
      expect(spy).toHaveBeenCalledWith('code');
    });

    it('catches and logs switchTab errors without throwing', () => {
      const { controller } = createController();
      // switchTab throws on invalid tab — _handleSwitchTab should catch it
      expect(() => controller._handleSwitchTab('invalid')).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Handle switch tab failed',
        expect.objectContaining({ error: expect.any(Error), tab: 'invalid' })
      );
    });
  });

  describe('_handleFocus', () => {
    it('emits WINDOW_FOCUSED event', () => {
      const { controller, eventBus } = createController();
      controller._handleFocus();
      expect(eventBus.emit).toHaveBeenCalledWith(
        'ui:window-focused',
        { window: 'artifacts' }
      );
    });
  });

  describe('_handleEnsureVisible', () => {
    it('shows window and emits visibility event', () => {
      const { controller, eventBus } = createController();
      const show = jest.fn();
      controller.modules = { artifactsWindow: { show } };

      controller._handleEnsureVisible();

      expect(show).toHaveBeenCalled();
      expect(eventBus.emit).toHaveBeenCalledWith(
        'ui:window-visibility-requested',
        { window: 'artifacts' }
      );
    });

    it('emits event even when artifactsWindow is missing', () => {
      const { controller, eventBus } = createController();
      controller.modules = {};

      controller._handleEnsureVisible();

      expect(eventBus.emit).toHaveBeenCalledWith(
        'ui:window-visibility-requested',
        { window: 'artifacts' }
      );
    });
  });

  describe('_handleSetMode', () => {
    it('emits MODE_CHANGED event with mode', () => {
      const { controller, eventBus } = createController();
      controller._handleSetMode('compact');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'artifacts:mode-changed',
        { mode: 'compact' }
      );
    });
  });

  // =========================================================================
  // exportFile — validation + IPC + events
  // =========================================================================

  describe('exportFile', () => {
    it('validates, exports via IPC, and emits events in order', async () => {
      const { controller, eventBus } = createController();
      const emitCalls = [];
      eventBus.emit.mockImplementation((event) => emitCalls.push(event));

      await controller.exportFile('content', 'myfile', 'js');

      expect(mockValidate).toHaveBeenCalledWith('content', 'myfile', 'js');
      expect(mockAether.artifacts.exportFile).toHaveBeenCalledWith('content', 'clean.js', 'js');

      // Verify event ordering
      expect(emitCalls).toEqual([
        'artifacts:file-export-started',
        'artifacts:file-exported',
      ]);
    });

    it('propagates validation errors (fail-fast)', async () => {
      const { controller } = createController();
      mockValidate.mockImplementationOnce(() => { throw new Error('path traversal'); });

      await expect(controller.exportFile('../../../etc/passwd', 'bad', 'txt'))
        .rejects.toThrow('path traversal');
    });

    it('emits FILE_EXPORT_ERROR on failure', async () => {
      const { controller, eventBus } = createController();
      mockAether.artifacts.exportFile.mockRejectedValueOnce(new Error('IPC fail'));

      await expect(controller.exportFile('x', 'f', 'js')).rejects.toThrow('IPC fail');
      expect(eventBus.emit).toHaveBeenCalledWith(
        'artifacts:file-export-error',
        expect.objectContaining({ error: expect.any(Error), filename: 'f' })
      );
    });
  });

  // =========================================================================
  // getStats — frozen object with correct fields
  // =========================================================================

  describe('getStats', () => {
    it('returns frozen object with all state fields', () => {
      const { controller } = createController();
      controller.currentChatId = 'chat-stats';
      controller.currentTab = 'code';
      controller.hasContent = true;
      controller.modules = { codeViewer: {}, outputViewer: {} };

      const stats = controller.getStats();

      expect(stats.initialized).toBe(false);
      expect(stats.backendConnected).toBe(false);
      expect(stats.currentTab).toBe('code');
      expect(stats.currentChatId).toBe('chat-stats');
      expect(stats.hasContent).toBe(true);
      expect(stats.modules).toEqual(['codeViewer', 'outputViewer']);
      expect(Object.isFrozen(stats)).toBe(true);
    });
  });

  // =========================================================================
  // loadArtifact — routing, enrichment, tab auto-switch logic
  // =========================================================================

  describe('loadArtifact', () => {
    it('throws on null artifact', () => {
      const { controller } = createController();
      controller.moduleCoordinator = mockModuleCoordinator;
      expect(() => controller.loadArtifact(null)).toThrow('Invalid artifact');
    });

    it('throws on artifact without id', () => {
      const { controller } = createController();
      controller.moduleCoordinator = mockModuleCoordinator;
      expect(() => controller.loadArtifact({})).toThrow('Invalid artifact');
    });

    it('routes, enriches, caches, and loads to viewer', () => {
      const { controller, eventBus } = createController();
      controller.moduleCoordinator = mockModuleCoordinator;
      controller.currentTab = 'output';
      controller.currentChatId = 'chat-la';

      const artifact = { id: 'art-la', role: 'assistant', type: 'code' };
      const classification = {
        viewer: 'codeViewer',
        tab: 'code',
        shouldAutoSwitch: false,
      };
      mockRoute.mockReturnValueOnce(classification);
      const enriched = { ...artifact, enriched: true };
      mockEnrich.mockReturnValueOnce(enriched);

      controller.loadArtifact(artifact, { autoSwitch: true, origin: 'manual', isFinal: true });

      // ArtifactRouter called with correct context
      expect(mockRoute).toHaveBeenCalledWith(artifact, expect.objectContaining({
        autoSwitch: true,
        origin: 'manual',
        isFinal: true,
        currentTab: 'output',
        chatId: 'chat-la',
      }));

      // ArtifactEnricher called
      expect(mockEnrich).toHaveBeenCalledWith(artifact, classification);

      // Cache updated
      expect(mockArtifactCache.set).toHaveBeenCalledWith('art-la', enriched);

      // State updated
      expect(controller.currentArtifact).toBe(enriched);
      expect(controller.hasContent).toBe(true);

      // ModuleCoordinator loaded
      expect(mockModuleCoordinator.loadToViewer).toHaveBeenCalledWith(enriched, classification);
      expect(mockModuleCoordinator.highlightArtifact).toHaveBeenCalledWith('art-la');

      // Event emitted
      expect(eventBus.emit).toHaveBeenCalledWith('artifacts:loaded', { artifact });
    });

    it('auto-switches tab when shouldAutoSwitch is true and not on target tab', () => {
      const { controller } = createController();
      controller.moduleCoordinator = mockModuleCoordinator;
      controller.currentTab = 'output';

      mockRoute.mockReturnValueOnce({
        viewer: 'codeViewer',
        tab: 'code',
        shouldAutoSwitch: true,
      });
      mockEnrich.mockReturnValueOnce({ id: 'a1', enriched: true });

      // Spy on switchTab to verify it's called
      const switchSpy = jest.spyOn(controller, 'switchTab').mockImplementation(() => {});

      controller.loadArtifact({ id: 'a1' }, {});

      expect(switchSpy).toHaveBeenCalledWith('code');
      switchSpy.mockRestore();
    });

    it('does NOT auto-switch when already on target tab', () => {
      const { controller } = createController();
      controller.moduleCoordinator = mockModuleCoordinator;
      controller.currentTab = 'code';

      mockRoute.mockReturnValueOnce({
        viewer: 'codeViewer',
        tab: 'code',
        shouldAutoSwitch: true,
      });
      mockEnrich.mockReturnValueOnce({ id: 'a1', enriched: true });

      const switchSpy = jest.spyOn(controller, 'switchTab').mockImplementation(() => {});

      controller.loadArtifact({ id: 'a1' }, {});

      expect(switchSpy).not.toHaveBeenCalled();
      switchSpy.mockRestore();
    });

    it('does NOT auto-switch away from files tab (unless target is files or origin is file-click)', () => {
      const { controller } = createController();
      controller.moduleCoordinator = mockModuleCoordinator;
      controller.currentTab = 'files';

      mockRoute.mockReturnValueOnce({
        viewer: 'codeViewer',
        tab: 'code',
        shouldAutoSwitch: true,
      });
      mockEnrich.mockReturnValueOnce({ id: 'a1', enriched: true });

      const switchSpy = jest.spyOn(controller, 'switchTab').mockImplementation(() => {});

      controller.loadArtifact({ id: 'a1' }, {});

      expect(switchSpy).not.toHaveBeenCalled();
      switchSpy.mockRestore();
    });

    it('DOES auto-switch from files tab when origin is file-click', () => {
      const { controller } = createController();
      controller.moduleCoordinator = mockModuleCoordinator;
      controller.currentTab = 'files';

      mockRoute.mockReturnValueOnce({
        viewer: 'codeViewer',
        tab: 'code',
        shouldAutoSwitch: false, // shouldAutoSwitch can be false, but origin=file-click triggers it
      });
      mockEnrich.mockReturnValueOnce({ id: 'a1', enriched: true });

      const switchSpy = jest.spyOn(controller, 'switchTab').mockImplementation(() => {});

      controller.loadArtifact({ id: 'a1' }, { origin: 'file-click' });

      expect(switchSpy).toHaveBeenCalledWith('code');
      switchSpy.mockRestore();
    });
  });

  // =========================================================================
  // dispose — resource cleanup verification
  // =========================================================================

  describe('dispose', () => {
    it('disposes extracted modules and nulls references', () => {
      const { controller } = createController();
      controller.dispose();

      expect(mockCodeExecutionHandler.dispose).toHaveBeenCalled();
      expect(mockArtifactLookupService.dispose).toHaveBeenCalled();
      expect(mockArtifactDeletionHandler.dispose).toHaveBeenCalled();
      expect(controller.codeExecutionHandler).toBeNull();
      expect(controller.artifactLookupService).toBeNull();
      expect(controller.artifactDeletionHandler).toBeNull();
    });

    it('clears caches and tracking collections', () => {
      const { controller } = createController();
      controller.dispose();

      expect(mockArtifactCache.clear).toHaveBeenCalled();
      expect(mockArtifactIndexService.clear).toHaveBeenCalled();
    });

    it('resets lifecycle flags', () => {
      const { controller } = createController();
      controller.initialized = true;
      controller.hasContent = true;

      controller.dispose();

      expect(controller.initialized).toBe(false);
      expect(controller.hasContent).toBe(false);
    });

    it('disposes sessionStore when dispose method exists', () => {
      const { controller } = createController();
      controller.dispose();

      expect(mockSessionStore.dispose).toHaveBeenCalled();
    });

    it('survives module dispose errors', () => {
      const { controller } = createController();
      mockCodeExecutionHandler.dispose.mockImplementationOnce(() => {
        throw new Error('handler dispose failed');
      });

      expect(() => controller.dispose()).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to dispose codeExecutionHandler',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    it('disposes viewer modules in reverse order', () => {
      const { controller } = createController();
      const disposalOrder = [];
      controller.modules = {
        codeViewer: { dispose: jest.fn(() => disposalOrder.push('codeViewer')) },
        outputViewer: { dispose: jest.fn(() => disposalOrder.push('outputViewer')) },
        fileManager: { dispose: jest.fn(() => disposalOrder.push('fileManager')) },
      };

      controller.dispose();

      expect(disposalOrder).toEqual(['fileManager', 'outputViewer', 'codeViewer']);
    });

    it('clears modules object after viewer module disposal', () => {
      const { controller } = createController();
      controller.modules = { codeViewer: { dispose: jest.fn() } };
      controller.dispose();
      expect(controller.modules).toEqual({});
    });

    it('executes IPC listener cleanup functions', () => {
      const { controller } = createController();
      const cleanup1 = jest.fn();
      const cleanup2 = jest.fn();
      controller._ipcListeners = [cleanup1, cleanup2];
      controller.dispose();
      expect(cleanup1).toHaveBeenCalledTimes(1);
      expect(cleanup2).toHaveBeenCalledTimes(1);
      expect(controller._ipcListeners).toEqual([]);
    });

    it('executes event listener cleanup functions', () => {
      const { controller } = createController();
      const cleanup1 = jest.fn();
      const cleanup2 = jest.fn();
      controller._eventListeners = [cleanup1, cleanup2];
      controller.dispose();
      expect(cleanup1).toHaveBeenCalledTimes(1);
      expect(cleanup2).toHaveBeenCalledTimes(1);
      expect(controller._eventListeners).toEqual([]);
    });

    it('survives viewer module dispose errors', () => {
      const { controller } = createController();
      controller.modules = {
        broken: { dispose: jest.fn(() => { throw new Error('viewer fail'); }) },
      };
      expect(() => controller.dispose()).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to dispose module',
        expect.objectContaining({ module: 'broken', error: expect.any(Error) })
      );
    });

    it('survives IPC cleanup errors', () => {
      const { controller } = createController();
      controller._ipcListeners = [() => { throw new Error('ipc fail'); }];
      expect(() => controller.dispose()).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to cleanup IPC listener',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    it('survives event cleanup errors', () => {
      const { controller } = createController();
      controller._eventListeners = [() => { throw new Error('event fail'); }];
      expect(() => controller.dispose()).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to cleanup event listener',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    it('nulls service and infrastructure references', () => {
      const { controller } = createController();
      controller.moduleCoordinator = {};
      controller.backendHealthProbe = {};
      controller.artifactService = {};
      controller.currentArtifact = { id: 'stale' };
      controller.storageAPI = {};

      controller.dispose();

      expect(controller.moduleCoordinator).toBeNull();
      expect(controller.backendHealthProbe).toBeNull();
      expect(controller.artifactService).toBeNull();
      expect(controller.currentArtifact).toBeNull();
      expect(controller.storageAPI).toBeNull();
      expect(controller.sessionStore).toBeNull();
    });

    it('clears deletedArtifacts set and logThrottle map', () => {
      const { controller } = createController();
      controller.deletedArtifacts.add('del-1');
      controller._logThrottle.set('art-1', { lastLog: 0, chunkCount: 5 });

      controller.dispose();

      expect(controller.deletedArtifacts.size).toBe(0);
      expect(controller._logThrottle.size).toBe(0);
    });

    it('skips viewer modules without dispose method', () => {
      const { controller } = createController();
      controller.modules = { noDispose: { render: jest.fn() } };
      expect(() => controller.dispose()).not.toThrow();
    });

    it('survives sessionStore dispose error', () => {
      const { controller } = createController();
      mockSessionStore.dispose.mockImplementationOnce(() => {
        throw new Error('session fail');
      });
      expect(() => controller.dispose()).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to dispose sessionStore',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  // =========================================================================
  // _reportWindowState — window state reporting
  // =========================================================================

  describe('_reportWindowState', () => {
    it('calls aether.windowControl.setState with hasContent', () => {
      const { controller } = createController();
      controller.hasContent = true;
      controller._reportWindowState();
      expect(mockAether.windowControl.setState).toHaveBeenCalledWith(true);
    });

    it('calls with false when no content', () => {
      const { controller } = createController();
      controller.hasContent = false;
      controller._reportWindowState();
      expect(mockAether.windowControl.setState).toHaveBeenCalledWith(false);
    });

    it('does not throw when aether.windowControl.setState is missing', () => {
      const { controller } = createController();
      const origWindowControl = mockAether.windowControl;
      mockAether.windowControl = null;
      expect(() => controller._reportWindowState()).not.toThrow();
      mockAether.windowControl = origWindowControl;
    });

    it('catches and logs error when setState throws', () => {
      const { controller } = createController();
      mockAether.windowControl.setState.mockImplementationOnce(() => {
        throw new Error('state fail');
      });
      expect(() => controller._reportWindowState()).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to report window state',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  // =========================================================================
  // IPC handler error paths — _handleFocus, _handleEnsureVisible, _handleSetMode
  // =========================================================================

  describe('_handleFocus error path', () => {
    it('catches and logs error without throwing', () => {
      const { controller, eventBus } = createController();
      eventBus.emit.mockImplementationOnce(() => { throw new Error('focus emit fail'); });
      expect(() => controller._handleFocus()).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Handle focus failed',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  describe('_handleEnsureVisible error path', () => {
    it('catches and logs error without throwing', () => {
      const { controller } = createController();
      controller.modules = {
        artifactsWindow: { show: jest.fn(() => { throw new Error('show fail'); }) },
      };
      expect(() => controller._handleEnsureVisible()).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Handle ensure visible failed',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  describe('_handleSetMode error path', () => {
    it('catches and logs error without throwing', () => {
      const { controller, eventBus } = createController();
      eventBus.emit.mockImplementationOnce(() => { throw new Error('mode emit fail'); });
      expect(() => controller._handleSetMode('compact')).not.toThrow();
      expect(mockLog.error).toHaveBeenCalledWith(
        'Handle set mode failed',
        expect.objectContaining({ error: expect.any(Error), mode: 'compact' })
      );
    });
  });

  // =========================================================================
  // loadArtifact — viewer load failure warning path
  // =========================================================================

  describe('loadArtifact — viewer load failure', () => {
    it('logs warning when moduleCoordinator.loadToViewer returns false', () => {
      const { controller } = createController();
      controller.moduleCoordinator = {
        loadToViewer: jest.fn(() => false),
        highlightArtifact: jest.fn(),
      };

      mockRoute.mockReturnValueOnce({
        viewer: 'codeViewer',
        tab: 'code',
        shouldAutoSwitch: false,
      });
      mockEnrich.mockReturnValueOnce({ id: 'art-fail', enriched: true });

      controller.loadArtifact({ id: 'art-fail' });

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load artifact'),
        expect.objectContaining({ viewer: 'codeViewer', artifactId: 'art-fail' })
      );
    });
  });

  // =========================================================================
  // exportFile — skips IPC when aether.artifacts.exportFile is missing
  // =========================================================================

  describe('exportFile — missing IPC', () => {
    it('does not throw when aether.artifacts.exportFile is missing', async () => {
      const { controller } = createController();
      const origExportFile = mockAether.artifacts.exportFile;
      delete mockAether.artifacts.exportFile;

      await expect(controller.exportFile('x', 'f.txt', 'txt')).resolves.not.toThrow();

      mockAether.artifacts.exportFile = origExportFile;
    });
  });

  // =========================================================================
  // BUG REGRESSION: _isDisposed lifecycle hardening
  // =========================================================================

  describe('_isDisposed lifecycle', () => {
    // BUG 1: dispose() was not idempotent — no _isDisposed flag
    it('sets _isDisposed = false in constructor', () => {
      const { controller } = createController();
      expect(controller._isDisposed).toBe(false);
    });

    it('sets _isDisposed = true after dispose()', () => {
      const { controller } = createController();
      controller.dispose();
      expect(controller._isDisposed).toBe(true);
    });

    it('dispose() is idempotent — second call is a no-op', () => {
      const { controller } = createController();
      controller.dispose();

      // Clear mocks after first dispose
      jest.clearAllMocks();
      mockArtifactLookupService.primeArtifactCache.mockReturnValue(false);

      // Second dispose should be a no-op — no module dispose calls
      controller.dispose();
      expect(mockCodeExecutionHandler.dispose).not.toHaveBeenCalled();
      expect(mockArtifactLookupService.dispose).not.toHaveBeenCalled();
      expect(mockArtifactDeletionHandler.dispose).not.toHaveBeenCalled();
      expect(mockArtifactCache.clear).not.toHaveBeenCalled();
    });

    // init() happy path — exercises all 6 private init methods
    it('init() happy path — initializes and emits SYSTEM.READY', async () => {
      const mockArtifactsApp = {
        setController: jest.fn(),
        initialize: jest.fn().mockResolvedValue({ artifactsWindow: { show: jest.fn() } }),
        getStorageAPI: jest.fn(() => null),
      };
      const mockStreamService = {
        setController: jest.fn(),
        handleStream: jest.fn(),
      };

      // Set up aether.artifacts with all on* IPC methods
      const ipcCleanup = jest.fn();
      const extAether = {
        ...mockAether,
        artifacts: {
          ...mockAether.artifacts,
          onStream: jest.fn(() => ipcCleanup),
          onLoadCode: jest.fn(() => ipcCleanup),
          onLoadOutput: jest.fn(() => ipcCleanup),
          onSwitchTab: jest.fn(() => ipcCleanup),
          onSwitchChat: jest.fn(() => ipcCleanup),
          onFocus: jest.fn(() => ipcCleanup),
          onEnsureVisible: jest.fn(() => ipcCleanup),
          onSetMode: jest.fn(() => ipcCleanup),
          onShowArtifact: jest.fn(() => ipcCleanup),
        },
        log: { send: jest.fn() },
      };

      const container = {
        resolve: jest.fn((name) => {
          if (name === 'artifactsApp') return mockArtifactsApp;
          return null;
        }),
        register: jest.fn(),
        has: jest.fn((name) => name === 'artifactsApp'),
      };

      const { controller, eventBus } = createController({
        container,
        aether: extAether,
      });

      await controller.init();

      // Verify initialization completed
      expect(controller.initialized).toBe(true);

      // Verify sessionStore was initialized
      expect(mockSessionStore.init).toHaveBeenCalledTimes(1);

      // Verify artifactsApp was configured
      expect(mockArtifactsApp.setController).toHaveBeenCalledWith(controller);
      expect(mockArtifactsApp.initialize).toHaveBeenCalledWith(
        expect.objectContaining({ sessionStore: expect.anything() })
      );

      // Verify IPC listeners were registered (8 base + 1 optional onShowArtifact = 9)
      expect(extAether.artifacts.onStream).toHaveBeenCalledTimes(1);
      expect(extAether.artifacts.onLoadCode).toHaveBeenCalledTimes(1);
      expect(extAether.artifacts.onLoadOutput).toHaveBeenCalledTimes(1);
      expect(extAether.artifacts.onSwitchTab).toHaveBeenCalledTimes(1);
      expect(extAether.artifacts.onSwitchChat).toHaveBeenCalledTimes(1);
      expect(extAether.artifacts.onFocus).toHaveBeenCalledTimes(1);
      expect(extAether.artifacts.onEnsureVisible).toHaveBeenCalledTimes(1);
      expect(extAether.artifacts.onSetMode).toHaveBeenCalledTimes(1);
      expect(extAether.artifacts.onShowArtifact).toHaveBeenCalledTimes(1);

      // Verify event listeners were registered (FILE_DELETED + TAB_CHANGED)
      expect(eventBus.on).toHaveBeenCalledWith('artifacts:file-deleted', expect.any(Function));
      expect(eventBus.on).toHaveBeenCalledWith('artifacts:tab-changed', expect.any(Function));

      // Verify backend health probe
      expect(mockBackendHealthProbe.probe).toHaveBeenCalledTimes(1);
      expect(controller.backendConnected).toBe(true);

      // Verify SYSTEM.READY emitted
      expect(eventBus.emit).toHaveBeenCalledWith(
        'system:ready',
        expect.objectContaining({ controller: 'ArtifactsController' }),
        expect.objectContaining({ priority: 'high' })
      );

      // Verify window.artifactsController set
      expect(window.artifactsController).toBe(controller);

      // Verify window.logToMain set
      expect(typeof window.logToMain).toBe('function');
    });

    it('init() — backend health probe failure sets backendConnected false', async () => {
      mockBackendHealthProbe.probe.mockResolvedValue({ healthy: false, error: 'timeout' });
      const mockArtifactsApp = {
        setController: jest.fn(),
        initialize: jest.fn().mockResolvedValue({}),
        getStorageAPI: jest.fn(() => null),
      };

      const ipcCleanup = jest.fn();
      const extAether = {
        ...mockAether,
        artifacts: {
          ...mockAether.artifacts,
          onStream: jest.fn(() => ipcCleanup),
          onLoadCode: jest.fn(() => ipcCleanup),
          onLoadOutput: jest.fn(() => ipcCleanup),
          onSwitchTab: jest.fn(() => ipcCleanup),
          onSwitchChat: jest.fn(() => ipcCleanup),
          onFocus: jest.fn(() => ipcCleanup),
          onEnsureVisible: jest.fn(() => ipcCleanup),
          onSetMode: jest.fn(() => ipcCleanup),
        },
      };

      const container = {
        resolve: jest.fn((name) => name === 'artifactsApp' ? mockArtifactsApp : null),
        register: jest.fn(),
        has: jest.fn((name) => name === 'artifactsApp'),
      };

      const { controller, eventBus } = createController({ container, aether: extAether });
      await controller.init();

      expect(controller.backendConnected).toBe(false);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'connection:backend-offline',
        expect.objectContaining({ error: 'timeout' })
      );
    });

    it('init() error propagation — re-throws and leaves initialized=false', async () => {
      const mockArtifactsApp = {
        setController: jest.fn(),
        initialize: jest.fn().mockRejectedValue(new Error('module init failed')),
        getStorageAPI: jest.fn(() => null),
      };

      const ipcCleanup = jest.fn();
      const extAether = {
        ...mockAether,
        artifacts: {
          ...mockAether.artifacts,
          onStream: jest.fn(() => ipcCleanup),
          onLoadCode: jest.fn(() => ipcCleanup),
          onLoadOutput: jest.fn(() => ipcCleanup),
          onSwitchTab: jest.fn(() => ipcCleanup),
          onSwitchChat: jest.fn(() => ipcCleanup),
          onFocus: jest.fn(() => ipcCleanup),
          onEnsureVisible: jest.fn(() => ipcCleanup),
          onSetMode: jest.fn(() => ipcCleanup),
        },
      };

      const container = {
        resolve: jest.fn((name) => name === 'artifactsApp' ? mockArtifactsApp : null),
        register: jest.fn(),
        has: jest.fn((name) => name === 'artifactsApp'),
      };

      const { controller } = createController({ container, aether: extAether });

      let thrownError;
      try {
        await controller.init();
      } catch (e) {
        thrownError = e;
      }

      expect(thrownError).toBeDefined();
      expect(thrownError.message).toBe('module init failed');
      expect(controller.initialized).toBe(false);
    });

    it('window.logToMain proxies to aether.log.send', async () => {
      const mockArtifactsApp = {
        setController: jest.fn(),
        initialize: jest.fn().mockResolvedValue({ artifactsWindow: { show: jest.fn() } }),
        getStorageAPI: jest.fn(() => null),
      };

      const ipcCleanup = jest.fn();
      const extAether = {
        ...mockAether,
        artifacts: {
          ...mockAether.artifacts,
          onStream: jest.fn(() => ipcCleanup),
          onLoadCode: jest.fn(() => ipcCleanup),
          onLoadOutput: jest.fn(() => ipcCleanup),
          onSwitchTab: jest.fn(() => ipcCleanup),
          onSwitchChat: jest.fn(() => ipcCleanup),
          onFocus: jest.fn(() => ipcCleanup),
          onEnsureVisible: jest.fn(() => ipcCleanup),
          onSetMode: jest.fn(() => ipcCleanup),
        },
        log: { send: jest.fn() },
      };

      const container = {
        resolve: jest.fn((name) => name === 'artifactsApp' ? mockArtifactsApp : null),
        register: jest.fn(),
        has: jest.fn((name) => name === 'artifactsApp'),
      };

      const { controller } = createController({ container, aether: extAether });
      await controller.init();

      window.logToMain('hello', { key: 'val' });
      expect(extAether.log.send).toHaveBeenCalledWith('hello {"key":"val"}');
    });

    // BUG 3: init() had no double-init guard
    it('init() ignores when already initialized', async () => {
      const { controller } = createController();
      controller.initialized = true;

      await controller.init();

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('already-initialized')
      );
    });

    // BUG 4: init() callable after dispose
    it('init() ignores when disposed', async () => {
      const { controller } = createController();
      controller.dispose();

      await controller.init();

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('disposed')
      );
      expect(controller.initialized).toBe(false);
    });
  });

  // =========================================================================
  // BUG REGRESSION: Public methods return safe values when disposed
  // =========================================================================

  describe('public methods guard on _isDisposed', () => {
    // BUG 2: Public methods callable after dispose → NPE crashes
    it('switchTab() is no-op when disposed', () => {
      const { controller } = createController();
      controller.dispose();

      // Should not throw (would NPE on this.modules.tabManager without guard)
      expect(() => controller.switchTab('code')).not.toThrow();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('switchTab()')
      );
    });

    it('loadArtifact() is no-op when disposed', () => {
      const { controller } = createController();
      controller.dispose();

      expect(() => controller.loadArtifact({ id: 'a1' })).not.toThrow();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('loadArtifact()')
      );
    });

    it('loadArtifactsForChat() returns empty array when disposed', async () => {
      const { controller } = createController();
      controller.dispose();

      const result = await controller.loadArtifactsForChat('chat-1');

      expect(result).toEqual([]);
      expect(mockArtifactService.getByChat).not.toHaveBeenCalled();
    });

    it('persistArtifact() returns null when disposed', async () => {
      const { controller } = createController();
      controller.dispose();

      const result = await controller.persistArtifact({ chat_id: 'c1' });

      expect(result).toBeNull();
      expect(mockArtifactService.saveArtifact).not.toHaveBeenCalled();
    });

    it('executeCode() returns null when disposed', async () => {
      const { controller } = createController();
      controller.dispose();

      const result = await controller.executeCode('x', 'js');

      expect(result).toBeNull();
      expect(mockCodeExecutionHandler.executeCode).not.toHaveBeenCalled();
    });

    it('requestBackendExecution() returns null when disposed', async () => {
      const { controller } = createController();
      controller.dispose();

      const result = await controller.requestBackendExecution({ code: 'x' });

      expect(result).toBeNull();
      expect(mockCodeExecutionHandler.requestBackendExecution).not.toHaveBeenCalled();
    });

    it('executeHtmlInPlace() returns null when disposed', async () => {
      const { controller } = createController();
      controller.dispose();

      const result = await controller.executeHtmlInPlace({ html: '<p>' });

      expect(result).toBeNull();
      expect(mockCodeExecutionHandler.executeHtmlInPlace).not.toHaveBeenCalled();
    });

    it('exportFile() is no-op when disposed', async () => {
      const { controller } = createController();
      controller.dispose();

      await controller.exportFile('x', 'f', 'js');

      expect(mockValidate).not.toHaveBeenCalled();
      expect(mockAether.artifacts.exportFile).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // BUG REGRESSION: Private handlers are no-ops when disposed
  // =========================================================================

  describe('private handlers guard on _isDisposed', () => {
    // BUG 2 (continued): Delegate methods crash with NPE after dispose
    it('_handleFileDeleted() is no-op when disposed', () => {
      const { controller } = createController();
      controller.dispose();

      // Would NPE on nulled artifactDeletionHandler without guard
      expect(() => controller._handleFileDeleted({ artifactId: 'a1' })).not.toThrow();
      expect(mockArtifactDeletionHandler.handleFileDeleted).not.toHaveBeenCalled();
    });

    it('_showDeletedArtifactMessage() is no-op when disposed', () => {
      const { controller } = createController();
      controller.dispose();

      expect(() => controller._showDeletedArtifactMessage('art-1')).not.toThrow();
      expect(mockArtifactDeletionHandler.showDeletedArtifactMessage).not.toHaveBeenCalled();
    });

    it('_handleShowArtifact() is no-op when disposed', () => {
      const { controller } = createController();
      controller.dispose();

      expect(() => controller._handleShowArtifact({ artifactId: 'a1' })).not.toThrow();
      expect(mockArtifactLookupService.handleShowArtifact).not.toHaveBeenCalled();
    });

    it('_primeArtifactCache() is no-op when disposed', () => {
      const { controller } = createController();
      controller.dispose();

      controller._primeArtifactCache([{ id: 'a1' }]);

      expect(mockArtifactLookupService.primeArtifactCache).not.toHaveBeenCalled();
    });

    it('_trackBackendIndex() is no-op when disposed', () => {
      const { controller } = createController();
      controller.dispose();

      controller._trackBackendIndex({ id: 'a1' });

      expect(mockArtifactLookupService.trackBackendIndex).not.toHaveBeenCalled();
    });

    // BUG 5 & 6: _handleSwitchChat async race — dispose between awaits
    it('_handleSwitchChat() is no-op when disposed at entry', async () => {
      const { controller } = createController();
      controller.dispose();

      await controller._handleSwitchChat('chat-1');

      // Should not have attempted any state changes
      expect(mockSessionStore.cacheArtifacts).not.toHaveBeenCalled();
      expect(mockSessionBridge.setActiveChat).not.toHaveBeenCalled();
    });

    it('_handleSwitchChat() stops at mid-async guard when disposed during await', async () => {
      const { controller, eventBus } = createController();
      controller.currentChatId = 'old-chat';

      // Dispose during the sessionBridge.setActiveChat await
      mockSessionBridge.setActiveChat.mockImplementationOnce(async () => {
        controller._isDisposed = true; // Simulate concurrent dispose
      });

      await controller._handleSwitchChat('new-chat');

      // sessionBridge was called (before dispose)
      expect(mockSessionBridge.setActiveChat).toHaveBeenCalledWith('new-chat');
      // But switchSession should NOT have been called (after mid-async guard)
      expect(mockSessionStore.switchSession).not.toHaveBeenCalled();
      // CHAT_SWITCHED event should NOT have been emitted
      expect(eventBus.emit).not.toHaveBeenCalledWith(
        'artifacts:chat-switched',
        expect.anything()
      );
    });
  });

  // =========================================================================
  // BUG #2 REGRESSION: container.resolve error now logged (was silent catch)
  // =========================================================================

  describe('_initializeModules — resolve error handling', () => {
    afterEach(() => {
      delete window.artifactSessionManager;
      delete window.artifactsController;
      delete window.logToMain;
    });

    it('logs warning when container.resolve throws for artifactStreamService', async () => {
      const mockArtifactsApp = {
        setController: jest.fn(),
        initialize: jest.fn().mockResolvedValue({ artifactsWindow: { show: jest.fn() } }),
        getStorageAPI: jest.fn(() => null),
      };

      const ipcCleanup = jest.fn();
      const extAether = {
        ...mockAether,
        artifacts: {
          ...mockAether.artifacts,
          onStream: jest.fn(() => ipcCleanup),
          onLoadCode: jest.fn(() => ipcCleanup),
          onLoadOutput: jest.fn(() => ipcCleanup),
          onSwitchTab: jest.fn(() => ipcCleanup),
          onSwitchChat: jest.fn(() => ipcCleanup),
          onFocus: jest.fn(() => ipcCleanup),
          onEnsureVisible: jest.fn(() => ipcCleanup),
          onSetMode: jest.fn(() => ipcCleanup),
        },
        log: { send: jest.fn() },
      };

      const container = {
        resolve: jest.fn((name) => {
          if (name === 'artifactsApp') return mockArtifactsApp;
          if (name === 'artifactStreamService') throw new Error('resolve boom');
          return null;
        }),
        register: jest.fn(),
        has: jest.fn((name) => name === 'artifactsApp' || name === 'artifactStreamService'),
      };

      const { controller } = createController({ container, aether: extAether });
      await controller.init();

      // Bug #2 fix: warning logged instead of silent catch
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to resolve existing artifactStreamService'),
        expect.objectContaining({ error: 'resolve boom' })
      );
      // Still initializes — fallback creates a new instance
      expect(controller.initialized).toBe(true);
    });
  });

  // =========================================================================
  // BUG #3 REGRESSION: dispose() cleans window globals
  // =========================================================================

  describe('dispose() — window globals cleanup', () => {
    afterEach(() => {
      delete window.artifactSessionManager;
      delete window.artifactsController;
      delete window.logToMain;
    });

    it('removes all window globals set during init', async () => {
      const { controller } = await initWithCallbacks();

      // Verify globals set by init
      expect(window.artifactSessionManager).toBeDefined();
      expect(window.artifactsController).toBe(controller);
      expect(typeof window.logToMain).toBe('function');

      controller.dispose();

      // Bug #3 fix: all globals removed
      expect(window.artifactSessionManager).toBeUndefined();
      expect(window.artifactsController).toBeUndefined();
      expect(window.logToMain).toBeUndefined();
    });

    it('window.logToMain closure is safe after dispose (no crash)', async () => {
      const { controller } = await initWithCallbacks();
      const logFn = window.logToMain; // capture reference before dispose
      controller.dispose();

      // Closure uses this.aether?.log?.send — aether not nulled in dispose
      // Should not throw even after dispose
      expect(() => logFn('test after dispose')).not.toThrow();
    });
  });

  // =========================================================================
  // IPC CALLBACK WIRING — Captured callbacks invoke correct handlers
  // =========================================================================

  describe('IPC callback wiring (captured callbacks)', () => {
    afterEach(() => {
      delete window.artifactSessionManager;
      delete window.artifactsController;
      delete window.logToMain;
    });

    // ---- onStream ----
    it('onStream delegates to artifactStreamService.handleStream', async () => {
      const { controller, ipcCallbacks } = await initWithCallbacks();
      const mockHandle = jest.fn();
      controller.modules.artifactStreamService = { handleStream: mockHandle };

      const payload = { type: 'code', content: 'x=1', artifact_id: 'a1' };
      ipcCallbacks.stream(payload);

      expect(mockHandle).toHaveBeenCalledTimes(1);
      expect(mockHandle).toHaveBeenCalledWith(payload);
    });

    it('onStream is no-op when artifactStreamService is null', async () => {
      const { controller, ipcCallbacks } = await initWithCallbacks();
      controller.modules.artifactStreamService = null;

      expect(() => ipcCallbacks.stream({ type: 'code' })).not.toThrow();
    });

    // ---- onLoadCode ----
    it('onLoadCode creates code artifact and delegates to loadArtifact', async () => {
      const { controller, ipcCallbacks } = await initWithCallbacks();
      const spy = jest.spyOn(controller, 'loadArtifact').mockImplementation(() => {});

      ipcCallbacks.loadCode('const x = 1;', 'javascript', 'test.js');

      expect(spy).toHaveBeenCalledTimes(1);
      const [artifact, opts] = spy.mock.calls[0];
      expect(artifact.type).toBe('code');
      expect(artifact.content).toBe('const x = 1;');
      expect(artifact.language).toBe('javascript');
      expect(artifact.filename).toBe('test.js');
      expect(opts).toEqual(expect.objectContaining({
        autoSwitch: true,
        origin: 'manual',
        isFinal: true,
      }));
    });

    it('onLoadCode defaults language=text, filename=untitled', async () => {
      const { controller, ipcCallbacks } = await initWithCallbacks();
      const spy = jest.spyOn(controller, 'loadArtifact').mockImplementation(() => {});

      ipcCallbacks.loadCode('hello', undefined, undefined);

      const [artifact] = spy.mock.calls[0];
      expect(artifact.language).toBe('text');
      expect(artifact.filename).toBe('untitled');
    });

    // ---- onLoadOutput ----
    it('onLoadOutput creates output artifact with correct shape', async () => {
      const { controller, ipcCallbacks } = await initWithCallbacks();
      controller.currentChatId = 'chat-42';
      const spy = jest.spyOn(controller, 'loadArtifact').mockImplementation(() => {});

      ipcCallbacks.loadOutput({ output: 'result', format: 'html' });

      expect(spy).toHaveBeenCalledTimes(1);
      const [artifact, opts] = spy.mock.calls[0];
      expect(artifact.type).toBe('output');
      expect(artifact.content).toBe('result');
      expect(artifact.format).toBe('html');
      expect(artifact.language).toBe('html');
      expect(artifact.chatId).toBe('chat-42');
      expect(artifact.role).toBe('computer');
      expect(artifact.end).toBe(true);
      expect(opts.forceOutput).toBe(true);
      expect(opts.forceAutoSwitch).toBe(true);
      expect(opts.origin).toBe('load-output');
    });

    it('onLoadOutput content fallback: data.content then raw data', async () => {
      const { controller, ipcCallbacks } = await initWithCallbacks();
      const spy = jest.spyOn(controller, 'loadArtifact').mockImplementation(() => {});

      ipcCallbacks.loadOutput({ content: 'fallback' });
      expect(spy.mock.calls[0][0].content).toBe('fallback');

      spy.mockClear();
      ipcCallbacks.loadOutput('raw-string');
      expect(spy.mock.calls[0][0].content).toBe('raw-string');
    });

    it('onLoadOutput format detection: json, html, text defaults', async () => {
      const { controller, ipcCallbacks } = await initWithCallbacks();
      const spy = jest.spyOn(controller, 'loadArtifact').mockImplementation(() => {});

      ipcCallbacks.loadOutput({ output: '{}', format: 'json' });
      expect(spy.mock.calls[0][0].language).toBe('json');

      spy.mockClear();
      ipcCallbacks.loadOutput({ output: 'x', format: 'text' });
      expect(spy.mock.calls[0][0].language).toBe('text');

      spy.mockClear();
      ipcCallbacks.loadOutput({ output: 'y' }); // no format
      expect(spy.mock.calls[0][0].format).toBe('text');
      expect(spy.mock.calls[0][0].language).toBe('text');
    });

    // ---- onSwitchTab ----
    it('onSwitchTab delegates to switchTab', async () => {
      const { controller, ipcCallbacks } = await initWithCallbacks();
      const spy = jest.spyOn(controller, 'switchTab').mockImplementation(() => {});

      ipcCallbacks.switchTab('code');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('code');
    });

    // ---- onSwitchChat ----
    it('onSwitchChat delegates to _handleSwitchChat', async () => {
      const { controller, ipcCallbacks } = await initWithCallbacks();
      const spy = jest.spyOn(controller, '_handleSwitchChat').mockResolvedValue(undefined);

      ipcCallbacks.switchChat('chat-99');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('chat-99');
    });

    // ---- onFocus ----
    it('onFocus emits WINDOW_FOCUSED event', async () => {
      const { eventBus, ipcCallbacks } = await initWithCallbacks();

      ipcCallbacks.focus();

      expect(eventBus.emit).toHaveBeenCalledWith(
        'ui:window-focused',
        { window: 'artifacts' }
      );
    });

    // ---- onEnsureVisible ----
    it('onEnsureVisible shows window and emits visibility event', async () => {
      const { controller, eventBus, ipcCallbacks } = await initWithCallbacks();
      const showSpy = jest.fn();
      controller.modules.artifactsWindow = { show: showSpy };

      ipcCallbacks.ensureVisible();

      expect(showSpy).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).toHaveBeenCalledWith(
        'ui:window-visibility-requested',
        { window: 'artifacts' }
      );
    });

    it('onEnsureVisible safe when artifactsWindow absent', async () => {
      const { controller, ipcCallbacks } = await initWithCallbacks();
      controller.modules.artifactsWindow = undefined;

      expect(() => ipcCallbacks.ensureVisible()).not.toThrow();
    });

    // ---- onSetMode ----
    it('onSetMode emits MODE_CHANGED event', async () => {
      const { eventBus, ipcCallbacks } = await initWithCallbacks();

      ipcCallbacks.setMode('detached');

      expect(eventBus.emit).toHaveBeenCalledWith(
        'artifacts:mode-changed',
        { mode: 'detached' }
      );
    });

    // ---- onShowArtifact ----
    it('onShowArtifact delegates to artifactLookupService', async () => {
      const { ipcCallbacks } = await initWithCallbacks();

      const payload = { artifactId: 'a1', chatId: 'c1' };
      ipcCallbacks.showArtifact(payload);

      expect(mockArtifactLookupService.handleShowArtifact).toHaveBeenCalledWith(payload);
    });

    // ---- onShowArtifact conditional registration ----
    it('onShowArtifact is NOT registered when API method is missing', async () => {
      const mockArtifactsApp = {
        setController: jest.fn(),
        initialize: jest.fn().mockResolvedValue({ artifactsWindow: { show: jest.fn() } }),
        getStorageAPI: jest.fn(() => null),
      };
      const ipcCleanup = jest.fn();
      const noShowAether = {
        ...mockAether,
        artifacts: {
          ...mockAether.artifacts,
          onStream: jest.fn(() => ipcCleanup),
          onLoadCode: jest.fn(() => ipcCleanup),
          onLoadOutput: jest.fn(() => ipcCleanup),
          onSwitchTab: jest.fn(() => ipcCleanup),
          onSwitchChat: jest.fn(() => ipcCleanup),
          onFocus: jest.fn(() => ipcCleanup),
          onEnsureVisible: jest.fn(() => ipcCleanup),
          onSetMode: jest.fn(() => ipcCleanup),
          // onShowArtifact intentionally omitted
        },
        log: { send: jest.fn() },
      };
      const container = {
        resolve: jest.fn((name) => name === 'artifactsApp' ? mockArtifactsApp : null),
        register: jest.fn(),
        has: jest.fn((name) => name === 'artifactsApp'),
      };

      const { controller } = createController({ container, aether: noShowAether });
      await controller.init();

      // 8 IPC listeners (not 9), because onShowArtifact was missing
      expect(controller._ipcListeners).toHaveLength(8);
    });
  });

  // =========================================================================
  // EventBus callback wiring — TAB_CHANGED state sync
  // =========================================================================

  describe('TAB_CHANGED event handler', () => {
    afterEach(() => {
      delete window.artifactSessionManager;
      delete window.artifactsController;
      delete window.logToMain;
    });

    it('syncs currentTab when event tab differs', async () => {
      const { controller, eventCallbacks } = await initWithCallbacks();
      controller.currentTab = 'output';

      eventCallbacks['artifacts:tab-changed']({ tab: 'code' });

      expect(controller.currentTab).toBe('code');
    });

    it('does not update when event tab matches current', async () => {
      const { controller, eventCallbacks } = await initWithCallbacks();
      controller.currentTab = 'code';

      eventCallbacks['artifacts:tab-changed']({ tab: 'code' });

      expect(controller.currentTab).toBe('code');
    });

    it('does not update when data.tab is falsy', async () => {
      const { controller, eventCallbacks } = await initWithCallbacks();
      controller.currentTab = 'output';

      eventCallbacks['artifacts:tab-changed']({ tab: '' });
      expect(controller.currentTab).toBe('output');

      eventCallbacks['artifacts:tab-changed']({ tab: null });
      expect(controller.currentTab).toBe('output');

      eventCallbacks['artifacts:tab-changed']({});
      expect(controller.currentTab).toBe('output');
    });

    // BUG DETECTION: handler does not guard against null/undefined data
    // This test asserts CORRECT behavior. If it fails, the bug exists.
    it('is a safe no-op when data is null or undefined', async () => {
      const { controller, eventCallbacks } = await initWithCallbacks();
      controller.currentTab = 'output';

      expect(() => eventCallbacks['artifacts:tab-changed'](null)).not.toThrow();
      expect(() => eventCallbacks['artifacts:tab-changed'](undefined)).not.toThrow();
      expect(controller.currentTab).toBe('output');
    });
  });

  // =========================================================================
  // FILE_DELETED event handler wiring (via eventBus)
  // =========================================================================

  describe('FILE_DELETED event handler (via eventBus)', () => {
    afterEach(() => {
      delete window.artifactSessionManager;
      delete window.artifactsController;
      delete window.logToMain;
    });

    it('delegates to _handleFileDeleted via eventBus callback', async () => {
      const { controller, eventCallbacks } = await initWithCallbacks();
      const spy = jest.spyOn(controller, '_handleFileDeleted');

      const payload = { artifactId: 'del-1', chatId: 'c1' };
      eventCallbacks['artifacts:file-deleted'](payload);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(payload);
    });

    it('FILE_DELETED is no-op after dispose (via _handleFileDeleted guard)', async () => {
      const { controller, eventCallbacks } = await initWithCallbacks();
      controller.dispose();

      // Callback still invocable but _handleFileDeleted checks _isDisposed
      expect(() => eventCallbacks['artifacts:file-deleted']({ artifactId: 'a1' })).not.toThrow();
      expect(mockArtifactDeletionHandler.handleFileDeleted).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Constructor closure contract — getters bind to live controller state
  // =========================================================================

  describe('constructor closure contract', () => {
    it('ArtifactDeletionHandler receives live getters that track state changes', () => {
      const { controller } = createController();
      const opts = MockDeletionCtor.mock.calls[0][0];

      // getDeletedArtifacts returns the controller's Set
      expect(opts.getDeletedArtifacts()).toBe(controller.deletedArtifacts);
      controller.deletedArtifacts.add('test-id');
      expect(opts.getDeletedArtifacts().has('test-id')).toBe(true);

      // getArtifactCache returns controller's cache
      expect(opts.getArtifactCache()).toBe(controller.artifactCache);

      // getCurrentTab tracks state changes
      expect(opts.getCurrentTab()).toBe('output');
      controller.currentTab = 'code';
      expect(opts.getCurrentTab()).toBe('code');

      // getModules returns the modules object
      expect(opts.getModules()).toBe(controller.modules);
    });

    it('ArtifactLookupService receives live getters and bound methods', () => {
      const { controller } = createController();
      const opts = MockLookupCtor.mock.calls[0][0];

      expect(opts.getArtifactCache()).toBe(controller.artifactCache);
      expect(opts.getArtifactIndexService()).toBe(controller.artifactIndexService);
      expect(opts.getSessionStore()).toBe(controller.sessionStore);

      expect(opts.getCurrentChatId()).toBeNull();
      controller.currentChatId = 'c-99';
      expect(opts.getCurrentChatId()).toBe('c-99');

      expect(opts.getDeletedArtifacts()).toBe(controller.deletedArtifacts);

      // Bound methods are functions
      expect(typeof opts.loadArtifact).toBe('function');
      expect(typeof opts.switchTab).toBe('function');
      expect(typeof opts.showDeletedMessage).toBe('function');
    });

    it('CodeExecutionHandler receives live getters and bound methods', () => {
      const { controller, eventBus } = createController();
      const opts = MockCodeExecCtor.mock.calls[0][0];

      expect(opts.eventBus).toBe(eventBus);
      expect(opts.aether).toBe(controller.aether);

      expect(opts.getArtifactCache()).toBe(controller.artifactCache);
      expect(opts.getCurrentChatId()).toBeNull();
      controller.currentChatId = 'c-42';
      expect(opts.getCurrentChatId()).toBe('c-42');

      expect(opts.getSessionStore()).toBe(controller.sessionStore);
      expect(typeof opts.getCodeExecutor).toBe('function');
      expect(typeof opts.switchTab).toBe('function');
      expect(typeof opts.loadArtifact).toBe('function');
      expect(typeof opts.persistArtifact).toBe('function');
    });

    it('closures bind to controller methods (not static snapshots)', () => {
      const { controller } = createController();
      const lookupOpts = MockLookupCtor.mock.calls[0][0];

      // switchTab closure calls the real controller.switchTab
      const switchTabSpy = jest.spyOn(controller, 'switchTab').mockImplementation(() => {});
      lookupOpts.switchTab('files');
      expect(switchTabSpy).toHaveBeenCalledWith('files');
    });
  });
});
