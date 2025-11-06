'use strict';

/**
 * @.architecture
 * 
 * Incoming: AudioManager method calls (enqueue/dequeue/peek/getQueueLength/isQueueEmpty/clearQueue/startPlayback/completePlayback/failPlayback/isPlaying/getCurrentAudio/setDecodedBuffer/getStatistics/getHistory/getQueueMetadata/removeFromQueue/stopCurrent/cleanup), binary audio data (ArrayBuffer/Uint8Array), options objects, audio IDs, decoded AudioBuffer, Error objects --- {method_calls, ArrayBuffer | Uint8Array | object | string | AudioBuffer | Error}
 * Processing: Maintain state (_queue: TTSAudio[], _isPlaying: boolean, _currentAudio: TTSAudio|null, _playbackHistory: TTSAudio[], _maxHistorySize=50), enqueue (validate via AudioValidator.validateTTSData, create TTSAudio.create(), push to _queue), dequeue (shift from _queue, return null if empty), peek (return first without removing), getQueueLength (_queue.length), isQueueEmpty (_queue.length===0), clearQueue (mark all pending as error 'Playback cancelled', reset _queue to []), startPlayback (validate audio exists, set _isPlaying=true, set _currentAudio, call audio.markPlaying()), completePlayback (set _isPlaying=false, call audio.markPlayed(), add to history, clear _currentAudio if matches), failPlayback (set _isPlaying=false, call audio.markError(error), add to history, clear _currentAudio if matches), isPlaying (return _isPlaying), getCurrentAudio (return _currentAudio), setDecodedBuffer (find by ID in _currentAudio or _queue, call audio.setDecodedBuffer(buffer)), getStatistics (filter history by status played/error, reduce sum duration, return 7 metrics: queueLength/isPlaying/historySize/totalPlayed/totalErrors/totalDuration/currentAudioId), getHistory (slice last N, map to toJSON(), reverse), _addToHistory (push to _playbackHistory, trim if >maxHistorySize via shift + cleanup), getQueueMetadata (map _queue to toJSON()), removeFromQueue (findIndex by ID, splice, cleanup removed), stopCurrent (mark as error 'Playback stopped by user', set _isPlaying=false, clear _currentAudio, add to history), cleanup (stop current, cleanup all queue items, cleanup all history items, reset all state) --- {13 jobs: JOB_GET_STATE, JOB_DISPOSE, JOB_CLEAR_STATE, JOB_GET_STATE, JOB_UPDATE_STATE, JOB_GET_STATE, JOB_INITIALIZE, JOB_UPDATE_STATE, JOB_STRINGIFY_JSON, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return TTSAudio instances, arrays, metadata objects, statistics, booleans, numbers, null, AudioValidator method calls --- {TTSAudio | array | object | boolean | number | null, javascript_object}
 * 
 * 
 * @module domain/audio/services/TTSService
 * 
 * TTSService
 * Business logic for text-to-speech playback
 * 
 * Handles TTS audio queue, playback coordination, and state management
 * Pure business logic - no DOM dependencies
 */

const { TTSAudio } = require('../models/TTSAudio');
const { AudioValidator } = require('../validators/AudioValidator');

class TTSService {
  constructor() {
    this._queue = [];
    this._isPlaying = false;
    this._currentAudio = null;
    this._playbackHistory = [];
    this._maxHistorySize = 50;
  }

  /**
   * Add TTS audio to queue
   * @param {ArrayBuffer|Uint8Array} audioData - Raw audio data
   * @param {Object} options - Optional metadata
   * @returns {TTSAudio}
   */
  enqueue(audioData, options = {}) {
    const validation = AudioValidator.validateTTSData({ audioData });
    if (!validation.valid) {
      throw new Error(`Invalid TTS audio data: ${validation.errors.join(', ')}`);
    }

    const ttsAudio = TTSAudio.create(audioData, options);
    this._queue.push(ttsAudio);
    return ttsAudio;
  }

  /**
   * Get next audio from queue
   * @returns {TTSAudio|null}
   */
  dequeue() {
    if (this._queue.length === 0) {
      return null;
    }
    return this._queue.shift();
  }

  /**
   * Peek at next audio without removing
   * @returns {TTSAudio|null}
   */
  peek() {
    return this._queue.length > 0 ? this._queue[0] : null;
  }

  /**
   * Get queue length
   * @returns {number}
   */
  getQueueLength() {
    return this._queue.length;
  }

  /**
   * Check if queue is empty
   * @returns {boolean}
   */
  isQueueEmpty() {
    return this._queue.length === 0;
  }

  /**
   * Clear queue
   */
  clearQueue() {
    // Mark all queued items as cancelled
    this._queue.forEach(audio => {
      if (audio.status === 'pending') {
        audio.markError(new Error('Playback cancelled'));
      }
    });
    this._queue = [];
  }

  /**
   * Mark playback as started
   * @param {TTSAudio} audio - Audio being played
   */
  startPlayback(audio) {
    if (!audio) {
      throw new Error('Audio is required');
    }

    this._isPlaying = true;
    this._currentAudio = audio;
    audio.markPlaying();
  }

  /**
   * Mark playback as completed
   * @param {TTSAudio} audio - Audio that finished playing
   */
  completePlayback(audio) {
    if (!audio) {
      throw new Error('Audio is required');
    }

    this._isPlaying = false;
    audio.markPlayed();
    
    // Add to history
    this._addToHistory(audio);
    
    // Clear current if it matches
    if (this._currentAudio?.id === audio.id) {
      this._currentAudio = null;
    }
  }

  /**
   * Mark playback as failed
   * @param {TTSAudio} audio - Audio that failed
   * @param {Error} error - Error that occurred
   */
  failPlayback(audio, error) {
    if (!audio) {
      throw new Error('Audio is required');
    }

    this._isPlaying = false;
    audio.markError(error);
    
    // Add to history
    this._addToHistory(audio);
    
    // Clear current if it matches
    if (this._currentAudio?.id === audio.id) {
      this._currentAudio = null;
    }
  }

  /**
   * Check if currently playing
   * @returns {boolean}
   */
  isPlaying() {
    return this._isPlaying;
  }

  /**
   * Get current audio
   * @returns {TTSAudio|null}
   */
  getCurrentAudio() {
    return this._currentAudio;
  }

  /**
   * Set decoded buffer for audio
   * @param {string} audioId - Audio identifier
   * @param {AudioBuffer} buffer - Decoded AudioBuffer
   * @returns {TTSAudio|null}
   */
  setDecodedBuffer(audioId, buffer) {
    // Check current audio
    if (this._currentAudio?.id === audioId) {
      this._currentAudio.setDecodedBuffer(buffer);
      return this._currentAudio;
    }

    // Check queue
    const audio = this._queue.find(a => a.id === audioId);
    if (audio) {
      audio.setDecodedBuffer(buffer);
      return audio;
    }

    return null;
  }

  /**
   * Get playback statistics
   * @returns {Object}
   */
  getStatistics() {
    const played = this._playbackHistory.filter(a => a.status === 'played').length;
    const errors = this._playbackHistory.filter(a => a.status === 'error').length;
    const totalDuration = this._playbackHistory.reduce((sum, a) => sum + a.estimateDuration(), 0);

    return {
      queueLength: this._queue.length,
      isPlaying: this._isPlaying,
      historySize: this._playbackHistory.length,
      totalPlayed: played,
      totalErrors: errors,
      totalDuration,
      currentAudioId: this._currentAudio?.id || null,
    };
  }

  /**
   * Get playback history
   * @param {number} limit - Maximum number of items to return
   * @returns {Object[]}
   */
  getHistory(limit = 10) {
    return this._playbackHistory
      .slice(-limit)
      .map(a => a.toJSON())
      .reverse();
  }

  /**
   * Add audio to history
   * @private
   * @param {TTSAudio} audio - Audio to add
   */
  _addToHistory(audio) {
    this._playbackHistory.push(audio);
    
    // Trim history if too large
    if (this._playbackHistory.length > this._maxHistorySize) {
      const removed = this._playbackHistory.shift();
      removed.cleanup();
    }
  }

  /**
   * Get queue metadata
   * @returns {Object[]}
   */
  getQueueMetadata() {
    return this._queue.map(a => a.toJSON());
  }

  /**
   * Remove specific audio from queue
   * @param {string} audioId - Audio identifier
   * @returns {boolean} True if removed, false if not found
   */
  removeFromQueue(audioId) {
    const index = this._queue.findIndex(a => a.id === audioId);
    if (index === -1) {
      return false;
    }

    const removed = this._queue.splice(index, 1)[0];
    removed.cleanup();
    return true;
  }

  /**
   * Stop current playback
   * @returns {TTSAudio|null} The audio that was stopped
   */
  stopCurrent() {
    if (!this._currentAudio) {
      return null;
    }

    const audio = this._currentAudio;
    audio.markError(new Error('Playback stopped by user'));
    this._isPlaying = false;
    this._currentAudio = null;
    this._addToHistory(audio);
    
    return audio;
  }

  /**
   * Cleanup all resources
   */
  cleanup() {
    // Stop current playback
    if (this._currentAudio) {
      this.stopCurrent();
    }

    // Clear and cleanup queue
    this._queue.forEach(audio => audio.cleanup());
    this._queue = [];

    // Cleanup history
    this._playbackHistory.forEach(audio => audio.cleanup());
    this._playbackHistory = [];

    this._isPlaying = false;
    this._currentAudio = null;
  }
}

module.exports = { TTSService };

