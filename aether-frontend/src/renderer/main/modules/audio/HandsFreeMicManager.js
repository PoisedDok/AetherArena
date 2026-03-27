'use strict';

/**
 * @module renderer/main/modules/audio/HandsFreeMicManager
 * 
 * HandsFreeMicManager - Continuous voice recording and STT streaming
 * ============================================================================
 * Handles toggle-based continuous microphone recording with STT streaming
 * to chat window, real-time audio level monitoring, and glassmorphic UI updates.
 */

const { getAether } = require('../../../shared/bridge/AetherBridge');
const { createRendererLogger } = require('../../../shared/utils/logger');

class HandsFreeMicManager {
  constructor(endpoint, guruConnection) {
    this.log = createRendererLogger('HandsFreeMicManager');
    this.endpoint = endpoint;
    this.guru = guruConnection;
    this.aether = getAether();
    
    if (!this.endpoint) {
      throw new Error('[HandsFreeMicManager] endpoint required');
    }
    
    if (!this.guru) {
      throw new Error('[HandsFreeMicManager] guruConnection required');
    }
    
    this._isDisposed = false;
    this.isActive = false;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.currentStream = null;
    this.analyser = null;
    this.audioContext = null;
    this.audioLevelUpdateInterval = null;
    this.transcriptionBuffer = '';
    
    this.micToggleEl = null;
    
    this._boundHandleSttPartial = this._handleSttPartial.bind(this);
    this._boundHandleSttFinal = this._handleSttFinal.bind(this);
    this._boundHandleTtsAudio = this._handleTtsAudio.bind(this);
    this._boundToggle = this.toggle.bind(this);
    
    this.log.debug('🎙️ HandsFreeMicManager: Initialized');
  }
  
  init() {
    this.micToggleEl = document.getElementById('mic-toggle');
    
    if (this.micToggleEl) {
      this.micToggleEl.addEventListener('click', this._boundToggle);
    }
    
    if (this.guru) {
      this.guru.on('stt-partial', this._boundHandleSttPartial);
      this.guru.on('stt-final', this._boundHandleSttFinal);
      this.guru.on('tts-audio', this._boundHandleTtsAudio);
    }
    
    this.log.debug('✅ HandsFreeMicManager: Setup complete');
  }
  
  toggle() {
    if (this.isActive) {
      this.stop();
    } else {
      this.start();
    }
  }
  
  async start() {
    if (this.isActive) {
      this.log.warn('[HandsFreeMicManager] Already active');
      return;
    }
    
    try {
      if (this.aether && this.aether.session && typeof this.aether.session.getStats === 'function') {
        const stats = await this.aether.session.getStats();
        
        // If no active chat, create a new one to ensure STT has a destination
        if (!stats.activeChatId && this.aether.ipc) {
          try {
            const newChat = await this.aether.ipc.invoke('storage:create-chat', { title: 'Handsfree Session' });
            const chatId = newChat?.id || newChat?.chatId || (typeof newChat === 'string' ? newChat : null);
            if (chatId) {
              this.log.info(`[HandsFreeMicManager] Created new chat for handsfree session: ${chatId}`);
              this.aether.ipc.send('chat:switch-to-chat', { chatId });
            }
          } catch (createErr) {
            this.log.error('[HandsFreeMicManager] Failed to create initial chat:', createErr);
          }
        }
      }
    } catch (sessionErr) {
      this.log.warn('[HandsFreeMicManager] Failed to check active session:', sessionErr);
    }
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      
      this.currentStream = stream;
      this.isActive = true;
      
      this._setupAudioMonitoring(stream);
      this._setupMediaRecorder(stream);
      
      this.mediaRecorder.start(100);
      
      this._sendStartMarker();
      
      this.log.debug('🎙️ HandsFreeMicManager: Started continuous recording');
      
      if (this.guru) {
        this.guru.emit('status', 'listening');
      }
    } catch (error) {
      this.log.error('[HandsFreeMicManager] Failed to start:', error);
      this.isActive = false;
    }
  }
  
  stop() {
    if (!this.isActive) {
      return;
    }
    
    this.isActive = false;
    
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    
    if (this.currentStream) {
      this.currentStream.getTracks().forEach(track => track.stop());
      this.currentStream = null;
    }
    
    if (this.audioLevelUpdateInterval) {
      clearInterval(this.audioLevelUpdateInterval);
      this.audioLevelUpdateInterval = null;
    }
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    
    this._sendEndMarker();
    
    if (this.transcriptionBuffer.trim()) {
      this._flushTranscriptionToChat();
    }
    
    this.log.debug('🎙️ HandsFreeMicManager: Stopped');
    
    if (this.guru) {
      this.guru.emit('status', 'idle');
    }
  }
  
  _setupAudioMonitoring(stream) {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    
    this.audioContext = audioContext;
    this.analyser = analyser;
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    this.audioLevelUpdateInterval = setInterval(() => {
      if (!this.isActive) {
        clearInterval(this.audioLevelUpdateInterval);
        this.audioLevelUpdateInterval = null;
        return;
      }
      
      analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const normalized = average / 255;
      
      if (this.guru && this.guru.state) {
        this.guru.state.audioLevel = normalized;
      }
    }, 50);
  }
  
  _setupMediaRecorder(stream) {
    const mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus'
    });
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0 && this.isActive) {
        this._sendAudioChunk(event.data);
      }
    };
    
    mediaRecorder.onerror = (error) => {
      this.log.error('[HandsFreeMicManager] MediaRecorder error:', error);
      this.stop();
    };
    
    this.mediaRecorder = mediaRecorder;
  }
  
  _sendStartMarker() {
    if (!this.endpoint || !this.endpoint.connection) return;
    
    try {
      this.endpoint.connection.send(JSON.stringify({
        role: 'user',
        type: 'audio',
        audio: '',
        format: 'opus',
        start: true
      }));
    } catch (error) {
      this.log.error('[HandsFreeMicManager] Failed to send start marker:', error);
    }
  }
  
  _sendEndMarker() {
    if (!this.endpoint || !this.endpoint.connection) return;
    
    try {
      this.endpoint.connection.send(JSON.stringify({
        role: 'user',
        type: 'audio',
        audio: '',
        format: 'opus',
        end: true
      }));
    } catch (error) {
      this.log.error('[HandsFreeMicManager] Failed to send end marker:', error);
    }
  }
  
  async _sendAudioChunk(blob) {
    if (!this.endpoint || !this.endpoint.connection) return;
    
    try {
      const base64 = await this._blobToBase64(blob);
      
      this.endpoint.connection.send(JSON.stringify({
        role: 'user',
        type: 'audio',
        audio: base64,
        format: 'opus'
      }));
    } catch (error) {
      this.log.error('[HandsFreeMicManager] Failed to send audio chunk:', error);
    }
  }
  
  _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  
  _handleSttPartial(data) {
    if (!this.isActive) return;
    
    this.log.debug('[HandsFreeMicManager] STT Partial:', data.text);
    
    this._streamToChatWindow(data.text, false);
  }
  
  _handleSttFinal(data) {
    if (!this.isActive) return;

    this.log.debug('[HandsFreeMicManager] STT Final:', data.text);

    // GAP 6 FIX: Handle wake word detection event (special sentinel value)
    if (data.text === "__WAKE_WORD_DETECTED__") {
      this.log.debug('🎯 [HandsFreeMicManager] Wake word detected!');
      
      // Emit wake word detection event to EventBus for visual feedback
      if (this.aether && this.aether.eventBus) {
        this.aether.eventBus.emit('handsfree:wake-word-detected', {
          timestamp: Date.now(),
        });
      }
      
      // Don't stream wake word sentinel to chat window
      return;
    }

    this.transcriptionBuffer += data.text + ' ';

    this._streamToChatWindow(data.text, true);

    // Emit to EventBus for HandsfreeCoordinator state machine
    if (this.aether && this.aether.eventBus) {
      this.aether.eventBus.emit('audio:stt-final', {
        text: data.text,
        timestamp: Date.now(),
      });
    }
  }
  
  /**
   * Handle TTS audio from backend
   * @private
   */
  _handleTtsAudio(data) {
    this.log.debug('[HandsFreeMicManager] TTS audio received:', data.format, data.audio?.length);
    
    // Call AudioManager to handle TTS playback
    if (window.audioManager && data.audio) {
      try {
        window.audioManager.handleTTSAudio(data.audio, data.format || 'wav');
      } catch (error) {
        this.log.error('[HandsFreeMicManager] Failed to handle TTS audio:', error);
      }
    } else {
      this.log.warn('[HandsFreeMicManager] AudioManager not available or missing audio data');
    }
  }
  
  _streamToChatWindow(text, isFinal) {
    try {
      this.aether?.chat?.streamUserInput({
        text: text,
        isFinal: isFinal,
        source: 'handsfree-stt'
      });
    } catch (error) {
      this.log.error('[HandsFreeMicManager] Failed to stream to chat:', error);
    }
  }
  
  _flushTranscriptionToChat() {
    const text = this.transcriptionBuffer.trim();
    if (!text) return;
    
    try {
      this.aether?.chat?.sendMessage({
        text: text,
        source: 'handsfree-stt-complete'
      });
      
      this.transcriptionBuffer = '';
    } catch (error) {
      this.log.error('[HandsFreeMicManager] Failed to flush transcription:', error);
    }
  }
  
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.stop();
    
    if (this.guru) {
      this.guru.off('stt-partial', this._boundHandleSttPartial);
      this.guru.off('stt-final', this._boundHandleSttFinal);
      this.guru.off('tts-audio', this._boundHandleTtsAudio);
    }
    
    // UI controller handles the click listener for toggle now, but if MicManager still needs it:
    if (this.micToggleEl) {
      this.micToggleEl.removeEventListener('click', this._boundToggle);
    }
    
    this.log.debug('🎙️ HandsFreeMicManager: Disposed');
  }
}

module.exports = HandsFreeMicManager;
