'use strict';

/**
 * @.architecture
 * Incoming: SettingsManager delegation for vision document settings --- {vision_document, javascript_object}
 * Processing: Populate/collect OCR engine, languages, picture description, output format; check primary model vision support --- {3 jobs: JOB_POPULATE, JOB_COLLECT, JOB_CHECK_VISION}
 * Outgoing: DOM mutations, endpoint.getModelCapabilities() --- {dom_mutation | http_request, void | boolean}
 *
 * @module application/main/modules/settings/binders/VisionSettingsBinder
 */

const config = require('../../../../../core/config');

class VisionSettingsBinder {
  constructor(deps = {}) {
    this._log = deps.log || { info() {}, warn() {}, error() {} };
    this._endpoint = deps.endpoint || null;
    this._enableLogging = false;
    this._currentModelSupportsVision = undefined;
  }

  dispose() {
    this._endpoint = null;
  }

  set enableLogging(v) { this._enableLogging = v; }
  set endpoint(v) { this._endpoint = v; }

  /** @returns {boolean|undefined} */
  get currentModelSupportsVision() { return this._currentModelSupportsVision; }
  set currentModelSupportsVision(v) { this._currentModelSupportsVision = v; }

  async checkPrimaryModelVisionSupport(currentSettings) {
    try {
      if (this._currentModelSupportsVision !== undefined) {
        return this._currentModelSupportsVision;
      }
      if (currentSettings && currentSettings.llm) {
        const modelName = currentSettings.llm.model;
        if (modelName && this._endpoint) {
          const capabilities = await this._endpoint.getModelCapabilities(modelName);
          return capabilities?.supports_vision || false;
        }
      }
      return false;
    } catch (error) {
      this._log.error('[VisionSettingsBinder] Failed to check primary model vision support:', error);
      return false;
    }
  }

  /**
   * Fetch document capabilities from backend and populate both OCR engine
   * and output format dropdowns. Single fetch, dual population.
   * Backend is SSOT — frontend never hardcodes these lists.
   * @private
   */
  async _populateDocumentCapabilities(selectedEngine, selectedOutputFormat) {
    try {
      if (!this._endpoint) throw new Error('Endpoint not initialized');
      const health = await this._endpoint.api.get('/v1/document/health');

      // ── OCR Engine dropdown ──
      const ocrEngineEl = document.getElementById('ocr-engine');
      if (ocrEngineEl) {
        const engineOptions = health.ocr_engine_options || [];
        ocrEngineEl.innerHTML = '';

        if (engineOptions.length === 0) {
          // Fallback: backend didn't return rich options (older version)
          for (const val of (health.ocr_engines || [])) {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = val;
            ocrEngineEl.appendChild(opt);
          }
        } else {
          for (const engine of engineOptions) {
            const opt = document.createElement('option');
            opt.value = engine.value;
            opt.textContent = engine.label;
            if (!engine.available) {
              opt.disabled = true;
              opt.textContent += ' (unavailable)';
            }
            if (engine.description) opt.title = engine.description;
            ocrEngineEl.appendChild(opt);
          }
        }

        if (selectedEngine) {
          ocrEngineEl.value = selectedEngine;
          if (ocrEngineEl.value !== selectedEngine) {
            const firstAvailable = engineOptions.find(e => e.available);
            if (firstAvailable) ocrEngineEl.value = firstAvailable.value;
          }
        }
      }

      // ── Output Format dropdown ──
      const formatEl = document.getElementById('doc-output-format');
      if (formatEl) {
        const formatOptions = health.output_format_options || [];
        formatEl.innerHTML = '';

        if (formatOptions.length === 0) {
          // Fallback: plain list
          for (const val of (health.output_formats || [])) {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = val;
            formatEl.appendChild(opt);
          }
        } else {
          for (const fmt of formatOptions) {
            const opt = document.createElement('option');
            opt.value = fmt.value;
            opt.textContent = fmt.label;
            formatEl.appendChild(opt);
          }
        }

        if (selectedOutputFormat) {
          formatEl.value = selectedOutputFormat;
        }
      }

      if (this._enableLogging) {
        this._log.info('[VisionSettingsBinder] Document capabilities populated from backend', {
          ocrEngines: (health.ocr_engine_options || []).length,
          outputFormats: (health.output_format_options || []).length,
        });
      }
    } catch (err) {
      this._log.warn('[VisionSettingsBinder] Failed to fetch document capabilities:', err.message);
    }
  }

  async populate(visionDocument, currentSettings) {
    if (!visionDocument) return;

    const primaryModelSupportsVision = await this.checkPrimaryModelVisionSupport(currentSettings);

    if (primaryModelSupportsVision) {
      const visionCard = document.querySelector('.settings-card:has(#ocr-engine)') || null;
      let noticeEl = document.getElementById('vision-primary-llm-notice');
      if (!noticeEl) {
        noticeEl = document.createElement('div');
        noticeEl.id = 'vision-primary-llm-notice';
        noticeEl.className = 'vision-info-notice';
        noticeEl.innerHTML = `
          <div class="vision-notice-body">
            <div class="vision-notice-icon">i</div>
            <div class="vision-notice-content">
              <div class="vision-notice-title">Vision-Capable Primary Model Active</div>
              <p class="vision-notice-desc">
                Your primary language model supports native vision processing. Images will be sent directly to the primary model for optimal performance. 
                The Vision/OCR provider in AI Services is used as fallback when a text-only primary model is configured.
              </p>
            </div>
          </div>
        `;
        if (visionCard && visionCard.parentNode) {
          visionCard.parentNode.insertBefore(noticeEl, visionCard);
        } else {
          const advancedHeader = document.querySelector('#tab-advanced .section-header');
          if (advancedHeader) advancedHeader.after(noticeEl);
        }
      }
      noticeEl.style.display = 'block';
    } else {
      const noticeEl = document.getElementById('vision-primary-llm-notice');
      if (noticeEl) noticeEl.style.display = 'none';
    }

    // Dynamically populate OCR engine + output format dropdowns from backend (SSOT)
    await this._populateDocumentCapabilities(visionDocument.ocr_engine, visionDocument.output_format);

    const ocrLangsEl = document.getElementById('ocr-languages');
    if (ocrLangsEl && visionDocument.ocr_languages) ocrLangsEl.value = visionDocument.ocr_languages;

    const picDescEl = document.getElementById('enable-picture-description');
    if (picDescEl) picDescEl.checked = visionDocument.enable_picture_description === true;

    // doc-output-format is populated by _populateDocumentCapabilities above

    if (this._enableLogging) {
      this._log.info('[VisionSettingsBinder] Vision settings populated', { ocr_engine: visionDocument.ocr_engine, primaryModelSupportsVision });
    }
  }

  collect(baseline) {
    if (!baseline || typeof baseline !== 'object') {
      throw new Error('[VisionSettingsBinder] CONTRACT VIOLATION: vision_document baseline required');
    }

    const ocrEngineEl = document.getElementById('ocr-engine');
    const ocrLangsEl = document.getElementById('ocr-languages');
    const picDescEl = document.getElementById('enable-picture-description');
    const outputFormatEl = document.getElementById('doc-output-format');

    return {
      ocr_engine: (ocrEngineEl && ocrEngineEl.value) ? ocrEngineEl.value : baseline.ocr_engine,
      ocr_languages: (ocrLangsEl && ocrLangsEl.value) ? ocrLangsEl.value : baseline.ocr_languages,
      enable_picture_description: picDescEl ? (picDescEl.checked === true) : (baseline.enable_picture_description === true),
      output_format: (outputFormatEl && outputFormatEl.value) ? outputFormatEl.value : baseline.output_format,
    };
  }
}

module.exports = VisionSettingsBinder;
