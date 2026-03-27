'use strict';

/**
 * @.architecture
 * 
 * Incoming: STT (Speech-to-Text) stream data from IPC --- {stt_stream, object}
 * Processing: Apply transcribed text to chat input element, handle partial/final transcripts --- {2 jobs: JOB_UPDATE_DOM_ELEMENT, JOB_EMIT_EVENT}
 * Outgoing: Updated input field value, input events --- {dom_update, void}
 * 
 * @module renderer/chat/controllers/modules/STTInputManager
 */

const { createRendererLogger } = require('../../../shared/utils/logger');

const sttLogger = createRendererLogger('STTInputManager');

/**
 * STTInputManager - Speech-to-Text Input Management
 * ==================================================
 * 
 * SINGLE RESPONSIBILITY: Manage STT transcript application to input field
 * 
 * RESPONSIBILITIES:
 * - Apply STT transcripts to input element
 * - Handle partial vs final transcripts
 * - Trigger input events for reactivity
 * 
 * CONTRACTS:
 * - Requires chat input element
 * - NO business logic
 * - NO network calls
 * 
 * @module renderer/chat/controllers/modules/STTInputManager
 */
class STTInputManager {
  constructor(options = {}) {
    this.inputElement = options.inputElement || null;
    this.log = sttLogger.child({ scope: 'stt-input-manager' });

    this.log.info('STTInputManager initialized');
  }

  /**
   * Set input element reference
   * @param {HTMLElement} element - Chat input element
   */
  setInputElement(element) {
    if (!element) {
      throw new Error('[STTInputManager] Input element is REQUIRED');
    }
    this.inputElement = element;
    this.log.debug('Input element set');
  }

  /**
   * Handle STT stream data
   * @param {Object} data - STT stream payload
   * @param {string} data.text - Transcribed text
   * @param {boolean} data.isFinal - Whether transcript is final
   * @param {string} [data.source] - STT source identifier
   */
  handleStream(data) {
    try {
      const { text, isFinal, source } = data;

      if (!text) {
        this.log.trace('STT stream received without text');
        return;
      }

      if (!this.inputElement) {
        this.log.warn('STT stream received but input element not set');
        return;
      }

      if (isFinal) {
        // Final transcript: use base text (pre-STT) instead of value (which includes partial preview)
        const baseText = (this.inputElement.getAttribute('data-stt-base') ?? this.inputElement.value).trim();
        this.inputElement.value = baseText ? `${baseText} ${text}` : text;
        
        // Clear STT base for next utterance
        this.inputElement.removeAttribute('data-stt-base');
        
        this.log.debug('STT final transcript applied', { text, source });
      } else {
        // Partial transcript: show as preview
        const baseText = this.inputElement.getAttribute('data-stt-base') ?? this.inputElement.value;
        this.inputElement.value = baseText + text;
        this.inputElement.setAttribute('data-stt-base', baseText);
        
        this.log.trace('STT partial transcript received', { text, source });
      }

      // Trigger input event for reactivity
      this.inputElement.dispatchEvent(new Event('input', { bubbles: true }));

    } catch (error) {
      this.log.error('STT stream handling error', { error });
    }
  }

  /**
   * Clear STT state
   */
  clear() {
    if (this.inputElement) {
      this.inputElement.removeAttribute('data-stt-base');
      this.log.debug('STT state cleared');
    }
  }

  /**
   * Dispose and cleanup
   */
  dispose() {
    this.clear();
    this.inputElement = null;
    this.log.info('STTInputManager disposed');
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = STTInputManager;
}

if (typeof window !== 'undefined') {
  window.STTInputManager = STTInputManager;
}
