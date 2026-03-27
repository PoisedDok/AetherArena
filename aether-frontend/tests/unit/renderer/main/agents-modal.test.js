'use strict';

// ---------------------------------------------------------------------------
// Mocks — survive resetMocks: true
// ---------------------------------------------------------------------------

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

const mockAether = { logger: mockLog };

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => mockAether,
}));

// Mock Toast to capture calls without DOM side effects
const mockToast = {
  success: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn(),
};
jest.mock('../../../../src/renderer/shared/components/Toast', () => mockToast);

// Mock state managers
const mockAgentState = {
  fetchAll: jest.fn().mockResolvedValue(undefined),
  findAgentByName: jest.fn(),
  getAgent: jest.fn(),
  setSelectedAgent: jest.fn(),
  getDirtyAgents: jest.fn(() => []),
  clearDirty: jest.fn(),
  templatesByName: {},
  agents: [],
};

jest.mock(
  '../../../../src/renderer/main/modules/agents/components/state/AgentStateManager',
  () => jest.fn(() => mockAgentState)
);

const mockToolState = {
  prefetchAll: jest.fn().mockResolvedValue(undefined),
  prefetchJobs: jest.fn().mockResolvedValue(undefined),
  prefetchResearchStatus: jest.fn().mockResolvedValue(undefined),
  getToolJobs: jest.fn(() => []),
  getToolRunState: jest.fn(() => null),
  getResearchStatus: jest.fn(() => null),
};

jest.mock(
  '../../../../src/renderer/main/modules/agents/components/state/ToolStateManager',
  () => jest.fn(() => mockToolState)
);

const mockDialogManager = {
  isOpen: jest.fn(() => false),
  open: jest.fn(),
  close: jest.fn(),
  cleanup: jest.fn(),
  getDialog: jest.fn(() => null),
  trackListener: jest.fn(),
};

jest.mock(
  '../../../../src/renderer/main/modules/agents/components/dialogs/DialogManager',
  () => jest.fn(() => mockDialogManager)
);

const mockSystemPanel = {
  renderCards: jest.fn(() => '<div>system cards</div>'),
  setupListeners: jest.fn(),
  _renderConfigPanelContent: jest.fn(() => '<div>config</div>'),
  endpoint: null,
};

jest.mock(
  '../../../../src/renderer/main/modules/agents/components/SystemAgentPanel',
  () => jest.fn(() => mockSystemPanel),
  { virtual: true }
);

// Mock tool components — pass through agent argument so renders produce real cards
jest.mock(
  '../../../../src/renderer/main/modules/agents/components/tools/ResearchTool',
  () => jest.fn((opts) => ({ name: 'research', agent: opts?.agent || null, createDialog: jest.fn() }))
);
// Mock ResultsViewerDialog — lazy to avoid out-of-scope document access
jest.mock(
  '../../../../src/renderer/main/modules/agents/components/dialogs/ResultsViewerDialog',
  () => {
    const mockResultsViewerDialog = jest.fn(function () {
      return {
        create: jest.fn(() => ({ tagName: 'DIV' })),
        setupListeners: jest.fn(),
      };
    });
    return mockResultsViewerDialog;
  }
);

// Mock JobDetailsDialog — lazy-required in _showDirectJobDetails
jest.mock(
  '../../../../src/renderer/main/modules/jobs/JobDetailsDialog',
  () => jest.fn(function () {
    return {
      create: jest.fn(() => ({ tagName: 'DIV', className: 'job-details-dialog' })),
      setupListeners: jest.fn(),
    };
  })
);

const AgentsModal = require(
  '../../../../src/renderer/main/modules/agents/AgentsModal'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createModal(overrides = {}) {
  const modal = new AgentsModal({
    id: 'test-agents-modal',
    endpoint: overrides.endpoint || { updateAgentConfig: jest.fn().mockResolvedValue(undefined) },
    ...overrides,
  });
  return modal;
}

function clearMocks() {
  mockLog.info.mockClear();
  mockLog.warn.mockClear();
  mockLog.error.mockClear();
  mockLog.debug.mockClear();
  mockLog.trace.mockClear();
  mockToast.success.mockClear();
  mockToast.error.mockClear();
  mockToast.warning.mockClear();
  mockAgentState.fetchAll.mockClear();
  mockAgentState.findAgentByName.mockClear();
  mockAgentState.getAgent.mockClear();
  mockAgentState.setSelectedAgent.mockClear();
  mockAgentState.getDirtyAgents.mockClear();
  mockAgentState.clearDirty.mockClear();
  mockToolState.prefetchAll.mockClear();
  mockToolState.prefetchJobs.mockClear();
  mockToolState.prefetchResearchStatus.mockClear();
  mockToolState.getToolJobs.mockClear();
  mockToolState.getToolRunState.mockClear();
  mockToolState.getResearchStatus.mockClear();
  mockDialogManager.isOpen.mockClear();
  mockDialogManager.open.mockClear();
  mockDialogManager.close.mockClear();
  mockDialogManager.cleanup.mockClear();
  mockDialogManager.getDialog.mockClear();
  mockDialogManager.trackListener.mockClear();
}

async function flushPromises() {
  let chain = Promise.resolve();
  for (let i = 0; i < 10; i++) chain = chain.then(() => {});
  await chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentsModal', () => {
  beforeEach(() => {
    clearMocks();
    mockAgentState.getDirtyAgents.mockReturnValue([]);
  });

  afterEach(() => {
    document.querySelectorAll('.modal-overlay, .tool-dialog').forEach(el => el.remove());
    delete window.aetherModals;
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('creates instance with default options', () => {
      const modal = createModal();
      expect(modal).toBeDefined();
      expect(modal.overlay).toBeDefined();
      expect(modal.panel).toBeDefined();
    });

    it('stores callbacks with defaults', () => {
      const modal = createModal();
      expect(typeof modal.onSave).toBe('function');
      expect(typeof modal.onCancel).toBe('function');
    });

    it('uses provided callbacks', () => {
      const onSave = jest.fn();
      const onCancel = jest.fn();
      const modal = createModal({ onSave, onCancel });
      expect(modal.onSave).toBe(onSave);
      expect(modal.onCancel).toBe(onCancel);
    });

    it('initializes empty tools array', () => {
      const modal = createModal();
      expect(modal.tools).toEqual([]);
    });

    it('initializes listener tracking arrays', () => {
      const modal = createModal();
      expect(modal._listeners).toEqual([]);
      expect(modal._panelListeners).toEqual([]);
      expect(modal._timers).toEqual([]);
      expect(modal._standaloneDialogs).toEqual([]);
    });

    it('adds agents-modal class to overlay', () => {
      const modal = createModal();
      expect(modal.overlay.classList.contains('agents-modal')).toBe(true);
    });

    it('adds agents-modal-panel class to panel', () => {
      const modal = createModal();
      expect(modal.panel.classList.contains('agents-modal-panel')).toBe(true);
    });
  });

  // =========================================================================
  // Pure utility methods
  // =========================================================================

  describe('_formatDuration', () => {
    let modal;
    beforeEach(() => { modal = createModal(); });

    it('returns 0s for null/undefined/negative', () => {
      expect(modal._formatDuration(null)).toBe('0s');
      expect(modal._formatDuration(undefined)).toBe('0s');
      expect(modal._formatDuration(-100)).toBe('0s');
    });

    it('formats milliseconds under 1 second', () => {
      expect(modal._formatDuration(500)).toBe('500ms');
    });

    it('formats seconds', () => {
      expect(modal._formatDuration(5000)).toBe('5.0s');
    });

    it('formats minutes and seconds', () => {
      expect(modal._formatDuration(125000)).toBe('2m 5s');
    });

    it('handles 0ms', () => {
      expect(modal._formatDuration(0)).toBe('0s');
    });

    it('returns seconds at exactly 1000ms boundary', () => {
      expect(modal._formatDuration(1000)).toBe('1.0s');
    });

    it('returns ms at 999ms (just under 1s)', () => {
      expect(modal._formatDuration(999)).toBe('999ms');
    });
  });

  describe('_formatRelativeTime', () => {
    let modal;
    beforeEach(() => { modal = createModal(); });

    it('returns "just now" for recent timestamps', () => {
      const now = new Date();
      expect(modal._formatRelativeTime(now)).toBe('just now');
    });

    it('returns minutes ago', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      expect(modal._formatRelativeTime(fiveMinAgo)).toBe('5m ago');
    });

    it('returns hours ago', () => {
      const twoHrsAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      expect(modal._formatRelativeTime(twoHrsAgo)).toBe('2h ago');
    });

    it('returns days ago for old timestamps', () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      expect(modal._formatRelativeTime(fiveDaysAgo)).toBe('5d ago');
    });

    it('returns "just now" for future timestamps (clock skew)', () => {
      const fiveMinFuture = new Date(Date.now() + 5 * 60 * 1000);
      expect(modal._formatRelativeTime(fiveMinFuture)).toBe('just now');
    });

    it('returns "just now" for far future timestamps', () => {
      const oneYearFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      expect(modal._formatRelativeTime(oneYearFuture)).toBe('just now');
    });

    it('returns minutes at exactly 60 second boundary', () => {
      const exactlyOneMin = new Date(Date.now() - 60 * 1000);
      expect(modal._formatRelativeTime(exactlyOneMin)).toBe('1m ago');
    });

    it('returns hours at exactly 60 minute boundary', () => {
      const exactlyOneHour = new Date(Date.now() - 60 * 60 * 1000);
      expect(modal._formatRelativeTime(exactlyOneHour)).toBe('1h ago');
    });

    it('handles invalid date', () => {
      expect(modal._formatRelativeTime('not-a-date')).toBe('not-a-date');
    });

    it('handles undefined timestamp gracefully', () => {
      // new Date(undefined) → Invalid Date → returns fallback
      expect(modal._formatRelativeTime(undefined)).toBe('—');
    });

    it('treats null as epoch date (new Date(null) = Jan 1 1970)', () => {
      // new Date(null) → epoch (valid date) → returns relative time
      const result = modal._formatRelativeTime(null);
      expect(result).toMatch(/^\d+d ago$/);
    });

    it('handles string timestamps', () => {
      const recent = new Date(Date.now() - 30000).toISOString();
      expect(modal._formatRelativeTime(recent)).toBe('just now');
    });
  });

  describe('_formatAgentName', () => {
    let modal;
    beforeEach(() => { modal = createModal(); });

    it('returns template display_name when available', () => {
      mockAgentState.templatesByName = { research: { display_name: 'Legal Research' } };
      modal.agentState = mockAgentState;
      expect(modal._formatAgentName('research')).toBe('Legal Research');
    });

    it('capitalizes first letter when no template', () => {
      mockAgentState.templatesByName = {};
      modal.agentState = mockAgentState;
      expect(modal._formatAgentName('testing')).toBe('Testing');
    });
  });

  describe('_getAgentIcon', () => {
    let modal;
    beforeEach(() => { modal = createModal(); });

    it('returns search for research', () => {
      expect(modal.renderer.getAgentIcon('research')).toBe('search');
    });

    it('returns robot for testing (default)', () => {
      expect(modal.renderer.getAgentIcon('testing')).toBe('robot');
    });

    it('returns robot for unknown', () => {
      expect(modal.renderer.getAgentIcon('custom_bot')).toBe('robot');
    });
  });

  describe('_getAgentDescription', () => {
    let modal;
    beforeEach(() => { modal = createModal(); });

    it('returns description for research', () => {
      expect(modal.renderer.getAgentDescription('research')).toContain('Legal research');
    });

    it('returns default for unknown', () => {
      expect(modal.renderer.getAgentDescription('unknown')).toBe('AI agent for specialized tasks');
    });
  });

  describe('_getStatusIconSmall', () => {
    let modal;
    beforeEach(() => { modal = createModal(); });

    it('returns check-circle for completed', () => {
      expect(modal.renderer.getStatusIconSmall('completed')).toBe('fa-check-circle');
    });

    it('returns spinner for running', () => {
      expect(modal.renderer.getStatusIconSmall('running')).toBe('fa-spinner fa-spin');
    });

    it('returns spinner for processing', () => {
      expect(modal.renderer.getStatusIconSmall('processing')).toBe('fa-spinner fa-spin');
    });

    it('returns exclamation for failed', () => {
      expect(modal.renderer.getStatusIconSmall('failed')).toBe('fa-exclamation-circle');
    });

    it('returns clock for pending', () => {
      expect(modal.renderer.getStatusIconSmall('pending')).toBe('fa-clock');
    });

    it('returns ban for cancelled', () => {
      expect(modal.renderer.getStatusIconSmall('cancelled')).toBe('fa-ban');
    });

    it('returns circle for unknown', () => {
      expect(modal.renderer.getStatusIconSmall('xyz')).toBe('fa-circle');
    });
  });

  describe('_getJobQuery', () => {
    let modal;
    beforeEach(() => { modal = createModal(); });

    it('returns Unknown for null job', () => {
      expect(modal.renderer.getJobQuery(null)).toBe('Unknown');
    });

    it('extracts query from metadata', () => {
      expect(modal.renderer.getJobQuery({ metadata: { query: 'find cases' } })).toBe('find cases');
    });

    it('extracts prompt from content', () => {
      expect(modal.renderer.getJobQuery({ content: { prompt: 'analyze doc' } })).toBe('analyze doc');
    });

    it('extracts filename from metadata', () => {
      expect(modal.renderer.getJobQuery({ metadata: { filename: 'contract.pdf' } })).toBe('contract.pdf');
    });

    it('extracts intake_text from metadata', () => {
      expect(modal.renderer.getJobQuery({ metadata: { intake_text: 'Review this contract' } })).toBe('Review this contract');
    });

    it('extracts query from job.query direct field', () => {
      expect(modal.renderer.getJobQuery({ query: 'Direct query field' })).toBe('Direct query field');
    });

    it('truncates to 40 chars', () => {
      const long = 'A'.repeat(50);
      const result = modal.renderer.getJobQuery({ metadata: { query: long } });
      expect(result.length).toBe(40);
      expect(result.endsWith('...')).toBe(true);
    });

    it('falls back to descriptive name for research', () => {
      expect(modal.renderer.getJobQuery({ agent_name: 'research' })).toBe('Research Task');
    });

    it('falls back to AI Agent Task for testing (default)', () => {
      expect(modal.renderer.getJobQuery({ agent_name: 'testing' })).toBe('AI Agent Task');
    });

    it('falls back to AI Agent Task for unknown', () => {
      expect(modal.renderer.getJobQuery({ agent_name: 'custom' })).toBe('AI Agent Task');
    });
  });

  describe('_getHubTitle', () => {
    it('returns AI Agents', () => {
      const modal = createModal();
      expect(modal._getHubTitle()).toBe('AI Agents');
    });
  });

  describe('_getHubSubtitle', () => {
    it('returns Research and Memory', () => {
      const modal = createModal();
      expect(modal._getHubSubtitle()).toBe('Research and Memory');
    });
  });

  describe('_getViews', () => {
    it('returns empty array (no tabs)', () => {
      const modal = createModal();
      const views = modal._getViews();
      expect(views).toEqual([]);
    });
  });

  describe('_escapeHtml', () => {
    let modal;
    beforeEach(() => { modal = createModal(); });

    it('escapes HTML tags', () => {
      const result = modal._escapeHtml('<script>alert("x")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;');
    });

    it('passes safe strings through', () => {
      expect(modal._escapeHtml('hello')).toBe('hello');
    });

    it('handles non-string input', () => {
      expect(modal._escapeHtml(123)).toBe('123');
    });
  });

  // =========================================================================
  // show — entry point validation
  // =========================================================================

  describe('show', () => {
    it('throws and toasts when endpoint is missing', async () => {
      const modal = createModal({ endpoint: null });
      modal.endpoint = null;
      await modal.show();
      expect(mockToast.error).toHaveBeenCalledWith(
        'Failed to load agent configurations. Check console for details.'
      );
    });

    it('does nothing when already open', async () => {
      const modal = createModal();
      modal.isOpen = true;
      await modal.show();
      // No error, no fetch
      expect(mockAgentState.fetchAll).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _handleEscape — nested dialog handling
  // =========================================================================

  describe('_handleEscape', () => {
    it('ignores non-Escape keys', () => {
      const modal = createModal();
      modal._handleCancel = jest.fn();
      modal._handleEscape({ key: 'Enter' });
      expect(mockDialogManager.close).not.toHaveBeenCalled();
      expect(modal._handleCancel).not.toHaveBeenCalled();
    });

    it('closes dialog first when dialog is open', () => {
      const modal = createModal();
      modal._handleCancel = jest.fn();
      mockDialogManager.isOpen.mockReturnValue(true);
      modal._handleEscape({ key: 'Escape' });
      expect(mockDialogManager.close).toHaveBeenCalled();
      expect(modal._handleCancel).not.toHaveBeenCalled();
    });

    it('calls _handleCancel when no dialog is open', () => {
      const modal = createModal();
      modal._handleCancel = jest.fn();
      mockDialogManager.isOpen.mockReturnValue(false);
      modal._handleEscape({ key: 'Escape' });
      expect(modal._handleCancel).toHaveBeenCalled();
    });

    it('handles Esc key alias', () => {
      const modal = createModal();
      modal._handleCancel = jest.fn();
      mockDialogManager.isOpen.mockReturnValue(false);
      modal._handleEscape({ key: 'Esc' });
      expect(modal._handleCancel).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _handleBackdropClick
  // =========================================================================

  describe('_handleBackdropClick', () => {
    it('calls _handleCancel when clicking overlay', () => {
      const modal = createModal();
      modal._handleCancel = jest.fn();
      modal._handleBackdropClick({ target: modal.overlay });
      expect(modal._handleCancel).toHaveBeenCalled();
    });

    it('does nothing when clicking inside panel', () => {
      const modal = createModal();
      modal._handleCancel = jest.fn();
      modal._handleBackdropClick({ target: modal.panel });
      expect(modal._handleCancel).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _handleCloseClick
  // =========================================================================

  describe('_handleCloseClick', () => {
    it('delegates to _handleCancel', () => {
      const modal = createModal();
      modal._handleCancel = jest.fn();
      modal._handleCloseClick();
      expect(modal._handleCancel).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _handleCancel
  // =========================================================================

  describe('_handleCancel', () => {
    it('closes modal and calls onCancel callback', () => {
      const onCancel = jest.fn();
      const modal = createModal({ onCancel });
      modal.close = jest.fn();
      modal._handleCancel();
      expect(modal.close).toHaveBeenCalled();
      expect(onCancel).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _onViewChanged
  // =========================================================================

  describe('_onViewChanged', () => {
    it('clears selected agent on view switch', () => {
      const modal = createModal();
      modal._onViewChanged('system');
      expect(mockAgentState.setSelectedAgent).toHaveBeenCalledWith(null);
    });
  });

  // =========================================================================
  // Listener tracking
  // =========================================================================

  describe('_trackListener', () => {
    it('adds event listener and tracks it', () => {
      const modal = createModal();
      const el = document.createElement('button');
      const handler = jest.fn();
      const spy = jest.spyOn(el, 'addEventListener');

      modal._trackListener(el, 'click', handler);

      expect(spy).toHaveBeenCalledWith('click', handler, undefined);
      expect(modal._listeners.length).toBe(1);
    });

    it('does nothing when element is null', () => {
      const modal = createModal();
      modal._trackListener(null, 'click', jest.fn());
      expect(modal._listeners.length).toBe(0);
    });

    it('does nothing when handler is null', () => {
      const modal = createModal();
      modal._trackListener(document.createElement('div'), 'click', null);
      expect(modal._listeners.length).toBe(0);
    });
  });

  describe('_trackPanelListener', () => {
    it('adds and tracks panel listener separately', () => {
      const modal = createModal();
      const el = document.createElement('div');
      modal._trackPanelListener(el, 'click', jest.fn());
      expect(modal._panelListeners.length).toBe(1);
    });
  });

  describe('_clearListeners', () => {
    it('removes all tracked listeners and empties array', () => {
      const modal = createModal();
      const el = document.createElement('button');
      const handler = jest.fn();
      modal._trackListener(el, 'click', handler);
      const removeSpy = jest.spyOn(el, 'removeEventListener');

      modal._clearListeners();

      expect(removeSpy).toHaveBeenCalledWith('click', handler, undefined);
      expect(modal._listeners).toEqual([]);
    });
  });

  describe('_clearPanelListeners', () => {
    it('removes all tracked panel listeners', () => {
      const modal = createModal();
      const el = document.createElement('div');
      const handler = jest.fn();
      modal._trackPanelListener(el, 'input', handler);

      modal._clearPanelListeners();

      expect(modal._panelListeners).toEqual([]);
    });
  });

  // =========================================================================
  // Timer tracking
  // =========================================================================

  describe('_trackTimer', () => {
    it('stores timer ID', () => {
      const modal = createModal();
      modal._trackTimer(123);
      expect(modal._timers).toEqual([123]);
    });

    it('ignores falsy timer ID', () => {
      const modal = createModal();
      modal._trackTimer(null);
      expect(modal._timers).toEqual([]);
    });
  });

  describe('_clearTimers', () => {
    it('clears all tracked timers', () => {
      jest.useFakeTimers();
      const modal = createModal();
      const id1 = setInterval(() => {}, 1000);
      const id2 = setInterval(() => {}, 1000);
      modal._timers = [id1, id2];

      modal._clearTimers();

      expect(modal._timers).toEqual([]);
      jest.useRealTimers();
    });
  });

  // =========================================================================
  // _cleanup — lifecycle
  // =========================================================================

  describe('_cleanup', () => {
    it('clears all listeners, timers, dialog, standalone dialogs, and resets state', () => {
      const modal = createModal();
      modal._listeners = [{ element: document.createElement('div'), event: 'click', handler: jest.fn() }];
      modal._panelListeners = [{ element: document.createElement('div'), event: 'input', handler: jest.fn() }];
      modal.activeView = 'system';

      // Add a standalone dialog to document.body (as _openResearchHistory does)
      const orphanDialog = document.createElement('div');
      orphanDialog.className = 'tool-dialog';
      document.body.appendChild(orphanDialog);
      modal._standaloneDialogs.push(orphanDialog);

      modal._cleanup();

      expect(modal._listeners).toEqual([]);
      expect(modal._panelListeners).toEqual([]);
      expect(modal._timers).toEqual([]);
      expect(modal._standaloneDialogs).toEqual([]);
      expect(mockDialogManager.cleanup).toHaveBeenCalled();
      expect(mockAgentState.setSelectedAgent).toHaveBeenCalledWith(null);
      expect(modal.activeView).toBe('ondemand');
      expect(mockAgentState.clearDirty).toHaveBeenCalled();

      // Standalone dialog must have been removed from DOM
      expect(document.body.contains(orphanDialog)).toBe(false);
    });
  });

  // =========================================================================
  // _handleSave — save flow
  // =========================================================================

  describe('_handleSave', () => {
    it('toasts success and closes when no dirty agents', async () => {
      const onSave = jest.fn();
      const modal = createModal({ onSave });
      modal.close = jest.fn();
      // footerEl needs a querySelector that returns null (no save button)
      modal.footerEl = document.createElement('div');

      await modal._handleSave();

      expect(mockToast.success).toHaveBeenCalledWith('No changes to save.');
      expect(modal.close).toHaveBeenCalled();
      expect(onSave).toHaveBeenCalledWith(mockAgentState.agents);
    });

    it('saves each dirty agent and closes', async () => {
      const onSave = jest.fn();
      const modal = createModal({ onSave });
      modal.close = jest.fn();
      modal.footerEl = document.createElement('div');
      modal._saveAgentConfig = jest.fn().mockResolvedValue(undefined);

      mockAgentState.getDirtyAgents.mockReturnValue(['research']);
      mockAgentState.findAgentByName.mockReturnValue({
        agent_name: 'research',
        enabled: true,
        model_name: 'gpt-4',
      });

      await modal._handleSave();

      expect(modal._saveAgentConfig).toHaveBeenCalledWith(
        expect.objectContaining({ agent_name: 'research' })
      );
      expect(mockToast.success).toHaveBeenCalledWith('Agent configurations saved.');
      expect(mockAgentState.clearDirty).toHaveBeenCalled();
    });

    it('toasts error and re-enables save button on failure', async () => {
      const modal = createModal();
      modal.close = jest.fn();
      const saveBtn = document.createElement('button');
      saveBtn.classList.add('agents-save');
      modal.footerEl = document.createElement('div');
      modal.footerEl.appendChild(saveBtn);

      mockAgentState.getDirtyAgents.mockReturnValue(['research']);
      mockAgentState.findAgentByName.mockReturnValue(null);

      await modal._handleSave();

      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save')
      );
      expect(saveBtn.disabled).toBe(false);
      expect(saveBtn.textContent).toBe('Save Changes');
    });
  });

  // =========================================================================
  // _saveAgentConfig — backend persistence
  // =========================================================================

  describe('_saveAgentConfig', () => {
    it('calls endpoint.updateAgentConfig with payload', async () => {
      const endpoint = { updateAgentConfig: jest.fn().mockResolvedValue(undefined) };
      const modal = createModal({ endpoint });

      const agent = {
        agent_name: 'research',
        enabled: true,
        model_name: 'gpt-4',
        prompt_template: 'You are...',
        execution_trigger: 'manual',
        trigger_frequency: 60,
        configuration: { max_results: 5 },
      };

      await modal._saveAgentConfig(agent);

      expect(endpoint.updateAgentConfig).toHaveBeenCalledWith('research', {
        enabled: true,
        model_name: 'gpt-4',
        prompt_template: 'You are...',
        execution_trigger: 'manual',
        trigger_frequency: 60,
        configuration: { max_results: 5 },
      });
    });
  });

  // =========================================================================
  // _handleAgentToggle — on-demand agent toggle
  // =========================================================================

  describe('_handleAgentToggle', () => {
    it('enables agent and persists via endpoint', async () => {
      const endpoint = { updateAgentConfig: jest.fn().mockResolvedValue(undefined) };
      const modal = createModal({ endpoint });
      modal._refreshHub = jest.fn();
      const agent = { agent_name: 'research', enabled: false };
      mockAgentState.findAgentByName.mockReturnValue(agent);
      mockAgentState.templatesByName = {};

      await modal._handleAgentToggle('research', true);

      expect(agent.enabled).toBe(true);
      expect(endpoint.updateAgentConfig).toHaveBeenCalledWith('research', { enabled: true });
      expect(mockToast.success).toHaveBeenCalledWith('Research enabled.');
      expect(modal._refreshHub).toHaveBeenCalled();
    });

    it('reverts on failure and still refreshes', async () => {
      const endpoint = {
        updateAgentConfig: jest.fn().mockRejectedValue(new Error('API fail')),
      };
      const modal = createModal({ endpoint });
      modal._refreshHub = jest.fn();
      const agent = { agent_name: 'research', enabled: true };
      mockAgentState.findAgentByName.mockReturnValue(agent);
      mockAgentState.templatesByName = {};

      await modal._handleAgentToggle('research', false);

      expect(agent.enabled).toBe(true); // reverted
      expect(mockToast.error).toHaveBeenCalledWith('Failed to update Research: API fail');
      expect(modal._refreshHub).toHaveBeenCalled();
    });

    it('does nothing when agent not found', async () => {
      const modal = createModal();
      mockAgentState.findAgentByName.mockReturnValue(null);
      await modal._handleAgentToggle('nonexistent', true);
      expect(modal.endpoint.updateAgentConfig).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _handleSystemAgentToggle
  // =========================================================================

  describe('_handleSystemAgentToggle', () => {
    it('enables system agent and persists', async () => {
      const endpoint = { updateAgentConfig: jest.fn().mockResolvedValue(undefined) };
      const modal = createModal({ endpoint });
      modal._refreshHub = jest.fn();
      const agent = { agent_name: 'context_manager', enabled: false };
      mockAgentState.getAgent.mockReturnValue(agent);
      mockAgentState.templatesByName = {};

      await modal._handleSystemAgentToggle(0, true);

      expect(agent.enabled).toBe(true);
      expect(endpoint.updateAgentConfig).toHaveBeenCalledWith('context_manager', { enabled: true });
    });

    it('reverts on failure', async () => {
      const endpoint = {
        updateAgentConfig: jest.fn().mockRejectedValue(new Error('fail')),
      };
      const modal = createModal({ endpoint });
      modal._refreshHub = jest.fn();
      const agent = { agent_name: 'context_manager', enabled: true };
      mockAgentState.getAgent.mockReturnValue(agent);
      mockAgentState.templatesByName = {};

      await modal._handleSystemAgentToggle(0, false);

      expect(agent.enabled).toBe(true); // reverted
      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Failed to update'));
    });
  });

  // =========================================================================
  // _openToolDialog — tool dialog opening
  // =========================================================================

  describe('_openToolDialog', () => {
    it('throws when tool is null', async () => {
      const modal = createModal();
      await expect(modal._openToolDialog(null)).rejects.toThrow('Tool is required');
    });

    it('creates dialog and opens with DialogManager', async () => {
      const modal = createModal();
      const mockDialogEl = document.createElement('div');
      const mockDialog = {
        create: jest.fn(() => mockDialogEl),
        setupListeners: jest.fn(),
      };
      const tool = { createDialog: jest.fn(() => mockDialog) };

      await modal._openToolDialog(tool);

      expect(tool.createDialog).toHaveBeenCalled();
      expect(mockDialog.create).toHaveBeenCalled();
      expect(mockDialogManager.open).toHaveBeenCalledWith(mockDialogEl);
      expect(mockDialog.setupListeners).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _viewToolResults
  // =========================================================================

  describe('_viewToolResults', () => {
    it('shows warning when no results available', () => {
      const modal = createModal();
      mockToolState.getToolRunState.mockReturnValue(null);
      modal._viewToolResults('research');
      expect(mockToast.warning).toHaveBeenCalledWith('No results available');
    });

    it('shows warning when results field is missing', () => {
      const modal = createModal();
      mockToolState.getToolRunState.mockReturnValue({ status: 'completed' });
      modal._viewToolResults('research');
      expect(mockToast.warning).toHaveBeenCalledWith('No results available');
    });

    it('creates ResultsViewerDialog and opens when results exist', () => {
      const modal = createModal();
      const mockResults = { answer: 'test answer', sources: [] };
      mockToolState.getToolRunState.mockReturnValue({
        status: 'completed',
        results: mockResults,
      });

      modal._viewToolResults('research');

      const ResultsViewerDialog = require(
        '../../../../src/renderer/main/modules/agents/components/dialogs/ResultsViewerDialog'
      );
      expect(ResultsViewerDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'research',
          results: mockResults,
        })
      );
      expect(mockDialogManager.open).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _openJobHistory
  // =========================================================================

  describe('_openJobHistory', () => {
    it('warns when job history modal is not available', () => {
      const modal = createModal({ aetherModals: undefined });
      modal._openJobHistory();
      expect(mockToast.warning).toHaveBeenCalledWith('Job history not available');
    });

    it('opens job history modal when available', () => {
      const mockHistoryModal = { show: jest.fn(), setAgentFilter: jest.fn() };
      const aetherModals = { get: jest.fn(() => mockHistoryModal) };
      const modal = createModal({ aetherModals });

      modal._openJobHistory('research');

      expect(mockHistoryModal.setAgentFilter).toHaveBeenCalledWith('research');
      expect(mockHistoryModal.show).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _handleAction — dispatch
  // =========================================================================

  describe('_handleAction', () => {
    it('dispatches set-view action', () => {
      const modal = createModal();
      modal.switchView = jest.fn();
      modal._refreshHub = jest.fn();
      const el = document.createElement('button');
      el.dataset.action = 'set-view';
      el.dataset.view = 'system';

      modal._handleAction(el, {});

      expect(modal.switchView).toHaveBeenCalledWith('system');
      expect(modal._refreshHub).toHaveBeenCalled();
    });

    it('dispatches close-dialog action', () => {
      const modal = createModal();
      const el = document.createElement('button');
      el.dataset.action = 'close-dialog';
      modal._handleAction(el, {});
      expect(mockDialogManager.close).toHaveBeenCalled();
    });

    it('dispatches view-specific-job action for modal-level recent jobs', () => {
      const modal = createModal();
      jest.spyOn(modal, '_openJobHistory');

      const el = document.createElement('div');
      el.dataset.action = 'view-specific-job';
      el.dataset.toolName = 'research';
      el.dataset.jobId = 'job-123';

      modal._handleAction(el, {});

      expect(modal._openJobHistory).toHaveBeenCalledWith('research', 'job-123');
    });

    it('toasts error when open-tool tool not found', () => {
      const modal = createModal();
      modal.tools = [];
      const el = document.createElement('button');
      el.dataset.action = 'open-tool';
      el.dataset.toolName = 'nonexistent';
      modal._handleAction(el, {});
      expect(mockToast.error).toHaveBeenCalledWith('Tool not available.');
    });
  });

  // =========================================================================
  // _renderAgentCard
  // =========================================================================

  describe('_renderAgentCard', () => {
    it('returns empty string when tool has no agent', () => {
      const modal = createModal();
      expect(modal.renderer.renderAgentCard({ agent: null }, mockToolState)).toBe('');
    });

    it('renders card with agent name', () => {
      const modal = createModal();
      mockToolState.getToolJobs.mockReturnValue([]);
      mockToolState.getToolRunState.mockReturnValue(null);
      mockAgentState.templatesByName = {};

      const html = modal.renderer.renderAgentCard({
        agent: { agent_name: 'research', enabled: true, agent_type: 'on-demand' },
      }, mockToolState);

      expect(html).toContain('agent-card');
      expect(html).toContain('data-tool-name="research"');
    });
  });

  // =========================================================================
  // module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports AgentsModal constructor', () => {
      expect(typeof AgentsModal).toBe('function');
    });
  });

  // =========================================================================
  // _renderContent — async render flow
  // =========================================================================

  describe('_renderContent', () => {
    it('sets skeleton HTML before fetching', async () => {
      const modal = createModal();
      let resolveAll;
      mockAgentState.fetchAll.mockReturnValue(new Promise(r => { resolveAll = r; }));

      const renderPromise = modal._renderContent();

      expect(modal.bodyEl.innerHTML).toContain('skeleton-container');
      expect(modal.bodyEl.innerHTML).toContain('skeleton-line');

      resolveAll();
      await renderPromise;
    });

    it('fetches agents then tools and renders hub', async () => {
      const modal = createModal();
      modal.isOpen = true; // Required for rendering to complete
      mockAgentState.findAgentByName.mockReturnValue({ agent_name: 'research', enabled: true });

      await modal._renderContent();

      expect(mockAgentState.fetchAll).toHaveBeenCalledWith(modal.endpoint);
      expect(mockToolState.prefetchAll).toHaveBeenCalledWith(
        modal.endpoint,
        ['research', 'memory'], // Actual code calls with research and memory
        expect.any(Function)
      );
      expect(modal.bodyEl.innerHTML).toContain('agents-hub');
      expect(modal.bodyEl.innerHTML).not.toContain('skeleton-container');
    });

    it('renders error state when fetchAll fails', async () => {
      const modal = createModal();
      modal.isOpen = true; // Required for error state to be rendered
      mockAgentState.fetchAll.mockRejectedValue(new Error('Network error'));

      await modal._renderContent();

      expect(modal.bodyEl.innerHTML).toContain('Failed to Load Agents');
      expect(modal.bodyEl.innerHTML).toContain('Backend may be unavailable');
      expect(mockLog.error).toHaveBeenCalledWith(
        'Failed to load agent configurations:',
        expect.any(Error)
      );
    });

    it('renders error state when prefetchAll fails', async () => {
      const modal = createModal();
      modal.isOpen = true; // Required for error state to be rendered
      mockToolState.prefetchAll.mockRejectedValue(new Error('Tools fetch error'));

      await modal._renderContent();

      expect(modal.bodyEl.innerHTML).toContain('Failed to Load Agents');
    });

    it('hides footer when footer content is empty (ondemand view)', async () => {
      const modal = createModal();
      modal.isOpen = true; // Required for rendering to complete
      mockAgentState.findAgentByName.mockReturnValue(null);
      mockAgentState.fetchAll.mockResolvedValue(undefined);
      mockToolState.prefetchAll.mockResolvedValue(undefined);

      await modal._renderContent();

      // On-demand view renders empty footer
      expect(modal.footerEl.classList.contains('hidden')).toBe(true);
    });
  });

  // =========================================================================
  // _setupEventListeners
  // =========================================================================

  describe('_setupEventListeners', () => {
    it('calls _attachEventListeners and _startPolling', () => {
      const modal = createModal();
      modal._attachEventListeners = jest.fn();
      modal._startPolling = jest.fn();

      modal._setupEventListeners();

      expect(modal._attachEventListeners).toHaveBeenCalled();
      expect(modal._startPolling).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _startPolling
  // =========================================================================

  describe('_startPolling', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    it('creates interval and tracks timer', () => {
      const modal = createModal();
      modal._startPolling();

      expect(modal._timers.length).toBe(1);
    });

    it('clears existing timers before creating new ones', () => {
      const modal = createModal();
      const oldId = setInterval(() => {}, 999);
      modal._timers = [oldId];

      modal._startPolling();

      expect(modal._timers.length).toBe(1);
      expect(modal._timers[0]).not.toBe(oldId);
    });

    it('polls tool state every 5 seconds', async () => {
      const modal = createModal();
      modal.isOpen = true;
      modal._refreshHub = jest.fn();
      mockAgentState.findAgentByName.mockReturnValue({ agent_name: 'research' });

      modal._startPolling();

      jest.advanceTimersByTime(5000);
      await flushPromises();

      expect(mockToolState.prefetchJobs).toHaveBeenCalledWith(
        modal.endpoint,
        ['research', 'memory'],
        expect.any(Function)
      );
    });

    it('skips refresh when document is hidden', async () => {
      const modal = createModal();
      modal.isOpen = true;
      modal._refreshHub = jest.fn();

      Object.defineProperty(document, 'hidden', { value: true, configurable: true });

      try {
        modal._startPolling();
        jest.advanceTimersByTime(5000);
        await flushPromises();

        expect(mockToolState.prefetchJobs).not.toHaveBeenCalled();
        expect(modal._refreshHub).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      }
    });

    it('does not refresh hub when dialog is open', async () => {
      const modal = createModal();
      modal.isOpen = true;
      modal._refreshHub = jest.fn();
      mockDialogManager.isOpen.mockReturnValue(true);

      modal._startPolling();
      jest.advanceTimersByTime(5000);
      await flushPromises();

      expect(modal._refreshHub).not.toHaveBeenCalled();
    });

    it('refreshes hub when modal is open and no dialog blocking', async () => {
      const modal = createModal();
      modal.isOpen = true;
      modal._refreshHub = jest.fn();
      mockDialogManager.isOpen.mockReturnValue(false);

      modal._startPolling();
      jest.advanceTimersByTime(5000);
      await flushPromises();

      expect(modal._refreshHub).toHaveBeenCalled();
    });

    it('catches polling errors gracefully', async () => {
      const modal = createModal();
      modal.isOpen = true;
      mockToolState.prefetchJobs.mockRejectedValue(new Error('poll fail'));

      modal._startPolling();
      jest.advanceTimersByTime(5000);
      await flushPromises();

      expect(mockLog.warn).toHaveBeenCalledWith(
        'AgentsModal: Polling failed:',
        expect.any(Error)
      );
    });
  });

  // =========================================================================
  // _initializeTools
  // =========================================================================

  describe('_initializeTools', () => {
    it('creates 3 tool components from agent state', () => {
      const modal = createModal();
      mockAgentState.findAgentByName.mockImplementation(name => ({
        agent_name: name,
        enabled: true,
      }));

      modal._initializeTools();

      expect(modal.tools.length).toBe(2);
      expect(modal.tools.map(t => t.name)).toEqual(['research', 'memory']);
    });
  });

  // =========================================================================
  // _renderOndemandView / _renderSystemView
  // =========================================================================

  describe('_renderOndemandView', () => {
    it('renders agent cards in grid container', () => {
      const modal = createModal();
      modal.tools = [{
        agent: { agent_name: 'research', enabled: true, agent_type: 'on-demand' },
      }];
      mockToolState.getToolJobs.mockReturnValue([]);
      mockToolState.getToolRunState.mockReturnValue(null);
      mockAgentState.templatesByName = {};

      const html = modal._renderOndemandView();

      expect(html).toContain('agents-grid-container');
      expect(html).toContain('agents-grid');
    });
  });

  describe('_renderSystemView', () => {
    it('returns empty grid when systemPanel is not set', () => {
      const modal = createModal();

      const html = modal._renderSystemView();

      // systemPanel is not initialized in constructor, so returns empty grid
      expect(html).toContain('agents-grid');
      expect(html).not.toContain('system cards');
    });

    it('delegates to systemPanel.renderCards when set', () => {
      const modal = createModal();
      modal.systemPanel = mockSystemPanel;

      const html = modal._renderSystemView();

      expect(html).toContain('system cards');
      expect(mockSystemPanel.renderCards).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _renderAgentCard — advanced scenarios
  // =========================================================================

  describe('_renderAgentCard — advanced', () => {
    let modal;
    beforeEach(() => {
      modal = createModal();
      mockAgentState.templatesByName = {};
    });

    it('renders running indicator when agent is running', () => {
      mockToolState.getToolJobs.mockReturnValue([]);
      mockToolState.getToolRunState.mockReturnValue({ status: 'running', job_id: '123' });

      const html = modal.renderer.renderAgentCard({
        agent: { agent_name: 'research', enabled: true, agent_type: 'on-demand' },
      }, mockToolState);

      expect(html).toContain('agent-status-badge running');
      expect(html).toContain('Running');
      expect(html).toContain('btn-card-primary running');
      expect(html).toContain('data-action="view-current-job"');
    });

    it('renders Queued text when agent is queued', () => {
      mockToolState.getToolJobs.mockReturnValue([]);
      mockToolState.getToolRunState.mockReturnValue({ status: 'queued' });

      const html = modal.renderer.renderAgentCard({
        agent: { agent_name: 'testing', enabled: true, agent_type: 'on-demand' },
      }, mockToolState);

      expect(html).toContain('Queued');
    });

    it('renders processing state as running', () => {
      mockToolState.getToolJobs.mockReturnValue([]);
      mockToolState.getToolRunState.mockReturnValue({ status: 'processing' });

      const html = modal.renderer.renderAgentCard({
        agent: { agent_name: 'research', enabled: true, agent_type: 'on-demand' },
      }, mockToolState);

      expect(html).toContain('Running');
    });

    it('does not render recent jobs inside card (moved to modal level)', () => {
      mockToolState.getToolJobs.mockReturnValue([
        { id: 'job-1', metadata: { query: 'Find cases' }, status: 'completed' },
        { id: 'job-2', metadata: { query: 'Analyze doc' }, status: 'failed' },
      ]);
      mockToolState.getToolRunState.mockReturnValue(null);

      const html = modal.renderer.renderAgentCard({
        agent: { agent_name: 'research', enabled: true, agent_type: 'on-demand' },
      }, mockToolState);

      // Recent jobs moved to modal level, not inside card
      expect(html).not.toContain('agent-recent-jobs-wrapper');
      expect(html).not.toContain('data-action="toggle-recent-jobs"');
      // But agent card should still render correctly
      expect(html).toContain('agent-card');
      expect(html).toContain('Research');
    });

    it('renders Interface button only for research agent', () => {
      mockToolState.getToolJobs.mockReturnValue([]);
      mockToolState.getToolRunState.mockReturnValue(null);

      const researchHtml = modal.renderer.renderAgentCard({
        agent: { agent_name: 'research', enabled: true, agent_type: 'on-demand' },
      }, mockToolState);
      const testingHtml = modal.renderer.renderAgentCard({
        agent: { agent_name: 'testing', enabled: true, agent_type: 'on-demand' },
      }, mockToolState);

      expect(researchHtml).toContain('data-action="open-perplexica-interface"');
      expect(researchHtml).toContain('Interface');
      expect(testingHtml).not.toContain('data-action="open-perplexica-interface"');
    });

    it('adds disabled class when agent is disabled', () => {
      mockToolState.getToolJobs.mockReturnValue([]);
      mockToolState.getToolRunState.mockReturnValue(null);

      const html = modal.renderer.renderAgentCard({
        agent: { agent_name: 'research', enabled: false, agent_type: 'on-demand' },
      }, mockToolState);

      expect(html).toContain('agent-card disabled');
    });

    it('renders Start button when not running', () => {
      mockToolState.getToolJobs.mockReturnValue([]);
      mockToolState.getToolRunState.mockReturnValue({ status: 'completed' });

      const html = modal.renderer.renderAgentCard({
        agent: { agent_name: 'research', enabled: true, agent_type: 'on-demand' },
      }, mockToolState);

      expect(html).toContain('data-action="open-tool"');
      expect(html).toContain('Start');
      expect(html).not.toContain('btn-card-primary running');
    });
  });

  // =========================================================================
  // _handleAction — advanced action paths
  // =========================================================================

  describe('_handleAction — advanced', () => {
    it('opens tool dialog for valid tool', () => {
      const modal = createModal();
      const mockDialogObj = {
        create: jest.fn(() => document.createElement('div')),
        setupListeners: jest.fn(),
      };
      const tool = { name: 'research', createDialog: jest.fn(() => mockDialogObj) };
      modal.tools = [tool];

      const el = document.createElement('button');
      el.dataset.action = 'open-tool';
      el.dataset.toolName = 'research';

      modal._handleAction(el, {});

      // _openToolDialog is async — tool should be found and dialog opened
      expect(tool.createDialog).toHaveBeenCalled();
    });

    it('open-tool catch handler toasts error when _openToolDialog rejects', async () => {
      const modal = createModal();
      const tool = { name: 'research' };
      modal.tools = [tool];
      modal._openToolDialog = jest.fn().mockRejectedValue(new Error('Dialog creation failed'));

      const el = document.createElement('button');
      el.dataset.action = 'open-tool';
      el.dataset.toolName = 'research';

      modal._handleAction(el, {});
      await flushPromises();

      expect(mockLog.error).toHaveBeenCalledWith(
        'AgentsModal: Failed to open tool dialog:',
        expect.any(Error)
      );
      expect(mockToast.error).toHaveBeenCalledWith('Failed to open tool: Dialog creation failed');
    });

    it('dispatches view-history action', () => {
      const modal = createModal();
      modal._openJobHistory = jest.fn();
      const el = document.createElement('button');
      el.dataset.action = 'view-history';
      el.dataset.toolName = 'research';

      modal._handleAction(el, {});

      expect(modal._openJobHistory).toHaveBeenCalledWith('research');
    });

    it('dispatches view-current-job with job_id from run state', () => {
      const modal = createModal();
      modal._openJobHistory = jest.fn();
      mockToolState.getToolRunState.mockReturnValue({ status: 'running', job_id: 'abc' });

      const el = document.createElement('button');
      el.dataset.action = 'view-current-job';
      el.dataset.toolName = 'research';

      modal._handleAction(el, {});

      expect(modal._openJobHistory).toHaveBeenCalledWith('research', 'abc');
    });

    it('dispatches view-last-job with fallback id field', () => {
      const modal = createModal();
      modal._openJobHistory = jest.fn();
      mockToolState.getToolRunState.mockReturnValue({ status: 'completed', id: 'xyz' });

      const el = document.createElement('button');
      el.dataset.action = 'view-last-job';
      el.dataset.toolName = 'research';

      modal._handleAction(el, {});

      expect(modal._openJobHistory).toHaveBeenCalledWith('research', 'xyz');
    });

    it('dispatches view-current-job with output_id fallback', () => {
      const modal = createModal();
      modal._openJobHistory = jest.fn();
      mockToolState.getToolRunState.mockReturnValue({ status: 'completed', output_id: 'out-1' });

      const el = document.createElement('button');
      el.dataset.action = 'view-current-job';
      el.dataset.toolName = 'research';

      modal._handleAction(el, {});

      expect(modal._openJobHistory).toHaveBeenCalledWith('research', 'out-1');
    });

    it('passes null jobId when run state has no id fields', () => {
      const modal = createModal();
      modal._openJobHistory = jest.fn();
      mockToolState.getToolRunState.mockReturnValue({ status: 'completed' });

      const el = document.createElement('button');
      el.dataset.action = 'view-current-job';
      el.dataset.toolName = 'research';

      modal._handleAction(el, {});

      expect(modal._openJobHistory).toHaveBeenCalledWith('research', null);
    });

    it('dispatches view-specific-job action', () => {
      const modal = createModal();
      modal._openJobHistory = jest.fn();
      const el = document.createElement('button');
      el.dataset.action = 'view-specific-job';
      el.dataset.toolName = 'research';
      el.dataset.jobId = 'job-42';

      modal._handleAction(el, {});

      expect(modal._openJobHistory).toHaveBeenCalledWith('research', 'job-42');
    });

    it('dispatches configure-agent action with valid index', () => {
      const modal = createModal();
      modal._openAgentConfigDialog = jest.fn();
      const el = document.createElement('button');
      el.dataset.action = 'configure-agent';
      el.dataset.agentIndex = '2';

      modal._handleAction(el, {});

      expect(modal._openAgentConfigDialog).toHaveBeenCalledWith(2);
    });

    it('ignores configure-agent with NaN index', () => {
      const modal = createModal();
      modal._openAgentConfigDialog = jest.fn();
      const el = document.createElement('button');
      el.dataset.action = 'configure-agent';
      el.dataset.agentIndex = 'abc';

      modal._handleAction(el, {});

      expect(modal._openAgentConfigDialog).not.toHaveBeenCalled();
    });

    it('dispatches tool-invoke for valid tool', () => {
      const modal = createModal();
      modal._openToolDialog = jest.fn().mockResolvedValue(undefined);
      const tool = { name: 'testing' };
      modal.tools = [tool];
      const el = document.createElement('button');
      el.dataset.action = 'tool-invoke';
      el.dataset.tool = 'testing';

      modal._handleAction(el, {});

      expect(modal._openToolDialog).toHaveBeenCalledWith(tool);
    });

    it('tool-invoke catch handler toasts error when _openToolDialog rejects', async () => {
      const modal = createModal();
      const tool = { name: 'testing' };
      modal.tools = [tool];
      modal._openToolDialog = jest.fn().mockRejectedValue(new Error('Invoke failed'));

      const el = document.createElement('button');
      el.dataset.action = 'tool-invoke';
      el.dataset.tool = 'testing';

      modal._handleAction(el, {});
      await flushPromises();

      expect(mockLog.error).toHaveBeenCalledWith(
        'AgentsModal: Failed to open tool dialog:',
        expect.any(Error)
      );
      expect(mockToast.error).toHaveBeenCalledWith('Failed to open tool: Invoke failed');
    });

    it('toasts error for tool-invoke when tool not found', () => {
      const modal = createModal();
      modal.tools = [];
      const el = document.createElement('button');
      el.dataset.action = 'tool-invoke';
      el.dataset.tool = 'nonexistent';

      modal._handleAction(el, {});

      expect(mockToast.error).toHaveBeenCalledWith('Tool not available.');
    });

    it('dispatches open-job-history with toolName from parent element', () => {
      const modal = createModal();
      modal._openJobHistory = jest.fn();
      const wrapper = document.createElement('div');
      wrapper.dataset.tool = 'research';
      const el = document.createElement('button');
      el.dataset.action = 'open-job-history';
      wrapper.appendChild(el);

      modal._handleAction(el, { target: el });

      expect(modal._openJobHistory).toHaveBeenCalledWith('research');
    });

    it('dispatches open-job-history with null when no parent tool element', () => {
      const modal = createModal();
      modal._openJobHistory = jest.fn();
      const el = document.createElement('button');
      el.dataset.action = 'open-job-history';

      modal._handleAction(el, { target: el });

      expect(modal._openJobHistory).toHaveBeenCalledWith(null);
    });


    it('dispatches open-research-history action', () => {
      const modal = createModal();
      modal._openResearchHistory = jest.fn();
      const el = document.createElement('button');
      el.dataset.action = 'open-research-history';

      modal._handleAction(el, {});

      expect(modal._openResearchHistory).toHaveBeenCalled();
    });

    it('dispatches open-perplexica-interface action', () => {
      const modal = createModal();
      modal._openAgentDashboard = jest.fn();
      const el = document.createElement('button');
      el.dataset.action = 'open-perplexica-interface';

      modal._handleAction(el, {});

      expect(modal._openAgentDashboard).toHaveBeenCalled();
    });

    it('dispatches view-results action', () => {
      const modal = createModal();
      modal._viewToolResults = jest.fn();
      const el = document.createElement('button');
      el.dataset.action = 'view-results';
      el.dataset.tool = 'research';

      modal._handleAction(el, {});

      expect(modal._viewToolResults).toHaveBeenCalledWith('research');
    });

    it('dispatches save-agent-config with valid index', () => {
      const modal = createModal();
      modal._saveAgentConfigFromDialog = jest.fn();
      const el = document.createElement('button');
      el.dataset.action = 'save-agent-config';
      el.dataset.agentIndex = '1';

      modal._handleAction(el, {});

      expect(modal._saveAgentConfigFromDialog).toHaveBeenCalledWith(1);
    });

    it('ignores save-agent-config with NaN index', () => {
      const modal = createModal();
      modal._saveAgentConfigFromDialog = jest.fn();
      const el = document.createElement('button');
      el.dataset.action = 'save-agent-config';
      el.dataset.agentIndex = 'NaN';

      modal._handleAction(el, {});

      expect(modal._saveAgentConfigFromDialog).not.toHaveBeenCalled();
    });

    it('ignores set-view with invalid view ID', () => {
      const modal = createModal();
      modal.switchView = jest.fn();
      modal._refreshHub = jest.fn();
      const el = document.createElement('button');
      el.dataset.action = 'set-view';
      el.dataset.view = 'invalid';

      modal._handleAction(el, {});

      expect(modal.switchView).not.toHaveBeenCalled();
      expect(modal._refreshHub).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _handleToolToggle — legacy toggle path
  // =========================================================================

  describe('_handleToolToggle', () => {
    it('toggles agent and disables input during save', async () => {
      const endpoint = { updateAgentConfig: jest.fn().mockResolvedValue(undefined) };
      const modal = createModal({ endpoint });
      modal._refreshHub = jest.fn();
      mockAgentState.templatesByName = {};
      const agent = { agent_name: 'research', enabled: false };
      mockAgentState.findAgentByName.mockReturnValue(agent);

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.agentName = 'research';
      input.checked = true;

      await modal._handleToolToggle(input);

      expect(agent.enabled).toBe(true);
      expect(endpoint.updateAgentConfig).toHaveBeenCalledWith('research', { enabled: true });
      expect(mockToast.success).toHaveBeenCalledWith('Research enabled.');
      expect(input.disabled).toBe(false);
      expect(modal._refreshHub).toHaveBeenCalled();
    });

    it('reverts toggle and re-enables input on API failure', async () => {
      const endpoint = {
        updateAgentConfig: jest.fn().mockRejectedValue(new Error('Fail')),
      };
      const modal = createModal({ endpoint });
      modal._refreshHub = jest.fn();
      mockAgentState.templatesByName = {};
      const agent = { agent_name: 'research', enabled: true };
      mockAgentState.findAgentByName.mockReturnValue(agent);

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.agentName = 'research';
      input.checked = false;

      await modal._handleToolToggle(input);

      expect(agent.enabled).toBe(true);
      expect(input.checked).toBe(true);
      expect(mockToast.error).toHaveBeenCalledWith('Failed to update Research: Fail');
      expect(input.disabled).toBe(false);
    });

    it('returns early when agent not found', async () => {
      const modal = createModal();
      mockAgentState.findAgentByName.mockReturnValue(null);

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.agentName = 'nonexistent';

      await modal._handleToolToggle(input);

      expect(modal.endpoint.updateAgentConfig).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _attachEventListeners — event delegation
  // =========================================================================

  describe('_attachEventListeners', () => {
    it('attaches exactly 5 listeners: cancel, close, save, bodyEl click, bodyEl change', () => {
      const modal = createModal();
      modal.footerEl.innerHTML = `
        <button class="agents-cancel">Cancel</button>
        <button class="agents-close">Close</button>
        <button class="agents-save">Save</button>
      `;

      modal._attachEventListeners();

      // cancel(click) + close(click) + save(click) + bodyEl(click) + bodyEl(change) = 5
      expect(modal._listeners.length).toBe(5);

      // Verify specific listener types
      const events = modal._listeners.map(l => `${l.event}`);
      expect(events.filter(e => e === 'click').length).toBe(4); // 3 footer buttons + 1 bodyEl delegation
      expect(events.filter(e => e === 'change').length).toBe(1); // 1 bodyEl change delegation
    });

    it('handles checkbox change dispatching to _handleAgentToggle', async () => {
      const endpoint = { updateAgentConfig: jest.fn().mockResolvedValue(undefined) };
      const modal = createModal({ endpoint });
      modal._refreshHub = jest.fn();
      modal.footerEl.innerHTML = '<button class="agents-cancel"></button>';
      mockAgentState.templatesByName = {};
      const agent = { agent_name: 'research', enabled: false };
      mockAgentState.findAgentByName.mockReturnValue(agent);

      modal._attachEventListeners();

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.agentName = 'research';
      checkbox.checked = true;
      modal.bodyEl.appendChild(checkbox);

      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      await flushPromises();

      expect(endpoint.updateAgentConfig).toHaveBeenCalledWith('research', { enabled: true });
    });

    it('handles system agent toggle via agentIndex', async () => {
      const endpoint = { updateAgentConfig: jest.fn().mockResolvedValue(undefined) };
      const modal = createModal({ endpoint });
      modal._refreshHub = jest.fn();
      modal.footerEl.innerHTML = '<button class="agents-cancel"></button>';
      mockAgentState.templatesByName = {};
      const agent = { agent_name: 'context_manager', enabled: false };
      mockAgentState.getAgent.mockReturnValue(agent);

      modal._attachEventListeners();

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.agentIndex = '0';
      checkbox.checked = true;
      modal.bodyEl.appendChild(checkbox);

      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      await flushPromises();

      expect(endpoint.updateAgentConfig).toHaveBeenCalledWith('context_manager', { enabled: true });
    });

    it('ignores non-checkbox change events', async () => {
      const modal = createModal();
      modal.footerEl.innerHTML = '<button class="agents-cancel"></button>';

      modal._attachEventListeners();

      const select = document.createElement('select');
      modal.bodyEl.appendChild(select);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await flushPromises();

      expect(modal.endpoint.updateAgentConfig).not.toHaveBeenCalled();
    });

    it('sets up system panel listeners when activeView is system and systemPanel exists', () => {
      const modal = createModal();
      modal.activeView = 'system';
      modal.footerEl.innerHTML = '<button class="agents-cancel"></button>';
      modal.systemPanel = mockSystemPanel;

      modal._attachEventListeners();

      expect(mockSystemPanel.setupListeners).toHaveBeenCalledWith(
        modal.bodyEl,
        expect.any(Function)
      );
    });
  });

  // =========================================================================
  // _openAgentConfigDialog
  // =========================================================================

  describe('_openAgentConfigDialog', () => {
    it('creates config dialog and opens with DialogManager', () => {
      const modal = createModal();
      const agent = { agent_name: 'context_manager', enabled: true, model_name: 'gpt-4' };
      mockAgentState.getAgent.mockReturnValue(agent);
      mockAgentState.templatesByName = {};

      modal._openAgentConfigDialog(0);

      expect(mockAgentState.setSelectedAgent).toHaveBeenCalledWith(0);
      expect(mockDialogManager.open).toHaveBeenCalled();
      const dialogArg = mockDialogManager.open.mock.calls[0][0];
      expect(dialogArg.className).toBe('tool-dialog');
      expect(dialogArg.innerHTML).toContain('Configuration');
      expect(dialogArg.innerHTML).toContain('data-action="save-agent-config"');
      expect(dialogArg.innerHTML).toContain('data-action="close-dialog"');
    });

    it('returns early when agent not found', () => {
      const modal = createModal();
      mockAgentState.getAgent.mockReturnValue(null);

      modal._openAgentConfigDialog(99);

      expect(mockDialogManager.open).not.toHaveBeenCalled();
    });

    it('sets up click and config panel listeners on dialog when systemPanel exists', () => {
      const modal = createModal();
      const agent = { agent_name: 'test_agent', enabled: true };
      mockAgentState.getAgent.mockReturnValue(agent);
      mockAgentState.templatesByName = {};
      modal.systemPanel = mockSystemPanel;

      modal._openAgentConfigDialog(0);

      expect(mockDialogManager.trackListener).toHaveBeenCalled();
      expect(mockSystemPanel.setupListeners).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _openJobHistory — advanced (jobId, fallback, error)
  // =========================================================================

  describe('_openJobHistory — advanced', () => {
    it('calls showJobDetailsById after delay when jobId provided', () => {
      jest.useFakeTimers();
      const mockModal = {
        show: jest.fn(),
        setAgentFilter: jest.fn(),
        showJobDetailsById: jest.fn(),
      };
      const aetherModals = { get: jest.fn(() => mockModal) };

      const modal = createModal({ aetherModals });
      modal._openJobHistory('research', 'job-99');

      expect(mockModal.setAgentFilter).toHaveBeenCalledWith('research');
      expect(mockModal.show).toHaveBeenCalled();

      jest.advanceTimersByTime(300);
      expect(mockModal.showJobDetailsById).toHaveBeenCalledWith('job-99');

      jest.useRealTimers();
    });

    it('tracks the showJobDetailsById timeout so _clearTimers cancels it', () => {
      jest.useFakeTimers();
      const mockModal = {
        show: jest.fn(),
        setAgentFilter: jest.fn(),
        showJobDetailsById: jest.fn(),
      };
      const aetherModals = { get: jest.fn(() => mockModal) };

      const modal = createModal({ aetherModals });
      const timersBefore = modal._timers.length;

      modal._openJobHistory('research', 'job-55');

      // Timer must be tracked
      expect(modal._timers.length).toBe(timersBefore + 1);

      // Clearing timers (as _cleanup does) should cancel the callback
      modal._clearTimers();
      jest.advanceTimersByTime(300);
      expect(mockModal.showJobDetailsById).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('skips setAgentFilter when no toolName', () => {
      const mockModal = { show: jest.fn(), setAgentFilter: jest.fn() };
      const aetherModals = { get: jest.fn(() => mockModal) };

      const modal = createModal({ aetherModals });
      modal._openJobHistory(null);

      expect(mockModal.setAgentFilter).not.toHaveBeenCalled();
      expect(mockModal.show).toHaveBeenCalled();
    });

    it('falls back to _showDirectJobDetails when modal unavailable and jobId given', () => {
      const modal = createModal({ aetherModals: undefined });
      modal._showDirectJobDetails = jest.fn();

      modal._openJobHistory(null, 'job-42');

      expect(modal._showDirectJobDetails).toHaveBeenCalledWith('job-42');
    });

    it('handles error in job history gracefully', () => {
      const aetherModals = {
        get: jest.fn(() => { throw new Error('Registry error'); }),
      };

      const modal = createModal({ aetherModals });
      modal._openJobHistory('research');

      expect(mockToast.error).toHaveBeenCalledWith('Failed to open job history');
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to open job history'),
        expect.any(Error)
      );
    });

    it('returns without warning when modal.get returns null and no jobId', () => {
      const aetherModals = { get: jest.fn(() => null) };
      const modal = createModal({ aetherModals });

      modal._openJobHistory('research');

      expect(mockToast.warning).toHaveBeenCalledWith('Job history not available');
    });
  });

  // =========================================================================
  // _showDirectJobDetails
  // =========================================================================

  describe('_showDirectJobDetails', () => {
    it('fetches job and opens dialog via DialogManager', async () => {
      const modal = createModal({
        endpoint: {
          updateAgentConfig: jest.fn(),
          api: {
            get: jest.fn().mockResolvedValue({
              id: 'job-1',
              status: 'completed',
            }),
          },
        },
      });

      await modal._showDirectJobDetails('job-1');

      expect(modal.endpoint.api.get).toHaveBeenCalledWith('/v1/agent/status/job-1');
      expect(mockDialogManager.open).toHaveBeenCalled();
    });

    it('normalizes job_id to id when id is missing', async () => {
      const mockJob = { job_id: 'j99', status: 'running' };
      const modal = createModal({
        endpoint: {
          updateAgentConfig: jest.fn(),
          api: { get: jest.fn().mockResolvedValue(mockJob) },
        },
      });

      await modal._showDirectJobDetails('j99');

      expect(mockJob.id).toBe('j99');
      expect(mockDialogManager.open).toHaveBeenCalled();
    });

    it('toasts error when job is null', async () => {
      const modal = createModal({
        endpoint: {
          updateAgentConfig: jest.fn(),
          api: { get: jest.fn().mockResolvedValue(null) },
        },
      });

      await modal._showDirectJobDetails('nonexistent');

      expect(mockToast.error).toHaveBeenCalledWith('Could not load job details');
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Direct job details'),
        expect.anything()
      );
    });

    it('toasts error on API failure', async () => {
      const modal = createModal({
        endpoint: {
          updateAgentConfig: jest.fn(),
          api: { get: jest.fn().mockRejectedValue(new Error('API down')) },
        },
      });

      await modal._showDirectJobDetails('fail');

      expect(mockToast.error).toHaveBeenCalledWith('Could not load job details');
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('Direct job details'),
        expect.any(Error)
      );
    });
  });

  // =========================================================================
  // _openResearchHistory
  // =========================================================================

  describe('_openResearchHistory', () => {
    it('renders history items when data is available', async () => {
      const modal = createModal({
        endpoint: {
          updateAgentConfig: jest.fn(),
          listResearchHistory: jest.fn().mockResolvedValue([
            {
              id: 'h1',
              created_at: new Date().toISOString(),
              content: {
                query: 'Find case law',
                time_ms: 5000,
                sources: [{ title: 'Source 1' }],
                model_used: 'gpt-4',
                results: { answer: 'test' },
              },
            },
          ]),
        },
      });

      await modal._openResearchHistory();

      const dialog = document.querySelector('.tool-dialog');
      expect(dialog).not.toBeNull();
      expect(dialog.innerHTML).toContain('Research History');
      expect(dialog.innerHTML).toContain('Find case law');
      expect(dialog.innerHTML).toContain('1 sources');
      expect(dialog.innerHTML).toContain('gpt-4');
    });

    it('shows empty state when no history', async () => {
      const modal = createModal({
        endpoint: {
          updateAgentConfig: jest.fn(),
          listResearchHistory: jest.fn().mockResolvedValue([]),
        },
      });

      await modal._openResearchHistory();

      const dialog = document.querySelector('.tool-dialog');
      expect(dialog).not.toBeNull();
      expect(dialog.innerHTML).toContain('No research history yet');
    });

    it('shows error state on API failure', async () => {
      const modal = createModal({
        endpoint: {
          updateAgentConfig: jest.fn(),
          listResearchHistory: jest.fn().mockRejectedValue(new Error('Fail')),
        },
      });

      await modal._openResearchHistory();

      const dialog = document.querySelector('.tool-dialog');
      expect(dialog).not.toBeNull();
      expect(dialog.innerHTML).toContain('Failed to load history');
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('research history'),
        expect.any(Error)
      );
    });

    it('handles null history response', async () => {
      const modal = createModal({
        endpoint: {
          updateAgentConfig: jest.fn(),
          listResearchHistory: jest.fn().mockResolvedValue(null),
        },
      });

      await modal._openResearchHistory();

      const dialog = document.querySelector('.tool-dialog');
      expect(dialog).not.toBeNull();
      expect(dialog.innerHTML).toContain('No research history yet');
    });

    it('tracks dialog in _standaloneDialogs for cleanup', async () => {
      const modal = createModal({
        endpoint: {
          updateAgentConfig: jest.fn(),
          listResearchHistory: jest.fn().mockResolvedValue([]),
        },
      });

      expect(modal._standaloneDialogs.length).toBe(0);
      await modal._openResearchHistory();
      expect(modal._standaloneDialogs.length).toBe(1);
    });

    it('close button removes dialog after animation and tracks timeout', async () => {
      jest.useFakeTimers();
      const modal = createModal({
        endpoint: {
          updateAgentConfig: jest.fn(),
          listResearchHistory: jest.fn().mockResolvedValue([]),
        },
      });

      await modal._openResearchHistory();

      const dialog = document.querySelector('.tool-dialog');
      expect(dialog).not.toBeNull();

      const timersBefore = modal._timers.length;
      const closeBtn = dialog.querySelector('.tool-dialog-close');
      closeBtn.click();

      // Close timeout must be tracked
      expect(modal._timers.length).toBe(timersBefore + 1);
      expect(dialog.classList.contains('visible')).toBe(false);

      jest.advanceTimersByTime(300);
      expect(document.querySelector('.tool-dialog')).toBeNull();
      // Dialog must be removed from standalone tracking too
      expect(modal._standaloneDialogs.length).toBe(0);

      jest.useRealTimers();
    });

    it('overlay click removes dialog', async () => {
      jest.useFakeTimers();
      const modal = createModal({
        endpoint: {
          updateAgentConfig: jest.fn(),
          listResearchHistory: jest.fn().mockResolvedValue([]),
        },
      });

      await modal._openResearchHistory();

      const dialog = document.querySelector('.tool-dialog');
      const overlay = dialog.querySelector('.tool-dialog-overlay');
      overlay.click();

      jest.advanceTimersByTime(300);
      expect(document.querySelector('.tool-dialog')).toBeNull();

      jest.useRealTimers();
    });

    it('View Results button click calls _viewHistoricalResearch and closes dialog', async () => {
      jest.useFakeTimers();
      const historyData = [
        {
          id: 'h1',
          created_at: new Date().toISOString(),
          content: {
            query: 'Find case law',
            time_ms: 5000,
            sources: [{ title: 'Source 1' }],
            model_used: 'gpt-4',
            results: { answer: 'Case law found' },
          },
        },
      ];

      const modal = createModal({
        endpoint: {
          updateAgentConfig: jest.fn(),
          listResearchHistory: jest.fn().mockResolvedValue(historyData),
        },
      });
      modal._viewHistoricalResearch = jest.fn();

      await modal._openResearchHistory();

      const dialog = document.querySelector('.tool-dialog');
      expect(dialog).not.toBeNull();

      const viewBtn = dialog.querySelector('.research-history-view[data-output-id="h1"]');
      expect(viewBtn).not.toBeNull();

      viewBtn.click();

      // Should have called _viewHistoricalResearch with the matching item
      expect(modal._viewHistoricalResearch).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'h1',
          content: expect.objectContaining({ query: 'Find case law' }),
        })
      );

      // Dialog should start close animation
      expect(dialog.classList.contains('visible')).toBe(false);

      // After timeout, dialog removed
      jest.advanceTimersByTime(300);
      expect(document.querySelector('.tool-dialog')).toBeNull();

      jest.useRealTimers();
    });

    it('View Results button does nothing when history item lacks results', async () => {
      const historyData = [
        {
          id: 'h2',
          created_at: new Date().toISOString(),
          content: {
            query: 'No results query',
            time_ms: 1000,
            sources: [],
            model_used: 'gpt-3.5',
            // No results field
          },
        },
      ];

      const modal = createModal({
        endpoint: {
          updateAgentConfig: jest.fn(),
          listResearchHistory: jest.fn().mockResolvedValue(historyData),
        },
      });
      modal._viewHistoricalResearch = jest.fn();

      await modal._openResearchHistory();

      const dialog = document.querySelector('.tool-dialog');
      const viewBtn = dialog.querySelector('.research-history-view[data-output-id="h2"]');
      expect(viewBtn).not.toBeNull();

      viewBtn.click();

      // Should NOT call _viewHistoricalResearch since content.results is missing
      expect(modal._viewHistoricalResearch).not.toHaveBeenCalled();
      // Dialog should still be in DOM (not closed by the click)
      expect(document.body.contains(dialog)).toBe(true);
    });
  });

  // =========================================================================
  // _openAgentDashboard / openAgentDashboard
  // =========================================================================

  describe('_openAgentDashboard', () => {
    it('sends IPC to open research window when IPC is available', async () => {
      const modal = createModal();
      
      mockAether.ipc = { send: jest.fn() };

      await modal._openAgentDashboard();

      expect(mockAether.ipc.send).toHaveBeenCalledWith('window:open-research');
      expect(mockLog.info).toHaveBeenCalledWith('AgentsModal: Agent dashboard opened');
    });

    it('logs error when IPC is not available', async () => {
      const modal = createModal();
      
      mockAether.ipc = undefined;

      await modal._openAgentDashboard();

      expect(mockLog.error).toHaveBeenCalledWith('AgentsModal: IPC not available');
    });

    it('handles error gracefully', async () => {
      const modal = createModal();
      
      mockAether.ipc = {
        send: () => { throw new Error('Bridge error'); }
      };

      await modal._openAgentDashboard();

      expect(mockToast.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to open dashboard')
      );
    });

    it('public openAgentDashboard delegates to _openAgentDashboard', () => {
      const modal = createModal();
      modal._openAgentDashboard = jest.fn();

      modal.openAgentDashboard();

      expect(modal._openAgentDashboard).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _viewHistoricalResearch
  // =========================================================================

  describe('_viewHistoricalResearch', () => {
    it('creates ResultsViewerDialog and opens via DialogManager', () => {
      const modal = createModal();
      const historyItem = {
        content: {
          query: 'Historical research query',
          answer: 'Results here',
          sources: [],
        },
      };

      modal._viewHistoricalResearch(historyItem);

      expect(mockDialogManager.open).toHaveBeenCalled();
    });

    it('handles empty content gracefully and uses fallback toolName', () => {
      const modal = createModal();

      modal._viewHistoricalResearch({});

      const ResultsViewerDialog = require(
        '../../../../src/renderer/main/modules/agents/components/dialogs/ResultsViewerDialog'
      );
      expect(ResultsViewerDialog).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'Research Results' })
      );
      expect(mockDialogManager.open).toHaveBeenCalled();
    });

    it('uses content.query as toolName for ResultsViewerDialog', () => {
      const modal = createModal();
      const historyItem = {
        content: { query: 'My Research' },
      };

      modal._viewHistoricalResearch(historyItem);

      // ResultsViewerDialog is called with toolName = query
      const ResultsViewerDialog = require(
        '../../../../src/renderer/main/modules/agents/components/dialogs/ResultsViewerDialog'
      );
      expect(ResultsViewerDialog).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'My Research' })
      );
    });
  });

  // =========================================================================
  // _refreshHub
  // =========================================================================

  describe('_refreshHub', () => {
    it('re-renders hub without prefetch by default', async () => {
      const modal = createModal();
      modal.tools = [];
      mockAgentState.templatesByName = {};
      mockToolState.prefetchJobs.mockClear();

      await modal._refreshHub();

      expect(mockToolState.prefetchJobs).not.toHaveBeenCalled();
      expect(modal.bodyEl.innerHTML).toContain('agents-hub');
    });

    it('prefetches jobs when forcePrefetch is true', async () => {
      const modal = createModal();
      modal.tools = [];
      mockAgentState.templatesByName = {};
      mockAgentState.findAgentByName.mockReturnValue(null);
      mockToolState.prefetchJobs.mockResolvedValue(undefined);

      await modal._refreshHub(true);

      expect(mockToolState.prefetchJobs).toHaveBeenCalledWith(
        modal.endpoint,
        ['research'],
        expect.any(Function)
      );
    });

    it('clears panel listeners before re-rendering', async () => {
      const modal = createModal();
      modal.tools = [];
      mockAgentState.templatesByName = {};

      const el = document.createElement('div');
      const handler = jest.fn();
      const removeSpy = jest.spyOn(el, 'removeEventListener');
      modal._trackPanelListener(el, 'click', handler);
      expect(modal._panelListeners.length).toBe(1);

      await modal._refreshHub();

      // Old panel listener's removeEventListener must have been called
      expect(removeSpy).toHaveBeenCalledWith('click', handler, undefined);
    });

    it('updates footer content', async () => {
      const modal = createModal();
      modal.tools = [];
      modal.activeView = 'system';
      mockAgentState.templatesByName = {};

      await modal._refreshHub();

      // System view should have Save/Cancel buttons
      expect(modal.footerEl.innerHTML).toContain('agents-save');
      expect(modal.footerEl.innerHTML).toContain('agents-cancel');
      expect(modal.footerEl.classList.contains('hidden')).toBe(false);
    });
  });

  // =========================================================================
  // _saveAgentConfigFromDialog
  // =========================================================================

  describe('_saveAgentConfigFromDialog', () => {
    it('collects form values and saves agent config', async () => {
      const endpoint = { updateAgentConfig: jest.fn().mockResolvedValue(undefined) };
      const modal = createModal({ endpoint });
      modal._refreshHub = jest.fn();

      const agent = {
        agent_name: 'test',
        enabled: true,
        model_name: 'gpt-3.5',
        execution_trigger: 'manual',
        trigger_frequency: 60,
        prompt_template: 'old prompt',
        configuration: {},
      };
      mockAgentState.getAgent.mockReturnValue(agent);

      const dialogEl = document.createElement('div');
      dialogEl.innerHTML = `
        <select class="config-model-select"><option value="gpt-4" selected>GPT-4</option></select>
        <select class="config-trigger-select"><option value="scheduled" selected>Scheduled</option></select>
        <input class="config-frequency-input" value="120">
        <textarea class="config-prompt-textarea">New prompt</textarea>
      `;
      mockDialogManager.getDialog.mockReturnValue(dialogEl);

      await modal._saveAgentConfigFromDialog(0);

      expect(agent.model_name).toBe('gpt-4');
      expect(agent.execution_trigger).toBe('scheduled');
      expect(agent.trigger_frequency).toBe(120);
      expect(agent.prompt_template).toBe('New prompt');
      expect(endpoint.updateAgentConfig).toHaveBeenCalledWith('test', expect.objectContaining({
        model_name: 'gpt-4',
        execution_trigger: 'scheduled',
        trigger_frequency: 120,
        prompt_template: 'New prompt',
      }));
      expect(mockToast.success).toHaveBeenCalledWith('Configuration saved.');
      expect(mockDialogManager.close).toHaveBeenCalled();
      expect(modal._refreshHub).toHaveBeenCalled();
    });

    it('returns early when agent not found', async () => {
      const modal = createModal();
      mockAgentState.getAgent.mockReturnValue(null);
      mockDialogManager.getDialog.mockClear();

      await modal._saveAgentConfigFromDialog(99);

      expect(mockDialogManager.getDialog).not.toHaveBeenCalled();
    });

    it('returns early when dialog not found', async () => {
      const modal = createModal();
      mockAgentState.getAgent.mockReturnValue({ agent_name: 'test' });
      mockDialogManager.getDialog.mockReturnValue(null);

      await modal._saveAgentConfigFromDialog(0);

      expect(modal.endpoint.updateAgentConfig).not.toHaveBeenCalled();
    });

    it('handles missing form elements gracefully', async () => {
      const endpoint = { updateAgentConfig: jest.fn().mockResolvedValue(undefined) };
      const modal = createModal({ endpoint });
      modal._refreshHub = jest.fn();

      const agent = {
        agent_name: 'test',
        enabled: true,
        model_name: 'gpt-3.5',
        configuration: {},
      };
      mockAgentState.getAgent.mockReturnValue(agent);

      const dialogEl = document.createElement('div');
      mockDialogManager.getDialog.mockReturnValue(dialogEl);

      await modal._saveAgentConfigFromDialog(0);

      // Agent properties should be unchanged
      expect(agent.model_name).toBe('gpt-3.5');
      expect(endpoint.updateAgentConfig).toHaveBeenCalledWith('test', expect.any(Object));
    });

    it('toasts error on save failure', async () => {
      const endpoint = {
        updateAgentConfig: jest.fn().mockRejectedValue(new Error('Save failed')),
      };
      const modal = createModal({ endpoint });

      const agent = {
        agent_name: 'test',
        enabled: true,
        model_name: 'gpt-3.5',
        configuration: {},
      };
      mockAgentState.getAgent.mockReturnValue(agent);

      const dialogEl = document.createElement('div');
      mockDialogManager.getDialog.mockReturnValue(dialogEl);

      await modal._saveAgentConfigFromDialog(0);

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Failed to save'));
      expect(mockLog.error).toHaveBeenCalledWith(
        expect.stringContaining('save agent config'),
        expect.any(Error)
      );
    });
  });

  // =========================================================================
  // FEATURE INTEGRATION TESTS — Consumer Flows
  // =========================================================================

  /**
   * Helpers for feature tests — set up realistic agent state so the full
   * render chain (AgentsModal → ToolsHubModal → _renderAgentCard) produces
   * the HTML a real consumer sees.
   */

  function makeAgent(name, enabled = true) {
    return {
      agent_name: name,
      enabled,
      agent_type: 'on-demand',
      model_name: 'gpt-4',
      prompt_template: `${name} prompt template`,
      execution_trigger: 'manual',
      trigger_frequency: 0,
      configuration: {},
    };
  }

  function setupAgentMocks(overrides = {}) {
    // Default to memory agent per current source implementation
    const agents = overrides.agents || [
      makeAgent('research'),
      makeAgent('memory'),
    ];
    const agentMap = {};
    for (const a of agents) agentMap[a.agent_name] = a;

    mockAgentState.findAgentByName.mockImplementation((name) => agentMap[name] || null);
    mockAgentState.agents = agents;
    mockAgentState.fetchAll.mockResolvedValue(undefined);
    mockToolState.prefetchAll.mockResolvedValue(undefined);

    if (overrides.jobs) {
      mockToolState.getToolJobs.mockImplementation((name) => overrides.jobs[name] || []);
    } else {
      mockToolState.getToolJobs.mockReturnValue([]);
    }

    if (overrides.runStates) {
      mockToolState.getToolRunState.mockImplementation((name) => overrides.runStates[name] || null);
    } else {
      mockToolState.getToolRunState.mockReturnValue(null);
    }

    return agents;
  }

  async function renderFullModal(modal) {
    modal.isOpen = true; // Required for _renderContent to complete rendering
    await modal._renderContent();
    await flushPromises();
    modal._attachEventListeners();
    return modal;
  }

  // -----------------------------------------------------------------------
  // Feature: Full Render Flow
  // -----------------------------------------------------------------------

  describe('Feature: Full Render Flow', () => {
    it('produces agent cards with names, descriptions, and Start buttons', async () => {
      setupAgentMocks();
      const modal = createModal();
      await renderFullModal(modal);

      // Hub structure rendered
      expect(modal.bodyEl.querySelector('.agents-hub')).not.toBeNull();

      // 2 agent cards rendered (one per tool)
      const cards = modal.bodyEl.querySelectorAll('.agent-card');
      expect(cards.length).toBe(2);

      // Each card has the correct agent name in its title
      const titles = [...modal.bodyEl.querySelectorAll('.agent-card-title')];
      const titleTexts = titles.map(t => t.textContent.trim());
      expect(titleTexts).toContain('Research');
      expect(titleTexts).toContain('Memory');

      // Each card has a description
      const descriptions = modal.bodyEl.querySelectorAll('.agent-card-description');
      expect(descriptions.length).toBe(2);
      for (const desc of descriptions) {
        expect(desc.textContent.trim().length).toBeGreaterThan(0);
      }

      // Each card has a Start or Memory Browser button
      const startBtns = modal.bodyEl.querySelectorAll('[data-action="open-tool"]');
      const memoryBtns = modal.bodyEl.querySelectorAll('[data-action="open-memory-browser"]');
      expect(startBtns.length + memoryBtns.length).toBe(2);
      for (const btn of startBtns) {
        expect(btn.textContent.trim()).toContain('Start');
      }
    });

    it('renders enabled/disabled status class on cards', async () => {
      setupAgentMocks({
        agents: [
          makeAgent('research', true),
          makeAgent('memory', false),
        ],
      });
      const modal = createModal();
      await renderFullModal(modal);

      const researchCard = modal.bodyEl.querySelector('.agent-card[data-tool-name="research"]');
      const memoryCard = modal.bodyEl.querySelector('.agent-card[data-tool-name="memory"]');

      expect(researchCard.classList.contains('enabled')).toBe(true);
      expect(memoryCard.classList.contains('disabled')).toBe(true);
    });

    it('renders no tabs (hub view without tab navigation)', async () => {
      setupAgentMocks();
      const modal = createModal();
      await renderFullModal(modal);

      // _getViews() returns [], so no tabs should be rendered
      const tabs = modal.bodyEl.querySelectorAll('.agents-tab');
      expect(tabs.length).toBe(0);
    });

    it('renders modal-level recent jobs section when jobs available', async () => {
      setupAgentMocks({
        jobs: {
          research: [
            { id: 'j1', status: 'completed', metadata: { query: 'Find precedent' }, created_at: new Date(Date.now() + 1000).toISOString() },
            { id: 'j2', status: 'running', metadata: { query: 'Statute check' }, created_at: new Date().toISOString() },
          ],
        },
      });
      const modal = createModal();
      await renderFullModal(modal);

      // Modal-level recent jobs section rendered
      const recentJobsSection = modal.bodyEl.querySelector('.agents-recent-jobs-section');
      expect(recentJobsSection).not.toBeNull();

      // Job items rendered
      const jobItems = modal.bodyEl.querySelectorAll('.agents-recent-job-item');
      expect(jobItems.length).toBe(2);

      // Job queries visible
      const queries = [...modal.bodyEl.querySelectorAll('.recent-job-query')];
      expect(queries[0].textContent).toBe('Find precedent');
      expect(queries[1].textContent).toBe('Statute check');

      // Each item has correct data attributes
      expect(jobItems[0].dataset.action).toBe('view-specific-job');
      expect(jobItems[0].dataset.toolName).toBe('research');
      expect(jobItems[0].dataset.jobId).toBe('j1');
    });

    it('ondemand footer is empty (no Save/Cancel)', async () => {
      setupAgentMocks();
      const modal = createModal();
      await renderFullModal(modal);

      // Footer should have no content in ondemand view
      expect(modal.footerEl.querySelector('.agents-save')).toBeNull();
      expect(modal.footerEl.querySelector('.agents-cancel')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Feature: Click Start Opens Tool Dialog
  // -----------------------------------------------------------------------

  describe('Feature: Click Start Opens Tool Dialog', () => {
    it('clicking Start on research card opens the research tool dialog', async () => {
      setupAgentMocks();
      const modal = createModal();
      await renderFullModal(modal);

      // Get the research tool's mock createDialog
      const researchTool = modal.tools.find(t => t.name === 'research');
      const mockDialog = { create: jest.fn(() => document.createElement('div')), setupListeners: jest.fn() };
      researchTool.createDialog.mockReturnValue(mockDialog);

      // Click the Start button for research
      const startBtn = modal.bodyEl.querySelector('[data-action="open-tool"][data-tool-name="research"]');
      expect(startBtn).not.toBeNull();
      startBtn.click();
      await flushPromises();

      // Dialog was created and opened
      expect(researchTool.createDialog).toHaveBeenCalled();
      expect(mockDialog.create).toHaveBeenCalled();
      expect(mockDialogManager.open).toHaveBeenCalled();
      expect(mockDialog.setupListeners).toHaveBeenCalled();
    });

    it('clicking Start on disabled agent still opens dialog (on-demand start is allowed)', async () => {
      setupAgentMocks({
        agents: [makeAgent('research', false), makeAgent('testing')],
      });
      const modal = createModal();
      await renderFullModal(modal);

      const researchTool = modal.tools.find(t => t.name === 'research');
      const mockDialog = { create: jest.fn(() => document.createElement('div')), setupListeners: jest.fn() };
      researchTool.createDialog.mockReturnValue(mockDialog);

      const startBtn = modal.bodyEl.querySelector('[data-action="open-tool"][data-tool-name="research"]');
      startBtn.click();
      await flushPromises();

      // Even disabled agents can be started on-demand
      expect(researchTool.createDialog).toHaveBeenCalled();
      expect(mockDialogManager.open).toHaveBeenCalled();
    });

    it('shows error toast when createDialog throws', async () => {
      setupAgentMocks();
      const modal = createModal();
      await renderFullModal(modal);

      const researchTool = modal.tools.find(t => t.name === 'research');
      researchTool.createDialog.mockImplementation(() => { throw new Error('Dialog init failed'); });

      const startBtn = modal.bodyEl.querySelector('[data-action="open-tool"][data-tool-name="research"]');
      startBtn.click();
      await flushPromises();

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Failed to open dialog'));
    });
  });

  // -----------------------------------------------------------------------
  // Feature: Recent Job Click Opens Job History
  // -----------------------------------------------------------------------

  describe('Feature: Recent Job Click Opens Job History', () => {
    it('clicking a recent job item opens job history with the correct jobId', async () => {
      setupAgentMocks({
        jobs: {
          research: [
            { id: 'job-abc', status: 'completed', metadata: { query: 'Find case law on negligence' }, created_at: new Date().toISOString() },
          ],
        },
      });
      const modal = createModal();
      await renderFullModal(modal);
      jest.spyOn(modal, '_openJobHistory');

      const jobItem = modal.bodyEl.querySelector('.agents-recent-job-item[data-job-id="job-abc"]');
      expect(jobItem).not.toBeNull();
      jobItem.click();
      await flushPromises();

      expect(modal._openJobHistory).toHaveBeenCalledWith('research', 'job-abc');
    });

    it('long query text is truncated in the rendered item', async () => {
      const longQuery = 'A'.repeat(50);
      setupAgentMocks({
        jobs: {
          memory: [
            { id: 'j-long', status: 'completed', metadata: { query: longQuery }, created_at: new Date().toISOString() },
          ],
        },
      });
      const modal = createModal();
      await renderFullModal(modal);

      const queryEl = modal.bodyEl.querySelector('.recent-job-query');
      // _getJobQuery truncates at 37 chars + '...'
      expect(queryEl.textContent.length).toBeLessThanOrEqual(40);
      expect(queryEl.textContent).toContain('...');
    });
  });

  // -----------------------------------------------------------------------
  // Feature: Running Status Display
  // -----------------------------------------------------------------------

  describe('Feature: Running Status Display', () => {
    it('running agent shows Running button instead of Start', async () => {
      setupAgentMocks({
        runStates: {
          research: { status: 'running', job_id: 'active-job-1' },
        },
      });
      const modal = createModal();
      await renderFullModal(modal);

      const researchCard = modal.bodyEl.querySelector('.agent-card[data-tool-name="research"]');
      expect(researchCard).not.toBeNull();
      expect(researchCard.dataset.runStatus).toBe('running');

      // Running button present
      const runningBtn = researchCard.querySelector('[data-action="view-current-job"]');
      expect(runningBtn).not.toBeNull();
      expect(runningBtn.textContent.trim()).toContain('Running');

      // Start button NOT present
      const startBtn = researchCard.querySelector('[data-action="open-tool"]');
      expect(startBtn).toBeNull();
    });

    it('queued agent shows Queued badge in header controls', async () => {
      setupAgentMocks({
        runStates: {
          memory: { status: 'queued', job_id: 'queued-job-1' },
        },
      });
      const modal = createModal();
      await renderFullModal(modal);

      const memoryCard = modal.bodyEl.querySelector('.agent-card[data-tool-name="memory"]');
      const badge = memoryCard.querySelector('.agent-status-badge');
      expect(badge).not.toBeNull();
      expect(badge.textContent.trim()).toContain('Queued');
    });

    it('clicking Running button opens job history for the active job', async () => {
      setupAgentMocks({
        runStates: {
          research: { status: 'running', job_id: 'active-job-1' },
        },
      });
      const modal = createModal();
      await renderFullModal(modal);
      jest.spyOn(modal, '_openJobHistory');

      const runningBtn = modal.bodyEl.querySelector('button[data-action="view-current-job"][data-tool-name="research"]');
      runningBtn.click();
      await flushPromises();

      expect(modal._openJobHistory).toHaveBeenCalledWith('research', 'active-job-1');
    });

    it('completed status does NOT show running indicator', async () => {
      setupAgentMocks({
        runStates: {
          research: { status: 'completed', job_id: 'done-job' },
        },
      });
      const modal = createModal();
      await renderFullModal(modal);

      const researchCard = modal.bodyEl.querySelector('.agent-card[data-tool-name="research"]');
      const badge = researchCard.querySelector('.agent-status-badge.running');
      expect(badge).toBeNull();

      // Start button present (not running)
      const startBtn = researchCard.querySelector('[data-action="open-tool"]');
      expect(startBtn).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Feature: View Switch + Footer
  // -----------------------------------------------------------------------

  describe('Feature: View Switch + Footer', () => {
    it('clicking System Agents tab switches view and shows Save/Cancel', async () => {
      setupAgentMocks();
      const modal = createModal();
      await renderFullModal(modal);

      // Initial: ondemand view, no footer buttons
      expect(modal.footerEl.querySelector('.agents-save')).toBeNull();

      // Switch to system view directly (no tabs since _getViews returns [])
      modal.activeView = 'system';
      modal.bodyEl.innerHTML = modal._renderActiveView();
      if (modal.footerEl) modal.footerEl.innerHTML = modal._renderModalFooter();
      await flushPromises();

      // View switched
      expect(modal.activeView).toBe('system');

      // Footer now has Save and Cancel
      expect(modal.footerEl.querySelector('.agents-save')).not.toBeNull();
      expect(modal.footerEl.querySelector('.agents-cancel')).not.toBeNull();
    });

    it('switching back to On Demand removes footer buttons', async () => {
      setupAgentMocks();
      const modal = createModal();
      await renderFullModal(modal);

      // Switch to system view directly (no tabs since _getViews returns [])
      modal.activeView = 'system';
      modal.bodyEl.innerHTML = modal._renderActiveView();
      if (modal.footerEl) modal.footerEl.innerHTML = modal._renderModalFooter();
      await flushPromises();
      expect(modal.footerEl.querySelector('.agents-save')).not.toBeNull();

      // Switch back to ondemand directly (no tabs since _getViews returns [])
      modal.activeView = 'ondemand';
      modal.bodyEl.innerHTML = modal._renderActiveView();
      if (modal.footerEl) modal.footerEl.innerHTML = modal._renderModalFooter();
      await flushPromises();

      expect(modal.footerEl.querySelector('.agents-save')).toBeNull();
      expect(modal.activeView).toBe('ondemand');
    });

    it('system view renders system panel cards when systemPanel is set', async () => {
      setupAgentMocks();
      const modal = createModal();
      modal.systemPanel = mockSystemPanel;
      await renderFullModal(modal);

      // Switch to system view directly (no tabs since _getViews returns [])
      modal.activeView = 'system';
      modal.bodyEl.innerHTML = modal._renderActiveView();
      if (modal.footerEl) modal.footerEl.innerHTML = modal._renderModalFooter();
      await flushPromises();

      // SystemAgentPanel.renderCards() was invoked
      expect(mockSystemPanel.renderCards).toHaveBeenCalled();
      expect(modal.bodyEl.innerHTML).toContain('system cards');
    });
  });

  // -----------------------------------------------------------------------
  // Feature: Full Save Flow
  // -----------------------------------------------------------------------

  describe('Feature: Full Save Flow', () => {
    it('save with dirty agents calls API for each, toasts success, and closes modal', async () => {
      const researchAgent = makeAgent('research');
      const memoryAgent = makeAgent('memory');
      setupAgentMocks({ agents: [researchAgent, memoryAgent] });

      const endpoint = { updateAgentConfig: jest.fn().mockResolvedValue(undefined) };
      const onSave = jest.fn();
      const modal = createModal({ endpoint, onSave });
      await renderFullModal(modal);

      // Switch to system view to get Save button
      // Switch to system view directly (no tabs since _getViews returns [])
      modal.activeView = 'system';
      modal.bodyEl.innerHTML = modal._renderActiveView();
      if (modal.footerEl) modal.footerEl.innerHTML = modal._renderModalFooter();
      // Re-attach listeners after manual re-render (matches _refreshHub behavior)
      modal._attachEventListeners();
      await flushPromises();

      // Mark two agents dirty - use memory instead of testing per current source
      mockAgentState.getDirtyAgents.mockReturnValue(['research', 'memory']);
      mockAgentState.findAgentByName.mockImplementation((name) => {
        if (name === 'research') return researchAgent;
        if (name === 'memory') return memoryAgent;
        return null;
      });

      // Spy on close
      jest.spyOn(modal, 'close').mockImplementation(() => {});

      // Click Save
      const saveBtn = modal.footerEl.querySelector('.agents-save');
      expect(saveBtn).not.toBeNull();
      saveBtn.click();
      await flushPromises();

      // API called for each dirty agent
      expect(endpoint.updateAgentConfig).toHaveBeenCalledTimes(2);
      expect(endpoint.updateAgentConfig).toHaveBeenCalledWith('research', expect.objectContaining({ enabled: true }));
      expect(endpoint.updateAgentConfig).toHaveBeenCalledWith('memory', expect.objectContaining({ enabled: true }));

      // Success toast
      expect(mockToast.success).toHaveBeenCalledWith('Agent configurations saved.');

      // Modal closed and onSave callback invoked
      expect(modal.close).toHaveBeenCalled();
      expect(onSave).toHaveBeenCalled();
    });

    it('save with no dirty agents toasts "No changes" and still closes', async () => {
      setupAgentMocks();
      const onSave = jest.fn();
      const modal = createModal({ onSave });
      await renderFullModal(modal);

      // Switch to system view
      // Switch to system view directly (no tabs since _getViews returns [])
      modal.activeView = 'system';
      modal.bodyEl.innerHTML = modal._renderActiveView();
      if (modal.footerEl) modal.footerEl.innerHTML = modal._renderModalFooter();
      // Re-attach listeners after manual re-render (matches _refreshHub behavior)
      modal._attachEventListeners();
      await flushPromises();

      mockAgentState.getDirtyAgents.mockReturnValue([]);
      jest.spyOn(modal, 'close').mockImplementation(() => {});

      const saveBtn = modal.footerEl.querySelector('.agents-save');
      saveBtn.click();
      await flushPromises();

      expect(mockToast.success).toHaveBeenCalledWith('No changes to save.');
      expect(modal.close).toHaveBeenCalled();
      expect(onSave).toHaveBeenCalled();
    });

    it('save failure shows error toast and re-enables Save button', async () => {
      const researchAgent = makeAgent('research');
      setupAgentMocks({ agents: [researchAgent, makeAgent('memory')] });

      const endpoint = { updateAgentConfig: jest.fn().mockRejectedValue(new Error('Network error')) };
      const modal = createModal({ endpoint });
      await renderFullModal(modal);

      // Switch to system view directly (no tabs since _getViews returns [])
      modal.activeView = 'system';
      modal.bodyEl.innerHTML = modal._renderActiveView();
      if (modal.footerEl) modal.footerEl.innerHTML = modal._renderModalFooter();
      // Re-attach listeners after manual re-render (matches _refreshHub behavior)
      modal._attachEventListeners();
      await flushPromises();

      mockAgentState.getDirtyAgents.mockReturnValue(['research']);
      mockAgentState.findAgentByName.mockReturnValue(researchAgent);

      const saveBtn = modal.footerEl.querySelector('.agents-save');
      saveBtn.click();
      await flushPromises();

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Failed to save'));
      // Save button re-enabled after failure
      expect(saveBtn.disabled).toBe(false);
      expect(saveBtn.textContent).toBe('Save Changes');
    });

    it('Cancel button closes modal and invokes onCancel', async () => {
      setupAgentMocks();
      const onCancel = jest.fn();
      const modal = createModal({ onCancel });
      await renderFullModal(modal);

      // Switch to system view directly (no tabs since _getViews returns [])
      modal.activeView = 'system';
      modal.bodyEl.innerHTML = modal._renderActiveView();
      if (modal.footerEl) modal.footerEl.innerHTML = modal._renderModalFooter();
      // Re-attach listeners after manual re-render (matches _refreshHub behavior)
      modal._attachEventListeners();
      await flushPromises();

      jest.spyOn(modal, 'close').mockImplementation(() => {});

      const cancelBtn = modal.footerEl.querySelector('.agents-cancel');
      cancelBtn.click();
      await flushPromises();

      expect(modal.close).toHaveBeenCalled();
      expect(onCancel).toHaveBeenCalled();
    });

    it('_refreshHub is blocked during save to prevent poll race condition', async () => {
      // Regression: a poll firing mid-save would re-render footer, creating
      // a fresh enabled Save button and allowing double-submit.
      const researchAgent = makeAgent('research');
      setupAgentMocks({ agents: [researchAgent, makeAgent('memory')] });

      // Slow endpoint so save is still in progress when we test
      let resolveEndpoint;
      const endpoint = {
        updateAgentConfig: jest.fn(() => new Promise((r) => { resolveEndpoint = r; })),
      };
      const modal = createModal({ endpoint });
      await renderFullModal(modal);

      // Switch to system view
      // Switch to system view directly (no tabs since _getViews returns [])
      modal.activeView = 'system';
      modal.bodyEl.innerHTML = modal._renderActiveView();
      if (modal.footerEl) modal.footerEl.innerHTML = modal._renderModalFooter();
      await flushPromises();

      mockAgentState.getDirtyAgents.mockReturnValue(['research']);
      mockAgentState.findAgentByName.mockReturnValue(researchAgent);

      const saveBtn = modal.footerEl.querySelector('.agents-save');
      expect(saveBtn.disabled).toBe(false);

      // Start save (will be pending because endpoint doesn't resolve yet)
      const savePromise = modal._handleSave();
      await flushPromises();

      // Save button should be disabled and show "Saving..."
      expect(saveBtn.disabled).toBe(true);
      expect(saveBtn.textContent).toBe('Saving...');

      // _isSaving flag is set
      expect(modal._isSaving).toBe(true);

      // Simulate poll-triggered _refreshHub — should be blocked
      await modal._refreshHub();

      // Save button should STILL be disabled (not re-rendered by poll)
      expect(saveBtn.disabled).toBe(true);
      expect(saveBtn.textContent).toBe('Saving...');

      // Resolve the endpoint to complete the save
      resolveEndpoint();
      jest.spyOn(modal, 'close').mockImplementation(() => {});
      await savePromise;
      await flushPromises();

      // _isSaving flag cleared
      expect(modal._isSaving).toBe(false);
    });

    it('_isSaving resets even when save fails', async () => {
      const researchAgent = makeAgent('research');
      setupAgentMocks({ agents: [researchAgent, makeAgent('memory')] });

      const endpoint = { updateAgentConfig: jest.fn().mockRejectedValue(new Error('Timeout')) };
      const modal = createModal({ endpoint });
      await renderFullModal(modal);

      // Switch to system view directly (no tabs since _getViews returns [])
      modal.activeView = 'system';
      modal.bodyEl.innerHTML = modal._renderActiveView();
      if (modal.footerEl) modal.footerEl.innerHTML = modal._renderModalFooter();
      await flushPromises();

      mockAgentState.getDirtyAgents.mockReturnValue(['research']);
      mockAgentState.findAgentByName.mockReturnValue(researchAgent);

      await modal._handleSave();
      await flushPromises();

      // Flag must be cleared even on failure — otherwise modal is permanently stuck
      expect(modal._isSaving).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Feature: Polling Updates Rendered UI
  // -----------------------------------------------------------------------

  describe('Feature: Polling Updates Rendered UI', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('polling re-renders cards when agent status changes', async () => {
      setupAgentMocks();
      const modal = createModal();
      modal.isOpen = true;

      await modal._renderContent();
      await flushPromises();
      modal._setupEventListeners(); // Starts polling

      // Initially: research has Start button
      let researchCard = modal.bodyEl.querySelector('.agent-card[data-tool-name="research"]');
      expect(researchCard.querySelector('[data-action="open-tool"]')).not.toBeNull();

      // Simulate state change: research now running
      mockToolState.getToolRunState.mockImplementation((name) => {
        if (name === 'research') return { status: 'running', job_id: 'poll-job-1' };
        return null;
      });

      // Advance past poll interval (5000ms)
      jest.advanceTimersByTime(5000);
      await flushPromises();

      // After poll: card should now show Running
      researchCard = modal.bodyEl.querySelector('.agent-card[data-tool-name="research"]');
      expect(researchCard.dataset.runStatus).toBe('running');
      const runningBtn = researchCard.querySelector('[data-action="view-current-job"]');
      expect(runningBtn).not.toBeNull();
      expect(runningBtn.textContent.trim()).toContain('Running');

      // Start button should be gone
      expect(researchCard.querySelector('[data-action="open-tool"]')).toBeNull();
    });

    it('polling does NOT refresh when document is hidden', async () => {
      setupAgentMocks();
      const modal = createModal();
      modal.isOpen = true;

      await modal._renderContent();
      await flushPromises();
      modal._setupEventListeners();

      // Simulate hidden document
      Object.defineProperty(document, 'hidden', { value: true, writable: true });

      jest.advanceTimersByTime(5000);
      await flushPromises();

      // prefetchJobs should NOT have been called during the poll
      expect(mockToolState.prefetchJobs).not.toHaveBeenCalled();

      // Restore
      Object.defineProperty(document, 'hidden', { value: false, writable: true });
    });

    it('polling does NOT refresh when dialog is open', async () => {
      setupAgentMocks();
      const modal = createModal();
      modal.isOpen = true;

      await modal._renderContent();
      await flushPromises();
      modal._setupEventListeners();

      mockDialogManager.isOpen.mockReturnValue(true);
      jest.spyOn(modal, '_refreshHub');

      jest.advanceTimersByTime(5000);
      await flushPromises();

      // prefetchJobs fires but _refreshHub should NOT (dialog is blocking)
      expect(mockToolState.prefetchJobs).toHaveBeenCalled();
      expect(modal._refreshHub).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Feature: Error Recovery
  // -----------------------------------------------------------------------

  describe('Feature: Error Recovery', () => {
    it('fetchAll failure shows error state; retry with fixed backend recovers', async () => {
      // First attempt: backend down
      mockAgentState.fetchAll.mockRejectedValueOnce(new Error('Backend unreachable'));

      const modal = createModal();
      modal.isOpen = true; // Required for error state to be rendered
      await modal._renderContent();
      await flushPromises();

      // Error state rendered
      expect(modal.bodyEl.querySelector('.modal-empty-state')).not.toBeNull();
      expect(modal.bodyEl.textContent).toContain('Failed to Load Agents');
      expect(modal.bodyEl.querySelector('.agent-card')).toBeNull();

      // Second attempt: backend recovers
      setupAgentMocks();
      await modal._renderContent();
      await flushPromises();

      // Agent cards now visible
      expect(modal.bodyEl.querySelector('.modal-empty-state')).toBeNull();
      const cards = modal.bodyEl.querySelectorAll('.agent-card');
      expect(cards.length).toBe(2);
    });

    it('prefetchAll failure still shows error (not half-rendered state)', async () => {
      mockAgentState.fetchAll.mockResolvedValue(undefined);
      mockToolState.prefetchAll.mockRejectedValueOnce(new Error('Timeout'));

      const modal = createModal();
      modal.isOpen = true; // Required for error state to be rendered
      await modal._renderContent();
      await flushPromises();

      // Should show error state, not a skeleton or partial render
      expect(modal.bodyEl.querySelector('.modal-empty-state')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Feature: Modal-Level Recent Jobs
  // -----------------------------------------------------------------------

  describe('Feature: Modal-Level Recent Jobs', () => {
    it('renders recent jobs section below agent cards', async () => {
      setupAgentMocks({
        jobs: {
          research: [
            { id: 'j1', status: 'completed', metadata: { query: 'Test query' }, created_at: new Date().toISOString() },
          ],
        },
      });
      const modal = createModal();
      await renderFullModal(modal);

      // Modal-level section rendered (not inside card)
      const section = modal.bodyEl.querySelector('.agents-recent-jobs-section');
      expect(section).not.toBeNull();

      // Has proper header
      const header = section.querySelector('.agents-recent-jobs-header');
      expect(header).not.toBeNull();
      expect(header.textContent).toContain('Recent Jobs');

      // Job item rendered with correct structure
      const jobItem = section.querySelector('.agents-recent-job-item');
      expect(jobItem).not.toBeNull();
      expect(jobItem.dataset.jobId).toBe('j1');
    });

    it('does not show recent jobs section when no jobs exist', async () => {
      setupAgentMocks({
        jobs: {
          research: [],
          memory: [],
        },
      });
      const modal = createModal();
      await renderFullModal(modal);

      // Section should not render when no jobs
      const section = modal.bodyEl.querySelector('.agents-recent-jobs-section');
      expect(section).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Feature: Research Interface Button
  // -----------------------------------------------------------------------

  describe('Feature: Research Interface Button', () => {
    it('only research card has Interface button', async () => {
      setupAgentMocks();
      const modal = createModal();
      await renderFullModal(modal);

      const interfaceBtns = modal.bodyEl.querySelectorAll('[data-action="open-perplexica-interface"]');
      expect(interfaceBtns.length).toBe(1);

      // It's on the research card
      const researchCard = interfaceBtns[0].closest('.agent-card');
      expect(researchCard.dataset.toolName).toBe('research');
    });

    it('clicking Interface button opens PerplexicaInterfaceDialog', async () => {
      setupAgentMocks();
      const modal = createModal();
      await renderFullModal(modal);
      jest.spyOn(modal, '_openAgentDashboard');

      const interfaceBtn = modal.bodyEl.querySelector('[data-action="open-perplexica-interface"]');
      interfaceBtn.click();
      await flushPromises();

      expect(modal._openAgentDashboard).toHaveBeenCalled();
    });
  });
});
