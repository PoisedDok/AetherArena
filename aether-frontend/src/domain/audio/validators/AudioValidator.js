'use strict';

/**
 * @.architecture
 * 
 * Incoming: AudioStreamService/AudioManager (browser API validation, memory safety checks) --- {MediaStream | MediaRecorder | AudioContext | ArrayBuffer, object}
 * Processing: Validate browser API objects (MediaStream/MediaRecorder/AudioContext), enforce chunk size limits (DoS protection) --- {1 job: JOB_VALIDATE_SCHEMA}
 * Outgoing: Validation results for browser APIs and memory safety --- {validation_result, {valid:boolean, errors:string[]}}
 * 
 * ARCHITECTURE NOTE:
 * Backend owns validation for TTS/STT request parameters (text, engine, voice).
 * Frontend validates ONLY:
 *   1. Browser API objects (MediaStream, MediaRecorder, AudioContext) - never sent to backend
 *   2. Memory safety (audio chunk size limits) - local DoS protection
 * 
 * All business logic validation for backend-sent data removed.
 * 
 * @module domain/audio/validators/AudioValidator
 */

const { createLogger } = require('../../../core/utils/logger');

const log = createLogger({ component: 'AudioValidator' });

/**
 * AudioValidator
 * 
 * Validates browser APIs and enforces memory safety only.
 * Backend validates: TTS/STT parameters, sample rates, formats, config.
 * Frontend validates: Browser API objects, memory limits.
 */
class AudioValidator {
  /**
   * Validate MediaStream object
   * ARCHITECTURE: Browser API object - frontend must validate before use
   * @param {MediaStream} stream - MediaStream to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateMediaStream(stream) {
    const errors = [];

    if (!stream) {
      errors.push('MediaStream is required');
      return { valid: false, errors };
    }

    if (!(stream instanceof MediaStream)) {
      errors.push('Invalid MediaStream object');
      return { valid: false, errors };
    }

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      errors.push('MediaStream has no audio tracks');
    }

    // Check if tracks are active
    const hasActiveTrack = audioTracks.some(track => track.readyState === 'live' && track.enabled);
    if (!hasActiveTrack) {
      errors.push('MediaStream has no active audio tracks');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate MediaRecorder object
   * ARCHITECTURE: Browser API object - frontend must validate before use
   * @param {MediaRecorder} recorder - MediaRecorder to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateMediaRecorder(recorder) {
    const errors = [];

    if (!recorder) {
      errors.push('MediaRecorder is required');
      return { valid: false, errors };
    }

    if (!(recorder instanceof MediaRecorder)) {
      errors.push('Invalid MediaRecorder object');
      return { valid: false, errors };
    }

    if (recorder.state === 'inactive' && recorder.stream.getAudioTracks().length === 0) {
      errors.push('MediaRecorder has no valid audio source');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate AudioContext object
   * ARCHITECTURE: Browser API object - frontend must validate before use
   * @param {AudioContext} context - AudioContext to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateAudioContext(context) {
    const errors = [];

    if (!context) {
      errors.push('AudioContext is required');
      return { valid: false, errors };
    }

    if (!(context instanceof AudioContext || context instanceof webkitAudioContext)) {
      errors.push('Invalid AudioContext object');
      return { valid: false, errors };
    }

    if (context.state === 'closed') {
      errors.push('AudioContext is closed');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate audio chunk data for memory safety
   * ARCHITECTURE: Local DoS protection - prevent oversized chunks from crashing renderer
   * @param {ArrayBuffer|Uint8Array} chunk - Audio chunk
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateAudioChunk(chunk) {
    const errors = [];

    if (!chunk) {
      errors.push('Audio chunk is required');
      return { valid: false, errors };
    }

    if (!(chunk instanceof ArrayBuffer) && !(chunk instanceof Uint8Array)) {
      errors.push('Audio chunk must be ArrayBuffer or Uint8Array');
    }

    const size = chunk instanceof ArrayBuffer ? chunk.byteLength : chunk.byteLength;
    if (size === 0) {
      errors.push('Audio chunk cannot be empty');
    }

    // Memory safety: prevent DoS by blocking oversized chunks
    const MAX_CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
    if (size > MAX_CHUNK_SIZE) {
      errors.push(`Audio chunk too large (max ${MAX_CHUNK_SIZE} bytes)`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Legacy compatibility: validateStreamData removed
   * ARCHITECTURE: Backend validates stream configuration
   * @deprecated Backend validates on receive
   */
  static validateStreamData(data) {
    log.warn('validateStreamData() is deprecated - backend owns validation');
    return { valid: true, errors: [] };
  }

  /**
   * Legacy compatibility: validateTTSData removed
   * ARCHITECTURE: Backend validates TTS parameters
   * @deprecated Backend validates on receive
   */
  static validateTTSData(data) {
    log.warn('validateTTSData() is deprecated - backend owns validation');
    return { valid: true, errors: [] };
  }

  /**
   * Legacy compatibility: validateSTTData removed
   * ARCHITECTURE: Backend validates STT results
   * @deprecated Backend validates on receive
   */
  static validateSTTData(data) {
    log.warn('validateSTTData() is deprecated - backend owns validation');
    return { valid: true, errors: [] };
  }

  /**
   * Legacy compatibility: validateConfig removed
   * ARCHITECTURE: Backend validates audio configuration
   * @deprecated Backend validates on receive
   */
  static validateConfig(config) {
    // Silently pass - backend owns validation
    return { valid: true, errors: [] };
  }

  /**
   * Legacy compatibility: validateAudioLevel removed
   * ARCHITECTURE: Backend validates audio levels
   * @deprecated Backend validates on receive
   */
  static validateAudioLevel(level) {
    // Silently pass - backend owns validation
    return { valid: true, errors: [] };
  }
}

module.exports = { AudioValidator };
