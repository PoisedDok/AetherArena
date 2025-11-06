'use strict';

/**
 * @.architecture
 * 
 * Incoming: none --- {none, none}
 * Processing: Re-export AudioStream/TTSAudio/STTResult/AudioConfig (models), AudioStreamService/TTSService/STTService/AudioManager (services), AudioValidator (validators) for centralized import path --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: application/*, renderer/* (audio domain layer) --- {module_exports, javascript_object}
 * 
 * 
 * @module domain/audio/index
 * 
 * Audio Domain
 * Public API for audio management
 * 
 * Clean domain layer following DDD principles
 */

// Models
const { AudioStream } = require('./models/AudioStream');
const { TTSAudio } = require('./models/TTSAudio');
const { STTResult } = require('./models/STTResult');
const { AudioConfig } = require('./models/AudioConfig');

// Services
const { AudioStreamService } = require('./services/AudioStreamService');
const { TTSService } = require('./services/TTSService');
const { STTService } = require('./services/STTService');
const { AudioManager } = require('./services/AudioManager');

// Validators
const { AudioValidator } = require('./validators/AudioValidator');

module.exports = {
  // Models
  AudioStream,
  TTSAudio,
  STTResult,
  AudioConfig,
  
  // Services
  AudioStreamService,
  TTSService,
  STTService,
  AudioManager,
  
  // Validators
  AudioValidator,
};

