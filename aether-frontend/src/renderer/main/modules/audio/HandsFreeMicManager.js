'use strict';

/**
 * @module renderer/main/modules/audio/HandsFreeMicManager
 * 
 * HandsFreeMicManager - Continuous voice recording and STT streaming
 * ============================================================================
 * Handles toggle-based continuous microphone recording with STT streaming
 * to chat window, real-time audio level monitoring, and glassmorphic UI updates.
 */

class HandsFreeMicManager {
  constructor(endpoint, guruConnection) {
    this.endpoint = endpoint;
    this.guru = guruConnection;
    
    if (!this.endpoint) {
      throw new Error('[HandsFreeMicManager] endpoint required');
    }
    
    if (!this.guru) {
      throw new Error('[HandsFreeMicManager] guruConnection required');
    }
    
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
    
    console.log('🎙️ HandsFreeMicManager: Initialized');
  }
  
  init() {
    this.micToggleEl = document.getElementById('mic-toggle');
    
    if (this.micToggleEl) {
      this.micToggleEl.addEventListener('click', () => this.toggle());
    }
    
    if (this.guru) {
      this.guru.on('stt-partial', this._boundHandleSttPartial);
      this.guru.on('stt-final', this._boundHandleSttFinal);
    }
    
    console.log('✅ HandsFreeMicManager: Setup complete');
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
      console.warn('[HandsFreeMicManager] Already active');
      return;
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
      
      if (this.micToggleEl) {
        this.micToggleEl.classList.add('active');
      }
      
      this._sendStartMarker();
      
      console.log('🎙️ HandsFreeMicManager: Started continuous recording');
      
      if (this.guru) {
        this.guru.emit('status', 'listening');
      }
    } catch (error) {
      console.error('[HandsFreeMicManager] Failed to start:', error);
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
    
    if (this.micToggleEl) {
      this.micToggleEl.classList.remove('active');
    }
    
    this._sendEndMarker();
    
    if (this.transcriptionBuffer.trim()) {
      this._flushTranscriptionToChat();
    }
    
    console.log('🎙️ HandsFreeMicManager: Stopped');
    
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
      console.error('[HandsFreeMicManager] MediaRecorder error:', error);
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
      console.error('[HandsFreeMicManager] Failed to send start marker:', error);
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
      console.error('[HandsFreeMicManager] Failed to send end marker:', error);
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
      console.error('[HandsFreeMicManager] Failed to send audio chunk:', error);
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
    
    console.log('[HandsFreeMicManager] STT Partial:', data.text);
    
    this._streamToChatWindow(data.text, false);
  }
  
  _handleSttFinal(data) {
    if (!this.isActive) return;
    
    console.log('[HandsFreeMicManager] STT Final:', data.text);
    
    this.transcriptionBuffer += data.text + ' ';
    
    this._streamToChatWindow(data.text, true);
  }
  
  _streamToChatWindow(text, isFinal) {
    try {
      window.aether.chat.streamUserInput({
        text: text,
        isFinal: isFinal,
        source: 'handsfree-stt'
      });
    } catch (error) {
      console.error('[HandsFreeMicManager] Failed to stream to chat:', error);
    }
  }
  
  _flushTranscriptionToChat() {
    const text = this.transcriptionBuffer.trim();
    if (!text) return;
    
    try {
      window.aether.chat.sendMessage({
        text: text,
        source: 'handsfree-stt-complete'
      });
      
      this.transcriptionBuffer = '';
    } catch (error) {
      console.error('[HandsFreeMicManager] Failed to flush transcription:', error);
    }
  }
  
  dispose() {
    this.stop();
    
    if (this.guru) {
      this.guru.off('stt-partial', this._boundHandleSttPartial);
      this.guru.off('stt-final', this._boundHandleSttFinal);
    }
    
    if (this.micToggleEl) {
      this.micToggleEl.removeEventListener('click', () => this.toggle());
    }
    
    console.log('🎙️ HandsFreeMicManager: Disposed');
  }
}

module.exports = HandsFreeMicManager;

