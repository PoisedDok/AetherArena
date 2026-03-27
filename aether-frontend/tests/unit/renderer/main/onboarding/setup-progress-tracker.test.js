'use strict';

// ---------------------------------------------------------------------------
// SetupProgressTracker — Unit tests
// ---------------------------------------------------------------------------
// Tests ETA calculation (with hysteresis), detail panel, phase dots,
// phase hints, auto-expand on slow phases, adaptive banner, and elapsed timer.
// ---------------------------------------------------------------------------

const SetupProgressTracker = require(
    '../../../../../src/renderer/main/modules/onboarding/modules/SetupProgressTracker'
);
const StepTemplates = require(
    '../../../../../src/renderer/main/modules/onboarding/modules/OnboardingStepTemplates'
);

const { PHASE_LABELS, PHASE_ORDER, PHASE_META } = SetupProgressTracker;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createBodyEl() {
    const el = document.createElement('div');
    el.innerHTML = StepTemplates.renderSetup();
    return el;
}

function createTracker(bodyEl) {
    if (!bodyEl) bodyEl = createBodyEl();
    const escapeHtml = jest.fn((s) => s || '');
    const tracker = new SetupProgressTracker({ bodyEl, escapeHtml });
    return { tracker, bodyEl, escapeHtml };
}

function makePhaseData(overrides = {}) {
    return {
        total_progress: 0,
        current_phase: 'idle',
        repositories: { status: 'pending', progress: 0, message: '' },
        python_packages: { status: 'pending', progress: 0, message: '' },
        oi_environment: { status: 'pending', progress: 0, message: '' },
        inference_environment: { status: 'pending', progress: 0, message: '' },
        ml_models: { status: 'pending', progress: 0, message: '' },
        docker_services: { status: 'pending', progress: 0, message: '' },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SetupProgressTracker', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // =========================================================================
    // Exports
    // =========================================================================

    describe('static exports', () => {
        it('exports PHASE_LABELS with expected keys', () => {
            expect(PHASE_LABELS).toBeDefined();
            expect(PHASE_LABELS.idle).toBe('Waiting to start...');
            expect(PHASE_LABELS.completed).toBe('Setup complete!');
            expect(PHASE_LABELS.docker_services).toBe('Starting background services...');
        });

        it('exports PHASE_ORDER with 6 phases', () => {
            expect(PHASE_ORDER).toHaveLength(6);
            expect(PHASE_ORDER[0]).toBe('repositories');
            expect(PHASE_ORDER[5]).toBe('docker_services');
        });

        it('exports PHASE_META with weights summing to 1.0', () => {
            expect(PHASE_META).toBeDefined();
            const totalWeight = PHASE_ORDER.reduce((sum, key) => sum + (PHASE_META[key]?.weight || 0), 0);
            expect(totalWeight).toBeCloseTo(1.0, 2);
        });

        it('every PHASE_ORDER key has a matching PHASE_META entry with hint', () => {
            for (const key of PHASE_ORDER) {
                expect(PHASE_META[key]).toBeDefined();
                expect(typeof PHASE_META[key].hint).toBe('string');
                expect(PHASE_META[key].hint.length).toBeGreaterThan(0);
            }
        });
    });

    // =========================================================================
    // constructor + init
    // =========================================================================

    describe('constructor', () => {
        it('initializes with disposed=false and empty timers', () => {
            const { tracker } = createTracker();
            expect(tracker._disposed).toBe(false);
            expect(tracker._timers).toEqual([]);
        });

        it('initializes ETA hysteresis state', () => {
            const { tracker } = createTracker();
            expect(tracker._lastDisplayedETA).toBeNull();
            expect(tracker._etaStableTime).toBe(0);
        });

        it('initializes userCollapsed to false', () => {
            const { tracker } = createTracker();
            expect(tracker._userCollapsed).toBe(false);
        });
    });

    describe('init', () => {
        it('resets progress history and starts elapsed timer', () => {
            const { tracker } = createTracker();
            tracker._progressHistory = [{ time: 1, progress: 10 }];
            tracker.init();
            expect(tracker._progressHistory).toEqual([]);
            expect(tracker._startTime).not.toBeNull();
            expect(tracker._elapsedTimerId).not.toBeNull();
        });
    });

    // =========================================================================
    // updateProgress
    // =========================================================================

    describe('updateProgress', () => {
        it('updates progress bar width and percent text', () => {
            const { tracker, bodyEl } = createTracker();
            tracker.updateProgress(makePhaseData({ total_progress: 42, current_phase: 'python_packages' }));

            expect(bodyEl.querySelector('#setup-bar-fill').style.width).toBe('42%');
            expect(bodyEl.querySelector('#setup-bar-percent').textContent).toBe('42%');
        });

        it('updates phase label from PHASE_LABELS map', () => {
            const { tracker, bodyEl } = createTracker();
            tracker.updateProgress(makePhaseData({ total_progress: 20, current_phase: 'repositories' }));

            expect(bodyEl.querySelector('#setup-phase-label').textContent).toBe('Verifying required files...');
        });

        it('prefers real backend message when phase is in_progress', () => {
            const { tracker, bodyEl } = createTracker();
            tracker.updateProgress(makePhaseData({
                total_progress: 50,
                current_phase: 'docker_services',
                docker_services: { status: 'in_progress', progress: 50, message: 'Pulling image redis:7...' },
            }));

            expect(bodyEl.querySelector('#setup-phase-label').textContent).toBe('Pulling image redis:7...');
        });

        it('shows shimmer when progress is 0 but phase is active', () => {
            const { tracker, bodyEl } = createTracker();
            tracker.updateProgress(makePhaseData({ total_progress: 0, current_phase: 'starting' }));

            const fill = bodyEl.querySelector('#setup-bar-fill');
            expect(fill.style.width).toBe('5%');
            expect(fill.classList.contains('shimmer')).toBe(true);
        });

        it('updates phase hint when transitioning to a new phase', () => {
            const { tracker, bodyEl } = createTracker();
            tracker.updateProgress(makePhaseData({ total_progress: 50, current_phase: 'docker_services' }));

            const hintEl = bodyEl.querySelector('#setup-phase-hint');
            expect(hintEl.textContent).toBe(PHASE_META.docker_services.hint);
            expect(hintEl.classList.contains('hidden')).toBe(false);
        });

        it('hides phase hint for non-meta phases like idle', () => {
            const { tracker, bodyEl } = createTracker();
            tracker.updateProgress(makePhaseData({ total_progress: 0, current_phase: 'idle' }));

            const hintEl = bodyEl.querySelector('#setup-phase-hint');
            expect(hintEl.classList.contains('hidden')).toBe(true);
        });
    });

    // =========================================================================
    // Phase dots
    // =========================================================================

    describe('_updatePhaseDots', () => {
        it('marks completed categories', () => {
            const { tracker, bodyEl } = createTracker();
            tracker._updatePhaseDots(makePhaseData({
                repositories: { status: 'completed', progress: 100 },
                python_packages: { status: 'running', progress: 50 },
                current_phase: 'python_packages',
            }));

            const repoDot = bodyEl.querySelector('.setup-phase-dot[data-phase="repositories"]');
            const pkgDot = bodyEl.querySelector('.setup-phase-dot[data-phase="python_packages"]');
            expect(repoDot.classList.contains('completed')).toBe(true);
            expect(pkgDot.classList.contains('active')).toBe(true);
        });

        it('marks error categories with error class', () => {
            const { tracker, bodyEl } = createTracker();
            tracker._updatePhaseDots(makePhaseData({
                repositories: { status: 'error', progress: 0 },
            }));

            const dot = bodyEl.querySelector('.setup-phase-dot[data-phase="repositories"]');
            expect(dot.classList.contains('error')).toBe(true);
        });

        it('marks completed_with_errors as warning', () => {
            const { tracker, bodyEl } = createTracker();
            tracker._updatePhaseDots(makePhaseData({
                repositories: { status: 'completed_with_errors', progress: 100 },
            }));

            const dot = bodyEl.querySelector('.setup-phase-dot[data-phase="repositories"]');
            expect(dot.classList.contains('warning')).toBe(true);
            expect(dot.classList.contains('completed')).toBe(false);
        });
    });

    // =========================================================================
    // Detail panel
    // =========================================================================

    describe('detail panel', () => {
        it('_bindDetailToggle toggles collapsed class on click', () => {
            const { tracker, bodyEl } = createTracker();
            tracker._bindDetailToggle();

            const btn = bodyEl.querySelector('#setup-detail-btn');
            const panel = bodyEl.querySelector('#setup-detail-panel');

            expect(panel.classList.contains('collapsed')).toBe(true);
            btn.click();
            expect(panel.classList.contains('collapsed')).toBe(false);
            expect(tracker._detailExpanded).toBe(true);
            btn.click();
            expect(panel.classList.contains('collapsed')).toBe(true);
            expect(tracker._detailExpanded).toBe(false);
        });

        it('sets _userCollapsed when user manually collapses', () => {
            const { tracker, bodyEl } = createTracker();
            tracker._bindDetailToggle();
            const btn = bodyEl.querySelector('#setup-detail-btn');

            // Open
            btn.click();
            expect(tracker._userCollapsed).toBe(false);

            // Close (user explicitly collapsed)
            btn.click();
            expect(tracker._userCollapsed).toBe(true);
        });

        it('_updateDetailPanel renders 6 phase rows', () => {
            const { tracker, bodyEl } = createTracker();
            tracker._updateDetailPanel(makePhaseData());

            const rows = bodyEl.querySelectorAll('.setup-detail-row');
            expect(rows.length).toBe(6);
        });

        it('active phase row shows hint subtitle', () => {
            const { tracker, bodyEl } = createTracker();
            tracker._updateDetailPanel(makePhaseData({
                current_phase: 'docker_services',
                docker_services: { status: 'in_progress', progress: 30, message: 'Pulling...' },
            }));

            const activeRow = bodyEl.querySelector('.setup-detail-row.active');
            expect(activeRow).not.toBeNull();
            const hint = activeRow.querySelector('.detail-row-hint');
            expect(hint).not.toBeNull();
            expect(hint.textContent).toBe(PHASE_META.docker_services.hint);
        });

        it('completed phase rows show elapsed time when tracked', () => {
            const { tracker, bodyEl } = createTracker();
            tracker._phaseStartTimes.repositories = Date.now() - 15000;

            tracker._updateDetailPanel(makePhaseData({
                current_phase: 'python_packages',
                repositories: { status: 'completed', progress: 100, message: 'Done' },
            }));

            const elapsedEls = bodyEl.querySelectorAll('.detail-row-elapsed');
            expect(elapsedEls.length).toBeGreaterThan(0);
            expect(elapsedEls[0].textContent).toContain('s');
        });
    });

    // =========================================================================
    // Auto-expand on slow phases
    // =========================================================================

    describe('auto-expand', () => {
        it('auto-expands detail panel when docker_services becomes active', () => {
            const { tracker, bodyEl } = createTracker();
            tracker._bindDetailToggle();

            expect(tracker._detailExpanded).toBe(false);

            tracker.updateProgress(makePhaseData({
                total_progress: 60,
                current_phase: 'docker_services',
                docker_services: { status: 'in_progress', progress: 10, message: 'Starting...' },
            }));

            expect(tracker._detailExpanded).toBe(true);
        });

        it('auto-expands on inference_environment', () => {
            const { tracker, bodyEl } = createTracker();
            tracker._bindDetailToggle();

            tracker.updateProgress(makePhaseData({
                total_progress: 30,
                current_phase: 'inference_environment',
                inference_environment: { status: 'in_progress', progress: 5, message: 'Downloading...' },
            }));

            expect(tracker._detailExpanded).toBe(true);
        });

        it('does NOT auto-expand if user manually collapsed', () => {
            const { tracker, bodyEl } = createTracker();
            tracker._bindDetailToggle();

            // User opens then closes
            const btn = bodyEl.querySelector('#setup-detail-btn');
            btn.click();
            btn.click();
            expect(tracker._userCollapsed).toBe(true);

            tracker.updateProgress(makePhaseData({
                total_progress: 60,
                current_phase: 'docker_services',
                docker_services: { status: 'in_progress', progress: 10, message: 'Starting...' },
            }));

            expect(tracker._detailExpanded).toBe(false);
        });

        it('does NOT auto-expand on non-slow phases like repositories', () => {
            const { tracker, bodyEl } = createTracker();
            tracker._bindDetailToggle();

            tracker.updateProgress(makePhaseData({
                total_progress: 5,
                current_phase: 'repositories',
                repositories: { status: 'in_progress', progress: 50, message: 'Checking...' },
            }));

            expect(tracker._detailExpanded).toBe(false);
        });
    });

    // =========================================================================
    // ETA hysteresis
    // =========================================================================

    describe('ETA hysteresis', () => {
        it('shows "Estimating time remaining..." for first 15 seconds', () => {
            const { tracker, bodyEl } = createTracker();
            tracker.init();

            tracker.updateProgress(makePhaseData({ total_progress: 10, current_phase: 'repositories' }));

            const etaEl = bodyEl.querySelector('#setup-eta');
            expect(etaEl.textContent).toBe('Estimating time remaining...');
        });

        it('shows "Almost done..." when progress >= 95', () => {
            const { tracker, bodyEl } = createTracker();
            tracker.init();

            tracker.updateProgress(makePhaseData({ total_progress: 97, current_phase: 'docker_services' }));

            expect(bodyEl.querySelector('#setup-eta').textContent).toBe('Almost done...');
        });

        it('rounds large ETAs to nearest 5 minutes', () => {
            const { tracker } = createTracker();
            // 12 minutes -> ceil to 15
            expect(tracker._formatETA(720)).toBe('~15 minutes remaining');
            // 22 minutes -> ceil to 25
            expect(tracker._formatETA(1320)).toBe('~25 minutes remaining');
        });

        it('returns exact minutes for small ETAs', () => {
            const { tracker } = createTracker();
            expect(tracker._formatETA(180)).toBe('~3 minutes remaining');
            expect(tracker._formatETA(60)).toBe('~1 minute remaining');
            expect(tracker._formatETA(30)).toBe('Less than a minute remaining');
        });

        it('returns "Estimating..." for null', () => {
            const { tracker } = createTracker();
            expect(tracker._formatETA(null)).toBe('Estimating...');
        });
    });

    // =========================================================================
    // Adaptive banner
    // =========================================================================

    describe('updateBannerEstimate', () => {
        it('shows cached message when both docker and venvs exist', () => {
            const { tracker, bodyEl } = createTracker();
            tracker.updateBannerEstimate({ dockerImagesCached: true, venvsExist: true });

            const banner = bodyEl.querySelector('#setup-install-banner');
            const firstRow = banner.querySelector('.install-banner-row span');
            expect(firstRow.textContent).toContain('5');
            expect(firstRow.textContent).toContain('10 minutes');
        });

        it('shows partial cache message when only docker cached', () => {
            const { tracker, bodyEl } = createTracker();
            tracker.updateBannerEstimate({ dockerImagesCached: true, venvsExist: false });

            const banner = bodyEl.querySelector('#setup-install-banner');
            const firstRow = banner.querySelector('.install-banner-row span');
            expect(firstRow.textContent).toContain('10');
            expect(firstRow.textContent).toContain('15 minutes');
        });

        it('shows fresh install message when nothing cached', () => {
            const { tracker, bodyEl } = createTracker();
            tracker.updateBannerEstimate({ dockerImagesCached: false, venvsExist: false });

            const banner = bodyEl.querySelector('#setup-install-banner');
            const firstRow = banner.querySelector('.install-banner-row span');
            expect(firstRow.textContent).toContain('15');
            expect(firstRow.textContent).toContain('30 minutes');
        });
    });

    // =========================================================================
    // Elapsed timer
    // =========================================================================

    describe('elapsed timer', () => {
        it('updates elapsed display every second', () => {
            const { tracker, bodyEl } = createTracker();
            tracker.init();

            jest.advanceTimersByTime(3000);

            const elapsed = bodyEl.querySelector('#setup-elapsed');
            expect(elapsed.textContent).toContain('3s elapsed');
        });

        it('shows minutes after 60s', () => {
            const { tracker, bodyEl } = createTracker();
            tracker.init();

            jest.advanceTimersByTime(65000);

            const elapsed = bodyEl.querySelector('#setup-elapsed');
            expect(elapsed.textContent).toContain('1m 05s elapsed');
        });

        it('stopElapsedTimer clears interval', () => {
            const { tracker } = createTracker();
            tracker.init();
            expect(tracker._elapsedTimerId).not.toBeNull();

            tracker.stopElapsedTimer();
            expect(tracker._elapsedTimerId).toBeNull();
        });
    });

    // =========================================================================
    // dispose
    // =========================================================================

    describe('dispose', () => {
        it('sets disposed flag and clears timers', () => {
            const { tracker } = createTracker();
            tracker.init();

            tracker._progressHistory.push({ time: 1, progress: 10 });
            tracker.dispose();

            expect(tracker._disposed).toBe(true);
            expect(tracker._timers).toEqual([]);
            expect(tracker._progressHistory).toEqual([]);
        });

        it('is idempotent on double dispose', () => {
            const { tracker } = createTracker();
            tracker.init();
            tracker.dispose();
            expect(() => tracker.dispose()).not.toThrow();
        });

        it('removes detail toggle listener', () => {
            const { tracker, bodyEl } = createTracker();
            tracker._bindDetailToggle();
            const btn = bodyEl.querySelector('#setup-detail-btn');

            tracker.dispose();

            // Clicking after dispose should not toggle (listener removed)
            const panel = bodyEl.querySelector('#setup-detail-panel');
            const collapsedBefore = panel.classList.contains('collapsed');
            btn.click();
            expect(panel.classList.contains('collapsed')).toBe(collapsedBefore);
        });
    });

    // =========================================================================
    // _calculateETA
    // =========================================================================

    describe('_calculateETA', () => {
        it('returns null when progress is 0', () => {
            const { tracker } = createTracker();
            expect(tracker._calculateETA(0)).toBeNull();
        });

        it('returns null when progress is 100', () => {
            const { tracker } = createTracker();
            expect(tracker._calculateETA(100)).toBeNull();
        });

        it('returns null with insufficient history', () => {
            const { tracker } = createTracker();
            tracker._progressHistory = [{ time: 1000, progress: 10 }];
            expect(tracker._calculateETA(50)).toBeNull();
        });

        it('calculates ETA from progress rate', () => {
            const { tracker } = createTracker();
            const now = Date.now();
            tracker._progressHistory = [
                { time: now - 10000, progress: 10 },
                { time: now, progress: 20 },
            ];

            const eta = tracker._calculateETA(20);
            // 10% in 10s = 1%/s. 80% remaining = 80s
            expect(eta).toBe(80);
        });

        it('returns null when time delta < 5s', () => {
            const { tracker } = createTracker();
            const now = Date.now();
            tracker._progressHistory = [
                { time: now - 3000, progress: 10 },
                { time: now, progress: 20 },
            ];
            expect(tracker._calculateETA(20)).toBeNull();
        });

        it('returns null when progress delta <= 0', () => {
            const { tracker } = createTracker();
            const now = Date.now();
            tracker._progressHistory = [
                { time: now - 10000, progress: 50 },
                { time: now, progress: 50 },
            ];
            expect(tracker._calculateETA(50)).toBeNull();
        });
    });
});
