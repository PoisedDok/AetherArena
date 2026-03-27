'use strict';

// ---------------------------------------------------------------------------
// ResearchDialog.js — Unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/main/modules/agents/components/dialogs/ResearchDialog.js (402 lines)
// Dependencies: Toast (static methods).
// ---------------------------------------------------------------------------

jest.mock('../../../../src/renderer/shared/components/Toast', () => ({
  success: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const Toast = require('../../../../src/renderer/shared/components/Toast');
const ResearchDialog = require('../../../../src/renderer/main/modules/agents/components/dialogs/ResearchDialog');

// Default researchStatus fixture
function makeResearchStatus(overrides = {}) {
  return {
    available_sources: {
      ai_mode: ['perplexica', 'scholar'],
      fast_mode: ['searxng', 'scholar'],
      local: ['local_index'],
      ...overrides,
    },
  };
}

describe('ResearchDialog', () => {
  let dialog;
  let endpoint;
  let toolState;
  let logger;
  let researchStatus;

  beforeEach(() => {
    document.body.innerHTML = '';
    Toast.success = jest.fn();
    Toast.error = jest.fn();
    Toast.info = jest.fn();

    endpoint = {
      runResearch: jest.fn().mockResolvedValue({
        sources_used: ['perplexica', 'local_index'],
        time_ms: 3500,
        output_id: 'out-123',
        entity_id: 'ent-456',
        results: { perplexica: [{ title: 'Result 1' }] },
      }),
    };
    toolState = { recordToolRun: jest.fn() };
    researchStatus = makeResearchStatus();
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    dialog = new ResearchDialog({
      endpoint,
      models: [{ name: 'gpt-4' }, { name: 'claude-3' }],
      researchStatus,
      toolState,
      logger,
    });
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('stores endpoint reference', () => {
      expect(dialog.endpoint).toBe(endpoint);
    });

    it('stores models array', () => {
      expect(dialog.models).toHaveLength(2);
    });

    it('stores researchStatus', () => {
      expect(dialog.researchStatus).toBe(researchStatus);
    });

    it('stores toolState', () => {
      expect(dialog.toolState).toBe(toolState);
    });

    it('stores logger', () => {
      expect(dialog.logger).toBe(logger);
    });

    it('defaults logger to console', () => {
      const d = new ResearchDialog({ endpoint, researchStatus, toolState });
      expect(d.logger).toBe(console);
    });

    it('defaults models to empty array', () => {
      const d = new ResearchDialog({ endpoint, researchStatus, toolState, logger });
      expect(d.models).toEqual([]);
    });

    it('defaults models to empty array when null', () => {
      const d = new ResearchDialog({ endpoint, researchStatus, toolState, logger, models: null });
      expect(d.models).toEqual([]);
    });

    it('initializes _dialogElement as null', () => {
      expect(dialog._dialogElement).toBeNull();
    });

    it('throws when endpoint is missing', () => {
      expect(() => new ResearchDialog({ researchStatus, toolState }))
        .toThrow('ResearchDialog: Endpoint is required');
    });

    it('throws when no config (default parameter)', () => {
      expect(() => new ResearchDialog())
        .toThrow('ResearchDialog: Endpoint is required');
    });

    it('throws when researchStatus is missing', () => {
      expect(() => new ResearchDialog({ endpoint, toolState }))
        .toThrow('ResearchDialog: Research status is required');
    });

    it('throws when toolState is missing', () => {
      expect(() => new ResearchDialog({ endpoint, researchStatus }))
        .toThrow('ResearchDialog: ToolStateManager is required');
    });
  });

  // =========================================================================
  // create
  // =========================================================================

  describe('create', () => {
    it('returns an HTMLElement', () => {
      expect(dialog.create()).toBeInstanceOf(HTMLElement);
    });

    it('sets className to "tool-dialog"', () => {
      expect(dialog.create().className).toBe('tool-dialog');
    });

    it('stores reference in _dialogElement', () => {
      const el = dialog.create();
      expect(dialog._dialogElement).toBe(el);
    });

    it('contains overlay', () => {
      expect(dialog.create().querySelector('.tool-dialog-overlay')).not.toBeNull();
    });

    it('contains header with "Research Tool" title', () => {
      expect(dialog.create().querySelector('h3').textContent).toContain('Research Tool');
    });

    it('contains fa-search icon', () => {
      expect(dialog.create().querySelector('h3 i.fa-search')).not.toBeNull();
    });

    it('contains close button with aria-label', () => {
      const close = dialog.create().querySelector('.tool-dialog-close');
      expect(close).not.toBeNull();
      expect(close.getAttribute('aria-label')).toBe('Close');
    });

    it('contains query textarea', () => {
      const el = dialog.create();
      const textarea = el.querySelector('.tool-research-query');
      expect(textarea).not.toBeNull();
      expect(textarea.getAttribute('rows')).toBe('5');
      expect(textarea.getAttribute('placeholder')).toBe('Enter research question');
    });

    it('contains AI mode select with 3 options', () => {
      const el = dialog.create();
      const select = el.querySelector('.tool-research-ai-mode');
      expect(select).not.toBeNull();
      const options = select.querySelectorAll('option');
      expect(options).toHaveLength(3);
      expect(options[0].value).toBe('');
      expect(options[1].value).toBe('ai');
      expect(options[2].value).toBe('fast');
    });

    it('contains optimization select with 4 options', () => {
      const el = dialog.create();
      const options = el.querySelectorAll('.tool-research-optimization option');
      expect(options).toHaveLength(4);
      expect(options[0].value).toBe('');
      expect(options[1].value).toBe('speed');
      expect(options[2].value).toBe('balanced');
      expect(options[3].value).toBe('quality');
    });

    it('contains source checkboxes from researchStatus', () => {
      const el = dialog.create();
      const checkboxes = el.querySelectorAll('.aether-toggle input[type="checkbox"]');
      // perplexica, scholar, searxng, local_index = 4 deduplicated
      expect(checkboxes).toHaveLength(4);
    });

    it('source checkboxes are all checked by default', () => {
      const el = dialog.create();
      const checkboxes = el.querySelectorAll('.aether-toggle input[type="checkbox"]');
      checkboxes.forEach(cb => expect(cb.checked).toBe(true));
    });

    it('source labels contain data-modes attribute', () => {
      const el = dialog.create();
      const toggles = el.querySelectorAll('.aether-toggle');
      // perplexica -> ai; scholar -> ai,fast; searxng -> fast; local_index -> local
      const perplexicaToggle = Array.from(toggles).find(t =>
        t.querySelector('input').value === 'perplexica'
      );
      expect(perplexicaToggle.dataset.modes).toBe('ai');

      const scholarToggle = Array.from(toggles).find(t =>
        t.querySelector('input').value === 'scholar'
      );
      expect(scholarToggle.dataset.modes).toBe('ai,fast');

      const localToggle = Array.from(toggles).find(t =>
        t.querySelector('input').value === 'local_index'
      );
      expect(localToggle.dataset.modes).toBe('local');
    });

    it('contains max results number input', () => {
      const el = dialog.create();
      const input = el.querySelector('.tool-research-max-results');
      expect(input).not.toBeNull();
      expect(input.getAttribute('type')).toBe('number');
      expect(input.getAttribute('min')).toBe('1');
      expect(input.getAttribute('max')).toBe('20');
    });

    it('contains model override select with models', () => {
      const el = dialog.create();
      const options = el.querySelectorAll('.tool-research-model option');
      expect(options).toHaveLength(3); // default + 2 models
      expect(options[0].textContent).toBe('Use agent/default model');
      expect(options[1].value).toBe('gpt-4');
      expect(options[2].value).toBe('claude-3');
    });

    it('contains hidden status div', () => {
      const el = dialog.create();
      const status = el.querySelector('.tool-dialog-status');
      expect(status.classList.contains('tool-dialog-status--hidden')).toBe(true);
    });

    it('contains hidden results div', () => {
      const el = dialog.create();
      const results = el.querySelector('.tool-dialog-results');
      expect(results.classList.contains('tool-dialog-results--hidden')).toBe(true);
    });

    it('throws when researchStatus has no available_sources.ai_mode', () => {
      dialog.researchStatus = { available_sources: { fast_mode: ['x'] } };
      expect(() => dialog.create()).toThrow('Research status missing available_sources');
    });

    it('throws when researchStatus has no available_sources.fast_mode', () => {
      dialog.researchStatus = { available_sources: { ai_mode: ['x'] } };
      expect(() => dialog.create()).toThrow('Research status missing available_sources');
    });

    it('throws when researchStatus has no available_sources', () => {
      dialog.researchStatus = {};
      expect(() => dialog.create()).toThrow('Research status missing available_sources');
    });

    it('escapes HTML in model names', () => {
      dialog.models = [{ name: '<img onerror=alert(1)>' }];
      const el = dialog.create();
      const option = el.querySelectorAll('.tool-research-model option')[1];
      expect(option.innerHTML).not.toContain('<img');
      expect(option.textContent).toBe('<img onerror=alert(1)>');
    });

    it('handles empty models array', () => {
      dialog.models = [];
      const el = dialog.create();
      const options = el.querySelectorAll('.tool-research-model option');
      expect(options).toHaveLength(1); // only default
    });
  });

  // =========================================================================
  // _buildSourceOptions
  // =========================================================================

  describe('_buildSourceOptions', () => {
    it('deduplicates sources across modes', () => {
      const el = dialog.create();
      const values = Array.from(el.querySelectorAll('.aether-toggle input')).map(i => i.value);
      // Set dedup: perplexica(ai), scholar(ai+fast), searxng(fast), local_index(local)
      expect(values).toHaveLength(4);
      expect(new Set(values).size).toBe(4);
    });

    it('handles ai_mode not being an array', () => {
      dialog.researchStatus = makeResearchStatus();
      // Override just ai_mode to be non-array
      dialog.researchStatus.available_sources.ai_mode = 'not-array';
      // create() will throw because it checks truthy ai_mode... but _buildSourceOptions
      // itself guards with Array.isArray. Need to call _buildSourceOptions directly.
      const html = dialog._buildSourceOptions({
        ai_mode: 'not-array',
        fast_mode: ['searxng'],
        local: [],
      });
      const container = document.createElement('div');
      container.innerHTML = html;
      expect(container.querySelectorAll('.aether-toggle')).toHaveLength(1);
      expect(container.querySelector('input').value).toBe('searxng');
    });

    it('handles all arrays being empty', () => {
      const html = dialog._buildSourceOptions({
        ai_mode: [],
        fast_mode: [],
        local: [],
      });
      expect(html).toBe('');
    });

    it('handles local sources only', () => {
      const html = dialog._buildSourceOptions({
        ai_mode: [],
        fast_mode: [],
        local: ['my_index', 'my_docs'],
      });
      const container = document.createElement('div');
      container.innerHTML = html;
      const toggles = container.querySelectorAll('.aether-toggle');
      expect(toggles).toHaveLength(2);
      expect(toggles[0].dataset.modes).toBe('local');
      expect(toggles[1].dataset.modes).toBe('local');
    });

    it('escapes HTML in source names', () => {
      const html = dialog._buildSourceOptions({
        ai_mode: ['<script>alert(1)</script>'],
        fast_mode: [],
        local: [],
      });
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('source appearing in all 3 modes gets all mode attributes', () => {
      const html = dialog._buildSourceOptions({
        ai_mode: ['universal'],
        fast_mode: ['universal'],
        local: ['universal'],
      });
      const container = document.createElement('div');
      container.innerHTML = html;
      expect(container.querySelector('.aether-toggle').dataset.modes).toBe('ai,fast,local');
    });
  });

  // =========================================================================
  // setupListeners
  // =========================================================================

  describe('setupListeners', () => {
    let dialogManager;
    let onRefresh;

    beforeEach(() => {
      dialogManager = { trackListener: jest.fn(), close: jest.fn() };
      onRefresh = jest.fn();
    });

    it('logs error when dialog not created', () => {
      dialog.setupListeners(dialogManager, onRefresh);
      expect(logger.error).toHaveBeenCalledWith(
        'ResearchDialog: Cannot setup listeners, dialog not created'
      );
    });

    it('does not call trackListener when dialog not created', () => {
      dialog.setupListeners(dialogManager, onRefresh);
      expect(dialogManager.trackListener).not.toHaveBeenCalled();
    });

    it('registers correct number of trackListener calls', () => {
      dialog.create();
      dialog.setupListeners(dialogManager, onRefresh);
      // close(1) + cancel(1) + overlay(1) + aiMode change(1) + 4 checkbox changes(4) + submit(1) = 9
      expect(dialogManager.trackListener).toHaveBeenCalledTimes(9);
    });

    it('close button calls dialogManager.close()', () => {
      dialog.create();
      dialog.setupListeners(dialogManager, onRefresh);
      const closeCall = dialogManager.trackListener.mock.calls.find(
        c => c[0].classList.contains('tool-dialog-close')
      );
      closeCall[2]();
      expect(dialogManager.close).toHaveBeenCalled();
    });

    it('cancel button calls dialogManager.close()', () => {
      dialog.create();
      dialog.setupListeners(dialogManager, onRefresh);
      const cancelCall = dialogManager.trackListener.mock.calls.find(
        c => c[0].classList.contains('tool-dialog-cancel')
      );
      cancelCall[2]();
      expect(dialogManager.close).toHaveBeenCalled();
    });

    it('overlay calls dialogManager.close()', () => {
      dialog.create();
      dialog.setupListeners(dialogManager, onRefresh);
      const overlayCall = dialogManager.trackListener.mock.calls.find(
        c => c[0].classList.contains('tool-dialog-overlay')
      );
      overlayCall[2]();
      expect(dialogManager.close).toHaveBeenCalled();
    });

    it('ai mode change handler calls _updateSourceAvailability', () => {
      const el = dialog.create();
      dialog.setupListeners(dialogManager, onRefresh);

      const aiModeSelect = el.querySelector('.tool-research-ai-mode');
      const aiModeCall = dialogManager.trackListener.mock.calls.find(
        c => c[0] === aiModeSelect && c[1] === 'change'
      );
      // Set mode to 'ai' and trigger the handler
      aiModeSelect.value = 'ai';
      aiModeCall[2]();

      // Verify searxng is disabled (it's fast-only)
      const searxng = Array.from(el.querySelectorAll('.aether-toggle')).find(
        t => t.querySelector('input').value === 'searxng'
      );
      expect(searxng.querySelector('input').disabled).toBe(true);
    });

    it('sets initial is-active class on checked checkboxes', () => {
      const el = dialog.create();
      dialog.setupListeners(dialogManager, onRefresh);
      // All checkboxes are checked by default
      const toggles = el.querySelectorAll('.aether-toggle');
      toggles.forEach(t => {
        expect(t.classList.contains('is-active')).toBe(true);
      });
    });

    it('checkbox change handler adds is-active when checked', () => {
      const el = dialog.create();
      dialog.setupListeners(dialogManager, onRefresh);

      const checkbox = el.querySelector('.aether-toggle input');
      const toggle = checkbox.closest('.aether-toggle');

      // Uncheck first
      checkbox.checked = false;
      const changeCall = dialogManager.trackListener.mock.calls.find(
        c => c[0] === checkbox && c[1] === 'change'
      );
      changeCall[2]();
      expect(toggle.classList.contains('is-active')).toBe(false);

      // Re-check
      checkbox.checked = true;
      changeCall[2]();
      expect(toggle.classList.contains('is-active')).toBe(true);
    });

    it('submit handler catches error and logs', async () => {
      dialog.create();
      dialog.setupListeners(dialogManager, onRefresh);
      dialog._submit = jest.fn().mockRejectedValue(new Error('boom'));

      const submitCall = dialogManager.trackListener.mock.calls.find(
        c => c[0].classList.contains('tool-dialog-submit')
      );
      await submitCall[2]();
      expect(logger.error).toHaveBeenCalledWith(
        'ResearchDialog: Invocation failed:',
        expect.any(Error)
      );
    });
  });

  // =========================================================================
  // _updateSourceAvailability
  // =========================================================================

  describe('_updateSourceAvailability', () => {
    let el;

    beforeEach(() => {
      el = dialog.create();
    });

    it('returns early when _dialogElement is null', () => {
      dialog._dialogElement = null;
      // Should not throw
      expect(() => dialog._updateSourceAvailability('ai')).not.toThrow();
    });

    it('enables all sources when mode is empty string', () => {
      dialog._updateSourceAvailability('');
      const checkboxes = el.querySelectorAll('.aether-toggle input');
      checkboxes.forEach(cb => {
        expect(cb.disabled).toBe(false);
      });
      el.querySelectorAll('.aether-toggle').forEach(t => {
        expect(t.classList.contains('is-disabled')).toBe(false);
      });
    });

    it('disables sources not available in AI mode', () => {
      dialog._updateSourceAvailability('ai');
      // searxng is only fast_mode — should be disabled
      const searxng = Array.from(el.querySelectorAll('.aether-toggle')).find(
        t => t.querySelector('input').value === 'searxng'
      );
      expect(searxng.querySelector('input').disabled).toBe(true);
      expect(searxng.querySelector('input').checked).toBe(false);
      expect(searxng.classList.contains('is-disabled')).toBe(true);
    });

    it('keeps AI and local sources enabled in AI mode', () => {
      dialog._updateSourceAvailability('ai');
      // perplexica is ai_mode — enabled
      const perplexica = Array.from(el.querySelectorAll('.aether-toggle')).find(
        t => t.querySelector('input').value === 'perplexica'
      );
      expect(perplexica.querySelector('input').disabled).toBe(false);
      expect(perplexica.classList.contains('is-disabled')).toBe(false);

      // local_index is local — enabled
      const local = Array.from(el.querySelectorAll('.aether-toggle')).find(
        t => t.querySelector('input').value === 'local_index'
      );
      expect(local.querySelector('input').disabled).toBe(false);
    });

    it('disables sources not available in fast mode', () => {
      dialog._updateSourceAvailability('fast');
      // perplexica is only ai_mode — should be disabled
      const perplexica = Array.from(el.querySelectorAll('.aether-toggle')).find(
        t => t.querySelector('input').value === 'perplexica'
      );
      expect(perplexica.querySelector('input').disabled).toBe(true);
      expect(perplexica.classList.contains('is-disabled')).toBe(true);
    });

    it('keeps fast and local sources enabled in fast mode', () => {
      dialog._updateSourceAvailability('fast');
      const searxng = Array.from(el.querySelectorAll('.aether-toggle')).find(
        t => t.querySelector('input').value === 'searxng'
      );
      expect(searxng.querySelector('input').disabled).toBe(false);

      const local = Array.from(el.querySelectorAll('.aether-toggle')).find(
        t => t.querySelector('input').value === 'local_index'
      );
      expect(local.querySelector('input').disabled).toBe(false);
    });

    it('scholar is enabled in both AI and fast modes', () => {
      dialog._updateSourceAvailability('ai');
      const scholarAi = Array.from(el.querySelectorAll('.aether-toggle')).find(
        t => t.querySelector('input').value === 'scholar'
      );
      expect(scholarAi.querySelector('input').disabled).toBe(false);

      dialog._updateSourceAvailability('fast');
      const scholarFast = Array.from(el.querySelectorAll('.aether-toggle')).find(
        t => t.querySelector('input').value === 'scholar'
      );
      expect(scholarFast.querySelector('input').disabled).toBe(false);
    });

    it('re-enables previously disabled sources when switching back to no mode', () => {
      dialog._updateSourceAvailability('ai');
      dialog._updateSourceAvailability('');
      const searxng = Array.from(el.querySelectorAll('.aether-toggle')).find(
        t => t.querySelector('input').value === 'searxng'
      );
      expect(searxng.querySelector('input').disabled).toBe(false);
      expect(searxng.classList.contains('is-disabled')).toBe(false);
    });

    it('unchecked disabled sources stay unchecked when re-enabled', () => {
      // Disable searxng (ai mode unchecks it)
      dialog._updateSourceAvailability('ai');
      const searxng = Array.from(el.querySelectorAll('.aether-toggle')).find(
        t => t.querySelector('input').value === 'searxng'
      );
      expect(searxng.querySelector('input').checked).toBe(false);

      // Re-enable (no mode) — it stays unchecked because only disabled state changes
      dialog._updateSourceAvailability('');
      expect(searxng.querySelector('input').checked).toBe(false);
      expect(searxng.querySelector('input').disabled).toBe(false);
    });
  });

  // =========================================================================
  // _submit — validation
  // =========================================================================

  describe('_submit — validation', () => {
    let dialogManager;

    beforeEach(() => {
      dialogManager = { close: jest.fn() };
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
    });

    it('shows error toast when query is empty', async () => {
      await dialog._submit(dialogManager, jest.fn());
      expect(Toast.error).toHaveBeenCalledWith('Query is required');
    });

    it('shows error toast when query is whitespace only', async () => {
      dialog._dialogElement.querySelector('.tool-research-query').value = '   ';
      await dialog._submit(dialogManager, jest.fn());
      expect(Toast.error).toHaveBeenCalledWith('Query is required');
    });

    it('does not close dialog when query is empty', async () => {
      await dialog._submit(dialogManager, jest.fn());
      expect(dialogManager.close).not.toHaveBeenCalled();
    });

    it('does not call endpoint when query is empty', async () => {
      await dialog._submit(dialogManager, jest.fn());
      expect(endpoint.runResearch).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _submit — early return guards
  // =========================================================================

  describe('_submit — early return guards', () => {
    it('returns when _dialogElement is null', async () => {
      dialog._dialogElement = null;
      await dialog._submit({}, jest.fn());
      expect(endpoint.runResearch).not.toHaveBeenCalled();
    });

    it('returns when endpoint is falsy', async () => {
      dialog.create();
      dialog.endpoint = null;
      await dialog._submit({}, jest.fn());
      expect(Toast.error).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _submit — success path
  // =========================================================================

  describe('_submit — success', () => {
    let dialogManager;
    let onRefresh;

    beforeEach(() => {
      dialogManager = { close: jest.fn() };
      onRefresh = jest.fn();
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      dialog._dialogElement.querySelector('.tool-research-query').value = 'How does quantum computing work?';
    });

    it('closes dialog immediately', async () => {
      await dialog._submit(dialogManager, onRefresh);
      expect(dialogManager.close).toHaveBeenCalled();
    });

    it('records running state before API call', async () => {
      let runningRecorded = false;
      toolState.recordToolRun = jest.fn().mockImplementation((tool, data) => {
        if (data.status === 'running') runningRecorded = true;
      });
      endpoint.runResearch = jest.fn().mockImplementation(() => {
        expect(runningRecorded).toBe(true);
        return Promise.resolve({ sources_used: [], time_ms: 100 });
      });
      await dialog._submit(dialogManager, onRefresh);
    });

    it('records running state with query and timestamp', async () => {
      await dialog._submit(dialogManager, onRefresh);
      const runningCall = toolState.recordToolRun.mock.calls.find(
        c => c[1].status === 'running'
      );
      expect(runningCall[0]).toBe('research');
      expect(runningCall[1].query).toBe('How does quantum computing work?');
      expect(runningCall[1].timestamp).toBeDefined();
    });

    it('calls onRefresh(true) after recording running state', async () => {
      await dialog._submit(dialogManager, onRefresh);
      // First onRefresh call is with true (before API)
      expect(onRefresh.mock.calls[0]).toEqual([true]);
    });

    it('sends query in payload', async () => {
      await dialog._submit(dialogManager, onRefresh);
      expect(endpoint.runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'How does quantum computing work?' })
      );
    });

    it('trims query whitespace', async () => {
      dialog._dialogElement.querySelector('.tool-research-query').value = '  padded query  ';
      await dialog._submit(dialogManager, onRefresh);
      expect(endpoint.runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'padded query' })
      );
    });

    it('sends ai_mode=true when AI mode selected', async () => {
      dialog._dialogElement.querySelector('.tool-research-ai-mode').value = 'ai';
      await dialog._submit(dialogManager, onRefresh);
      expect(endpoint.runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ ai_mode: true })
      );
    });

    it('sends ai_mode=false when fast mode selected', async () => {
      dialog._dialogElement.querySelector('.tool-research-ai-mode').value = 'fast';
      await dialog._submit(dialogManager, onRefresh);
      expect(endpoint.runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ ai_mode: false })
      );
    });

    it('omits ai_mode when default mode selected', async () => {
      await dialog._submit(dialogManager, onRefresh);
      const payload = endpoint.runResearch.mock.calls[0][0];
      expect(payload).not.toHaveProperty('ai_mode');
    });

    it('sends optimization_mode when selected', async () => {
      dialog._dialogElement.querySelector('.tool-research-optimization').value = 'quality';
      await dialog._submit(dialogManager, onRefresh);
      expect(endpoint.runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ optimization_mode: 'quality' })
      );
    });

    it('omits optimization_mode when default', async () => {
      await dialog._submit(dialogManager, onRefresh);
      const payload = endpoint.runResearch.mock.calls[0][0];
      expect(payload).not.toHaveProperty('optimization_mode');
    });

    it('sends selected (checked) sources in payload', async () => {
      await dialog._submit(dialogManager, onRefresh);
      const payload = endpoint.runResearch.mock.calls[0][0];
      expect(payload.sources).toEqual(
        expect.arrayContaining(['perplexica', 'scholar', 'searxng', 'local_index'])
      );
    });

    it('omits sources when none are checked', async () => {
      // Uncheck all
      dialog._dialogElement.querySelectorAll('.aether-toggle input').forEach(cb => {
        cb.checked = false;
      });
      await dialog._submit(dialogManager, onRefresh);
      const payload = endpoint.runResearch.mock.calls[0][0];
      expect(payload).not.toHaveProperty('sources');
    });

    it('sends max_results when a valid number', async () => {
      dialog._dialogElement.querySelector('.tool-research-max-results').value = '10';
      await dialog._submit(dialogManager, onRefresh);
      expect(endpoint.runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ max_results: 10 })
      );
    });

    it('omits max_results when empty', async () => {
      await dialog._submit(dialogManager, onRefresh);
      const payload = endpoint.runResearch.mock.calls[0][0];
      expect(payload).not.toHaveProperty('max_results');
    });

    it('omits max_results when non-numeric', async () => {
      dialog._dialogElement.querySelector('.tool-research-max-results').value = 'abc';
      await dialog._submit(dialogManager, onRefresh);
      const payload = endpoint.runResearch.mock.calls[0][0];
      expect(payload).not.toHaveProperty('max_results');
    });

    it('sends model when selected', async () => {
      dialog._dialogElement.querySelector('.tool-research-model').value = 'claude-3';
      await dialog._submit(dialogManager, onRefresh);
      expect(endpoint.runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-3' })
      );
    });

    it('omits model when default', async () => {
      await dialog._submit(dialogManager, onRefresh);
      const payload = endpoint.runResearch.mock.calls[0][0];
      expect(payload).not.toHaveProperty('model');
    });

    it('always sends persist_history=true', async () => {
      await dialog._submit(dialogManager, onRefresh);
      expect(endpoint.runResearch).toHaveBeenCalledWith(
        expect.objectContaining({ persist_history: true })
      );
    });

    it('records completed state with response data', async () => {
      await dialog._submit(dialogManager, onRefresh);
      const completedCall = toolState.recordToolRun.mock.calls.find(
        c => c[1].status === 'completed'
      );
      expect(completedCall[0]).toBe('research');
      expect(completedCall[1].time_ms).toBe(3500);
      expect(completedCall[1].sources_used).toBe(2); // length of sources_used array
      expect(completedCall[1].output_id).toBe('out-123');
      expect(completedCall[1].entity_id).toBe('ent-456');
      expect(completedCall[1].results).toBeDefined();
    });

    it('uses elapsed time when response has no time_ms', async () => {
      endpoint.runResearch = jest.fn().mockResolvedValue({
        sources_used: [],
      });
      await dialog._submit(dialogManager, onRefresh);
      const completedCall = toolState.recordToolRun.mock.calls.find(
        c => c[1].status === 'completed'
      );
      // time_ms should be a small positive number (Date.now() delta)
      expect(completedCall[1].time_ms).toBeGreaterThanOrEqual(0);
    });

    it('handles non-array sources_used in response', async () => {
      endpoint.runResearch = jest.fn().mockResolvedValue({
        sources_used: 'not-array',
        time_ms: 100,
      });
      await dialog._submit(dialogManager, onRefresh);
      const completedCall = toolState.recordToolRun.mock.calls.find(
        c => c[1].status === 'completed'
      );
      expect(completedCall[1].sources_used).toBe(0);
    });

    it('shows success toast with formatted duration', async () => {
      await dialog._submit(dialogManager, onRefresh);
      expect(Toast.success).toHaveBeenCalledWith('Research completed in 3.5s • Saved to history');
    });

    it('calls onRefresh() on success (no arg)', async () => {
      await dialog._submit(dialogManager, onRefresh);
      // Second onRefresh call (after API completes) has no argument
      const secondCall = onRefresh.mock.calls[1];
      expect(secondCall).toEqual([]);
    });

    it('does not crash when onRefresh is null', async () => {
      await expect(dialog._submit(dialogManager, null)).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // _submit — failure path
  // =========================================================================

  describe('_submit — failure', () => {
    let dialogManager;
    let onRefresh;

    beforeEach(() => {
      dialogManager = { close: jest.fn() };
      onRefresh = jest.fn();
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      dialog._dialogElement.querySelector('.tool-research-query').value = 'test query';
      endpoint.runResearch = jest.fn().mockRejectedValue(new Error('API timeout'));
    });

    it('records failed state', async () => {
      await dialog._submit(dialogManager, onRefresh);
      expect(toolState.recordToolRun).toHaveBeenCalledWith('research', { status: 'failed' });
    });

    it('logs the error', async () => {
      await dialog._submit(dialogManager, onRefresh);
      expect(logger.error).toHaveBeenCalledWith(
        'ResearchDialog: Research failed:',
        expect.any(Error)
      );
    });

    it('shows error toast with message', async () => {
      await dialog._submit(dialogManager, onRefresh);
      expect(Toast.error).toHaveBeenCalledWith('Research failed: API timeout');
    });

    it('shows "Unknown error" when error has no message', async () => {
      endpoint.runResearch = jest.fn().mockRejectedValue({});
      await dialog._submit(dialogManager, onRefresh);
      expect(Toast.error).toHaveBeenCalledWith('Research failed: Unknown error');
    });

    it('calls onRefresh on failure', async () => {
      await dialog._submit(dialogManager, onRefresh);
      // Two calls: first(true) before API, second() after failure
      expect(onRefresh).toHaveBeenCalledTimes(2);
    });

    it('does not crash when onRefresh is null on failure', async () => {
      await expect(dialog._submit(dialogManager, null)).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // _formatDuration
  // =========================================================================

  describe('_formatDuration', () => {
    it('formats sub-second as milliseconds', () => {
      expect(dialog._formatDuration(500)).toBe('500ms');
    });

    it('formats 0ms', () => {
      expect(dialog._formatDuration(0)).toBe('0ms');
    });

    it('formats seconds with 1 decimal', () => {
      expect(dialog._formatDuration(3500)).toBe('3.5s');
    });

    it('formats exactly 1 second', () => {
      expect(dialog._formatDuration(1000)).toBe('1.0s');
    });

    it('formats minutes and seconds', () => {
      expect(dialog._formatDuration(90000)).toBe('1m 30s');
    });

    it('formats exactly 1 minute', () => {
      expect(dialog._formatDuration(60000)).toBe('1m 0s');
    });

    it('formats large durations', () => {
      expect(dialog._formatDuration(300000)).toBe('5m 0s');
    });
  });

  // =========================================================================
  // _escapeHtml
  // =========================================================================

  describe('_escapeHtml', () => {
    it('escapes < and >', () => {
      expect(dialog._escapeHtml('<div>')).toBe('&lt;div&gt;');
    });

    it('escapes &', () => {
      expect(dialog._escapeHtml('a & b')).toBe('a &amp; b');
    });

    it('passes through safe text', () => {
      expect(dialog._escapeHtml('Hello')).toBe('Hello');
    });

    it('converts numbers to string', () => {
      expect(dialog._escapeHtml(42)).toBe('42');
    });
  });

  // =========================================================================
  // cleanup
  // =========================================================================

  describe('cleanup', () => {
    it('nulls _dialogElement', () => {
      dialog.create();
      dialog.cleanup();
      expect(dialog._dialogElement).toBeNull();
    });

    it('safe when already null', () => {
      expect(() => dialog.cleanup()).not.toThrow();
    });

    it('idempotent', () => {
      dialog.create();
      dialog.cleanup();
      dialog.cleanup();
      expect(dialog._dialogElement).toBeNull();
    });
  });

  // =========================================================================
  // integration
  // =========================================================================

  describe('integration', () => {
    it('full workflow: create, setupListeners, change mode, submit, cleanup', async () => {
      const dialogManager = { close: jest.fn(), trackListener: jest.fn() };
      const onRefresh = jest.fn();

      const el = dialog.create();
      document.body.appendChild(el);
      dialog.setupListeners(dialogManager, onRefresh);

      // Set query
      el.querySelector('.tool-research-query').value = 'Integration test query';
      // Select AI mode
      el.querySelector('.tool-research-ai-mode').value = 'ai';
      // Select optimization
      el.querySelector('.tool-research-optimization').value = 'balanced';

      await dialog._submit(dialogManager, onRefresh);
      expect(dialogManager.close).toHaveBeenCalled();
      expect(endpoint.runResearch).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'Integration test query',
          ai_mode: true,
          optimization_mode: 'balanced',
          persist_history: true,
        })
      );

      dialog.cleanup();
      expect(dialog._dialogElement).toBeNull();
    });
  });

  // =========================================================================
  // edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('submit with all optional fields populated', async () => {
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      const el = dialog._dialogElement;

      el.querySelector('.tool-research-query').value = 'full payload';
      el.querySelector('.tool-research-ai-mode').value = 'fast';
      el.querySelector('.tool-research-optimization').value = 'speed';
      el.querySelector('.tool-research-max-results').value = '5';
      el.querySelector('.tool-research-model').value = 'gpt-4';

      await dialog._submit({ close: jest.fn() }, jest.fn());
      const payload = endpoint.runResearch.mock.calls[0][0];
      expect(payload.query).toBe('full payload');
      expect(payload.ai_mode).toBe(false);
      expect(payload.optimization_mode).toBe('speed');
      expect(payload.max_results).toBe(5);
      expect(payload.model).toBe('gpt-4');
      expect(payload.persist_history).toBe(true);
    });

    it('submit with minimal fields (only query)', async () => {
      dialog.create();
      document.body.appendChild(dialog._dialogElement);
      // Uncheck all sources
      dialog._dialogElement.querySelectorAll('.aether-toggle input').forEach(cb => {
        cb.checked = false;
      });
      dialog._dialogElement.querySelector('.tool-research-query').value = 'minimal';
      await dialog._submit({ close: jest.fn() }, jest.fn());
      const payload = endpoint.runResearch.mock.calls[0][0];
      expect(payload).toEqual({
        query: 'minimal',
        persist_history: true,
      });
    });

    it('multiple creates overwrite _dialogElement', () => {
      const el1 = dialog.create();
      const el2 = dialog.create();
      expect(dialog._dialogElement).toBe(el2);
      expect(el1).not.toBe(el2);
    });
  });
});
