'use strict';

const { Settings } = require('../../../../../src/domain/settings/models/Settings');

describe('Settings Domain Model', () => {
  describe('Constructor', () => {
    it('should create with all default categories', () => {
      const s = new Settings();
      expect(s.interpreter).toBeDefined();
      expect(s.llm).toBeDefined();
      expect(s.voice).toBeDefined();
      expect(s.memory).toBeDefined();
      expect(s.security).toBeDefined();
    });

    it('should accept custom data', () => {
      const s = new Settings({ llm: { model: 'custom-model' } });
      expect(s.llm.model).toBe('custom-model');
    });

    it('should not override other categories when one is provided', () => {
      const s = new Settings({ llm: { model: 'x' } });
      expect(s.interpreter).toBeDefined();
      expect(s.voice).toBeDefined();
    });
  });

  describe('Default getters', () => {
    it('should return default interpreter settings', () => {
      const interp = Settings.getDefaultInterpreter();
      expect(interp.auto_run).toBe(true);  // Must be true for external server mode
      expect(interp.loop).toBe(false);
      expect(interp.safe_mode).toBe('off');
      expect(interp.computer).toBeDefined();
      expect(interp.computer.import_computer_api).toBe(true);
    });

    it('should return default LLM settings', () => {
      const llm = Settings.getDefaultLLM();
      expect(llm.provider).toBe('aether_inference');
      expect(llm.model).toBeTruthy();
      expect(llm.supports_vision).toBe(true);
      expect(llm.context_window).toBeGreaterThan(0);
      expect(llm.max_tokens).toBeGreaterThan(0);
    });

    it('should return default voice settings', () => {
      const voice = Settings.getDefaultVoice();
      expect(voice.mic_button_enabled).toBe(true);
      expect(voice.stt).toBeDefined();
      expect(voice.tts).toBeDefined();
      expect(voice.wakeword).toBeDefined();
      expect(voice.stt.provider).toBe('dsm');
      expect(voice.tts.provider).toBe('dsm');
    });

    it('should return default memory settings', () => {
      const memory = Settings.getDefaultMemory();
      expect(memory.enabled).toBe(true);
      expect(memory.type).toBe('supabase');
      expect(memory.retrieval.enabled).toBe(true);
    });

    it('should return default security settings', () => {
      const sec = Settings.getDefaultSecurity();
      expect(sec.bind_host).toBe('127.0.0.1');
      expect(sec.auth_enabled).toBe(false);
      expect(sec.allowed_origins).toContain('http://localhost:*');
    });
  });

  describe('get() - dot path access', () => {
    it('should get top-level property', () => {
      const s = new Settings();
      expect(s.get('llm')).toBeDefined();
    });

    it('should get nested property', () => {
      const s = new Settings();
      expect(s.get('llm.provider')).toBe('aether_inference');
      expect(s.get('voice.stt.provider')).toBe('dsm');
    });

    it('should return undefined for missing path', () => {
      const s = new Settings();
      expect(s.get('nonexistent')).toBeUndefined();
      expect(s.get('llm.nonexistent')).toBeUndefined();
      expect(s.get('a.b.c.d')).toBeUndefined();
    });
  });

  describe('set() - dot path mutation', () => {
    it('should set top-level property', () => {
      const s = new Settings();
      s.set('llm', { model: 'new' });
      expect(s.llm.model).toBe('new');
    });

    it('should set nested property', () => {
      const s = new Settings();
      s.set('llm.model', 'changed-model');
      expect(s.get('llm.model')).toBe('changed-model');
    });

    it('should create intermediate objects', () => {
      const s = new Settings();
      s.set('custom.deep.path', 'value');
      expect(s.get('custom.deep.path')).toBe('value');
    });
  });

  describe('mergeWithDefaults', () => {
    it('should merge partial data with defaults', () => {
      const merged = Settings.mergeWithDefaults({
        llm: { model: 'custom-model' }
      });
      expect(merged.llm.model).toBe('custom-model');
      expect(merged.llm.provider).toBe('aether_inference'); // preserved default
      expect(merged.voice.stt.provider).toBe('dsm'); // fully default
    });

    it('should deep merge nested objects', () => {
      const merged = Settings.mergeWithDefaults({
        voice: { stt: { language: 'en' } }
      });
      expect(merged.voice.stt.language).toBe('en');
      expect(merged.voice.stt.sample_rate_hz).toBe(16000); // preserved
      expect(merged.voice.tts.provider).toBe('dsm'); // sibling preserved
    });
  });

  describe('Clone', () => {
    it('should deep clone', () => {
      const original = new Settings();
      const cloned = original.clone();
      cloned.llm.model = 'modified';
      expect(original.llm.model).not.toBe('modified');
    });

    it('should clone nested objects', () => {
      const original = new Settings();
      const cloned = original.clone();
      cloned.voice.stt.language = 'fr';
      expect(original.voice.stt.language).not.toBe('fr');
    });
  });

  describe('Serialization', () => {
    it('should convert to JSON', () => {
      const s = new Settings();
      const json = s.toJSON();
      expect(json).toHaveProperty('interpreter');
      expect(json).toHaveProperty('llm');
      expect(json).toHaveProperty('voice');
      expect(json).toHaveProperty('memory');
      expect(json).toHaveProperty('security');
    });

    it('should round-trip through fromJSON', () => {
      const original = new Settings();
      const restored = Settings.fromJSON(original.toJSON());
      expect(restored.llm.provider).toBe(original.llm.provider);
      expect(restored.voice.stt.provider).toBe(original.voice.stt.provider);
    });

    it('should export and import JSON string', () => {
      const original = new Settings();
      const jsonStr = original.exportJSON();
      expect(typeof jsonStr).toBe('string');
      const restored = Settings.importJSON(jsonStr);
      expect(restored.llm.provider).toBe(original.llm.provider);
    });
  });

  describe('Factory', () => {
    it('should create default settings', () => {
      const s = Settings.createDefault();
      expect(s).toBeInstanceOf(Settings);
      expect(s.llm.provider).toBe('aether_inference');
    });
  });
});
