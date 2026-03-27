'use strict';

/**
 * @.architecture
 * 
 * Incoming: AudioManager constructor, Settings.voice (JSON configuration data), AudioService.updateConfig() --- {method_calls | settings_data, object}
 * Processing: Initialize 3 configuration categories (microphone/tts/general), microphone settings (enabled/pushToTalk/sampleRate=16000/fftSize=256/visualizationEnabled), tts settings (enabled/sampleRate=16000/autoPlay/volume=1.0/queueEnabled), general settings (audioContextSampleRate=16000/enableKeyboardShortcuts/keyboardShortcutKey='Space'/enableTouchControls), generate getUserMedia constraints (sampleRate/echoCancellation/noiseSuppression/autoGainControl), generate AudioContext options, validate settings (sampleRate>0, volume 0-1), update individual categories, convert to/from JSON --- {8 jobs: JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_INITIALIZE, JOB_PARSE_JSON, JOB_STRINGIFY_JSON, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return configuration objects (constraints/options), validation results, JSON representation, AudioConfig instance --- {object | AudioConfig, javascript_object}
 * 
 * PRODUCTION ARCHITECTURE: ScriptProcessorNode with frontend resampling
 * - Capture: ScriptProcessorNode (deprecated but reliable in Electron)
 * - Format: Raw PCM16 (no container, no codec)
 * - Resampling: Frontend 48kHz → 16kHz (averaging-based downsampling)
 * - Transport: WebSocket JSON with Base64-encoded PCM16
 * - Backend: Direct numpy conversion (no ffmpeg/pydub for PCM)
 * 
 * @module domain/audio/models/AudioConfig
 * 
 * AudioConfig Model
 * Represents audio system configuration
 * 
 * Manages audio settings for microphone, TTS, and general audio behavior
 */

class AudioConfig {
  /**
   * @param {Object} data - Audio configuration data
   * @param {Object} data.microphone - Microphone settings
   * @param {Object} data.tts - TTS settings
   * @param {Object} data.general - General audio settings
   */
  constructor(data = {}) {
    this.microphone = {
      enabled: data.microphone?.enabled !== undefined ? data.microphone.enabled : true,
      pushToTalk: data.microphone?.pushToTalk !== undefined ? data.microphone.pushToTalk : true,
      // PRODUCTION: ScriptProcessorNode captures raw PCM, no MediaRecorder
      mimeType: data.microphone?.mimeType || 'audio/wav',  // Unused (legacy MediaRecorder fallback)
      sampleRate: data.microphone?.sampleRate || 16000,  // Target rate (frontend resamples)
      audioBitsPerSecond: data.microphone?.audioBitsPerSecond || 256000,  // Unused
      chunkInterval: data.microphone?.chunkInterval || 1000,  // Unused
      fftSize: data.microphone?.fftSize || 256,
      visualizationEnabled: data.microphone?.visualizationEnabled !== undefined
        ? data.microphone.visualizationEnabled
        : true,
    };

    this.tts = {
      enabled: data.tts?.enabled !== undefined ? data.tts.enabled : true,
      sampleRate: data.tts?.sampleRate || 16000,
      autoPlay: data.tts?.autoPlay !== undefined ? data.tts.autoPlay : true,
      volume: data.tts?.volume !== undefined ? data.tts.volume : 1.0,
      queueEnabled: data.tts?.queueEnabled !== undefined ? data.tts.queueEnabled : true,
    };

    this.general = {
      audioContextSampleRate: data.general?.audioContextSampleRate || 16000,
      enableKeyboardShortcuts: data.general?.enableKeyboardShortcuts !== undefined
        ? data.general.enableKeyboardShortcuts
        : true,
      keyboardShortcutKey: data.general?.keyboardShortcutKey || 'Space',
      enableTouchControls: data.general?.enableTouchControls !== undefined
        ? data.general.enableTouchControls
        : true,
    };
  }

  /**
   * Create default configuration
   * @returns {AudioConfig}
   */
  static createDefault() {
    return new AudioConfig();
  }

  /**
   * Check if microphone is enabled
   * @returns {boolean}
   */
  isMicrophoneEnabled() {
    return this.microphone.enabled;
  }

  /**
   * Check if TTS is enabled
   * @returns {boolean}
   */
  isTTSEnabled() {
    return this.tts.enabled;
  }

  /**
   * Check if push-to-talk mode is enabled
   * @returns {boolean}
   */
  isPushToTalkEnabled() {
    return this.microphone.pushToTalk;
  }

  /**
   * Check if visualization is enabled
   * @returns {boolean}
   */
  isVisualizationEnabled() {
    return this.microphone.visualizationEnabled;
  }

  /**
   * Check if keyboard shortcuts are enabled
   * @returns {boolean}
   */
  areKeyboardShortcutsEnabled() {
    return this.general.enableKeyboardShortcuts;
  }

  /**
   * Get microphone media constraints
   * @returns {Object}
   */
  getMicrophoneConstraints() {
    return {
      audio: {
        sampleRate: this.microphone.sampleRate,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    };
  }

  /**
   * Get MediaRecorder options
   * @returns {Object}
   */
  getMediaRecorderOptions() {
    return {
      mimeType: this.microphone.mimeType,
      audioBitsPerSecond: this.microphone.audioBitsPerSecond,
    };
  }

  /**
   * Get AudioContext options
   * @returns {Object}
   */
  getAudioContextOptions() {
    return {
      sampleRate: this.general.audioContextSampleRate,
    };
  }

  /**
   * Update microphone settings
   * @param {Object} settings - Microphone settings to update
   */
  updateMicrophone(settings) {
    this.microphone = { ...this.microphone, ...settings };
  }

  /**
   * Update TTS settings
   * @param {Object} settings - TTS settings to update
   */
  updateTTS(settings) {
    this.tts = { ...this.tts, ...settings };
  }

  /**
   * Update general settings
   * @param {Object} settings - General settings to update
   */
  updateGeneral(settings) {
    this.general = { ...this.general, ...settings };
  }

  /**
   * Validate configuration
   * @returns {Object} Validation result { valid: boolean, errors: string[] }
   */
  validate() {
    const errors = [];

    // Validate microphone settings
    if (this.microphone.sampleRate <= 0) {
      errors.push('Microphone sample rate must be positive');
    }
    if (this.microphone.audioBitsPerSecond <= 0) {
      errors.push('Microphone audio bits per second must be positive');
    }
    if (this.microphone.chunkInterval <= 0) {
      errors.push('Microphone chunk interval must be positive');
    }

    // Validate TTS settings
    if (this.tts.sampleRate <= 0) {
      errors.push('TTS sample rate must be positive');
    }
    if (this.tts.volume < 0 || this.tts.volume > 1) {
      errors.push('TTS volume must be between 0 and 1');
    }

    // Validate general settings
    if (this.general.audioContextSampleRate <= 0) {
      errors.push('Audio context sample rate must be positive');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Convert to plain object
   * @returns {Object}
   */
  toJSON() {
    return {
      microphone: { ...this.microphone },
      tts: { ...this.tts },
      general: { ...this.general },
    };
  }

  /**
   * Create from plain object
   * @param {Object} json - Plain object
   * @returns {AudioConfig}
   */
  static fromJSON(json) {
    return new AudioConfig(json);
  }
}

module.exports = { AudioConfig };
