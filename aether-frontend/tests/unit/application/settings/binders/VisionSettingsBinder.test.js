/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */
'use strict';

const VisionSettingsBinder = require('../../../../../src/application/main/modules/settings/binders/VisionSettingsBinder');

// Mock /v1/document/health response for dynamic dropdown population
const MOCK_DOC_HEALTH = {
  healthy: true,
  ocr_engine_options: [
    { value: 'glm-ocr', label: 'GLM-OCR (Vision AI)', available: true, description: 'VLM OCR' },
    { value: 'easyocr', label: 'EasyOCR', available: true, description: 'Easy OCR' },
    { value: 'tesseract', label: 'Tesseract', available: true, description: 'Tesseract OCR' },
  ],
  ocr_engines: ['glm-ocr', 'easyocr', 'tesseract'],
  output_format_options: [
    { value: 'markdown', label: 'Markdown' },
    { value: 'json', label: 'JSON' },
    { value: 'text', label: 'Plain Text' },
  ],
  output_formats: ['markdown', 'json', 'text'],
};

describe('VisionSettingsBinder', () => {
  let binder;
  let mockLog;
  let mockEndpoint;

  beforeEach(() => {
    mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    mockEndpoint = { 
      getModelCapabilities: jest.fn(), 
      getBackendURL: jest.fn().mockReturnValue('http://127.0.0.1:8765'),
      api: {
        get: jest.fn().mockResolvedValue(MOCK_DOC_HEALTH)
      }
    };
    binder = new VisionSettingsBinder({ log: mockLog, endpoint: mockEndpoint });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // =========================================================================
  // Constructor / property accessors
  // =========================================================================
  describe('constructor', () => {
    it('defaults enableLogging to false', () => {
      expect(binder._enableLogging).toBe(false);
    });

    it('defaults _currentModelSupportsVision to undefined', () => {
      expect(binder.currentModelSupportsVision).toBeUndefined();
    });

    it('uses provided log', () => {
      expect(binder._log).toBe(mockLog);
    });

    it('uses provided endpoint', () => {
      expect(binder._endpoint).toBe(mockEndpoint);
    });

    it('defaults log to no-op when not provided', () => {
      const b = new VisionSettingsBinder();
      expect(() => b._log.info('x')).not.toThrow();
      expect(() => b._log.warn('x')).not.toThrow();
      expect(() => b._log.error('x')).not.toThrow();
    });

    it('defaults endpoint to null when not provided', () => {
      const b = new VisionSettingsBinder();
      expect(b._endpoint).toBeNull();
    });
  });

  describe('setters', () => {
    it('enableLogging setter works', () => {
      binder.enableLogging = true;
      expect(binder._enableLogging).toBe(true);
    });

    it('endpoint setter works', () => {
      const newEp = { getModelCapabilities: jest.fn() };
      binder.endpoint = newEp;
      expect(binder._endpoint).toBe(newEp);
    });

    it('currentModelSupportsVision getter/setter pair', () => {
      binder.currentModelSupportsVision = true;
      expect(binder.currentModelSupportsVision).toBe(true);
      binder.currentModelSupportsVision = false;
      expect(binder.currentModelSupportsVision).toBe(false);
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================
  describe('dispose()', () => {
    it('nulls endpoint', () => {
      binder.dispose();
      expect(binder._endpoint).toBeNull();
    });

    it('is idempotent', () => {
      binder.dispose();
      expect(() => binder.dispose()).not.toThrow();
    });
  });

  // =========================================================================
  // populate
  // =========================================================================
  describe('populate()', () => {
    it('does nothing when visionDocument is null', async () => {
      await expect(binder.populate(null, {})).resolves.toBeUndefined();
    });

    it('does nothing when visionDocument is undefined', async () => {
      await expect(binder.populate(undefined, {})).resolves.toBeUndefined();
    });

    it('sets OCR engine and languages dynamically from backend', async () => {
      document.body.innerHTML = '<select id="ocr-engine"></select><input id="ocr-languages"><input type="checkbox" id="enable-picture-description"><select id="doc-output-format"></select>';
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);
      await binder.populate({ ocr_engine: 'tesseract', ocr_languages: 'eng', enable_picture_description: true, output_format: 'markdown' }, {});
      expect(document.getElementById('ocr-engine').value).toBe('tesseract');
      expect(document.getElementById('ocr-engine').options.length).toBe(3); // dynamically populated
      expect(document.getElementById('ocr-languages').value).toBe('eng');
      expect(document.getElementById('enable-picture-description').checked).toBe(true);
      expect(document.getElementById('doc-output-format').value).toBe('markdown');
      expect(document.getElementById('doc-output-format').options.length).toBe(3); // dynamically populated
    });

    it('skips missing OCR elements gracefully', async () => {
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);
      // No DOM elements — should not throw
      await expect(binder.populate({ ocr_engine: 'tesseract' }, {})).resolves.toBeUndefined();
    });

    it('sets enable_picture_description to false when false', async () => {
      document.body.innerHTML = '<input type="checkbox" id="enable-picture-description" checked>';
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);
      await binder.populate({ enable_picture_description: false }, {});
      expect(document.getElementById('enable-picture-description').checked).toBe(false);
    });

    // Vision notice creation when primary model supports vision
    describe('vision notice (primary model supports vision)', () => {
      beforeEach(() => {
        mockEndpoint.getModelCapabilities.mockResolvedValue({ supports_vision: true });
        document.body.innerHTML = `
          <div id="tab-advanced"><div class="section-header">Advanced</div></div>
          <div class="settings-card"><input id="ocr-engine"></div>
          <input id="ocr-languages">
          <input type="checkbox" id="enable-picture-description">
          <input id="doc-output-format">
        `;
      });

      it('creates vision notice element when model supports vision', async () => {
        await binder.populate({ ocr_engine: 'tesseract' }, { llm: { model: 'gpt-4-vision' } });
        const notice = document.getElementById('vision-primary-llm-notice');
        expect(notice).not.toBeNull();
        expect(notice.style.display).toBe('block');
        expect(notice.textContent).toContain('Vision-Capable Primary Model Active');
      });

      it('does not duplicate notice on second populate call', async () => {
        await binder.populate({ ocr_engine: 'tesseract' }, { llm: { model: 'gpt-4-vision' } });
        await binder.populate({ ocr_engine: 'docling' }, { llm: { model: 'gpt-4-vision' } });
        const notices = document.querySelectorAll('#vision-primary-llm-notice');
        expect(notices.length).toBe(1);
      });

      it('inserts notice before vision card when found', async () => {
        // Add :has(#ocr-engine) card parent
        const visionCard = document.querySelector('.settings-card');
        await binder.populate({ ocr_engine: 'test' }, { llm: { model: 'gpt-4-vision' } });
        const notice = document.getElementById('vision-primary-llm-notice');
        expect(notice).not.toBeNull();
        // Notice should be a sibling of the vision card
        expect(notice.parentNode).toBe(visionCard.parentNode);
      });

      it('falls back to advancedHeader.after when no visionCard parent', async () => {
        // Remove the settings-card so querySelector fails
        document.body.innerHTML = `
          <div id="tab-advanced"><div class="section-header">Advanced</div></div>
          <input id="ocr-engine">
        `;
        await binder.populate({ ocr_engine: 'test' }, { llm: { model: 'gpt-4-vision' } });
        const notice = document.getElementById('vision-primary-llm-notice');
        expect(notice).not.toBeNull();
      });
    });

    describe('vision notice hidden when model does NOT support vision', () => {
      it('hides existing notice', async () => {
        document.body.innerHTML = '<div id="vision-primary-llm-notice" style="display:block"></div><input id="ocr-engine"><input type="checkbox" id="enable-picture-description">';
        mockEndpoint.getModelCapabilities.mockResolvedValue({ supports_vision: false });
        await binder.populate({ ocr_engine: 'test' }, { llm: { model: 'text-model' } });
        expect(document.getElementById('vision-primary-llm-notice').style.display).toBe('none');
      });

      it('does not crash when notice does not exist', async () => {
        document.body.innerHTML = '<input id="ocr-engine">';
        mockEndpoint.getModelCapabilities.mockResolvedValue({ supports_vision: false });
        await expect(binder.populate({ ocr_engine: 'test' }, { llm: { model: 'x' } })).resolves.toBeUndefined();
      });
    });

    describe('logging', () => {
      it('logs when enableLogging is true', async () => {
        document.body.innerHTML = '<input id="ocr-engine">';
        mockEndpoint.getModelCapabilities.mockResolvedValue(null);
        binder.enableLogging = true;
        await binder.populate({ ocr_engine: 'tesseract' }, {});
        expect(mockLog.info).toHaveBeenCalledWith(
          expect.stringContaining('[VisionSettingsBinder] Vision settings populated'),
          expect.objectContaining({ ocr_engine: 'tesseract' })
        );
      });

      it('does not log when enableLogging is false', async () => {
        document.body.innerHTML = '<input id="ocr-engine">';
        mockEndpoint.getModelCapabilities.mockResolvedValue(null);
        binder.enableLogging = false;
        await binder.populate({ ocr_engine: 'tesseract' }, {});
        expect(mockLog.info).not.toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // collect
  // =========================================================================
  describe('collect()', () => {
    it('throws when baseline is null', () => {
      expect(() => binder.collect(null)).toThrow('CONTRACT VIOLATION');
    });

    it('throws when baseline is undefined', () => {
      expect(() => binder.collect(undefined)).toThrow('CONTRACT VIOLATION');
    });

    it('throws when baseline is a string', () => {
      expect(() => binder.collect('not-an-object')).toThrow('CONTRACT VIOLATION');
    });

    it('collects from DOM elements', () => {
      document.body.innerHTML = '<input id="ocr-engine" value="tesseract"><input id="ocr-languages" value="eng"><input type="checkbox" id="enable-picture-description" checked><input id="doc-output-format" value="markdown">';
      const result = binder.collect({ ocr_engine: 'x', ocr_languages: 'y', enable_picture_description: false, output_format: 'text' });
      expect(result).toEqual({
        ocr_engine: 'tesseract',
        ocr_languages: 'eng',
        enable_picture_description: true,
        output_format: 'markdown',
      });
    });

    it('falls back to baseline when elements absent', () => {
      const baseline = { ocr_engine: 'native', ocr_languages: 'jpn', enable_picture_description: false, output_format: 'text' };
      const result = binder.collect(baseline);
      expect(result).toEqual({
        ocr_engine: 'native',
        ocr_languages: 'jpn',
        enable_picture_description: false,
        output_format: 'text',
      });
    });

    it('falls back to baseline for empty-valued elements', () => {
      document.body.innerHTML = '<input id="ocr-engine" value=""><input id="ocr-languages" value="">';
      const baseline = { ocr_engine: 'native', ocr_languages: 'jpn', enable_picture_description: true, output_format: 'md' };
      const result = binder.collect(baseline);
      expect(result.ocr_engine).toBe('native');
      expect(result.ocr_languages).toBe('jpn');
    });

    it('uses DOM value over baseline when element has value', () => {
      document.body.innerHTML = '<input id="doc-output-format" value="html">';
      const baseline = { ocr_engine: 'x', ocr_languages: 'y', enable_picture_description: false, output_format: 'text' };
      const result = binder.collect(baseline);
      expect(result.output_format).toBe('html');
    });
  });

  // =========================================================================
  // checkPrimaryModelVisionSupport
  // =========================================================================
  describe('checkPrimaryModelVisionSupport()', () => {
    it('returns cached value if set', async () => {
      binder.currentModelSupportsVision = true;
      expect(await binder.checkPrimaryModelVisionSupport({})).toBe(true);
      expect(mockEndpoint.getModelCapabilities).not.toHaveBeenCalled();
    });

    it('returns cached false value', async () => {
      binder.currentModelSupportsVision = false;
      expect(await binder.checkPrimaryModelVisionSupport({ llm: { model: 'x' } })).toBe(false);
      expect(mockEndpoint.getModelCapabilities).not.toHaveBeenCalled();
    });

    it('returns false when no currentSettings', async () => {
      expect(await binder.checkPrimaryModelVisionSupport(null)).toBe(false);
    });

    it('returns false when no llm in settings', async () => {
      expect(await binder.checkPrimaryModelVisionSupport({})).toBe(false);
    });

    it('returns false when no model name', async () => {
      expect(await binder.checkPrimaryModelVisionSupport({ llm: {} })).toBe(false);
    });

    it('returns false when no endpoint', async () => {
      binder._endpoint = null;
      expect(await binder.checkPrimaryModelVisionSupport({ llm: { model: 'gpt-4' } })).toBe(false);
    });

    it('calls endpoint.getModelCapabilities with model name', async () => {
      mockEndpoint.getModelCapabilities.mockResolvedValue({ supports_vision: true });
      const result = await binder.checkPrimaryModelVisionSupport({ llm: { model: 'gpt-4-vision' } });
      expect(result).toBe(true);
      expect(mockEndpoint.getModelCapabilities).toHaveBeenCalledWith('gpt-4-vision');
    });

    it('returns false when capabilities is null', async () => {
      mockEndpoint.getModelCapabilities.mockResolvedValue(null);
      const result = await binder.checkPrimaryModelVisionSupport({ llm: { model: 'text-model' } });
      expect(result).toBe(false);
    });

    it('returns false when supports_vision is false', async () => {
      mockEndpoint.getModelCapabilities.mockResolvedValue({ supports_vision: false });
      const result = await binder.checkPrimaryModelVisionSupport({ llm: { model: 'text-model' } });
      expect(result).toBe(false);
    });

    it('returns false and logs error on exception', async () => {
      mockEndpoint.getModelCapabilities.mockRejectedValue(new Error('network fail'));
      const result = await binder.checkPrimaryModelVisionSupport({ llm: { model: 'test' } });
      expect(result).toBe(false);
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('[VisionSettingsBinder]'),
        expect.any(Error)
      );
    });
  });
});
