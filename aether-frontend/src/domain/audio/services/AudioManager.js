'use strict';

/**
 * @.architecture
 * 
 * Incoming: UIManager.startMicrophone/stopMicrophone(), MessageManager.handleTTSAudio(), Backend WebSocket (TTS audio/STT transcriptions), MediaRecorder dataavailable events (Blob audio chunks), requestAnimationFrame callbacks (visualization loop), constructor dependencies (eventBus/endpoint/config) --- {method_calls | stream_types.tts_audio | stream_types.stt_result | browser_event, object | ArrayBuffer | Blob}
 * Processing: Initialize (validate AudioConfig, set initialized flag), check microphone availability (getUserMedia test, stop tracks), start microphone (generate stream ID, getUserMedia with constraints, create AudioContext, create AnalyserNode with config.fftSize, create MediaRecorder with config options, setup dataavailable handler, start recording at chunkInterval, delegate startStream to AudioStreamService, start visualization requestAnimationFrame loop, emit event, notify backend via endpoint.connection.send({role:'user',start:true})), stop microphone (cancelAnimationFrame, delegate stopStream to AudioStreamService, cleanup stream resources, emit event with duration, notify backend {role:'user',end:true}), handle audio data (convert Blob to ArrayBuffer, validate chunk via AudioStreamService, send via endpoint.streamAudio(), emit event with size), start visualization (get AnalyserNode, requestAnimationFrame loop, getByteFrequencyData(), calculate audio level via AudioStreamService, update stream level, emit event), handle TTS audio (enqueue via TTSService, emit event, start playback if not playing and autoPlay enabled), play next TTS (dequeue from TTSService, create AudioContext, decodeAudioData(), create BufferSourceNode, apply volume via GainNode, setup onended handler for queue continuation, start source), stop TTS (delegate to TTSService, emit event), clear TTS queue (delegate to TTSService, emit event), handle STT partial/final (delegate to STTService, emit event with trimmed text and confidence), get status (delegate to services for stream/TTS/STT statistics), update config (update microphone/tts/general categories, validate, emit event), cleanup (cleanup all streams/TTS/STT via services, cancel visualization, reset state, emit event) --- {9 jobs: JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_START, JOB_STOP, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: AudioStreamService/TTSService/STTService method calls (orchestration delegation), EventBus.emit() (15 event types: stream-started/stopped, chunk-sent, error, level-updated, tts-queued/started/completed/error/stopped/queue-empty/queue-cleared, stt-partial/final, config-updated, cleanup-complete), endpoint.connection.send() (start/end notifications via delegation), endpoint.streamAudio() (audio chunks via delegation), return stream ID/status/statistics --- {method_calls | events, string | object}
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

class AudioManager {
  /**
   * @param {Object} dependencies - Injected dependencies
   * @param {Object} dependencies.eventBus - Event bus for pub/sub
   * @param {Object} dependencies.endpoint - Backend endpoint for audio streaming
   * @param {AudioConfig} dependencies.config - Audio configuration
   */
  constructor(dependencies = {}) {
    const noop = () => {};
    const noopLog = { trace: noop, debug: noop, info: noop, warn: noop, error: noop };
    this.logger = dependencies.logger || noopLog;
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

    // TTS playback resource tracking (for stopTTS to actually stop audio output)
    this._ttsSource = null;
    this._ttsAudioContext = null;
    this._ttsStoppedByUser = false;
  }

  /**
   * Initialize audio manager
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      if (this._initialized) {
        return;
      }

      const validation = this.config.validate();
      if (!validation.valid) {
        throw new Error(`Invalid audio configuration: ${validation.errors.join(', ')}`);
      }

      this._initialized = true;
    } catch (error) {
      this.logger.error('initialize failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Check if microphone is available
   * @returns {Promise<boolean>}
   */
  async checkMicrophoneAvailability() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return false;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      return true;
    } catch (error) {
      this.logger.error('microphone not available', { error: error.message });
      return false;
    }
  }

  /**
   * Start microphone capture
   * @param {Object} options - Optional overrides
   * @returns {Promise<string>} Stream ID
   */
  async startMicrophone(options = {}) {
    try {
      if (!this._initialized) {
        throw new Error('AudioManager not initialized');
      }

      if (!this.config.isMicrophoneEnabled()) {
        throw new Error('Microphone is disabled in configuration');
      }

      const streamId = options.streamId || `stream-${Date.now()}`;

      const constraints = this.config.getMicrophoneConstraints();
      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

      const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error('AudioContext is not available in this environment');
      }
      const audioContext = new AudioContextCtor(this.config.getAudioContextOptions());
      const source = audioContext.createMediaStreamSource(mediaStream);

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = this.config.microphone.fftSize;
      source.connect(analyser);

      // PRODUCTION SOLUTION: ScriptProcessorNode with frontend resampling
      // Research: ScriptProcessorNode deprecated but reliable in Electron
      // Raw PCM16 optimal for Whisper ML pipeline (no codec overhead)
      let captureNode = null;
      let mediaRecorder = null;

      // ScriptProcessorNode (industry standard for Electron despite deprecation)
      // Research: Deprecated but reliable in Electron, AudioWorklet has module path issues
      try {
        // Smaller buffer for faster wake word response (<100ms latency)
        const bufferSize = 2048;  // ~43ms @ 48kHz, ~128ms @ 16kHz after resample
        
        // eslint-disable-next-line deprecation/deprecation
        // @ts-ignore - Intentional use of deprecated API (reliable in Electron)
        const scriptNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
        
        const sourceSampleRate = audioContext.sampleRate;  // Usually 48kHz
        const targetSampleRate = 16000;  // Whisper native sample rate
        let chunksSent = 0; // Debug counter
        
        // eslint-disable-next-line deprecation/deprecation
        // @ts-ignore - Intentional use of deprecated API (reliable in Electron)
        scriptNode.onaudioprocess = (audioProcessingEvent) => {
          // Debug: Log first invocation
          if (chunksSent === 0) {
            this.logger.debug('onaudioprocess first call', { streamActive: this.streamService.isStreamActive(streamId), hasEndpoint: !!this.endpoint });
          }
          
          if (!this.streamService.isStreamActive(streamId) || !this.endpoint) {
            return;
          }
          
          const inputBuffer = audioProcessingEvent.inputBuffer;
          const inputData = inputBuffer.getChannelData(0); // Mono Float32
          
          // CRITICAL: Frontend resampling to reduce bandwidth & match Whisper
          // Research: Averaging-based downsampling is optimal for real-time
          let resampledData = inputData;
          if (sourceSampleRate !== targetSampleRate) {
            resampledData = this._downsampleAudio(inputData, sourceSampleRate, targetSampleRate);
          }
          
          // Convert Float32 → PCM16
          const pcm16 = new Int16Array(resampledData.length);
          for (let i = 0; i < resampledData.length; i++) {
            const s = Math.max(-1, Math.min(1, resampledData[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          
          // Send raw PCM16 to backend
          this._handleRawPCM(streamId, pcm16.buffer, targetSampleRate);
          
          // Debug log every 50 chunks (~6-7 seconds)
          chunksSent++;
          if (chunksSent % 50 === 0) {
            this.logger.debug(`sent ${chunksSent} PCM16 chunks`, { samples: pcm16.length, sampleRate: targetSampleRate });
          }
        };
        
        source.connect(scriptNode);
        scriptNode.connect(audioContext.destination);
        captureNode = scriptNode;
        
        this.logger.info('audio capture started', { sourceSampleRate, targetSampleRate, format: 'PCM16' });
      } catch (error) {
        this.logger.error('ScriptProcessorNode initialization failed', {
          error: error.message,
          stack: error.stack,
          audioContextState: audioContext.state,
          audioContextSampleRate: audioContext.sampleRate,
          mediaStreamActive: mediaStream.active
        });
        
        // NO FALLBACK - We need to see what's breaking
        throw new Error(`ScriptProcessorNode initialization failed: ${error.message}`);
      }

      this.logger.debug('starting stream registration', { hasCaptureNode: !!captureNode, hasMediaRecorder: !!mediaRecorder });
      
      const stream = this.streamService.startStream(streamId, mediaStream, mediaRecorder, audioContext);
      stream.setAnalyser(analyser, source);
      
      // Store capture node for cleanup
      if (captureNode) {
        stream.captureNode = captureNode;
      }

      this._currentStreamId = streamId;

      if (this.config.isVisualizationEnabled()) {
        this._startVisualization(streamId);
      }

      if (this.eventBus) {
        this.eventBus.emit('audio:stream-started', { streamId });
      }

      if (this.endpoint) {
        this.endpoint.connection.send({
          role: 'user',
          start: true,
        });
      }

      return streamId;
    } catch (error) {
      this.logger.error('startMicrophone failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Stop microphone capture
   * @param {string} streamId - Stream identifier (optional, uses current if not provided)
   * @returns {Promise<void>}
   */
  async stopMicrophone(streamId = null) {
    try {
      const targetStreamId = streamId || this._currentStreamId;

      if (!targetStreamId) {
        return;
      }

      if (this._visualizationFrameId) {
        cancelAnimationFrame(this._visualizationFrameId);
        this._visualizationFrameId = null;
      }

      const stream = this.streamService.stopStream(targetStreamId);

      if (stream) {
        this.streamService.cleanupStream(targetStreamId);

        if (this.eventBus) {
          this.eventBus.emit('audio:stream-stopped', {
            streamId: targetStreamId,
            duration: stream.getDuration(),
          });
        }
      }

      if (this.endpoint) {
        this.endpoint.connection.send({
          role: 'user',
          end: true,
        });
      }

      if (this._currentStreamId === targetStreamId) {
        this._currentStreamId = null;
      }
    } catch (error) {
      this.logger.error('stopMicrophone failed', { error: error.message });
      throw error;
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
        this.logger.warn('invalid audio chunk, skipping');
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
      this.logger.error('error handling audio data', { error: error.message });
      if (this.eventBus) {
        this.eventBus.emit('audio:error', { streamId, error });
      }
    }
  }

  /**
   * Handle raw PCM audio data from ScriptProcessorNode
   * @private
   * @param {string} streamId - Stream identifier
   * @param {ArrayBuffer} pcmData - Raw PCM16 data
   * @param {number} sampleRate - Sample rate
   */
  async _handleRawPCM(streamId, pcmData, sampleRate) {
    try {
      if (!this.streamService.isStreamActive(streamId) || !this.endpoint) {
        this.logger.warn('skipping PCM send', { streamActive: this.streamService.isStreamActive(streamId), hasEndpoint: !!this.endpoint });
        return;
      }

      // Convert PCM16 ArrayBuffer to Base64
      const uint8Array = new Uint8Array(pcmData);
      let binary = '';
      for (let i = 0; i < uint8Array.length; i++) {
        binary += String.fromCharCode(uint8Array[i]);
      }
      const base64PCM = btoa(binary);

      // Send as JSON message with PCM data
      this.endpoint.connection.send({
        role: 'user',
        type: 'audio',
        audio: base64PCM,
        format: 'pcm16',  // Raw PCM16 (not WAV)
        sampleRate: sampleRate,
        timestamp: Date.now()
      });

      // Emit event
      if (this.eventBus) {
        this.eventBus.emit('audio:chunk-sent', {
          streamId,
          size: pcmData.byteLength,
          format: 'pcm16'
        });
      }
    } catch (error) {
      this.logger.error('error handling raw PCM', { error: error.message });
      if (this.eventBus) {
        this.eventBus.emit('audio:error', { streamId, error });
      }
    }
  }

  /**
   * Downsample audio using averaging (optimal for real-time)
   * @private
   * @param {Float32Array} buffer - Input audio samples
   * @param {number} fromSampleRate - Source sample rate (e.g., 48000)
   * @param {number} toSampleRate - Target sample rate (e.g., 16000)
   * @returns {Float32Array} Downsampled audio
   * 
   * Research source: https://github.com/SYSTRAN/faster-whisper/issues/671
   * Industry standard: Averaging-based downsampling for WebSocket streaming
   */
  _downsampleAudio(buffer, fromSampleRate, toSampleRate) {
    if (fromSampleRate === toSampleRate) {
      return buffer;
    }
    
    const sampleRateRatio = Math.round(fromSampleRate / toSampleRate);
    const newLength = Math.round(buffer.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    
    let offsetResult = 0;
    let offsetBuffer = 0;
    
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
      let accum = 0;
      let count = 0;
      
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    
    return result;
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

      // Decompose FFT into 4 frequency bands for multi-band visualizer reactivity
      const bands = this._computeFFTBands(dataArray);
      
      // Update stream level
      this.streamService.updateAudioLevel(streamId, level);

      // Emit event (includes FFT band data)
      if (this.eventBus) {
        this.eventBus.emit('audio:level-updated', { 
          streamId, 
          level,
          bass: bands.bass,
          lowMid: bands.lowMid,
          highMid: bands.highMid,
          treble: bands.treble,
          source: 'stt'
        });
      }

      // Request next frame
      this._visualizationFrameId = requestAnimationFrame(updateVisualization);
    };

    updateVisualization();
  }

  /**
   * Decompose FFT frequency data into 4 bands for multi-band audio reactivity.
   * Band boundaries: bass (0-10%), lowMid (10-30%), highMid (30-60%), treble (60-100%).
   * Each band is normalized to [0, 1].
   * @private
   * @param {Uint8Array} data - Frequency data from AnalyserNode.getByteFrequencyData()
   * @returns {{ bass: number, lowMid: number, highMid: number, treble: number }}
   */
  _computeFFTBands(data) {
    const len = data.length;
    if (len === 0) return { bass: 0, lowMid: 0, highMid: 0, treble: 0 };

    const bassEnd = Math.floor(len * 0.1);
    const lowMidEnd = Math.floor(len * 0.3);
    const highMidEnd = Math.floor(len * 0.6);

    let bassSum = 0, lowMidSum = 0, highMidSum = 0, trebleSum = 0;
    for (let i = 0; i < len; i++) {
      const v = data[i];
      if (i < bassEnd) bassSum += v;
      else if (i < lowMidEnd) lowMidSum += v;
      else if (i < highMidEnd) highMidSum += v;
      else trebleSum += v;
    }

    return {
      bass:    bassSum / ((bassEnd || 1) * 255),
      lowMid:  lowMidSum / (((lowMidEnd - bassEnd) || 1) * 255),
      highMid: highMidSum / (((highMidEnd - lowMidEnd) || 1) * 255),
      treble:  trebleSum / (((len - highMidEnd) || 1) * 255),
    };
  }

  /**
   * Handle incoming TTS audio
   * @param {ArrayBuffer|Uint8Array} audioData - Raw audio data
   * @param {Object} options - Optional metadata
   * @returns {Promise<void>}
   */
  async handleTTSAudio(audioData, options = {}) {
    try {
      if (!this.config.isTTSEnabled()) {
        return;
      }

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
      this.logger.error('error handling TTS audio', { error: error.message });
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

    let audio = null;
    let audioContext = null;

    try {
      audio = this.ttsService.dequeue();
      if (!audio) {
        if (this.eventBus) {
          this.eventBus.emit('audio:tts-queue-empty');
        }
        return;
      }

      this.ttsService.startPlayback(audio);

      if (this.eventBus) {
        this.eventBus.emit('audio:tts-started', { audioId: audio.id });
      }

      const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error('AudioContext is not available in this environment');
      }
      audioContext = new AudioContextCtor(this.config.getAudioContextOptions());

      const arrayBuffer = audio.getArrayBuffer();
      let audioBuffer;

      // Raw PCM16 (from handsfree TTS): manually convert to AudioBuffer.
      // decodeAudioData only handles container formats (WAV/MP3/OGG) with headers.
      if (audio.format === 'pcm16' || audio.format === 'pcm') {
        const sampleRate = audio.sampleRate || 24000;
        const pcm16 = new Int16Array(arrayBuffer);
        audioBuffer = audioContext.createBuffer(1, pcm16.length, sampleRate);
        const channelData = audioBuffer.getChannelData(0);
        for (let i = 0; i < pcm16.length; i++) {
          channelData[i] = pcm16[i] / 32768;
        }
      } else {
        // Container format (WAV/MP3/OGG) — browser decodes headers
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      }
      audio.setDecodedBuffer(audioBuffer);

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      
      // ADD: Analyser for TTS playback level monitoring (handsfree mode support)
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      let outputNode = audioContext.destination;
      let gainNode = null;
      if (this.config.tts.volume !== 1.0) {
        gainNode = audioContext.createGain();
        gainNode.gain.value = this.config.tts.volume;
        analyser.connect(gainNode);
        gainNode.connect(audioContext.destination);
      } else {
        analyser.connect(audioContext.destination);
      }
      
      // Monitor TTS audio level during playback
      const monitorTTSLevel = () => {
        if (!this.ttsService.isPlaying()) return;
        
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(dataArray);
        const level = dataArray.reduce((a, b) => a + b) / dataArray.length / 255;

        // Decompose FFT into 4 frequency bands
        const bands = this._computeFFTBands(dataArray);
        
        // Emit for EventBus subscribers (visualizer, handsfree coordinator)
        if (this.eventBus) {
          this.eventBus.emit('audio:level-updated', { 
            streamId: 'tts-playback', 
            level,
            bass: bands.bass,
            lowMid: bands.lowMid,
            highMid: bands.highMid,
            treble: bands.treble,
            source: 'tts'
          });
        }
        
        // Backward compatibility: Update legacy guru state if present
        const guruState = globalThis?.guru?.state;
        if (guruState) {
          guruState.audioLevel = level;
        }
        
        requestAnimationFrame(monitorTTSLevel);
      };
      monitorTTSLevel();

      source.onended = () => {
        this._ttsSource = null;
        this.ttsService.completePlayback(audio);

        if (this.eventBus) {
          this.eventBus.emit('audio:tts-completed', { audioId: audio.id });
        }

        Promise.resolve()
          .then(async () => {
            if (audioContext && audioContext.state !== 'closed') {
              await audioContext.close();
            }
          })
          .catch((closeError) => {
            this.logger.warn('playNextTTS cleanup failed', { error: closeError.message });
          })
          .finally(() => {
            this._ttsAudioContext = null;
            // Only continue queue if playback completed naturally (not stopped by user)
            if (this.config.tts.queueEnabled && !this._ttsStoppedByUser) {
              this.playNextTTS().catch((queueError) => {
                this.logger.error('playNextTTS queue error', { error: queueError.message });
              });
            }
          });
      };

      // Track source and context so stopTTS() can actually stop audio output
      this._ttsSource = source;
      this._ttsAudioContext = audioContext;
      this._ttsStoppedByUser = false;
      source.start(0);
    } catch (error) {
      this.logger.error('error playing TTS audio', { error: error.message });

      if (audio) {
        this.ttsService.failPlayback(audio, error);
      }

      if (this.eventBus) {
        this.eventBus.emit('audio:tts-error', { audioId: audio?.id ?? null, error });
      }

      this._ttsSource = null;
      this._ttsAudioContext = null;

      if (audioContext && audioContext.state !== 'closed') {
        try {
          await audioContext.close();
        } catch (closeError) {
          this.logger.warn('playNextTTS close failed', { error: closeError.message });
        }
      }

      if (this.config.tts.queueEnabled) {
        await this.playNextTTS();
      }
    }
  }

  /**
   * Stop current TTS playback
   */
  stopTTS() {
    this._ttsStoppedByUser = true;
    const audio = this.ttsService.stopCurrent();

    // Actually stop the audio output — without this, the AudioBufferSourceNode
    // continues playing until the buffer finishes, then onended fires and
    // starts the next queued audio. The user clicked "stop" but hears more audio.
    if (this._ttsSource) {
      try { this._ttsSource.stop(); } catch (_) { /* already stopped/disconnected */ }
      this._ttsSource = null;
    }
    if (this._ttsAudioContext && this._ttsAudioContext.state !== 'closed') {
      this._ttsAudioContext.close().catch(() => {});
      this._ttsAudioContext = null;
    }

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
      this.logger.error('error handling STT partial', { error: error.message });
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
      this.logger.error('error handling STT final', { error: error.message });
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

    // Stop TTS audio output before clearing service state
    if (this._ttsSource) {
      try { this._ttsSource.stop(); } catch (_) { /* already stopped */ }
      this._ttsSource = null;
    }
    if (this._ttsAudioContext && this._ttsAudioContext.state !== 'closed') {
      this._ttsAudioContext.close().catch(() => {});
      this._ttsAudioContext = null;
    }
    this._ttsStoppedByUser = false;

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
