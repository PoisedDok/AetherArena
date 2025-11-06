'use strict';

/**
 * @.architecture
 * 
 * Incoming: require() statements from SettingsService/ProfileService/ModelService files --- {module_exports, class}
 * Processing: Aggregate and re-export 3 settings service classes (SettingsService, ProfileService, ModelService) --- {1 jobs: JOB_ROUTE_BY_TYPE}
 * Outgoing: module.exports barrel export to parent modules (SettingsManager, domain/settings/index.js) --- {module_exports, class}
 * 
 * 
 * @module domain/settings/services/index
 * 
 * Settings Services
 * Domain services for settings functionality
 */

const { SettingsService } = require('./SettingsService');
const { ProfileService } = require('./ProfileService');
const { ModelService } = require('./ModelService');

module.exports = {
  SettingsService,
  ProfileService,
  ModelService,
};

