'use strict';

/**
 * @.architecture
 * 
 * Incoming: AudioStreamService/TTSService/STTService/AudioManager validation method calls, data objects (stream data/TTS data/STT data/config/audio chunks), browser API objects (MediaStream/MediaRecorder/AudioContext), audio levels --- {method_calls, object | MediaStream | MediaRecorder | AudioContext | number}
 * Processing: Static pure validation functions (no side effects), validateStreamData (check id non-empty string, config.mimeType string, config.sampleRate>0, config.audioBitsPerSecond>0, config.chunkInterval>0, audioLevel 0-1), validateTTSData (check audioData required ArrayBuffer or Uint8Array, sampleRate>0, format string, status enum pending/playing/played/error), validateSTTData (check text non-empty string, isFinal boolean, confidence 0-1, streamId string), validateConfig (3 categories: microphone enabled boolean + sampleRate>0 + audioBitsPerSecond>0 + chunkInterval>0 + mimeType string, tts enabled boolean + sampleRate>0 + volume 0-1 + autoPlay boolean, general audioContextSampleRate>0 + enableKeyboardShortcuts boolean + keyboardShortcutKey string), validateAudioChunk (check required ArrayBuffer or Uint8Array, size>0, size≤10MB for DoS protection), validateMediaStream (check instanceof MediaStream, has audio tracks via getAudioTracks().length>0, has active tracks via readyState='live' AND enabled), validateMediaRecorder (check instanceof MediaRecorder, has valid audio source via stream.getAudioTracks()), validateAudioContext (check instanceof AudioContext or webkitAudioContext, state not 'closed'), validateAudioLevel (check required, is number, 0-1 range, not NaN) --- {4 jobs: JOB_VALIDATE_SCHEMA, JOB_VALIDATE_SCHEMA, JOB_VALIDATE_SCHEMA, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return validation result objects { valid: boolean, errors: string[] } --- {object, javascript_object}
 * 
 * 
 * @module domain/audio/validators/AudioValidator
 * 
 * AudioValidator
 * Validation logic for audio domain models
 * 
 * Pure validation functions with no side effects
 */

class AudioValidator {
  /**
   * Validate audio stream data
   * @param {Object} data - Audio stream data to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateStreamData(data) {
    const errors = [];

    if (!data) {
      errors.push('Audio stream data is required');
      return { valid: false, errors };
    }

    if (!data.id || typeof data.id !== 'string') {
      errors.push('Stream ID must be a non-empty string');
    }

    if (data.config) {
      if (data.config.mimeType && typeof data.config.mimeType !== 'string') {
        errors.push('MIME type must be a string');
      }

      if (data.config.sampleRate) {
        if (typeof data.config.sampleRate !== 'number' || data.config.sampleRate <= 0) {
          errors.push('Sample rate must be a positive number');
        }
      }

      if (data.config.audioBitsPerSecond) {
        if (typeof data.config.audioBitsPerSecond !== 'number' || data.config.audioBitsPerSecond <= 0) {
          errors.push('Audio bits per second must be a positive number');
        }
      }

      if (data.config.chunkInterval) {
        if (typeof data.config.chunkInterval !== 'number' || data.config.chunkInterval <= 0) {
          errors.push('Chunk interval must be a positive number');
        }
      }
    }

    if (data.audioLevel !== undefined) {
      if (typeof data.audioLevel !== 'number' || data.audioLevel < 0 || data.audioLevel > 1) {
        errors.push('Audio level must be a number between 0 and 1');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate TTS audio data
   * @param {Object} data - TTS audio data to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateTTSData(data) {
    const errors = [];

    if (!data) {
      errors.push('TTS audio data is required');
      return { valid: false, errors };
    }

    if (!data.audioData) {
      errors.push('Audio data is required');
    } else if (!(data.audioData instanceof ArrayBuffer) && !(data.audioData instanceof Uint8Array)) {
      errors.push('Audio data must be ArrayBuffer or Uint8Array');
    }

    if (data.sampleRate) {
      if (typeof data.sampleRate !== 'number' || data.sampleRate <= 0) {
        errors.push('Sample rate must be a positive number');
      }
    }

    if (data.format && typeof data.format !== 'string') {
      errors.push('Format must be a string');
    }

    if (data.status && !['pending', 'playing', 'played', 'error'].includes(data.status)) {
      errors.push('Status must be one of: pending, playing, played, error');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate STT result data
   * @param {Object} data - STT result data to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateSTTData(data) {
    const errors = [];

    if (!data) {
      errors.push('STT result data is required');
      return { valid: false, errors };
    }

    if (!data.text || typeof data.text !== 'string') {
      errors.push('Text must be a non-empty string');
    }

    if (typeof data.isFinal !== 'boolean') {
      errors.push('isFinal must be a boolean');
    }

    if (data.confidence !== undefined) {
      if (typeof data.confidence !== 'number' || data.confidence < 0 || data.confidence > 1) {
        errors.push('Confidence must be a number between 0 and 1');
      }
    }

    if (data.streamId && typeof data.streamId !== 'string') {
      errors.push('Stream ID must be a string');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate audio configuration
   * @param {Object} config - Audio config to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateConfig(config) {
    const errors = [];

    if (!config) {
      errors.push('Audio configuration is required');
      return { valid: false, errors };
    }

    // Validate microphone config
    if (config.microphone) {
      const mic = config.microphone;

      if (mic.enabled !== undefined && typeof mic.enabled !== 'boolean') {
        errors.push('Microphone enabled must be boolean');
      }

      if (mic.sampleRate && (typeof mic.sampleRate !== 'number' || mic.sampleRate <= 0)) {
        errors.push('Microphone sample rate must be positive number');
      }

      if (mic.audioBitsPerSecond && (typeof mic.audioBitsPerSecond !== 'number' || mic.audioBitsPerSecond <= 0)) {
        errors.push('Microphone audio bits per second must be positive number');
      }

      if (mic.chunkInterval && (typeof mic.chunkInterval !== 'number' || mic.chunkInterval <= 0)) {
        errors.push('Microphone chunk interval must be positive number');
      }

      if (mic.mimeType && typeof mic.mimeType !== 'string') {
        errors.push('Microphone MIME type must be string');
      }
    }

    // Validate TTS config
    if (config.tts) {
      const tts = config.tts;

      if (tts.enabled !== undefined && typeof tts.enabled !== 'boolean') {
        errors.push('TTS enabled must be boolean');
      }

      if (tts.sampleRate && (typeof tts.sampleRate !== 'number' || tts.sampleRate <= 0)) {
        errors.push('TTS sample rate must be positive number');
      }

      if (tts.volume !== undefined && (typeof tts.volume !== 'number' || tts.volume < 0 || tts.volume > 1)) {
        errors.push('TTS volume must be number between 0 and 1');
      }

      if (tts.autoPlay !== undefined && typeof tts.autoPlay !== 'boolean') {
        errors.push('TTS auto-play must be boolean');
      }
    }

    // Validate general config
    if (config.general) {
      const general = config.general;

      if (general.audioContextSampleRate && (typeof general.audioContextSampleRate !== 'number' || general.audioContextSampleRate <= 0)) {
        errors.push('Audio context sample rate must be positive number');
      }

      if (general.enableKeyboardShortcuts !== undefined && typeof general.enableKeyboardShortcuts !== 'boolean') {
        errors.push('Enable keyboard shortcuts must be boolean');
      }

      if (general.keyboardShortcutKey && typeof general.keyboardShortcutKey !== 'string') {
        errors.push('Keyboard shortcut key must be string');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate audio chunk data for streaming
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

    // Check reasonable size limits (prevent DoS)
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
   * Validate MediaStream object
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
   * Validate audio level value
   * @param {number} level - Audio level (0-1)
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateAudioLevel(level) {
    const errors = [];

    if (level === undefined || level === null) {
      errors.push('Audio level is required');
      return { valid: false, errors };
    }

    if (typeof level !== 'number') {
      errors.push('Audio level must be a number');
    } else if (level < 0 || level > 1) {
      errors.push('Audio level must be between 0 and 1');
    } else if (isNaN(level)) {
      errors.push('Audio level cannot be NaN');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

module.exports = { AudioValidator };

