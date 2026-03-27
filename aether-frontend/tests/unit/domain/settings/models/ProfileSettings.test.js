'use strict';

const { ProfileSettings } = require('../../../../../src/domain/settings/models/ProfileSettings');

describe('ProfileSettings', () => {
  describe('constructor', () => {
    it('defaults to empty profiles and null current', () => {
      const ps = new ProfileSettings();
      expect(ps.availableProfiles).toEqual([]);
      expect(ps.currentProfile).toBeNull();
    });

    it('accepts initial data', () => {
      const ps = new ProfileSettings({ availableProfiles: ['a', 'b'], currentProfile: 'a' });
      expect(ps.availableProfiles).toEqual(['a', 'b']);
      expect(ps.currentProfile).toBe('a');
    });
  });

  describe('create()', () => {
    it('sorts profiles alphabetically', () => {
      const ps = ProfileSettings.create(['beta.py', 'alpha.py', 'gamma.py'], 'alpha.py');
      expect(ps.getAvailableProfiles()).toEqual(['alpha.py', 'beta.py', 'gamma.py']);
      expect(ps.getCurrentProfile()).toBe('alpha.py');
    });

    it('handles empty array', () => {
      const ps = ProfileSettings.create([]);
      expect(ps.getProfileCount()).toBe(0);
    });

    it('coerces non-string items to strings', () => {
      const ps = ProfileSettings.create([123, null]);
      expect(ps.getAvailableProfiles()).toEqual(['123', 'null']);
    });
  });

  describe('setAvailableProfiles()', () => {
    it('replaces and sorts profiles', () => {
      const ps = ProfileSettings.create(['a']);
      ps.setAvailableProfiles(['z', 'm', 'a']);
      expect(ps.getAvailableProfiles()).toEqual(['a', 'm', 'z']);
    });
  });

  describe('setCurrentProfile()', () => {
    it('sets current profile when it exists', () => {
      const ps = ProfileSettings.create(['alpha', 'beta'], null);
      ps.setCurrentProfile('beta');
      expect(ps.getCurrentProfile()).toBe('beta');
    });

    it('throws when profile not in available list', () => {
      const ps = ProfileSettings.create(['alpha'], null);
      expect(() => ps.setCurrentProfile('nonexistent')).toThrow('not found');
    });
  });

  describe('hasProfile()', () => {
    it('returns true for existing profile', () => {
      const ps = ProfileSettings.create(['alpha']);
      expect(ps.hasProfile('alpha')).toBe(true);
    });

    it('returns false for missing profile', () => {
      const ps = ProfileSettings.create(['alpha']);
      expect(ps.hasProfile('beta')).toBe(false);
    });
  });

  describe('getDefaultProfile()', () => {
    it('returns first profile when available', () => {
      const ps = ProfileSettings.create(['beta', 'alpha']);
      expect(ps.getDefaultProfile()).toBe('alpha'); // sorted
    });

    it('returns GURU.py when no profiles', () => {
      const ps = ProfileSettings.create([]);
      expect(ps.getDefaultProfile()).toBe('GURU.py');
    });
  });

  describe('searchProfiles()', () => {
    it('returns all profiles when no keyword', () => {
      const ps = ProfileSettings.create(['alpha', 'beta']);
      expect(ps.searchProfiles('')).toEqual(['alpha', 'beta']);
    });

    it('filters by case-insensitive keyword', () => {
      const ps = ProfileSettings.create(['alpha_test.py', 'beta_prod.py', 'gamma_test.py']);
      expect(ps.searchProfiles('test')).toEqual(['alpha_test.py', 'gamma_test.py']);
    });

    it('case-insensitive match', () => {
      const ps = ProfileSettings.create(['Alpha']);
      expect(ps.searchProfiles('ALPHA')).toEqual(['Alpha']);
    });
  });

  describe('getProfileCount() / hasProfiles() / hasCurrentProfile()', () => {
    it('reports correct count', () => {
      const ps = ProfileSettings.create(['a', 'b']);
      expect(ps.getProfileCount()).toBe(2);
      expect(ps.hasProfiles()).toBe(true);
    });

    it('hasProfiles is false when empty', () => {
      const ps = ProfileSettings.create([]);
      expect(ps.hasProfiles()).toBe(false);
    });

    it('hasCurrentProfile is false when null', () => {
      const ps = ProfileSettings.create(['a']);
      expect(ps.hasCurrentProfile()).toBe(false);
    });

    it('hasCurrentProfile is true when set', () => {
      const ps = ProfileSettings.create(['a'], 'a');
      expect(ps.hasCurrentProfile()).toBe(true);
    });
  });

  describe('toJSON() / fromJSON()', () => {
    it('round-trips through JSON', () => {
      const ps = ProfileSettings.create(['alpha', 'beta'], 'alpha');
      const json = ps.toJSON();
      expect(json.count).toBe(2);
      expect(json.currentProfile).toBe('alpha');

      const restored = ProfileSettings.fromJSON(json);
      expect(restored.getCurrentProfile()).toBe('alpha');
      expect(restored.getAvailableProfiles()).toEqual(['alpha', 'beta']);
    });
  });
});
