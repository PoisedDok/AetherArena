'use strict';

/**
 * @.architecture
 * 
 * Incoming: UIManager.startMicrophone/stopMicrophone(), MessageManager.handleTTSAudio(), Backend WebSocket (TTS audio/STT transcriptions), MediaRecorder dataavailable events (Blob audio chunks), requestAnimationFrame callbacks (visualization loop), constructor dependencies (eventBus/endpoint/config) --- {method_calls | stream_types.tts_audio | stream_types.stt_result | browser_event, object | ArrayBuffer | Blob}
 * Processing: Initialize (validate AudioConfig, set initialized flag), check microphone availability (getUserMedia test, stop tracks), start microphone (generate stream ID, getUserMedia with constraints, create AudioContext, create AnalyserNode with config.fftSize, create MediaRecorder with config options, setup dataavailable handler, start recording at chunkInterval, delegate startStream to AudioStreamService, start visualization requestAnimationFrame loop, emit event, notify backend via endpoint.connection.send({role:'user',start:true})), stop microphone (cancelAnimationFrame, delegate stopStream to AudioStreamService, cleanup stream resources, emit event with duration, notify backend {role:'user',end:true}), handle audio data (convert Blob to ArrayBuffer, validate chunk via AudioStreamService, send via endpoint.streamAudio(), emit event with size), start visualization (get AnalyserNode, requestAnimationFrame loop, getByteFrequencyData(), calculate audio level via AudioStreamService, update stream level, emit event), handle TTS audio (enqueue via TTSService, emit event, start playback if not playing and autoPlay enabled), play next TTS (dequeue from TTSService, create AudioContext, decodeAudioData(), create BufferSourceNode, apply volume via GainNode, setup onended handler for queue continuation, start source), stop TTS (delegate to TTSService, emit event), clear TTS queue (delegate to TTSService, emit event), handle STT partial/final (delegate to STTService, emit event with trimmed text and confidence), get status (delegate to services for stream/TTS/STT statistics), update config (update microphone/tts/general categories, validate, emit event), cleanup (cleanup all streams/TTS/STT via services, cancel visualization, reset state, emit event) --- {15 jobs: JOB_GET_STATE, JOB_GET_STATE, JOB_DISPOSE, JOB_PARSE_JSON, JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT, JOB_HTTP_REQUEST, JOB_INITIALIZE, JOB_UPDATE_STATE, JOB_START, JOB_STOP, JOB_WS_SEND, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: AudioStreamService/TTSService/STTService method calls (orchestration delegation), EventBus.emit() (15 event types: stream-started/stopped, chunk-sent, error, level-updated, tts-queued/started/completed/error/stopped/queue-empty/queue-cleared, stt-partial/final, config-updated, cleanup-complete), endpoint.connection.send() (start/end notifications), endpoint.streamAudio() (audio chunks), return stream ID/status/statistics --- {method_calls | events | http_request, string | object}
 * 
 * 
 * @module domain/audio/services/AudioManager
 * 
 * AudioManager Service
 * High-level orchestrator for audio domain operations
 * 
 * Coordinates audio streaming, TTS playback, and STT processing
 * This is the main entry point for audio operations
 */

const { AudioConfig } = require('../models/AudioConfig');
const { AudioStreamService } = require('./AudioStreamService');
const { TTSService } = require('./TTSService');
const { STTService } = require('./STTService');
const { AudioValidator } = require('../validators/AudioValidator');

class AudioManager {
  /**
   * @param {Object} dependencies - Injected dependencies
   * @param {Object} dependencies.eventBus - Event bus for pub/sub
   * @param {Object} dependencies.endpoint - Backend endpoint for audio streaming
   * @param {AudioConfig} dependencies.config - Audio configuration
   */
  constructor(dependencies = {}) {
    this.eventBus = dependencies.eventBus || null;
    this.endpoint = dependencies.endpoint || null;
    this.config = dependencies.config || AudioConfig.createDefault();

    // Initialize services
    this.streamService = new AudioStreamService();
    this.ttsService = new TTSService();
    this.sttService = new STTService();

    // State
    this._initialized = false;
    this._currentStreamId = null;
    this._visualizationFrameId = null;
  }

  /**
   * Initialize audio manager
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this._initialized) {
      return;
    }

    // Validate configuration
    const validation = this.config.validate();
    if (!validation.valid) {
      throw new Error(`Invalid audio configuration: ${validation.errors.join(', ')}`);
    }

    this._initialized = true;
  }

  /**
   * Check if microphone is available
   * @returns {Promise<boolean>}
   */
  async checkMicrophoneAvailability() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      return true;
    } catch (error) {
      console.error('Microphone not available:', error);
      return false;
    }
  }

  /**
   * Start microphone capture
   * @param {Object} options - Optional overrides
   * @returns {Promise<string>} Stream ID
   */
  async startMicrophone(options = {}) {
    if (!this._initialized) {
      throw new Error('AudioManager not initialized');
    }

    if (!this.config.isMicrophoneEnabled()) {
      throw new Error('Microphone is disabled in configuration');
    }

    // Generate stream ID
    const streamId = options.streamId || `stream-${Date.now()}`;

    // Get user media
    const constraints = this.config.getMicrophoneConstraints();
    const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

    // Create audio context for analysis
    const audioContext = new (window.AudioContext || window.webkitAudioContext)(
      this.config.getAudioContextOptions()
    );
    const source = audioContext.createMediaStreamSource(mediaStream);

    // Create analyser for audio level monitoring
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = this.config.microphone.fftSize;
    source.connect(analyser);

    // Create media recorder
    const recorderOptions = this.config.getMediaRecorderOptions();
    const mediaRecorder = new MediaRecorder(mediaStream, recorderOptions);

    // Setup data handler
    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        this._handleAudioData(streamId, event.data);
      }
    });

    // Start recording
    mediaRecorder.start(this.config.microphone.chunkInterval);

    // Create stream in service
    const stream = this.streamService.startStream(streamId, mediaStream, mediaRecorder, audioContext);
    stream.setAnalyser(analyser, source);

    this._currentStreamId = streamId;

    // Start visualization if enabled
    if (this.config.isVisualizationEnabled()) {
      this._startVisualization(streamId);
    }

    // Emit event
    if (this.eventBus) {
      this.eventBus.emit('audio:stream-started', { streamId });
    }

    // Notify backend
    if (this.endpoint) {
      this.endpoint.connection.send({
        role: 'user',
        start: true,
      });
    }

    return streamId;
  }

  /**
   * Stop microphone capture
   * @param {string} streamId - Stream identifier (optional, uses current if not provided)
   * @returns {Promise<void>}
   */
  async stopMicrophone(streamId = null) {
    const targetStreamId = streamId || this._currentStreamId;
    
    if (!targetStreamId) {
      return;
    }

    // Stop visualization
    if (this._visualizationFrameId) {
      cancelAnimationFrame(this._visualizationFrameId);
      this._visualizationFrameId = null;
    }

    // Stop stream
    const stream = this.streamService.stopStream(targetStreamId);
    
    if (stream) {
      // Cleanup stream resources
      this.streamService.cleanupStream(targetStreamId);

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('audio:stream-stopped', { 
          streamId: targetStreamId,
          duration: stream.getDuration(),
        });
      }
    }

    // Notify backend
    if (this.endpoint) {
      this.endpoint.connection.send({
        role: 'user',
        end: true,
      });
    }

    // Clear current stream if it matches
    if (this._currentStreamId === targetStreamId) {
      this._currentStreamId = null;
    }
  }

  /**
   * Handle audio data from MediaRecorder
   * @private
   * @param {string} streamId - Stream identifier
   * @param {Blob} blob - Audio data blob
   */
  async _handleAudioData(streamId, blob) {
    try {
      const arrayBuffer = await blob.arrayBuffer();
      
      // Validate chunk
      if (!this.streamService.validateChunk(arrayBuffer)) {
        console.error('Invalid audio chunk, skipping');
        return;
      }

      // Send to backend if stream is still active
      if (this.streamService.isStreamActive(streamId) && this.endpoint) {
        this.endpoint.streamAudio(arrayBuffer);
      }

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('audio:chunk-sent', {
          streamId,
          size: arrayBuffer.byteLength,
        });
      }
    } catch (error) {
      console.error('Error handling audio data:', error);
      if (this.eventBus) {
        this.eventBus.emit('audio:error', { streamId, error });
      }
    }
  }

  /**
   * Start audio level visualization
   * @private
   * @param {string} streamId - Stream identifier
   */
  _startVisualization(streamId) {
    const stream = this.streamService.getStream(streamId);
    if (!stream) {
      return;
    }

    const analyser = stream.getAnalyser();
    if (!analyser) {
      return;
    }

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const updateVisualization = () => {
      if (!this.streamService.isStreamActive(streamId)) {
        return;
      }

      analyser.getByteFrequencyData(dataArray);
      
      // Calculate audio level
      const level = this.streamService.calculateAudioLevel(dataArray);
      
      // Update stream level
      this.streamService.updateAudioLevel(streamId, level);

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('audio:level-updated', { streamId, level });
      }

      // Request next frame
      this._visualizationFrameId = requestAnimationFrame(updateVisualization);
    };

    updateVisualization();
  }

  /**
   * Handle incoming TTS audio
   * @param {ArrayBuffer|Uint8Array} audioData - Raw audio data
   * @param {Object} options - Optional metadata
   * @returns {Promise<void>}
   */
  async handleTTSAudio(audioData, options = {}) {
    if (!this.config.isTTSEnabled()) {
      return;
    }

    try {
      // Add to queue
      const ttsAudio = this.ttsService.enqueue(audioData, options);

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('audio:tts-queued', { audioId: ttsAudio.id });
      }

      // Start playback if not already playing
      if (!this.ttsService.isPlaying() && this.config.tts.autoPlay) {
        await this.playNextTTS();
      }
    } catch (error) {
      console.error('Error handling TTS audio:', error);
      if (this.eventBus) {
        this.eventBus.emit('audio:error', { error });
      }
    }
  }

  /**
   * Play next TTS audio from queue
   * @returns {Promise<void>}
   */
  async playNextTTS() {
    if (this.ttsService.isPlaying()) {
      return;
    }

    const audio = this.ttsService.dequeue();
    if (!audio) {
      if (this.eventBus) {
        this.eventBus.emit('audio:tts-queue-empty');
      }
      return;
    }

    try {
      // Mark as playing
      this.ttsService.startPlayback(audio);

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('audio:tts-started', { audioId: audio.id });
      }

      // Create audio context if not exists
      const audioContext = new (window.AudioContext || window.webkitAudioContext)(
        this.config.getAudioContextOptions()
      );

      // Decode audio data
      const arrayBuffer = audio.getArrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      audio.setDecodedBuffer(audioBuffer);

      // Create source and play
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      
      // Apply volume
      if (this.config.tts.volume !== 1.0) {
        const gainNode = audioContext.createGain();
        gainNode.gain.value = this.config.tts.volume;
        source.connect(gainNode);
        gainNode.connect(audioContext.destination);
      }

      // Setup completion handler
      source.onended = () => {
        this.ttsService.completePlayback(audio);
        
        if (this.eventBus) {
          this.eventBus.emit('audio:tts-completed', { audioId: audio.id });
        }

        // Play next in queue
        if (this.config.tts.queueEnabled) {
          this.playNextTTS();
        }
      };

      source.start(0);

    } catch (error) {
      console.error('Error playing TTS audio:', error);
      this.ttsService.failPlayback(audio, error);
      
      if (this.eventBus) {
        this.eventBus.emit('audio:tts-error', { audioId: audio.id, error });
      }

      // Try next in queue
      if (this.config.tts.queueEnabled) {
        this.playNextTTS();
      }
    }
  }

  /**
   * Stop current TTS playback
   */
  stopTTS() {
    const audio = this.ttsService.stopCurrent();
    
    if (audio && this.eventBus) {
      this.eventBus.emit('audio:tts-stopped', { audioId: audio.id });
    }
  }

  /**
   * Clear TTS queue
   */
  clearTTSQueue() {
    this.ttsService.clearQueue();
    
    if (this.eventBus) {
      this.eventBus.emit('audio:tts-queue-cleared');
    }
  }

  /**
   * Handle STT partial result
   * @param {string} streamId - Stream identifier
   * @param {string} text - Transcribed text
   * @param {Object} options - Optional metadata
   */
  handleSTTPartial(streamId, text, options = {}) {
    try {
      const result = this.sttService.processPartial(streamId, text, options);
      
      if (this.eventBus) {
        this.eventBus.emit('audio:stt-partial', {
          streamId,
          text: result.getTrimmedText(),
          confidence: result.confidence,
        });
      }
    } catch (error) {
      console.error('Error handling STT partial:', error);
    }
  }

  /**
   * Handle STT final result
   * @param {string} streamId - Stream identifier
   * @param {string} text - Transcribed text
   * @param {Object} options - Optional metadata
   */
  handleSTTFinal(streamId, text, options = {}) {
    try {
      const result = this.sttService.processFinal(streamId, text, options);
      
      if (this.eventBus) {
        this.eventBus.emit('audio:stt-final', {
          streamId,
          text: result.getTrimmedText(),
          confidence: result.confidence,
        });
      }
    } catch (error) {
      console.error('Error handling STT final:', error);
    }
  }

  /**
   * Get current stream status
   * @returns {Object|null}
   */
  getCurrentStreamStatus() {
    if (!this._currentStreamId) {
      return null;
    }

    return this.streamService.getStreamMetadata(this._currentStreamId);
  }

  /**
   * Get TTS queue status
   * @returns {Object}
   */
  getTTSStatus() {
    return this.ttsService.getStatistics();
  }

  /**
   * Get STT statistics
   * @param {string} streamId - Stream identifier (optional)
   * @returns {Object}
   */
  getSTTStatistics(streamId = null) {
    if (streamId) {
      return this.sttService.getStreamStatistics(streamId);
    }
    return this.sttService.getGlobalStatistics();
  }

  /**
   * Update configuration
   * @param {Object} updates - Configuration updates
   */
  updateConfig(updates) {
    if (updates.microphone) {
      this.config.updateMicrophone(updates.microphone);
    }
    if (updates.tts) {
      this.config.updateTTS(updates.tts);
    }
    if (updates.general) {
      this.config.updateGeneral(updates.general);
    }

    // Validate updated config
    const validation = this.config.validate();
    if (!validation.valid) {
      throw new Error(`Invalid configuration update: ${validation.errors.join(', ')}`);
    }

    if (this.eventBus) {
      this.eventBus.emit('audio:config-updated', { config: this.config.toJSON() });
    }
  }

  /**
   * Cleanup and release all resources
   */
  cleanup() {
    // Stop all streams
    this.streamService.cleanupAllStreams();

    // Clear TTS
    this.ttsService.cleanup();

    // Clear STT
    this.sttService.cleanup();

    // Cancel visualization
    if (this._visualizationFrameId) {
      cancelAnimationFrame(this._visualizationFrameId);
      this._visualizationFrameId = null;
    }

    this._currentStreamId = null;
    this._initialized = false;

    if (this.eventBus) {
      this.eventBus.emit('audio:cleanup-complete');
    }
  }
}

module.exports = { AudioManager };

