'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

const SettingsValidator = require('../../../../../src/domain/settings/validators/SettingsValidator');

describe('SettingsValidator', () => {
  describe('sanitizeSettingString()', () => {
    it('escapes HTML entities', () => {
      expect(SettingsValidator.sanitizeSettingString('<script>alert("xss")</script>'))
        .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;');
    });

    it('escapes ampersands', () => {
      expect(SettingsValidator.sanitizeSettingString('a&b')).toBe('a&amp;b');
    });

    it('escapes single quotes', () => {
      expect(SettingsValidator.sanitizeSettingString("it's")).toBe("it&#x27;s");
    });

    it('returns empty string for null', () => {
      expect(SettingsValidator.sanitizeSettingString(null)).toBe('');
    });

    it('returns empty string for non-string', () => {
      expect(SettingsValidator.sanitizeSettingString(42)).toBe('');
    });

    it('passes through clean strings', () => {
      expect(SettingsValidator.sanitizeSettingString('hello world')).toBe('hello world');
    });
  });

  describe('validateJSON()', () => {
    it('validates valid JSON', () => {
      expect(SettingsValidator.validateJSON('{"a":1}')).toEqual({ valid: true, errors: [] });
    });

    it('rejects invalid JSON', () => {
      const result = SettingsValidator.validateJSON('{broken}');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid JSON');
    });

    it('rejects null', () => {
      expect(SettingsValidator.validateJSON(null).valid).toBe(false);
    });

    it('rejects non-string', () => {
      expect(SettingsValidator.validateJSON(42).valid).toBe(false);
    });
  });

  describe('validate() - top-level', () => {
    it('rejects non-object', () => {
      expect(SettingsValidator.validate(null).valid).toBe(false);
      expect(SettingsValidator.validate('string').valid).toBe(false);
      expect(SettingsValidator.validate([]).valid).toBe(false);
    });

    it('accepts empty object', () => {
      expect(SettingsValidator.validate({}).valid).toBe(true);
    });
  });

  describe('validate() - interpreter', () => {
    it('accepts valid safe_mode values', () => {
      for (const mode of ['off', 'ask', 'auto']) {
        const r = SettingsValidator.validate({ interpreter: { safe_mode: mode } });
        expect(r.valid).toBe(true);
        expect(r.sanitized.interpreter.safe_mode).toBe(mode);
      }
    });

    it('rejects invalid safe_mode', () => {
      const r = SettingsValidator.validate({ interpreter: { safe_mode: 'dangerous' } });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('safe_mode'))).toBe(true);
    });

    it('rejects non-object interpreter', () => {
      const r = SettingsValidator.validate({ interpreter: 'string' });
      expect(r.valid).toBe(false);
    });

    it('rejects empty/whitespace safe_mode', () => {
      expect(SettingsValidator.validate({ interpreter: { safe_mode: '' } }).valid).toBe(false);
      expect(SettingsValidator.validate({ interpreter: { safe_mode: '  ' } }).valid).toBe(false);
    });

    it('rejects safe_mode with leading/trailing whitespace', () => {
      expect(SettingsValidator.validate({ interpreter: { safe_mode: ' off ' } }).valid).toBe(false);
    });
  });

  describe('validate() - llm', () => {
    it('accepts valid provider and model', () => {
      const r = SettingsValidator.validate({
        llm: { provider: 'openai', model: 'gpt-4o' }
      });
      expect(r.valid).toBe(true);
      expect(r.sanitized.llm.provider).toBe('openai');
      expect(r.sanitized.llm.model).toBe('gpt-4o');
    });

    it('accepts model with slashes (org/model)', () => {
      const r = SettingsValidator.validate({
        llm: { provider: 'hf', model: 'mistralai/Mixtral-8x7B' }
      });
      expect(r.valid).toBe(true);
    });

    it('rejects model with path traversal', () => {
      const r = SettingsValidator.validate({
        llm: { provider: 'x', model: '../../../etc/passwd' }
      });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('path traversal'))).toBe(true);
    });

    it('rejects model starting with absolute path', () => {
      const r = SettingsValidator.validate({
        llm: { provider: 'x', model: '/etc/passwd' }
      });
      expect(r.valid).toBe(false);
    });

    it('rejects provider with shell metacharacters', () => {
      const r = SettingsValidator.validate({
        llm: { provider: 'openai; rm -rf /', model: 'x' }
      });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('invalid characters'))).toBe(true);
    });

    it('rejects provider with CRLF injection', () => {
      const r = SettingsValidator.validate({
        llm: { provider: 'open\nai', model: 'x' }
      });
      expect(r.valid).toBe(false);
    });

    it('validates api_base as http(s) URL', () => {
      const valid = SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', api_base: 'https://api.example.com/v1' }
      });
      expect(valid.valid).toBe(true);
      expect(valid.sanitized.llm.api_base).toBe('https://api.example.com/v1');
    });

    it('rejects javascript: URL in api_base', () => {
      const r = SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', api_base: 'javascript:alert(1)' }
      });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('protocol not allowed'))).toBe(true);
    });

    it('rejects data: URL in api_base', () => {
      const r = SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', api_base: 'data:text/html,<h1>xss</h1>' }
      });
      expect(r.valid).toBe(false);
    });

    it('rejects file: URL in api_base', () => {
      const r = SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', api_base: 'file:///etc/passwd' }
      });
      expect(r.valid).toBe(false);
    });

    it('rejects protocol-relative URL in api_base', () => {
      const r = SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', api_base: '//evil.com/api' }
      });
      expect(r.valid).toBe(false);
    });

    it('rejects URL with credentials', () => {
      const r = SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', api_base: 'https://user:pass@api.example.com' }
      });
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => e.includes('credentials'))).toBe(true);
    });

    it('validates context_window range', () => {
      expect(SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', context_window: 4096 }
      }).valid).toBe(true);

      expect(SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', context_window: 500 }
      }).valid).toBe(false);

      expect(SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', context_window: 3_000_000 }
      }).valid).toBe(false);
    });

    it('validates temperature range 0-2', () => {
      expect(SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', temperature: 0.7 }
      }).valid).toBe(true);

      expect(SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', temperature: -1 }
      }).valid).toBe(false);

      expect(SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', temperature: 3 }
      }).valid).toBe(false);
    });

    it('validates top_p range 0-1', () => {
      expect(SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', top_p: 0.9 }
      }).valid).toBe(true);

      expect(SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', top_p: 1.5 }
      }).valid).toBe(false);
    });

    it('validates max_tokens', () => {
      expect(SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', max_tokens: 4096 }
      }).valid).toBe(true);

      expect(SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', max_tokens: 0 }
      }).valid).toBe(false);

      expect(SettingsValidator.validate({
        llm: { provider: 'x', model: 'y', max_tokens: 500_000 }
      }).valid).toBe(false);
    });
  });

  describe('validate() - voice', () => {
    it('accepts valid voice settings', () => {
      const r = SettingsValidator.validate({
        voice: { mic_button_enabled: true, stt: { sample_rate_hz: 16000 } }
      });
      expect(r.valid).toBe(true);
      expect(r.sanitized.voice.mic_button_enabled).toBe(true);
      expect(r.sanitized.voice.stt.sample_rate_hz).toBe(16000);
    });

    it('rejects non-boolean mic_button_enabled', () => {
      const r = SettingsValidator.validate({ voice: { mic_button_enabled: 'yes' } });
      expect(r.valid).toBe(false);
    });

    it('rejects out-of-range sample_rate_hz', () => {
      expect(SettingsValidator.validate({ voice: { stt: { sample_rate_hz: 100 } } }).valid).toBe(false);
      expect(SettingsValidator.validate({ voice: { stt: { sample_rate_hz: 96000 } } }).valid).toBe(false);
    });
  });

  describe('validate() - memory', () => {
    it('accepts valid memory type', () => {
      for (const type of ['supabase', 'pgvector']) {
        const r = SettingsValidator.validate({ memory: { type } });
        expect(r.valid).toBe(true);
        expect(r.sanitized.memory.type).toBe(type);
      }
    });

    it('rejects invalid memory type', () => {
      for (const type of ['mongodb', 'sqlite', 'redis', 'chroma']) {
        const r = SettingsValidator.validate({ memory: { type } });
        expect(r.valid).toBe(false);
      }
    });
  });

  describe('validateSettings() alias', () => {
    it('delegates to validate()', () => {
      const r = SettingsValidator.validateSettings({ llm: { provider: 'x', model: 'y' } });
      expect(r.valid).toBe(true);
    });
  });

  describe('legacy deprecated methods', () => {
    it('validateInterpreterSettings returns valid', () => {
      expect(SettingsValidator.validateInterpreterSettings({}).valid).toBe(true);
    });

    it('validateLLMSettings returns valid', () => {
      expect(SettingsValidator.validateLLMSettings({}).valid).toBe(true);
    });

    it('validateVoiceSettings returns valid', () => {
      expect(SettingsValidator.validateVoiceSettings({}).valid).toBe(true);
    });

    it('validateMemorySettings returns valid', () => {
      expect(SettingsValidator.validateMemorySettings({}).valid).toBe(true);
    });

    it('validateSecuritySettings returns valid', () => {
      expect(SettingsValidator.validateSecuritySettings({}).valid).toBe(true);
    });

    it('validateProfileName returns valid', () => {
      expect(SettingsValidator.validateProfileName('x').valid).toBe(true);
    });

    it('validateModelName returns valid', () => {
      expect(SettingsValidator.validateModelName('x').valid).toBe(true);
    });

    it('validateModelCapabilities returns valid', () => {
      expect(SettingsValidator.validateModelCapabilities({}).valid).toBe(true);
    });

    it('_isValidUrl returns true', () => {
      expect(SettingsValidator._isValidUrl('x')).toBe(true);
    });
  });
});
