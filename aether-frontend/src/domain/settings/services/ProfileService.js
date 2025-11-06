'use strict';

/**
 * @.architecture
 * 
 * Incoming: ProfileManager.refreshProfileList(), SettingsManager.setProfile() (method calls for profile operations) --- {profile_name, string}
 * Processing: Refresh profiles via SettingsRepository.loadProfiles(), set current profile (validate via SettingsValidator), persist selection via repository.saveProfileSelection(), emit events (profiles:updated/profile:changed), maintain _profileSettings state (ProfileSettings instance) --- {5 jobs: JOB_GET_STATE, JOB_UPDATE_STATE, JOB_SAVE_TO_DB, JOB_EMIT_EVENT, JOB_VALIDATE_SCHEMA}
 * Outgoing: SettingsRepository.loadProfiles/saveProfileSelection() (backend operations), EventBus.emit() (events), return ProfileSettings instances --- {profile_settings, javascript_object}
 * 
 * 
 * @module domain/settings/services/ProfileService
 */

const { ProfileSettings } = require('../models/ProfileSettings');
const { SettingsValidator } = require('../validators/SettingsValidator');

class ProfileService {
  /**
   * @param {Object} dependencies - Injected dependencies
   * @param {Object} dependencies.repository - Settings repository
   * @param {Object} dependencies.eventBus - Event bus for events
   */
  constructor(dependencies = {}) {
    this.repository = dependencies.repository || null;
    this.eventBus = dependencies.eventBus || null;
    this._profileSettings = ProfileSettings.create([]);
  }

  /**
   * Refresh profile list from backend
   * @returns {Promise<ProfileSettings>}
   */
  async refreshProfiles() {
    if (!this.repository) {
      throw new Error('Repository not configured');
    }

    try {
      this._profileSettings = await this.repository.loadProfiles();

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('profiles:updated', {
          profiles: this._profileSettings.getAvailableProfiles(),
          count: this._profileSettings.getProfileCount(),
          timestamp: Date.now(),
        });
      }

      return this._profileSettings;
    } catch (error) {
      throw new Error(`Failed to refresh profiles: ${error.message}`);
    }
  }

  /**
   * Set current profile
   * @param {string} profileName - Profile name
   * @returns {Promise<boolean>}
   */
  async setProfile(profileName) {
    if (!this.repository) {
      throw new Error('Repository not configured');
    }

    // Validate profile name
    const validation = SettingsValidator.validateProfileName(profileName);
    if (!validation.valid) {
      throw new Error(`Invalid profile name: ${validation.errors.join(', ')}`);
    }

    // Check if profile exists
    if (!this._profileSettings.hasProfile(profileName)) {
      throw new Error(`Profile "${profileName}" not found`);
    }

    const previousProfile = this._profileSettings.getCurrentProfile();

    try {
      await this.repository.saveProfileSelection(profileName);
      
      // Update current profile
      this._profileSettings.setCurrentProfile(profileName);

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('profile:changed', {
          profile: profileName,
          previousProfile,
          timestamp: Date.now(),
        });
      }

      return true;
    } catch (error) {
      throw new Error(`Failed to set profile: ${error.message}`);
    }
  }

  /**
   * Get current profile
   * @returns {string|null}
   */
  getCurrentProfile() {
    return this._profileSettings.getCurrentProfile();
  }

  /**
   * Get all profiles
   * @returns {string[]}
   */
  getProfiles() {
    return this._profileSettings.getAvailableProfiles();
  }

  /**
   * Check if profile exists
   * @param {string} profileName - Profile name
   * @returns {boolean}
   */
  hasProfile(profileName) {
    return this._profileSettings.hasProfile(profileName);
  }

  /**
   * Get default profile
   * @returns {string}
   */
  getDefaultProfile() {
    return this._profileSettings.getDefaultProfile();
  }

  /**
   * Search profiles by keyword
   * @param {string} keyword - Search keyword
   * @returns {string[]}
   */
  searchProfiles(keyword) {
    return this._profileSettings.searchProfiles(keyword);
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStatistics() {
    return {
      totalProfiles: this._profileSettings.getProfileCount(),
      currentProfile: this._profileSettings.getCurrentProfile(),
      hasProfiles: this._profileSettings.hasProfiles(),
      hasCurrentProfile: this._profileSettings.hasCurrentProfile(),
    };
  }

  /**
   * Cleanup
   */
  cleanup() {
    this._profileSettings = ProfileSettings.create([]);

    if (this.eventBus) {
      this.eventBus.emit('profiles:cleanup', { timestamp: Date.now() });
    }
  }
}

module.exports = { ProfileService };

