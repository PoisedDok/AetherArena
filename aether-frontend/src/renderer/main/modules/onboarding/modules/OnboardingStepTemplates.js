/**
 * @.architecture
 *
 * Incoming: OnboardingModal orchestrator --- {method_call}
 * Processing: Return static HTML templates for each onboarding step --- {JOB_RENDER_TEMPLATE}
 * Outgoing: HTML string --- {string}
 *
 * @.security innerHTML audit: SAFE
 * All functions return static HTML templates with no user-controlled data interpolation.
 *
 * Steps (5 total, consolidated from original 9):
 *   1. Welcome   — Brand hero, value props, single CTA
 *   2. License   — Terms acceptance + AI disclaimer + third-party notices + privacy disclosure (merged)
 *   3. Setup     — Auto prerequisites check -> unified progress (absorbs Prerequisites, Setup, AI Models, Dependencies)
 *   4. Knowledge — Folder selection + proactive toggle (rendered by IntelligenceStepController)
 *   5. Complete  — Restart countdown with success animation
 *
 * @module renderer/main/modules/onboarding/modules/OnboardingStepTemplates
 */

'use strict';

const escapeHtml = require('../../../../shared/utils/escapeHtml');

// Contract identifiers for durable legal acceptance persistence.
// Keep these in sync with legal text revisions in this module.
const LICENSE_ACCEPTANCE_VERSION = '2026-02-17';
const LICENSE_ACCEPTANCE_HASH = '4fae27d8a2be5438cf2a70c549cab2df8f22ec3ddcfcf278c99244724b2b47a3';

/**
 * Step 1: Welcome
 * Clean hero with accent glow, "AetherArena" wordmark, tagline, 3 minimal value badges.
 * @param {string} [initialName=''] - Optional initial value for the name input
 * @returns {string} HTML
 */
function renderWelcome(initialName = '') {
    const safeName = escapeHtml(initialName || '');
    return `
        <div class="onboarding-welcome">
            <div class="welcome-hero">
                <div class="glow-orb"></div>
                <div class="welcome-wordmark">
                    <span class="wordmark-a">A</span><span class="wordmark-rest">ether</span><span class="wordmark-product">Arena</span>
                </div>
                <p class="welcome-tagline">The private AI assistant that thinks ahead.</p>
            </div>
            <div class="welcome-content">
                <p>AetherArena lives on your computer. It reads your documents, searches the web privately, and brings you what you need — before you even ask. Your work stays on your machine.</p>
                <div class="welcome-profile-form">
                    <div class="form-field">
                        <label for="onboarding-name">How should I call you? <span class="optional-tag">(Optional)</span></label>
                        <div class="input-wrapper">
                            <input id="onboarding-name" type="text" placeholder="Your name or nickname" value="${safeName}" maxlength="100" />
                            <div class="field-icon">
                                <i class="fas fa-user"></i>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="welcome-features">
                <div class="feature-badge">
                    <i class="fas fa-shield-halved"></i>
                    <span>Private by Default</span>
                </div>
                <div class="feature-badge">
                    <i class="fas fa-laptop"></i>
                    <span>Runs on Your Machine</span>
                </div>
                <div class="feature-badge">
                    <i class="fas fa-lightbulb"></i>
                    <span>Thinks Ahead</span>
                </div>
            </div>
        </div>
    `;
}

/**
 * Step 2: License & Privacy (merged from Terms + Privacy)
 * Scrollable license text with checkbox + compact privacy highlights.
 * @param {boolean} [termsAccepted=false] - Whether the terms checkbox should be pre-checked
 * @returns {string} HTML
 */
function renderLicense(termsAccepted = false) {
    return `
        <div class="onboarding-license">
            <div class="license-terms-section">
                <div class="terms-container">
                    <div class="terms-header-premium">
                        <span>BUSINESS SOURCE LICENSE 1.1</span>
                        <span class="terms-version-meta">Version ${LICENSE_ACCEPTANCE_VERSION}</span>
                    </div>
                    <div class="terms-scroll-area">
                        <div class="terms-section">
                            <p><strong>Permitted Use:</strong> You may use AetherArena for non-commercial, personal, testing, and development purposes.</p>
                            <p><strong>Production Use:</strong> Commercial use or production deployment requires a separate commercial license from the Licensor (Krish Dokania).</p>
                            <p><strong>Transition:</strong> This license automatically converts to Apache License, Version 2.0 on November 21, 2029.</p>
                        </div>
                        <hr class="divider">
                        <div class="terms-bullets">
                            <div class="bullet-item"><i class="fas fa-circle"></i> No illegal activities.</div>
                            <div class="bullet-item"><i class="fas fa-circle"></i> No warranties provided.</div>
                            <div class="bullet-item"><i class="fas fa-circle"></i> Hardware/API costs are user-responsibility.</div>
                        </div>
                        <hr class="divider">
                        <div class="terms-section">
                            <p><strong>AI Content Disclaimer:</strong> AetherArena uses artificial intelligence to generate content. AI-generated content may be inaccurate, incomplete, or misleading. Do not rely on outputs as professional, legal, medical, or financial advice. Always verify independently with qualified professionals.</p>
                        </div>
                        <hr class="divider">
                        <div class="terms-section">
                            <p><strong>Third-Party Components:</strong> AetherArena incorporates open-source software including Electron, FastAPI, Perplexica, PyTorch, Hugging Face Transformers, Three.js, Preact, and others, each distributed under their respective licenses (MIT, Apache 2.0, BSD, etc.). Full third-party notices are available in <strong>Settings &rarr; About</strong> after setup.</p>
                        </div>
                    </div>
                </div>
                <div class="terms-disclaimer">
                    <i class="fas fa-exclamation-triangle"></i>
                    <p>By checking below, you accept the BUSL-1.1 license, acknowledge the AI content disclaimer, and the use of third-party open-source components described above.</p>
                </div>
                <label class="aether-toggle-premium">
                    <input type="checkbox" id="accept-terms" ${termsAccepted ? 'checked' : ''}>
                    <i class="fas fa-check-circle toggle-check"></i>
                    <span class="toggle-label">I have read and accept the terms, disclaimers, and notices above</span>
                </label>
            </div>

            <div class="license-privacy-section">
                <h4 class="privacy-section-title">
                    <i class="fas fa-shield-alt"></i>
                    Privacy at a Glance
                </h4>
                <div class="privacy-highlights">
                    <div class="privacy-highlight">
                        <i class="fas fa-eye-slash"></i>
                        <div>
                            <strong>Local-Only Data</strong>
                            <span>Chat history and personal data stay on your machine.</span>
                        </div>
                    </div>
                    <div class="privacy-highlight">
                        <i class="fas fa-lock"></i>
                        <div>
                            <strong>Secure Storage</strong>
                            <span>Encryption keys stay in your device's secure storage.</span>
                        </div>
                    </div>
                    <div class="privacy-highlight warning">
                        <i class="fas fa-globe"></i>
                        <div>
                            <strong>Your Choice on Cloud</strong>
                            <span>Cloud AI services only see your messages if you choose to use them.</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

/**
 * Step 3: System Setup (unified)
 * Absorbs: Prerequisites, Setup, AI Models, Dependencies.
 * Three phases: Checking -> Installing -> Verifying.
 * All phase transitions handled by SetupStepController.
 * @returns {string} HTML
 */
function renderSetup() {
    return `
        <div class="onboarding-setup">
            <!-- Phase 1: Checking prerequisites (visible initially) -->
            <div class="setup-phase" id="setup-phase-checking">
                <div class="setup-checking-status">
                    <div class="checking-spinner-wrap">
                        <i class="fas fa-circle-notch fa-spin"></i>
                    </div>
                    <span id="setup-checking-label">Checking system requirements...</span>
                </div>

                <div class="setup-prereq-errors hidden" id="setup-prereq-errors"></div>

                <div class="setup-checking-actions" id="setup-checking-actions">
                    <!-- Dynamic: populated by SetupStepController based on state -->
                </div>
            </div>

            <!-- Phase 2: Installing (hidden initially) -->
            <div class="setup-phase hidden" id="setup-phase-installing">
                <div class="setup-install-banner" id="setup-install-banner">
                    <div class="install-banner-row">
                        <i class="fas fa-clock"></i>
                        <span>First-time setup typically takes <strong>15\u201330 minutes</strong> depending on your internet speed.</span>
                    </div>
                    <div class="install-banner-row">
                        <i class="fas fa-window-minimize"></i>
                        <span>You can minimize or resize this window \u2014 setup continues in the background.</span>
                    </div>
                    <div class="install-banner-row install-banner-warning">
                        <i class="fas fa-exclamation-triangle"></i>
                        <span>Please <strong>do not force-quit</strong> AetherArena during setup. It may leave things in a broken state.</span>
                    </div>
                </div>

                <div class="setup-phase-label" id="setup-phase-label">Preparing setup...</div>
                <div class="setup-phase-hint hidden" id="setup-phase-hint"></div>

                <div class="setup-unified-bar">
                    <div class="setup-bar-track">
                        <div class="setup-bar-fill" id="setup-bar-fill"></div>
                    </div>
                    <div class="setup-bar-percent" id="setup-bar-percent">0%</div>
                </div>

                <div class="setup-phase-dots" id="setup-phase-dots">
                    <div class="setup-phase-dot" data-phase="repositories">
                        <span class="phase-dot-indicator"></span>
                        <span class="phase-dot-label">Verify</span>
                    </div>
                    <div class="setup-phase-dot" data-phase="python_packages">
                        <span class="phase-dot-indicator"></span>
                        <span class="phase-dot-label">Packages</span>
                    </div>
                    <div class="setup-phase-dot" data-phase="oi_environment">
                        <span class="phase-dot-indicator"></span>
                        <span class="phase-dot-label">AI Runtime</span>
                    </div>
                    <div class="setup-phase-dot" data-phase="inference_environment">
                        <span class="phase-dot-indicator"></span>
                        <span class="phase-dot-label">Inference</span>
                    </div>
                    <div class="setup-phase-dot" data-phase="ml_models">
                        <span class="phase-dot-indicator"></span>
                        <span class="phase-dot-label">Voice</span>
                    </div>
                    <div class="setup-phase-dot" data-phase="docker_services">
                        <span class="phase-dot-indicator"></span>
                        <span class="phase-dot-label">Services</span>
                    </div>
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
                    <div class="setup-detail-phases" id="setup-detail-phases">
                        <!-- Populated dynamically by SetupStepController._updateDetailPanel() -->
                    </div>
                </div>
            </div>

            <!-- Phase 3: Verifying (hidden initially) -->
            <div class="setup-phase hidden" id="setup-phase-verifying">
                <div class="setup-verify-complete">
                    <div class="verify-icon-wrap" id="setup-verify-icon-wrap">
                        <i class="fas fa-circle-notch fa-spin"></i>
                    </div>
                    <span id="setup-verify-label">Connecting to services...</span>
                </div>
                <div class="setup-checking-actions" id="setup-verify-actions"></div>
            </div>
        </div>
    `;
}

/**
 * Step 5: Complete
 * Success animation + restart countdown.
 * @returns {string} HTML
 */
function renderComplete() {
    return `
        <div class="onboarding-complete">
            <div class="complete-icon-wrapper">
                <i class="fas fa-check-circle"></i>
            </div>
            <h3>You're All Set</h3>
            <p>AetherArena will restart to activate your settings. After restart, background services will begin learning from your selected sources and indexing your files. This happens quietly &mdash; you can start using AetherArena immediately.</p>
            <p class="complete-hint">You can adjust these settings anytime in <strong>Settings &rarr; Knowledge</strong>.</p>
        </div>
    `;
}

module.exports = {
    renderWelcome,
    renderLicense,
    renderSetup,
    renderComplete,
    LICENSE_ACCEPTANCE_VERSION,
    LICENSE_ACCEPTANCE_HASH,
};
