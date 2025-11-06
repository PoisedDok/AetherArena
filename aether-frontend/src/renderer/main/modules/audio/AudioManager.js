'use strict';

/**
 * @.architecture
 * 
 * Incoming: User interactions (mic button mouse/touch, Space key), window.guru (tts-audio, audio-level, stt-final events), Endpoint.connection (audio stream responses) --- {dom_types.mouse_event | event_types.AUDIO.*, Event | ArrayBuffer}
 * Processing: Push-to-talk (hold to speak, release to send), MediaRecorder (audio/webm;codecs=opus, 100ms chunks), base64 encode audio, send via WebSocket ({role:'user', audio:base64, format:'opus'}), monitor audio level via AnalyserNode (256 FFT, 50ms update), queue TTS chunks, decode/play with AudioContext, update mic level fill UI (0-100% height), track guru.state.audioLevel (normalized 0-1) --- {8 jobs: JOB_START, JOB_STOP, JOB_STRINGIFY_JSON, JOB_SEND_IPC, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_PARSE_JSON, JOB_UPDATE_STATE}
 * Outgoing: Endpoint.connection.send() → Backend STT ({role:'user', audio:base64, start:true, end:true}), AudioContext (TTS playback queue), DOM (#mic-button, #mic-level-fill), guru.emit('status', 'listening'|'thinking') --- {websocket_stream_chunk, json}
 * 
 * 
 * @module renderer/main/modules/audio/AudioManager
 * 
 * AudioManager - Handles microphone capture, TTS playback, and audio processing
 * ============================================================================
 * Production-ready audio management with:
 * - Push-to-talk microphone control
 * - Real-time audio level monitoring
 * - STT streaming integration
 * - TTS playback queue management
 * - Keyboard shortcut support (Space key)
 * - Touch device support
 * - Automatic cleanup
 */

class AudioManager {
  constructor(endpoint, guruConnection) {
    // Dependencies
    this.endpoint = endpoint;
    this.guru = guruConnection;
    
    // Validate dependencies
    if (!this.endpoint) {
      throw new Error('[AudioManager] endpoint required');
    }
    
    if (!this.guru) {
      throw new Error('[AudioManager] guruConnection required');
    }
    
    // Audio state
    this.micEnabled = false;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.audioContext = null;
    this.audioQueue = [];
    this.isPlaying = false;
    
    // Current audio stream
    this.currentStream = null;
    this.analyser = null;
    this.audioLevelUpdateInterval = null;
    
    // UI elements
    this.micButtonEl = null;
    this.micLevelFillEl = null;
    
    // Event listeners for cleanup
    this._onTtsAudio = null;
    this._onAudioLevel = null;
    this._onSttFinal = null;
    this._onKeyDown = null;
    this._onKeyUp = null;
    this._onBodyClickInitAudio = null;
    
    // IPC reference (from window.aether if available)
    this.ipc = null;
    
    this.init();
  }

  /**
   * Initialize audio manager
   */
  init() {
    console.log('🎤 AudioManager: Initializing...');
    
    // Get UI elements
    this.micButtonEl = document.getElementById('mic-button');
    this.micLevelFillEl = document.getElementById('mic-level-fill');
    
    // Get IPC if available
    if (typeof window !== 'undefined' && window.aether && window.aether.ipc) {
      this.ipc = window.aether.ipc;
    }
    
    // Setup
    this.setupMicrophoneAvailability();
    this.setupMicrophoneControls();
    this.setupTTSPlayback();
    this.setupAudioEventListeners();
    
    console.log('✅ AudioManager: Initialization complete');
  }

  /**
   * Check microphone availability
   */
  setupMicrophoneAvailability() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.warn('[AudioManager] MediaDevices API not available');
      if (this.micButtonEl) {
        this.micButtonEl.style.color = '#ff4444'; // red indicates unavailable
      }
      return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        stream.getTracks().forEach(t => t.stop());
        if (this.micButtonEl) {
          this.micButtonEl.style.color = 'rgba(255, 255, 255, 0.9)'; // available
        }
      })
      .catch(() => {
        if (this.micButtonEl) {
          this.micButtonEl.style.color = '#ff4444'; // red indicates unavailable
        }
      });
  }

  /**
   * Setup microphone controls
   */
  setupMicrophoneControls() {
    if (!this.micButtonEl) return;

    // Push-to-talk implementation: Hold to speak, release to send
    this.micButtonEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.startMicrophone();
    });

    this.micButtonEl.addEventListener('mouseup', () => {
      this.stopMicrophone();
    });

    // Handle mouse leave (in case user drags out of button while holding)
    this.micButtonEl.addEventListener('mouseleave', () => {
      if (this.micEnabled) {
        this.micButtonEl.dispatchEvent(new Event('mouseup'));
      }
    });
    
    // Add touch support for mobile devices
    this.micButtonEl.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.micButtonEl.dispatchEvent(new MouseEvent('mousedown'));
    });
    
    this.micButtonEl.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.micButtonEl.dispatchEvent(new MouseEvent('mouseup'));
    });
    
    this.micButtonEl.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      this.micButtonEl.dispatchEvent(new MouseEvent('mouseup'));
    });
    
    // Add keyboard shortcut (Space) for accessibility
    this._onKeyDown = (e) => {
      const terminalInput = document.getElementById('terminal-input');
      // Only if the input field is not focused and space is pressed
      if (e.code === 'Space' && document.activeElement !== terminalInput) {
        e.preventDefault();
        if (!this.micEnabled) {
          this.micButtonEl.dispatchEvent(new MouseEvent('mousedown'));
        }
      }
    };
    document.addEventListener('keydown', this._onKeyDown);
    
    this._onKeyUp = (e) => {
      if (e.code === 'Space' && this.micEnabled) {
        e.preventDefault();
        this.micButtonEl.dispatchEvent(new MouseEvent('mouseup'));
      }
    };
    document.addEventListener('keyup', this._onKeyUp);
    
    // Add tooltip to show it's push-to-talk
    this.micButtonEl.setAttribute('title', 'Hold to speak (push-to-talk)');
    
    console.log('[AudioManager] Microphone controls setup complete');
  }

  /**
   * Start microphone capture
   */
  startMicrophone() {
    if (this.micButtonEl && this.micButtonEl.style.color === 'rgb(255, 68, 68)') { // red/unavailable
      console.warn('[AudioManager] Microphone not available or permission denied');
      return;
    }
    
    if (this.micEnabled) return; // Already recording
    
    this.micEnabled = true;
    if (this.micButtonEl) {
      this.micButtonEl.style.color = '#00ff7f'; // green when active
      this.micButtonEl.classList.add('active');
    }
    
    // Start STT streaming
    console.log('[AudioManager] Hold to speak...');
    
    // Manually set UI state to listening (blue) for immediate feedback
    this.guru.state.assistant = 'listening';
    this.guru.emit('status', 'listening');
    
    // Tell the backend we're starting an audio stream
    this.endpoint.connection.send({
      role: "user",
      start: true
    });
    
    // Start microphone capture
    this.startMicCapture();
    
    this.logToMain('[AudioManager] Mic started (push-to-talk)');
  }

  /**
   * Stop microphone capture
   */
  stopMicrophone() {
    if (!this.micEnabled) return; // Not recording
    
    this.micEnabled = false;
    if (this.micButtonEl) {
      this.micButtonEl.style.color = 'rgba(255, 255, 255, 0.9)'; // back to default
      this.micButtonEl.classList.remove('active');
    }
    
    // Stop STT streaming
    console.log('[AudioManager] Processing speech...');
    
    // Manually set UI state back to thinking for immediate feedback
    this.guru.state.assistant = 'thinking';
    this.guru.emit('status', 'thinking');
    
    // Tell the backend we're ending the audio stream
    this.endpoint.connection.send({
      role: "user",
      end: true
    });
    
    // Stop microphone capture
    this.stopMicCapture();
    
    this.logToMain('[AudioManager] Mic stopped (push-to-talk)');
  }

  /**
   * Start microphone capture with audio monitoring
   */
  startMicCapture() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error('[AudioManager] Browser API for mic capture not available');
      return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        this.currentStream = stream;
        
        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        
        // Create analyzer to monitor audio levels
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        
        this.audioContext = audioContext;
        this.analyser = analyser;
        
        // Update audio level visualization
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        this.audioLevelUpdateInterval = setInterval(() => {
          if (!this.micEnabled) {
            clearInterval(this.audioLevelUpdateInterval);
            this.audioLevelUpdateInterval = null;
            return;
          }
          
          analyser.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          const normalized = average / 255;
          
          // Update mic level fill
          if (this.micLevelFillEl) {
            this.micLevelFillEl.style.height = `${normalized * 100}%`;
          }
          
          // Update guru state audio level
          if (this.guru && this.guru.state) {
            this.guru.state.audioLevel = normalized;
          }
        }, 50);
        
        // Create media recorder for streaming audio to backend
        const mediaRecorder = new MediaRecorder(stream, {
          mimeType: 'audio/webm;codecs=opus'
        });
        
        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            // Convert blob to base64 and send to backend
            const reader = new FileReader();
            reader.onloadend = () => {
              const base64Audio = reader.result.split(',')[1];
              
              // Send audio chunk via WebSocket
              this.endpoint.connection.send({
                role: "user",
                audio: base64Audio,
                format: "opus"
              });
            };
            reader.readAsDataURL(event.data);
          }
        };
        
        mediaRecorder.start(100); // Send chunks every 100ms
        this.mediaRecorder = mediaRecorder;
        
        console.log('[AudioManager] Microphone capture started');
      })
      .catch(error => {
        console.error('[AudioManager] Error accessing microphone:', error);
        this.micEnabled = false;
        if (this.micButtonEl) {
          this.micButtonEl.style.color = 'rgba(255, 255, 255, 0.9)';
          this.micButtonEl.classList.remove('active');
        }
      });
  }

  /**
   * Stop microphone capture
   */
  stopMicCapture() {
    // Stop media recorder
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      this.mediaRecorder = null;
    }
    
    // Stop all tracks
    if (this.currentStream) {
      this.currentStream.getTracks().forEach(track => track.stop());
      this.currentStream = null;
    }
    
    // Close audio context
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    
    // Clear interval
    if (this.audioLevelUpdateInterval) {
      clearInterval(this.audioLevelUpdateInterval);
      this.audioLevelUpdateInterval = null;
    }
    
    // Reset mic level fill
    if (this.micLevelFillEl) {
      this.micLevelFillEl.style.height = '0%';
    }
    
    // Reset guru audio level
    if (this.guru && this.guru.state) {
      this.guru.state.audioLevel = 0;
    }
    
    console.log('[AudioManager] Microphone capture stopped');
  }

  /**
   * Setup TTS playback
   */
  setupTTSPlayback() {
    if (!this.guru) {
      console.warn('[AudioManager] Guru connection not available for TTS');
      return;
    }

    // Listen for TTS audio chunks
    this._onTtsAudio = (audioData) => {
      this.queueAudioChunk(audioData);
    };
    
    try {
      this.guru.on('tts-audio', this._onTtsAudio);
      console.log('[AudioManager] TTS playback listener registered');
    } catch (error) {
      console.error('[AudioManager] Error registering TTS listener:', error);
    }
  }

  /**
   * Queue audio chunk for playback
   * @param {ArrayBuffer|Blob} audioData
   */
  queueAudioChunk(audioData) {
    this.audioQueue.push(audioData);
    
    if (!this.isPlaying) {
      this.playNextAudioChunk();
    }
  }

  /**
   * Play next audio chunk from queue
   */
  async playNextAudioChunk() {
    if (this.audioQueue.length === 0) {
      this.isPlaying = false;
      return;
    }
    
    this.isPlaying = true;
    const audioData = this.audioQueue.shift();
    
    try {
      // Create audio context if needed
      if (!this.audioContext) {
        this.audioContext = new AudioContext();
      }
      
      // Decode and play audio
      const audioBuffer = await this.audioContext.decodeAudioData(audioData);
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);
      
      source.onended = () => {
        this.playNextAudioChunk();
      };
      
      source.start(0);
    } catch (error) {
      console.error('[AudioManager] Error playing audio chunk:', error);
      this.playNextAudioChunk(); // Try next chunk
    }
  }

  /**
   * Setup audio event listeners
   */
  setupAudioEventListeners() {
    if (!this.guru) return;

    // Listen for audio level updates from backend
    this._onAudioLevel = (level) => {
      if (this.guru && this.guru.state) {
        this.guru.state.audioLevel = level;
      }
    };
    
    try {
      this.guru.on('audio-level', this._onAudioLevel);
    } catch (error) {
      console.error('[AudioManager] Error registering audio-level listener:', error);
    }

    // Listen for STT final results
    this._onSttFinal = (text) => {
      console.log('[AudioManager] STT final:', text);
    };
    
    try {
      this.guru.on('stt-final', this._onSttFinal);
    } catch (error) {
      console.error('[AudioManager] Error registering stt-final listener:', error);
    }

    console.log('[AudioManager] Audio event listeners setup complete');
  }

  /**
   * Log message to main process
   * @param {string} message
   */
  logToMain(message) {
    try {
      if (this.ipc && typeof this.ipc.send === 'function') {
        this.ipc.send('renderer-log', message);
      } else if (typeof window !== 'undefined' && window.logToMain) {
        window.logToMain(message);
      } else {
        console.log(message);
      }
    } catch (error) {
      console.error('[AudioManager] Error logging to main:', error);
    }
  }

  /**
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    return Object.freeze({
      micEnabled: this.micEnabled,
      isPlaying: this.isPlaying,
      queueLength: this.audioQueue.length,
      hasAudioContext: !!this.audioContext,
      hasStream: !!this.currentStream
    });
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    console.log('🛑 AudioManager: Disposing...');

    // Stop microphone if active
    if (this.micEnabled) {
      this.stopMicrophone();
    }

    // Clear audio queue
    this.audioQueue = [];
    this.isPlaying = false;

    // Close audio context
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    // Remove event listeners
    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown);
      this._onKeyDown = null;
    }

    if (this._onKeyUp) {
      document.removeEventListener('keyup', this._onKeyUp);
      this._onKeyUp = null;
    }

    // Remove guru listeners
    if (this.guru) {
      if (this._onTtsAudio) {
        try {
          this.guru.off('tts-audio', this._onTtsAudio);
        } catch (error) {
          console.error('[AudioManager] Error removing tts-audio listener:', error);
        }
      }

      if (this._onAudioLevel) {
        try {
          this.guru.off('audio-level', this._onAudioLevel);
        } catch (error) {
          console.error('[AudioManager] Error removing audio-level listener:', error);
        }
      }

      if (this._onSttFinal) {
        try {
          this.guru.off('stt-final', this._onSttFinal);
        } catch (error) {
          console.error('[AudioManager] Error removing stt-final listener:', error);
        }
      }
    }

    // Clear references
    this.endpoint = null;
    this.guru = null;
    this.ipc = null;
    this.micButtonEl = null;
    this.micLevelFillEl = null;

    console.log('✅ AudioManager: Disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AudioManager;
}

if (typeof window !== 'undefined') {
  window.AudioManager = AudioManager;
  console.log('📦 AudioManager loaded');
}

