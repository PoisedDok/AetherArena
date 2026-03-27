/**
 * Early Jest Setup File
 * ============================================================================
 * This file runs before the test framework is loaded (via setupFiles in jest.config.js).
 * Use it to set up global mocks that need to be available before modules are loaded.
 */

// Mock crypto.randomUUID for Node.js environments that don't have it
// This runs BEFORE test files are loaded, so modules that use crypto.randomUUID
// at the top level will see this mock.
let uuidCounter = 0;
const mockRandomUUID = () => {
  uuidCounter += 1;
  // Generate valid UUID format (8-4-4-4-12 hex pattern) that tests expect
  const counter = uuidCounter.toString(16).padStart(8, '0');
  return `${counter}-1234-1234-1234-${counter.toString().padStart(12, '0')}`;
};

// Polyfill globalThis
if (typeof global.globalThis === 'undefined') {
  global.globalThis = global;
}

// Set up crypto on globalThis (most code uses globalThis.crypto)
if (!global.globalThis.crypto) {
  global.globalThis.crypto = {
    randomUUID: mockRandomUUID,
  };
} else if (!global.globalThis.crypto.randomUUID) {
  global.globalThis.crypto.randomUUID = mockRandomUUID;
}

// Also set up on global for backwards compatibility
if (!global.crypto) {
  global.crypto = global.globalThis.crypto;
} else if (!global.crypto.randomUUID) {
  global.crypto.randomUUID = mockRandomUUID;
}

console.log('[Jest Early Setup] crypto.randomUUID mocked on globalThis and global');

// Mock Performance API for Node.js environment
// Make getEntriesByType writable so tests can mock it
if (typeof global.performance !== 'undefined') {
  const originalGetEntriesByType = global.performance.getEntriesByType;
  Object.defineProperty(global.performance, 'getEntriesByType', {
    value: originalGetEntriesByType,
    writable: true,
    configurable: true,
  });
  
  // Also mock mark and measure if they don't exist
  if (!global.performance.mark) {
    global.performance.mark = jest.fn();
  }
  if (!global.performance.measure) {
    global.performance.measure = jest.fn();
  }
  if (!global.performance.now) {
    global.performance.now = () => Date.now();
  }
  
  console.log('[Jest Early Setup] Performance API mocked for Node.js');
}
