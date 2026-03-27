'use strict';

/**
 * port-resolver Unit Tests
 * ============================================================================
 * Tests getBackendUrl (no portManager, healthy service, fallback, contract
 * violation), getServiceUrl, getBackendWsUrl (http->ws, https->wss, null),
 * isServiceHealthy, getAllServices, clearCache.
 *
 * getPortManager() returns null in Node (no Electron). PortManager-available
 * paths tested via jest.isolateModules with assertions INSIDE the block.
 *
 * @module tests/unit/core/config/port-resolver.test
 */

describe('port-resolver', () => {

  afterEach(() => {
    delete process.versions.electron;
    delete process.type;
  });

  // =========================================================================
  // No PortManager (standard Node env -- process.versions.electron absent)
  // =========================================================================

  describe('getBackendUrl (no PortManager)', () => {
    it('returns the provided default URL', () => {
      jest.isolateModules(() => {
        const pr = require('../../../../src/core/config/port-resolver');
        expect(pr.getBackendUrl('http://127.0.0.1:8765')).toBe('http://127.0.0.1:8765');
      });
    });

    it('returns DEFAULTS.backend.baseUrl when no argument', () => {
      jest.isolateModules(() => {
        const pr = require('../../../../src/core/config/port-resolver');
        const url = pr.getBackendUrl();
        expect(url).toMatch(/^https?:\/\//);
      });
    });

    it('throws CONTRACT VIOLATION for empty string', () => {
      jest.isolateModules(() => {
        const pr = require('../../../../src/core/config/port-resolver');
        expect(() => pr.getBackendUrl('')).toThrow('CONTRACT VIOLATION');
      });
    });

    it('throws CONTRACT VIOLATION for null', () => {
      jest.isolateModules(() => {
        const pr = require('../../../../src/core/config/port-resolver');
        expect(() => pr.getBackendUrl(null)).toThrow('CONTRACT VIOLATION');
      });
    });

    it('throws CONTRACT VIOLATION for whitespace-only', () => {
      jest.isolateModules(() => {
        const pr = require('../../../../src/core/config/port-resolver');
        expect(() => pr.getBackendUrl('   ')).toThrow('CONTRACT VIOLATION');
      });
    });
  });

  // =========================================================================
  // getBackendUrl WITH PortManager (mocked Electron main process)
  // =========================================================================

  describe('getBackendUrl (with PortManager)', () => {
    it('returns discovered URL when service is healthy', () => {
      jest.isolateModules(() => {
        jest.mock('../../../../src/main/services/PortManager', () => ({
          getManager: () => ({
            getService: () => ({ healthy: true, url: 'http://discovered:9000' }),
            getServiceUrl: jest.fn(),
          }),
        }));
        process.versions.electron = '28.0.0';
        process.type = 'browser';
        const pr = require('../../../../src/core/config/port-resolver');
        expect(pr.getBackendUrl('http://default:8765')).toBe('http://discovered:9000');
      });
    });

    it('falls through to getServiceUrl when service not healthy', () => {
      jest.isolateModules(() => {
        const mockServiceUrl = jest.fn(() => 'http://serviceurl:8765');
        jest.mock('../../../../src/main/services/PortManager', () => ({
          getManager: () => ({
            getService: () => ({ healthy: false }),
            getServiceUrl: mockServiceUrl,
          }),
        }));
        process.versions.electron = '28.0.0';
        process.type = 'browser';
        const pr = require('../../../../src/core/config/port-resolver');
        expect(pr.getBackendUrl('http://default:8765')).toBe('http://serviceurl:8765');
        expect(mockServiceUrl).toHaveBeenCalledWith('backend', 'http://default:8765');
      });
    });

    it('falls through when getService returns null', () => {
      jest.isolateModules(() => {
        jest.mock('../../../../src/main/services/PortManager', () => ({
          getManager: () => ({
            getService: () => null,
            getServiceUrl: () => 'http://fallback:8765',
          }),
        }));
        process.versions.electron = '28.0.0';
        process.type = 'browser';
        const pr = require('../../../../src/core/config/port-resolver');
        expect(pr.getBackendUrl('http://default:8765')).toBe('http://fallback:8765');
      });
    });

    it('falls through when getService throws', () => {
      jest.isolateModules(() => {
        jest.mock('../../../../src/main/services/PortManager', () => ({
          getManager: () => ({
            getService: () => { throw new Error('fail'); },
            getServiceUrl: () => 'http://safe:8765',
          }),
        }));
        process.versions.electron = '28.0.0';
        process.type = 'browser';
        const pr = require('../../../../src/core/config/port-resolver');
        expect(pr.getBackendUrl('http://default:8765')).toBe('http://safe:8765');
      });
    });
  });

  // =========================================================================
  // getServiceUrl
  // =========================================================================

  describe('getServiceUrl', () => {
    it('delegates to portManager when available', () => {
      jest.isolateModules(() => {
        const mockServiceUrl = jest.fn(() => 'http://svc:3000');
        jest.mock('../../../../src/main/services/PortManager', () => ({
          getManager: () => ({
            getService: jest.fn(),
            getServiceUrl: mockServiceUrl,
          }),
        }));
        process.versions.electron = '28.0.0';
        process.type = 'browser';
        const pr = require('../../../../src/core/config/port-resolver');
        expect(pr.getServiceUrl('perplexica', 'http://def:3000')).toBe('http://svc:3000');
        expect(mockServiceUrl).toHaveBeenCalledWith('perplexica', 'http://def:3000');
      });
    });

    it('returns default when no portManager', () => {
      jest.isolateModules(() => {
        const pr = require('../../../../src/core/config/port-resolver');
        expect(pr.getServiceUrl('perplexica', 'http://def:3000')).toBe('http://def:3000');
      });
    });
  });

  // =========================================================================
  // getBackendWsUrl
  // =========================================================================

  describe('getBackendWsUrl', () => {
    it('converts http:// to ws://', () => {
      jest.isolateModules(() => {
        const pr = require('../../../../src/core/config/port-resolver');
        expect(pr.getBackendWsUrl('http://localhost:8765')).toBe('ws://localhost:8765');
      });
    });

    it('converts https:// to wss://', () => {
      jest.isolateModules(() => {
        const pr = require('../../../../src/core/config/port-resolver');
        expect(pr.getBackendWsUrl('https://example.com')).toBe('wss://example.com');
      });
    });

    it('throws for null input', () => {
      jest.isolateModules(() => {
        const pr = require('../../../../src/core/config/port-resolver');
        expect(() => pr.getBackendWsUrl(null)).toThrow('CONTRACT VIOLATION');
      });
    });

    it('throws for empty string', () => {
      jest.isolateModules(() => {
        const pr = require('../../../../src/core/config/port-resolver');
        expect(() => pr.getBackendWsUrl('')).toThrow('CONTRACT VIOLATION');
      });
    });

    it('throws for undefined', () => {
      jest.isolateModules(() => {
        const pr = require('../../../../src/core/config/port-resolver');
        expect(() => pr.getBackendWsUrl(undefined)).toThrow('CONTRACT VIOLATION');
      });
    });
  });

  // =========================================================================
  // isServiceHealthy
  // =========================================================================

  describe('isServiceHealthy', () => {
    it('returns true when service is healthy', () => {
      jest.isolateModules(() => {
        jest.mock('../../../../src/main/services/PortManager', () => ({
          getManager: () => ({
            getService: () => ({ healthy: true }),
            getServiceUrl: jest.fn(),
          }),
        }));
        process.versions.electron = '28.0.0';
        process.type = 'browser';
        const pr = require('../../../../src/core/config/port-resolver');
        expect(pr.isServiceHealthy('backend')).toBe(true);
      });
    });

    it('returns false when service is not healthy', () => {
      jest.isolateModules(() => {
        jest.mock('../../../../src/main/services/PortManager', () => ({
          getManager: () => ({
            getService: () => ({ healthy: false }),
            getServiceUrl: jest.fn(),
          }),
        }));
        process.versions.electron = '28.0.0';
        process.type = 'browser';
        const pr = require('../../../../src/core/config/port-resolver');
        expect(pr.isServiceHealthy('backend')).toBe(false);
      });
    });

    it('returns false when service not found', () => {
      jest.isolateModules(() => {
        jest.mock('../../../../src/main/services/PortManager', () => ({
          getManager: () => ({
            getService: () => null,
            getServiceUrl: jest.fn(),
          }),
        }));
        process.versions.electron = '28.0.0';
        process.type = 'browser';
        const pr = require('../../../../src/core/config/port-resolver');
        expect(pr.isServiceHealthy('unknown')).toBe(false);
      });
    });

    it('returns false when no portManager', () => {
      jest.isolateModules(() => {
        const pr = require('../../../../src/core/config/port-resolver');
        expect(pr.isServiceHealthy('backend')).toBe(false);
      });
    });
  });

  // =========================================================================
  // getAllServices
  // =========================================================================

  describe('getAllServices', () => {
    it('returns services from portManager', () => {
      jest.isolateModules(() => {
        const services = [{ name: 'backend', url: 'http://x', healthy: true }];
        jest.mock('../../../../src/main/services/PortManager', () => ({
          getManager: () => ({
            getService: jest.fn(),
            getServiceUrl: jest.fn(),
            getHealthyServices: () => services,
          }),
        }));
        process.versions.electron = '28.0.0';
        process.type = 'browser';
        const pr = require('../../../../src/core/config/port-resolver');
        expect(pr.getAllServices()).toEqual(services);
      });
    });

    it('returns empty array when no portManager', () => {
      jest.isolateModules(() => {
        const pr = require('../../../../src/core/config/port-resolver');
        expect(pr.getAllServices()).toEqual([]);
      });
    });
  });

  // =========================================================================
  // clearCache
  // =========================================================================

  describe('clearCache', () => {
    it('exported and callable', () => {
      jest.isolateModules(() => {
        const pr = require('../../../../src/core/config/port-resolver');
        expect(typeof pr.clearCache).toBe('function');
        pr.clearCache(); // should not throw
      });
    });
  });
});
