'use strict';

/**
 * @.architecture
 * 
 * Incoming: require() statements from AudioStreamService/TTSService/STTService/AudioManager files --- {module_exports, class}
 * Processing: Aggregate and re-export 4 audio service classes (AudioStreamService, TTSService, STTService, AudioManager) --- {1 jobs: JOB_ROUTE_BY_TYPE}
 * Outgoing: module.exports barrel export to parent modules (UIManager, domain/audio/index.js) --- {module_exports, class}
 * 
 * 
 * @module domain/audio/services/index
 * 
 * Audio Services
 * Domain services for audio functionality
 */

const { AudioStreamService } = require('./AudioStreamService');
const { TTSService } = require('./TTSService');
const { STTService } = require('./STTService');
const { AudioManager } = require('./AudioManager');

module.exports = {
  AudioStreamService,
  TTSService,
  STTService,
  AudioManager,
};

