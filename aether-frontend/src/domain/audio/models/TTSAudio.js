'use strict';

/**
 * @.architecture
 * 
 * Incoming: TTSService.handleAudioChunk(), WebSocket/HTTP TTS responses (binary audio data ArrayBuffer/Uint8Array), fromJSON (JSON metadata) --- {stream_types.tts_audio | json, ArrayBuffer | Uint8Array | object}
 * Processing: Initialize TTS audio model (id/audioData/text/sampleRate=16000/format='pcm'/receivedAt/status='pending'/decodedBuffer/error), factory create with auto-generated ID (tts-timestamp-random), convert Uint8Array to ArrayBuffer (getArrayBuffer), calculate size in bytes (byteLength), status lifecycle (markPlaying→'playing', markPlayed→'played', markError→'error'), store decoded AudioBuffer (setDecodedBuffer), state checks (isReadyToPlay=audioData exists+status='pending'+no error, isPlaying, hasPlayed, hasError), estimate duration in seconds (size / bytesPerSample*channels / sampleRate, assumes 16-bit mono), serialize to JSON (exclude binary audioData/decodedBuffer, include size/duration/hasError/errorMessage), deserialize from JSON (metadata only, no audio data), cleanup resources (clear audioData/decodedBuffer/error) --- {9 jobs: JOB_GET_STATE, JOB_DISPOSE, JOB_PARSE_JSON, JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_INITIALIZE, JOB_PARSE_JSON, JOB_STRINGIFY_JSON, JOB_UPDATE_STATE}
 * Outgoing: Return TTSAudio instances, JSON representation (without binary data), duration estimate, size in bytes --- {TTSAudio | object | number, javascript_object}
 * 
 * 
 * @module domain/audio/models/TTSAudio
 * 
 * TTSAudio Model
 * Represents a text-to-speech audio chunk
 * 
 * Manages TTS audio data and playback state
 */

class TTSAudio {
  /**
   * @param {Object} data - TTS audio data
   * @param {string} data.id - Audio chunk identifier
   * @param {ArrayBuffer|Uint8Array} data.audioData - Raw audio data
   * @param {string} data.text - Text that was converted to speech
   * @param {number} data.sampleRate - Audio sample rate
   * @param {string} data.format - Audio format (pcm, wav, mp3)
   * @param {Date} data.receivedAt - Time audio was received
   * @param {string} data.status - Playback status (pending|playing|played|error)
   * @param {AudioBuffer|null} data.decodedBuffer - Decoded AudioBuffer
   * @param {Error|null} data.error - Error if decoding failed
   */
  constructor(data) {
    this.id = data.id || null;
    this.audioData = data.audioData || null;
    this.text = data.text || '';
    this.sampleRate = data.sampleRate || 16000;
    this.format = data.format || 'pcm';
    this.receivedAt = data.receivedAt || new Date();
    this.status = data.status || 'pending';
    this.decodedBuffer = data.decodedBuffer || null;
    this.error = data.error || null;
  }

  /**
   * Create TTS audio from raw data
   * @param {ArrayBuffer|Uint8Array} audioData - Raw audio bytes
   * @param {Object} options - Optional metadata
   * @returns {TTSAudio}
   */
  static create(audioData, options = {}) {
    const id = options.id || `tts-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return new TTSAudio({
      id,
      audioData,
      text: options.text || '',
      sampleRate: options.sampleRate || 16000,
      format: options.format || 'pcm',
      receivedAt: new Date(),
      status: 'pending',
    });
  }

  /**
   * Get audio data as ArrayBuffer
   * @returns {ArrayBuffer}
   */
  getArrayBuffer() {
    if (this.audioData instanceof ArrayBuffer) {
      return this.audioData;
    }
    if (this.audioData instanceof Uint8Array) {
      return this.audioData.buffer;
    }
    throw new Error('Invalid audio data format');
  }

  /**
   * Get audio data size in bytes
   * @returns {number}
   */
  getSize() {
    if (this.audioData instanceof ArrayBuffer) {
      return this.audioData.byteLength;
    }
    if (this.audioData instanceof Uint8Array) {
      return this.audioData.byteLength;
    }
    return 0;
  }

  /**
   * Mark as playing
   */
  markPlaying() {
    this.status = 'playing';
  }

  /**
   * Mark as played
   */
  markPlayed() {
    this.status = 'played';
  }

  /**
   * Mark as error
   * @param {Error} error - Error that occurred
   */
  markError(error) {
    this.status = 'error';
    this.error = error;
  }

  /**
   * Set decoded buffer
   * @param {AudioBuffer} buffer - Decoded AudioBuffer
   */
  setDecodedBuffer(buffer) {
    this.decodedBuffer = buffer;
  }

  /**
   * Check if audio is ready to play
   * @returns {boolean}
   */
  isReadyToPlay() {
    return (
      this.audioData !== null &&
      this.status === 'pending' &&
      this.error === null
    );
  }

  /**
   * Check if audio is currently playing
   * @returns {boolean}
   */
  isPlaying() {
    return this.status === 'playing';
  }

  /**
   * Check if audio has been played
   * @returns {boolean}
   */
  hasPlayed() {
    return this.status === 'played';
  }

  /**
   * Check if audio has error
   * @returns {boolean}
   */
  hasError() {
    return this.status === 'error' || this.error !== null;
  }

  /**
   * Get duration estimate in seconds (rough estimate based on size)
   * @returns {number}
   */
  estimateDuration() {
    const size = this.getSize();
    const bytesPerSample = 2; // 16-bit
    const channels = 1; // mono
    const samples = size / (bytesPerSample * channels);
    return samples / this.sampleRate;
  }

  /**
   * Convert to plain object
   * @returns {Object}
   */
  toJSON() {
    return {
      id: this.id,
      text: this.text,
      sampleRate: this.sampleRate,
      format: this.format,
      receivedAt: this.receivedAt?.toISOString() || null,
      status: this.status,
      size: this.getSize(),
      duration: this.estimateDuration(),
      hasError: this.hasError(),
      errorMessage: this.error?.message || null,
    };
  }

  /**
   * Create from plain object (without audio data)
   * @param {Object} json - Plain object
   * @returns {TTSAudio}
   */
  static fromJSON(json) {
    return new TTSAudio({
      id: json.id,
      text: json.text,
      sampleRate: json.sampleRate,
      format: json.format,
      receivedAt: json.receivedAt ? new Date(json.receivedAt) : null,
      status: json.status,
      error: json.errorMessage ? new Error(json.errorMessage) : null,
    });
  }

  /**
   * Clean up resources
   */
  cleanup() {
    this.audioData = null;
    this.decodedBuffer = null;
    this.error = null;
  }
}

module.exports = { TTSAudio };
