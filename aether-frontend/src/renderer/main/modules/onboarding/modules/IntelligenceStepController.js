/**
 * @.architecture
 *
 * Incoming: OnboardingModal orchestrator --- {method_call}
 * Processing: Manage file indexing locations, proactive toggle, data source cards, save config
 *             --- {JOB_LOCATION_MGMT, JOB_SOURCE_STATUS, JOB_SAVE_CONFIG}
 * Outgoing: endpoint.createFileIndexingLocation, endpoint.updateProactiveConfig,
 *           endpoint.updateFileIndexingDaemonConfig, endpoint.getProactiveSourceStatus --- {api_call}
 *
 * Two config mechanisms in saveConfig():
 *   1. updateFileIndexingDaemonConfig -> config_override.json -> HOW daemons run (browser, watch_locations)
 *   2. updateProactiveConfig -> proactive_config.json -> WHETHER daemons run (per-source enabled) + triggers reload
 *
 * Rendering: ComponentFactory template stamping. No innerHTML for UI structure.
 *   Templates parsed once at require() time. mount() stamps + binds into a container.
 *   Stamps self-clean via dispose(). No shared _listeners[] array.
 *
 * @module renderer/main/modules/onboarding/modules/IntelligenceStepController
 */

'use strict';

const ComponentFactory = require('../../../../shared/utils/ComponentFactory');
const Toast = require('../../../../shared/components/Toast');

// =========================================================================
// Templates
// =========================================================================

const {
    IntelligenceTemplate,
    LocationChipTemplate,
    BrowserCardTemplate,
    EmailCardTemplate,
    FilesystemCardTemplate
} = require('./IntelligenceTemplates');

const IntelligenceDomainService = require('./IntelligenceDomainService');

// =========================================================================
// Controller
// =========================================================================

class IntelligenceStepController {
    /**
     * @param {Object} opts
     * @param {Object} opts.endpoint - Backend API endpoint facade
     * @param {HTMLElement} opts.bodyEl - Modal body element (kept for consistency with other controllers)
     * @param {Object} opts.log - Logger instance
     * @param {Object} opts.primaryPath - Shared object { value: string|null } for primary storage path
     * @param {Array<string>} opts.selectedPaths - Reference to the selectedPaths array for secondary storage
     * @param {Object} opts.intelligenceToggles - Reference to the intelligence toggles object
     * @param {Object} opts.sourceConfig - Shared source config from OnboardingModal (persists across navigation)
     */
    constructor({ endpoint, bodyEl, log, primaryPath, selectedPaths, intelligenceToggles, sourceConfig }) {
        this._endpoint = endpoint;
        this._bodyEl = bodyEl;
        this._log = log;
        this._primaryPath = primaryPath;
        this._selectedPaths = selectedPaths;
        this._intelligenceToggles = intelligenceToggles;
        
        this.domainService = new IntelligenceDomainService({
            primaryPath,
            selectedPaths,
            intelligenceToggles,
            sourceConfig,
            endpoint,
            log
        });

        // Stamp lifecycle tracking — categorized by re-render scope
        this._stamps = [];                  // Main layout stamp disposers (lifecycle: mount -> dispose)
        this._cardCleanups = [];            // Source card stamp disposers (lifecycle: fetch -> refetch)
        this._primaryChipDispose = null;    // Primary chip stamp disposer (lifecycle: refresh -> refresh)
        this._secondaryChipCleanups = [];   // Secondary chip stamp disposers (lifecycle: refresh -> refresh)
        this._cleanups = [];                // Non-stamp cleanup functions

        this._fsHighlightTimer = null;      // Filesystem card highlight timer

        this._refs = null;                  // Main template refs
        this._filesystemCardRefs = null;    // Filesystem card refs (for reactive updates)
        this._disposed = false;
    }

    // =========================================================================
    // Mount — replaces renderHTML() + bind()
    // =========================================================================

    /**
     * Stamp the intelligence step UI into a container element.
     * Replaces the old renderHTML() + bind() two-phase pattern.
     * @param {HTMLElement} container - DOM element to mount into
     */
    mount(container) {
        const { root, refs, bind, dispose } = IntelligenceTemplate.stamp();
        this._stamps.push(dispose);
        this._refs = refs;

        // Set initial dynamic content
        this._renderPrimaryContent();
        this._renderSecondaryContent();

        // Proactive toggle state
        refs.proactiveToggle.checked = this._intelligenceToggles.proactiveMaster;

        // Source section visibility
        refs.sourceSection.classList.add(
            this._intelligenceToggles.proactiveMaster ? 'is-visible' : 'is-hidden'
        );

        // Source cards — show skeletons initially
        this._renderSkeletons();
        this._renderDaemonSummary();

        // Select button label
        refs.selectPrimaryLabel.textContent = this._primaryPath.value ? 'Change' : 'Select Folder';

        // --- Bind event handlers ---
        bind('selectPrimaryBtn', 'click', () => this._selectPrimaryStorage());
        bind('addSecondaryBtn', 'click', () => this._addSecondaryLocation());
        bind('proactiveToggle', 'change', (e) => {
            this._intelligenceToggles.proactiveMaster = e.target.checked;
            this._onProactiveToggle(e.target.checked);
        });

        // Mount to container
        container.replaceChildren();
        container.appendChild(root);

        // If proactive is already ON, fetch source status immediately
        if (this._intelligenceToggles.proactiveMaster) {
            this._fetchSourceStatus();
        }
    }

    // =========================================================================
    // Primary storage display
    // =========================================================================

    _renderPrimaryContent() {
        const container = this._refs?.primaryDisplay;
        if (!container) return;

        // Dispose previous primary chip stamp
        if (this._primaryChipDispose) {
            this._primaryChipDispose();
            this._primaryChipDispose = null;
        }

        container.replaceChildren();

        if (this._primaryPath.value) {
            const { root, refs, bind, dispose } = LocationChipTemplate.stamp();
            this._primaryChipDispose = dispose;

            refs.chip.classList.add('intel-primary-chip');
            refs.icon.classList.add('fa-hard-drive');
            refs.chipPath.textContent = this._abbreviatePath(this._primaryPath.value);
            refs.chipPath.title = this._primaryPath.value;
            refs.typeBadge.textContent = 'PRIMARY';
            refs.typeBadge.classList.add('primary');
            refs.removeBtn.id = 'intel-primary-remove';
            
            if (refs.modeSelect) {
                refs.modeSelect.value = this._primaryPath.mode || 'combined';
                bind('modeSelect', 'change', (e) => {
                    this._primaryPath.mode = e.target.value;
                });
            }

            bind('removeBtn', 'click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._primaryPath.value = null;
                this._renderPrimaryContent();
                this._onStorageLocationChanged();
            });

            container.appendChild(root);
        } else {
            container.appendChild(this._createPrimaryEmptyState());
        }

        // Update select button label
        if (this._refs?.selectPrimaryLabel) {
            this._refs.selectPrimaryLabel.textContent = this._primaryPath.value ? 'Change' : 'Select Folder';
        }
    }

    _createPrimaryEmptyState() {
        const div = document.createElement('div');
        div.className = 'intel-empty-state';
        const icon = document.createElement('i');
        icon.className = 'fas fa-hard-drive';
        const span = document.createElement('span');
        span.textContent = 'Select your main workspace folder \u2014 Documents, Desktop, or a custom location.';
        div.appendChild(icon);
        div.appendChild(span);
        return div;
    }

    // =========================================================================
    // Secondary storage display
    // =========================================================================

    _renderSecondaryContent() {
        const container = this._refs?.secondaryChips;
        if (!container) return;

        // Dispose previous secondary chip stamps
        for (const d of this._secondaryChipCleanups) d();
        this._secondaryChipCleanups = [];

        container.replaceChildren();

        if (this._selectedPaths.length === 0) {
            container.appendChild(this._createSecondaryEmptyState());
        } else {
            for (let i = 0; i < this._selectedPaths.length; i++) {
                const pathObj = this._selectedPaths[i];
                const { root, refs, bind, dispose } = LocationChipTemplate.stamp();
                this._secondaryChipCleanups.push(dispose);

                refs.chip.dataset.index = String(i);
                refs.icon.classList.add('fa-folder');
                refs.chipPath.textContent = this._abbreviatePath(pathObj.path);
                refs.chipPath.title = pathObj.path;
                refs.typeBadge.textContent = 'SECONDARY';
                refs.typeBadge.classList.add('secondary');
                refs.removeBtn.dataset.index = String(i);
                
                if (refs.modeSelect) {
                    refs.modeSelect.value = pathObj.mode || 'combined';
                    bind('modeSelect', 'change', (e) => {
                        pathObj.mode = e.target.value;
                    });
                }

                bind('removeBtn', 'click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const idx = this._selectedPaths.indexOf(pathObj);
                    if (idx !== -1) {
                        this._selectedPaths.splice(idx, 1);
                        this._renderSecondaryContent();
                        this._onStorageLocationChanged();
                    }
                });

                container.appendChild(root);
            }
        }
    }

    _createSecondaryEmptyState() {
        const div = document.createElement('div');
        div.className = 'intel-empty-state intel-empty-secondary';
        const icon = document.createElement('i');
        icon.className = 'fas fa-folder-open';
        const span = document.createElement('span');
        span.append('No additional folders. You can add more anytime in ');
        const strong = document.createElement('strong');
        strong.textContent = 'Settings';
        span.appendChild(strong);
        span.append('.');
        div.appendChild(icon);
        div.appendChild(span);
        return div;
    }

    // =========================================================================
    // Source skeleton loading state
    // =========================================================================

    _renderSkeletons() {
        const container = this._refs?.sourceCards;
        if (!container) return;

        container.replaceChildren();

        // Screen reader status
        const srOnly = document.createElement('span');
        srOnly.className = 'sr-only';
        srOnly.setAttribute('role', 'status');
        srOnly.textContent = 'Loading activity source status\u2026';
        container.appendChild(srOnly);

        // 3 skeleton cards
        for (let i = 0; i < 3; i++) {
            const card = document.createElement('div');
            card.className = 'intel-source-card is-loading';
            card.setAttribute('aria-hidden', 'true');
            const skeleton = document.createElement('div');
            skeleton.className = 'intel-source-skeleton';
            for (let j = 0; j < 3; j++) {
                const line = document.createElement('div');
                line.className = 'intel-source-skeleton-line';
                skeleton.appendChild(line);
            }
            card.appendChild(skeleton);
            container.appendChild(card);
        }
    }

    // =========================================================================
    // Proactive toggle <-> Source cards interaction
    // =========================================================================

    _onProactiveToggle(checked) {
        const section = this._refs?.sourceSection;
        if (!section) return;

        if (checked) {
            section.classList.remove('is-hidden');
            section.classList.add('is-visible');
            if (!this.domainService.sourceStatus && !this.domainService.sourceStatusLoading) {
                this._fetchSourceStatus();
            }
        } else {
            section.classList.remove('is-visible');
            section.classList.add('is-hidden');
            this._abortFetch();
        }

        this._renderDaemonSummary();
    }

    _abortFetch() {
        this.domainService.abortFetch();

        const sourceCards = this._refs?.sourceCards;
        if (sourceCards && sourceCards.getAttribute('aria-busy') === 'true') {
            sourceCards.setAttribute('aria-busy', 'false');
            sourceCards.replaceChildren();
        }
    }

    // =========================================================================
    // Source status fetch and rendering
    // =========================================================================

    async _fetchSourceStatus() {
        if (this._disposed) return;

        this._abortFetch();
        this._renderDaemonSummary();

        const sourceCards = this._refs?.sourceCards;
        if (sourceCards) {
            this._disposeCardCleanups();
            sourceCards.setAttribute('aria-busy', 'true');
            this._renderSkeletons();
        }

        try {
            await this.domainService.fetchSourceStatus();
            if (this._disposed) return;
            this._renderSourceCards();
        } catch (err) {
            if (this._disposed) return;
            if (err.name === 'AbortError') return;

            if (sourceCards) {
                sourceCards.setAttribute('aria-busy', 'false');
                sourceCards.replaceChildren();

                const { errorEl, retryBtn } = this._createErrorElement(
                    'Could not load activity source status.',
                    'intel-source-retry',
                    'Retry loading activity source status'
                );
                sourceCards.appendChild(errorEl);

                const retryHandler = () => this._fetchSourceStatus();
                retryBtn.addEventListener('click', retryHandler);
                this._cardCleanups.push(() => retryBtn.removeEventListener('click', retryHandler));
            }
            this._renderDaemonSummary();
        }
    }

    _renderSourceCards() {
        const sourceCards = this._refs?.sourceCards;
        if (!sourceCards || !this.domainService.sourceStatus) return;

        this._disposeCardCleanups();
        sourceCards.replaceChildren();

        const s = this.domainService.sourceStatus;
        const browserRoot = this._mountBrowserCard(s.browser);
        const emailRoot = this._mountEmailCard(s.email);
        const fsRoot = this._mountFilesystemCard();

        if (browserRoot) sourceCards.appendChild(browserRoot);
        if (emailRoot) sourceCards.appendChild(emailRoot);
        if (fsRoot) sourceCards.appendChild(fsRoot);

        sourceCards.setAttribute('aria-busy', 'false');
        this._renderDaemonSummary();
    }

    // =========================================================================
    // Browser card
    // =========================================================================

    _mountBrowserCard(browser) {
        if (!browser) return null;

        const { root, refs, bind, dispose } = BrowserCardTemplate.stamp();
        this._cardCleanups.push(dispose);

        if (browser.error) {
            refs.toggleLabel.remove();
            refs.statusDot.classList.add('source-status-error');

            const { errorEl, retryBtn } = this._createErrorElement(
                'Could not detect browsers.',
                'intel-source-retry-browser',
                'Retry browser detection'
            );
            refs.body.appendChild(errorEl);

            bind(retryBtn, 'click', () => this._fetchSourceStatus());
        } else {
            const hasInstalledBrowsers = browser.installed && browser.installed.length > 0;
            refs.statusDot.classList.add(hasInstalledBrowsers ? 'source-status-ok' : 'source-status-warn');
            refs.toggleInput.checked = this.domainService.sourceToggles.browser && hasInstalledBrowsers;
            refs.toggleInput.disabled = !hasInstalledBrowsers;

            if (hasInstalledBrowsers) {
                const detail = document.createElement('div');
                detail.className = 'intel-source-detail';

                const label = document.createElement('label');
                label.htmlFor = 'intel-browser-select';
                label.textContent = 'Reads recent page titles from your browsing history to understand what topics you are researching.';

                const select = document.createElement('select');
                select.id = 'intel-browser-select';
                for (const b of browser.installed) {
                    const opt = document.createElement('option');
                    opt.value = b.value;
                    opt.textContent = b.label;
                    if (b.value === this.domainService.selectedBrowser) opt.selected = true;
                    select.appendChild(opt);
                }

                detail.appendChild(label);
                detail.appendChild(select);
                refs.body.appendChild(detail);

                // Profile selection — show checkboxes for the selected browser's profiles
                const profileContainer = document.createElement('div');
                profileContainer.className = 'intel-profile-list';
                profileContainer.id = 'intel-browser-profiles';
                refs.body.appendChild(profileContainer);

                this._renderProfileCheckboxes(browser, profileContainer, bind);

                bind(select, 'change', (e) => {
                    this.domainService.selectedBrowser = e.target.value;
                    // Reset exclusions when switching browsers — profiles differ per browser
                    this.domainService.excludedProfiles.length = 0;
                    this._renderProfileCheckboxes(browser, profileContainer, bind);
                });
            } else {
                const detail = document.createElement('div');
                detail.className = 'intel-source-detail';
                detail.textContent = 'No supported browsers detected. AetherArena supports Chrome, Edge, and Chromium.';
                refs.body.appendChild(detail);
            }

            bind('toggleInput', 'change', (e) => {
                e.stopPropagation();
                this.domainService.sourceToggles.browser = e.target.checked;
                
                if (e.target.checked && hasInstalledBrowsers) {
                    this.domainService.excludedProfiles.length = 0;
                    const profileContainer = refs.body.querySelector('.intel-profile-list');
                    if (profileContainer) {
                        this._renderProfileCheckboxes(browser, profileContainer, bind);
                    }
                }
                
                this._renderDaemonSummary();
            });
        }

        this._bindCardCollapseHandlers(refs, bind);
        refs.card.classList.add('card-enter');
        return root;
    }

    /**
     * Render profile checkboxes for the currently selected browser.
     * All profiles are included by default; unchecking adds to _excludedProfiles.
     * @param {Object} browserStatus - Full browser status from API
     * @param {HTMLElement} container - Container element for profile checkboxes
     * @param {Function} bind - Card stamp bind function
     */
    _renderProfileCheckboxes(browserStatus, container, bind) {
        container.replaceChildren();

        const selected = browserStatus.installed?.find(b => b.value === this.domainService.selectedBrowser);
        if (!selected || !selected.profiles || selected.profiles.length === 0) return;

        // Only show profile selection if there are 2+ profiles
        if (selected.profiles.length < 2) return;

        const heading = document.createElement('div');
        heading.className = 'intel-profile-heading';
        heading.textContent = 'Include these profiles:';
        container.appendChild(heading);

        for (const profileName of selected.profiles) {
            const label = document.createElement('label');
            label.className = 'intel-profile-item';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = profileName;
            checkbox.checked = !this.domainService.excludedProfiles.includes(profileName);

            const displayName = profileName === 'Default' ? 'Default Profile' : profileName;
            const nameSpan = document.createElement('span');
            nameSpan.className = 'intel-profile-name';
            nameSpan.textContent = displayName;

            label.appendChild(checkbox);
            label.appendChild(nameSpan);
            container.appendChild(label);

            bind(checkbox, 'change', (e) => {
                e.stopPropagation();
                if (e.target.checked) {
                    const idx = this.domainService.excludedProfiles.indexOf(profileName);
                    if (idx !== -1) this.domainService.excludedProfiles.splice(idx, 1);
                } else {
                    if (!this.domainService.excludedProfiles.includes(profileName)) {
                        this.domainService.excludedProfiles.push(profileName);
                    }
                }

                // Guard: all profiles excluded = browser source is useless.
                // Auto-disable the browser toggle and inform user.
                if (this.domainService.excludedProfiles.length >= selected.profiles.length) {
                    this.domainService.sourceToggles.browser = false;
                    const browserToggle = container.closest('.intel-source-card')
                        ?.querySelector('.intel-source-toggle input[type="checkbox"]');
                    if (browserToggle) browserToggle.checked = false;
                    Toast.info('All profiles excluded. Web activity has been disabled.');
                    this._renderDaemonSummary();
                }
            });
        }
    }

    // =========================================================================
    // Email card
    // =========================================================================

    _mountEmailCard(email) {
        if (!email) return null;

        const { root, refs, bind, dispose } = EmailCardTemplate.stamp();
        this._cardCleanups.push(dispose);

        const isMac = email.platform === 'darwin';

        if (!isMac) {
            // Not macOS — unavailable. Disable toggle AND update shared state
            // so saveConfig sends email_enabled: false (daemon can't run here).
            refs.statusDot.classList.add('source-status-unavailable');
            refs.platformBadge.textContent = 'macOS Only';
            refs.toggleInput.disabled = true;
            refs.toggleInput.checked = false;
            this.domainService.sourceToggles.email = false;

            const detail = document.createElement('div');
            detail.className = 'intel-source-detail';
            detail.textContent = 'Email activity tracking is currently available on macOS only.';
            refs.body.appendChild(detail);
        } else if (email.error) {
            // Error state: hide toggle, show error
            refs.toggleLabel.remove();
            refs.statusDot.classList.add('source-status-error');

            const { errorEl, retryBtn } = this._createErrorElement(
                'Could not check email access.',
                'intel-source-retry-email',
                'Retry email access check'
            );
            refs.body.appendChild(errorEl);

            bind(retryBtn, 'click', () => this._fetchSourceStatus());
        } else {
            // macOS, no error
            refs.statusDot.classList.add(email.accessible ? 'source-status-ok' : 'source-status-warn');
            refs.toggleInput.checked = this.domainService.sourceToggles.email;

            if (email.accessible) {
                const detail = document.createElement('div');
                detail.className = 'intel-source-detail';
                const checkIcon = document.createElement('i');
                checkIcon.className = 'fas fa-check-circle';
                checkIcon.style.color = 'var(--color-success)';
                detail.appendChild(checkIcon);
                detail.append(' Reads recent email subjects and senders to understand your current projects and conversations. Message bodies are not accessed.');
                refs.body.appendChild(detail);
            } else {
                // Permission guide
                const guide = document.createElement('div');
                guide.className = 'source-permission-guide';

                const msgSpan = document.createElement('span');
                msgSpan.textContent = 'AetherArena uses macOS Automation to read email metadata only \u2014 message bodies are not accessed.';
                guide.appendChild(msgSpan);

                const instrSpan = document.createElement('span');
                instrSpan.append('Grant permission at: ');
                const codeEl = document.createElement('code');
                codeEl.textContent = email.permission_instructions || '';
                instrSpan.appendChild(codeEl);
                guide.appendChild(instrSpan);

                if (email.restart_note) {
                    const noteSpan = document.createElement('span');
                    noteSpan.style.fontSize = '10px';
                    noteSpan.style.opacity = '0.7';
                    noteSpan.textContent = email.restart_note;
                    guide.appendChild(noteSpan);
                }

                const actions = document.createElement('div');
                actions.className = 'source-permission-actions';

                const openSettingsBtn = document.createElement('button');
                openSettingsBtn.id = 'intel-email-open-settings';
                openSettingsBtn.className = 'btn-accent';
                openSettingsBtn.setAttribute('aria-label', 'Open macOS System Settings to grant Mail.app automation permission');
                openSettingsBtn.textContent = 'Open System Settings';

                const checkAgainBtn = document.createElement('button');
                checkAgainBtn.id = 'intel-email-check-again';
                checkAgainBtn.setAttribute('aria-label', 'Re-check email access after granting permission');
                checkAgainBtn.textContent = 'Check Again';

                actions.appendChild(openSettingsBtn);
                actions.appendChild(checkAgainBtn);
                guide.appendChild(actions);
                refs.body.appendChild(guide);

                bind(openSettingsBtn, 'click', () => {
                    try {
                        const aether = typeof window !== 'undefined' ? window['aether'] : null;
                        if (aether?.shell?.openExternal) {
                            aether.shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
                        }
                    } catch (err) {
                        this._log.warn('[IntelligenceStep] Could not open System Settings:', err);
                    }
                });

                bind(checkAgainBtn, 'click', () => this._fetchSourceStatus());
            }

            bind('toggleInput', 'change', (e) => {
                e.stopPropagation();
                this.domainService.sourceToggles.email = e.target.checked;
                this._renderDaemonSummary();
            });
        }

        this._bindCardCollapseHandlers(refs, bind);
        refs.card.classList.add('card-enter');
        return root;
    }

    // =========================================================================
    // Filesystem card
    // =========================================================================

    _mountFilesystemCard() {
        const { root, refs, bind, dispose } = FilesystemCardTemplate.stamp();
        this._cardCleanups.push(dispose);
        this._filesystemCardRefs = refs;

        const count = this.domainService.getLocationCount();
        refs.statusDot.classList.add(count > 0 ? 'source-status-ok' : 'source-status-warn');
        refs.toggleInput.checked = this.domainService.sourceToggles.filesystem && count > 0;
        refs.toggleInput.disabled = count <= 0;

        this._updateFilesystemBody(count);

        bind('toggleInput', 'change', (e) => {
            e.stopPropagation();
            this.domainService.sourceToggles.filesystem = e.target.checked;
            this._renderDaemonSummary();
        });

        this._bindCardCollapseHandlers(refs, bind);
        refs.card.classList.add('card-enter');
        return root;
    }

    _updateFilesystemBody(count) {
        const body = this._filesystemCardRefs?.body;
        if (!body) return;

        body.replaceChildren();

        const detail = document.createElement('div');
        detail.className = 'intel-source-detail';

        if (count > 0) {
            detail.append('Watches for file changes (new, modified, deleted) in ');
            const strong = document.createElement('strong');
            strong.id = 'intel-fs-count';
            strong.textContent = String(count);
            detail.appendChild(strong);
            detail.append(` selected folder${count !== 1 ? 's' : ''} to keep suggestions current.`);
        } else {
            detail.textContent = 'Select folders above to enable file change tracking.';
            detail.classList.add('intel-source-disabled-msg');
        }

        body.appendChild(detail);
    }

    // =========================================================================
    // Reactive filesystem card updates
    // =========================================================================

    _onStorageLocationChanged() {
        const count = this.domainService.getLocationCount();
        const fsRefs = this._filesystemCardRefs;
        if (!fsRefs) return;

        const wasDisabled = fsRefs.toggleInput?.disabled;

        // Update body content
        this._updateFilesystemBody(count);

        // Update toggle
        if (fsRefs.toggleInput) {
            fsRefs.toggleInput.disabled = count === 0;

            if (count === 0) {
                // No locations: auto-disable filesystem source
                fsRefs.toggleInput.checked = false;
                this.domainService.sourceToggles.filesystem = false;
            } else if (wasDisabled && count > 0) {
                // Transition from 0 to 1+ locations: auto-enable with highlight
                this.domainService.sourceToggles.filesystem = true;
                fsRefs.toggleInput.checked = true;

                // Brief highlight animation on the filesystem card
                if (fsRefs.card) {
                    fsRefs.card.classList.add('card-highlight');
                    if (this._fsHighlightTimer) clearTimeout(this._fsHighlightTimer);
                    this._fsHighlightTimer = setTimeout(() => {
                        if (fsRefs.card) fsRefs.card.classList.remove('card-highlight');
                        this._fsHighlightTimer = null;
                    }, 1500);
                }
            } else if (!fsRefs.toggleInput.checked && this.domainService.sourceToggles.filesystem) {
                fsRefs.toggleInput.checked = true;
            }
        }

        // Update status dot
        if (fsRefs.statusDot) {
            fsRefs.statusDot.classList.remove('source-status-ok', 'source-status-warn');
            fsRefs.statusDot.classList.add(count > 0 ? 'source-status-ok' : 'source-status-warn');
        }

        this._renderDaemonSummary();
    }

    // =========================================================================
    // Storage location management
    // =========================================================================

    async _selectPrimaryStorage() {
        try {
            const aether = typeof window !== 'undefined' ? window['aether'] : null;
            if (!aether?.dialog?.showDirectoryPicker) {
                Toast.warning('Directory picker not available in this context.');
                return;
            }

            const dirPath = await aether.dialog.showDirectoryPicker();
            if (!dirPath) return;

            // If this path is already in secondary, remove it from there
            const secIdx = this._selectedPaths.findIndex(p => p.path === dirPath);
            if (secIdx !== -1) {
                this._selectedPaths.splice(secIdx, 1);
                this._renderSecondaryContent();
            }

            this._primaryPath.value = dirPath;
            if (!this._primaryPath.mode) this._primaryPath.mode = 'combined';
            this._renderPrimaryContent();
            this._onStorageLocationChanged();
        } catch (err) {
            this._log.error('[OnboardingModal] Primary storage picker failed:', err);
            Toast.error('Failed to open directory picker.');
        }
    }

    async _addSecondaryLocation() {
        try {
            const aether = typeof window !== 'undefined' ? window['aether'] : null;
            if (!aether?.dialog?.showDirectoryPicker) {
                Toast.warning('Directory picker not available in this context.');
                return;
            }

            const dirPath = await aether.dialog.showDirectoryPicker();
            if (!dirPath) return;

            if (dirPath === this._primaryPath.value) {
                Toast.info('This folder is already your primary storage.');
                return;
            }

            if (this._selectedPaths.some(p => p.path === dirPath)) {
                Toast.info('This location is already added.');
                return;
            }

            this._selectedPaths.push({ path: dirPath, mode: 'combined' });
            this._renderSecondaryContent();
            this._onStorageLocationChanged();
        } catch (err) {
            this._log.error('[OnboardingModal] Secondary folder picker failed:', err);
            Toast.error('Failed to open directory picker.');
        }
    }

    // =========================================================================
    // Shared card helpers
    // =========================================================================

    /**
     * Bind collapse/expand click + keyboard handlers on a source card header.
     * @param {Object} refs - Card stamp refs (must have .card and .header)
     * @param {Function} bind - Card stamp bind function
     */
    _bindCardCollapseHandlers(refs, bind) {
        const toggleCollapse = (e) => {
            if (e.target.closest('.intel-source-toggle') || e.target.closest('select')) return;
            const isCollapsed = refs.card.classList.toggle('collapsed');
            refs.header.setAttribute('aria-expanded', String(!isCollapsed));
        };
        bind('header', 'click', toggleCollapse);
        bind('header', 'keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleCollapse(e);
            }
        });
    }

    /**
     * Create an error element with icon, message, and retry button.
     * @param {string} text - Error message
     * @param {string} retryId - ID for the retry button
     * @param {string} retryLabel - aria-label for the retry button
     * @returns {{ errorEl: HTMLElement, retryBtn: HTMLElement }}
     */
    _createErrorElement(text, retryId, retryLabel) {
        const errorEl = document.createElement('div');
        errorEl.className = 'intel-source-error';
        errorEl.setAttribute('role', 'alert');

        const icon = document.createElement('i');
        icon.className = 'fas fa-exclamation-circle';
        icon.setAttribute('aria-hidden', 'true');

        const span = document.createElement('span');
        span.textContent = text;

        const retryBtn = document.createElement('button');
        retryBtn.id = retryId;
        retryBtn.setAttribute('aria-label', retryLabel);
        retryBtn.textContent = 'Retry';

        errorEl.appendChild(icon);
        errorEl.appendChild(span);
        errorEl.appendChild(retryBtn);

        return { errorEl, retryBtn };
    }

    // =========================================================================
    // Utilities
    // =========================================================================

    _abbreviatePath(fullPath) {
        if (!fullPath) return '';
        const home = typeof process !== 'undefined' ? process.env.HOME : null;
        if (home && fullPath.startsWith(home + '/')) {
            return '~' + fullPath.slice(home.length);
        }
        const parts = fullPath.split('/').filter(Boolean);
        if (parts.length <= 3) return fullPath;
        return '\u2026/' + parts.slice(-2).join('/');
    }

    getConsolidatedData() {
        return this.domainService.getConsolidatedData();
    }

    getSaveReadiness() {
        return this.domainService.getSaveReadiness();
    }

    _renderDaemonSummary() {
        const summary = this._refs?.daemonSummary;
        if (!summary) return;

        summary.replaceChildren();

        const states = this.domainService.computeDaemonStates();

        const title = document.createElement('div');
        title.className = 'intel-daemon-summary-title';
        title.textContent = 'Background services in this setup';
        summary.appendChild(title);

        const list = document.createElement('div');
        list.className = 'intel-daemon-summary-list';

        this._appendDaemonSummaryRow(list, 'Web activity reader', states.browserEnabled);
        this._appendDaemonSummaryRow(list, 'Email activity reader', states.emailEnabled);
        this._appendDaemonSummaryRow(list, 'File activity watcher', states.fileSystemEnabled);
        this._appendDaemonSummaryRow(list, 'Suggestion planner', states.queryGenerationEnabled);
        this._appendDaemonSummaryRow(list, 'File indexer', states.fileIndexingEnabled);

        summary.appendChild(list);

        const note = document.createElement('div');
        note.className = 'intel-daemon-summary-note';
        note.textContent = 'Services start after restart and run locally in the background. Activity logs auto-delete after 24 hours.';
        summary.appendChild(note);

        if (states.proactive && this.domainService.sourceStatusLoading) {
            const pending = document.createElement('div');
            pending.className = 'intel-daemon-summary-pending';
            pending.textContent = 'Still checking browser and email availability.';
            summary.appendChild(pending);
        }
    }

    _appendDaemonSummaryRow(container, label, enabled) {
        const row = document.createElement('div');
        row.className = 'intel-daemon-summary-row';

        const labelEl = document.createElement('span');
        labelEl.className = 'intel-daemon-summary-label';
        labelEl.textContent = label;

        const valueEl = document.createElement('span');
        valueEl.className = `intel-daemon-summary-value ${enabled ? 'is-enabled' : 'is-disabled'}`;
        valueEl.textContent = enabled ? 'On' : 'Off';

        row.appendChild(labelEl);
        row.appendChild(valueEl);
        container.appendChild(row);
    }

    // =========================================================================
    // Save configuration — TWO MECHANISMS
    // =========================================================================

    /**
     * Save intelligence configuration: validates readiness.
     * API calls removed - actual persistence is consolidated in OnboardingModal.finish().
     *
     * Critical guarantee: onboarding completion is blocked unless source checks
     * are finished (unless bypass is used).
     */
    async saveConfig(options = {}) {
        const allowPendingSourceStatus = options.allowPendingSourceStatus === true;
        const readiness = this.getSaveReadiness();
        if (!readiness.ready && !allowPendingSourceStatus) {
            const error = new Error(readiness.message);
            error.code = readiness.reason;
            throw error;
        }

        this._log.debug('[IntelligenceStep] Config validated for consolidation');
    }

    // =========================================================================
    // Cleanup
    // =========================================================================

    _disposeCardCleanups() {
        for (const d of this._cardCleanups) d();
        this._cardCleanups = [];
        this._filesystemCardRefs = null;
    }

    _disposeChipCleanups() {
        if (this._primaryChipDispose) {
            this._primaryChipDispose();
            this._primaryChipDispose = null;
        }
        for (const d of this._secondaryChipCleanups) d();
        this._secondaryChipCleanups = [];
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;

        // 0. Abort any in-flight network request FIRST (prevents post-dispose state mutation)
        this._abortFetch();

        // 1. Main layout stamps
        for (const d of this._stamps) d();
        this._stamps = [];

        // 2. Card stamps
        this._disposeCardCleanups();

        // 3. Chip stamps
        this._disposeChipCleanups();

        // 4. Non-stamp cleanups
        for (const c of this._cleanups) c();
        this._cleanups = [];

        if (this._fsHighlightTimer) {
            clearTimeout(this._fsHighlightTimer);
            this._fsHighlightTimer = null;
        }

        if (this.domainService) {
            this.domainService.dispose();
            this.domainService = null;
        }

        // 5. Null ALL references
        this._refs = null;
        this._endpoint = null;
        this._bodyEl = null;
        this._log = null;
        this._primaryPath = null;
        this._selectedPaths = null;
        this._intelligenceToggles = null;
    }
}

module.exports = IntelligenceStepController;
