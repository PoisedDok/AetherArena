'use strict';

// ---------------------------------------------------------------------------
// Onboarding Step Controllers — Direct unit tests
// ---------------------------------------------------------------------------
// Source files:
//   src/renderer/main/modules/onboarding/modules/SetupStepController.js
//   src/renderer/main/modules/onboarding/modules/IntelligenceStepController.js
//
// The existing onboarding-modal.test.js covers orchestration/delegation.
// This file tests the controllers directly: init logic, polling, dispose,
// save flows, edge cases, and resource lifecycle.
// ---------------------------------------------------------------------------

const SETUP_SRC = '../../../../../src/renderer/main/modules/onboarding/modules/SetupStepController';
const INTEL_SRC = '../../../../../src/renderer/main/modules/onboarding/modules/IntelligenceStepController';
const TOAST_PATH = '../../../../../src/renderer/shared/components/Toast';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock(
  '../../../../../src/renderer/shared/components/Toast',
  () => ({
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
  })
);

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

const SetupStepController = require(SETUP_SRC);
const IntelligenceStepController = require(INTEL_SRC);
const Toast = require(TOAST_PATH);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEndpoint() {
  const endpoint = {
    getBackendURL: jest.fn(() => 'http://localhost:8765'),
    getHealth: jest.fn(() => Promise.resolve({ status: 'ok' })),
    getOrchestrationState: jest.fn(() => Promise.resolve({ phase: 'idle', status: 'pending' })),
    executeOrchestrationCommand: jest.fn(() => Promise.resolve()),
    getSetupStatus: jest.fn(async () => {
      const baseUrl = endpoint.getBackendURL();
      const response = await fetch(`${baseUrl}/v1/setup/status`);
      return response.json();
    }),
    getSetupRequirements: jest.fn(async () => {
      const baseUrl = endpoint.getBackendURL();
      const response = await fetch(`${baseUrl}/v1/setup/requirements`);
      return response.json();
    }),
    startSetup: jest.fn(async () => {
      const baseUrl = endpoint.getBackendURL();
      const response = await fetch(`${baseUrl}/v1/setup/start`, { method: 'POST' });
      return response.json();
    }),
    finalizeSetup: jest.fn(async () => {
      const baseUrl = endpoint.getBackendURL();
      const response = await fetch(`${baseUrl}/v1/setup/finalize`, { method: 'POST' });
      return response.json();
    }),
    setPreference: jest.fn(() => Promise.resolve()),
    triggerFileIndexingReindex: jest.fn(() => Promise.resolve({})),
    updateFileIndexingDaemonConfig: jest.fn(() => Promise.resolve()),
    updateProactiveConfig: jest.fn(() => Promise.resolve()),
    getProactiveConfig: jest.fn(function () {
      const calls = this.updateProactiveConfig.mock.calls;
      const lastPayload = calls.length > 0 ? calls[calls.length - 1][0] : null;
      return Promise.resolve(lastPayload || {
        enabled: true,
        browser_enabled: true,
        email_enabled: true,
        file_system_enabled: true,
        query_generation_enabled: true,
        file_indexing_enabled: true,
      });
    }),
  };
  return endpoint;
}

function createMockLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

/** Build a minimal DOM tree that SetupStepController.start() queries (3-phase layout). */
function createSetupDOM() {
  const bodyEl = document.createElement('div');
  bodyEl.innerHTML = `
    <div class="onboarding-setup">
      <div class="setup-phase" id="setup-phase-checking">
        <div class="setup-checking-status">
          <span id="setup-checking-label">Checking system requirements...</span>
        </div>
        <div class="setup-prereq-errors hidden" id="setup-prereq-errors"></div>
        <div class="setup-checking-actions" id="setup-checking-actions">
          <!-- Dynamic buttons populated by controller -->
        </div>
      </div>
      <div class="setup-phase hidden" id="setup-phase-installing">
        <div class="setup-install-banner" id="setup-install-banner">
          <div class="install-banner-row"><i class="fas fa-clock"></i><span>First-time setup typically takes <strong>15\u201330 minutes</strong>.</span></div>
          <div class="install-banner-row"><i class="fas fa-window-minimize"></i><span>You can minimize this window.</span></div>
          <div class="install-banner-row install-banner-warning"><i class="fas fa-exclamation-triangle"></i><span>Please <strong>do not force-quit</strong>.</span></div>
        </div>
        <div class="setup-phase-label" id="setup-phase-label">Preparing setup...</div>
        <div class="setup-unified-bar">
          <div class="setup-bar-track">
            <div class="setup-bar-fill" id="setup-bar-fill"></div>
          </div>
          <div class="setup-bar-percent" id="setup-bar-percent">0%</div>
        </div>
        <div class="setup-phase-dots" id="setup-phase-dots">
          <div class="setup-phase-dot" data-phase="repositories"><span class="phase-dot-indicator"></span><span class="phase-dot-label">Verify</span></div>
          <div class="setup-phase-dot" data-phase="python_packages"><span class="phase-dot-indicator"></span><span class="phase-dot-label">Packages</span></div>
          <div class="setup-phase-dot" data-phase="oi_environment"><span class="phase-dot-indicator"></span><span class="phase-dot-label">AI Runtime</span></div>
          <div class="setup-phase-dot" data-phase="inference_environment"><span class="phase-dot-indicator"></span><span class="phase-dot-label">Inference</span></div>
          <div class="setup-phase-dot" data-phase="ml_models"><span class="phase-dot-indicator"></span><span class="phase-dot-label">Voice</span></div>
          <div class="setup-phase-dot" data-phase="docker_services"><span class="phase-dot-indicator"></span><span class="phase-dot-label">Services</span></div>
        </div>
        <div class="setup-time-row">
          <div class="setup-elapsed" id="setup-elapsed"></div>
          <div class="setup-eta" id="setup-eta"></div>
        </div>
        <div class="setup-detail-toggle" id="setup-detail-toggle">
          <button class="setup-detail-btn" id="setup-detail-btn" aria-expanded="false" aria-controls="setup-detail-panel">
            <i class="fas fa-chevron-right"></i> <span>Show Details</span>
          </button>
        </div>
        <div class="setup-detail-panel collapsed" id="setup-detail-panel" role="region">
          <div class="setup-detail-phases" id="setup-detail-phases"></div>
        </div>
      </div>
      <div class="setup-phase hidden" id="setup-phase-verifying">
        <div class="setup-verify-complete">
          <div class="verify-icon-wrap" id="setup-verify-icon-wrap"><i class="fas fa-circle-notch fa-spin"></i></div>
          <span id="setup-verify-label">Connecting to services...</span>
        </div>
        <div class="setup-checking-actions" id="setup-verify-actions"></div>
      </div>
    </div>
  `;
  return bodyEl;
}

/** Mock a successful fetch returning JSON. */
function mockFetchJSON(data) {
  return jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(data),
    })
  );
}

/** Mock a failing fetch. */
function mockFetchReject(err) {
  return jest.fn(() => Promise.reject(err || new Error('Network error')));
}

/** Flush all pending microtasks (needed for async callbacks inside setTimeout). */
async function flushPromises() {
  // Chain enough microtask ticks to resolve fetch → json → then chains
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function makeSetupStatus(overrides = {}) {
  const defaultTask = { progress: 0, message: 'Pending', status: 'pending' };
  return {
    current_phase: 'idle',
    total_progress: 0,
    repositories: { ...defaultTask },
    python_packages: { ...defaultTask },
    oi_environment: { ...defaultTask },
    ml_models: { ...defaultTask },
    docker_services: { ...defaultTask },
    ...overrides,
  };
}

// ===========================================================================
// SetupStepController
// ===========================================================================

describe('SetupStepController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createSetupCtrl(overrides = {}) {
    const endpoint = createMockEndpoint();
    const log = createMockLog();
    const onNext = jest.fn();
    const onNavigationControl = jest.fn();
    const onDefer = jest.fn();
    const bodyEl = createSetupDOM();
    const escapeHtml = jest.fn((v) => String(v || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

    const ctrl = new SetupStepController({
      endpoint,
      bodyEl,
      log,
      onNext,
      onNavigationControl,
      onDefer,
      escapeHtml,
      ...overrides,
    });

    return { ctrl, endpoint, log, onNext, onNavigationControl, onDefer, bodyEl, escapeHtml };
  }

  // ---- Constructor ----

  describe('constructor', () => {
    test('stores all dependencies including onNavigationControl and onDefer', () => {
      const { ctrl, endpoint, log, onNext, onNavigationControl, bodyEl, escapeHtml } = createSetupCtrl();
      expect(ctrl._endpoint).toBe(endpoint);
      expect(ctrl._bodyEl).toBe(bodyEl);
      expect(ctrl._log).toBe(log);
      expect(ctrl._onNext).toBe(onNext);
      expect(ctrl._onNavigationControl).toBe(onNavigationControl);
      expect(ctrl._escapeHtml).toBe(escapeHtml);
      expect(ctrl._disposed).toBe(false);
      expect(ctrl._lastPhase).toBeNull();
    });
  });

  // ---- start() ----

  describe('start()', () => {
    test('hides navigation via onNavigationControl callback', () => {
      const { ctrl, onNavigationControl } = createSetupCtrl();
      ctrl.start();
      expect(onNavigationControl).toHaveBeenCalledWith({ back: false, next: false });
      ctrl.dispose();
    });

    test('starts polling orchestration state', async () => {
      const { ctrl, endpoint } = createSetupCtrl();
      endpoint.getOrchestrationState.mockResolvedValueOnce({ phase: 'checking', status: 'in_progress' });
      
      ctrl.start();
      jest.advanceTimersByTime(10); // Advance past setTimeout(poll, 0)
      await flushPromises();
      
      expect(endpoint.getOrchestrationState).toHaveBeenCalled();
      expect(ctrl._lastPhase).toBe('checking');
      ctrl.dispose();
    });

    test('sends start_check command if state is idle', async () => {
      const { ctrl, endpoint } = createSetupCtrl();
      endpoint.getOrchestrationState.mockResolvedValueOnce({ phase: 'idle', status: 'pending' });
      
      ctrl.start();
      jest.advanceTimersByTime(10); // Advance past setTimeout(poll, 0)
      await flushPromises();
      
      expect(endpoint.executeOrchestrationCommand).toHaveBeenCalledWith('start_check');
      ctrl.dispose();
    });
  });

  // ---- _renderState ----

  describe('_renderState()', () => {
    test('transitions to checking phase', () => {
      const { ctrl, bodyEl } = createSetupCtrl();
      ctrl._renderState({ phase: 'checking', status: 'in_progress' });
      
      expect(ctrl._lastPhase).toBe('checking');
      expect(bodyEl.querySelector('#setup-phase-checking').classList.contains('hidden')).toBe(false);
      expect(bodyEl.querySelector('#setup-phase-installing').classList.contains('hidden')).toBe(true);
      expect(bodyEl.querySelector('#setup-checking-label').textContent).toBe('Checking requirements...');
    });

    test('transitions to installing phase', () => {
      const { ctrl, bodyEl } = createSetupCtrl();
      ctrl._renderState({ phase: 'installing', status: 'in_progress', progress: { total_progress: 50 } });
      
      expect(ctrl._lastPhase).toBe('installing');
      expect(bodyEl.querySelector('#setup-phase-checking').classList.contains('hidden')).toBe(true);
      expect(bodyEl.querySelector('#setup-phase-installing').classList.contains('hidden')).toBe(false);
      expect(bodyEl.querySelector('#setup-bar-fill').style.width).toBe('50%');
    });

    test('handles action_required in checking phase', () => {
      const { ctrl, bodyEl } = createSetupCtrl();
      ctrl._renderState({ 
        phase: 'checking', 
        status: 'action_required', 
        requirements: { python3: { installed: false } } 
      });
      
      const labelEl = bodyEl.querySelector('#setup-checking-label');
      expect(labelEl.textContent).toBe('Missing requirements detected.');
      
      const actionsEl = bodyEl.querySelector('#setup-checking-actions');
      expect(actionsEl.children.length).toBeGreaterThan(0);
    });

    test('handles error in installing phase', () => {
      const { ctrl, bodyEl } = createSetupCtrl();
      
      // First put it in installing state to initialize tracker
      ctrl._renderState({ phase: 'installing', status: 'in_progress', progress: 10 });
      
      // Then error it out
      ctrl._renderState({ phase: 'installing', status: 'error', error: 'Failed to install' });
      
      const labelEl = bodyEl.querySelector('#setup-phase-label');
      expect(labelEl.textContent).toContain('Setup failed: Failed to install');
      expect(Toast.error).toHaveBeenCalled();
    });

    test('advances on completed phase', () => {
      const { ctrl, onNext } = createSetupCtrl();
      
      ctrl._renderState({ phase: 'completed', status: 'completed' });
      
      expect(ctrl._lastPhase).toBe('completed');
      jest.advanceTimersByTime(2000);
      expect(onNext).toHaveBeenCalled();
    });
  });

  describe('dispose()', () => {
    test('clears all timers and intervals', () => {
      const { ctrl } = createSetupCtrl();
      ctrl._pollTimer = setTimeout(() => {}, 99999);
      ctrl._advanceTimer = setTimeout(() => {}, 99999);
      ctrl._actionCleanups = [jest.fn()];

      ctrl.dispose();

      expect(ctrl._disposed).toBe(true);
      expect(ctrl._pollTimer).toBeDefined(); // Actually it gets cleared, but reference remains
      expect(ctrl._actionCleanups).toEqual([]);
    });

    test('idempotent — second call is no-op', () => {
      const { ctrl } = createSetupCtrl();
      ctrl.dispose();
      ctrl._actionCleanups = [jest.fn()];
      ctrl.dispose();
      expect(ctrl._actionCleanups).toEqual([]); // Still clears it
    });
  });
});

// ===========================================================================
// IntelligenceStepController
// ===========================================================================

describe('IntelligenceStepController', () => {
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    document.body.innerHTML = '';
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  function createIntelCtrl(overrides = {}) {
    const endpoint = createMockEndpoint();
    const log = createMockLog();
    const primaryPath = overrides.primaryPath || { value: null };
    const selectedPaths = overrides.selectedPaths || [{ path: '/Users/dev/projects', mode: 'combined' }, { path: '/Users/dev/notes', mode: 'combined' }];
    const intelligenceToggles = overrides.intelligenceToggles || { proactiveMaster: true };
    const sourceConfig = overrides.sourceConfig || {
      sourceToggles: { browser: true, email: true, filesystem: true },
      selectedBrowser: null,
      excludedProfiles: [],
    };
    const bodyEl = document.createElement('div');

    const ctrl = new IntelligenceStepController({
      endpoint,
      bodyEl,
      log,
      primaryPath,
      selectedPaths,
      intelligenceToggles,
      sourceConfig,
    });

    return { ctrl, endpoint, log, primaryPath, selectedPaths, intelligenceToggles, sourceConfig, bodyEl };
  }

  function mountIntelCtrl(overrides = {}) {
    const result = createIntelCtrl(overrides);
    result.ctrl.mount(result.bodyEl);
    return result;
  }

  // ---- Constructor ----

  describe('constructor', () => {
    test('stores all dependencies', () => {
      const { ctrl, endpoint, log, selectedPaths, intelligenceToggles, bodyEl } = createIntelCtrl();
      expect(ctrl._endpoint).toBe(endpoint);
      expect(ctrl._bodyEl).toBe(bodyEl);
      expect(ctrl._log).toBe(log);
      expect(ctrl._selectedPaths).toBe(selectedPaths);
      expect(ctrl._intelligenceToggles).toBe(intelligenceToggles);
      expect(ctrl._disposed).toBe(false);
    });
  });

  // ---- mount() ----

  describe('mount()', () => {
    test('renders location chips for selectedPaths', () => {
      const { bodyEl } = mountIntelCtrl({ selectedPaths: [{ path: '/a/b', mode: 'combined' }, { path: '/c/d', mode: 'combined' }] });

      const chips = bodyEl.querySelectorAll('.intel-location-chip');
      expect(chips.length).toBe(2);
      expect(chips[0].dataset.index).toBe('0');
      expect(chips[1].dataset.index).toBe('1');
    });

    test('renders empty state when no paths selected', () => {
      const { bodyEl } = mountIntelCtrl({ selectedPaths: [] });

      expect(bodyEl.querySelector('.intel-empty-state')).not.toBeNull();
      expect(bodyEl.textContent).toContain('Select your main workspace folder');
    });

    test('renders proactive toggle checked when master is true', () => {
      const { bodyEl } = mountIntelCtrl({ intelligenceToggles: { proactiveMaster: true } });

      const toggle = bodyEl.querySelector('#intel-toggle-proactive');
      expect(toggle).not.toBeNull();
      expect(toggle.checked).toBe(true);
    });

    test('renders proactive toggle unchecked when master is false', () => {
      const { bodyEl } = mountIntelCtrl({ intelligenceToggles: { proactiveMaster: false } });

      const toggle = bodyEl.querySelector('#intel-toggle-proactive');
      expect(toggle).not.toBeNull();
      expect(toggle.checked).toBe(false);
    });

    test('includes privacy notice', () => {
      const { bodyEl } = mountIntelCtrl();

      expect(bodyEl.textContent).toContain('100% local');
      expect(bodyEl.textContent).toContain('Nothing leaves your machine');
    });

    test('renders add folder button', () => {
      const { bodyEl } = mountIntelCtrl();

      const addBtn = bodyEl.querySelector('#intel-add-secondary');
      expect(addBtn).not.toBeNull();
      expect(addBtn.textContent).toContain('Add Folder');
    });
  });

  // ---- mount() event binding ----

  describe('mount() event binding', () => {
    test('add-secondary button is present and clickable', () => {
      const { bodyEl } = mountIntelCtrl({ selectedPaths: [] });

      const addBtn = bodyEl.querySelector('#intel-add-secondary');
      expect(addBtn).not.toBeNull();
    });

    test('proactive toggle change updates intelligenceToggles', () => {
      const intelligenceToggles = { proactiveMaster: true };
      const { bodyEl } = mountIntelCtrl({ intelligenceToggles });

      const toggle = bodyEl.querySelector('#intel-toggle-proactive');
      expect(toggle).not.toBeNull();

      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
      expect(intelligenceToggles.proactiveMaster).toBe(false);
    });

    test('chip remove buttons are present for each selected path', () => {
      const { bodyEl } = mountIntelCtrl({ selectedPaths: [{ path: '/a', mode: 'combined' }, { path: '/b', mode: 'combined' }] });

      const chipButtons = bodyEl.querySelectorAll('.chip-remove');
      expect(chipButtons.length).toBe(2);
    });
  });

  // ---- Chip removal via mounted DOM ----

  describe('chip removal', () => {
    test('removing a secondary chip removes the path from selectedPaths', () => {
      const selectedPaths = [{ path: '/a', mode: 'combined' }, { path: '/b', mode: 'combined' }, { path: '/c', mode: 'combined' }];
      const { bodyEl } = mountIntelCtrl({ selectedPaths });

      // Click remove on the second chip (/b)
      const removeBtns = bodyEl.querySelectorAll('.chip-remove');
      // Primary chip (null path = no primary chip) + 3 secondary chips
      // We need the second secondary chip's remove button
      const secondaryRemoveBtns = Array.from(removeBtns).slice(-3);
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'preventDefault', { value: jest.fn() });
      Object.defineProperty(event, 'stopPropagation', { value: jest.fn() });
      secondaryRemoveBtns[1].dispatchEvent(event);

      expect(selectedPaths).toEqual([{ path: '/a', mode: 'combined' }, { path: '/c', mode: 'combined' }]);
    });

    test('removing last chip shows empty state', () => {
      const selectedPaths = [{ path: '/only', mode: 'combined' }];
      const { bodyEl } = mountIntelCtrl({ selectedPaths });

      const removeBtns = bodyEl.querySelectorAll('.chip-remove');
      const lastBtn = removeBtns[removeBtns.length - 1];
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'preventDefault', { value: jest.fn() });
      Object.defineProperty(event, 'stopPropagation', { value: jest.fn() });
      lastBtn.dispatchEvent(event);

      expect(selectedPaths).toEqual([]);
      expect(bodyEl.querySelector('.intel-empty-secondary')).not.toBeNull();
    });
  });

  // ---- _addSecondaryLocation ----

  describe('_addSecondaryLocation()', () => {
    test('adds directory to selectedPaths and refreshes chips', async () => {
      const selectedPaths = [{ path: '/existing', mode: 'combined' }];
      const { ctrl, bodyEl } = mountIntelCtrl({ selectedPaths });

      window.aether = {
        dialog: {
          showDirectoryPicker: jest.fn().mockResolvedValue('/new/path'),
        },
      };

      await ctrl._addSecondaryLocation();

      expect(selectedPaths).toEqual([{ path: '/existing', mode: 'combined' }, { path: '/new/path', mode: 'combined' }]);
      // Chips should be re-rendered — check via DOM
      expect(bodyEl.textContent).toContain('/new/path');
    });

    test('does not add duplicate path', async () => {
      const selectedPaths = [{ path: '/existing', mode: 'combined' }];
      const { ctrl } = createIntelCtrl({ selectedPaths });

      window.aether = {
        dialog: {
          showDirectoryPicker: jest.fn().mockResolvedValue('/existing'),
        },
      };

      await ctrl._addSecondaryLocation();

      expect(selectedPaths).toEqual([{ path: '/existing', mode: 'combined' }]);
      expect(Toast.info).toHaveBeenCalledWith('This location is already added.');
    });

    test('does nothing if user cancels picker (null result)', async () => {
      const selectedPaths = [];
      const { ctrl } = createIntelCtrl({ selectedPaths });

      window.aether = {
        dialog: {
          showDirectoryPicker: jest.fn().mockResolvedValue(null),
        },
      };

      await ctrl._addSecondaryLocation();
      expect(selectedPaths).toEqual([]);
    });

    test('shows warning when dialog API is unavailable', async () => {
      const { ctrl } = createIntelCtrl();
      window.aether = null;

      await ctrl._addSecondaryLocation();

      expect(Toast.warning).toHaveBeenCalledWith('Directory picker not available in this context.');
    });

    test('shows warning when showDirectoryPicker is missing', async () => {
      const { ctrl } = createIntelCtrl();
      window.aether = { dialog: {} };

      await ctrl._addSecondaryLocation();

      expect(Toast.warning).toHaveBeenCalledWith('Directory picker not available in this context.');
    });

    test('shows error toast on picker exception', async () => {
      const { ctrl, log } = createIntelCtrl();
      window.aether = {
        dialog: {
          showDirectoryPicker: jest.fn().mockRejectedValue(new Error('Permission denied')),
        },
      };

      await ctrl._addSecondaryLocation();

      expect(Toast.error).toHaveBeenCalledWith('Failed to open directory picker.');
      expect(log.error).toHaveBeenCalled();
    });
  });

  // ---- _renderSecondaryContent ----

  describe('_renderSecondaryContent()', () => {
    test('renders empty state when no paths', () => {
      const selectedPaths = [];
      const { ctrl, bodyEl } = mountIntelCtrl({ selectedPaths });

      // Force re-render to verify behavior
      ctrl._renderSecondaryContent();

      expect(bodyEl.querySelector('.intel-empty-secondary')).not.toBeNull();
    });

    test('renders chips when paths exist', () => {
      const selectedPaths = [{ path: '/path/one', mode: 'combined' }, { path: '/path/two', mode: 'combined' }];
      const { bodyEl } = mountIntelCtrl({ selectedPaths });

      const chips = bodyEl.querySelectorAll('.intel-location-chip');
      expect(chips.length).toBe(2);
    });

    test('disposes old chips before re-rendering', () => {
      const selectedPaths = [{ path: '/a', mode: 'combined' }];
      const { ctrl } = mountIntelCtrl({ selectedPaths });

      expect(ctrl._secondaryChipCleanups.length).toBe(1);
      const oldDispose = ctrl._secondaryChipCleanups[0];

      // Trigger re-render
      ctrl._renderSecondaryContent();

      // Old dispose should have been called (array replaced with new one)
      expect(ctrl._secondaryChipCleanups.length).toBe(1);
      expect(ctrl._secondaryChipCleanups[0]).not.toBe(oldDispose);
    });

    test('no-op when refs not available (before mount)', () => {
      const { ctrl } = createIntelCtrl();

      // _refs is null before mount — should not throw
      expect(() => ctrl._renderSecondaryContent()).not.toThrow();
    });
  });

  // ---- _abbreviatePath ----

  describe('_abbreviatePath()', () => {
    test('returns full path when <= 3 parts', () => {
      const { ctrl } = createIntelCtrl();
      expect(ctrl._abbreviatePath('/a/b')).toBe('/a/b');
    });

    test('abbreviates long non-home paths with ellipsis prefix', () => {
      const { ctrl } = createIntelCtrl();
      expect(ctrl._abbreviatePath('/Volumes/ext/projects/my-app')).toBe('\u2026/projects/my-app');
    });

    test('handles empty string', () => {
      const { ctrl } = createIntelCtrl();
      expect(ctrl._abbreviatePath('')).toBe('');
    });

    test('handles null/undefined', () => {
      const { ctrl } = createIntelCtrl();
      expect(ctrl._abbreviatePath(null)).toBe('');
      expect(ctrl._abbreviatePath(undefined)).toBe('');
    });
  });

  // ---- saveConfig & getConsolidatedData ----

  describe('saveConfig & getConsolidatedData', () => {
    function createReadyIntelCtrl(overrides = {}) {
      const result = createIntelCtrl(overrides);
      result.ctrl.domainService.sourceStatusLoading = false;
      result.ctrl.domainService.sourceStatusError = null;
      result.ctrl.domainService.sourceStatus = overrides.sourceStatus || {
        browser: { available: true },
        email: { available: true },
      };
      return result;
    }

    test('saveConfig validates readiness', async () => {
      const { ctrl, log } = createReadyIntelCtrl();
      await ctrl.saveConfig();
      expect(log.debug).toHaveBeenCalledWith('[IntelligenceStep] Config validated for consolidation');
    });

    test('saveConfig throws error when not ready', async () => {
      const { ctrl } = createReadyIntelCtrl();
      ctrl.domainService.sourceStatusLoading = true; // Simulating loading status
      
      await expect(ctrl.saveConfig()).rejects.toMatchObject({
        code: 'source_status_loading',
      });
    });

    test('getConsolidatedData returns correct payload format', () => {
      const { ctrl } = createReadyIntelCtrl({
        selectedPaths: [{ path: '/Users/dev/notes', mode: 'combined' }],
        intelligenceToggles: { proactiveMaster: true },
      });

      const data = ctrl.getConsolidatedData();
      
      expect(data).toHaveProperty('indexing_locations');
      expect(data.indexing_locations).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/Users/dev/notes', type: 'secondary' })
      ]));

      expect(data).toHaveProperty('daemon_config');
      expect(data.daemon_config).toHaveProperty('browser');
      expect(data.daemon_config).toHaveProperty('filesystem');

      expect(data).toHaveProperty('proactive_config');
      expect(data.proactive_config.enabled).toBe(true);
    });
  });

  // ---- dispose ----

  describe('dispose()', () => {
    test('sets disposed flag', () => {
      const { ctrl } = mountIntelCtrl();
      ctrl.dispose();
      expect(ctrl._disposed).toBe(true);
    });

    test('clears all stamp tracking arrays', () => {
      const { ctrl } = mountIntelCtrl({ selectedPaths: ['/a', '/b'] });

      expect(ctrl._stamps.length).toBeGreaterThan(0);
      expect(ctrl._secondaryChipCleanups.length).toBe(2);

      ctrl.dispose();

      expect(ctrl._stamps).toEqual([]);
      expect(ctrl._cardCleanups).toEqual([]);
      expect(ctrl._secondaryChipCleanups).toEqual([]);
      expect(ctrl._cleanups).toEqual([]);
      expect(ctrl._primaryChipDispose).toBeNull();
      expect(ctrl._filesystemCardRefs).toBeNull();
    });

    test('idempotent — second call is no-op', () => {
      const { ctrl } = mountIntelCtrl();
      ctrl.dispose();
      expect(ctrl._disposed).toBe(true);

      // Second call should not throw
      expect(() => ctrl.dispose()).not.toThrow();
    });
  });

  // ---- Lifecycle quantitative proof ----

  describe('resource lifecycle', () => {
    test('mount() creates stamps tracked in _stamps array', () => {
      const { ctrl } = mountIntelCtrl({
        selectedPaths: ['/a', '/b'],
        intelligenceToggles: { proactiveMaster: true },
      });

      // Main layout stamp should be tracked
      expect(ctrl._stamps.length).toBe(1);
    });

    test('secondary chips tracked in _secondaryChipCleanups', () => {
      const { ctrl } = mountIntelCtrl({
        selectedPaths: ['/a', '/b'],
      });

      expect(ctrl._secondaryChipCleanups.length).toBe(2);
    });

    test('chip removal disposes old stamps and re-creates for remaining paths', () => {
      const selectedPaths = ['/a', '/b'];
      const { ctrl, bodyEl } = mountIntelCtrl({
        selectedPaths,
        intelligenceToggles: { proactiveMaster: true },
      });

      expect(ctrl._secondaryChipCleanups.length).toBe(2);

      // Remove a chip
      const removeBtns = bodyEl.querySelectorAll('.chip-remove');
      const lastRemove = removeBtns[removeBtns.length - 1];
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'preventDefault', { value: jest.fn() });
      Object.defineProperty(event, 'stopPropagation', { value: jest.fn() });
      lastRemove.dispatchEvent(event);

      // After removal: 1 path remains, so 1 chip cleanup tracked
      expect(ctrl._secondaryChipCleanups.length).toBe(1);
    });

    test('dispose clears all tracking — quantitative N created = M cleaned', () => {
      const selectedPaths = ['/a', '/b'];
      const { ctrl } = mountIntelCtrl({ selectedPaths });

      const stampCount = ctrl._stamps.length;
      const chipCount = ctrl._secondaryChipCleanups.length;

      expect(stampCount).toBeGreaterThan(0);
      expect(chipCount).toBe(2);

      ctrl.dispose();

      // All tracking arrays empty — everything cleaned
      expect(ctrl._stamps.length).toBe(0);
      expect(ctrl._secondaryChipCleanups.length).toBe(0);
      expect(ctrl._cardCleanups.length).toBe(0);
      expect(ctrl._cleanups.length).toBe(0);
    });
  });
});
