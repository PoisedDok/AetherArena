/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */
'use strict';

const SummarySettingsBinder = require('../../../../../src/application/main/modules/settings/binders/SummarySettingsBinder');

/**
 * Helper: build the full DOM scaffold for summary settings.
 * Mirrors the real HTML IDs used in the settings panel.
 */
function buildSummaryDom() {
  document.body.innerHTML = `
    <input type="checkbox" id="auto-summarize-enabled">
    <div id="auto-summarize-config" style="display:none;"></div>
    <input id="summary-model" value="">
    <input id="summary-temperature" value="">
    <input id="summary-max-tokens" value="">
    <input id="summary-title-max-length" value="">
    <input id="summary-key-points-max" value="">
    <input id="summary-default-search-limit" value="">
    <textarea id="summary-system-prompt"></textarea>
    <span id="summary-valid-types"></span>
  `;
}

describe('SummarySettingsBinder', () => {
  let binder;
  const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  beforeEach(() => {
    binder = new SummarySettingsBinder({ log: mockLog });
    jest.clearAllMocks();
  });
  afterEach(() => { document.body.innerHTML = ''; });

  // ==========================================================================
  // populate()
  // ==========================================================================

  describe('populate()', () => {
    it('does nothing when toggle element is absent', () => {
      // DOM is empty -- no #auto-summarize-enabled
      binder.populate({ summary_service: { auto_summarize: true } });
      // No crash, no DOM changes
    });

    it('sets toggle checked and panel visible when auto_summarize is true (from summary_service)', () => {
      buildSummaryDom();
      binder.populate({ summary_service: { auto_summarize: true } });
      expect(document.getElementById('auto-summarize-enabled').checked).toBe(true);
      expect(document.getElementById('auto-summarize-config').style.display).toBe('block');
    });

    it('sets toggle unchecked and panel hidden when auto_summarize is false', () => {
      buildSummaryDom();
      binder.populate({ summary_service: { auto_summarize: false } });
      expect(document.getElementById('auto-summarize-enabled').checked).toBe(false);
      expect(document.getElementById('auto-summarize-config').style.display).toBe('none');
    });

    it('prefers summary_service.auto_summarize over summary.auto_summarize', () => {
      buildSummaryDom();
      binder.populate({
        summary_service: { auto_summarize: false },
        summary: { auto_summarize: true },
      });
      expect(document.getElementById('auto-summarize-enabled').checked).toBe(false);
    });

    it('falls back to summary.auto_summarize when summary_service lacks it', () => {
      buildSummaryDom();
      binder.populate({
        summary_service: {},
        summary: { auto_summarize: true },
      });
      expect(document.getElementById('auto-summarize-enabled').checked).toBe(true);
    });

    it('defaults to false when neither source has auto_summarize', () => {
      buildSummaryDom();
      binder.populate({});
      expect(document.getElementById('auto-summarize-enabled').checked).toBe(false);
    });

    it('populates model from prefs.model', () => {
      buildSummaryDom();
      binder.populate({ summary: { model: 'gpt-4' } });
      expect(document.getElementById('summary-model').value).toBe('gpt-4');
    });

    it('falls back to llm.summarizer_model for model when prefs.model absent', () => {
      buildSummaryDom();
      binder.populate({ llm: { summarizer_model: 'claude-3' } });
      expect(document.getElementById('summary-model').value).toBe('claude-3');
    });

    it('populates numeric fields preferring prefs over svc', () => {
      buildSummaryDom();
      binder.populate({
        summary_service: { temperature: 0.5, max_tokens: 1000 },
        summary: { temperature: 0.9 },
      });
      expect(document.getElementById('summary-temperature').value).toBe('0.9');
      expect(document.getElementById('summary-max-tokens').value).toBe('1000');
    });

    it('populates valid_summary_types as comma-joined string', () => {
      buildSummaryDom();
      binder.populate({
        summary_service: { valid_summary_types: ['brief', 'detailed'] },
      });
      expect(document.getElementById('summary-valid-types').textContent).toBe('brief, detailed');
    });

    it('shows (none) for empty valid_summary_types array', () => {
      buildSummaryDom();
      binder.populate({ summary_service: { valid_summary_types: [] } });
      expect(document.getElementById('summary-valid-types').textContent).toBe('(none)');
    });

    it('populates system_prompt_template preferring prefs', () => {
      buildSummaryDom();
      binder.populate({
        summary_service: { system_prompt_template: 'svc-prompt' },
        summary: { system_prompt_template: 'user-prompt' },
      });
      expect(document.getElementById('summary-system-prompt').value).toBe('user-prompt');
    });

    it('handles non-object summary_service gracefully', () => {
      buildSummaryDom();
      binder.populate({ summary_service: 'invalid' });
      // Should not crash; treats as empty object
      expect(document.getElementById('auto-summarize-enabled').checked).toBe(false);
    });

    it('logs error when populate throws internally', () => {
      buildSummaryDom();
      // Force internal error by making getElementById throw on a specific call
      const origGetById = document.getElementById.bind(document);
      let callCount = 0;
      jest.spyOn(document, 'getElementById').mockImplementation((id) => {
        callCount++;
        if (id === 'summary-model') throw new Error('test-error');
        return origGetById(id);
      });

      binder.populate({ summary_service: { auto_summarize: true } });
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to populate'),
        expect.any(Error),
      );

      document.getElementById.mockRestore();
    });
  });

  // ==========================================================================
  // attachListenersOnce()
  // ==========================================================================

  describe('attachListenersOnce()', () => {
    it('wires change listener that toggles panel visibility', () => {
      buildSummaryDom();
      binder.attachListenersOnce();

      const toggle = document.getElementById('auto-summarize-enabled');
      const panel = document.getElementById('auto-summarize-config');

      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      expect(panel.style.display).toBe('block');

      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
      expect(panel.style.display).toBe('none');
    });

    it('is idempotent -- only wires once', () => {
      buildSummaryDom();
      binder.attachListenersOnce();
      binder.attachListenersOnce();
      expect(binder._summaryUiBound).toBe(true);
    });

    it('does nothing when toggle is absent', () => {
      // empty DOM
      binder.attachListenersOnce();
      expect(binder._summaryUiBound).toBe(false);
    });
  });

  // ==========================================================================
  // collect()
  // ==========================================================================

  describe('collect()', () => {
    it('returns null when toggle element is absent', () => {
      expect(binder.collect({}, {}, {})).toBeNull();
    });

    it('throws CONTRACT VIOLATION when baselineSvc is null', () => {
      buildSummaryDom();
      expect(() => binder.collect(null, {}, {})).toThrow('CONTRACT VIOLATION');
    });

    it('throws CONTRACT VIOLATION when baselineSvc is not an object', () => {
      buildSummaryDom();
      expect(() => binder.collect('string', {}, {})).toThrow('CONTRACT VIOLATION');
    });

    it('collects values from DOM elements when populated', () => {
      buildSummaryDom();
      document.getElementById('auto-summarize-enabled').checked = true;
      document.getElementById('summary-model').value = 'gpt-4o';
      document.getElementById('summary-temperature').value = '0.7';
      document.getElementById('summary-max-tokens').value = '2048';
      document.getElementById('summary-title-max-length').value = '100';
      document.getElementById('summary-key-points-max').value = '5';
      document.getElementById('summary-default-search-limit').value = '10';
      document.getElementById('summary-system-prompt').value = 'Be concise.';

      const result = binder.collect(
        { temperature: 0.5 },
        { model: 'fallback-model' },
        { llm: { summarizer_model: 'llm-fallback' } },
      );

      expect(result.enabled).toBe(true);
      expect(result.auto_summarize).toBe(true);
      expect(result.model).toBe('gpt-4o');
      expect(result.temperature).toBe(0.7);
      expect(result.max_tokens).toBe(2048);
      expect(result.title_max_length).toBe(100);
      expect(result.key_points_max).toBe(5);
      expect(result.default_search_limit).toBe(10);
      expect(result.system_prompt_template).toBe('Be concise.');
    });

    it('falls back to prefs then svc when DOM values are empty', () => {
      buildSummaryDom();
      // All inputs left empty (default)

      const result = binder.collect(
        { temperature: 0.3, max_tokens: 500, title_max_length: 80, key_points_max: 3, default_search_limit: 20, system_prompt_template: 'svc-prompt' },
        { temperature: 0.6, model: 'prefs-model' },
        {},
      );

      expect(result.model).toBe('prefs-model');
      expect(result.temperature).toBe(0.6); // prefs > svc
      expect(result.max_tokens).toBe(500); // svc (prefs undefined)
      expect(result.system_prompt_template).toBe('svc-prompt');
    });

    it('uses llm.summarizer_model as model fallback when prefs.model absent', () => {
      buildSummaryDom();

      const result = binder.collect(
        { temperature: 0.5 },
        {}, // no prefs.model
        { llm: { summarizer_model: 'llm-summary-model' } },
      );

      expect(result.model).toBe('llm-summary-model');
    });

    it('returns empty string model when all fallbacks absent', () => {
      buildSummaryDom();
      const result = binder.collect({ temperature: 0.5 }, {}, {});
      expect(result.model).toBe('');
    });

    it('handles null baselinePrefs gracefully', () => {
      buildSummaryDom();
      document.getElementById('summary-model').value = 'test-model';

      const result = binder.collect({ temperature: 0.5 }, null, {});
      expect(result.model).toBe('test-model');
      expect(result.temperature).toBe(0.5); // svc fallback
    });
  });
});
