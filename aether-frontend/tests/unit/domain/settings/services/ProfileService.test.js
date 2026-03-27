'use strict';

const { ProfileService } = require('../../../../../src/domain/settings/services/ProfileService');
const { ProfileSettings } = require('../../../../../src/domain/settings/models/ProfileSettings');

// SettingsValidator is required inside ProfileService but only for potential future use
// The real ProfileService code doesn't call validate on set -- it checks hasProfile() only.

function createMockRepo() {
  return {
    loadProfiles: jest.fn().mockResolvedValue(
      ProfileSettings.create(['alpha.py', 'beta.py', 'gamma.py'])
    ),
    saveProfileSelection: jest.fn().mockResolvedValue(true)
  };
}

function createMockEventBus() {
  return { emit: jest.fn() };
}

describe('ProfileService', () => {
  describe('constructor', () => {
    it('initializes with empty profile list', () => {
      const svc = new ProfileService();
      expect(svc.getProfiles()).toEqual([]);
      expect(svc.getCurrentProfile()).toBeNull();
    });
  });

  describe('refreshProfiles()', () => {
    it('throws when repo not configured', async () => {
      const svc = new ProfileService();
      await expect(svc.refreshProfiles()).rejects.toThrow('Repository not configured');
    });

    it('loads profiles from repo and emits event', async () => {
      const repo = createMockRepo();
      const bus = createMockEventBus();
      const svc = new ProfileService({ repository: repo, eventBus: bus });

      const result = await svc.refreshProfiles();
      expect(repo.loadProfiles).toHaveBeenCalled();
      expect(result).toBeInstanceOf(ProfileSettings);
      expect(svc.getProfiles().length).toBe(3);
      expect(bus.emit).toHaveBeenCalledWith('profiles:updated', expect.objectContaining({
        count: 3
      }));
    });

    it('wraps repo errors', async () => {
      const repo = createMockRepo();
      repo.loadProfiles.mockRejectedValue(new Error('network'));
      const svc = new ProfileService({ repository: repo });

      await expect(svc.refreshProfiles()).rejects.toThrow('Failed to refresh profiles: network');
    });
  });

  describe('setProfile()', () => {
    it('throws when repo not configured', async () => {
      const svc = new ProfileService();
      await expect(svc.setProfile('x')).rejects.toThrow('Repository not configured');
    });

    it('throws when profile not in cache', async () => {
      const repo = createMockRepo();
      const svc = new ProfileService({ repository: repo });
      await svc.refreshProfiles();

      await expect(svc.setProfile('nonexistent')).rejects.toThrow('not found in cache');
    });

    it('persists via repo and emits event', async () => {
      const repo = createMockRepo();
      const bus = createMockEventBus();
      const svc = new ProfileService({ repository: repo, eventBus: bus });
      await svc.refreshProfiles();

      const result = await svc.setProfile('beta.py');
      expect(repo.saveProfileSelection).toHaveBeenCalledWith('beta.py');
      expect(result).toBe(true);
      expect(svc.getCurrentProfile()).toBe('beta.py');
      expect(bus.emit).toHaveBeenCalledWith('profile:changed', expect.objectContaining({
        profile: 'beta.py'
      }));
    });

    it('wraps save errors', async () => {
      const repo = createMockRepo();
      repo.saveProfileSelection.mockRejectedValue(new Error('save fail'));
      const svc = new ProfileService({ repository: repo });
      await svc.refreshProfiles();

      await expect(svc.setProfile('alpha.py')).rejects.toThrow('Failed to set profile: save fail');
    });
  });

  describe('hasProfile()', () => {
    it('returns true for loaded profile', async () => {
      const repo = createMockRepo();
      const svc = new ProfileService({ repository: repo });
      await svc.refreshProfiles();

      expect(svc.hasProfile('alpha.py')).toBe(true);
      expect(svc.hasProfile('nonexistent')).toBe(false);
    });
  });

  describe('getDefaultProfile()', () => {
    it('returns first sorted profile', async () => {
      const repo = createMockRepo();
      const svc = new ProfileService({ repository: repo });
      await svc.refreshProfiles();

      expect(svc.getDefaultProfile()).toBe('alpha.py');
    });
  });

  describe('searchProfiles()', () => {
    it('filters by keyword', async () => {
      const repo = createMockRepo();
      const svc = new ProfileService({ repository: repo });
      await svc.refreshProfiles();

      expect(svc.searchProfiles('beta')).toEqual(['beta.py']);
    });
  });

  describe('getStatistics()', () => {
    it('returns stats after load', async () => {
      const repo = createMockRepo();
      const svc = new ProfileService({ repository: repo });
      await svc.refreshProfiles();

      const stats = svc.getStatistics();
      expect(stats.totalProfiles).toBe(3);
      expect(stats.currentProfile).toBeNull();
      expect(stats.hasProfiles).toBe(true);
      expect(stats.hasCurrentProfile).toBe(false);
    });
  });

  describe('cleanup()', () => {
    it('resets state and emits event', async () => {
      const repo = createMockRepo();
      const bus = createMockEventBus();
      const svc = new ProfileService({ repository: repo, eventBus: bus });
      await svc.refreshProfiles();

      svc.cleanup();
      expect(svc.getProfiles()).toEqual([]);
      expect(svc.getCurrentProfile()).toBeNull();
      expect(bus.emit).toHaveBeenCalledWith('profiles:cleanup', expect.any(Object));
    });
  });
});
