'use strict';

/**
 * @.architecture
 * 
 * Incoming: require() statements from AudioStream/TTSAudio/STTResult/AudioConfig files --- {module_exports, class}
 * Processing: Aggregate and re-export 4 audio model classes (AudioStream, TTSAudio, STTResult, AudioConfig) --- {1 jobs: JOB_ROUTE_BY_TYPE}
 * Outgoing: module.exports barrel export to parent modules (AudioManager, domain/audio/index.js) --- {module_exports, class}
 * 
 * 
 * @module domain/audio/models/index
 * 
 * Audio Models
 * Domain models for audio functionality
 */

const { AudioStream } = require('./AudioStream');
const { TTSAudio } = require('./TTSAudio');
const { STTResult } = require('./STTResult');
const { AudioConfig } = require('./AudioConfig');

module.exports = {
  AudioStream,
  TTSAudio,
  STTResult,
  AudioConfig,
};
