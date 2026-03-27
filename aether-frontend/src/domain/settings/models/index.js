'use strict';

/**
 * @.architecture
 * 
 * Incoming: require() statements from Settings/ProfileSettings/ModelSettings/ModelCapabilities files --- {module_exports, class}
 * Processing: Aggregate and re-export 4 settings model classes (Settings, ProfileSettings, ModelSettings, ModelCapabilities) --- {1 jobs: JOB_ROUTE_BY_TYPE}
 * Outgoing: module.exports barrel export to parent modules (SettingsService, domain/settings/index.js) --- {module_exports, class}
 * 
 * 
 * @module domain/settings/models/index
 * 
 * Settings Models
 * Domain models for settings functionality
 */

const { Settings } = require('./Settings');
const { ProfileSettings } = require('./ProfileSettings');
const { ModelSettings } = require('./ModelSettings');
const { ModelCapabilities } = require('./ModelCapabilities');

module.exports = {
  Settings,
  ProfileSettings,
  ModelSettings,
  ModelCapabilities,
};
