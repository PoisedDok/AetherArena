'use strict';

/**
 * Coordinator Unit Tests
 * 
 * Tests the 6 extracted coordinator classes from the MainApp god-object decomposition.
 * Covers: constructor fallback, initialize() wiring, dispose() cleanup (N=M), double-dispose safety.
 */

// Mock createRendererLogger before requiring modules
jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: (name) => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

// Mock the AudioManager, HandsfreeCoordinator, HandsfreeConversationDisplay
jest.mock('../../../../src/domain/audio/services/AudioManager', () => {
  return jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    dispose: jest.fn(),
    startMicrophone: jest.fn(),
    stopMicrophone: jest.fn(),
  }));
});

jest.mock('../../../../src/domain/audio/services/HandsfreeCoordinator', () => {
  return jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    dispose: jest.fn(),
    enable: jest.fn(),
    disable: jest.fn(),
  }));
});

jest.mock('../../../../src/renderer/main/modules/handsfree/HandsfreeConversationDisplay', () => {
  return jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    dispose: jest.fn(),
  }));
});

const EventBusBridge = require('../../../../src/renderer/main/runtime/coordinators/EventBusBridge');
const GuruConnectionBridge = require('../../../../src/renderer/main/runtime/coordinators/GuruConnectionBridge');
const ControlPanelController = require('../../../../src/renderer/main/runtime/coordinators/ControlPanelController');
const MenuBadgeController = require('../../../../src/renderer/main/runtime/coordinators/MenuBadgeController');
const TelemetryController = require('../../../../src/renderer/main/runtime/coordinators/TelemetryController');

// ============================================================================
// Helpers
// ============================================================================

function createMockEventBus() {
  const handlers = new Map();
  return {
    on: jest.fn((event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {
        const arr = handlers.get(event);
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx >= 0) arr.splice(idx, 1);
        }
      };
    }),
    off: jest.fn(),
    emit: jest.fn((event, data) => {
      const arr = handlers.get(event);
      if (arr) arr.forEach(h => h(data, { bus: 'test', timestamp: Date.now() }));
    }),
    dispose: jest.fn(),
    _handlers: handlers,
  };
}

function createMockGuru() {
  const listeners = new Map();
  return {
    on: jest.fn((event, handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    }),
    off: jest.fn((event, handler) => {
      const arr = listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    }),
    getStatus: jest.fn(() => 'disconnected'),
    isConnected: jest.fn(() => false),
    connect: jest.fn(),
    disconnect: jest.fn(),
    _listeners: listeners,
  };
}

function createMockEndpoint() {
  return {
    getBackendURL: jest.fn(() => 'http://localhost:4000'),
    getSettings: jest.fn().mockResolvedValue({}),
    setSettings: jest.fn().mockResolvedValue({}),
    getModelCapabilities: jest.fn().mockResolvedValue({}),
    getModels: jest.fn().mockResolvedValue([]),
    post: jest.fn().mockResolvedValue({}),
    get: jest.fn().mockResolvedValue({}),
    listAgentJobs: jest.fn().mockResolvedValue({ jobs: [] }),
    getUnreadEmailCount: jest.fn().mockResolvedValue(0),
  };
}

function createMockElement() {
  return {
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn(), contains: jest.fn() },
    style: {},
    textContent: '',
    innerHTML: '',
    setAttribute: jest.fn(),
    getAttribute: jest.fn(),
    querySelector: jest.fn(() => null),
    querySelectorAll: jest.fn(() => []),
    disabled: false,
    click: jest.fn(),
  };
}

// ============================================================================
// EventBusBridge
// ============================================================================

describe('EventBusBridge', () => {
  let bridge, eventBus;

  beforeEach(() => {
    eventBus = createMockEventBus();
    bridge = new EventBusBridge({
      eventBus,
      elements: { statusMessage: createMockElement() },
      aether: {},
      endpoint: createMockEndpoint(),
      guru: createMockGuru(),
      callbacks: {},
    });
  });

  afterEach(() => {
    bridge.dispose();
  });

  it('should construct with missing dependencies gracefully', () => {
    const minimal = new EventBusBridge({});
    expect(minimal.eventBus).toBeNull();
    expect(minimal._cleanup).toEqual([]);
    minimal.dispose();
  });

  it('should skip bind when EventBus is unavailable', () => {
    const minimal = new EventBusBridge({});
    minimal.bind();
    expect(minimal._cleanup.length).toBe(0);
  });

  it('should register listeners on bind and track cleanup functions', () => {
    bridge.bind();
    expect(bridge._cleanup.length).toBeGreaterThan(0);
    expect(eventBus.on).toHaveBeenCalled();
  });

  it('should remove all listeners on unbind (N = M)', () => {
    bridge.bind();
    const N = bridge._cleanup.length;
    expect(N).toBeGreaterThan(0);

    bridge.unbind();
    expect(bridge._cleanup.length).toBe(0);
  });

  it('should handle double-dispose safely', () => {
    bridge.bind();
    bridge.dispose();
    expect(() => bridge.dispose()).not.toThrow();
    expect(bridge._cleanup.length).toBe(0);
    expect(bridge.eventBus).toBeNull();
  });

  it('should null out all references on dispose', () => {
    bridge.dispose();
    expect(bridge.eventBus).toBeNull();
    expect(bridge.aether).toBeNull();
    expect(bridge.endpoint).toBeNull();
    expect(bridge.guru).toBeNull();
  });
});

// ============================================================================
// GuruConnectionBridge
// ============================================================================

describe('GuruConnectionBridge', () => {
  let bridge, guru, eventBus, endpoint;

  beforeEach(() => {
    guru = createMockGuru();
    eventBus = createMockEventBus();
    endpoint = createMockEndpoint();
    bridge = new GuruConnectionBridge({
      guru,
      endpoint,
      eventBus,
      elements: { connectionDot: createMockElement(), connectionLabel: createMockElement() },
      callbacks: {},
    });
  });

  afterEach(() => {
    bridge.dispose();
  });

  it('should construct with missing guru gracefully', () => {
    const minimal = new GuruConnectionBridge({});
    expect(minimal.guru).toBeNull();
    minimal.dispose();
  });

  it('should skip initialize when guru is unavailable', () => {
    const minimal = new GuruConnectionBridge({});
    minimal.initialize();
    expect(minimal._guruListeners).toEqual([]);
  });

  it('should register guru listeners on initialize', () => {
    bridge.initialize();
    expect(bridge._guruListeners.length).toBeGreaterThan(0);
    expect(guru.on).toHaveBeenCalled();
  });

  it('should remove all guru listeners on dispose (N = M)', () => {
    bridge.initialize();
    const N = bridge._guruListeners.length;
    expect(N).toBeGreaterThan(0);

    bridge.dispose();
    expect(guru.off).toHaveBeenCalledTimes(N);
  });

  it('should handle double-dispose safely', () => {
    bridge.initialize();
    bridge.dispose();
    expect(() => bridge.dispose()).not.toThrow();
  });
});

// ============================================================================
// ControlPanelController
// ============================================================================

describe('ControlPanelController', () => {
  let controller, elements;

  beforeEach(() => {
    elements = {
      settingsBtn: createMockElement(),
      newChatBtn: createMockElement(),
      chatLibraryBtn: createMockElement(),
      mcpBtn: createMockElement(),
      memoryBtn: createMockElement(),
      refreshBtn: createMockElement(),
      handsfreeBtn: createMockElement(),
    };
    controller = new ControlPanelController({
      elements,
      callbacks: {
        openSettings: jest.fn(),
        newChat: jest.fn(),
        openChatLibrary: jest.fn(),
        openMcp: jest.fn(),
        openMemory: jest.fn(),
        refresh: jest.fn(),
        toggleHandsfree: jest.fn(),
      },
    });
  });

  afterEach(() => {
    controller.dispose();
  });

  it('should construct with empty elements gracefully', () => {
    const minimal = new ControlPanelController({});
    expect(minimal._domListeners).toEqual([]);
    minimal.dispose();
  });

  it('should register DOM listeners on initialize', () => {
    controller.initialize();
    expect(controller._domListeners.length).toBeGreaterThan(0);
  });

  it('should remove all DOM listeners on dispose (N = M)', () => {
    controller.initialize();
    const N = controller._domListeners.length;
    expect(N).toBeGreaterThan(0);

    controller.dispose();
    expect(controller._domListeners.length).toBe(0);
  });

  it('should handle double-dispose safely', () => {
    controller.initialize();
    controller.dispose();
    expect(() => controller.dispose()).not.toThrow();
    expect(controller._domListeners.length).toBe(0);
  });
});

// ============================================================================
// MenuBadgeController
// ============================================================================

describe('MenuBadgeController', () => {
  let controller, endpoint;

  beforeEach(() => {
    endpoint = createMockEndpoint();
    controller = new MenuBadgeController({
      endpoint,
      elements: {
        indexBadge: createMockElement(),
        jobsBadge: createMockElement(),
      },
    });
  });

  afterEach(() => {
    controller.dispose();
  });

  it('should construct with missing endpoint gracefully', () => {
    const minimal = new MenuBadgeController({});
    expect(minimal.endpoint).toBeNull();
    minimal.dispose();
  });

  it('should skip polling when endpoint is missing', async () => {
    const minimal = new MenuBadgeController({});
    await minimal.initialize();
    // Should not throw, should log warning
    minimal.dispose();
  });

  it('should null references on dispose', () => {
    controller.dispose();
    expect(controller.endpoint).toBeNull();
    expect(controller._settings).toBeNull();
  });

  it('should handle double-dispose safely', () => {
    controller.dispose();
    expect(() => controller.dispose()).not.toThrow();
  });
});

// ============================================================================
// TelemetryController
// ============================================================================

describe('TelemetryController', () => {
  let controller;

  beforeEach(() => {
    controller = new TelemetryController({
      aether: { telemetry: { trackEvent: jest.fn(), flush: jest.fn() } },
      guru: createMockGuru(),
      endpoint: createMockEndpoint(),
      eventBus: createMockEventBus(),
    });
  });

  afterEach(() => {
    controller.dispose();
  });

  it('should construct with missing dependencies gracefully', () => {
    const minimal = new TelemetryController({});
    expect(minimal.aether).toBeNull();
    expect(minimal.guru).toBeNull();
    minimal.dispose();
  });

  it('should null out references on dispose', () => {
    controller.dispose();
    expect(controller.aether).toBeNull();
    expect(controller.guru).toBeNull();
    expect(controller.endpoint).toBeNull();
  });

  it('should handle double-dispose safely', () => {
    controller.dispose();
    expect(() => controller.dispose()).not.toThrow();
  });
});

// ============================================================================
// Cross-cutting: All coordinators
// ============================================================================

describe('All Coordinators - Lifecycle Contract', () => {
  const coordinatorConfigs = [
    {
      name: 'EventBusBridge',
      create: () => new EventBusBridge({ eventBus: createMockEventBus() }),
    },
    {
      name: 'GuruConnectionBridge',
      create: () => new GuruConnectionBridge({ guru: createMockGuru() }),
    },
    {
      name: 'ControlPanelController',
      create: () => new ControlPanelController({ elements: {} }),
    },
    {
      name: 'MenuBadgeController',
      create: () => new MenuBadgeController({}),
    },
    {
      name: 'TelemetryController',
      create: () => new TelemetryController({}),
    },
  ];

  coordinatorConfigs.forEach(({ name, create }) => {
    it(`${name}: should not throw on construction with minimal deps`, () => {
      expect(() => create()).not.toThrow();
    });

    it(`${name}: should not throw on dispose without initialization`, () => {
      const instance = create();
      expect(() => instance.dispose()).not.toThrow();
    });

    it(`${name}: should not throw on double-dispose`, () => {
      const instance = create();
      instance.dispose();
      expect(() => instance.dispose()).not.toThrow();
    });
  });
});
