'use strict';

// ============================================================================
// Platform factory tests — container.js, endpoint.js, eventBus.js
// Each factory is a thin wrapper around a core module with defaults/validation.
// ============================================================================

// ============================================================================
// Mocks — core modules that factories wrap
// ============================================================================

jest.mock('../../../src/core/di/Container', () => {
  const MockDependencyContainer = jest.fn();
  return { DependencyContainer: MockDependencyContainer };
});

jest.mock('../../../src/core/communication/Endpoint', () => {
  return jest.fn();
});

jest.mock('../../../src/core/events/EventBus', () => {
  return jest.fn();
});

jest.mock('../../../src/core/events/EventTypes', () => ({
  EventTypes: { CHAT_SEND: 'chat:send', SYSTEM_ERROR: 'system:error' },
  EventPriority: { HIGH: 'high', NORMAL: 'normal', LOW: 'low' },
}));

// ============================================================================
// References
// ============================================================================

const { DependencyContainer } = require('../../../src/core/di/Container');
const Endpoint = require('../../../src/core/communication/Endpoint');
const EventBus = require('../../../src/core/events/EventBus');
const { EventTypes, EventPriority } = require('../../../src/core/events/EventTypes');

const {
  createRendererContainer,
  RendererContainer,
} = require('../../../src/renderer/shared/platform/container');

const {
  createRendererEndpoint,
  RendererEndpoint,
} = require('../../../src/renderer/shared/platform/endpoint');

const {
  createRendererEventBus,
  RendererEventBus,
  RendererEventTypes,
  RendererEventPriority,
} = require('../../../src/renderer/shared/platform/eventBus');

// ============================================================================
// createRendererContainer
// ============================================================================

describe('createRendererContainer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates DependencyContainer with default name "renderer"', () => {
    createRendererContainer();
    expect(DependencyContainer).toHaveBeenCalledTimes(1);
    expect(DependencyContainer).toHaveBeenCalledWith({
      name: 'renderer',
      enableLogging: false,
    });
  });

  it('passes custom name option', () => {
    createRendererContainer({ name: 'artifacts' });
    expect(DependencyContainer).toHaveBeenCalledWith({
      name: 'artifacts',
      enableLogging: false,
    });
  });

  it('enables logging only when explicitly true', () => {
    createRendererContainer({ enableLogging: true });
    expect(DependencyContainer).toHaveBeenCalledWith({
      name: 'renderer',
      enableLogging: true,
    });
  });

  it('disables logging for truthy non-boolean values (strict === true check)', () => {
    createRendererContainer({ enableLogging: 'yes' });
    expect(DependencyContainer).toHaveBeenCalledWith({
      name: 'renderer',
      enableLogging: false,
    });
  });

  it('disables logging for numeric 1 (strict === true check)', () => {
    createRendererContainer({ enableLogging: 1 });
    expect(DependencyContainer).toHaveBeenCalledWith({
      name: 'renderer',
      enableLogging: false,
    });
  });

  it('returns a DependencyContainer instance', () => {
    const container = createRendererContainer();
    expect(container).toBeInstanceOf(DependencyContainer);
  });

  it('exports RendererContainer as DependencyContainer class', () => {
    expect(RendererContainer).toBe(DependencyContainer);
  });
});

// ============================================================================
// createRendererEndpoint
// ============================================================================

describe('createRendererEndpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates Endpoint with valid config', () => {
    const config = { API_BASE_URL: 'http://api.test', WS_URL: 'ws://ws.test' };
    createRendererEndpoint(config);
    expect(Endpoint).toHaveBeenCalledTimes(1);
    expect(Endpoint).toHaveBeenCalledWith(config);
  });

  it('passes additional config properties through', () => {
    const config = { API_BASE_URL: 'http://api.test', WS_URL: 'ws://ws.test', timeout: 5000 };
    createRendererEndpoint(config);
    expect(Endpoint).toHaveBeenCalledWith(config);
  });

  it('returns an Endpoint instance', () => {
    const config = { API_BASE_URL: 'http://api.test', WS_URL: 'ws://ws.test' };
    const endpoint = createRendererEndpoint(config);
    expect(endpoint).toBeInstanceOf(Endpoint);
  });

  it('throws when API_BASE_URL is missing', () => {
    expect(() => createRendererEndpoint({ WS_URL: 'ws://ws.test' }))
      .toThrow('[RendererEndpoint] API_BASE_URL and WS_URL are required');
  });

  it('throws when WS_URL is missing', () => {
    expect(() => createRendererEndpoint({ API_BASE_URL: 'http://api.test' }))
      .toThrow('[RendererEndpoint] API_BASE_URL and WS_URL are required');
  });

  it('throws when both are missing (empty config)', () => {
    expect(() => createRendererEndpoint({}))
      .toThrow('[RendererEndpoint] API_BASE_URL and WS_URL are required');
  });

  it('throws when called with no arguments (defaults to empty config)', () => {
    expect(() => createRendererEndpoint())
      .toThrow('[RendererEndpoint] API_BASE_URL and WS_URL are required');
  });

  it('throws Error instance with correct message', () => {
    let caught;
    try { createRendererEndpoint(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe('[RendererEndpoint] API_BASE_URL and WS_URL are required');
  });

  it('does not construct Endpoint when validation fails', () => {
    try { createRendererEndpoint({}); } catch (_) { /* expected */ }
    expect(Endpoint).not.toHaveBeenCalled();
  });

  it('treats empty string API_BASE_URL as missing (falsy)', () => {
    expect(() => createRendererEndpoint({ API_BASE_URL: '', WS_URL: 'ws://ws.test' }))
      .toThrow('[RendererEndpoint] API_BASE_URL and WS_URL are required');
  });

  it('treats empty string WS_URL as missing (falsy)', () => {
    expect(() => createRendererEndpoint({ API_BASE_URL: 'http://api.test', WS_URL: '' }))
      .toThrow('[RendererEndpoint] API_BASE_URL and WS_URL are required');
  });

  it('exports RendererEndpoint as Endpoint class', () => {
    expect(RendererEndpoint).toBe(Endpoint);
  });
});

// ============================================================================
// createRendererEventBus
// ============================================================================

describe('createRendererEventBus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates EventBus with default options', () => {
    createRendererEventBus();
    expect(EventBus).toHaveBeenCalledTimes(1);
    expect(EventBus).toHaveBeenCalledWith({
      name: 'renderer',
      maxListeners: 50,
      enableLogging: false,
    });
  });

  it('passes custom name', () => {
    createRendererEventBus({ name: 'chat-bus' });
    expect(EventBus).toHaveBeenCalledWith({
      name: 'chat-bus',
      maxListeners: 50,
      enableLogging: false,
    });
  });

  it('passes custom maxListeners', () => {
    createRendererEventBus({ maxListeners: 100 });
    expect(EventBus).toHaveBeenCalledWith({
      name: 'renderer',
      maxListeners: 100,
      enableLogging: false,
    });
  });

  it('preserves maxListeners=0 via nullish coalescing (not falsy default)', () => {
    createRendererEventBus({ maxListeners: 0 });
    expect(EventBus).toHaveBeenCalledWith({
      name: 'renderer',
      maxListeners: 0,
      enableLogging: false,
    });
  });

  it('uses default maxListeners=50 for null', () => {
    createRendererEventBus({ maxListeners: null });
    expect(EventBus).toHaveBeenCalledWith({
      name: 'renderer',
      maxListeners: 50,
      enableLogging: false,
    });
  });

  it('uses default maxListeners=50 for undefined', () => {
    createRendererEventBus({ maxListeners: undefined });
    expect(EventBus).toHaveBeenCalledWith({
      name: 'renderer',
      maxListeners: 50,
      enableLogging: false,
    });
  });

  it('enables logging only when explicitly true', () => {
    createRendererEventBus({ enableLogging: true });
    expect(EventBus).toHaveBeenCalledWith({
      name: 'renderer',
      maxListeners: 50,
      enableLogging: true,
    });
  });

  it('disables logging for truthy non-boolean values (strict === true)', () => {
    createRendererEventBus({ enableLogging: 1 });
    expect(EventBus).toHaveBeenCalledWith({
      name: 'renderer',
      maxListeners: 50,
      enableLogging: false,
    });
  });

  it('returns an EventBus instance', () => {
    const bus = createRendererEventBus();
    expect(bus).toBeInstanceOf(EventBus);
  });

  it('exports RendererEventBus as EventBus class', () => {
    expect(RendererEventBus).toBe(EventBus);
  });

  it('exports RendererEventTypes from core EventTypes', () => {
    expect(RendererEventTypes).toBe(EventTypes);
    expect(RendererEventTypes).toEqual({ CHAT_SEND: 'chat:send', SYSTEM_ERROR: 'system:error' });
  });

  it('exports RendererEventPriority from core EventPriority', () => {
    expect(RendererEventPriority).toBe(EventPriority);
    expect(RendererEventPriority).toEqual({ HIGH: 'high', NORMAL: 'normal', LOW: 'low' });
  });
});
