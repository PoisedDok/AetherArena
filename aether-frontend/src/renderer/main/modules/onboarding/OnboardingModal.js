/**
 * @.architecture
 *
 * Incoming: MainApp initialization --- {first_run_check}
 * Processing: Orchestrate 5-step onboarding flow (Welcome, License, Setup, Knowledge, Complete).
 *   Manages modal state via BaseModal (closable:false — user cannot dismiss mid-onboarding).
 *   Horizontal dot stepper replaces sidebar. Navigation guards prevent step changes during setup.
 * Outgoing: Preference persistence /v1/settings/preference, proactive config, daemon config, UI events --- {preference.onboarding_complete}
 *
 * @.security innerHTML audit: SAFE
 * All innerHTML usages set static HTML templates (step layouts, SVG icons, form structures).
 * No user-controlled data is interpolated into innerHTML. User input is handled via form elements.
 */

'use strict';

const BaseModal = require('../../../shared/modals/BaseModal');
const Toast = require('../../../shared/components/Toast');
const { createRendererLogger } = require('../../../shared/utils/logger');
const escapeHtml = require('../../../shared/utils/escapeHtml');
const StepTemplates = require('./modules/OnboardingStepTemplates');
const SetupStepController = require('./modules/SetupStepController');
const IntelligenceStepController = require('./modules/IntelligenceStepController');
const OnboardingService = require('./services/OnboardingService');

const DOM_SELECTORS = {
    STEP_CONTENT: '#onboarding-step-content',
    STEP_TITLE: '#onboarding-step-title',
    STEP_SUBTITLE: '#onboarding-step-subtitle',
    NEXT_BTN: '#onboarding-next',
    BACK_BTN: '#onboarding-back',
    STATUS_MSG: '#onboarding-status-msg',
    STEPPER_DOTS: '#stepper-dots',
    NAME_INPUT: '#onboarding-name',
    ACCEPT_TERMS: '#accept-terms',
    COMPLETE_ICON_WRAPPER: '.complete-icon-wrapper',
    COMPLETE_HEADING: '.onboarding-complete h3',
    COMPLETE_DESC: '.onboarding-complete > p:first-of-type',
};

const TIMEOUTS = {
    TRANSITION_MS: 250,
    SWAP_ENTER_MS: 120,
    SETUP_START_DELAY_MS: 50,
};

/**
 * OnboardingModal - The first-run experience for AetherArena.
 *
 * 5-step consolidated flow:
 *   1. Welcome     — Brand hero, value props
 *   2. License     — Terms + privacy merged
 *   3. Setup       — Auto prerequisites -> unified progress (absorbs 4 old steps)
 *   4. Knowledge   — Folder selection + smart suggestions config
 *   5. Complete    — Restart countdown
 *
 * Non-dismissible: closable=false prevents ESC, backdrop click, and close button.
 * Navigation guards: Back/Next hidden during active setup.
 */
class OnboardingModal extends BaseModal {
    constructor(options = {}) {
        super({
            title: 'Welcome to AetherArena',
            id: 'onboarding-modal',
            size: 'lg',
            heightPreset: 'default',
            showFooter: true,
            closable: false,  // CRITICAL: Cannot dismiss during onboarding
        });
        this.log = createRendererLogger('OnboardingModal');

        this.endpoint = options.endpoint;
        this.eventBus = options.eventBus;
        this.onComplete = options.onComplete;

        this.currentStep = 0;
        this.steps = [
            {
                id: 'welcome',
                title: 'Welcome to AetherArena',
                subtitle: 'Your Private AI Assistant',
            },
            {
                id: 'license',
                title: 'License & Privacy',
                subtitle: 'Terms of use and your privacy',
            },
            {
                id: 'setup',
                title: 'System Setup',
                subtitle: 'Setting things up for you',
            },
            {
                id: 'knowledge',
                title: 'Your Knowledge',
                subtitle: 'What should AetherArena know about?',
            },
            {
                id: 'complete',
                title: 'You\'re All Set',
                subtitle: 'Getting everything ready',
            }
        ];

        this._listeners = [];
        this._timers = [];
        this._primaryPath = { value: null, mode: 'combined' }; // Object ref so IntelligenceStepController can mutate
        this._selectedPaths = [];            // Secondary storage paths: Array of { path, mode }
        this._intelligenceToggles = { proactiveMaster: true };
        // Source config state persisted across back/forward navigation.
        // Passed by reference to IntelligenceStepController — controller mutations
        // (toggle changes, browser selection, profile exclusions) persist here
        // even when the controller is disposed and re-created on step transitions.
        this._sourceConfig = {
            sourceToggles: { browser: true, email: true, filesystem: true },
            selectedBrowser: null,
            excludedProfiles: [],
        };
        this._hasRenderedFirstStep = false;
        this._isTransitioning = false; // Guard against rapid multi-clicks
        this._isSetupActive = false; // Navigation guard flag
        this._isFinishing = false;   // Guard against double finish() invocation
        this._isSaving = false;      // Guard against concurrent save operations
        this._knowledgeSaveBypassArmed = false; // Two-click bypass when source checks are still loading
        this._disposed = false;

        this._onboardingName = '';
        this._termsAccepted = false;
    }

    /**
     * Override BaseModal._renderContent to handle multi-step UI with horizontal stepper.
     */
    async _renderContent() {
        // Hide BaseModal header — we use our own stepper header
        if (this.headerEl) this.headerEl.classList.add('hidden');

        this.panel.classList.add('onboarding-panel');
        this.bodyEl.classList.add('onboarding-body');

        this.bodyEl.innerHTML = `
            <div class="onboarding-layout">
                <div class="onboarding-stepper">
                    <div class="stepper-dots" id="stepper-dots">
                        ${this._renderStepperDots()}
                    </div>
                </div>
                <main class="onboarding-main">
                    <div class="onboarding-step-header">
                        <div class="step-title-group">
                            <h2 id="onboarding-step-title"></h2>
                            <p id="onboarding-step-subtitle"></p>
                        </div>
                    </div>
                    <div id="onboarding-step-content" class="onboarding-step-content">
                    </div>
                </main>
            </div>
        `;

        this.footerEl.innerHTML = `
            <div class="onboarding-footer-content">
                <div id="onboarding-status-msg" class="onboarding-status-msg"></div>
                <div class="onboarding-actions">
                    <button id="onboarding-back" class="btn-premium-link danger btn-sm hidden">Back</button>
                    <button id="onboarding-next" class="btn-primary">Continue</button>
                </div>
            </div>
        `;

        // Cache elements
        this._stepContentEl = this.bodyEl.querySelector(DOM_SELECTORS.STEP_CONTENT);
        this._stepTitleEl = this.bodyEl.querySelector(DOM_SELECTORS.STEP_TITLE);
        this._stepSubtitleEl = this.bodyEl.querySelector(DOM_SELECTORS.STEP_SUBTITLE);
        this._nextBtn = this.footerEl.querySelector(DOM_SELECTORS.NEXT_BTN);
        this._backBtn = this.footerEl.querySelector(DOM_SELECTORS.BACK_BTN);
        this._statusMsgEl = this.footerEl.querySelector(DOM_SELECTORS.STATUS_MSG);
        this._stepperDotsEl = this.bodyEl.querySelector(DOM_SELECTORS.STEPPER_DOTS);

        this._renderStep();
    }

    /**
     * Generate the horizontal stepper dot HTML (dots + connectors).
     */
    _renderStepperDots() {
        return this.steps.map((step, i) => {
            const dot = `<div class="stepper-dot" data-step="${i}"></div>`;
            const connector = i < this.steps.length - 1
                ? `<div class="stepper-connector" data-after="${i}"></div>`
                : '';
            return dot + connector;
        }).join('');
    }

    _setupEventListeners() {
        const nextHandler = () => this.nextStep();
        const backHandler = () => this.prevStep();

        this._nextBtn.addEventListener('click', nextHandler);
        this._backBtn.addEventListener('click', backHandler);

        this._listeners.push(
            { el: this._nextBtn, type: 'click', fn: nextHandler },
            { el: this._backBtn, type: 'click', fn: backHandler }
        );
    }

    /**
     * Remove tracked click listeners on _nextBtn and _backBtn.
     * Called before repurposing these buttons (e.g., restart countdown step)
     * to prevent the old nextStep/prevStep handlers firing alongside new ones.
     */
    _removeButtonListeners() {
        for (let i = this._listeners.length - 1; i >= 0; i--) {
            const entry = this._listeners[i];
            if (entry.type === 'click' && (entry.el === this._nextBtn || entry.el === this._backBtn)) {
                entry.el.removeEventListener(entry.type, entry.fn);
                this._listeners.splice(i, 1);
            }
        }
    }

    _cleanup() {
        this._disposed = true;

        // Clean up DOM event listeners
        this._listeners.forEach(l => l.el.removeEventListener(l.type, l.fn));
        this._listeners = [];

        // Clean up restart countdown timer
        this._clearRestartCountdownTimer();

        // Dispose step controllers
        if (this._setupCtrl) {
            this._setupCtrl.dispose();
            this._setupCtrl = null;
        }
        if (this._intelligenceCtrl) {
            this._intelligenceCtrl.dispose();
            this._intelligenceCtrl = null;
        }

        // Clean up timers (clearTimeout clears both setTimeout and setInterval handles per WHATWG spec)
        this._timers.forEach(id => {
            clearInterval(id);
            clearTimeout(id);
        });
        this._timers = [];

        // Release shared state refs
        this._sourceConfig = null;

        // Reset lifecycle flags
        this._hasRenderedFirstStep = false;
        this._isTransitioning = false;
        this._isSetupActive = false;
        this._isFinishing = false;
        this._isSaving = false;
        this._knowledgeSaveBypassArmed = false;
    }

    /**
     * Capture state from the current step's DOM before leaving.
     */
    _captureCurrentStepState() {
        const step = this.steps[this.currentStep];

        // Capture Welcome state
        if (step.id === 'welcome') {
            const nameInput = this.bodyEl.querySelector(DOM_SELECTORS.NAME_INPUT);
            if (nameInput) {
                this._onboardingName = nameInput.value.trim().substring(0, 100); // 100 chars max length
            }
        }

        // Capture License state
        if (step.id === 'license') {
            const checkbox = this.bodyEl.querySelector(DOM_SELECTORS.ACCEPT_TERMS);
            if (checkbox) {
                this._termsAccepted = checkbox.checked;
            }
        }
    }

    /**
     * Navigation guard: prevent step changes during active setup.
     */
    async nextStep() {
        if (this._isSetupActive || this._isTransitioning) return; // Blocked during setup or transition

        const step = this.steps[this.currentStep];

        // Validation: License step requires terms acceptance
        if (step.id === 'license') {
            const checkbox = this.bodyEl.querySelector(DOM_SELECTORS.ACCEPT_TERMS);
            if (!checkbox || !checkbox.checked) {
                Toast.warning('Please accept the license terms to continue.');
                return;
            }
        }

        // Capture inputs before leaving the step
        this._captureCurrentStepState();

        // Save intelligence config before advancing past Knowledge step
        if (step.id === 'knowledge' && this._intelligenceCtrl) {
            let allowPendingSourceStatus = false;
            const saveReadiness = typeof this._intelligenceCtrl.getSaveReadiness === 'function'
                ? this._intelligenceCtrl.getSaveReadiness()
                : { ready: true };

            if (!saveReadiness.ready) {
                if (!this._knowledgeSaveBypassArmed) {
                    this._knowledgeSaveBypassArmed = true;
                    if (this._nextBtn) this._nextBtn.textContent = 'Finish Anyway';
                    Toast.warning('Still checking activity access. Click Finish Anyway to continue now, or wait a moment.');
                    return;
                }
                allowPendingSourceStatus = true;
            } else {
                this._knowledgeSaveBypassArmed = false;
            }

            if (this._isSaving) return; // Prevent concurrent save operations
            this._isSaving = true;
            if (this._nextBtn) {
                this._nextBtn.disabled = true;
                this._nextBtn.textContent = 'Saving...';
            }
            if (this._backBtn) this._backBtn.disabled = true;
            try {
                await this._intelligenceCtrl.saveConfig({ allowPendingSourceStatus });
                this._knowledgeSaveBypassArmed = false;
            } catch (err) {
                this.log.error('[OnboardingModal] Failed to save intelligence config:', err);
                if (err?.code === 'source_status_loading' || err?.code === 'source_status_pending') {
                    this._knowledgeSaveBypassArmed = true;
                    Toast.warning(err.message || 'Still checking activity access. Click Finish Anyway to continue now, or wait a moment.');
                } else if (err?.code === 'daemon_config_save_failed') {
                    this._knowledgeSaveBypassArmed = false;
                    Toast.error('Failed to save activity source settings. Please retry in a moment.');
                } else if (err?.code === 'proactive_config_save_failed' || err?.code === 'proactive_config_verify_failed') {
                    this._knowledgeSaveBypassArmed = false;
                    Toast.error('Failed to activate smart suggestions. Please retry in a moment.');
                } else if (err?.code === 'indexing_location_save_failed') {
                    this._knowledgeSaveBypassArmed = false;
                    const reasonText = String(err?.cause?.message || '');
                    const reasonLower = reasonText.toLowerCase();
                    const storageUnavailable =
                        reasonLower.includes('service not initialized') ||
                        reasonLower.includes('not initialized') ||
                        reasonLower.includes('503') ||
                        reasonLower.includes('backend unavailable');
                    if (storageUnavailable) {
                        Toast.error('Failed to save folders because indexing storage is not initialized. Return to System Setup, complete setup, then try again.');
                    } else {
                        Toast.error(err.message || 'Failed to save selected folders. Please try again.');
                    }
                } else {
                    Toast.error('Failed to save configuration. Please try again.');
                }
                if (this._nextBtn) {
                    this._nextBtn.disabled = false;
                    this._nextBtn.textContent = step.id === 'knowledge'
                        ? (this._knowledgeSaveBypassArmed ? 'Finish Anyway' : 'Finish Setup')
                        : 'Continue';
                }
                if (this._backBtn) this._backBtn.disabled = false;
                return;
            } finally {
                this._isSaving = false;
            }
            if (this._nextBtn) {
                this._nextBtn.disabled = false;
                this._nextBtn.textContent = step.id === 'knowledge' ? 'Finish Setup' : 'Continue';
            }
            if (this._backBtn) this._backBtn.disabled = false;
        }

        this._isTransitioning = true;

        if (this.currentStep < this.steps.length - 1) {
            this.currentStep++;
            this._reportStateToBackend();
            this._renderStep();
        } else {
            this.finish();
        }

        setTimeout(() => { this._isTransitioning = false; }, TIMEOUTS.TRANSITION_MS);
    }

    prevStep() {
        if (this._isSetupActive || this._isTransitioning) return; // Blocked during setup or transition

        this._captureCurrentStepState();
        this._isTransitioning = true;

        const knowledgeIndex = this.steps.findIndex(s => s.id === 'knowledge');
        const licenseIndex = this.steps.findIndex(s => s.id === 'license');

        // Navigation trap fix: Skip Setup step when going backwards from Knowledge.
        // Since setup already initialized the backend, going back to it traps the user
        // as it will detect completion and bounce them forward again.
        if (knowledgeIndex !== -1 && licenseIndex !== -1 && this.currentStep === knowledgeIndex) {
            this.currentStep = licenseIndex;
            this._reportStateToBackend();
            this._renderStep();
        } else if (this.currentStep > 0) {
            this.currentStep--;
            this._reportStateToBackend();
            this._renderStep();
        }

        setTimeout(() => { this._isTransitioning = false; }, TIMEOUTS.TRANSITION_MS);
    }

    /**
     * Report current onboarding state to the backend for progressive persistence.
     */
    _reportStateToBackend() {
        if (!this.endpoint || typeof this.endpoint.saveOnboardingState !== 'function') return;

        const currentStepId = this.steps[this.currentStep]?.id || 'unknown';
        const payload = {
            step: currentStepId,
            name: this._onboardingName,
            terms_accepted: this._termsAccepted,
            timestamp: new Date().toISOString()
        };

        this.endpoint.saveOnboardingState(payload).catch(err => {
            this.log.warn('[OnboardingModal] Failed to report step state to backend', err);
        });
    }

    _renderStep() {
        const step = this.steps[this.currentStep];
        if (step.id !== 'knowledge') {
            this._knowledgeSaveBypassArmed = false;
        }

        // Update header
        this._stepTitleEl.textContent = step.title;
        this._stepSubtitleEl.textContent = step.subtitle;

        // Update horizontal stepper
        this._updateStepper();

        // Update footer buttons (defaults — controllers can override via onNavigationControl)
        this._backBtn.classList.toggle('hidden', this.currentStep === 0);
        this._backBtn.disabled = false;
        this._nextBtn.disabled = false;

        if (step.id === 'knowledge') {
            this._nextBtn.textContent = this._knowledgeSaveBypassArmed ? 'Finish Anyway' : 'Finish Setup';
        } else if (this.currentStep === this.steps.length - 1) {
            this._nextBtn.textContent = 'Start Experience';
        } else {
            this._nextBtn.textContent = 'Continue';
        }

        // Setup step: hide footer buttons (controller manages navigation)
        if (step.id === 'setup') {
            this._nextBtn.classList.add('hidden');
            this._backBtn.classList.add('hidden');
        } else {
            this._nextBtn.classList.remove('hidden');
        }

        // Complete step: special footer handling (done in finish() -> _showRestartNotice())
        if (step.id === 'complete') {
            this._nextBtn.classList.add('hidden');
            this._backBtn.classList.add('hidden');
        }

        // Reset status message
        this._statusMsgEl.textContent = '';

        // Animate step content transition
        if (this._stepContentEl) {
            const isFirstRender = !this._hasRenderedFirstStep;

            if (isFirstRender) {
                this._hasRenderedFirstStep = true;
                this._renderStepBody(step.id);
                this._stepContentEl.classList.add('step-enter');
            } else {
                this._stepContentEl.classList.remove('step-enter');
                this._stepContentEl.classList.add('step-exit');

                const swapAndEnter = () => {
                    if (this._disposed) return;
                    this._renderStepBody(step.id);
                    this._stepContentEl.classList.remove('step-exit');
                    void this._stepContentEl.offsetHeight;
                    this._stepContentEl.classList.add('step-enter');
                };

                this._timers.push(setTimeout(swapAndEnter, TIMEOUTS.SWAP_ENTER_MS));
            }
        } else {
            this._renderStepBody(step.id);
        }
    }

    /**
     * Update horizontal stepper dots and connectors to reflect current step.
     */
    _updateStepper() {
        if (!this._stepperDotsEl) return;

        // Update dots
        const dots = this._stepperDotsEl.querySelectorAll('.stepper-dot');
        dots.forEach((dot, i) => {
            dot.classList.toggle('is-active', i === this.currentStep);
            dot.classList.toggle('is-complete', i < this.currentStep);
        });

        // Update connectors
        const connectors = this._stepperDotsEl.querySelectorAll('.stepper-connector');
        connectors.forEach((conn, i) => {
            conn.classList.toggle('is-complete', i < this.currentStep);
        });
    }

    _renderStepBody(stepId, options = {}) {
        const autoFinish = options.autoFinish !== false;
        let html = '';
        switch (stepId) {
            case 'welcome':
                html = StepTemplates.renderWelcome(this._onboardingName);
                break;

            case 'license':
                html = StepTemplates.renderLicense(this._termsAccepted);
                break;

            case 'setup':
                html = StepTemplates.renderSetup();
                this._isSetupActive = true;
                this._timers.push(setTimeout(() => {
                    if (this._disposed) return;
                    if (this._setupCtrl) this._setupCtrl.dispose();
                    this._setupCtrl = new SetupStepController({
                        endpoint: this.endpoint,
                        bodyEl: this.bodyEl,
                        log: this.log,
                        onNext: () => {
                            this._isSetupActive = false;
                            this.nextStep();
                        },
                        onNavigationControl: ({ back, next }) => {
                            if (this._backBtn) {
                                this._backBtn.classList.toggle('hidden', !back);
                                this._backBtn.disabled = !back;
                            }
                            if (this._nextBtn) {
                                this._nextBtn.classList.toggle('hidden', !next);
                                this._nextBtn.disabled = !next;
                            }
                        },
                        onDefer: () => this._deferSetup(),
                        escapeHtml: (v) => this._escapeHtml(v),
                    });
                    this._setupCtrl.start();
                }, TIMEOUTS.SETUP_START_DELAY_MS));
                break;

            case 'knowledge':
                if (this._intelligenceCtrl) this._intelligenceCtrl.dispose();
                this._intelligenceCtrl = new IntelligenceStepController({
                    endpoint: this.endpoint,
                    bodyEl: this.bodyEl,
                    log: this.log,
                    primaryPath: this._primaryPath,
                    selectedPaths: this._selectedPaths,
                    intelligenceToggles: this._intelligenceToggles,
                    sourceConfig: this._sourceConfig,
                });
                html = '';
                break;

            case 'complete':
                // Set complete content synchronously FIRST (prevents flash of old content
                // during step-enter animation while finish() awaits async operations).
                html = StepTemplates.renderComplete();
                // Fire finish() async — saves preferences, starts countdown.
                // Do NOT return early; let html be set on _stepContentEl below.
                if (autoFinish) {
                    this.finish();
                }
                break;
        }

        this._stepContentEl.innerHTML = html;

        // Post-render bindings
        if (stepId === 'knowledge' && this._intelligenceCtrl) {
            this._intelligenceCtrl.mount(this._stepContentEl);
        }
    }

    /**
     * Compatibility alias for open()
     */
    async show() {
        this.currentStep = 0;
        this._disposed = false; // Reset disposal flag for fresh lifecycle

        // Recreate shared state if _cleanup() nulled it (lifecycle resilience).
        // Production path creates a new modal each launch, but defensive coding
        // ensures destroy/recreate works correctly per DEVELOPMENT_PROTOCOL.
        if (!this._sourceConfig) {
            this._sourceConfig = {
                sourceToggles: { browser: true, email: true, filesystem: true },
                selectedBrowser: null,
                excludedProfiles: [],
            };
        }

        this._reportStateToBackend();
        await this.open();
    }

    async finish() {
        // Guard: prevent double invocation from button double-fire (addEventListener + onclick)
        if (this._isFinishing) return;
        this._isFinishing = true;

        if (this._finishAbortController) {
            this._finishAbortController.abort();
        }
        this._finishAbortController = new AbortController();

        if (this._nextBtn) {
            this._nextBtn.disabled = true;
            this._nextBtn.classList.remove('hidden');
            this._nextBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Saving...';
        }
        if (this._backBtn) {
            this._backBtn.classList.remove('hidden');
            this._backBtn.textContent = 'Cancel';
            this._backBtn.disabled = false;
            
            // Temporary cancel listener
            this._cancelFinishHandler = () => {
                if (this._finishAbortController) {
                    this._finishAbortController.abort();
                    this._finishAbortController = null;
                }
            };
            this._backBtn.addEventListener('click', this._cancelFinishHandler, { once: true });
            this._listeners.push({ el: this._backBtn, type: 'click', fn: this._cancelFinishHandler });
        }

        try {
            // Crash-safety: mark done + pending sync locally BEFORE remote calls.
            // If app crashes mid-persistence, isNeeded() will retry the sync on next launch.
            OnboardingService.setLocalCompletionState(true, true);

            // 1. Gather all consolidated data
            const intelData = this._intelligenceCtrl
                ? this._intelligenceCtrl.getConsolidatedData()
                : { indexing_locations: [], daemon_config: {}, proactive_config: { enabled: false } };

            const consolidatedPayload = {
                user_profile: {
                    name: this._onboardingName || 'Aether User'
                },
                legal_acceptance: {
                    terms_version: OnboardingService.getLegalAcceptanceVersion(),
                    terms_hash: OnboardingService.getLegalAcceptanceHash(),
                    acceptance_method: 'checkbox',
                    accepted: this._termsAccepted
                },
                ...intelData
            };

            // 2. Send atomic payload to new endpoint
            // This endpoint writes to pending_onboarding.json, which is processed after restart.
            // This replaces individual setPreference/updateConfig calls that were prone to
            // timing issues when services were still initializing.
            this.log.info('[OnboardingModal] Submitting consolidated onboarding data');
            await this.endpoint.completeOnboarding(consolidatedPayload, { signal: this._finishAbortController.signal });

            // Remote sync verified — clear pending flag.
            OnboardingService.clearPendingSyncFlag();

            if (this._cancelFinishHandler && this._backBtn) {
                this._backBtn.removeEventListener('click', this._cancelFinishHandler);
                this._cancelFinishHandler = null;
            }

            this._showRestartNotice();
        } catch (error) {
            if (this._cancelFinishHandler && this._backBtn) {
                this._backBtn.removeEventListener('click', this._cancelFinishHandler);
                this._cancelFinishHandler = null;
            }
            if (error.name === 'AbortError') {
                this.log.info('Finalize onboarding aborted by user');
                this._isFinishing = false;
                // Revert to initial complete step state
                this._renderStepBody('complete', { autoFinish: false });
                return;
            }
            this.log.error('Failed to finalize onboarding:', error);
            OnboardingService.setLocalCompletionState(false, false);
            this._showFinalizeFailureState(error);
            this._isFinishing = false;
        } finally {
            this._finishAbortController = null;
        }
    }

    _showFinalizeFailureState(error) {
        const code = error?.code || 'unknown';
        let message = 'Could not finalize onboarding. Please retry.';
        
        if (error.isBackendUnavailableError || error.message?.includes('fetch failed')) {
            message = 'Backend service is unreachable. The service might be starting up or has crashed. You can retry, or quit the app and try again.';
        } else if (error.isTimeoutError || error.name === 'TimeoutError') {
            message = 'The request timed out. Please check your connection and retry.';
        } else if (code === 'legal_acceptance_save_failed' || code === 'legal_acceptance_verify_failed') {
            message = 'Could not save legal acceptance. Please retry to continue.';
        } else if (code === 'onboarding_complete_save_failed' || code === 'onboarding_complete_verify_failed') {
            message = 'Could not save onboarding completion. Please retry to continue.';
        }

        Toast.error(message);
        if (this._statusMsgEl) {
            this._statusMsgEl.textContent = message;
            this._statusMsgEl.className = 'onboarding-status-msg error';
        }

        this._removeButtonListeners();
        if (this._nextBtn) {
            this._nextBtn.classList.remove('hidden');
            this._nextBtn.disabled = false;
            this._nextBtn.textContent = 'Retry Finalization';
            const retryHandler = () => this.finish();
            this._nextBtn.addEventListener('click', retryHandler);
            this._listeners.push({ el: this._nextBtn, type: 'click', fn: retryHandler });
        }

        if (this._backBtn) {
            this._backBtn.classList.remove('hidden');
            this._backBtn.disabled = false;
            this._backBtn.textContent = 'Quit App';
            const quitHandler = () => this._requestAppQuit('Setup is required before using AetherArena. Please reopen and continue onboarding.');
            this._backBtn.addEventListener('click', quitHandler);
            this._listeners.push({ el: this._backBtn, type: 'click', fn: quitHandler });
        }
    }

    _requestAppQuit(fallbackToastMessage) {
        try {
            const aether = typeof window !== 'undefined' ? window['aether'] : null;
            if (aether?.ipc?.send) {
                aether.ipc.send('app:quit');
                return true;
            }
        } catch (e) {
            this.log.error('[OnboardingModal] Failed to trigger app quit:', e);
        }

        if (fallbackToastMessage) {
            Toast.warning(fallbackToastMessage);
        }
        return false;
    }

    _clearRestartCountdownTimer() {
        if (this._restartCountdownTimer) {
            clearInterval(this._restartCountdownTimer);
            const idx = this._timers.indexOf(this._restartCountdownTimer);
            if (idx !== -1) {
                this._timers.splice(idx, 1);
            }
            this._restartCountdownTimer = null;
        }
    }

    /**
     * Show restart notice as the final step content.
     * Auto-restarts after countdown for premium UX.
     */
    _showRestartNotice() {
        // Guard: clear any existing countdown timer (prevents double-speed countdown
        // if this method is called more than once, e.g., from button double-fire).
        this._clearRestartCountdownTimer();

        if (this._stepContentEl) {
            this._stepContentEl.innerHTML = StepTemplates.renderComplete();
        }

        if (this._stepTitleEl) this._stepTitleEl.textContent = 'You\'re All Set';
        if (this._stepSubtitleEl) this._stepSubtitleEl.textContent = 'Getting everything ready';

        // Show restart button and skip-restart option
        let countdown = 5;

        // Remove the nextStep/prevStep listeners before repurposing buttons.
        // Without this, both the old handler and the new one fire on click.
        this._removeButtonListeners();

        if (this._nextBtn) {
            this._nextBtn.classList.remove('hidden');
            this._nextBtn.disabled = false;
            this._nextBtn.textContent = `Restarting in ${countdown}s`;
            const relaunchHandler = () => this._triggerRelaunch();
            this._nextBtn.addEventListener('click', relaunchHandler);
            this._listeners.push({ el: this._nextBtn, type: 'click', fn: relaunchHandler });
        }

        if (this._backBtn) {
            this._backBtn.classList.remove('hidden');
            this._backBtn.textContent = 'Quit App';
            const quitHandler = () => {
                this._clearRestartCountdownTimer();
                const quitRequested = this._requestAppQuit(
                    'Restart is required before continuing. Please quit and reopen AetherArena.'
                );
                if (!quitRequested && this._statusMsgEl) {
                    this._statusMsgEl.textContent = 'Restart is required. Retry restart or quit and reopen.';
                    this._statusMsgEl.className = 'onboarding-status-msg error';
                }
            };
            this._backBtn.addEventListener('click', quitHandler);
            this._listeners.push({ el: this._backBtn, type: 'click', fn: quitHandler });
        }

        if (this._statusMsgEl) {
            this._statusMsgEl.textContent = 'Application will restart automatically';
            this._statusMsgEl.className = 'onboarding-status-msg info';
        }

        this._restartCountdownTimer = setInterval(() => {
            countdown--;
            if (this._nextBtn) {
                if (countdown > 0) {
                    this._nextBtn.textContent = `Restarting in ${countdown}s`;
                } else {
                    this._nextBtn.textContent = 'Restarting...';
                    this._nextBtn.disabled = true;
                }
            }
            if (countdown <= 0) {
                this._clearRestartCountdownTimer();
                this._triggerRelaunch();
            }
        }, 1000);
        this._timers.push(this._restartCountdownTimer);
    }

    /**
     * Trigger app relaunch via IPC.
     * Transitions UI to shutdown state before sending IPC to cover the
     * delay between IPC send and actual process termination.
     * Falls back to prompting user to manually quit if IPC is unavailable.
     */
    _triggerRelaunch() {
        try {
            const aether = typeof window !== 'undefined' ? window['aether'] : null;
            if (aether?.ipc?.send) {
                this.log.debug('[OnboardingModal] Triggering app relaunch via IPC');
                this._showShutdownState();
                aether.ipc.send('app:relaunch');
                return;
            }
        } catch (e) {
            this.log.error('[OnboardingModal] Failed to trigger relaunch:', e);
        }

        const quitRequested = this._requestAppQuit(
            'Automatic restart is unavailable. Quit and reopen AetherArena to continue.'
        );
        if (quitRequested) return;

        // Keep onboarding gate blocked until user can restart manually.
        if (this._statusMsgEl) {
            this._statusMsgEl.textContent = 'Restart is required before continuing. Retry restart or quit and reopen.';
            this._statusMsgEl.className = 'onboarding-status-msg error';
        }
        this._removeButtonListeners();

        if (this._nextBtn) {
            this._nextBtn.classList.remove('hidden');
            this._nextBtn.disabled = false;
            this._nextBtn.textContent = 'Retry Restart';
            const retryHandler = () => this._triggerRelaunch();
            this._nextBtn.addEventListener('click', retryHandler);
            this._listeners.push({ el: this._nextBtn, type: 'click', fn: retryHandler });
        }

        if (this._backBtn) {
            this._backBtn.classList.remove('hidden');
            this._backBtn.disabled = false;
            this._backBtn.textContent = 'Quit App';
            const quitHandler = () => this._requestAppQuit(
                'Restart is required before continuing. Please quit and reopen AetherArena.'
            );
            this._backBtn.addEventListener('click', quitHandler);
            this._listeners.push({ el: this._backBtn, type: 'click', fn: quitHandler });
        }
    }

    /**
     * Transition the complete step into a shutdown/restarting visual state.
     * Covers the delay between IPC send and actual Electron process exit.
     */
    _showShutdownState() {
        // Stop the countdown timer — we're past the point of no return
        this._clearRestartCountdownTimer();

        // Swap the green checkmark icon to a spinning icon
        if (this._stepContentEl) {
            const iconWrapper = this._stepContentEl.querySelector(DOM_SELECTORS.COMPLETE_ICON_WRAPPER);
            if (iconWrapper) {
                iconWrapper.classList.add('is-shutting-down');
                const icon = iconWrapper.querySelector('i');
                if (icon) {
                    icon.className = 'fas fa-sync-alt fa-spin';
                }
            }

            // Update heading + description
            const heading = this._stepContentEl.querySelector(DOM_SELECTORS.COMPLETE_HEADING);
            if (heading) heading.textContent = 'Restarting\u2026';

            const desc = this._stepContentEl.querySelector(DOM_SELECTORS.COMPLETE_DESC);
            if (desc) desc.textContent = 'Shutting down services and relaunching. This only takes a moment.';
        }

        // Update footer elements
        if (this._nextBtn) {
            this._nextBtn.textContent = 'Shutting down\u2026';
            this._nextBtn.disabled = true;
        }
        if (this._backBtn) {
            this._backBtn.classList.add('hidden');
        }
        if (this._statusMsgEl) {
            this._statusMsgEl.textContent = 'Application is restarting — please wait';
        }
    }

    /**
     * Setup is mandatory on first run. Do not allow defer-based continuation.
     * If user cannot proceed, request app quit so they can retry on next launch.
     */
    _deferSetup() {
        const quitRequested = this._requestAppQuit(
            'Setup is required before continuing. Please quit and reopen AetherArena to retry.'
        );
        if (!quitRequested && this._statusMsgEl) {
            this._statusMsgEl.textContent = 'Setup is required before continuing. Retry setup or quit and reopen.';
            this._statusMsgEl.className = 'onboarding-status-msg error';
        }
    }

    /**
     * Escape HTML entities to prevent XSS in innerHTML interpolation.
     * Delegates to shared string-based utility (no DOM element creation).
     * @param {string} str
     * @returns {string}
     * @private
     */
    _escapeHtml(str) {
        return escapeHtml(str);
    }

    static async isNeeded(endpoint) {
        return OnboardingService.isNeeded(endpoint);
    }
}

module.exports = OnboardingModal;
