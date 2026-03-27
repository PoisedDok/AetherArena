'use strict';

const { resolveStorageAPI } = require('../../../src/shared/utils/storage-resolver');

describe('resolveStorageAPI', () => {
  const originalAether = global.aether;
  const originalStorageAPI = global.storageAPI;

  afterEach(() => {
    delete global.aether;
    delete global.storageAPI;
  });

  afterAll(() => {
    if (typeof originalAether !== 'undefined') {
      global.aether = originalAether;
    } else {
      delete global.aether;
    }

    if (typeof originalStorageAPI !== 'undefined') {
      global.storageAPI = originalStorageAPI;
    } else {
      delete global.storageAPI;
    }
  });

  test('returns explicit storageAPI from options when provided', () => {
    const explicit = { id: 'explicit-storage' };
    expect(resolveStorageAPI({ storageAPI: explicit })).toBe(explicit);
  });

  test('prefers aether.storage over other globals', () => {
    const expected = { id: 'bridge-storage' };
    global.aether = { storage: expected, storageAPI: { id: 'legacy' } };
    global.storageAPI = { id: 'fallback' };

    expect(resolveStorageAPI()).toBe(expected);
  });

  test('falls back to aether.storageAPI when storage absent', () => {
    const expected = { id: 'legacy-storage' };
    global.aether = { storageAPI: expected };
    delete global.storageAPI;

    expect(resolveStorageAPI()).toBe(expected);
  });

  test('falls back to global storageAPI when no aether bridge present', () => {
    const expected = { id: 'global-storage' };
    delete global.aether;
    global.storageAPI = expected;

    expect(resolveStorageAPI()).toBe(expected);
  });

  test('returns null when no storage implementations are available', () => {
    delete global.aether;
    delete global.storageAPI;

    expect(resolveStorageAPI()).toBeNull();
  });
});


