'use strict';

/**
 * @.architecture
 * 
 * Incoming: require() statement from SettingsValidator file --- {module_exports, class}
 * Processing: Re-export 1 settings validator class (SettingsValidator) --- {1 jobs: JOB_ROUTE_BY_TYPE}
 * Outgoing: module.exports barrel export to parent modules (SettingsService, domain/settings/index.js) --- {module_exports, class}
 * 
 * 
 * @module domain/settings/validators/index
 * 
 * Settings Validators
 * Domain validators for settings functionality
 */

const { SettingsValidator } = require('./SettingsValidator');

module.exports = {
  SettingsValidator,
};

