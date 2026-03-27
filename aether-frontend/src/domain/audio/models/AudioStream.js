'use strict';

/**
 * @.architecture
 * 
 * Incoming: AudioStreamService.startCapture(), AudioManager.startRecording() (method calls with stream configuration), fromJSON (JSON data) --- {method_calls | json, object | MediaStream | MediaRecorder | AudioContext}
 * Processing: Initialize stream model (id/isActive/MediaStream/MediaRecorder/AudioContext/audioLevel/startedAt/endedAt/config), default config (mimeType='audio/webm'/audioBitsPerSecond=256000/sampleRate=16000/fftSize=256/chunkInterval=100ms), track internal Web Audio API nodes (_analyser AnalyserNode/_source MediaStreamAudioSourceNode), start stream (set browser APIs, mark active, timestamp startedAt), stop stream (mark inactive, timestamp endedAt, reset audioLevel to 0), updateLevel (validate 0-1 range), calculate duration (startedAt → endedAt or now in milliseconds), validate stream (check id/config/mimeType/sampleRate), setAnalyser for audio level monitoring, cleanup resources (stop MediaRecorder, stop all MediaStream tracks, disconnect audio nodes, close AudioContext, clear all references, mark inactive), serialize to JSON (exclude browser APIs, include duration), deserialize from JSON (parse timestamps) --- {11 jobs: JOB_GET_STATE, JOB_DISPOSE, JOB_GET_STATE, JOB_INITIALIZE, JOB_PARSE_JSON, JOB_START, JOB_STOP, JOB_STRINGIFY_JSON, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return AudioStream instances, JSON representation (without browser APIs), duration in milliseconds --- {AudioStream | object | number, javascript_object}
 * 
 * 
 * @module domain/audio/models/AudioStream
 * 
 * AudioStream Model
 * Represents an audio streaming session
 * 
 * Manages microphone capture state and audio stream configuration
 */

class AudioStream {
  /**
   * @param {Object} data - Audio stream data
   * @param {string} data.id - Stream identifier
   * @param {boolean} data.isActive - Stream active state
   * @param {MediaStream|null} data.mediaStream - Browser MediaStream object
   * @param {MediaRecorder|null} data.mediaRecorder - Browser MediaRecorder object
   * @param {AudioContext|null} data.audioContext - Browser AudioContext for analysis
   * @param {number} data.audioLevel - Current audio level (0-1 range)
   * @param {Date} data.startedAt - Stream start time
   * @param {Date|null} data.endedAt - Stream end time
   * @param {Object} data.config - Stream configuration
   */
  constructor(data) {
    this.id = data.id || null;
    this.isActive = data.isActive || false;
    this.mediaStream = data.mediaStream || null;
    this.mediaRecorder = data.mediaRecorder || null; // Legacy fallback
    this.captureNode = data.captureNode || null; // ScriptProcessorNode for production
    this.audioContext = data.audioContext || null;
    this.audioLevel = data.audioLevel || 0;
    this.startedAt = data.startedAt || null;
    this.endedAt = data.endedAt || null;
    this.config = data.config || {
      mimeType: 'audio/webm',
      audioBitsPerSecond: 16000 * 16, // 16kHz, 16-bit
      sampleRate: 16000,
      fftSize: 256,
      chunkInterval: 100, // ms
    };
    
    // Internal state
    this._analyser = null;
    this._source = null;
  }

  /**
   * Create new audio stream instance
   * @param {string} id - Stream identifier
   * @param {Object} config - Optional configuration overrides
   * @returns {AudioStream}
   */
  static create(id, config = {}) {
    return new AudioStream({
      id,
      isActive: false,
      startedAt: new Date(),
      config: { ...new AudioStream({}).config, ...config },
    });
  }

  /**
   * Start stream
   * @param {MediaStream} mediaStream - Browser MediaStream
   * @param {MediaRecorder} mediaRecorder - Browser MediaRecorder
   * @param {AudioContext} audioContext - Browser AudioContext
   */
  start(mediaStream, mediaRecorder, audioContext) {
    this.mediaStream = mediaStream;
    this.mediaRecorder = mediaRecorder;
    this.audioContext = audioContext;
    this.isActive = true;
    this.startedAt = new Date();
    this.endedAt = null;
  }

  /**
   * Stop stream
   */
  stop() {
    this.isActive = false;
    this.endedAt = new Date();
    this.audioLevel = 0;
  }

  /**
   * Update audio level
   * @param {number} level - Audio level (0-1)
   */
  updateLevel(level) {
    if (level >= 0 && level <= 1) {
      this.audioLevel = level;
    }
  }

  /**
   * Get stream duration in milliseconds
   * @returns {number}
   */
  getDuration() {
    if (!this.startedAt) return 0;
    const end = this.endedAt || new Date();
    return end.getTime() - this.startedAt.getTime();
  }

  /**
   * Check if stream is valid
   * @returns {boolean}
   */
  isValid() {
    return (
      this.id !== null &&
      this.config !== null &&
      typeof this.config.mimeType === 'string' &&
      typeof this.config.sampleRate === 'number'
    );
  }

  /**
   * Set analyser and source for audio level monitoring
   * @param {AnalyserNode} analyser - Web Audio API AnalyserNode
   * @param {MediaStreamAudioSourceNode} source - Web Audio API source
   */
  setAnalyser(analyser, source) {
    this._analyser = analyser;
    this._source = source;
  }

  /**
   * Get analyser for audio level monitoring
   * @returns {AnalyserNode|null}
   */
  getAnalyser() {
    return this._analyser;
  }

  /**
   * Clean up stream resources
   */
  cleanup() {
    // Stop media recorder (legacy MediaRecorder fallback)
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch (e) {
        // Already stopped
      }
    }

    // Disconnect ScriptProcessorNode (production audio capture)
    if (this.captureNode) {
      try {
        this.captureNode.disconnect();
        this.captureNode.onaudioprocess = null; // Clear handler
      } catch (e) {
        // Already disconnected
      }
    }

    // Stop media stream tracks
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch (e) {
          // Already stopped
        }
      });
    }

    // Disconnect audio nodes
    if (this._source) {
      try {
        this._source.disconnect();
      } catch (e) {
        // Already disconnected
      }
    }

    if (this._analyser) {
      try {
        this._analyser.disconnect();
      } catch (e) {
        // Already disconnected
      }
    }

    // Close audio context
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch (e) {
        // Already closed
      }
    }

    // Clear references
    this.mediaRecorder = null;
    this.mediaStream = null;
    this.audioContext = null;
    this._analyser = null;
    this._source = null;
    this.isActive = false;
  }

  /**
   * Convert to plain object
   * @returns {Object}
   */
  toJSON() {
    return {
      id: this.id,
      isActive: this.isActive,
      audioLevel: this.audioLevel,
      startedAt: this.startedAt?.toISOString() || null,
      endedAt: this.endedAt?.toISOString() || null,
      duration: this.getDuration(),
      config: this.config,
    };
  }

  /**
   * Create from plain object
   * @param {Object} json - Plain object
   * @returns {AudioStream}
   */
  static fromJSON(json) {
    return new AudioStream({
      id: json.id,
      isActive: json.isActive,
      audioLevel: json.audioLevel,
      startedAt: json.startedAt ? new Date(json.startedAt) : null,
      endedAt: json.endedAt ? new Date(json.endedAt) : null,
      config: json.config,
    });
  }
}

module.exports = { AudioStream };
