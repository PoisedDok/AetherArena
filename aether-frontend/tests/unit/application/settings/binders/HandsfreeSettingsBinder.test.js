/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */
'use strict';

/**
 * HandsfreeSettingsBinder Unit Tests
 * ============================================================================
 * Tests populate/collect for 20+ handsfree fields, TTS engine voice visibility,
 * proactive TTS visibility, auto-language detection, voice preview buttons,
 * and range slider live updates.
 */

const HandsfreeSettingsBinder = require('../../../../../src/application/main/modules/settings/binders/HandsfreeSettingsBinder');

// Mock /v1/tts/capabilities response for dynamic dropdown population
const MOCK_TTS_CAPS = {
  engines: [
    { value: 'qwen3', label: 'Qwen3 (0.6B, high quality)', available: true },
    { value: 'kokoro', label: 'Kokoro (82M, legacy)', available: true },
    { value: 'system', label: 'System (fallback)', available: true },
  ],
  current_engine: 'qwen3',
  voices: {
    qwen3: [
      { value: 'Ryan', label: 'Ryan (male, dynamic, English)', language: 'english' },
      { value: 'Aiden', label: 'Aiden (male, clear, English)', language: 'english' },
    ],
    kokoro: [
      { value: 'af_heart', label: 'AF Heart (female, warm)', language: 'english' },
    ],
  },
  languages: [
    { value: '', label: 'Auto (from voice)' },
    { value: 'english', label: 'English' },
    { value: 'chinese', label: 'Chinese' },
  ],
};

describe('HandsfreeSettingsBinder', () => {
  let binder;
  let mockLog;

  const fullHandsfree = {
    stt_model: 'whisper-large-v3',
    stt_language: 'en',
    tts_enabled: true,
    tts_engine: 'qwen3',
    tts_voice: 'Ryan',
    tts_language: 'english',
    tts_speed: 1.2,
    tts_volume: 0.8,
    wake_word_model: 'Aether',
    wake_word_threshold: 0.75,
    conversation_timeout: 30,
    vad_enabled: true,
    vad_threshold: 0.5,
    vad_debounce: 300,
    interruption_enabled: false,
    interruption_threshold: 0.6,
    interruption_cooldown: 1000,
    auto_loop: true,
    push_to_talk: false,
    silence_timeout: 5000,
    proactive_tts_enabled: true,
    proactive_tts_voice: 'Ryan',
    proactive_tts_language: 'english',
  };

  /** Helper: create an element and attach to body */
  function el(tag, id, attrs = {}) {
    const e = document.createElement(tag);
    e.id = id;
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'checked') e.checked = v;
      else if (k === 'type') e.type = v;
      else e.setAttribute(k, v);
    });
    document.body.appendChild(e);
    return e;
  }

  beforeEach(() => {
    mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const mockEndpoint = {
      api: {
        get: jest.fn().mockResolvedValue(MOCK_TTS_CAPS)
      }
    };
    binder = new HandsfreeSettingsBinder({ log: mockLog, endpoint: mockEndpoint });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // =========================================================================
  // populate
  // =========================================================================
  describe('populate()', () => {
    it('does nothing when handsfree is null', async () => {
      await expect(binder.populate(null)).resolves.toBeUndefined();
    });

    it('populates STT model and language', async () => {
      el('input', 'handsfree-stt-model');
      el('input', 'handsfree-stt-language');

      await binder.populate(fullHandsfree);

      expect(document.getElementById('handsfree-stt-model').value).toBe('whisper-large-v3');
      expect(document.getElementById('handsfree-stt-language').value).toBe('en');
    });

    it('populates TTS enabled checkbox', async () => {
      el('input', 'handsfree-tts-enabled', { type: 'checkbox' });
      await binder.populate(fullHandsfree);
      expect(document.getElementById('handsfree-tts-enabled').checked).toBe(true);
    });

    it('populates TTS engine select dynamically from backend', async () => {
      el('select', 'handsfree-tts-engine');
      await binder.populate(fullHandsfree);
      const engineEl = document.getElementById('handsfree-tts-engine');
      expect(engineEl.value).toBe('qwen3');
      expect(engineEl.options.length).toBe(3); // dynamically populated from mock
    });

    it('populates TTS voice for qwen3 engine dynamically', async () => {
      el('select', 'handsfree-tts-engine');
      el('select', 'handsfree-tts-voice-qwen3');
      await binder.populate(fullHandsfree);
      const voiceEl = document.getElementById('handsfree-tts-voice-qwen3');
      expect(voiceEl.value).toBe('Ryan');
      expect(voiceEl.options.length).toBe(2); // dynamically populated from mock
    });

    it('populates TTS voice for kokoro engine dynamically', async () => {
      el('select', 'handsfree-tts-engine');
      el('select', 'handsfree-tts-voice-kokoro');
      await binder.populate({ ...fullHandsfree, tts_engine: 'kokoro', tts_voice: 'af_heart' });
      const voiceEl = document.getElementById('handsfree-tts-voice-kokoro');
      expect(voiceEl.value).toBe('af_heart');
      expect(voiceEl.options.length).toBe(1); // dynamically populated from mock
    });

    it('populates TTS language dynamically', async () => {
      el('select', 'handsfree-tts-language-qwen3');
      await binder.populate(fullHandsfree);
      const langEl = document.getElementById('handsfree-tts-language-qwen3');
      expect(langEl.value).toBe('english');
      expect(langEl.options.length).toBe(3); // dynamically populated from mock
    });

    it('populates TTS speed with display value', async () => {
      el('input', 'handsfree-tts-speed');
      el('span', 'handsfree-tts-speed-value');
      await binder.populate(fullHandsfree);
      expect(document.getElementById('handsfree-tts-speed').value).toBe('1.2');
      expect(document.getElementById('handsfree-tts-speed-value').textContent).toBe('1.2x');
    });

    it('populates TTS volume with display value', async () => {
      el('input', 'handsfree-tts-volume');
      el('span', 'handsfree-tts-volume-value');
      await binder.populate(fullHandsfree);
      expect(document.getElementById('handsfree-tts-volume').value).toBe('0.8');
      expect(document.getElementById('handsfree-tts-volume-value').textContent).toBe('80%');
    });

    it('populates wake word settings', async () => {
      el('input', 'handsfree-wake-word-model');
      el('input', 'handsfree-wake-word-threshold');
      el('span', 'handsfree-wake-word-threshold-value');
      await binder.populate(fullHandsfree);
      expect(document.getElementById('handsfree-wake-word-model').value).toBe('Aether');
      expect(document.getElementById('handsfree-wake-word-threshold').value).toBe('0.75');
      expect(document.getElementById('handsfree-wake-word-threshold-value').textContent).toBe('0.75');
    });

    it('populates VAD settings', async () => {
      el('input', 'handsfree-vad-enabled', { type: 'checkbox' });
      el('input', 'handsfree-vad-threshold');
      el('span', 'handsfree-vad-threshold-value');
      el('input', 'handsfree-vad-debounce');
      await binder.populate(fullHandsfree);
      expect(document.getElementById('handsfree-vad-enabled').checked).toBe(true);
      expect(document.getElementById('handsfree-vad-threshold').value).toBe('0.5');
      expect(document.getElementById('handsfree-vad-debounce').value).toBe('300');
    });

    it('populates interruption settings', async () => {
      el('input', 'handsfree-interruption-enabled', { type: 'checkbox' });
      el('input', 'handsfree-interruption-threshold');
      el('span', 'handsfree-interruption-threshold-value');
      el('input', 'handsfree-interruption-cooldown');
      await binder.populate(fullHandsfree);
      expect(document.getElementById('handsfree-interruption-enabled').checked).toBe(false);
      expect(document.getElementById('handsfree-interruption-threshold').value).toBe('0.6');
      expect(document.getElementById('handsfree-interruption-cooldown').value).toBe('1000');
    });

    it('populates auto_loop, push_to_talk, silence_timeout', async () => {
      el('input', 'handsfree-auto-loop', { type: 'checkbox' });
      el('input', 'handsfree-push-to-talk', { type: 'checkbox' });
      el('input', 'handsfree-silence-timeout');
      await binder.populate(fullHandsfree);
      expect(document.getElementById('handsfree-auto-loop').checked).toBe(true);
      expect(document.getElementById('handsfree-push-to-talk').checked).toBe(false);
      expect(document.getElementById('handsfree-silence-timeout').value).toBe('5000');
    });

    it('populates proactive TTS settings dynamically', async () => {
      el('input', 'proactive-tts-enabled', { type: 'checkbox' });
      await binder.populate(fullHandsfree);
      expect(document.getElementById('proactive-tts-enabled').checked).toBe(true);
    });

    it('does not throw when DOM elements are absent', async () => {
      await expect(binder.populate(fullHandsfree)).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // collect
  // =========================================================================
  describe('collect()', () => {
    it('throws when baseline is null', () => {
      expect(() => binder.collect(null)).toThrow('CONTRACT VIOLATION');
    });

    it('returns settings from DOM elements', () => {
      el('input', 'handsfree-stt-model').value = 'whisper-large-v3';
      el('input', 'handsfree-stt-language').value = 'en';
      const ttsEnabled = el('input', 'handsfree-tts-enabled', { type: 'checkbox' });
      ttsEnabled.checked = true;
      el('input', 'handsfree-tts-engine').value = 'qwen3';
      el('input', 'handsfree-tts-voice-qwen3').value = 'Ryan';
      el('input', 'handsfree-tts-language-qwen3').value = 'english';
      el('input', 'handsfree-tts-speed').value = '1.2';
      el('input', 'handsfree-tts-volume').value = '0.8';
      el('input', 'handsfree-wake-word-model').value = 'Aether';
      el('input', 'handsfree-wake-word-threshold').value = '0.75';
      el('input', 'handsfree-conversation-timeout').value = '30';
      const vadEnabled = el('input', 'handsfree-vad-enabled', { type: 'checkbox' });
      vadEnabled.checked = true;
      el('input', 'handsfree-vad-threshold').value = '0.5';
      el('input', 'handsfree-vad-debounce').value = '300';

      const result = binder.collect(fullHandsfree);
      expect(result.stt_model).toBe('whisper-large-v3');
      expect(result.tts_enabled).toBe(true);
      expect(result.tts_speed).toBe(1.2);
      expect(result.vad_enabled).toBe(true);
    });

    it('falls back to baseline when elements are absent', () => {
      const result = binder.collect(fullHandsfree);
      expect(result.stt_model).toBe(fullHandsfree.stt_model);
      expect(result.tts_speed).toBe(fullHandsfree.tts_speed);
      expect(result.wake_word_threshold).toBe(fullHandsfree.wake_word_threshold);
    });
  });

  // =========================================================================
  // updateTtsVoiceVisibility
  // =========================================================================
  describe('updateTtsVoiceVisibility()', () => {
    it('shows qwen3 fields and hides kokoro for qwen3 engine', () => {
      el('div', 'qwen3-voice-field');
      el('div', 'qwen3-language-field');
      el('div', 'kokoro-voice-field');

      binder.updateTtsVoiceVisibility('qwen3');

      expect(document.getElementById('qwen3-voice-field').style.display).toBe('');
      expect(document.getElementById('qwen3-language-field').style.display).toBe('');
      expect(document.getElementById('kokoro-voice-field').style.display).toBe('none');
    });

    it('shows kokoro field and hides qwen3 for kokoro engine', () => {
      el('div', 'qwen3-voice-field');
      el('div', 'qwen3-language-field');
      el('div', 'kokoro-voice-field');

      binder.updateTtsVoiceVisibility('kokoro');

      expect(document.getElementById('qwen3-voice-field').style.display).toBe('none');
      expect(document.getElementById('kokoro-voice-field').style.display).toBe('');
    });

    it('does not throw when elements are absent', () => {
      expect(() => binder.updateTtsVoiceVisibility('qwen3')).not.toThrow();
    });
  });

  // =========================================================================
  // updateProactiveTtsVisibility
  // =========================================================================
  describe('updateProactiveTtsVisibility()', () => {
    it('is a no-op as fields are removed from DOM', () => {
      expect(() => binder.updateProactiveTtsVisibility(true)).not.toThrow();
    });
  });

  // =========================================================================
  // autoSetLanguageFromVoice
  // =========================================================================
  describe('autoSetLanguageFromVoice()', () => {
    it('does nothing when language element is absent', () => {
      expect(() => binder.autoSetLanguageFromVoice('Ryan')).not.toThrow();
    });

    it('does nothing when language is explicitly set (non-empty)', () => {
      el('input', 'handsfree-tts-language-qwen3').value = 'chinese';
      binder.autoSetLanguageFromVoice('Ryan');
      // Should not change -- user chose an explicit language
      expect(document.getElementById('handsfree-tts-language-qwen3').value).toBe('chinese');
    });

    it('sets help text for known voice in auto mode', () => {
      const langEl = el('input', 'handsfree-tts-language-qwen3');
      langEl.value = '';
      // Create form-field wrapper with form-help
      const wrapper = document.createElement('div');
      wrapper.className = 'form-field';
      const helpEl = document.createElement('span');
      helpEl.className = 'form-help';
      wrapper.appendChild(langEl);
      wrapper.appendChild(helpEl);
      document.body.innerHTML = '';
      document.body.appendChild(wrapper);
      langEl.id = 'handsfree-tts-language-qwen3';

      binder.autoSetLanguageFromVoice('Vivian');
      expect(helpEl.textContent).toContain('chinese');
    });
  });

  // =========================================================================
  // initVoicePreviewButtons
  // =========================================================================
  describe('initVoicePreviewButtons()', () => {
    it('only wires once (idempotent)', () => {
      const btn = el('button', 'preview-voice-qwen3');
      const spy = jest.spyOn(btn, 'addEventListener');

      binder.initVoicePreviewButtons();
      binder.initVoicePreviewButtons();

      expect(spy.mock.calls.filter(c => c[0] === 'click').length).toBe(1);
      spy.mockRestore();
    });

    it('does not throw when buttons are absent', () => {
      expect(() => binder.initVoicePreviewButtons()).not.toThrow();
    });
  });

  // =========================================================================
  // wireRangeSliderLiveUpdates
  // =========================================================================
  describe('wireRangeSliderLiveUpdates()', () => {
    it('updates display when slider value changes', () => {
      const slider = el('input', 'handsfree-tts-speed');
      slider.type = 'range';
      slider.value = '1.0';
      const display = el('span', 'handsfree-tts-speed-value');

      binder.wireRangeSliderLiveUpdates();
      slider.value = '1.5';
      slider.dispatchEvent(new Event('input'));

      expect(display.textContent).toBe('1.5x');
    });

    it('only wires once (idempotent)', () => {
      const slider = el('input', 'handsfree-tts-speed');
      el('span', 'handsfree-tts-speed-value');
      const spy = jest.spyOn(slider, 'addEventListener');

      binder.wireRangeSliderLiveUpdates();
      binder.wireRangeSliderLiveUpdates();

      expect(spy.mock.calls.filter(c => c[0] === 'input').length).toBe(1);
      spy.mockRestore();
    });
  });
});
