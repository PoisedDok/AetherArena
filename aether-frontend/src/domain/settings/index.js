'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export Settings/ProfileSettings/ModelSettings/ModelCapabilities (models), SettingsService/ProfileService/ModelService (services), SettingsRepository (repositories), SettingsValidator (validators) for centralized import path --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: application/*, renderer/* (settings domain layer) --- {module_exports, javascript_object}
 * 
 * 
 * @module domain/settings/index
 * 
 * Settings Domain
 * Public API for settings management
 * 
 * Clean domain layer following DDD principles
 */

// Models
const { Settings } = require('./models/Settings');
const { ProfileSettings } = require('./models/ProfileSettings');
const { ModelSettings } = require('./models/ModelSettings');
const { ModelCapabilities } = require('./models/ModelCapabilities');

// Services
const { SettingsService } = require('./services/SettingsService');
const { ProfileService } = require('./services/ProfileService');
const { ModelService } = require('./services/ModelService');

// Repositories
const { SettingsRepository } = require('./repositories/SettingsRepository');

// Validators
const { SettingsValidator } = require('./validators/SettingsValidator');

module.exports = {
  // Models
  Settings,
  ProfileSettings,
  ModelSettings,
  ModelCapabilities,
  
  // Services
  SettingsService,
  ProfileService,
  ModelService,
  
  // Repositories
  SettingsRepository,
  
  // Validators
  SettingsValidator,
};

