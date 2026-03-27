'use strict';

// ---------------------------------------------------------------------------
// OnboardingModal.js — Characterization tests (post-consolidation)
// ---------------------------------------------------------------------------
// Source: src/renderer/main/modules/onboarding/OnboardingModal.js
// 5-step flow: Welcome, License, Setup, Knowledge, Complete.
// BaseModal mocked to isolate OnboardingModal logic.
// ---------------------------------------------------------------------------

const SRC = '../../../../../src/renderer/main/modules/onboarding/OnboardingModal';
const BASE_MODAL_PATH = '../../../../../src/renderer/shared/modals/BaseModal';
const TOAST_PATH = '../../../../../src/renderer/shared/components/Toast';
const LOGGER_PATH = '../../../../../src/renderer/shared/utils/logger';

// ---------------------------------------------------------------------------
// Mocks — isolate from BaseModal DOM, Toast, logger, fetch
// ---------------------------------------------------------------------------

jest.mock(
  '../../../../../src/renderer/shared/modals/BaseModal',
  () => {
    return class MockBaseModal {
      constructor(options = {}) {
        this.title = options.title || 'Modal';
        this.id = options.id || 'mock-modal';
        this.size = options.size || 'xl';
        this.heightPreset = options.heightPreset || 'default';
        this.showFooter = options.showFooter || false;
        this.closable = options.closable !== undefined ? options.closable : true;
        this.isOpen = false;

        // Placeholders — populated by _initMockDOM before _renderContent
        this.overlay = null;
        this.panel = null;
        this.headerEl = null;
        this.bodyEl = null;
        this.footerEl = null;
        this.closeButton = null;
      }

      /** Create real DOM elements. Called before open() in tests. */
      _initMockDOM() {
        if (this.bodyEl) return; // Already initialised
        const doc = global.document;
        this.overlay = doc.createElement('div');
        this.panel = doc.createElement('div');
        this.headerEl = doc.createElement('div');
        this.bodyEl = doc.createElement('div');
        this.footerEl = doc.createElement('div');
        this.closeButton = doc.createElement('button');
      }

      async open() {
        this._initMockDOM();
        this.isOpen = true;
        await this._renderContent();
        if (this._setupEventListeners) this._setupEventListeners();
      }

      close() {
        this.isOpen = false;
        if (this._cleanup) this._cleanup();
      }

      destroy() {
        this.close();
      }
    };
  }
);

jest.mock(
  '../../../../../src/renderer/shared/components/Toast',
  () => ({
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
  })
);

jest.mock(
  '../../../../../src/renderer/shared/utils/logger',
  () => ({
    createRendererLogger: jest.fn(() => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  })
);

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

const OnboardingModal = require(SRC);
const Toast = require(TOAST_PATH);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEndpoint() {
  const legalAcceptance = {
    accepted: true,
    terms_version: '2026-02-17',
    terms_hash: '4fae27d8a2be5438cf2a70c549cab2df8f22ec3ddcfcf278c99244724b2b47a3',
  };
  const endpoint = {
    getBackendURL: jest.fn(() => 'http://localhost:8765'),
    getHealth: jest.fn(),
    getSetupRequirements: jest.fn(() => Promise.resolve({
      python3: { installed: true },
      docker_daemon: { installed: true, running: true },
      venv_oi: { complete: true },
      venv_inference: { complete: true },
      docker_images: { complete: true },
    })),
    setPreference: jest.fn(() => Promise.resolve()),
    getPreference: jest.fn((key) => {
      if (key === 'onboarding_complete') return Promise.resolve(true);
      if (key === 'legal_acceptance_latest') return Promise.resolve(legalAcceptance);
      return Promise.resolve(null);
    }),
    recordLegalAcceptance: jest.fn(() => Promise.resolve({
      accepted: true,
      ...legalAcceptance,
    })),
    getLatestLegalAcceptance: jest.fn(() => Promise.resolve({
      accepted: true,
      ...legalAcceptance,
    })),
    getSetupStatus: jest.fn(),
    startSetup: jest.fn(() => Promise.resolve({ message: 'Setup engine initiated' })),
    finalizeSetup: jest.fn(() => Promise.resolve({ status: 'ok', message: 'Backend fully operational' })),
    completeOnboarding: jest.fn(() => Promise.resolve({ status: 'ok' })),
    createFileIndexingLocation: jest.fn(() => Promise.resolve()),
    updateFileIndexingDaemonConfig: jest.fn(() => Promise.resolve()),
    updateProactiveConfig: jest.fn(() => Promise.resolve()),
    getProactiveConfig: jest.fn(() => {
      const calls = endpoint.updateProactiveConfig.mock.calls;
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

function createMockEventBus() {
  return {
    emit: jest.fn(),
    on: jest.fn(() => jest.fn()),
    off: jest.fn(),
  };
}

function createModal(overrides = {}) {
  const endpoint = createMockEndpoint();
  const eventBus = createMockEventBus();
  const onComplete = jest.fn();

  const modal = new OnboardingModal({
    endpoint,
    eventBus,
    onComplete,
    ...overrides,
  });

  return { modal, endpoint, eventBus, onComplete };
}

/**
 * Simulate BaseModal.open() flow: _renderContent + _setupEventListeners.
 */
async function openModal(modal) {
  await modal.open();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('OnboardingModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    document.body.innerHTML = '';

    // rAF polyfill for fake timers
    global.requestAnimationFrame = window.requestAnimationFrame = (cb) => setTimeout(cb, 0);

    // Reset localStorage
    localStorage.clear();

    // Reset global fetch
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      })
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('passes correct options to BaseModal super()', () => {
      const { modal } = createModal();
      expect(modal.title).toBe('Welcome to AetherArena');
      expect(modal.id).toBe('onboarding-modal');
      expect(modal.size).toBe('lg');
      expect(modal.heightPreset).toBe('default');
      expect(modal.showFooter).toBe(true);
    });

    it('sets closable to false (non-dismissible during onboarding)', () => {
      const { modal } = createModal();
      expect(modal.closable).toBe(false);
    });

    it('stores injected dependencies', () => {
      const { modal, endpoint, eventBus, onComplete } = createModal();
      expect(modal.endpoint).toBe(endpoint);
      expect(modal.eventBus).toBe(eventBus);
      expect(modal.onComplete).toBe(onComplete);
    });

    it('initializes 5 onboarding steps', () => {
      const { modal } = createModal();
      expect(modal.steps).toHaveLength(5);
    });

    it('defines steps with correct IDs in order', () => {
      const { modal } = createModal();
      const ids = modal.steps.map(s => s.id);
      expect(ids).toEqual([
        'welcome', 'license', 'setup', 'knowledge', 'complete',
      ]);
    });

    it('each step has id, title, subtitle', () => {
      const { modal } = createModal();
      for (const step of modal.steps) {
        expect(step).toHaveProperty('id');
        expect(step).toHaveProperty('title');
        expect(step).toHaveProperty('subtitle');
        expect(typeof step.id).toBe('string');
        expect(typeof step.title).toBe('string');
        expect(typeof step.subtitle).toBe('string');
      }
    });

    it('starts at step 0', () => {
      const { modal } = createModal();
      expect(modal.currentStep).toBe(0);
    });

    it('initializes empty tracking arrays', () => {
      const { modal } = createModal();
      expect(modal._listeners).toEqual([]);
      expect(modal._timers).toEqual([]);
      expect(modal._selectedPaths).toEqual([]);
    });

    it('initializes intelligence toggles with proactiveMaster=true', () => {
      const { modal } = createModal();
      expect(modal._intelligenceToggles).toEqual({ proactiveMaster: true });
    });

    it('initializes _sourceConfig with default source toggles', () => {
      const { modal } = createModal();
      expect(modal._sourceConfig).toEqual({
        sourceToggles: { browser: true, email: true, filesystem: true },
        selectedBrowser: null,
        excludedProfiles: [],
      });
    });

    it('sets _hasRenderedFirstStep to false', () => {
      const { modal } = createModal();
      expect(modal._hasRenderedFirstStep).toBe(false);
    });

    it('sets _isSetupActive to false', () => {
      const { modal } = createModal();
      expect(modal._isSetupActive).toBe(false);
    });

    it('sets _isSaving to false', () => {
      const { modal } = createModal();
      expect(modal._isSaving).toBe(false);
    });

    it('sets _disposed to false', () => {
      const { modal } = createModal();
      expect(modal._disposed).toBe(false);
    });
  });

  // =========================================================================
  // _renderContent
  // =========================================================================

  describe('_renderContent', () => {
    it('creates stepper dots for all 5 steps', async () => {
      const { modal } = createModal();
      await openModal(modal);

      const dots = modal.bodyEl.querySelectorAll('.stepper-dot');
      expect(dots.length).toBe(5);
    });

    it('creates stepper connectors between dots', async () => {
      const { modal } = createModal();
      await openModal(modal);

      const connectors = modal.bodyEl.querySelectorAll('.stepper-connector');
      expect(connectors.length).toBe(4); // 5 steps → 4 connectors
    });

    it('creates step content container', async () => {
      const { modal } = createModal();
      await openModal(modal);

      expect(modal._stepContentEl).not.toBeNull();
      expect(modal._stepContentEl.id).toBe('onboarding-step-content');
    });

    it('creates footer with next and back buttons', async () => {
      const { modal } = createModal();
      await openModal(modal);

      expect(modal._nextBtn).not.toBeNull();
      expect(modal._backBtn).not.toBeNull();
      expect(modal._nextBtn.id).toBe('onboarding-next');
      expect(modal._backBtn.id).toBe('onboarding-back');
    });

    it('creates status message element', async () => {
      const { modal } = createModal();
      await openModal(modal);

      expect(modal._statusMsgEl).not.toBeNull();
      expect(modal._statusMsgEl.id).toBe('onboarding-status-msg');
    });

    it('hides base modal header', async () => {
      const { modal } = createModal();
      await openModal(modal);

      expect(modal.headerEl.classList.contains('hidden')).toBe(true);
    });

    it('adds onboarding-panel class to panel', async () => {
      const { modal } = createModal();
      await openModal(modal);

      expect(modal.panel.classList.contains('onboarding-panel')).toBe(true);
    });

    it('creates stepper dots container', async () => {
      const { modal } = createModal();
      await openModal(modal);

      const dots = modal.bodyEl.querySelector('#stepper-dots');
      expect(dots).not.toBeNull();
      // Dots container has stepper dots + connectors for all 5 steps
      expect(dots.querySelectorAll('.stepper-dot').length).toBe(5);
    });
  });

  // =========================================================================
  // _setupEventListeners
  // =========================================================================

  describe('_setupEventListeners', () => {
    it('tracks 2 listeners (next + back buttons)', async () => {
      const { modal } = createModal();
      await openModal(modal);

      expect(modal._listeners.length).toBe(2);
      expect(modal._listeners[0].type).toBe('click');
      expect(modal._listeners[1].type).toBe('click');
    });
  });

  // =========================================================================
  // Navigation: nextStep / prevStep
  // =========================================================================

  describe('nextStep', () => {
    it('increments currentStep and renders next step', async () => {
      const { modal } = createModal();
      await openModal(modal);

      expect(modal.currentStep).toBe(0);
      await modal.nextStep();
      jest.advanceTimersByTime(200);
      expect(modal.currentStep).toBe(1);
    });

    it('advances through welcome to license', async () => {
      const { modal } = createModal();
      await openModal(modal);

      await modal.nextStep();
      jest.advanceTimersByTime(250); // wait out the _isTransitioning debounce
      expect(modal.currentStep).toBe(1); // license

      // License requires checkbox
      const checkbox = modal.bodyEl.querySelector('#accept-terms')
        || modal._stepContentEl.querySelector('#accept-terms');
      if (checkbox) checkbox.checked = true;

      await modal.nextStep();
      jest.advanceTimersByTime(250);
      expect(modal.currentStep).toBe(2); // setup
    });

    it('blocks on license step if checkbox not checked', async () => {
      const { modal } = createModal();
      await openModal(modal);

      // Navigate to license
      modal.currentStep = 1;
      modal._renderStep();
      jest.advanceTimersByTime(250);

      // Try to advance without checking checkbox
      await modal.nextStep();
      jest.advanceTimersByTime(250);

      expect(modal.currentStep).toBe(1); // Still on license
      expect(Toast.warning).toHaveBeenCalledWith(
        'Please accept the license terms to continue.'
      );
    });

    it('allows license step with checkbox checked', async () => {
      const { modal } = createModal();
      await openModal(modal);

      // Navigate to license
      modal.currentStep = 1;
      modal._renderStep();
      jest.advanceTimersByTime(250);

      // Check the checkbox
      const checkbox = modal.bodyEl.querySelector('#accept-terms');
      if (checkbox) checkbox.checked = true;

      await modal.nextStep();
      jest.advanceTimersByTime(250);

      expect(modal.currentStep).toBe(2);
    });

    it('blocks when _isSetupActive is true', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._isSetupActive = true;
      modal.currentStep = 0;

      await modal.nextStep();
      jest.advanceTimersByTime(200);

      expect(modal.currentStep).toBe(0); // Did not advance
    });

    it('calls finish() on last step', async () => {
      const { modal } = createModal();
      await openModal(modal);

      // Set to second-to-last step (knowledge)
      modal.currentStep = modal.steps.length - 2; // index 3
      modal._renderStep();
      jest.advanceTimersByTime(200);

      // Spy on finish before advancing
      const finishSpy = jest.spyOn(modal, 'finish').mockImplementation(() => {});

      await modal.nextStep();
      // nextStep increments to 4, _renderStep calls _renderStepBody('complete') which calls finish()
      jest.advanceTimersByTime(200);

      expect(finishSpy).toHaveBeenCalled();
    });
  });

  describe('prevStep', () => {
    it('decrements currentStep from 1 to 0', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 1;
      modal.prevStep();
      jest.advanceTimersByTime(200);

      expect(modal.currentStep).toBe(0);
    });

    it('skips Setup step (2) when navigating backwards from Knowledge (3)', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 3;
      modal.prevStep();
      jest.advanceTimersByTime(200);

      expect(modal.currentStep).toBe(1);
    });

    it('does nothing at step 0', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 0;
      modal.prevStep();

      expect(modal.currentStep).toBe(0);
    });

    it('blocks when _isSetupActive is true', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._isSetupActive = true;
      modal.currentStep = 2;

      modal.prevStep();

      expect(modal.currentStep).toBe(2); // Did not decrement
    });
    it('blocks rapid double-clicks on nextStep using _isTransitioning guard', async () => {
      const { modal } = createModal();
      await openModal(modal);

      expect(modal.currentStep).toBe(0);

      // Fire two nextStep calls immediately without waiting
      const p1 = modal.nextStep();
      const p2 = modal.nextStep();

      await Promise.all([p1, p2]);

      // State should only advance by 1
      expect(modal.currentStep).toBe(1);
    });

    it('blocks rapid double-clicks on prevStep using _isTransitioning guard', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 3; // start at knowledge

      // Fire two prevStep calls immediately
      modal.prevStep(); // Should go to 1 (skipping 2)
      modal.prevStep(); // Should be blocked by guard

      // Should only go back to step 1
      expect(modal.currentStep).toBe(1);
    });

    it('captures state on prevStep navigation', async () => {
      const { modal } = createModal();
      await openModal(modal);
      
      // Setup DOM for backward navigation
      modal.currentStep = 1;
      modal.bodyEl.innerHTML = '<input type="checkbox" id="accept-terms" checked />';
      
      modal.prevStep();
      jest.advanceTimersByTime(250);
      
      expect(modal._termsAccepted).toBe(true);
    });
  });

  // =========================================================================
  // _renderStep
  // =========================================================================

  describe('_renderStep', () => {
    it('updates title and subtitle from step definition', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 1; // license step
      modal._renderStep();

      expect(modal._stepTitleEl.textContent).toBe('License & Privacy');
      expect(modal._stepSubtitleEl.textContent).toBe('Terms of use and your privacy');
    });

    it('marks first step active in stepper', async () => {
      const { modal } = createModal();
      await openModal(modal);

      const dots = modal.bodyEl.querySelectorAll('.stepper-dot');
      expect(dots[0].classList.contains('is-active')).toBe(true);
      expect(dots[1].classList.contains('is-active')).toBe(false);
    });

    it('marks previous steps as complete', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 3;
      modal._renderStep();

      const dots = modal.bodyEl.querySelectorAll('.stepper-dot');
      expect(dots[0].classList.contains('is-complete')).toBe(true);
      expect(dots[1].classList.contains('is-complete')).toBe(true);
      expect(dots[2].classList.contains('is-complete')).toBe(true);
      expect(dots[3].classList.contains('is-active')).toBe(true);
      expect(dots[3].classList.contains('is-complete')).toBe(false);
    });

    it('updates stepper dots on step change', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 2;
      modal._renderStep();

      // Steps 0,1 should be complete; step 2 should be active
      const dots = modal.bodyEl.querySelectorAll('.stepper-dot');
      expect(dots[0].classList.contains('is-complete')).toBe(true);
      expect(dots[1].classList.contains('is-complete')).toBe(true);
      expect(dots[2].classList.contains('is-active')).toBe(true);
    });

    it('hides back button on step 0', async () => {
      const { modal } = createModal();
      await openModal(modal);

      expect(modal._backBtn.classList.contains('hidden')).toBe(true);
    });

    it('shows back button on step > 0', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 1;
      modal._renderStep();

      expect(modal._backBtn.classList.contains('hidden')).toBe(false);
    });

    it('shows "Start Experience" on last step', async () => {
      const { modal } = createModal();
      await openModal(modal);

      // Spy on finish to prevent it from running when we render the complete step
      jest.spyOn(modal, 'finish').mockImplementation(() => {});

      modal.currentStep = modal.steps.length - 1;
      modal._renderStep();

      expect(modal._nextBtn.textContent).toBe('Start Experience');
    });

    it('shows "Continue" on non-last steps', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 0;
      modal._renderStep();

      expect(modal._nextBtn.textContent).toBe('Continue');
    });

    it('shows "Finish Setup" on Knowledge step', async () => {
      const { modal } = createModal();
      await openModal(modal);

      // Knowledge step is index 3
      modal.currentStep = 3;
      modal._renderStep();

      expect(modal._nextBtn.textContent).toBe('Finish Setup');
    });

    it('hides navigation buttons on setup step', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 2; // setup
      modal._renderStep();

      expect(modal._nextBtn.classList.contains('hidden')).toBe(true);
      expect(modal._backBtn.classList.contains('hidden')).toBe(true);
    });

    it('sets _hasRenderedFirstStep after first render', async () => {
      const { modal } = createModal();
      await openModal(modal);

      expect(modal._hasRenderedFirstStep).toBe(true);
    });

    it('tracks step transition timeout in _timers', async () => {
      const { modal } = createModal();
      await openModal(modal);

      // Force a non-first render (first render skips animation timeout)
      modal._hasRenderedFirstStep = true;
      const timerCountBefore = modal._timers.length;

      modal.currentStep = 1;
      modal._renderStep();

      // Should have added a timeout for the step-exit/enter animation
      expect(modal._timers.length).toBeGreaterThan(timerCountBefore);
    });

    it('tracks setup controller deferred creation timeout in _timers', async () => {
      const { modal } = createModal();
      await openModal(modal);

      const timerCountBefore = modal._timers.length;
      modal._renderStepBody('setup');

      expect(modal._timers.length).toBeGreaterThan(timerCountBefore);
    });

    it('does not execute step transition after _disposed', async () => {
      const { modal } = createModal();
      await openModal(modal);

      // Force non-first render
      modal._hasRenderedFirstStep = true;
      modal.currentStep = 1;
      modal._renderStep();

      // Dispose before timeout fires
      modal._cleanup();

      // Advance past the animation timeout (120ms)
      jest.advanceTimersByTime(200);

      // Should not throw — _disposed guard prevents stale callback execution
      expect(modal._disposed).toBe(true);
    });
  });

  // =========================================================================
  // _renderStepBody — HTML template rendering
  // =========================================================================

  describe('_renderStepBody', () => {
    it('renders welcome step with hero and feature badges', async () => {
      const { modal } = createModal();
      await openModal(modal);

      expect(modal._stepContentEl.querySelector('.onboarding-welcome')).not.toBeNull();
      expect(modal._stepContentEl.querySelectorAll('.feature-badge').length).toBe(3);
    });

    it('renders license step with checkbox and privacy highlights', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._renderStepBody('license');

      expect(modal._stepContentEl.querySelector('#accept-terms')).not.toBeNull();
      expect(modal._stepContentEl.querySelector('.onboarding-license')).not.toBeNull();
      expect(modal._stepContentEl.querySelectorAll('.privacy-highlight').length).toBe(3);
    });

    it('renders setup step with 3 phase containers', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._renderStepBody('setup');

      expect(modal._stepContentEl.querySelector('#setup-phase-checking')).not.toBeNull();
      expect(modal._stepContentEl.querySelector('#setup-phase-installing')).not.toBeNull();
      expect(modal._stepContentEl.querySelector('#setup-phase-verifying')).not.toBeNull();
    });

    it('renders setup step and sets _isSetupActive to true', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._renderStepBody('setup');

      expect(modal._isSetupActive).toBe(true);
    });

    it('renders knowledge step with intelligence controller', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._renderStepBody('knowledge');

      expect(modal._stepContentEl.querySelector('.onboarding-intelligence')).not.toBeNull();
      expect(modal._stepContentEl.querySelector('#intel-add-secondary')).not.toBeNull();
      expect(modal._stepContentEl.querySelector('#intel-toggle-proactive')).not.toBeNull();
    });
  });

  // =========================================================================
  // Utility: _escapeHtml
  // =========================================================================

  describe('_escapeHtml', () => {
    let modal;

    beforeEach(() => {
      ({ modal } = createModal());
    });

    it('returns empty string for non-string input', () => {
      expect(modal._escapeHtml(null)).toBe('');
      expect(modal._escapeHtml(undefined)).toBe('');
      expect(modal._escapeHtml(123)).toBe('');
      expect(modal._escapeHtml('')).toBe('');
    });

    it('passes through plain text unchanged', () => {
      expect(modal._escapeHtml('hello world')).toBe('hello world');
    });

    it('escapes HTML angle brackets', () => {
      const result = modal._escapeHtml('<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
    });

    it('escapes ampersands', () => {
      expect(modal._escapeHtml('a & b')).toContain('&amp;');
    });

    it('handles strings with special HTML characters', () => {
      const result = modal._escapeHtml('a "quoted" & <tagged> string');
      expect(result).toContain('&amp;');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
      // String-based escaper correctly escapes double quotes to &quot;
      expect(result).toContain('&quot;');
      expect(result).not.toContain('"quoted"');
    });
  });

  // =========================================================================
  // Static: isNeeded
  // =========================================================================

  describe('isNeeded (static)', () => {
    const legalAcceptance = {
      accepted: true,
      terms_version: '2026-02-17',
      terms_hash: '4fae27d8a2be5438cf2a70c549cab2df8f22ec3ddcfcf278c99244724b2b47a3',
    };

    const getPreferenceWithLegal = (onboardingValue, legalValue = legalAcceptance) =>
      jest.fn((key) => {
        if (key === 'onboarding_complete') return Promise.resolve(onboardingValue);
        if (key === 'legal_acceptance_latest') return Promise.resolve(legalValue);
        return Promise.resolve(null);
      });

    it('returns false when localStorage has onboarding_complete=true and no endpoint', async () => {
      localStorage.setItem('aether_onboarding_complete', 'true');
      const result = await OnboardingModal.isNeeded(null);
      expect(result).toBe(false);
    });

    it('returns true when localStorage is empty and no endpoint', async () => {
      const result = await OnboardingModal.isNeeded(null);
      expect(result).toBe(true);
    });

    it('returns true when localStorage is empty and endpoint is undefined', async () => {
      const result = await OnboardingModal.isNeeded(undefined);
      expect(result).toBe(true);
    });

    it('returns false when API says onboarding_complete and syncs to localStorage', async () => {
      const endpoint = {
        getPreference: getPreferenceWithLegal({ value: true }),
        getSetupStatus: jest.fn(),
      };

      const result = await OnboardingModal.isNeeded(endpoint);
      expect(result).toBe(false);
      expect(endpoint.getPreference).toHaveBeenCalledWith('onboarding_complete');
      expect(localStorage.getItem('aether_onboarding_complete')).toBe('true');
    });

    it('returns false when API stores onboarding_complete as boolean true', async () => {
      const endpoint = {
        getPreference: getPreferenceWithLegal(true),
        getSetupStatus: jest.fn(),
      };

      const result = await OnboardingModal.isNeeded(endpoint);
      expect(result).toBe(false);
      expect(localStorage.getItem('aether_onboarding_complete')).toBe('true');
    });

    it('returns true when API says not complete', async () => {
      const endpoint = {
        getPreference: getPreferenceWithLegal({ value: false }),
        getSetupStatus: jest.fn(),
      };

      const result = await OnboardingModal.isNeeded(endpoint);
      expect(result).toBe(true);
    });

    it('returns true and logs warning when API call throws during strict verification', async () => {
      const endpoint = {
        getPreference: jest.fn((key) => (
          key === 'onboarding_complete'
            ? Promise.reject(new Error('network'))
            : Promise.resolve(legalAcceptance)
        )),
        getSetupStatus: jest.fn(),
      };

      const result = await OnboardingModal.isNeeded(endpoint);
      expect(result).toBe(true);
    });

    it('returns true when API returns null preference', async () => {
      const endpoint = {
        getPreference: getPreferenceWithLegal(null),
        getSetupStatus: jest.fn(),
      };

      const result = await OnboardingModal.isNeeded(endpoint);
      expect(result).toBe(true);
    });

    // Cross-check tests (localStorage vs backend setup status)
    it('returns true when localStorage done but backend phase is idle (stale cache)', async () => {
      localStorage.setItem('aether_onboarding_complete', 'true');
      const endpoint = {
        getSetupStatus: jest.fn(() => Promise.resolve({ current_phase: 'idle' })),
        getPreference: getPreferenceWithLegal(true),
      };

      const result = await OnboardingModal.isNeeded(endpoint);
      expect(result).toBe(true);
      // Should have cleared stale localStorage
      expect(localStorage.getItem('aether_onboarding_complete')).toBeNull();
    });

    it('returns false when localStorage done and backend confirms completed', async () => {
      localStorage.setItem('aether_onboarding_complete', 'true');
      const endpoint = {
        getSetupStatus: jest.fn(() => Promise.resolve({ current_phase: 'completed' })),
        getPreference: getPreferenceWithLegal(true),
      };

      const result = await OnboardingModal.isNeeded(endpoint);
      expect(result).toBe(false);
    });

    it('returns true when localStorage done and backend reports skipped (legacy state)', async () => {
      localStorage.setItem('aether_onboarding_complete', 'true');
      const endpoint = {
        getSetupStatus: jest.fn(() => Promise.resolve({ current_phase: 'skipped' })),
        getPreference: getPreferenceWithLegal(true),
      };

      const result = await OnboardingModal.isNeeded(endpoint);
      expect(result).toBe(true);
      expect(localStorage.getItem('aether_onboarding_complete')).toBeNull();
    });

    it('syncs pending onboarding completion when local state is done and backend is reachable', async () => {
      localStorage.setItem('aether_onboarding_complete', 'true');
      localStorage.setItem('aether_onboarding_complete_sync_pending', 'true');
      const endpoint = {
        setPreference: jest.fn(() => Promise.resolve()),
        getPreference: getPreferenceWithLegal(true),
        getSetupStatus: jest.fn(() => Promise.resolve({ current_phase: 'completed' })),
      };

      const result = await OnboardingModal.isNeeded(endpoint);

      expect(result).toBe(false);
      expect(endpoint.setPreference).toHaveBeenCalledWith('onboarding_complete', true);
      expect(localStorage.getItem('aether_onboarding_complete_sync_pending')).toBeNull();
    });

    it('keeps pending sync marker when backend sync attempt fails', async () => {
      localStorage.setItem('aether_onboarding_complete', 'true');
      localStorage.setItem('aether_onboarding_complete_sync_pending', 'true');
      const endpoint = {
        setPreference: jest.fn(() => Promise.reject(new Error('sync fail'))),
        getSetupStatus: jest.fn(() => Promise.resolve({ current_phase: 'completed' })),
        getPreference: getPreferenceWithLegal(true),
      };

      const result = await OnboardingModal.isNeeded(endpoint);

      expect(result).toBe(false);
      expect(localStorage.getItem('aether_onboarding_complete_sync_pending')).toBe('true');
    });

    it('keeps pending sync marker when write succeeds but verification read is incomplete', async () => {
      localStorage.setItem('aether_onboarding_complete', 'true');
      localStorage.setItem('aether_onboarding_complete_sync_pending', 'true');
      const endpoint = {
        setPreference: jest.fn(() => Promise.resolve()),
        getPreference: jest.fn((key) => (
          key === 'onboarding_complete'
            ? Promise.resolve(false)
            : Promise.resolve(legalAcceptance)
        )),
        getSetupStatus: jest.fn(() => Promise.resolve({ current_phase: 'completed' })),
      };

      const result = await OnboardingModal.isNeeded(endpoint);

      expect(result).toBe(false);
      expect(endpoint.setPreference).toHaveBeenCalledWith('onboarding_complete', true);
      expect(endpoint.getPreference).toHaveBeenCalledWith('onboarding_complete');
      expect(localStorage.getItem('aether_onboarding_complete_sync_pending')).toBe('true');
    });

    it('returns false when localStorage done but backend cross-check throws (graceful degradation)', async () => {
      localStorage.setItem('aether_onboarding_complete', 'true');
      const endpoint = {
        getSetupStatus: jest.fn(() => Promise.reject(new Error('timeout'))),
        getPreference: getPreferenceWithLegal(true),
      };

      const result = await OnboardingModal.isNeeded(endpoint);
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // show
  // =========================================================================

  describe('show', () => {
    it('resets currentStep to 0 and calls open()', async () => {
      const { modal } = createModal();
      modal.currentStep = 3;

      await modal.show();

      expect(modal.currentStep).toBe(0);
      expect(modal.isOpen).toBe(true);
    });

    it('resets _disposed flag for fresh lifecycle after close/reopen', async () => {
      const { modal } = createModal();
      await modal.show();

      // Close sets _disposed via _cleanup
      modal.close();
      expect(modal._disposed).toBe(true);
      expect(modal._sourceConfig).toBeNull(); // _cleanup nulled it

      // Reopen must reset _disposed AND recreate _sourceConfig
      await modal.show();
      expect(modal._disposed).toBe(false);
      expect(modal._sourceConfig).toEqual({
        sourceToggles: { browser: true, email: true, filesystem: true },
        selectedBrowser: null,
        excludedProfiles: [],
      });
    });
  });

  // =========================================================================
  // finish
  // =========================================================================

  describe('finish', () => {
    it('saves to localStorage', async () => {
      const { modal } = createModal();
      await openModal(modal);

      await modal.finish();

      expect(localStorage.getItem('aether_onboarding_complete')).toBe('true');
      expect(localStorage.getItem('aether_onboarding_complete_sync_pending')).toBeNull();
    });

    it('calls endpoint.completeOnboarding with consolidated payload', async () => {
      const { modal, endpoint } = createModal();
      await openModal(modal);

      // Setup some state to verify consolidation
      modal._onboardingName = 'Test User';
      modal._termsAccepted = true;
      modal._selectedPaths = ['/test/path'];

      // Mock intelligence controller data
      modal._intelligenceCtrl = {
        getConsolidatedData: jest.fn(() => ({
          indexing_locations: [{ path: '/test/path', name: 'path', type: 'secondary' }],
          daemon_config: {},
          proactive_config: { enabled: true }
        }))
      };

      await modal.finish();

      expect(endpoint.completeOnboarding).toHaveBeenCalledWith(
        expect.objectContaining({
          user_profile: { name: 'Test User' },
          legal_acceptance: expect.objectContaining({
            accepted: true
          }),
          indexing_locations: expect.arrayContaining([
            expect.objectContaining({ path: '/test/path' })
          ]),
          proactive_config: expect.objectContaining({ enabled: true })
        }),
        expect.objectContaining({ signal: expect.any(Object) })
      );
    });

    it('calls _showRestartNotice on success', async () => {
      const { modal } = createModal();
      await openModal(modal);

      const spy = jest.spyOn(modal, '_showRestartNotice').mockImplementation(() => {});

      await modal.finish();

      expect(spy).toHaveBeenCalled();
    });

    it('shows finalize failure state on completeOnboarding error', async () => {
      const { modal, endpoint } = createModal();
      await openModal(modal);
      
      // Override completeOnboarding so it fails
      endpoint.completeOnboarding = jest.fn().mockRejectedValue(new Error('server down'));

      const spy = jest.spyOn(modal, '_showFinalizeFailureState').mockImplementation(() => {});

      await modal.finish();

      expect(spy).toHaveBeenCalled();
      expect(localStorage.getItem('aether_onboarding_complete')).toBeNull();
      expect(localStorage.getItem('aether_onboarding_complete_sync_pending')).toBeNull();
    });
  });

  // =========================================================================
  // _showRestartNotice
  // =========================================================================

  describe('_showRestartNotice', () => {
    it('replaces step content with complete template', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._showRestartNotice();

      expect(modal._stepContentEl.querySelector('.onboarding-complete')).not.toBeNull();
    });

    it('updates title to "You\'re All Set"', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._showRestartNotice();

      expect(modal._stepTitleEl.textContent).toBe("You're All Set");
    });

    it('starts countdown timer', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._showRestartNotice();

      expect(modal._restartCountdownTimer).not.toBeNull();
      expect(modal._nextBtn.textContent).toBe('Restarting in 5s');
    });

    it('countdown decrements every second', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._showRestartNotice();

      jest.advanceTimersByTime(1000);
      expect(modal._nextBtn.textContent).toBe('Restarting in 4s');

      jest.advanceTimersByTime(1000);
      expect(modal._nextBtn.textContent).toBe('Restarting in 3s');
    });

    it('triggers relaunch at countdown=0', async () => {
      const { modal } = createModal();
      await openModal(modal);

      const spy = jest.spyOn(modal, '_triggerRelaunch').mockImplementation(() => {});
      modal._showRestartNotice();

      jest.advanceTimersByTime(5000);

      expect(spy).toHaveBeenCalled();
    });

    it('tracks countdown timer in _timers', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._showRestartNotice();

      expect(modal._timers.length).toBeGreaterThan(0);
    });

    it('shows quit-app back button', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._showRestartNotice();

      expect(modal._backBtn.classList.contains('hidden')).toBe(false);
      expect(modal._backBtn.textContent).toBe('Quit App');
    });

    it('quit-app action does not resolve onboarding gate in-place', async () => {
      const { modal, onComplete, eventBus } = createModal();
      await openModal(modal);
      modal._showRestartNotice();

      const send = jest.fn();
      window.aether = { ipc: { send } };

      modal._backBtn.click();

      expect(send).toHaveBeenCalledWith('app:quit');
      expect(onComplete).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalledWith('onboarding:finished');

      delete window.aether;
    });
  });

  // =========================================================================
  // _triggerRelaunch
  // =========================================================================

  describe('_triggerRelaunch', () => {
    it('calls IPC app:relaunch when available', async () => {
      const { modal } = createModal();
      await openModal(modal);

      const mockSend = jest.fn();
      window.aether = { ipc: { send: mockSend } };

      modal._triggerRelaunch();

      expect(mockSend).toHaveBeenCalledWith('app:relaunch');

      delete window.aether;
    });

    it('transitions UI to shutdown state before sending IPC', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._showRestartNotice();

      const mockSend = jest.fn();
      window.aether = { ipc: { send: mockSend } };

      modal._triggerRelaunch();

      // Button shows shutdown text
      expect(modal._nextBtn.textContent).toBe('Shutting down\u2026');
      expect(modal._nextBtn.disabled).toBe(true);

      // Back button hidden during shutdown transition
      expect(modal._backBtn.classList.contains('hidden')).toBe(true);

      // Status message updated
      expect(modal._statusMsgEl.textContent).toBe('Application is restarting \u2014 please wait');

      // Icon swapped to spinner
      const icon = modal._stepContentEl.querySelector('.complete-icon-wrapper i');
      expect(icon.className).toContain('fa-sync-alt');
      expect(icon.className).toContain('fa-spin');

      // Heading updated
      const heading = modal._stepContentEl.querySelector('.onboarding-complete h3');
      expect(heading.textContent).toBe('Restarting\u2026');

      delete window.aether;
    });

    it('clears countdown timer when entering shutdown state', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._showRestartNotice();
      expect(modal._restartCountdownTimer).not.toBeNull();

      const mockSend = jest.fn();
      window.aether = { ipc: { send: mockSend } };

      modal._triggerRelaunch();

      expect(modal._restartCountdownTimer).toBeNull();

      delete window.aether;
    });

    it('falls back to Toast warning when IPC unavailable', async () => {
      const { modal } = createModal();
      await openModal(modal);

      delete window.aether;

      modal._triggerRelaunch();

      expect(Toast.warning).toHaveBeenCalledWith(
        'Automatic restart is unavailable. Quit and reopen AetherArena to continue.'
      );
    });

    it('does not resolve onboarding gate on restart fallback', async () => {
      const { modal, onComplete, eventBus } = createModal();
      await openModal(modal);

      delete window.aether;

      modal._triggerRelaunch();

      expect(onComplete).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalledWith('onboarding:finished');
    });
  });

  describe('_deferSetup', () => {
    it('requests app quit and does not mark onboarding complete', async () => {
      const { modal, onComplete, eventBus } = createModal();
      await openModal(modal);

      const send = jest.fn();
      window.aether = { ipc: { send } };

      modal._deferSetup();

      expect(send).toHaveBeenCalledWith('app:quit');
      expect(onComplete).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalledWith('onboarding:deferred');

      delete window.aether;
    });
  });

  // =========================================================================
  // _cleanup
  // =========================================================================

  describe('_cleanup', () => {
    it('removes all tracked listeners', async () => {
      const { modal } = createModal();
      await openModal(modal);

      const removeEventListenerSpy = jest.fn();
      modal._listeners = [
        { el: { removeEventListener: removeEventListenerSpy }, type: 'click', fn: jest.fn() },
        { el: { removeEventListener: removeEventListenerSpy }, type: 'change', fn: jest.fn() },
      ];

      modal._cleanup();

      expect(removeEventListenerSpy).toHaveBeenCalledTimes(2);
      expect(modal._listeners).toEqual([]);
    });

    it('clears all tracked timers', async () => {
      const { modal } = createModal();
      await openModal(modal);

      const timer1 = setInterval(() => {}, 9999);
      const timer2 = setTimeout(() => {}, 9999);
      modal._timers = [timer1, timer2];

      modal._cleanup();

      expect(modal._timers).toEqual([]);
    });

    it('clears restart countdown timer', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._restartCountdownTimer = setInterval(() => {}, 1000);
      modal._cleanup();

      expect(modal._restartCountdownTimer).toBeNull();
    });

    it('resets _hasRenderedFirstStep flag', async () => {
      const { modal } = createModal();
      await openModal(modal);

      expect(modal._hasRenderedFirstStep).toBe(true);
      modal._cleanup();
      expect(modal._hasRenderedFirstStep).toBe(false);
    });

    it('resets _isSetupActive flag', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._isSetupActive = true;
      modal._cleanup();
      expect(modal._isSetupActive).toBe(false);
    });

    it('disposes step controllers and nulls references', async () => {
      const { modal } = createModal();
      await openModal(modal);

      const mockCtrl = (name) => ({
        dispose: jest.fn(),
        name,
      });

      const setupCtrl = mockCtrl('setup');
      const intelligenceCtrl = mockCtrl('intelligence');

      modal._setupCtrl = setupCtrl;
      modal._intelligenceCtrl = intelligenceCtrl;

      modal._cleanup();

      expect(setupCtrl.dispose).toHaveBeenCalledTimes(1);
      expect(intelligenceCtrl.dispose).toHaveBeenCalledTimes(1);

      expect(modal._setupCtrl).toBeNull();
      expect(modal._intelligenceCtrl).toBeNull();
      expect(modal._sourceConfig).toBeNull();
    });

    it('handles cleanup gracefully when no controllers exist', async () => {
      const { modal } = createModal();
      await openModal(modal);

      expect(() => modal._cleanup()).not.toThrow();
    });

    it('sets _disposed flag to true', async () => {
      const { modal } = createModal();
      await openModal(modal);

      expect(modal._disposed).toBe(false);
      modal._cleanup();
      expect(modal._disposed).toBe(true);
    });

    it('resets _isSaving flag', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._isSaving = true;
      modal._cleanup();
      expect(modal._isSaving).toBe(false);
    });
  });

  // =========================================================================
  // Consumer contract: module.exports
  // =========================================================================

  describe('consumer contract', () => {
    it('exports OnboardingModal class', () => {
      expect(typeof OnboardingModal).toBe('function');
      expect(OnboardingModal.name).toBe('OnboardingModal');
    });

    it('has static isNeeded method', () => {
      expect(typeof OnboardingModal.isNeeded).toBe('function');
    });

    it('has show instance method', () => {
      const { modal } = createModal();
      expect(typeof modal.show).toBe('function');
    });

    it('has finish instance method', () => {
      const { modal } = createModal();
      expect(typeof modal.finish).toBe('function');
    });

    it('accepts { endpoint, eventBus, onComplete } constructor options', () => {
      const ep = createMockEndpoint();
      const eb = createMockEventBus();
      const oc = jest.fn();

      const m = new OnboardingModal({ endpoint: ep, eventBus: eb, onComplete: oc });

      expect(m.endpoint).toBe(ep);
      expect(m.eventBus).toBe(eb);
      expect(m.onComplete).toBe(oc);
    });
  });

  // =========================================================================
  // Knowledge step delegation (post-refactor)
  // Logic tests in intelligence-step.test.js. Here we verify the
  // orchestrator correctly delegates to IntelligenceStepController.
  // =========================================================================

  describe('knowledge step delegation', () => {
    it('creates IntelligenceStepController when rendering knowledge step', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._renderStepBody('knowledge');

      expect(modal._intelligenceCtrl).not.toBeNull();
      expect(modal._intelligenceCtrl).toHaveProperty('mount');
      expect(modal._intelligenceCtrl).toHaveProperty('saveConfig');
      expect(modal._intelligenceCtrl).toHaveProperty('dispose');
    });

    it('passes correct dependencies to IntelligenceStepController', async () => {
      const { modal, endpoint } = createModal();
      await openModal(modal);

      modal._renderStepBody('knowledge');

      expect(modal._intelligenceCtrl._endpoint).toBe(endpoint);
      expect(modal._intelligenceCtrl._bodyEl).toBe(modal.bodyEl);
      expect(modal._intelligenceCtrl.domainService._selectedPaths).toBe(modal._selectedPaths);
      expect(modal._intelligenceCtrl.domainService._intelligenceToggles).toBe(modal._intelligenceToggles);
      expect(modal._intelligenceCtrl.domainService._sourceConfig).toBe(modal._sourceConfig);
    });

    it('renders HTML from IntelligenceStepController into step content', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._renderStepBody('knowledge');

      expect(modal._stepContentEl.querySelector('.onboarding-intelligence')).not.toBeNull();
      expect(modal._stepContentEl.querySelector('#intel-add-secondary')).not.toBeNull();
      expect(modal._stepContentEl.querySelector('#intel-toggle-proactive')).not.toBeNull();
    });

    it('delegates saveConfig to controller in nextStep', async () => {
      const { modal } = createModal();
      await openModal(modal);

      // Navigate to knowledge step (index 3)
      modal.currentStep = 3;
      modal._renderStep();
      jest.advanceTimersByTime(200);

      const mockSaveConfig = jest.fn(() => Promise.resolve());
      modal._intelligenceCtrl.saveConfig = mockSaveConfig;

      // Spy finish since next step is complete (which triggers finish)
      jest.spyOn(modal, 'finish').mockImplementation(() => {});

      await modal.nextStep();

      expect(mockSaveConfig).toHaveBeenCalledTimes(1);
    });

    it('arms finish bypass when source readiness is still loading', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 3;
      modal._renderStep();
      jest.advanceTimersByTime(200);

      const saveConfig = jest.fn(() => Promise.resolve());
      modal._intelligenceCtrl.getSaveReadiness = jest.fn(() => ({ ready: false, reason: 'source_status_loading' }));
      modal._intelligenceCtrl.saveConfig = saveConfig;

      await modal.nextStep();

      expect(saveConfig).not.toHaveBeenCalled();
      expect(modal.currentStep).toBe(3);
      expect(modal._nextBtn.textContent).toBe('Finish Anyway');
      expect(Toast.warning).toHaveBeenCalledWith(
        'Still checking activity access. Click Finish Anyway to continue now, or wait a moment.'
      );
    });

    it('uses explicit bypass on second click when source readiness is unresolved', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 3;
      modal._renderStep();
      jest.advanceTimersByTime(200);

      const saveConfig = jest.fn(() => Promise.resolve());
      modal._intelligenceCtrl.getSaveReadiness = jest.fn(() => ({ ready: false, reason: 'source_status_loading' }));
      modal._intelligenceCtrl.saveConfig = saveConfig;

      jest.spyOn(modal, 'finish').mockImplementation(() => {});

      await modal.nextStep(); // arms bypass
      await modal.nextStep(); // executes bypass

      expect(saveConfig).toHaveBeenCalledWith({ allowPendingSourceStatus: true });
      expect(modal.currentStep).toBe(4);
    });

    it('disables both buttons during saveConfig and restores after', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 3;
      modal._renderStep();
      jest.advanceTimersByTime(200);

      let btnStatesDuringSave = [];
      modal._intelligenceCtrl.saveConfig = jest.fn(async () => {
        btnStatesDuringSave.push({
          nextDisabled: modal._nextBtn.disabled,
          nextText: modal._nextBtn.textContent,
          backDisabled: modal._backBtn.disabled,
        });
      });

      jest.spyOn(modal, 'finish').mockImplementation(() => {});

      await modal.nextStep();

      expect(btnStatesDuringSave.length).toBe(1);
      expect(btnStatesDuringSave[0].nextDisabled).toBe(true);
      expect(btnStatesDuringSave[0].nextText).toBe('Saving...');
      expect(btnStatesDuringSave[0].backDisabled).toBe(true);

      // After save completes, step advances to 'complete' (last step)
      // Button text becomes 'Start Experience' on the final step
      expect(modal._nextBtn.disabled).toBe(false);
      expect(modal._nextBtn.textContent).toBe('Start Experience');
      expect(modal._backBtn.disabled).toBe(false);
    });

    it('blocks advancement and shows error when saveConfig throws', async () => {
      const Toast = require(TOAST_PATH);
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 3;
      modal._renderStep();
      jest.advanceTimersByTime(200);

      const err = new Error('save failed');
      err.code = 'indexing_location_save_failed';
      err.cause = new Error('503 service not initialized');
      modal._intelligenceCtrl.saveConfig = jest.fn(() => Promise.reject(err));

      await modal.nextStep();

      // Should NOT advance — stays on knowledge step (index 3)
      expect(modal.currentStep).toBe(3);
      // User sees error Toast with specific guidance for the identified 503/initialization issue
      expect(Toast.error).toHaveBeenCalledWith(expect.stringContaining('Return to System Setup, complete setup, then try again.'));
      // Buttons restored for retry — Knowledge step shows "Finish Setup"
      expect(modal._nextBtn.disabled).toBe(false);
      expect(modal._nextBtn.textContent).toBe('Finish Setup');
      expect(modal._backBtn.disabled).toBe(false);
    });

    it('advances when saveConfig resolves successfully', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 3;
      modal._renderStep();
      jest.advanceTimersByTime(200);

      modal._intelligenceCtrl.saveConfig = jest.fn(() => Promise.resolve());
      jest.spyOn(modal, 'finish').mockImplementation(() => {});

      await modal.nextStep();

      // Should advance
      expect(modal.currentStep).toBe(4);
    });

    it('prevents concurrent saves via _isSaving guard', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 3;
      modal._renderStep();
      jest.advanceTimersByTime(200);

      let resolveFirst;
      const firstSavePromise = new Promise(r => { resolveFirst = r; });
      modal._intelligenceCtrl.saveConfig = jest.fn(() => firstSavePromise);

      jest.spyOn(modal, 'finish').mockImplementation(() => {});

      // Start first save (don't await — it's in-flight)
      const p1 = modal.nextStep();

      // _isSaving should now be true
      expect(modal._isSaving).toBe(true);

      // Attempt a second save while first is in-flight
      const p2 = modal.nextStep();

      // saveConfig should only have been called once
      expect(modal._intelligenceCtrl.saveConfig).toHaveBeenCalledTimes(1);

      // Resolve first save
      resolveFirst();
      await p1;
      await p2;

      // _isSaving should be cleared
      expect(modal._isSaving).toBe(false);
    });

    it('resets _isSaving even when saveConfig throws', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal.currentStep = 3;
      modal._renderStep();
      jest.advanceTimersByTime(200);

      modal._intelligenceCtrl.saveConfig = jest.fn(() =>
        Promise.reject(new Error('fail'))
      );

      await modal.nextStep();

      expect(modal._isSaving).toBe(false);
    });

    it('disposes previous controller when re-rendering knowledge step', async () => {
      const { modal } = createModal();
      await openModal(modal);

      modal._renderStepBody('knowledge');
      const firstCtrl = modal._intelligenceCtrl;
      const disposeSpy = jest.spyOn(firstCtrl, 'dispose');

      modal._renderStepBody('knowledge');

      expect(disposeSpy).toHaveBeenCalledTimes(1);
      expect(modal._intelligenceCtrl).not.toBe(firstCtrl);
    });
  });
});
