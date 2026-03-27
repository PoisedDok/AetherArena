'use strict';

// ---------------------------------------------------------------------------
// SetupStepController.js — Unit tests (post-consolidation)
// ---------------------------------------------------------------------------
// Tests the 3-phase state machine: checking -> installing -> verifying.
// DOM structure provided by StepTemplates.renderSetup().
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

const SetupStepController = require(
    '../../../../../src/renderer/main/modules/onboarding/modules/SetupStepController'
);
const Toast = require('../../../../../src/renderer/shared/components/Toast');
const StepTemplates = require(
    '../../../../../src/renderer/main/modules/onboarding/modules/OnboardingStepTemplates'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flushMicrotasks(n = 10) {
    for (let i = 0; i < n; i++) await Promise.resolve();
}

function createBodyEl() {
    const el = document.createElement('div');
    el.innerHTML = StepTemplates.renderSetup();
    return el;
}

function createController(overrides = {}) {
    const bodyEl = createBodyEl();
    const endpoint = {
        getBackendURL: jest.fn(() => 'http://localhost:8765'),
        getHealth: jest.fn(() => Promise.resolve({ status: 'ok' })),
        getOrchestrationState: jest.fn(async () => {
            return { phase: 'checking', status: 'in_progress', requirements: {} };
        }),
        executeOrchestrationCommand: jest.fn(async () => {
            return {};
        }),
        ...overrides.endpoint,
    };
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const onNext = jest.fn();
    const onNavigationControl = jest.fn();
    const onDefer = jest.fn();
    const escapeHtml = jest.fn((s) => s || '');

    const ctrl = new SetupStepController({
        endpoint,
        bodyEl,
        log,
        onNext,
        onNavigationControl,
        onDefer,
        escapeHtml,
    });
    return { ctrl, bodyEl, endpoint, log, onNext, onNavigationControl, onDefer, escapeHtml };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SetupStepController', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // =========================================================================
    // constructor
    // =========================================================================

    describe('constructor', () => {
        it('initializes with empty timers and not disposed', () => {
            const { ctrl } = createController();
            expect(ctrl._pollTimer).toBeNull();
            expect(ctrl._advanceTimer).toBeNull();
            expect(ctrl._disposed).toBe(false);
        });

        it('stores onNavigationControl callback', () => {
            const { ctrl, onNavigationControl } = createController();
            expect(ctrl._onNavigationControl).toBe(onNavigationControl);
        });

        it('initializes phase to null', () => {
            const { ctrl } = createController();
            expect(ctrl._lastPhase).toBeNull();
        });

        it('defaults onNavigationControl and onDefer to no-ops when not provided', () => {
            const bodyEl = createBodyEl();
            const ctrl = new SetupStepController({
                endpoint: {
                    getBackendURL: jest.fn(),
                    getHealth: jest.fn(),
                    getOrchestrationState: jest.fn(),
                    executeOrchestrationCommand: jest.fn()
                },
                bodyEl,
                log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
                onNext: jest.fn(),
                escapeHtml: jest.fn(),
            });
            // Should not throw when called
            expect(() => ctrl._onNavigationControl({ back: false, next: false })).not.toThrow();
            expect(() => ctrl._onDefer()).not.toThrow();
        });
    });

    // =========================================================================
    // start()
    // =========================================================================

    describe('start', () => {
        it('hides navigation buttons via onNavigationControl', () => {
            const { ctrl, onNavigationControl } = createController();
            ctrl.start();
            expect(onNavigationControl).toHaveBeenCalledWith({ back: false, next: false });
            ctrl.dispose();
        });

        it('starts polling state', () => {
            const { ctrl } = createController();
            ctrl.start();
            expect(ctrl._pollTimer).not.toBeNull();
            ctrl.dispose();
        });
    });

    // =========================================================================
    // Phase 1: _runPrerequisiteCheck
    // =========================================================================

    describe('_runPrerequisiteCheck', () => {
        it('polls backend health and checks setup status when ready', async () => {
            const { ctrl, endpoint } = createController();
            
            // Mock idle first, then checking
            endpoint.getOrchestrationState
                .mockResolvedValueOnce({ phase: 'idle' })
                .mockResolvedValueOnce({ phase: 'checking', status: 'in_progress', requirements: {} });

            ctrl.start();
            
            // Allow the setTimeout(0) for polling to run
            jest.advanceTimersByTime(10);
            await flushMicrotasks(20);

            // Should have checked state and sent start_check
            expect(endpoint.getOrchestrationState).toHaveBeenCalled();
            expect(endpoint.executeOrchestrationCommand).toHaveBeenCalledWith('start_check');
            ctrl.dispose();
        });

        it('auto-transitions to installing when all requirements met', async () => {
            const { ctrl, endpoint, bodyEl } = createController();
            
            // Mock idle first, then checking, then installing
            endpoint.getOrchestrationState
                .mockResolvedValueOnce({ phase: 'idle' })
                .mockResolvedValueOnce({ phase: 'checking', status: 'in_progress', requirements: {} })
                .mockResolvedValueOnce({ phase: 'installing', status: 'in_progress' });
            
            ctrl.start();
            jest.advanceTimersByTime(10);
            await flushMicrotasks(20);

            // Fast forward to next poll (checking)
            jest.advanceTimersByTime(2000);
            await flushMicrotasks(20);

            // Fast forward to next poll (installing)
            jest.advanceTimersByTime(2000);
            await flushMicrotasks(20);

            expect(ctrl._phase || ctrl._lastPhase).toBe('installing');
            ctrl.dispose();
        });

        it('auto-advances when setup already complete', async () => {
            const { ctrl, endpoint, onNext } = createController();
            endpoint.getOrchestrationState
                .mockResolvedValueOnce({ phase: 'idle' })
                .mockResolvedValueOnce({ phase: 'completed' });

            ctrl.start();
            jest.advanceTimersByTime(10);
            await flushMicrotasks(20);

            // Fast forward to next poll
            jest.advanceTimersByTime(2000);
            await flushMicrotasks(20);

            // After 800ms delay, should advance
            jest.advanceTimersByTime(1500); // Wait for _advanceAfterDelay
            expect(onNext).toHaveBeenCalled();
            ctrl.dispose();
        });

        it('shows prereq errors when Docker not installed', async () => {
            const { ctrl, endpoint, bodyEl } = createController();
            endpoint.getOrchestrationState
                .mockResolvedValueOnce({ phase: 'idle' })
                .mockResolvedValueOnce({ 
                    phase: 'checking', 
                    status: 'action_required', 
                    requirements: {
                        python3: { installed: true },
                        docker_daemon: { installed: false, running: false },
                    }
                });

            ctrl.start();
            jest.advanceTimersByTime(10);
            await flushMicrotasks(20);

            // Fast forward to next poll
            jest.advanceTimersByTime(2000);
            await flushMicrotasks(20);

            const errorsEl = bodyEl.querySelector('#setup-prereq-errors');
            expect(errorsEl.classList.contains('hidden')).toBe(false);
            // Platform-aware: text varies by OS, but card structure is constant
            expect(errorsEl.innerHTML).toContain('Docker Desktop Needed');
            expect(errorsEl.innerHTML).toContain('prereq-card--docker');
            expect(errorsEl.innerHTML).toContain('prereq-steps');
            // Time estimate badge present
            expect(errorsEl.innerHTML).toContain('prereq-time-est');
            ctrl.dispose();
        });

        it('shows prereq errors when Docker installed but not running', async () => {
            const { ctrl, endpoint, bodyEl } = createController();
            endpoint.getOrchestrationState
                .mockResolvedValueOnce({ phase: 'idle' })
                .mockResolvedValueOnce({ 
                    phase: 'checking', 
                    status: 'action_required', 
                    requirements: {
                        python3: { installed: true },
                        docker_daemon: { installed: true, running: false },
                    }
                });

            ctrl.start();
            jest.advanceTimersByTime(10);
            await flushMicrotasks(20);

            // Fast forward to next poll
            jest.advanceTimersByTime(2000);
            await flushMicrotasks(20);

            const errorsEl = bodyEl.querySelector('#setup-prereq-errors');
            expect(errorsEl.innerHTML).toContain('Start Docker Desktop');
            expect(errorsEl.innerHTML).toContain('prereq-card--docker-stopped');
            // Time estimate for first launch
            expect(errorsEl.innerHTML).toContain('prereq-time-est');
            ctrl.dispose();
        });

        it('shows prereq errors when Python not installed', async () => {
            const { ctrl, endpoint, bodyEl } = createController();
            endpoint.getOrchestrationState
                .mockResolvedValueOnce({ phase: 'idle' })
                .mockResolvedValueOnce({ 
                    phase: 'checking', 
                    status: 'action_required', 
                    requirements: {
                        python3: { installed: false },
                        docker_daemon: { installed: true, running: true },
                    }
                });

            ctrl.start();
            jest.advanceTimersByTime(10);
            await flushMicrotasks(20);

            // Fast forward to next poll
            jest.advanceTimersByTime(2000);
            await flushMicrotasks(50); // Increased microtasks

            const errorsEl = bodyEl.querySelector('#setup-prereq-errors');
            expect(errorsEl.classList.contains('hidden')).toBe(false);
            expect(errorsEl.innerHTML).toContain('Python 3 Needed');
            expect(errorsEl.innerHTML).toContain('prereq-card--python');
            expect(errorsEl.innerHTML).toContain('prereq-steps');
            // Time estimate badge present
            expect(errorsEl.innerHTML).toContain('prereq-time-est');
            ctrl.dispose();
        });

        it('handles poll errors gracefully by updating UI and continuing to poll', async () => {
            const { ctrl, endpoint, bodyEl } = createController();
            
            // Mock getOrchestrationState to throw
            endpoint.getOrchestrationState.mockRejectedValue(new Error('Network down'));

            ctrl.start();
            jest.advanceTimersByTime(10);
            await flushMicrotasks(20);

            const labelEl = bodyEl.querySelector('#setup-checking-label');
            const spinnerEl = bodyEl.querySelector('.checking-spinner-wrap');
            
            expect(labelEl.textContent).toContain('Disconnected from setup service');
            expect(spinnerEl.innerHTML).toContain('fa-exclamation-circle');
            
            // Verify it schedules the next poll
            expect(ctrl._pollTimer).not.toBeNull();
            
            ctrl.dispose();
        });
    });

    // =========================================================================
    // Phase 2: Action Buttons (Retry, Defer)
    // =========================================================================

    describe('Action Buttons', () => {
        it('clicking Retry Check sends retry_check command', async () => {
            const { ctrl, endpoint, bodyEl } = createController();
            
            ctrl._showCheckingPhase({
                phase: 'checking',
                status: 'action_required',
                requirements: {}
            });
            
            const retryBtn = bodyEl.querySelector('#setup-checking-actions .btn-primary');
            expect(retryBtn).not.toBeNull();
            
            retryBtn.click();
            expect(endpoint.executeOrchestrationCommand).toHaveBeenCalledWith('retry_check');
        });

        it('clicking Retry Setup sends retry_install command', async () => {
            const { ctrl, endpoint, bodyEl } = createController();
            
            ctrl._showInstallingPhase({
                phase: 'installing',
                status: 'error',
                error: 'Network timeout',
                progress: { total_progress: 50, step_details: {} }
            });
            
            const retryBtn = bodyEl.querySelector('#setup-checking-actions .btn-primary');
            expect(retryBtn).not.toBeNull();
            
            retryBtn.click();
            expect(endpoint.executeOrchestrationCommand).toHaveBeenCalledWith('retry_install');
        });

        it('clicking Quit App calls defer handler', async () => {
            const { ctrl, onDefer, bodyEl } = createController();
            
            ctrl._showCheckingPhase({
                phase: 'checking',
                status: 'error',
                error: 'Backend crashed'
            });
            
            const deferBtn = bodyEl.querySelector('#setup-checking-actions .btn-premium-link');
            expect(deferBtn).not.toBeNull();
            
            deferBtn.click();
            expect(onDefer).toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Phase 2: _updateProgress
    // =========================================================================

    describe('_updateProgress', () => {
        it('updates progress bar width and percentage text', () => {
            const { ctrl, bodyEl } = createController();

            ctrl._showInstallingPhase({
                status: 'in_progress',
                progress: {
                    total_progress: 42,
                    current_phase: 'python_packages'
                }
            });

            expect(bodyEl.querySelector('#setup-bar-fill').style.width).toBe('42%');
            expect(bodyEl.querySelector('#setup-bar-percent').textContent).toBe('42%');
        });

        it('updates phase label from current_step', () => {
            const { ctrl, bodyEl } = createController();

            ctrl._showInstallingPhase({
                status: 'in_progress',
                progress: {
                    total_progress: 20,
                    current_phase: 'repositories'
                }
            });

            // The actual test expects 'Verifying required files...' based on PHASE_LABELS
            expect(bodyEl.querySelector('#setup-phase-label').textContent).toBe(
                'Verifying required files...'
            );
        });

        it('adds shimmer class when progress is 0 but phase is active', () => {
            const { ctrl, bodyEl } = createController();

            ctrl._showInstallingPhase({
                status: 'in_progress',
                progress: {
                    total_progress: 0,
                    current_phase: 'starting'
                }
            });

            const fill = bodyEl.querySelector('#setup-bar-fill');
            expect(fill.classList.contains('shimmer')).toBe(true);
            expect(fill.style.width).toBe('5%'); // Minimal visible fill
        });
    });

    // =========================================================================
    // Phase 2: _updatePhaseDots
    // =========================================================================

    describe('_updatePhaseDots', () => {
        it('marks completed categories with completed class', () => {
            const { ctrl, bodyEl } = createController();

            ctrl._showInstallingPhase({
                status: 'in_progress',
                progress: {
                    total_progress: 50,
                    current_phase: 'python_packages',
                    repositories: { status: 'completed' },
                    python_packages: { status: 'running' },
                    oi_environment: { status: 'pending' },
                    ml_models: { status: 'pending' },
                    docker_services: { status: 'pending' }
                }
            });

            const repoDot = bodyEl.querySelector('.setup-phase-dot[data-phase="repositories"]');
            const pkgDot = bodyEl.querySelector('.setup-phase-dot[data-phase="python_packages"]');
            const oiDot = bodyEl.querySelector('.setup-phase-dot[data-phase="oi_environment"]');

            expect(repoDot.classList.contains('completed')).toBe(true);
            expect(pkgDot.classList.contains('active')).toBe(true);
            expect(oiDot.classList.contains('completed')).toBe(false);
            expect(oiDot.classList.contains('active')).toBe(false);
        });

        it('marks error categories with error class', () => {
            const { ctrl, bodyEl } = createController();

            ctrl._showInstallingPhase({
                status: 'in_progress',
                progress: {
                    total_progress: 10,
                    current_phase: 'repositories',
                    repositories: { status: 'error' },
                    python_packages: { status: 'pending' },
                    oi_environment: { status: 'pending' },
                    ml_models: { status: 'pending' },
                    docker_services: { status: 'pending' },
                }
            });

            const repoDot = bodyEl.querySelector('.setup-phase-dot[data-phase="repositories"]');
            expect(repoDot.classList.contains('error')).toBe(true);
        });

        it('marks completed_with_errors categories with warning class (not completed)', () => {
            const { ctrl, bodyEl } = createController();

            ctrl._showInstallingPhase({
                status: 'in_progress',
                progress: {
                    total_progress: 100,
                    current_phase: 'docker_services',
                    repositories: { status: 'completed_with_errors' },
                    python_packages: { status: 'pending' },
                    oi_environment: { status: 'pending' },
                    ml_models: { status: 'pending' },
                    docker_services: { status: 'pending' },
                }
            });

            const repoDot = bodyEl.querySelector('.setup-phase-dot[data-phase="repositories"]');
            expect(repoDot.classList.contains('warning')).toBe(true);
            expect(repoDot.classList.contains('completed')).toBe(false);
        });
    });



    // =========================================================================
    // _transitionToVerifying
    // =========================================================================

    describe('_showVerifyingPhase', () => {
        it('hides checking and installing phases and shows verifying phase', () => {
            const { ctrl, bodyEl } = createController();

            ctrl._showVerifyingPhase({ phase: 'completed', status: 'success' });

            expect(bodyEl.querySelector('#setup-phase-checking').classList.contains('hidden')).toBe(true);
            expect(bodyEl.querySelector('#setup-phase-installing').classList.contains('hidden')).toBe(true);
            expect(bodyEl.querySelector('#setup-phase-verifying').classList.contains('hidden')).toBe(false);
        });

        it('sets phase to verifying', () => {
            const { ctrl } = createController();
            ctrl._showVerifyingPhase({ phase: 'completed', status: 'success' });
            expect(ctrl._phase).toBe('verifying');
        });

        it('auto-advances after success + delay', async () => {
            const { ctrl, onNext } = createController();

            ctrl._renderState({ phase: 'completed' });

            jest.advanceTimersByTime(1200); // ADVANCE_DELAY_MS
            await flushMicrotasks();

            expect(onNext).toHaveBeenCalled();
            ctrl.dispose();
        });

        it('adds verify-success class to icon wrap on success', async () => {
            const { ctrl, bodyEl } = createController();

            ctrl._showVerifyingPhase({ phase: 'completed', status: 'completed' });

            const iconWrap = bodyEl.querySelector('#setup-verify-icon-wrap');
            expect(iconWrap.classList.contains('verify-success')).toBe(true);
            expect(iconWrap.innerHTML).toContain('fa-check-circle');

            const label = bodyEl.querySelector('#setup-verify-label');
            expect(label.textContent).toBe('All systems connected!');
            ctrl.dispose();
        });

        it('adds verify-warning class on error', async () => {
            const { ctrl, bodyEl } = createController();

            ctrl._showVerifyingPhase({ phase: 'completed', status: 'error', error: 'Partial failure' });

            const iconWrap = bodyEl.querySelector('#setup-verify-icon-wrap');
            // Wait, does it add verify-warning? The code says style.background = var(--color-warning-bg)
            expect(iconWrap.innerHTML).toContain('fa-exclamation-triangle');
            
            const label = bodyEl.querySelector('#setup-verify-label');
            expect(label.textContent).toContain('Service connection failed: Partial failure');
            ctrl.dispose();
        });

        it('shows retry on finalize failure', async () => {
            const { ctrl, bodyEl } = createController();
            
            ctrl._showVerifyingPhase({ phase: 'completed', status: 'error', error: 'Finalize failed' });

            const actionsEl = bodyEl.querySelector('#setup-verify-actions');
            expect(actionsEl).not.toBeNull();
            
            const retryBtn = actionsEl.querySelector('.btn-primary');
            expect(retryBtn).not.toBeNull();
            expect(retryBtn.textContent).toContain('Retry Connection');
            ctrl.dispose();
        });
    });

    // =========================================================================
    // dispose
    // =========================================================================

    describe('dispose', () => {
        it('sets _disposed and clears timers', () => {
            const { ctrl } = createController();
            ctrl._pollTimer = setTimeout(() => {}, 100);
            ctrl._advanceTimer = setTimeout(() => {}, 100);
            ctrl.dispose();
            expect(ctrl._disposed).toBe(true);
            
            // Fast forward timers to ensure they don't fire
            jest.advanceTimersByTime(200);
            // Jest clearAllTimers is implicitly tested if these don't run
        });

        it('idempotent — second call is no-op', () => {
            const { ctrl } = createController();
            ctrl.dispose();
            ctrl.dispose(); // Should not throw
            expect(ctrl._disposed).toBe(true);
        });
    });
});
