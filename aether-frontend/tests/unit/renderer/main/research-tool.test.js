'use strict';

// ---------------------------------------------------------------------------
// ResearchTool.js — Unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/main/modules/agents/components/tools/ResearchTool.js (253 lines)
// Extends ToolComponent. Renders research card, creates ResearchDialog.
// Complex status display: AI/Fast/Local modes. Source count on completed runs.
// ---------------------------------------------------------------------------

jest.mock(
  '../../../../src/renderer/main/modules/agents/components/dialogs/ResearchDialog',
  () => jest.fn()
);

jest.mock(
  '../../../../src/renderer/shared/components/Toast',
  () => ({})
);

const ResearchTool = require('../../../../src/renderer/main/modules/agents/components/tools/ResearchTool');
const ResearchDialog = require('../../../../src/renderer/main/modules/agents/components/dialogs/ResearchDialog');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseHtml(htmlStr) {
  const container = document.createElement('div');
  container.innerHTML = htmlStr.trim();
  return container;
}

function makeResearchStatus(overrides = {}) {
  return {
    perplexica_enabled: true,
    searxng_enabled: true,
    available_sources: {
      ai_mode: ['perplexica'],
      fast_mode: ['searxng'],
      local: ['local-index'],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResearchTool', () => {
  let tool;
  let endpoint;
  let toolState;
  let logger;
  let agent;
  let agentState;
  let templatesByName;
  let researchStatus;

  beforeEach(() => {
    researchStatus = makeResearchStatus();

    endpoint = { invoke: jest.fn() };
    toolState = {
      getToolJobs: jest.fn().mockReturnValue([]),
      getToolRunState: jest.fn().mockReturnValue(null),
      getResearchStatus: jest.fn().mockReturnValue(researchStatus),
    };
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    agent = { enabled: true, model_name: 'gpt-4o' };
    agentState = { models: ['gpt-4o', 'claude-3.5'] };
    templatesByName = {};

    ResearchDialog.mockClear();
    ResearchDialog.mockImplementation(function (config) {
      this._mockConfig = config;
    });

    tool = new ResearchTool({
      agent,
      endpoint,
      toolState,
      agentState,
      logger,
      templatesByName,
    });
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('passes name as "research" to ToolComponent', () => {
      expect(tool.name).toBe('research');
    });

    it('stores agentState from config', () => {
      expect(tool.agentState).toBe(agentState);
    });

    it('stores templatesByName from config', () => {
      expect(tool.templatesByName).toBe(templatesByName);
    });

    it('defaults templatesByName to empty object when not provided', () => {
      const t = new ResearchTool({ agent, endpoint, toolState, logger });
      expect(t.templatesByName).toEqual({});
    });

    it('defaults templatesByName to {} when null', () => {
      const t = new ResearchTool({ agent, endpoint, toolState, logger, templatesByName: null });
      expect(t.templatesByName).toEqual({});
    });

    it('throws when endpoint missing (ToolComponent)', () => {
      expect(() => new ResearchTool({ agent, toolState })).toThrow('Endpoint is required');
    });

    it('throws when toolState missing (ToolComponent)', () => {
      expect(() => new ResearchTool({ agent, endpoint })).toThrow('ToolStateManager is required');
    });
  });

  // =========================================================================
  // render()
  // =========================================================================

  describe('render()', () => {
    describe('card structure', () => {
      it('returns HTML with tool-card container', () => {
        const dom = parseHtml(tool.render());
        expect(dom.querySelector('.tool-card')).not.toBeNull();
      });

      it('sets data-tool="research"', () => {
        const dom = parseHtml(tool.render());
        expect(dom.querySelector('.tool-card').getAttribute('data-tool')).toBe('research');
      });

      it('renders display name "Research" in title', () => {
        const dom = parseHtml(tool.render());
        expect(dom.querySelector('.tool-card-title span').textContent).toBe('Research');
      });

      it('renders fa-search icon', () => {
        expect(parseHtml(tool.render()).querySelector('.fa-search')).not.toBeNull();
      });

      it('renders primary "Start Research" button', () => {
        const dom = parseHtml(tool.render());
        const btn = dom.querySelector('[data-action="tool-invoke"]');
        expect(btn).not.toBeNull();
        expect(btn.getAttribute('data-tool')).toBe('research');
        expect(btn.textContent).toContain('Start Research');
      });

      it('renders secondary "Research History" button', () => {
        const dom = parseHtml(tool.render());
        const btn = dom.querySelector('[data-action="open-research-history"]');
        expect(btn).not.toBeNull();
        expect(btn.getAttribute('data-tool')).toBe('research');
        expect(btn.textContent).toContain('Research History');
      });

      it('renders "Agent Interface" button for Perplexica', () => {
        const dom = parseHtml(tool.render());
        const btn = dom.querySelector('[data-action="open-perplexica-interface"]');
        expect(btn).not.toBeNull();
        expect(btn.getAttribute('data-tool')).toBe('research');
        expect(btn.textContent).toContain('Agent Interface');
      });
    });

    describe('agent present vs. missing', () => {
      it('no is-disabled class when agent present', () => {
        const dom = parseHtml(tool.render());
        expect(dom.querySelector('.tool-card').classList.contains('is-disabled')).toBe(false);
      });

      it('no Missing badge when agent present', () => {
        expect(parseHtml(tool.render()).querySelector('.tool-card-badge--missing')).toBeNull();
      });

      it('adds is-disabled class when agent null', () => {
        tool.agent = null;
        const dom = parseHtml(tool.render());
        expect(dom.querySelector('.tool-card').classList.contains('is-disabled')).toBe(true);
      });

      it('shows Missing badge when agent null', () => {
        tool.agent = null;
        const badge = parseHtml(tool.render()).querySelector('.tool-card-badge--missing');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('Missing');
      });
    });

    describe('View Results button', () => {
      it('renders View Results button when state has results', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'completed', results: { data: [] } });
        const dom = parseHtml(tool.render());
        const btn = dom.querySelector('[data-action="view-results"]');
        expect(btn).not.toBeNull();
        expect(btn.textContent).toContain('View Results');
      });

      it('does NOT render View Results when results is null', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'completed', results: null });
        expect(parseHtml(tool.render()).querySelector('[data-action="view-results"]')).toBeNull();
      });

      it('does NOT render View Results when state is null', () => {
        toolState.getToolRunState.mockReturnValue(null);
        expect(parseHtml(tool.render()).querySelector('[data-action="view-results"]')).toBeNull();
      });

      it('does NOT render View Results when results is undefined', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'completed' });
        expect(parseHtml(tool.render()).querySelector('[data-action="view-results"]')).toBeNull();
      });

      it('renders View Results for truthy results (even empty array)', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'completed', results: [] });
        // [] is truthy
        const btn = parseHtml(tool.render()).querySelector('[data-action="view-results"]');
        expect(btn).not.toBeNull();
      });
    });

    describe('run info and status sections', () => {
      it('renders status section when research status available', () => {
        expect(parseHtml(tool.render()).querySelector('.tool-card-status-section')).not.toBeNull();
      });

      it('omits run info section when no run state', () => {
        toolState.getToolRunState.mockReturnValue(null);
        expect(parseHtml(tool.render()).querySelector('.tool-card-run-section')).toBeNull();
      });

      it('renders run info section when running', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'running' });
        expect(parseHtml(tool.render()).querySelector('.tool-card-run-section')).not.toBeNull();
      });
    });

    describe('HTML escaping', () => {
      it('escapes description with HTML', () => {
        tool.templatesByName = { research: { description: '<img onerror=x>' } };
        const html = tool.render();
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
      });
    });
  });

  // =========================================================================
  // createDialog()
  // =========================================================================

  describe('createDialog()', () => {
    it('creates ResearchDialog with correct config', () => {
      tool.createDialog();
      expect(ResearchDialog).toHaveBeenCalledTimes(1);
      expect(ResearchDialog).toHaveBeenCalledWith({
        endpoint,
        models: ['gpt-4o', 'claude-3.5'],
        researchStatus,
        toolState,
        logger,
      });
    });

    it('returns ResearchDialog instance', () => {
      const dialog = tool.createDialog();
      expect(dialog._mockConfig.researchStatus).toBe(researchStatus);
    });

    it('throws when researchStatus is null', () => {
      toolState.getResearchStatus.mockReturnValue(null);
      expect(() => tool.createDialog()).toThrow('Research status not available');
    });

    it('throws when researchStatus is undefined', () => {
      toolState.getResearchStatus.mockReturnValue(undefined);
      expect(() => tool.createDialog()).toThrow('Research status not available');
    });

    it('passes empty array for models when agentState is null', () => {
      tool.agentState = null;
      tool.createDialog();
      expect(ResearchDialog).toHaveBeenCalledWith(
        expect.objectContaining({ models: [] })
      );
    });

    it('passes empty array when agentState.models is undefined', () => {
      tool.agentState = {};
      tool.createDialog();
      expect(ResearchDialog).toHaveBeenCalledWith(
        expect.objectContaining({ models: [] })
      );
    });

    it('passes empty array when agentState.models is null', () => {
      tool.agentState = { models: null };
      tool.createDialog();
      expect(ResearchDialog).toHaveBeenCalledWith(
        expect.objectContaining({ models: [] })
      );
    });

    it('passes researchStatus from toolState.getResearchStatus()', () => {
      const custom = { perplexica_enabled: false };
      toolState.getResearchStatus.mockReturnValue(custom);
      tool.createDialog();
      expect(ResearchDialog).toHaveBeenCalledWith(
        expect.objectContaining({ researchStatus: custom })
      );
    });
  });

  // =========================================================================
  // getStatus()
  // =========================================================================

  describe('getStatus()', () => {
    it('returns {available: true, researchStatus} when agent and status exist', () => {
      expect(tool.getStatus()).toEqual({
        available: true,
        researchStatus,
      });
    });

    it('returns available=false when agent is null', () => {
      tool.agent = null;
      expect(tool.getStatus().available).toBe(false);
    });

    it('returns available=false when researchStatus is null', () => {
      toolState.getResearchStatus.mockReturnValue(null);
      expect(tool.getStatus().available).toBe(false);
    });

    it('returns available=false when both agent and status are null', () => {
      tool.agent = null;
      toolState.getResearchStatus.mockReturnValue(null);
      const status = tool.getStatus();
      expect(status.available).toBe(false);
      expect(status.researchStatus).toBeNull();
    });

    it('returns researchStatus from toolState', () => {
      const custom = { perplexica_enabled: false };
      toolState.getResearchStatus.mockReturnValue(custom);
      expect(tool.getStatus().researchStatus).toBe(custom);
    });
  });

  // =========================================================================
  // _getDescription()
  // =========================================================================

  describe('_getDescription()', () => {
    it('returns default when no template', () => {
      expect(tool._getDescription()).toBe('Research tool for legal workflow automation');
    });

    it('returns template description when available', () => {
      tool.templatesByName = { research: { description: 'Custom desc' } };
      expect(tool._getDescription()).toBe('Custom desc');
    });

    it('returns default when template exists but no description', () => {
      tool.templatesByName = { research: {} };
      expect(tool._getDescription()).toBe('Research tool for legal workflow automation');
    });

    it('returns default when template description is empty string', () => {
      tool.templatesByName = { research: { description: '' } };
      expect(tool._getDescription()).toBe('Research tool for legal workflow automation');
    });

    it('returns default when templatesByName is null', () => {
      tool.templatesByName = null;
      expect(tool._getDescription()).toBe('Research tool for legal workflow automation');
    });
  });

  // =========================================================================
  // _renderServiceStatus()
  // =========================================================================

  describe('_renderServiceStatus()', () => {
    it('returns "Status unavailable" when no research status', () => {
      toolState.getResearchStatus.mockReturnValue(null);
      const dom = parseHtml(tool._renderServiceStatus());
      const el = dom.querySelector('.tool-card-statusline.muted');
      expect(el).not.toBeNull();
      expect(el.textContent).toBe('Status unavailable.');
    });

    describe('mode chips', () => {
      it('renders "AI mode" ok chip when perplexica enabled', () => {
        const dom = parseHtml(tool._renderServiceStatus());
        const chips = dom.querySelectorAll('.tool-chip.ok');
        const texts = Array.from(chips).map(c => c.textContent);
        expect(texts).toContain('AI mode');
      });

      it('renders "AI mode off" warn chip when perplexica disabled', () => {
        researchStatus.perplexica_enabled = false;
        const dom = parseHtml(tool._renderServiceStatus());
        const warnChips = Array.from(dom.querySelectorAll('.tool-chip.warn')).map(c => c.textContent);
        expect(warnChips).toContain('AI mode off');
      });

      it('renders "Fast mode" ok chip when searxng enabled', () => {
        const dom = parseHtml(tool._renderServiceStatus());
        const okChips = Array.from(dom.querySelectorAll('.tool-chip.ok')).map(c => c.textContent);
        expect(okChips).toContain('Fast mode');
      });

      it('renders "Fast mode off" warn chip when searxng disabled', () => {
        researchStatus.searxng_enabled = false;
        const dom = parseHtml(tool._renderServiceStatus());
        const warnChips = Array.from(dom.querySelectorAll('.tool-chip.warn')).map(c => c.textContent);
        expect(warnChips).toContain('Fast mode off');
      });

      it('renders "Local" ok chip when local sources exist', () => {
        const dom = parseHtml(tool._renderServiceStatus());
        const okChips = Array.from(dom.querySelectorAll('.tool-chip.ok')).map(c => c.textContent);
        expect(okChips).toContain('Local');
      });

      it('renders "Local" muted chip when no local sources', () => {
        researchStatus.available_sources.local = [];
        const dom = parseHtml(tool._renderServiceStatus());
        const mutedChips = Array.from(dom.querySelectorAll('.tool-chip.muted')).map(c => c.textContent);
        expect(mutedChips).toContain('Local');
      });

      it('renders 3 chips total in all configurations', () => {
        const dom = parseHtml(tool._renderServiceStatus());
        const allChips = dom.querySelectorAll('.tool-chip');
        expect(allChips.length).toBe(3);
      });
    });

    describe('sources summary', () => {
      it('renders AI sources in summary', () => {
        const html = tool._renderServiceStatus();
        expect(html).toContain('AI: perplexica');
      });

      it('renders Fast sources in summary', () => {
        const html = tool._renderServiceStatus();
        expect(html).toContain('Fast: searxng');
      });

      it('renders Local sources in summary', () => {
        const html = tool._renderServiceStatus();
        expect(html).toContain('Local: local-index');
      });

      it('joins multiple sources with comma', () => {
        researchStatus.available_sources.ai_mode = ['perplexica', 'openai'];
        const html = tool._renderServiceStatus();
        expect(html).toContain('AI: perplexica, openai');
      });

      it('joins categories with bullet separator', () => {
        const html = tool._renderServiceStatus();
        const dom = parseHtml(html);
        const summaryEl = dom.querySelectorAll('.tool-card-statusline')[1];
        const text = summaryEl.textContent;
        // Should contain bullet between AI and Fast
        expect(text).toMatch(/AI:.*•.*Fast:/);
      });

      it('shows "No sources reported" when all sources empty', () => {
        researchStatus.available_sources = { ai_mode: [], fast_mode: [], local: [] };
        const html = tool._renderServiceStatus();
        expect(html).toContain('No sources reported');
      });

      it('shows "No sources reported" when available_sources is empty object', () => {
        researchStatus.available_sources = {};
        const html = tool._renderServiceStatus();
        expect(html).toContain('No sources reported');
      });

      it('shows "No sources reported" when available_sources is undefined', () => {
        delete researchStatus.available_sources;
        const html = tool._renderServiceStatus();
        expect(html).toContain('No sources reported');
      });

      it('handles non-array source values gracefully (defaults to [])', () => {
        researchStatus.available_sources = { ai_mode: 'string', fast_mode: 42, local: null };
        const html = tool._renderServiceStatus();
        expect(html).toContain('No sources reported');
      });
    });

    describe('escaping', () => {
      it('escapes HTML in sources summary', () => {
        researchStatus.available_sources.ai_mode = ['<script>xss</script>'];
        const html = tool._renderServiceStatus();
        expect(html).not.toContain('<script>xss');
        expect(html).toContain('&lt;script&gt;');
      });
    });
  });

  // =========================================================================
  // _renderToolRunInfo()
  // =========================================================================

  describe('_renderToolRunInfo()', () => {
    it('returns empty string when no state', () => {
      toolState.getToolRunState.mockReturnValue(null);
      expect(tool._renderToolRunInfo()).toBe('');
    });

    it('calls getToolRunState with "research"', () => {
      tool._renderToolRunInfo();
      expect(toolState.getToolRunState).toHaveBeenCalledWith('research');
    });

    describe('running', () => {
      it('shows spinner for "running"', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'running' });
        const dom = parseHtml(tool._renderToolRunInfo());
        expect(dom.querySelector('.status-running')).not.toBeNull();
        expect(dom.querySelector('.tool-status-spinner')).not.toBeNull();
        expect(dom.textContent).toContain('Running job...');
      });

      it('shows spinner for "processing"', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'processing' });
        expect(parseHtml(tool._renderToolRunInfo()).querySelector('.status-running')).not.toBeNull();
      });

      it('case-insensitive: "RUNNING"', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'RUNNING' });
        expect(parseHtml(tool._renderToolRunInfo()).querySelector('.status-running')).not.toBeNull();
      });
    });

    describe('completed', () => {
      it('shows check icon and duration', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'completed', time_ms: 5000 });
        const dom = parseHtml(tool._renderToolRunInfo());
        expect(dom.querySelector('.status-completed')).not.toBeNull();
        expect(dom.querySelector('.fa-check-circle')).not.toBeNull();
        expect(dom.textContent).toContain('in 5.0s');
      });

      it('shows "Completed" without duration when time_ms missing', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'completed' });
        const dom = parseHtml(tool._renderToolRunInfo());
        expect(dom.textContent).toContain('Completed');
        expect(dom.textContent).not.toContain('in ');
      });

      it('shows source count badge for single source', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'completed', sources_used: 1 });
        const dom = parseHtml(tool._renderToolRunInfo());
        const badge = dom.querySelector('.tool-run-badge');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('1 source');
      });

      it('shows source count badge with plural for multiple sources', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'completed', sources_used: 5 });
        const dom = parseHtml(tool._renderToolRunInfo());
        const badge = dom.querySelector('.tool-run-badge');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('5 sources');
      });

      it('no source badge when sources_used is 0', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'completed', sources_used: 0 });
        expect(parseHtml(tool._renderToolRunInfo()).querySelector('.tool-run-badge')).toBeNull();
      });

      it('no source badge when sources_used is undefined', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'completed' });
        expect(parseHtml(tool._renderToolRunInfo()).querySelector('.tool-run-badge')).toBeNull();
      });

      it('no source badge when sources_used is NaN', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'completed', sources_used: NaN });
        // NaN is not finite, defaults to 0
        expect(parseHtml(tool._renderToolRunInfo()).querySelector('.tool-run-badge')).toBeNull();
      });

      it('no source badge when sources_used is negative', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'completed', sources_used: -1 });
        // -1 is finite, sourceCount = -1, -1 > 0 is false
        expect(parseHtml(tool._renderToolRunInfo()).querySelector('.tool-run-badge')).toBeNull();
      });

      it('shows duration and source count together', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'completed', time_ms: 3000, sources_used: 3 });
        const dom = parseHtml(tool._renderToolRunInfo());
        expect(dom.textContent).toContain('in 3.0s');
        expect(dom.querySelector('.tool-run-badge').textContent).toBe('3 sources');
      });

      it('case-insensitive: "COMPLETED"', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'COMPLETED' });
        expect(parseHtml(tool._renderToolRunInfo()).querySelector('.status-completed')).not.toBeNull();
      });
    });

    describe('failed', () => {
      it('shows error icon and "Failed"', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'failed' });
        const dom = parseHtml(tool._renderToolRunInfo());
        expect(dom.querySelector('.status-failed')).not.toBeNull();
        expect(dom.querySelector('.fa-exclamation-circle')).not.toBeNull();
        expect(dom.textContent).toContain('Failed');
      });

      it('case-insensitive: "FAILED"', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'FAILED' });
        expect(parseHtml(tool._renderToolRunInfo()).querySelector('.status-failed')).not.toBeNull();
      });
    });

    describe('unknown/other', () => {
      it('returns empty for unknown status', () => {
        toolState.getToolRunState.mockReturnValue({ status: 'queued' });
        expect(tool._renderToolRunInfo()).toBe('');
      });

      it('returns empty for null status', () => {
        toolState.getToolRunState.mockReturnValue({ status: null });
        expect(tool._renderToolRunInfo()).toBe('');
      });

      it('returns empty for undefined status', () => {
        toolState.getToolRunState.mockReturnValue({ status: undefined });
        expect(tool._renderToolRunInfo()).toBe('');
      });
    });
  });

  // =========================================================================
  // Inherited methods
  // =========================================================================

  describe('inherited methods', () => {
    it('isAvailable() true when agent exists', () => {
      expect(tool.isAvailable()).toBe(true);
    });

    it('isAvailable() false when agent null', () => {
      tool.agent = null;
      expect(tool.isAvailable()).toBe(false);
    });

    it('getDisplayName() returns "Research"', () => {
      expect(tool.getDisplayName()).toBe('Research');
    });

    it('cleanup() logs and does not throw', () => {
      expect(() => tool.cleanup()).not.toThrow();
      expect(logger.info).toHaveBeenCalledWith('ToolComponent: Cleanup research');
    });
  });

  // =========================================================================
  // Integration
  // =========================================================================

  describe('integration', () => {
    it('full card: agent present, running, with results from previous run', () => {
      toolState.getToolRunState.mockReturnValue({ status: 'running', results: { items: [] } });
      const dom = parseHtml(tool.render());

      expect(dom.querySelector('.tool-card').classList.contains('is-disabled')).toBe(false);
      expect(dom.querySelector('.tool-card-status-section')).not.toBeNull();
      expect(dom.querySelector('.status-running')).not.toBeNull();
      // Results from previous run visible
      expect(dom.querySelector('[data-action="view-results"]')).not.toBeNull();
    });

    it('disabled card: no agent, no run state, no research status', () => {
      tool.agent = null;
      toolState.getResearchStatus.mockReturnValue(null);
      toolState.getToolRunState.mockReturnValue(null);
      const dom = parseHtml(tool.render());

      expect(dom.querySelector('.tool-card').classList.contains('is-disabled')).toBe(true);
      expect(dom.querySelector('.tool-card-badge--missing')).not.toBeNull();
      expect(dom.querySelector('.tool-card-run-section')).toBeNull();
      expect(dom.querySelector('[data-action="view-results"]')).toBeNull();
    });

    it('all modes off, completed with sources', () => {
      researchStatus.perplexica_enabled = false;
      researchStatus.searxng_enabled = false;
      researchStatus.available_sources = { ai_mode: [], fast_mode: [], local: [] };
      toolState.getToolRunState.mockReturnValue({ status: 'completed', time_ms: 10000, sources_used: 7 });

      const dom = parseHtml(tool.render());
      // Mode chips: 2 warn (AI off, Fast off) + 1 muted (Local)
      const warnChips = dom.querySelectorAll('.tool-chip.warn');
      expect(warnChips.length).toBe(2);
      const mutedChips = dom.querySelectorAll('.tool-chip.muted');
      // muted chips: 1 (Local) + 1 (sources summary)
      expect(mutedChips.length).toBeGreaterThanOrEqual(1);
      // Completed with sources
      expect(dom.querySelector('.tool-run-badge').textContent).toBe('7 sources');
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('_renderServiceStatus handles perplexica_enabled as 0 (falsy)', () => {
      researchStatus.perplexica_enabled = 0;
      const dom = parseHtml(tool._renderServiceStatus());
      const warnChips = Array.from(dom.querySelectorAll('.tool-chip.warn')).map(c => c.textContent);
      expect(warnChips).toContain('AI mode off');
    });

    it('_renderServiceStatus handles searxng_enabled as "" (falsy)', () => {
      researchStatus.searxng_enabled = '';
      const dom = parseHtml(tool._renderServiceStatus());
      const warnChips = Array.from(dom.querySelectorAll('.tool-chip.warn')).map(c => c.textContent);
      expect(warnChips).toContain('Fast mode off');
    });

    it('render is pure — same state produces same HTML', () => {
      toolState.getToolRunState.mockReturnValue({ status: 'completed', time_ms: 1000, sources_used: 2 });
      expect(tool.render()).toBe(tool.render());
    });

    it('createDialog callable multiple times', () => {
      tool.createDialog();
      tool.createDialog();
      expect(ResearchDialog).toHaveBeenCalledTimes(2);
    });
  });
});
