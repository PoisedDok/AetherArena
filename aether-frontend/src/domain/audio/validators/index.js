'use strict';

/**
 * @.architecture
 * 
 * Incoming: require() statement from AudioValidator file --- {module_exports, class}
 * Processing: Re-export 1 audio validator class (AudioValidator) --- {1 jobs: JOB_ROUTE_BY_TYPE}
 * Outgoing: module.exports barrel export to parent modules (AudioStreamService, domain/audio/index.js) --- {module_exports, class}
 * 
 * 
 * @module domain/audio/validators/index
 * 
 * Audio Validators
 * Domain validators for audio functionality
 */

const { AudioValidator } = require('./AudioValidator');

module.exports = {
  AudioValidator,
};

