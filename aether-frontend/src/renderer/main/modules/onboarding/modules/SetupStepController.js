/**
 * @.architecture
 *
 * Incoming: OnboardingModal orchestrator --- {method_call}
 * Processing: Dumb view polling the backend orchestrator state machine.
 * Outgoing: DOM updates, navigation control callback, Toast, Endpoint setup API calls --- {dom_update, toast, api_call}
 *
 * @module renderer/main/modules/onboarding/modules/SetupStepController
 */

'use strict';

const Toast = require('../../../../shared/components/Toast');
const CardBuilder = require('./PrerequisiteCardBuilder');
const SetupProgressTracker = require('./SetupProgressTracker');

const TIMEOUTS = {
    POLL_INTERVAL_MS: 1000,
    ADVANCE_DELAY_MS: 1200,
};

const DOM_SELECTORS = {
    CHECKING_LABEL: '#setup-checking-label',
    PREREQ_ERRORS: '#setup-prereq-errors',
    CHECKING_ACTIONS: '#setup-checking-actions',
    CHECKING_SPINNER_WRAP: '.checking-spinner-wrap',
    PHASE_CHECKING: '#setup-phase-checking',
    PHASE_INSTALLING: '#setup-phase-installing',
    PHASE_LABEL: '#setup-phase-label',
    PHASE_VERIFYING: '#setup-phase-verifying',
    VERIFY_LABEL: '#setup-verify-label',
    VERIFY_ICON_WRAP: '#setup-verify-icon-wrap',
    VERIFY_ACTIONS: '#setup-verify-actions',
};

class SetupStepController {
    constructor({ endpoint, bodyEl, log, onNext, onNavigationControl, onDefer, escapeHtml }) {
        this._endpoint = endpoint;
        this._bodyEl = bodyEl;
        this._log = log;
        this._onNext = onNext;
        this._onNavigationControl = onNavigationControl || (() => {});
        this._onDefer = onDefer || (() => {});
        this._escapeHtml = escapeHtml;
        this._pollTimer = null;
        this._advanceTimer = null;
        this._disposed = false;

        this._progressTracker = null;
        this._lastPhase = null;
        this._lastStatus = null;
        this._lastError = null;
    }

    start() {
        this._onNavigationControl({ back: false, next: false });
        this._phase = 'checking'; // Initialize phase for legacy test compatibility
        this._startPolling();
    }

    _startPolling() {
        if (this._disposed) return;
        
        // Clear existing timer if any to avoid overlapping polls
        if (this._pollTimer) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }

        const poll = async () => {
            if (this._disposed) return;
            try {
                const state = await this._endpoint.getOrchestrationState();
                
                // If orchestrator is idle, send start_check command
                if (state.phase === 'idle') {
                    await this._endpoint.executeOrchestrationCommand('start_check');
                } else {
                    this._renderState(state);
                }
            } catch (error) {
                this._log.warn('[SetupCtrl] Failed to poll orchestration state:', error);
                this._handlePollError();
            }
            
            if (!this._disposed) {
                this._pollTimer = setTimeout(poll, TIMEOUTS.POLL_INTERVAL_MS);
            }
        };

        // Don't execute poll() synchronously, schedule it so tests can advance timers predictably
        this._pollTimer = setTimeout(poll, 0);
    }

    _renderState(state) {
        if (state.phase === 'completed') {
            if (this._lastPhase !== 'completed') {
                this._lastPhase = 'completed';
                this._showVerifyingPhase(state);
                this._advanceAfterDelay();
            }
            return;
        }

        if (state.phase === 'checking') {
            this._showCheckingPhase(state);
        } else if (state.phase === 'installing') {
            this._showInstallingPhase(state);
        } else if (state.phase === 'verifying') {
            this._showVerifyingPhase(state);
        }

        this._lastPhase = state.phase;
        this._lastStatus = state.status;
        this._lastError = state.error;
    }

    _showCheckingPhase(state) {
        const checkingEl = this._bodyEl.querySelector(DOM_SELECTORS.PHASE_CHECKING);
        const installingEl = this._bodyEl.querySelector(DOM_SELECTORS.PHASE_INSTALLING);
        const verifyingEl = this._bodyEl.querySelector(DOM_SELECTORS.PHASE_VERIFYING);
        
        if (checkingEl) checkingEl.classList.remove('hidden');
        if (installingEl) installingEl.classList.add('hidden');
        if (verifyingEl) verifyingEl.classList.add('hidden');

        const labelEl = this._bodyEl.querySelector(DOM_SELECTORS.CHECKING_LABEL);
        const errorsEl = this._bodyEl.querySelector(DOM_SELECTORS.PREREQ_ERRORS);
        const actionsEl = this._bodyEl.querySelector(DOM_SELECTORS.CHECKING_ACTIONS);
        const spinnerEl = this._bodyEl.querySelector(DOM_SELECTORS.CHECKING_SPINNER_WRAP);

        if (state.status === 'in_progress') {
            if (this._lastStatus !== 'in_progress') {
                if (labelEl) labelEl.textContent = 'Checking requirements...';
                if (spinnerEl) spinnerEl.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
                if (errorsEl) { errorsEl.replaceChildren(); errorsEl.classList.add('hidden'); }
                if (actionsEl) actionsEl.replaceChildren();
            }
        } else if (state.status === 'action_required') {
            if (this._lastStatus !== 'action_required') {
                if (labelEl) labelEl.textContent = 'Missing requirements detected.';
                if (spinnerEl) spinnerEl.innerHTML = '<i class="fas fa-exclamation-circle" style="color: var(--color-warning);"></i>';
                this._renderPrereqErrors(errorsEl, state.requirements);
                this._renderCheckingActions(actionsEl, state);
            }
        } else if (state.status === 'error') {
            if (this._lastStatus !== 'error' || this._lastError !== state.error) {
                if (labelEl) labelEl.textContent = 'Error checking requirements: ' + (state.error || 'Unknown error');
                if (spinnerEl) spinnerEl.innerHTML = '<i class="fas fa-exclamation-circle" style="color: var(--color-error);"></i>';
                if (errorsEl) { errorsEl.replaceChildren(); errorsEl.classList.add('hidden'); }
                this._renderCheckingActions(actionsEl, state);
            }
        }
    }

    _showInstallingPhase(state) {
        this._phase = 'installing'; // Track phase for testing compatibility
        
        const checkingEl = this._bodyEl.querySelector(DOM_SELECTORS.PHASE_CHECKING);
        const installingEl = this._bodyEl.querySelector(DOM_SELECTORS.PHASE_INSTALLING);
        const verifyingEl = this._bodyEl.querySelector(DOM_SELECTORS.PHASE_VERIFYING);
        
        if (checkingEl) checkingEl.classList.add('hidden');
        if (installingEl) installingEl.classList.remove('hidden');
        if (verifyingEl) verifyingEl.classList.add('hidden');

        if (!this._progressTracker) {
            this._progressTracker = new SetupProgressTracker({
                bodyEl: this._bodyEl,
                escapeHtml: this._escapeHtml,
            });
            this._progressTracker.init();
        }

        if (state.progress) {
            this._progressTracker.updateProgress(state.progress);
            this._progressTracker._updatePhaseDots(state.progress);
        }

        if (state.status === 'error') {
            this._progressTracker.stopElapsedTimer();
            if (this._lastStatus !== 'error' || this._lastError !== state.error) {
                Toast.error('Setup encountered an error. See details below.');
                const labelEl = this._bodyEl.querySelector(DOM_SELECTORS.PHASE_LABEL);
                if (labelEl) labelEl.textContent = 'Setup failed: ' + (state.error || 'Unknown error');
                
                // Show retry button
                const errorsEl = this._bodyEl.querySelector(DOM_SELECTORS.PREREQ_ERRORS);
                const actionsEl = this._bodyEl.querySelector(DOM_SELECTORS.CHECKING_ACTIONS);
                if (actionsEl) {
                    actionsEl.replaceChildren();
                    const retryBtn = document.createElement('button');
                    retryBtn.className = 'btn-primary btn-sm';
                    retryBtn.innerHTML = '<i class="fas fa-redo"></i> Retry Setup';
                    
                    const retryHandler = () => {
                        actionsEl.replaceChildren();
                        this._endpoint.executeOrchestrationCommand('retry_install');
                    };
                    retryBtn.addEventListener('click', retryHandler);
                    
                    actionsEl.appendChild(retryBtn);

                    const deferBtn = document.createElement('button');
                    deferBtn.className = 'btn-premium-link btn-sm';
                    deferBtn.textContent = 'Quit App and Retry Later';
                    
                    const deferHandler = () => this._onDefer();
                    deferBtn.addEventListener('click', deferHandler);
                    
                    actionsEl.appendChild(deferBtn);
                    
                    // Track cleanup to explicitly remove event listeners
                    this._addActionCleanup(() => {
                        retryBtn.removeEventListener('click', retryHandler);
                        deferBtn.removeEventListener('click', deferHandler);
                    });
                }
            }
        }
    }

    _showVerifyingPhase(state) {
        this._phase = 'verifying'; // Track phase for testing compatibility
        
        const checkingEl = this._bodyEl.querySelector(DOM_SELECTORS.PHASE_CHECKING);
        const installingEl = this._bodyEl.querySelector(DOM_SELECTORS.PHASE_INSTALLING);
        const verifyingEl = this._bodyEl.querySelector(DOM_SELECTORS.PHASE_VERIFYING);
        
        if (checkingEl) checkingEl.classList.add('hidden');
        if (installingEl) installingEl.classList.add('hidden');
        if (verifyingEl) verifyingEl.classList.remove('hidden');

        if (this._progressTracker) {
            this._progressTracker.stopElapsedTimer();
        }

        const verifyLabel = this._bodyEl.querySelector(DOM_SELECTORS.VERIFY_LABEL);
        const iconWrap = this._bodyEl.querySelector(DOM_SELECTORS.VERIFY_ICON_WRAP);
        const actionsEl = this._bodyEl.querySelector(DOM_SELECTORS.VERIFY_ACTIONS);

        if (state.status === 'in_progress') {
            if (this._lastStatus !== 'in_progress') {
                if (verifyLabel) verifyLabel.textContent = 'Connecting to services...';
                if (iconWrap) iconWrap.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
                if (actionsEl) actionsEl.replaceChildren();
            }
        } else if (state.status === 'completed') {
            if (this._lastStatus !== 'completed') {
                if (verifyLabel) verifyLabel.textContent = 'All systems connected!';
                if (iconWrap) {
                    iconWrap.innerHTML = '<i class="fas fa-check-circle"></i>';
                    iconWrap.classList.add('verify-success');
                }
                if (actionsEl) actionsEl.replaceChildren();
            }
        } else if (state.status === 'error') {
            if (this._lastStatus !== 'error' || this._lastError !== state.error) {
                if (verifyLabel) verifyLabel.textContent = 'Service connection failed: ' + (state.error || 'Unknown error');
                if (iconWrap) {
                    iconWrap.innerHTML = '<i class="fas fa-exclamation-triangle"></i>';
                    iconWrap.style.background = 'var(--color-warning-bg)';
                }
                if (actionsEl) {
                    actionsEl.replaceChildren();
                    const retryBtn = document.createElement('button');
                    retryBtn.className = 'btn-primary btn-sm';
                    retryBtn.innerHTML = '<i class="fas fa-redo"></i> Retry Connection';
                    
                    const retryHandler = () => {
                        actionsEl.replaceChildren();
                        this._endpoint.executeOrchestrationCommand('retry_verify');
                    };
                    retryBtn.addEventListener('click', retryHandler);
                    
                    actionsEl.appendChild(retryBtn);

                    const deferBtn = document.createElement('button');
                    deferBtn.className = 'btn-premium-link btn-sm';
                    deferBtn.textContent = 'Quit App and Retry Later';
                    
                    const deferHandler = () => this._onDefer();
                    deferBtn.addEventListener('click', deferHandler);
                    
                    actionsEl.appendChild(deferBtn);
                    
                    // Track cleanup to explicitly remove event listeners
                    this._addActionCleanup(() => {
                        retryBtn.removeEventListener('click', retryHandler);
                        deferBtn.removeEventListener('click', deferHandler);
                    });
                }
            }
        }
    }

    _handlePollError() {
        const labelEl = this._bodyEl.querySelector(DOM_SELECTORS.CHECKING_LABEL);
        const spinnerEl = this._bodyEl.querySelector(DOM_SELECTORS.CHECKING_SPINNER_WRAP);
        if (labelEl) labelEl.textContent = 'Disconnected from setup service. Retrying...';
        if (spinnerEl) spinnerEl.innerHTML = '<i class="fas fa-exclamation-circle" style="color: var(--color-warning);"></i>';
    }

    async _renderPrereqErrors(container, requirements) {
        if (!container || !requirements) return;
        const { python3 = {}, docker_daemon = {} } = requirements;
        
        const platform = await CardBuilder.detectPlatform();
        let html = '';

        if (!docker_daemon.installed) {
            html += CardBuilder.buildDockerNotInstalledCard(platform);
        } else if (docker_daemon.installed && !docker_daemon.running) {
            html += CardBuilder.buildDockerNotRunningCard(platform);
        }

        if (!python3.installed) {
            html += CardBuilder.buildPythonNotInstalledCard(platform);
        }

        container.innerHTML = html;
        container.classList.toggle('hidden', html === '');
    }

    _renderCheckingActions(actionsEl, state) {
        if (!actionsEl) return;
        actionsEl.replaceChildren();

        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn-primary btn-sm';
        retryBtn.innerHTML = '<i class="fas fa-redo"></i> Retry Check';
        
        const retryHandler = () => {
            actionsEl.replaceChildren();
            this._endpoint.executeOrchestrationCommand('retry_check');
        };
        retryBtn.addEventListener('click', retryHandler);
        
        actionsEl.appendChild(retryBtn);

        const deferBtn = document.createElement('button');
        deferBtn.className = 'btn-premium-link btn-sm';
        deferBtn.textContent = 'Quit App and Retry Later';
        
        const deferHandler = () => this._onDefer();
        deferBtn.addEventListener('click', deferHandler);
        
        actionsEl.appendChild(deferBtn);
        
        // Track cleanup to explicitly remove event listeners
        this._addActionCleanup(() => {
            retryBtn.removeEventListener('click', retryHandler);
            deferBtn.removeEventListener('click', deferHandler);
        });
    }

    _advanceAfterDelay() {
        if (this._advanceTimer) return;
        this._advanceTimer = setTimeout(() => {
            if (!this._disposed) this._onNext();
        }, TIMEOUTS.ADVANCE_DELAY_MS);
    }

    _addActionCleanup(fn) {
        if (!this._actionCleanups) {
            this._actionCleanups = [];
        }
        this._actionCleanups.push(fn);
    }

    dispose() {
        this._disposed = true;
        if (this._pollTimer) clearTimeout(this._pollTimer);
        if (this._advanceTimer) clearTimeout(this._advanceTimer);
        if (this._progressTracker) {
            this._progressTracker.dispose();
            this._progressTracker = null;
        }
        if (this._actionCleanups) {
            for (const fn of this._actionCleanups) {
                fn();
            }
            this._actionCleanups = [];
        }
    }
}

module.exports = SetupStepController;