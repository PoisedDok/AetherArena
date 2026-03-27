'use strict';

/**
 * ProfileManager Unit Tests
 * ============================================================================
 * Tests profile management: refresh from backend, set current profile,
 * profile search, defaults, event emission, error handling, and cleanup.
 *
 * @module tests/unit/application/ProfileManager.test
 */

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

const ProfileManager = require('../../../src/application/main/modules/profiles/ProfileManager');
const { EventTypes } = require('../../../src/core/events/EventTypes');

function createMockEndpoint() {
  return {
    getProfiles: jest.fn().mockResolvedValue({ profiles: ['alpha.py', 'beta.py', 'gamma.py'] }),
    setSettings: jest.fn().mockResolvedValue({}),
  };
}

function createMockEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

describe('ProfileManager', () => {
  let manager;
  let endpoint;
  let eventBus;

  beforeEach(() => {
    endpoint = createMockEndpoint();
    eventBus = createMockEventBus();
    manager = new ProfileManager({ endpoint, eventBus });
  });

  afterEach(() => {
    if (manager) manager.dispose();
  });

  // -----------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------
  describe('constructor', () => {
    it('throws when endpoint not provided', () => {
      expect(() => new ProfileManager({ eventBus })).toThrow('endpoint required');
    });

    it('throws when eventBus not provided', () => {
      expect(() => new ProfileManager({ endpoint })).toThrow('eventBus required');
    });

    it('initializes with empty profiles and null current', () => {
      expect(manager.getProfiles()).toEqual([]);
      expect(manager.getCurrentProfile()).toBeNull();
    });
  });

  // -----------------------------------------------------------
  // refreshProfileList
  // -----------------------------------------------------------
  describe('refreshProfileList()', () => {
    it('fetches profiles from endpoint and stores sorted', async () => {
      const profiles = await manager.refreshProfileList();
      expect(endpoint.getProfiles).toHaveBeenCalled();
      expect(profiles).toEqual(['alpha.py', 'beta.py', 'gamma.py']);
      expect(manager.getProfiles()).toEqual(['alpha.py', 'beta.py', 'gamma.py']);
    });

    it('sorts profiles alphabetically', async () => {
      endpoint.getProfiles.mockResolvedValue({ profiles: ['zebra.py', 'alpha.py', 'middle.py'] });
      const profiles = await manager.refreshProfileList();
      expect(profiles).toEqual(['alpha.py', 'middle.py', 'zebra.py']);
    });

    it('converts profile entries to strings', async () => {
      endpoint.getProfiles.mockResolvedValue({ profiles: [123, null, 'real.py'] });
      const profiles = await manager.refreshProfileList();
      expect(profiles.every(p => typeof p === 'string')).toBe(true);
    });

    it('handles missing profiles array in response', async () => {
      endpoint.getProfiles.mockResolvedValue({});
      const profiles = await manager.refreshProfileList();
      expect(profiles).toEqual([]);
    });

    it('handles null response gracefully', async () => {
      endpoint.getProfiles.mockResolvedValue(null);
      const profiles = await manager.refreshProfileList();
      expect(profiles).toEqual([]);
    });

    it('emits PROFILE.LIST_UPDATED event', async () => {
      await manager.refreshProfileList();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.PROFILE.LIST_UPDATED,
        expect.objectContaining({
          profiles: expect.any(Array),
          count: 3,
          timestamp: expect.any(Number),
        })
      );
    });

    it('returns empty array on endpoint failure', async () => {
      endpoint.getProfiles.mockRejectedValue(new Error('network error'));
      const profiles = await manager.refreshProfileList();
      expect(profiles).toEqual([]);
    });
  });

  // -----------------------------------------------------------
  // setCurrentProfile
  // -----------------------------------------------------------
  describe('setCurrentProfile()', () => {
    it('persists selection to backend and updates state', async () => {
      const result = await manager.setCurrentProfile('alpha.py');
      expect(result).toBe(true);
      expect(manager.getCurrentProfile()).toBe('alpha.py');
      expect(endpoint.setSettings).toHaveBeenCalledWith({
        interpreter: { profile: 'alpha.py' },
      });
    });

    it('emits PROFILE.CHANGED event with previous profile', async () => {
      await manager.setCurrentProfile('alpha.py');
      eventBus.emit.mockClear();

      await manager.setCurrentProfile('beta.py');
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.PROFILE.CHANGED,
        expect.objectContaining({
          profile: 'beta.py',
          previousProfile: 'alpha.py',
          timestamp: expect.any(Number),
        }),
        expect.any(Object)
      );
    });

    it('returns false for empty/null profile name', async () => {
      expect(await manager.setCurrentProfile('')).toBe(false);
      expect(await manager.setCurrentProfile(null)).toBe(false);
      expect(await manager.setCurrentProfile(undefined)).toBe(false);
    });

    it('returns false on endpoint failure', async () => {
      endpoint.setSettings.mockRejectedValue(new Error('save failed'));
      const result = await manager.setCurrentProfile('alpha.py');
      expect(result).toBe(false);
      // State should NOT have been updated
      expect(manager.getCurrentProfile()).toBeNull();
    });
  });

  // -----------------------------------------------------------
  // Query methods
  // -----------------------------------------------------------
  describe('hasProfile()', () => {
    it('returns true for existing profile', async () => {
      await manager.refreshProfileList();
      expect(manager.hasProfile('alpha.py')).toBe(true);
    });

    it('returns false for non-existent profile', async () => {
      await manager.refreshProfileList();
      expect(manager.hasProfile('nonexistent.py')).toBe(false);
    });
  });

  describe('getDefaultProfile()', () => {
    it('returns first profile when available', async () => {
      await manager.refreshProfileList();
      expect(manager.getDefaultProfile()).toBe('alpha.py');
    });

    it('returns GURU.py fallback when no profiles', () => {
      expect(manager.getDefaultProfile()).toBe('GURU.py');
    });
  });

  describe('searchProfiles()', () => {
    beforeEach(async () => {
      await manager.refreshProfileList();
    });

    it('returns matching profiles (case-insensitive)', () => {
      const results = manager.searchProfiles('ALPHA');
      expect(results).toEqual(['alpha.py']);
    });

    it('returns all profiles for empty keyword', () => {
      const results = manager.searchProfiles('');
      expect(results).toEqual(['alpha.py', 'beta.py', 'gamma.py']);
    });

    it('returns all profiles for null keyword', () => {
      const results = manager.searchProfiles(null);
      expect(results).toEqual(['alpha.py', 'beta.py', 'gamma.py']);
    });

    it('returns empty array when no matches', () => {
      const results = manager.searchProfiles('nonexistent');
      expect(results).toEqual([]);
    });
  });

  // -----------------------------------------------------------
  // Statistics
  // -----------------------------------------------------------
  describe('getStats()', () => {
    it('returns frozen stats object', async () => {
      await manager.refreshProfileList();
      await manager.setCurrentProfile('beta.py');
      const stats = manager.getStats();
      expect(Object.isFrozen(stats)).toBe(true);
      expect(stats.totalProfiles).toBe(3);
      expect(stats.currentProfile).toBe('beta.py');
      expect(stats.hasProfiles).toBe(true);
    });

    it('reports no profiles initially', () => {
      const stats = manager.getStats();
      expect(stats.totalProfiles).toBe(0);
      expect(stats.hasProfiles).toBe(false);
    });
  });

  // -----------------------------------------------------------
  // dispose
  // -----------------------------------------------------------
  describe('dispose()', () => {
    it('clears all state and references', async () => {
      await manager.refreshProfileList();
      await manager.setCurrentProfile('alpha.py');
      manager.dispose();
      expect(manager.getProfiles()).toEqual([]);
      expect(manager.getCurrentProfile()).toBeNull();
      expect(manager.endpoint).toBeNull();
      expect(manager.eventBus).toBeNull();
    });

    it('is safe to call twice', () => {
      expect(() => {
        manager.dispose();
        manager.dispose();
      }).not.toThrow();
      manager = null;
    });
  });

  // -----------------------------------------------------------
  // enableLogging branches
  // -----------------------------------------------------------
  describe('enableLogging branches', () => {
    let logManager;
    let logEndpoint;
    let logEventBus;

    beforeEach(() => {
      logEndpoint = createMockEndpoint();
      logEventBus = createMockEventBus();
      logManager = new ProfileManager({
        endpoint: logEndpoint,
        eventBus: logEventBus,
        enableLogging: true,
      });
    });

    afterEach(() => {
      if (logManager) logManager.dispose();
    });

    it('logs during refreshProfileList', async () => {
      await logManager.refreshProfileList();
      // Covers lines 57, 73
    });

    it('logs during setCurrentProfile', async () => {
      await logManager.setCurrentProfile('alpha.py');
      // Covers lines 95, 118
    });

    it('logs during dispose', () => {
      logManager.dispose();
      // Covers line 198
      logManager = null;
    });
  });

  // -----------------------------------------------------------
  // window global export
  // -----------------------------------------------------------
  describe('window global export', () => {
    it('attaches ProfileManager to window when window exists', () => {
      jest.isolateModules(() => {
        global.window = {};
        jest.mock('../../../src/renderer/shared/utils/logger', () => ({
          createRendererLogger: () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(),
            debug: jest.fn(), trace: jest.fn(),
          }),
        }));
        const PM = require('../../../src/application/main/modules/profiles/ProfileManager');
        expect(global.window.ProfileManager).toBe(PM);
        delete global.window;
      });
    });
  });
});
