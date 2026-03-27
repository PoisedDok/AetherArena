/**
 * @.architecture
 *
 * Incoming: SetupStepController --- {method_call}
 * Processing: Track setup progress, calculate adaptive ETA with hysteresis,
 *             manage detail panel with phase hints and auto-expand on slow phases,
 *             update phase dots, elapsed timer, shimmer animation.
 *             --- {JOB_TRACK_PROGRESS, JOB_ETA, JOB_DETAIL_PANEL, JOB_PHASE_DOTS}
 * Outgoing: DOM updates to progress elements --- {dom_update}
 *
 * Owns: progress history, ETA calculation, elapsed timer, detail panel toggle,
 *       phase dot state, shimmer animation. Does NOT own fetch/polling — that stays
 *       in SetupStepController.
 *
 * @module renderer/main/modules/onboarding/modules/SetupProgressTracker
 */

'use strict';

/**
 * Human-readable labels for backend setup phases.
 * Maps `current_phase` from the backend status response to user-visible text.
 */
const PHASE_LABELS = {
    idle: 'Waiting to start...',
    starting: 'Preparing setup...',
    repositories: 'Verifying required files...',
    python_packages: 'Installing required software...',
    oi_environment: 'Setting up AI engine...',
    inference_environment: 'Setting up local AI models...',
    ml_models: 'Downloading voice models...',
    docker_services: 'Starting background services...',
    completed: 'Setup complete!',
    error: 'Setup ran into a problem.',
    skipped: 'Setup skipped.',
};

/**
 * Backend category keys in execution order (for phase dot progression).
 */
const PHASE_ORDER = [
    'repositories',
    'python_packages',
    'oi_environment',
    'inference_environment',
    'ml_models',
    'docker_services',
];

/**
 * Phase metadata: weights for ETA calculation + contextual hints for users.
 * Weights reflect typical relative durations (sum = 1.0).
 * Hints shown in the detail panel and as contextual subtitles.
 */
const PHASE_META = {
    repositories:          { weight: 0.02, hint: 'Verifying bundled files (instant if cached)' },
    python_packages:       { weight: 0.03, hint: 'Installing small helper packages' },
    oi_environment:        { weight: 0.15, hint: 'Setting up AI runtime environment' },
    inference_environment: { weight: 0.25, hint: 'Downloading on-device AI models (~1\u20133 GB)' },
    ml_models:             { weight: 0.10, hint: 'Downloading voice synthesis models (~500 MB)' },
    docker_services:       { weight: 0.45, hint: 'Downloading and starting local services (~2 GB on first run)' },
};

/**
 * Phases that are known to be slow and warrant auto-expanding the detail panel.
 */
const SLOW_PHASES = new Set(['docker_services', 'inference_environment']);

/**
 * Short labels for detail panel rows.
 */
const DETAIL_ROW_LABELS = {
    repositories: 'Verify',
    python_packages: 'Packages',
    oi_environment: 'AI Runtime',
    inference_environment: 'Inference',
    ml_models: 'Voice',
    docker_services: 'Services',
};

class SetupProgressTracker {
    /**
     * @param {Object} opts
     * @param {HTMLElement} opts.bodyEl - Modal body for DOM queries
     * @param {Function} opts.escapeHtml - HTML escape utility
     */
    constructor({ bodyEl, escapeHtml }) {
        this._bodyEl = bodyEl;
        this._escapeHtml = escapeHtml;

        // Timing
        this._startTime = null;
        this._elapsedTimerId = null;
        this._timers = [];

        // Progress tracking
        this._lastProgress = -1;
        this._lastProgressTime = 0;
        this._progressHistory = [];
        this._lastPhase = null;

        // Per-phase elapsed tracking
        this._phaseStartTimes = {};

        // ETA hysteresis state
        this._lastDisplayedETA = null;
        this._etaStableTime = 0;
        this._etaInitTime = 0;

        // Detail panel
        this._detailExpanded = false;
        this._userCollapsed = false;
        this._detailToggleListener = null;

        this._disposed = false;
    }

    /**
     * Initialize the tracker: bind detail toggle, reset history, start elapsed timer.
     * Called when transitioning to the installing phase.
     */
    init() {
        this._progressHistory = [];
        this._phaseStartTimes = {};
        this._lastDisplayedETA = null;
        this._etaStableTime = 0;
        this._startTime = Date.now();
        this._etaInitTime = Date.now();
        this._bindDetailToggle();
        this._startElapsedTimer();
    }

    // =========================================================================
    // PROGRESS UPDATE (main entry point, called every poll cycle)
    // =========================================================================

    /**
     * Update the unified progress UI from backend status data.
     * Uses REAL backend messages when available, falls back to PHASE_LABELS.
     * Updates ETA, phase dots, detail panel, and phase hint.
     * @param {Object} data - Backend /v1/setup/status response
     */
    updateProgress(data) {
        const labelEl = this._bodyEl.querySelector('#setup-phase-label');
        const fillEl = this._bodyEl.querySelector('#setup-bar-fill');
        const percentEl = this._bodyEl.querySelector('#setup-bar-percent');

        const progress = Math.min(data.total_progress || 0, 100);
        if (fillEl) {
            fillEl.style.width = `${progress}%`;

            const now = Date.now();
            if (progress !== this._lastProgress) {
                this._lastProgress = progress;
                this._lastProgressTime = now;
                fillEl.classList.remove('shimmer');
            } else if (now - this._lastProgressTime > 5000 && progress < 100 && progress > 0) {
                fillEl.classList.add('shimmer');
            }

            if (progress === 0 && data.current_phase && data.current_phase !== 'idle') {
                fillEl.style.width = '5%';
                fillEl.classList.add('shimmer');
            }
        }

        if (percentEl) {
            percentEl.textContent = `${Math.round(progress)}%`;
        }

        // Update phase label
        const phase = data.current_phase || 'idle';
        if (labelEl) {
            const phaseData = data[phase];
            const backendMessage = phaseData && phaseData.message && phaseData.status === 'in_progress'
                ? phaseData.message
                : null;
            labelEl.textContent = backendMessage || PHASE_LABELS[phase] || `Processing: ${phase}...`;
        }

        // Track per-phase start times
        if (phase !== this._lastPhase && PHASE_ORDER.includes(phase)) {
            if (!this._phaseStartTimes[phase]) {
                this._phaseStartTimes[phase] = Date.now();
            }
            this._lastPhase = phase;

            // Auto-expand detail panel on slow phases (unless user explicitly collapsed)
            if (SLOW_PHASES.has(phase) && !this._userCollapsed) {
                this._autoExpandPanel();
            }
        }

        // Update phase hint subtitle
        this._updatePhaseHint(phase);

        // Record progress sample for ETA sliding window
        this._progressHistory.push({ time: Date.now(), progress });
        const cutoff = Date.now() - 60000;
        while (this._progressHistory.length > 1 && this._progressHistory[0].time < cutoff) {
            this._progressHistory.shift();
        }

        this._updateETADisplay(progress);
        this._updatePhaseDots(data);
        this._updateDetailPanel(data);
    }

    // =========================================================================
    // PHASE HINT (contextual message under main label)
    // =========================================================================

    /**
     * Update the phase hint subtitle element with contextual info from PHASE_META.
     * @param {string} phase - Current phase key
     */
    _updatePhaseHint(phase) {
        const hintEl = this._bodyEl.querySelector('#setup-phase-hint');
        if (!hintEl) return;

        const meta = PHASE_META[phase];
        if (meta && meta.hint) {
            hintEl.textContent = meta.hint;
            hintEl.classList.remove('hidden');
        } else {
            hintEl.textContent = '';
            hintEl.classList.add('hidden');
        }
    }

    // =========================================================================
    // ETA (with hysteresis for smooth display)
    // =========================================================================

    /**
     * Calculate ETA from sliding window of progress samples.
     * @returns {number|null} Estimated seconds remaining, or null if insufficient data.
     */
    _calculateETA(currentProgress) {
        if (currentProgress <= 0 || currentProgress >= 100) return null;
        if (this._progressHistory.length < 2) return null;

        const oldest = this._progressHistory[0];
        const newest = this._progressHistory[this._progressHistory.length - 1];
        const timeDelta = newest.time - oldest.time;
        const progressDelta = newest.progress - oldest.progress;

        if (timeDelta < 5000 || progressDelta <= 0) return null;

        const rate = progressDelta / timeDelta;
        const remaining = 100 - currentProgress;
        const etaMs = remaining / rate;

        return Math.max(0, Math.round(etaMs / 1000));
    }

    /**
     * Format ETA seconds into human-readable string.
     * Rounds large values to nearest 5 minutes for psychological comfort.
     * @param {number|null} seconds
     * @returns {string}
     */
    _formatETA(seconds) {
        if (seconds === null) return 'Estimating...';
        if (seconds < 60) return 'Less than a minute remaining';
        const mins = Math.ceil(seconds / 60);
        if (mins > 10) {
            const rounded = Math.ceil(mins / 5) * 5;
            return `~${rounded} minutes remaining`;
        }
        return mins === 1 ? '~1 minute remaining' : `~${mins} minutes remaining`;
    }

    /**
     * Update the ETA display element with hysteresis to prevent wild fluctuation.
     * - Delays first ETA display for 15 seconds of data
     * - Dampens large swings (>50% change) with "Recalculating..." pause
     * - Only updates displayed ETA when the new value has been stable
     * @param {number} progress - Current total progress (0-100)
     */
    _updateETADisplay(progress) {
        const etaEl = this._bodyEl.querySelector('#setup-eta');
        if (!etaEl) return;

        if (progress >= 95) {
            etaEl.textContent = 'Almost done...';
            this._lastDisplayedETA = null;
            return;
        }

        if (progress <= 0) {
            etaEl.textContent = '';
            return;
        }

        // Don't show ETA until 15 seconds of progress data collected
        const timeSinceInit = Date.now() - this._etaInitTime;
        if (timeSinceInit < 15000) {
            etaEl.textContent = 'Estimating time remaining...';
            return;
        }

        const etaSeconds = this._calculateETA(progress);

        if (etaSeconds === null) {
            etaEl.textContent = 'Estimating...';
            return;
        }

        // Hysteresis: if ETA changed by >50% from last displayed, pause
        if (this._lastDisplayedETA !== null && this._lastDisplayedETA > 0) {
            const ratio = etaSeconds / this._lastDisplayedETA;
            if (ratio > 1.5 || ratio < 0.5) {
                const now = Date.now();
                if (this._etaStableTime === 0) {
                    this._etaStableTime = now;
                }
                // Wait 5 seconds for new rate to stabilize before updating
                if (now - this._etaStableTime < 5000) {
                    etaEl.textContent = 'Recalculating...';
                    return;
                }
                // Stabilization period passed — accept new ETA
                this._etaStableTime = 0;
            } else {
                this._etaStableTime = 0;
            }
        }

        this._lastDisplayedETA = etaSeconds;
        etaEl.textContent = this._formatETA(etaSeconds);
    }

    // =========================================================================
    // PHASE DOTS
    // =========================================================================

    /**
     * Update the 6 phase dots based on category status.
     * @param {Object} data - Backend status response
     */
    _updatePhaseDots(data) {
        for (const key of PHASE_ORDER) {
            const dotEl = this._bodyEl.querySelector(`.setup-phase-dot[data-phase="${key}"]`);
            if (!dotEl) continue;

            const category = data[key];
            if (!category) continue;

            dotEl.classList.remove('active', 'completed', 'warning', 'error');

            if (category.status === 'completed' || category.status === 'skipped') {
                dotEl.classList.add('completed');
            } else if (category.status === 'completed_with_errors') {
                dotEl.classList.add('warning');
            } else if (category.status === 'error') {
                dotEl.classList.add('error');
            } else if (category.status === 'running' || category.status === 'in_progress' ||
                       data.current_phase === key) {
                dotEl.classList.add('active');
            }
        }
    }

    // =========================================================================
    // DETAIL PANEL (with auto-expand + phase hints + per-phase elapsed)
    // =========================================================================

    /**
     * Bind the "Show Details" / "Hide Details" toggle button.
     * Tracked listener is removed in dispose().
     */
    _bindDetailToggle() {
        const btn = this._bodyEl.querySelector('#setup-detail-btn');
        const panel = this._bodyEl.querySelector('#setup-detail-panel');
        if (!btn || !panel) return;

        if (this._detailToggleListener) {
            btn.removeEventListener('click', this._detailToggleListener);
        }

        this._detailToggleListener = () => {
            this._detailExpanded = !this._detailExpanded;
            // Track explicit user collapse so auto-expand respects it
            if (!this._detailExpanded) {
                this._userCollapsed = true;
            }
            panel.classList.toggle('collapsed', !this._detailExpanded);
            btn.setAttribute('aria-expanded', String(this._detailExpanded));
            const icon = btn.querySelector('i');
            const label = btn.querySelector('span');
            if (icon) {
                icon.className = this._detailExpanded ? 'fas fa-chevron-down' : 'fas fa-chevron-right';
            }
            if (label) {
                label.textContent = this._detailExpanded ? 'Hide Details' : 'Show Details';
            }
        };

        btn.addEventListener('click', this._detailToggleListener);
    }

    /**
     * Programmatically expand the detail panel (for slow phases).
     * Does NOT set _userCollapsed — only manual collapse does that.
     */
    _autoExpandPanel() {
        if (this._detailExpanded) return;

        const btn = this._bodyEl.querySelector('#setup-detail-btn');
        const panel = this._bodyEl.querySelector('#setup-detail-panel');
        if (!btn || !panel) return;

        this._detailExpanded = true;
        panel.classList.remove('collapsed');
        btn.setAttribute('aria-expanded', 'true');
        const icon = btn.querySelector('i');
        const label = btn.querySelector('span');
        if (icon) icon.className = 'fas fa-chevron-down';
        if (label) label.textContent = 'Hide Details';
    }

    /**
     * Update the collapsible detail panel with per-phase rows.
     * Each row shows: status icon + phase label + hint (for active) + mini progress + message + elapsed.
     * @param {Object} data - Backend status response
     */
    _updateDetailPanel(data) {
        const container = this._bodyEl.querySelector('#setup-detail-phases');
        if (!container) return;

        let html = '';
        for (const key of PHASE_ORDER) {
            const phase = data[key] || { status: 'pending', progress: 0, message: '' };
            const label = DETAIL_ROW_LABELS[key] || key;
            const meta = PHASE_META[key];
            const pct = Math.min(phase.progress || 0, 100);
            const msg = phase.message || '';

            let statusClass = '';
            let iconHtml = '<i class="fas fa-circle"></i>';
            const isActive = phase.status === 'in_progress' || phase.status === 'running' || data.current_phase === key;

            if (phase.status === 'completed' || phase.status === 'skipped') {
                statusClass = 'completed';
                iconHtml = '<i class="fas fa-check-circle"></i>';
            } else if (phase.status === 'completed_with_errors') {
                statusClass = 'warning';
                iconHtml = '<i class="fas fa-exclamation-circle"></i>';
            } else if (phase.status === 'error') {
                statusClass = 'error';
                iconHtml = '<i class="fas fa-times-circle"></i>';
            } else if (isActive) {
                statusClass = 'active';
                iconHtml = '<i class="fas fa-circle-notch fa-spin"></i>';
            }

            // Phase hint subtitle (shown only for active phase)
            const hintHtml = isActive && meta && meta.hint
                ? `<span class="detail-row-hint">${meta.hint}</span>`
                : '';

            // Per-phase elapsed time (for completed or active phases)
            let elapsedHtml = '';
            const startTime = this._phaseStartTimes[key];
            if (startTime) {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                if (phase.status === 'completed' || phase.status === 'skipped' || phase.status === 'completed_with_errors') {
                    elapsedHtml = `<span class="detail-row-elapsed">${elapsed}s</span>`;
                } else if (isActive && elapsed > 5) {
                    elapsedHtml = `<span class="detail-row-elapsed">${elapsed}s</span>`;
                }
            }

            html += `
                <div class="setup-detail-row ${statusClass}">
                    <span class="detail-row-icon">${iconHtml}</span>
                    <span class="detail-row-label">
                        ${label}
                        ${hintHtml}
                    </span>
                    <div class="detail-row-bar"><div class="detail-row-bar-fill" style="width:${pct}%"></div></div>
                    <span class="detail-row-msg">${this._escapeHtml(msg)}</span>
                    ${elapsedHtml}
                </div>
            `;
        }

        container.innerHTML = html;
    }

    // =========================================================================
    // ADAPTIVE BANNER
    // =========================================================================

    /**
     * Update the setup banner text based on cached state from requirements.
     * Called by SetupStepController after transitioning to installing phase.
     * @param {{ dockerImagesCached: boolean, venvsExist: boolean }} cacheState
     */
    updateBannerEstimate(cacheState) {
        const banner = this._bodyEl.querySelector('#setup-install-banner');
        if (!banner) return;

        const rows = banner.querySelectorAll('.install-banner-row');
        if (!rows.length) return;

        // First row contains the time estimate
        const timeRow = rows[0];
        const span = timeRow?.querySelector('span');
        if (!span) return;

        if (cacheState.dockerImagesCached && cacheState.venvsExist) {
            span.innerHTML = 'Most components are already cached. Setup should take <strong>~5\u201310 minutes</strong>.';
        } else if (cacheState.dockerImagesCached) {
            span.innerHTML = 'Some components are cached. Setup should take <strong>~10\u201315 minutes</strong>.';
        } else {
            span.innerHTML = 'First-time setup typically takes <strong>15\u201330 minutes</strong> depending on your internet speed.';
        }
    }

    // =========================================================================
    // ELAPSED TIMER
    // =========================================================================

    /**
     * Start the elapsed time counter (updates every second).
     */
    _startElapsedTimer() {
        const elapsedEl = this._bodyEl.querySelector('#setup-elapsed');
        if (!elapsedEl) return;

        this._elapsedTimerId = setInterval(() => {
            if (this._disposed || !this._startTime) return;
            const seconds = Math.floor((Date.now() - this._startTime) / 1000);
            const mins = Math.floor(seconds / 60);
            const secs = seconds % 60;
            elapsedEl.textContent = mins > 0
                ? `${mins}m ${secs.toString().padStart(2, '0')}s elapsed`
                : `${secs}s elapsed`;
        }, 1000);

        this._timers.push(this._elapsedTimerId);
    }

    /**
     * Stop the elapsed time counter.
     */
    stopElapsedTimer() {
        if (this._elapsedTimerId) {
            clearInterval(this._elapsedTimerId);
            const idx = this._timers.indexOf(this._elapsedTimerId);
            if (idx !== -1) {
                this._timers.splice(idx, 1);
            }
            this._elapsedTimerId = null;
        }
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Dispose: stop timers, remove listeners, clear state.
     */
    dispose() {
        if (this._disposed) return;
        this._disposed = true;

        this.stopElapsedTimer();

        if (this._detailToggleListener) {
            const btn = this._bodyEl?.querySelector('#setup-detail-btn');
            if (btn) btn.removeEventListener('click', this._detailToggleListener);
            this._detailToggleListener = null;
        }

        for (const id of this._timers) {
            clearInterval(id);
            clearTimeout(id);
        }
        this._timers = [];
        this._progressHistory = [];
        this._phaseStartTimes = {};
    }
}

// Export constants for use by SetupStepController and tests
SetupProgressTracker.PHASE_LABELS = PHASE_LABELS;
SetupProgressTracker.PHASE_ORDER = PHASE_ORDER;
SetupProgressTracker.PHASE_META = PHASE_META;

module.exports = SetupProgressTracker;
