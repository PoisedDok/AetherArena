'use strict';

/**
 * @.architecture
 * Incoming: SettingsManager._populateHandsfreeSettings / _collectHandsfreeSettings (method delegation) --- {handsfree_config, javascript_object}
 * Processing: Bind 20+ handsfree settings fields between backend config and DOM, manage TTS engine voice visibility, auto-detect language from voice, wire voice preview and range slider live updates --- {3 jobs: JOB_POPULATE_DOM, JOB_COLLECT_DOM, JOB_WIRE_UI}
 * Outgoing: DOM mutations (input/select values, checkbox states, display toggles, textContent) --- {dom_mutation, void}
 *
 * Extracted from SettingsManager monolith: _populateHandsfreeSettings, _collectHandsfreeSettings,
 * _updateTtsVoiceVisibility, _updateProactiveTtsVisibility, _autoSetLanguageFromVoice,
 * initVoicePreviewButtons, _wireRangeSliderLiveUpdates, _previewVoice.
 *
 * @module application/main/modules/settings/binders/HandsfreeSettingsBinder
 */

const DEFAULTS = require('../../../../../core/config/defaults');
const config = require('../../../../../core/config');

class HandsfreeSettingsBinder {
  /**
   * @param {Object} deps
   * @param {Object} deps.log - Logger instance
   * @param {Object} [deps.endpoint] - Backend endpoint (for voice preview)
   */
  constructor(deps = {}) {
    this._log = deps.log || { info() {}, warn() {}, error() {} };
    this._endpoint = deps.endpoint || null;
    this._enableLogging = false;
    this._voicePreviewWired = false;
    this._rangeSliderWired = false;
    this._previewAudioSource = null;
    this._listeners = [];
  }

  _trackListener(el, event, handler) {
    if (!el) return;
    el.addEventListener(event, handler);
    this._listeners.push({ el, event, handler });
  }

  dispose() {
    for (const { el, event, handler } of this._listeners) {
      el.removeEventListener(event, handler);
    }
    this._listeners = [];
    if (this._previewAudioSource) {
      try { this._previewAudioSource.stop(); } catch (_) { /* ignore */ }
      this._previewAudioSource = null;
    }
    this._voicePreviewWired = false;
    this._rangeSliderWired = false;
    this._endpoint = null;
  }

  set enableLogging(v) { this._enableLogging = v; }
  set endpoint(v) { this._endpoint = v; }

  // =========================================================================
  // Dynamic TTS Capabilities (SSOT from backend)
  // =========================================================================

  /**
   * Populate a single <select> element from an array of {value, label} options.
   * @private
   */
  _populateSelect(selectId, options, selectedValue) {
    const el = document.getElementById(selectId);
    if (!el || !Array.isArray(options)) return;

    el.innerHTML = '';
    for (const opt of options) {
      const optEl = document.createElement('option');
      optEl.value = opt.value;
      optEl.textContent = opt.label;
      if (opt.available === false) {
        optEl.disabled = true;
        optEl.textContent += ' (unavailable)';
      }
      el.appendChild(optEl);
    }
    if (selectedValue !== undefined && selectedValue !== null) {
      el.value = selectedValue;
    }
  }

  /**
   * Fetch TTS capabilities from backend and populate all TTS dropdowns.
   * Covers: handsfree TTS engine, voices (qwen3/kokoro), language,
   * proactive TTS voice and language.
   * @private
   */
  async _populateTtsCapabilities(handsfree) {
    try {
      if (!this._endpoint) throw new Error('Endpoint not initialized');
      const caps = await this._endpoint.api.get('/v1/tts/capabilities');

      // Engines
      if (caps.engines) {
        this._populateSelect('handsfree-tts-engine', caps.engines, handsfree.tts_engine);
      }

      // Qwen3 voices
      if (caps.voices?.qwen3) {
        const engine = handsfree.tts_engine || 'qwen3';
        const selectedVoice = engine === 'qwen3' ? handsfree.tts_voice : undefined;
        this._populateSelect('handsfree-tts-voice-qwen3', caps.voices.qwen3, selectedVoice);
      }

      // Kokoro voices
      if (caps.voices?.kokoro) {
        const engine = handsfree.tts_engine || 'qwen3';
        const selectedVoice = engine === 'kokoro' ? handsfree.tts_voice : undefined;
        this._populateSelect('handsfree-tts-voice-kokoro', caps.voices.kokoro, selectedVoice);
      }

      // Languages
      if (caps.languages) {
        this._populateSelect('handsfree-tts-language-qwen3', caps.languages, handsfree.tts_language);
      }

      if (this._enableLogging) {
        this._log.info('[HandsfreeSettingsBinder] TTS capabilities populated from backend', {
          engines: caps.engines?.length, voices: Object.keys(caps.voices || {}), languages: caps.languages?.length
        });
      }
    } catch (err) {
      this._log.warn('[HandsfreeSettingsBinder] Failed to fetch TTS capabilities, keeping placeholders:', err.message);
    }
  }

  // =========================================================================
  // Populate
  // =========================================================================

  /**
   * Populate all handsfree settings into DOM.
   * @param {Object} handsfree - Handsfree config from backend
   */
  async populate(handsfree) {
    if (!handsfree) return;

    // Dynamically populate TTS dropdowns from backend (SSOT)
    await this._populateTtsCapabilities(handsfree);

    // Global Handsfree Enabled Toggle
    this._setChecked('handsfree-enabled', handsfree.enabled);
    
    // Also explicitly trigger the visibility of advanced settings container
    const advancedContainer = document.getElementById('handsfree-advanced-settings');
    if (advancedContainer) {
      advancedContainer.style.display = handsfree.enabled ? 'block' : 'none';
      document
        .querySelectorAll('#handsfree-advanced-settings input, #handsfree-advanced-settings select')
        .forEach((el) => {
          el.disabled = !handsfree.enabled;
        });
    }

    // STT
    this._setInputValue('handsfree-stt-model', handsfree.stt_model);
    this._setInputValue('handsfree-stt-language', handsfree.stt_language);

    // TTS Enabled
    this._setChecked('handsfree-tts-enabled', handsfree.tts_enabled);

    // Show/hide engine-specific voice dropdowns
    this.updateTtsVoiceVisibility(handsfree.tts_engine || 'qwen3');

    // TTS Speed + display
    this._setSliderWithDisplay('handsfree-tts-speed', 'handsfree-tts-speed-value',
      handsfree.tts_speed, (v) => `${v}x`);

    // TTS Volume + display
    this._setSliderWithDisplay('handsfree-tts-volume', 'handsfree-tts-volume-value',
      handsfree.tts_volume, (v) => `${Math.round(v * 100)}%`);

    // Wake Word
    this._setInputValue('handsfree-wake-word-model', handsfree.wake_word_model);
    this._setSliderWithDisplay('handsfree-wake-word-threshold', 'handsfree-wake-word-threshold-value',
      handsfree.wake_word_threshold, (v) => v.toFixed(2));

    // Conversation Timeout
    this._setInputValueIfDefined('handsfree-conversation-timeout', handsfree.conversation_timeout);

    // VAD
    this._setChecked('handsfree-vad-enabled', handsfree.vad_enabled);
    this._setSliderWithDisplay('handsfree-vad-threshold', 'handsfree-vad-threshold-value',
      handsfree.vad_threshold, (v) => v.toFixed(2));
    this._setInputValueIfDefined('handsfree-vad-debounce', handsfree.vad_debounce);

    // Interruption
    this._setChecked('handsfree-interruption-enabled', handsfree.interruption_enabled);
    this._setSliderWithDisplay('handsfree-interruption-threshold', 'handsfree-interruption-threshold-value',
      handsfree.interruption_threshold, (v) => v.toFixed(2));
    this._setInputValueIfDefined('handsfree-interruption-cooldown', handsfree.interruption_cooldown);

    // Auto Loop / Push to Talk / Silence Timeout
    this._setChecked('handsfree-auto-loop', handsfree.auto_loop);
    this._setChecked('handsfree-push-to-talk', handsfree.push_to_talk);
    this._setInputValueIfDefined('handsfree-silence-timeout', handsfree.silence_timeout);

    // Proactive Agent TTS (toggle visibility)
    this._setChecked('proactive-tts-enabled', handsfree.proactive_tts_enabled);
    const proactiveTtsEnabledEl = document.getElementById('proactive-tts-enabled');
    this.updateProactiveTtsVisibility(proactiveTtsEnabledEl ? proactiveTtsEnabledEl.checked : false);

    // Wire voice preview + range sliders
    this.initVoicePreviewButtons();
    this.wireRangeSliderLiveUpdates();

    if (this._enableLogging) {
      this._log.info('[HandsfreeSettingsBinder] Handsfree settings populated', handsfree);
    }
  }

  // =========================================================================
  // Collect
  // =========================================================================

  /**
   * Collect handsfree settings from DOM.
   * @param {Object} baseline - Current handsfree settings from backend (fallback values)
   * @returns {Object}
   */
  collect(baseline) {
    if (!baseline || typeof baseline !== 'object') {
      throw new Error('[HandsfreeSettingsBinder] CONTRACT VIOLATION: handsfree baseline settings required');
    }

    const ttsEngineEl = document.getElementById('handsfree-tts-engine');
    const currentEngine = ttsEngineEl ? ttsEngineEl.value : 'qwen3';
    const ttsVoiceEl = currentEngine === 'qwen3'
      ? document.getElementById('handsfree-tts-voice-qwen3')
      : currentEngine === 'kokoro'
        ? document.getElementById('handsfree-tts-voice-kokoro')
        : null;
    const ttsLanguageEl = document.getElementById('handsfree-tts-language-qwen3');

    const settings = {
      enabled: this._getCheckedOrFallback('handsfree-enabled', baseline.enabled),
      stt_model: this._getInputOrFallback('handsfree-stt-model', baseline.stt_model),
      stt_language: this._getInputOrFallback('handsfree-stt-language', baseline.stt_language),
      tts_enabled: this._getCheckedOrFallback('handsfree-tts-enabled', baseline.tts_enabled),
      tts_engine: this._getInputOrFallback('handsfree-tts-engine', baseline.tts_engine),
      tts_voice: (ttsVoiceEl && ttsVoiceEl.value) ? ttsVoiceEl.value : baseline.tts_voice,
      tts_language: (ttsLanguageEl && ttsLanguageEl.value !== undefined) ? ttsLanguageEl.value : (baseline.tts_language || ''),
      tts_speed: this._getFloatOrFallback('handsfree-tts-speed', baseline.tts_speed),
      tts_volume: this._getFloatOrFallback('handsfree-tts-volume', baseline.tts_volume),
      wake_word_model: this._getInputOrFallback('handsfree-wake-word-model', baseline.wake_word_model),
      wake_word_threshold: this._getFloatOrFallback('handsfree-wake-word-threshold', baseline.wake_word_threshold),
      conversation_timeout: this._getIntOrFallback('handsfree-conversation-timeout', baseline.conversation_timeout),
      vad_enabled: this._getCheckedOrFallback('handsfree-vad-enabled', baseline.vad_enabled),
      vad_threshold: this._getFloatOrFallback('handsfree-vad-threshold', baseline.vad_threshold),
      vad_debounce: this._getIntOrFallback('handsfree-vad-debounce', baseline.vad_debounce),
      interruption_enabled: this._getCheckedOrFallback('handsfree-interruption-enabled', baseline.interruption_enabled),
      interruption_threshold: this._getFloatOrFallback('handsfree-interruption-threshold', baseline.interruption_threshold),
      interruption_cooldown: this._getIntOrFallback('handsfree-interruption-cooldown', baseline.interruption_cooldown),
      auto_loop: this._getCheckedOrFallback('handsfree-auto-loop', baseline.auto_loop),
      push_to_talk: this._getCheckedOrFallback('handsfree-push-to-talk', baseline.push_to_talk),
      silence_timeout: this._getIntOrFallback('handsfree-silence-timeout', baseline.silence_timeout),
      proactive_tts_enabled: this._getCheckedOrFallback('proactive-tts-enabled', baseline.proactive_tts_enabled),
      // Unify Proactive TTS voice and language with main TTS settings
      proactive_tts_voice: (ttsVoiceEl && ttsVoiceEl.value) ? ttsVoiceEl.value : baseline.tts_voice,
      proactive_tts_language: (ttsLanguageEl && ttsLanguageEl.value !== undefined) ? ttsLanguageEl.value : (baseline.tts_language || ''),
    };

    if (this._enableLogging) {
      this._log.info('[HandsfreeSettingsBinder] Handsfree settings collected', settings);
    }

    return settings;
  }

  // =========================================================================
  // TTS Voice Visibility
  // =========================================================================

  updateTtsVoiceVisibility(engine) {
    const qwen3Field = document.getElementById('qwen3-voice-field');
    const qwen3LangField = document.getElementById('qwen3-language-field');
    const kokoroField = document.getElementById('kokoro-voice-field');
    if (qwen3Field) qwen3Field.style.display = (engine === 'qwen3') ? '' : 'none';
    if (qwen3LangField) qwen3LangField.style.display = (engine === 'qwen3') ? '' : 'none';
    if (kokoroField) kokoroField.style.display = (engine === 'kokoro') ? '' : 'none';
  }

  updateProactiveTtsVisibility(enabled) {
    // Proactive TTS voice/language fields are now unified with main TTS fields and removed from DOM.
    // No dynamic DOM updates required here.
  }

  // =========================================================================
  // Auto-language
  // =========================================================================

  autoSetLanguageFromVoice(voiceName) {
    const langEl = document.getElementById('handsfree-tts-language-qwen3');
    if (!langEl) return;
    if (langEl.value !== '') return;

    const voiceLanguageMap = {
      'Ryan': 'english',
      'Aiden': 'english',
      'Vivian': 'chinese',
      'Serena': 'chinese',
      'Uncle_Fu': 'chinese',
      'Dylan': 'chinese',
      'Eric': 'chinese',
      'Ono_Anna': 'japanese',
      'Sohee': 'korean',
    };

    const helpEl = langEl.closest('.form-field')?.querySelector('.form-help');
    const nativeLang = voiceLanguageMap[voiceName] || 'english';
    if (helpEl) {
      helpEl.textContent = `Auto mode: will use "${nativeLang}" (${voiceName}'s native language)`;
    }
  }

  // =========================================================================
  // Voice Preview
  // =========================================================================

  initVoicePreviewButtons() {
    if (this._voicePreviewWired) return;
    this._voicePreviewWired = true;

    const qwen3Btn = document.getElementById('preview-voice-qwen3');
    const kokoroBtn = document.getElementById('preview-voice-kokoro');

    this._trackListener(qwen3Btn, 'click', () => {
      const voiceEl = document.getElementById('handsfree-tts-voice-qwen3');
      this.previewVoice('qwen3', voiceEl ? voiceEl.value : 'Ryan', qwen3Btn);
    });
    this._trackListener(kokoroBtn, 'click', () => {
      const voiceEl = document.getElementById('handsfree-tts-voice-kokoro');
      this.previewVoice('kokoro', voiceEl ? voiceEl.value : 'af_heart', kokoroBtn);
    });
  }

  async previewVoice(engine, voice, btn) {
    if (btn.classList.contains('is-loading') || btn.classList.contains('is-playing')) {
      if (this._previewAudioSource) {
        try { this._previewAudioSource.stop(); } catch (_) { /* ignore */ }
        this._previewAudioSource = null;
      }
      btn.classList.remove('is-loading', 'is-playing', 'is-error');
      btn.innerHTML = '<i class="fas fa-play"></i> Preview Voice';
      return;
    }

    btn.classList.add('is-loading');
    btn.classList.remove('is-error', 'is-playing');
    btn.innerHTML = '<i class="fas fa-spinner"></i> Loading...';

    try {
      if (!this._endpoint) throw new Error('Endpoint not initialized');
      const arrayBuffer = await this._endpoint.api.post('/v1/tts/preview', { engine, voice }, { responseType: 'arraybuffer' });
      if (arrayBuffer.byteLength === 0) {
        throw new Error('Empty audio response');
      }

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);

      this._previewAudioSource = source;

      btn.classList.remove('is-loading');
      btn.classList.add('is-playing');
      btn.innerHTML = '<i class="fas fa-stop"></i> Playing...';

      source.onended = () => {
        btn.classList.remove('is-playing');
        btn.innerHTML = '<i class="fas fa-play"></i> Preview Voice';
        this._previewAudioSource = null;
        audioCtx.close().catch(() => {});
      };

      source.start(0);

    } catch (error) {
      this._log.error('[HandsfreeSettingsBinder] Voice preview failed:', error);
      btn.classList.remove('is-loading', 'is-playing');
      btn.classList.add('is-error');
      btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Preview Failed';

      setTimeout(() => {
        btn.classList.remove('is-error');
        btn.innerHTML = '<i class="fas fa-play"></i> Preview Voice';
      }, 3000);
    }
  }

  // =========================================================================
  // Range Slider Live Updates
  // =========================================================================

  wireRangeSliderLiveUpdates() {
    if (this._rangeSliderWired) return;
    this._rangeSliderWired = true;

    const sliders = [
      { input: 'handsfree-tts-speed', display: 'handsfree-tts-speed-value', format: (v) => `${parseFloat(v).toFixed(1)}x` },
      { input: 'handsfree-tts-volume', display: 'handsfree-tts-volume-value', format: (v) => `${Math.round(parseFloat(v) * 100)}%` },
      { input: 'handsfree-vad-threshold', display: 'handsfree-vad-threshold-value', format: (v) => parseFloat(v).toFixed(2) },
      { input: 'handsfree-wake-word-threshold', display: 'handsfree-wake-word-threshold-value', format: (v) => parseFloat(v).toFixed(2) },
      { input: 'handsfree-interruption-threshold', display: 'handsfree-interruption-threshold-value', format: (v) => parseFloat(v).toFixed(2) },
    ];

    for (const { input, display, format } of sliders) {
      const inputEl = document.getElementById(input);
      const displayEl = document.getElementById(display);
      if (inputEl && displayEl) {
        this._trackListener(inputEl, 'input', () => {
          displayEl.textContent = format(inputEl.value);
        });
      }
    }
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  _setInputValue(id, value) {
    if (!value) return;
    const el = document.getElementById(id);
    if (el) el.value = value;
  }

  _setInputValueIfDefined(id, value) {
    if (value === undefined) return;
    const el = document.getElementById(id);
    if (el) el.value = value;
  }

  _setChecked(id, value) {
    if (value === undefined) return;
    const el = document.getElementById(id);
    if (el) el.checked = value;
  }

  _setSliderWithDisplay(sliderId, displayId, value, formatter) {
    if (value === undefined) return;
    const sliderEl = document.getElementById(sliderId);
    const displayEl = document.getElementById(displayId);
    if (sliderEl) sliderEl.value = value;
    if (displayEl) displayEl.textContent = formatter(value);
  }

  _getInputOrFallback(id, fallback) {
    const el = document.getElementById(id);
    return (el && el.value) ? el.value : fallback;
  }

  _getInputValueOrDefault(id, defaultValue) {
    const el = document.getElementById(id);
    return (el && el.value !== undefined) ? el.value : defaultValue;
  }

  _getCheckedOrFallback(id, fallback) {
    const el = document.getElementById(id);
    return el ? (el.checked === true) : Boolean(fallback);
  }

  _getFloatOrFallback(id, fallback) {
    const el = document.getElementById(id);
    const raw = el?.value;
    return (raw && String(raw).trim().length) ? parseFloat(raw) : fallback;
  }

  _getIntOrFallback(id, fallback) {
    const el = document.getElementById(id);
    const raw = el?.value;
    return (raw && String(raw).trim().length) ? parseInt(raw, 10) : fallback;
  }
}

module.exports = HandsfreeSettingsBinder;
