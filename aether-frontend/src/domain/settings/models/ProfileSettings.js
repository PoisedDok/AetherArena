'use strict';

/**
 * @.architecture
 * 
 * Incoming: Constructor data (availableProfiles/currentProfile), method calls (create/setAvailableProfiles/setCurrentProfile/getCurrentProfile/getAvailableProfiles/hasProfile/getDefaultProfile/searchProfiles/getProfileCount/hasProfiles/hasCurrentProfile/toJSON/fromJSON), JSON data --- {method_calls, object | array | string}
 * Processing: Initialize availableProfiles array, currentProfile string, sort profiles alphabetically, set/get current profile, validate profile exists (hasProfile), get default profile (first profile or 'GURU.py'), search profiles by keyword (case-insensitive includes), get profile count, check has profiles/current profile, convert to JSON (includes count) --- {8 jobs: JOB_GET_STATE, JOB_GET_STATE, JOB_INITIALIZE, JOB_PARSE_JSON, JOB_STRINGIFY_JSON, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return values (profiles array, current profile string, JSON), throw Error for invalid profile --- {array | string | object | null | number | boolean, javascript_object | Error}
 * 
 * 
 * @module domain/settings/models/ProfileSettings
 * 
 * ProfileSettings Model
 * Represents interpreter profile settings
 * 
 * Manages profile list and current profile selection
 */

class ProfileSettings {
  /**
   * @param {Object} data - Profile settings data
   * @param {string[]} data.availableProfiles - List of available profiles
   * @param {string|null} data.currentProfile - Currently selected profile
   */
  constructor(data = {}) {
    this.availableProfiles = data.availableProfiles || [];
    this.currentProfile = data.currentProfile || null;
  }

  /**
   * Create from profile list
   * @param {string[]} profiles - List of available profiles
   * @param {string|null} currentProfile - Current profile
   * @returns {ProfileSettings}
   */
  static create(profiles = [], currentProfile = null) {
    return new ProfileSettings({
      availableProfiles: profiles.map(String).sort((a, b) => a.localeCompare(b)),
      currentProfile,
    });
  }

  /**
   * Set available profiles
   * @param {string[]} profiles - List of profiles
   */
  setAvailableProfiles(profiles) {
    this.availableProfiles = profiles.map(String).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Set current profile
   * @param {string} profileName - Profile name
   */
  setCurrentProfile(profileName) {
    if (!this.hasProfile(profileName)) {
      throw new Error(`Profile "${profileName}" not found in available profiles`);
    }
    this.currentProfile = profileName;
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
   * @returns {string[]}
   */
  getAvailableProfiles() {
    return [...this.availableProfiles];
  }

  /**
   * Check if profile exists
   * @param {string} profileName - Profile name
   * @returns {boolean}
   */
  hasProfile(profileName) {
    return this.availableProfiles.includes(profileName);
  }

  /**
   * Get default profile
   * @returns {string}
   */
  getDefaultProfile() {
    return this.availableProfiles[0] || 'GURU.py';
  }

  /**
   * Search profiles by keyword
   * @param {string} keyword - Search keyword
   * @returns {string[]}
   */
  searchProfiles(keyword) {
    if (!keyword) return this.availableProfiles;

    const lowerKeyword = keyword.toLowerCase();
    return this.availableProfiles.filter(profile =>
      profile.toLowerCase().includes(lowerKeyword)
    );
  }

  /**
   * Get profile count
   * @returns {number}
   */
  getProfileCount() {
    return this.availableProfiles.length;
  }

  /**
   * Check if has profiles
   * @returns {boolean}
   */
  hasProfiles() {
    return this.availableProfiles.length > 0;
  }

  /**
   * Check if current profile is set
   * @returns {boolean}
   */
  hasCurrentProfile() {
    return this.currentProfile !== null;
  }

  /**
   * Convert to plain object
   * @returns {Object}
   */
  toJSON() {
    return {
      availableProfiles: [...this.availableProfiles],
      currentProfile: this.currentProfile,
      count: this.availableProfiles.length,
    };
  }

  /**
   * Create from plain object
   * @param {Object} json - Plain object
   * @returns {ProfileSettings}
   */
  static fromJSON(json) {
    return new ProfileSettings({
      availableProfiles: json.availableProfiles || [],
      currentProfile: json.currentProfile || null,
    });
  }
}

module.exports = { ProfileSettings };
