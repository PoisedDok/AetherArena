/**
 * Jest Setup File
 * ============================================================================
 * Global setup for Jest tests:
 * - Extended matchers
 * - Global mocks
 * - Test utilities
 * - Environment setup
 * 
 * @module tests/helpers/setup
 */

// Increase test timeout for integration tests
jest.setTimeout(10000);

// Mock console methods to reduce noise (can be overridden per test)
global.console = {
  ...console,
  // Uncomment to suppress logs during tests
  // log: jest.fn(),
  // debug: jest.fn(),
  // info: jest.fn(),
  // warn: jest.fn(),
  // error: jest.fn(),
};

// Mock crypto.randomUUID for Node.js environments that don't have it
// (needed for tests running in CI with older Node or JSDOM environment)
const mockRandomUUID = () => 'test-uuid-12345678-1234-1234-1234-123456789012';

// For Node.js environment
if (typeof global !== 'undefined') {
  if (!global.crypto) {
    global.crypto = {
      randomUUID: mockRandomUUID,
    };
  } else if (!global.crypto.randomUUID) {
    global.crypto.randomUUID = mockRandomUUID;
  }
}

// For JSDOM environment
if (typeof window !== 'undefined' && window.crypto) {
  if (!window.crypto.randomUUID) {
    window.crypto.randomUUID = mockRandomUUID;
  }
}

// Mock Electron modules (for unit tests)
if (!process.env.E2E_TEST) {
  jest.mock('electron', () => ({
    app: {
      on: jest.fn(),
      whenReady: jest.fn(() => Promise.resolve()),
      quit: jest.fn(),
      getPath: jest.fn(() => '/tmp/aether-test'),
    },
    BrowserWindow: jest.fn(),
    ipcMain: {
      on: jest.fn(),
      handle: jest.fn(),
      removeHandler: jest.fn(),
    },
    ipcRenderer: {
      send: jest.fn(),
      invoke: jest.fn(),
      on: jest.fn(),
    },
    shell: {
      openExternal: jest.fn(),
    },
    session: {
      defaultSession: {
        webRequest: {
          onHeadersReceived: jest.fn(),
          onBeforeRequest: jest.fn(),
        },
      },
    },
  }), { virtual: true });
}

// Custom matchers
expect.extend({
  /**
   * Check if value is within range
   */
  toBeWithinRange(received, min, max) {
    const pass = received >= min && received <= max;
    return {
      pass,
      message: () => 
        pass
          ? `Expected ${received} not to be within range ${min} - ${max}`
          : `Expected ${received} to be within range ${min} - ${max}`,
    };
  },
  
  /**
   * Check if value is frozen (Object.freeze)
   */
  toBeFrozen(received) {
    const pass = Object.isFrozen(received);
    return {
      pass,
      message: () =>
        pass
          ? `Expected object not to be frozen`
          : `Expected object to be frozen`,
    };
  },
  
  /**
   * Check if function is async
   */
  toBeAsync(received) {
    const pass = received.constructor.name === 'AsyncFunction';
    return {
      pass,
      message: () =>
        pass
          ? `Expected function not to be async`
          : `Expected function to be async`,
    };
  },
  
  /**
   * Check if string is valid URL
   */
  toBeValidUrl(received) {
    let pass = false;
    try {
      new URL(received);
      pass = true;
    } catch {}
    
    return {
      pass,
      message: () =>
        pass
          ? `Expected "${received}" not to be a valid URL`
          : `Expected "${received}" to be a valid URL`,
    };
  },
  
  /**
   * Check if value is valid UUID
   */
  toBeValidUuid(received) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const pass = uuidRegex.test(received);
    
    return {
      pass,
      message: () =>
        pass
          ? `Expected "${received}" not to be a valid UUID`
          : `Expected "${received}" to be a valid UUID`,
    };
  },
});

// Global test helpers
global.createMockLogger = () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(function() { return this; }),
  flush: jest.fn(() => Promise.resolve()),
});

global.createMockEventBus = () => ({
  emit: jest.fn(),
  on: jest.fn(() => jest.fn()),
  off: jest.fn(),
  once: jest.fn(() => jest.fn()),
  removeAllListeners: jest.fn(),
});

global.createMockWindow = () => ({
  id: 1,
  webContents: {
    send: jest.fn(),
    on: jest.fn(),
    session: {
      webRequest: {
        onHeadersReceived: jest.fn(),
        onBeforeRequest: jest.fn(),
      },
    },
  },
  on: jest.fn(),
  once: jest.fn(),
  loadFile: jest.fn(() => Promise.resolve()),
  show: jest.fn(),
  hide: jest.fn(),
  close: jest.fn(),
  isDestroyed: jest.fn(() => false),
});

global.sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

global.waitFor = async (condition, timeout = 5000, interval = 100) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) {
      return true;
    }
    await sleep(interval);
  }
  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
};

// Setup environment variables for tests
process.env.NODE_ENV = 'test';
process.env.ELECTRON_DEV = 'false';

// Mock HTMLDialogElement for JSDOM
if (typeof window !== 'undefined') {
  window.HTMLDialogElement = window.HTMLDialogElement || class HTMLDialogElement extends HTMLElement {};
  if (!window.HTMLDialogElement.prototype.showModal) {
    window.HTMLDialogElement.prototype.showModal = jest.fn(function() {
      this.open = true;
    });
  }
  if (!window.HTMLDialogElement.prototype.close) {
    window.HTMLDialogElement.prototype.close = jest.fn(function(returnValue) {
      this.open = false;
      this.returnValue = returnValue;
      this.dispatchEvent(new Event('close'));
    });
  }
  
  // JSDOM creates <dialog> as HTMLUnknownElement or HTMLElement
  if (typeof window.HTMLUnknownElement !== 'undefined') {
    window.HTMLUnknownElement.prototype.showModal = window.HTMLDialogElement.prototype.showModal;
    window.HTMLUnknownElement.prototype.close = window.HTMLDialogElement.prototype.close;
  }
  if (typeof window.HTMLElement !== 'undefined') {
    if (!window.HTMLElement.prototype.showModal) {
      window.HTMLElement.prototype.showModal = window.HTMLDialogElement.prototype.showModal;
    }
    if (!window.HTMLElement.prototype.close) {
      window.HTMLElement.prototype.close = window.HTMLDialogElement.prototype.close;
    }
  }
}

console.log('✅ Jest setup complete');


