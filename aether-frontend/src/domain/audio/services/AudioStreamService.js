'use strict';

/**
 * @.architecture
 * 
 * Incoming: AudioManager method calls (createStream/startStream/stopStream/updateAudioLevel/getStream/isStreamActive/getActiveStreams/cleanupStream/cleanupAllStreams/calculateAudioLevel/validateChunk/getStreamDuration/getStreamMetadata), stream IDs, browser API objects (MediaStream/MediaRecorder/AudioContext), frequency data (Uint8Array from AnalyserNode), audio chunks (ArrayBuffer/Uint8Array) --- {method_calls, string | MediaStream | MediaRecorder | AudioContext | Uint8Array | ArrayBuffer}
 * Processing: Maintain _activeStreams Map (streamId → AudioStream), createStream (validate via AudioValidator, create AudioStream.create(), store in Map), startStream (validate MediaStream/MediaRecorder/AudioContext via AudioValidator, get or create stream, call stream.start()), stopStream (get from Map, call stream.stop()), updateAudioLevel (validate 0-1 range via AudioValidator, get stream, call stream.updateLevel()), getStream (get from Map), isStreamActive (get from Map, check stream.isActive), getActiveStreams (filter Map values by isActive), cleanupStream (get from Map, call stream.cleanup(), delete from Map), cleanupAllStreams (iterate Map entries, cleanup() each stream, clear Map), calculateAudioLevel (sum frequency data array, calculate average, normalize to 0-1 by dividing by 255), validateChunk (delegate to AudioValidator.validateAudioChunk()), getStreamDuration (get stream, call stream.getDuration()), getStreamMetadata (get stream, call stream.toJSON()), getAllStreamsMetadata (map all streams to toJSON()) --- {11 jobs: JOB_GET_STATE, JOB_DISPOSE, JOB_INITIALIZE, JOB_GET_STATE, JOB_GET_STATE, JOB_INITIALIZE, JOB_START, JOB_STOP, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return AudioStream instances, arrays, metadata objects, booleans, numbers, AudioValidator method calls --- {AudioStream | array | object | boolean | number, javascript_object}
 * 
 * 
 * @module domain/audio/services/AudioStreamService
 * 
 * AudioStreamService
 * Business logic for audio streaming operations
 * 
 * Handles microphone capture, audio level monitoring, and streaming to backend
 * Pure business logic - no DOM dependencies
 */

const { AudioStream } = require('../models/AudioStream');
const { AudioValidator } = require('../validators/AudioValidator');

class AudioStreamService {
  constructor() {
    this._activeStreams = new Map();
  }

  /**
   * Create new audio stream
   * @param {string} streamId - Stream identifier
   * @param {Object} config - Stream configuration
   * @returns {AudioStream}
   */
  createStream(streamId, config = {}) {
    const validation = AudioValidator.validateStreamData({ id: streamId, config });
    if (!validation.valid) {
      throw new Error(`Invalid stream data: ${validation.errors.join(', ')}`);
    }

    const stream = AudioStream.create(streamId, config);
    this._activeStreams.set(streamId, stream);
    return stream;
  }

  /**
   * Start audio stream
   * @param {string} streamId - Stream identifier
   * @param {MediaStream} mediaStream - Browser MediaStream
   * @param {MediaRecorder} mediaRecorder - Browser MediaRecorder
   * @param {AudioContext} audioContext - Browser AudioContext
   * @returns {AudioStream}
   */
  startStream(streamId, mediaStream, mediaRecorder, audioContext) {
    // Validate inputs
    const streamValidation = AudioValidator.validateMediaStream(mediaStream);
    if (!streamValidation.valid) {
      throw new Error(`Invalid MediaStream: ${streamValidation.errors.join(', ')}`);
    }

    const recorderValidation = AudioValidator.validateMediaRecorder(mediaRecorder);
    if (!recorderValidation.valid) {
      throw new Error(`Invalid MediaRecorder: ${recorderValidation.errors.join(', ')}`);
    }

    const contextValidation = AudioValidator.validateAudioContext(audioContext);
    if (!contextValidation.valid) {
      throw new Error(`Invalid AudioContext: ${contextValidation.errors.join(', ')}`);
    }

    // Get or create stream
    let stream = this._activeStreams.get(streamId);
    if (!stream) {
      stream = this.createStream(streamId);
    }

    stream.start(mediaStream, mediaRecorder, audioContext);
    return stream;
  }

  /**
   * Stop audio stream
   * @param {string} streamId - Stream identifier
   * @returns {AudioStream|null}
   */
  stopStream(streamId) {
    const stream = this._activeStreams.get(streamId);
    if (!stream) {
      return null;
    }

    stream.stop();
    return stream;
  }

  /**
   * Update audio level for stream
   * @param {string} streamId - Stream identifier
   * @param {number} level - Audio level (0-1)
   * @returns {AudioStream|null}
   */
  updateAudioLevel(streamId, level) {
    const validation = AudioValidator.validateAudioLevel(level);
    if (!validation.valid) {
      throw new Error(`Invalid audio level: ${validation.errors.join(', ')}`);
    }

    const stream = this._activeStreams.get(streamId);
    if (!stream) {
      return null;
    }

    stream.updateLevel(level);
    return stream;
  }

  /**
   * Get active stream
   * @param {string} streamId - Stream identifier
   * @returns {AudioStream|null}
   */
  getStream(streamId) {
    return this._activeStreams.get(streamId) || null;
  }

  /**
   * Check if stream exists and is active
   * @param {string} streamId - Stream identifier
   * @returns {boolean}
   */
  isStreamActive(streamId) {
    const stream = this._activeStreams.get(streamId);
    return stream ? stream.isActive : false;
  }

  /**
   * Get all active streams
   * @returns {AudioStream[]}
   */
  getActiveStreams() {
    return Array.from(this._activeStreams.values()).filter(s => s.isActive);
  }

  /**
   * Cleanup stream and remove from active streams
   * @param {string} streamId - Stream identifier
   * @returns {boolean} True if cleaned up, false if not found
   */
  cleanupStream(streamId) {
    const stream = this._activeStreams.get(streamId);
    if (!stream) {
      return false;
    }

    stream.cleanup();
    this._activeStreams.delete(streamId);
    return true;
  }

  /**
   * Cleanup all streams
   */
  cleanupAllStreams() {
    for (const [streamId, stream] of this._activeStreams.entries()) {
      try {
        stream.cleanup();
      } catch (e) {
        console.error(`Failed to cleanup stream ${streamId}:`, e);
      }
    }
    this._activeStreams.clear();
  }

  /**
   * Calculate audio level from frequency data
   * @param {Uint8Array} frequencyData - Frequency data from AnalyserNode
   * @returns {number} Audio level (0-1)
   */
  calculateAudioLevel(frequencyData) {
    if (!frequencyData || frequencyData.length === 0) {
      return 0;
    }

    let sum = 0;
    for (let i = 0; i < frequencyData.length; i++) {
      sum += frequencyData[i];
    }
    const average = sum / frequencyData.length;
    return Math.min(average / 255, 1); // Normalize to 0-1
  }

  /**
   * Validate audio chunk before streaming
   * @param {ArrayBuffer|Uint8Array} chunk - Audio chunk
   * @returns {boolean}
   */
  validateChunk(chunk) {
    const validation = AudioValidator.validateAudioChunk(chunk);
    return validation.valid;
  }

  /**
   * Get stream duration
   * @param {string} streamId - Stream identifier
   * @returns {number} Duration in milliseconds, or 0 if not found
   */
  getStreamDuration(streamId) {
    const stream = this._activeStreams.get(streamId);
    return stream ? stream.getDuration() : 0;
  }

  /**
   * Get stream metadata
   * @param {string} streamId - Stream identifier
   * @returns {Object|null}
   */
  getStreamMetadata(streamId) {
    const stream = this._activeStreams.get(streamId);
    return stream ? stream.toJSON() : null;
  }

  /**
   * Get all streams metadata
   * @returns {Object[]}
   */
  getAllStreamsMetadata() {
    return Array.from(this._activeStreams.values()).map(s => s.toJSON());
  }
}

module.exports = { AudioStreamService };

