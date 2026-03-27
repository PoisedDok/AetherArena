'use strict';

const { AudioConfig } = require('../../../../../src/domain/audio/models/AudioConfig');

describe('AudioConfig Domain Model', () => {
  describe('Constructor', () => {
    it('should create with all defaults', () => {
      const cfg = new AudioConfig();
      expect(cfg.microphone.enabled).toBe(true);
      expect(cfg.microphone.pushToTalk).toBe(true);
      expect(cfg.microphone.sampleRate).toBe(16000);
      expect(cfg.microphone.fftSize).toBe(256);
      expect(cfg.microphone.visualizationEnabled).toBe(true);
      expect(cfg.tts.enabled).toBe(true);
      expect(cfg.tts.sampleRate).toBe(16000);
      expect(cfg.tts.autoPlay).toBe(true);
      expect(cfg.tts.volume).toBe(1.0);
      expect(cfg.tts.queueEnabled).toBe(true);
      expect(cfg.general.audioContextSampleRate).toBe(16000);
      expect(cfg.general.enableKeyboardShortcuts).toBe(true);
      expect(cfg.general.keyboardShortcutKey).toBe('Space');
      expect(cfg.general.enableTouchControls).toBe(true);
    });

    it('should accept custom microphone settings', () => {
      const cfg = new AudioConfig({
        microphone: { enabled: false, pushToTalk: false, sampleRate: 44100 }
      });
      expect(cfg.microphone.enabled).toBe(false);
      expect(cfg.microphone.pushToTalk).toBe(false);
      expect(cfg.microphone.sampleRate).toBe(44100);
    });

    it('should accept custom TTS settings', () => {
      const cfg = new AudioConfig({
        tts: { enabled: false, volume: 0.5, autoPlay: false }
      });
      expect(cfg.tts.enabled).toBe(false);
      expect(cfg.tts.volume).toBe(0.5);
      expect(cfg.tts.autoPlay).toBe(false);
    });

    it('should accept custom general settings', () => {
      const cfg = new AudioConfig({
        general: { enableKeyboardShortcuts: false, keyboardShortcutKey: 'Enter' }
      });
      expect(cfg.general.enableKeyboardShortcuts).toBe(false);
      expect(cfg.general.keyboardShortcutKey).toBe('Enter');
    });
  });

  describe('Feature checks', () => {
    it('isMicrophoneEnabled', () => {
      expect(new AudioConfig({ microphone: { enabled: true } }).isMicrophoneEnabled()).toBe(true);
      expect(new AudioConfig({ microphone: { enabled: false } }).isMicrophoneEnabled()).toBe(false);
    });

    it('isTTSEnabled', () => {
      expect(new AudioConfig({ tts: { enabled: true } }).isTTSEnabled()).toBe(true);
      expect(new AudioConfig({ tts: { enabled: false } }).isTTSEnabled()).toBe(false);
    });

    it('isPushToTalkEnabled', () => {
      expect(new AudioConfig({ microphone: { pushToTalk: true } }).isPushToTalkEnabled()).toBe(true);
      expect(new AudioConfig({ microphone: { pushToTalk: false } }).isPushToTalkEnabled()).toBe(false);
    });

    it('isVisualizationEnabled', () => {
      expect(new AudioConfig().isVisualizationEnabled()).toBe(true);
      expect(new AudioConfig({ microphone: { visualizationEnabled: false } }).isVisualizationEnabled()).toBe(false);
    });

    it('areKeyboardShortcutsEnabled', () => {
      expect(new AudioConfig().areKeyboardShortcutsEnabled()).toBe(true);
      expect(new AudioConfig({ general: { enableKeyboardShortcuts: false } }).areKeyboardShortcutsEnabled()).toBe(false);
    });
  });

  describe('Constraint generation', () => {
    it('should generate microphone constraints', () => {
      const cfg = new AudioConfig();
      const constraints = cfg.getMicrophoneConstraints();
      expect(constraints.audio.sampleRate).toBe(16000);
      expect(constraints.audio.echoCancellation).toBe(true);
      expect(constraints.audio.noiseSuppression).toBe(true);
      expect(constraints.audio.autoGainControl).toBe(true);
    });

    it('should generate MediaRecorder options', () => {
      const cfg = new AudioConfig();
      const opts = cfg.getMediaRecorderOptions();
      expect(opts.mimeType).toBe('audio/wav');
      expect(opts.audioBitsPerSecond).toBe(256000);
    });

    it('should generate AudioContext options', () => {
      const cfg = new AudioConfig();
      const opts = cfg.getAudioContextOptions();
      expect(opts.sampleRate).toBe(16000);
    });
  });

  describe('Updates', () => {
    it('should update microphone settings', () => {
      const cfg = new AudioConfig();
      cfg.updateMicrophone({ sampleRate: 44100, enabled: false });
      expect(cfg.microphone.sampleRate).toBe(44100);
      expect(cfg.microphone.enabled).toBe(false);
      expect(cfg.microphone.pushToTalk).toBe(true); // preserved
    });

    it('should update TTS settings', () => {
      const cfg = new AudioConfig();
      cfg.updateTTS({ volume: 0.3 });
      expect(cfg.tts.volume).toBe(0.3);
      expect(cfg.tts.enabled).toBe(true); // preserved
    });

    it('should update general settings', () => {
      const cfg = new AudioConfig();
      cfg.updateGeneral({ keyboardShortcutKey: 'F1' });
      expect(cfg.general.keyboardShortcutKey).toBe('F1');
    });
  });

  describe('Validation', () => {
    it('should validate default config', () => {
      const result = new AudioConfig().validate();
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should catch invalid microphone sample rate', () => {
      const cfg = new AudioConfig();
      cfg.microphone.sampleRate = 0;
      const result = cfg.validate();
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Microphone sample rate must be positive');
    });

    it('should catch invalid TTS volume', () => {
      const cfg = new AudioConfig();
      cfg.tts.volume = 1.5;
      const result = cfg.validate();
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('TTS volume must be between 0 and 1');
    });

    it('should catch invalid TTS volume (negative)', () => {
      const cfg = new AudioConfig();
      cfg.tts.volume = -0.1;
      const result = cfg.validate();
      expect(result.valid).toBe(false);
    });

    it('should catch invalid audio context sample rate', () => {
      const cfg = new AudioConfig();
      cfg.general.audioContextSampleRate = -1;
      const result = cfg.validate();
      expect(result.valid).toBe(false);
    });

    it('should accumulate multiple errors', () => {
      const cfg = new AudioConfig();
      cfg.microphone.sampleRate = 0;
      cfg.tts.volume = 5;
      cfg.general.audioContextSampleRate = 0;
      const result = cfg.validate();
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Serialization', () => {
    it('should convert to JSON', () => {
      const cfg = new AudioConfig();
      const json = cfg.toJSON();
      expect(json.microphone).toBeDefined();
      expect(json.tts).toBeDefined();
      expect(json.general).toBeDefined();
    });

    it('should round-trip through fromJSON', () => {
      const original = new AudioConfig({
        microphone: { sampleRate: 44100 },
        tts: { volume: 0.5 }
      });
      const restored = AudioConfig.fromJSON(original.toJSON());
      expect(restored.microphone.sampleRate).toBe(44100);
      expect(restored.tts.volume).toBe(0.5);
    });
  });

  describe('createDefault factory', () => {
    it('should return default config', () => {
      const cfg = AudioConfig.createDefault();
      expect(cfg).toBeInstanceOf(AudioConfig);
      expect(cfg.microphone.enabled).toBe(true);
    });
  });
});
