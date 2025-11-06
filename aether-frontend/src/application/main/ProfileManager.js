'use strict';

/**
 * @.architecture
 * 
 * Incoming: MainOrchestrator.refreshProfileList calls, MainOrchestrator.setCurrentProfile calls --- {lifecycle_types.method_call, string}
 * Processing: Fetch profiles via Endpoint.getProfiles, parse response, persist selection via Endpoint.setSettings, emit EventBus events (LIST_UPDATED/CHANGED), update state (profiles array/currentProfile), provide getters for state/stats/search/default, dispose resources --- {6 jobs: JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_HTTP_REQUEST, JOB_PARSE_JSON, JOB_UPDATE_STATE}
 * Outgoing: EventBus.emit (PROFILE.* events), Endpoint.setSettings request, return profile arrays --- {event_types.profile_list_updated, profile_types.profile_array}
 * 
 * @module application/main/ProfileManager
 * 
 * ProfileManager - Manages interpreter profiles
 * ============================================================================
 * Production-ready profile management service.
 * 
 * Features:
 * - Profile list refreshing from backend
 * - Profile selection and persistence
 * - Profile search
 * - Default profile fallback
 */

const { EventTypes, EventPriority } = require('../../core/events/EventTypes');

class ProfileManager {
  constructor(options = {}) {
    // Dependencies
    this.endpoint = options.endpoint || null;
    this.eventBus = options.eventBus || null;
    
    // Configuration
    this.enableLogging = options.enableLogging !== undefined ? options.enableLogging : false;
    
    // State
    this.profiles = [];
    this.currentProfile = null;
    
    // Validation
    if (!this.endpoint) {
      throw new Error('[ProfileManager] endpoint required');
    }
    
    if (!this.eventBus) {
      throw new Error('[ProfileManager] eventBus required');
    }
  }

  /**
   * Refresh profile list from backend
   * @returns {Promise<Array>} List of available profiles
   */
  async refreshProfileList() {
    if (this.enableLogging) {
      console.log('[ProfileManager] Refreshing profile list...');
    }

    try {
      const response = await this.endpoint.getProfiles();
      const profiles = Array.isArray(response?.profiles) ? response.profiles : [];

      this.profiles = profiles.map(String).sort((a, b) => a.localeCompare(b));

      // Emit event
      this.eventBus.emit(EventTypes.PROFILE.LIST_UPDATED, {
        profiles: this.profiles,
        count: this.profiles.length,
        timestamp: Date.now()
      });

      if (this.enableLogging) {
        console.log(`[ProfileManager] Found ${this.profiles.length} profiles`);
      }

      return this.profiles;
    } catch (error) {
      console.error('[ProfileManager] Error refreshing profile list:', error);
      return [];
    }
  }

  /**
   * Set current profile
   * @param {string} profileName - Profile to set as current
   * @returns {Promise<boolean>} Success status
   */
  async setCurrentProfile(profileName) {
    if (!profileName) return false;

    if (this.enableLogging) {
      console.log(`[ProfileManager] Setting profile: ${profileName}`);
    }

    try {
      // Persist to backend
      const payload = {
        interpreter: {
          profile: profileName
        }
      };

      await this.endpoint.setSettings(payload);

      const previousProfile = this.currentProfile;
      this.currentProfile = profileName;

      // Emit event
      this.eventBus.emit(EventTypes.PROFILE.CHANGED, {
        profile: profileName,
        previousProfile,
        timestamp: Date.now()
      }, { priority: EventPriority.NORMAL });

      if (this.enableLogging) {
        console.log(`[ProfileManager] Profile changed: ${previousProfile} → ${profileName}`);
      }

      return true;
    } catch (error) {
      console.error('[ProfileManager] Error setting profile:', error);
      return false;
    }
  }

  /**
   * Get current profile
   * @returns {string|null}
   */
  getCurrentProfile() {
    return this.currentProfile;
  }

  /**
   * Get all profiles
   * @returns {Array}
   */
  getProfiles() {
    return [...this.profiles];
  }

  /**
   * Check if profile exists
   * @param {string} profileName - Profile name
   * @returns {boolean}
   */
  hasProfile(profileName) {
    return this.profiles.includes(profileName);
  }

  /**
   * Get default profile
   * @returns {string}
   */
  getDefaultProfile() {
    // Return first profile or fallback
    return this.profiles[0] || 'guru_integration.py';
  }

  /**
   * Search profiles by keyword
   * @param {string} keyword - Search keyword
   * @returns {Array} Matching profiles
   */
  searchProfiles(keyword) {
    if (!keyword) return this.profiles;

    const lowerKeyword = keyword.toLowerCase();
    return this.profiles.filter(profile => 
      profile.toLowerCase().includes(lowerKeyword)
    );
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return Object.freeze({
      totalProfiles: this.profiles.length,
      currentProfile: this.currentProfile,
      hasProfiles: this.profiles.length > 0
    });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.profiles = [];
    this.currentProfile = null;
    this.endpoint = null;
    this.eventBus = null;

    if (this.enableLogging) {
      console.log('[ProfileManager] Disposed');
    }
  }
}

// Export
module.exports = ProfileManager;

if (typeof window !== 'undefined') {
  window.ProfileManager = ProfileManager;
  console.log('📦 ProfileManager loaded');
}

