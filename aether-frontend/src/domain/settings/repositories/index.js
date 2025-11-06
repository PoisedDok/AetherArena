'use strict';

/**
 * @.architecture
 * 
 * Incoming: require() statement from SettingsRepository file --- {module_exports, class}
 * Processing: Re-export 1 settings repository class (SettingsRepository) --- {1 jobs: JOB_ROUTE_BY_TYPE}
 * Outgoing: module.exports barrel export to parent modules (SettingsService, domain/settings/index.js) --- {module_exports, class}
 * 
 * 
 * @module domain/settings/repositories/index
 * 
 * Settings Repositories
 * Data access layer for settings
 */

const { SettingsRepository } = require('./SettingsRepository');

module.exports = {
  SettingsRepository,
};

