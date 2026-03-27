'use strict';

/**
 * @.architecture
 * Incoming: SettingsManager constructor (wiring), document input/change events (user interaction) --- {dom_event, Event}
 * Processing: Track dirty state via document-level event delegation on #settings-modal, update DOM status indicator and save button, delegate TTS-related change events to callbacks --- {3 jobs: JOB_TRACK_STATE, JOB_UPDATE_DOM, JOB_DELEGATE_EVENT}
 * Outgoing: DOM updates (#settings-status text, #settings-save button state), callback invocations (onTtsEngineChange, onQwen3VoiceChange, onProactiveTtsToggle) --- {dom_mutation | callback, void}
 *
 * Extracted from SettingsManager monolith: _setupDirtyTracking(), _setDirty(), _inputHandler, _changeHandler.
 * Single responsibility: document-level event delegation for settings dirty tracking.
 *
 * @module application/main/modules/settings/DirtyTracker
 */

class DirtyTracker {
  /**
   * @param {Object} callbacks
   * @param {Function} [callbacks.isPopulating] - Returns true when UI is being programmatically populated (suppress dirty)
   * @param {Function} [callbacks.onTtsEngineChange] - Called when handsfree-tts-engine changes (value)
   * @param {Function} [callbacks.onQwen3VoiceChange] - Called when handsfree-tts-voice-qwen3 changes (value)
   * @param {Function} [callbacks.onProactiveTtsToggle] - Called when proactive-tts-enabled changes (checked)
   */
  constructor(callbacks = {}) {
    this._isDirty = false;
    this._inputHandler = null;
    this._changeHandler = null;
    this._isPopulating = callbacks.isPopulating || (() => false);
    this._onTtsEngineChange = callbacks.onTtsEngineChange || null;
    this._onQwen3VoiceChange = callbacks.onQwen3VoiceChange || null;
    this._onProactiveTtsToggle = callbacks.onProactiveTtsToggle || null;
  }

  /**
   * Attach document-level event listeners for dirty tracking.
   * Must be called once after construction.
   */
  attach() {
    this._inputHandler = (e) => {
      const modal = document.getElementById('settings-modal');
      if (modal && modal.contains(e.target)) {
        this.setDirty(true);
      }
    };

    this._changeHandler = (e) => {
      const modal = document.getElementById('settings-modal');
      if (modal && modal.contains(e.target)) {
        this.setDirty(true);
      }
      // Toggle voice dropdown visibility when TTS engine changes
      if (e.target && e.target.id === 'handsfree-tts-engine' && this._onTtsEngineChange) {
        this._onTtsEngineChange(e.target.value);
      }
      // Auto-set TTS language when Qwen3 voice changes (unless user explicitly chose one)
      if (e.target && e.target.id === 'handsfree-tts-voice-qwen3' && this._onQwen3VoiceChange) {
        this._onQwen3VoiceChange(e.target.value);
      }
      // Toggle proactive TTS voice/language visibility when toggle changes
      if (e.target && e.target.id === 'proactive-tts-enabled' && this._onProactiveTtsToggle) {
        this._onProactiveTtsToggle(e.target.checked);
      }
    };

    document.addEventListener('input', this._inputHandler);
    document.addEventListener('change', this._changeHandler);
  }

  /**
   * Detach document-level event listeners. Safe to call multiple times.
   */
  detach() {
    if (this._inputHandler) {
      document.removeEventListener('input', this._inputHandler);
      this._inputHandler = null;
    }
    if (this._changeHandler) {
      document.removeEventListener('change', this._changeHandler);
      this._changeHandler = null;
    }
  }

  /**
   * Set dirty state and update DOM indicators.
   * Suppressed when isPopulating() returns true.
   * @param {boolean} dirty
   */
  setDirty(dirty) {
    if (this._isPopulating()) return;

    this._isDirty = dirty;
    const statusEl = document.getElementById('settings-status');
    const saveBtn = document.getElementById('settings-save');

    if (statusEl) {
      if (dirty) {
        statusEl.textContent = '\u25CF Unsaved changes';
        statusEl.style.color = 'var(--color-warning)';
        statusEl.style.opacity = '1';
      } else {
        statusEl.textContent = '';
      }
    }

    if (saveBtn) {
      if (dirty) {
        saveBtn.classList.add('is-dirty');
        saveBtn.disabled = false;
      } else {
        saveBtn.classList.remove('is-dirty');
        saveBtn.disabled = true;
      }
    }
  }

  /**
   * @returns {boolean} Current dirty state
   */
  isDirty() {
    return this._isDirty;
  }
}

module.exports = DirtyTracker;
