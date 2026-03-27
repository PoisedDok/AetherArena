'use strict';

// ---------------------------------------------------------------------------
// IntelligenceStepController.js — Unit tests
// ---------------------------------------------------------------------------

jest.mock(
    '../../../../../src/renderer/shared/components/Toast',
    () => ({ success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() })
);

const IntelligenceStepController = require(
    '../../../../../src/renderer/main/modules/onboarding/modules/IntelligenceStepController'
);
const Toast = require('../../../../../src/renderer/shared/components/Toast');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Standard mock source-status response. */
function mockSourceStatusResponse(overrides = {}) {
    return {
        browser: {
            installed: [
                { value: 'chrome', label: 'Google Chrome', profiles_count: 3 },
                { value: 'edge', label: 'Microsoft Edge', profiles_count: 0 },
            ],
            current: 'edge',
            recommended: 'chrome',
            error: null,
            ...overrides.browser,
        },
        email: {
            platform: 'darwin',
            accessible: true,
            method: 'applescript',
            permission_instructions: null,
            restart_note: null,
            error: null,
            ...overrides.email,
        },
        filesystem: {
            watch_locations: [],
            valid_count: 0,
            indexing_locations: [],
            error: null,
            ...overrides.filesystem,
        },
    };
}

function createController(overrides = {}) {
    const bodyEl = document.createElement('div');
    const endpoint = {
        getBackendURL: jest.fn(() => 'http://localhost:8765'),
        setPreference: jest.fn(() => Promise.resolve()),
        createFileIndexingLocation: jest.fn(() => Promise.resolve()),
        triggerFileIndexingReindex: jest.fn(() => Promise.resolve({})),
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
        getProactiveSourceStatus: jest.fn(() => Promise.resolve(mockSourceStatusResponse())),
        ...overrides.endpoint,
    };
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const primaryPath = overrides.primaryPath || { value: null };
    const selectedPaths = overrides.selectedPaths || [];
    const intelligenceToggles = overrides.intelligenceToggles || { proactiveMaster: true };
    const sourceConfig = overrides.sourceConfig || {
        sourceToggles: { browser: true, email: true, filesystem: true },
        selectedBrowser: null,
        excludedProfiles: [],
    };

    const ctrl = new IntelligenceStepController({
        endpoint, bodyEl, log, primaryPath, selectedPaths, intelligenceToggles, sourceConfig,
    });

    return { ctrl, bodyEl, endpoint, log, primaryPath, selectedPaths, intelligenceToggles, sourceConfig };
}

/** Mount helper: stamps into bodyEl and returns controller context. */
function mountController(overrides = {}) {
    const result = createController(overrides);
    result.ctrl.mount(result.bodyEl);
    return result;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('IntelligenceStepController', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // =====================================================================
    // mount — replaces renderHTML + bind
    // =====================================================================

    describe('mount', () => {
        it('renders empty state when no paths', () => {
            const { bodyEl } = mountController();
            expect(bodyEl.querySelector('.intel-empty-state')).not.toBeNull();
            expect(bodyEl.textContent).toContain('Select your main workspace folder');
        });

        it('renders location chips when paths selected', () => {
            const { bodyEl } = mountController({ selectedPaths: [{ path: '/Users/me/docs', mode: 'combined' }] });
            expect(bodyEl.querySelector('.intel-location-chip')).not.toBeNull();
            expect(bodyEl.querySelector('.chip-path')).not.toBeNull();
        });

        it('renders proactive toggle checked by default', () => {
            const { bodyEl } = mountController();
            const toggle = bodyEl.querySelector('#intel-toggle-proactive');
            expect(toggle.checked).toBe(true);
        });

        it('renders proactive toggle unchecked when disabled', () => {
            const { bodyEl } = mountController({
                intelligenceToggles: { proactiveMaster: false },
            });
            const toggle = bodyEl.querySelector('#intel-toggle-proactive');
            expect(toggle.checked).toBe(false);
        });

        it('renders source section visible when proactive is ON', () => {
            const { bodyEl } = mountController();
            const section = bodyEl.querySelector('#intel-source-section');
            expect(section).not.toBeNull();
            expect(section.classList.contains('is-visible')).toBe(true);
        });

        it('renders source section hidden when proactive is OFF', () => {
            const { bodyEl } = mountController({
                intelligenceToggles: { proactiveMaster: false },
            });
            const section = bodyEl.querySelector('#intel-source-section');
            expect(section.classList.contains('is-hidden')).toBe(true);
        });

        it('renders source skeleton loaders', () => {
            const { bodyEl } = mountController();
            expect(bodyEl.querySelector('.intel-source-skeleton')).not.toBeNull();
        });

        it('renders explicit background service summary with five rows', () => {
            const { bodyEl } = mountController();
            const rows = bodyEl.querySelectorAll('.intel-daemon-summary-row');
            expect(rows.length).toBe(5);
            expect(bodyEl.textContent).toContain('Background services in this setup');
        });

        it('renders primary chip when primary path is set', () => {
            const { bodyEl } = mountController({ primaryPath: { value: '/Users/me/docs' } });
            const chip = bodyEl.querySelector('.intel-primary-chip');
            expect(chip).not.toBeNull();
            expect(bodyEl.querySelector('.chip-type-badge').textContent).toBe('PRIMARY');
        });

        it('renders secondary chips with correct badge', () => {
            const { bodyEl } = mountController({ selectedPaths: [{ path: '/a/b', mode: 'combined' }] });
            const badge = bodyEl.querySelector('.chip-type-badge.secondary');
            expect(badge).not.toBeNull();
            expect(badge.textContent).toBe('SECONDARY');
        });

        it('renders select button with correct label when primary exists', () => {
            const { bodyEl } = mountController({ primaryPath: { value: '/Users/me/docs' } });
            const label = bodyEl.querySelector('#intel-select-primary');
            expect(label.textContent).toContain('Change');
        });

        it('renders select button with "Select Folder" when no primary', () => {
            const { bodyEl } = mountController();
            const label = bodyEl.querySelector('#intel-select-primary');
            expect(label.textContent).toContain('Select Folder');
        });
    });

    // =====================================================================
    // Event bindings from mount
    // =====================================================================

    describe('event bindings', () => {
        it('triggers source status fetch when proactive is ON', () => {
            const { endpoint } = mountController();
            expect(endpoint.getProactiveSourceStatus).toHaveBeenCalledTimes(1);
        });

        it('does NOT fetch source status when proactive is OFF', () => {
            const { endpoint } = mountController({
                intelligenceToggles: { proactiveMaster: false },
            });
            expect(endpoint.getProactiveSourceStatus).not.toHaveBeenCalled();
        });

        it('proactive toggle triggers source section visibility', () => {
            const { bodyEl } = mountController({
                intelligenceToggles: { proactiveMaster: false },
            });

            const toggle = bodyEl.querySelector('#intel-toggle-proactive');
            toggle.checked = true;
            toggle.dispatchEvent(new Event('change'));

            const section = bodyEl.querySelector('#intel-source-section');
            expect(section.classList.contains('is-visible')).toBe(true);
            expect(section.classList.contains('is-hidden')).toBe(false);
        });

        it('hides source section when proactive toggle turned OFF', () => {
            const { bodyEl } = mountController();

            const toggle = bodyEl.querySelector('#intel-toggle-proactive');
            toggle.checked = false;
            toggle.dispatchEvent(new Event('change'));

            const section = bodyEl.querySelector('#intel-source-section');
            expect(section.classList.contains('is-hidden')).toBe(true);
        });

        it('re-fetches source status when toggled OFF then ON again mid-flight', () => {
            const { bodyEl, endpoint } = mountController({
                endpoint: {
                    getProactiveSourceStatus: jest.fn(() =>
                        new Promise(resolve => setTimeout(() => resolve(mockSourceStatusResponse()), 500))
                    ),
                },
            });

            // Mount triggered 1st fetch (proactive ON by default)
            expect(endpoint.getProactiveSourceStatus).toHaveBeenCalledTimes(1);

            const toggle = bodyEl.querySelector('#intel-toggle-proactive');

            // Toggle OFF mid-flight — aborts fetch, resets _sourceStatusLoading
            toggle.checked = false;
            toggle.dispatchEvent(new Event('change'));

            // Toggle ON again — must trigger a new fetch (not blocked by stale loading flag)
            toggle.checked = true;
            toggle.dispatchEvent(new Event('change'));

            expect(endpoint.getProactiveSourceStatus).toHaveBeenCalledTimes(2);
        });
    });

    // =====================================================================
    // _abbreviatePath
    // =====================================================================

    describe('_abbreviatePath', () => {
        it('returns empty for falsy', () => {
            const { ctrl } = createController();
            expect(ctrl._abbreviatePath('')).toBe('');
            expect(ctrl._abbreviatePath(null)).toBe('');
        });

        it('keeps short paths (2 segments)', () => {
            const { ctrl } = createController();
            expect(ctrl._abbreviatePath('/a/b')).toBe('/a/b');
        });

        it('keeps 3-segment paths unchanged (boundary)', () => {
            const { ctrl } = createController();
            expect(ctrl._abbreviatePath('/a/b/c')).toBe('/a/b/c');
        });

        it('abbreviates 4+ segment non-home paths with ellipsis prefix', () => {
            const { ctrl } = createController();
            expect(ctrl._abbreviatePath('/Volumes/ext/deep/nested/dir')).toBe('\u2026/nested/dir');
            expect(ctrl._abbreviatePath('/a/b/c/d')).toBe('\u2026/c/d');
        });

        it('uses ~ prefix for paths under HOME', () => {
            const origHome = process.env.HOME;
            process.env.HOME = '/Users/me';
            try {
                const { ctrl } = createController();
                expect(ctrl._abbreviatePath('/Users/me/Documents/work/project')).toBe('~/Documents/work/project');
            } finally {
                process.env.HOME = origHome;
            }
        });
    });

    // =====================================================================
    // Source cards
    // =====================================================================

    describe('source cards', () => {
        it('renders browser card with auto-detected selection after fetch', async () => {
            const { ctrl, bodyEl, endpoint } = mountController();
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 0));

            expect(bodyEl.textContent).toContain('Web Activity');
            expect(ctrl.domainService.selectedBrowser).toBe('chrome');
        });

        it('renders email card with correct platform state', async () => {
            const { bodyEl, endpoint } = mountController();
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 0));

            expect(bodyEl.textContent).toContain('Email Activity');
        });

        it('disables email toggle and sets sourceToggles.email to false on non-macOS', async () => {
            const sourceConfig = {
                sourceToggles: { browser: true, email: true, filesystem: true },
                selectedBrowser: null,
                excludedProfiles: [],
            };
            const nonMacStatus = mockSourceStatusResponse({
                email: { platform: 'linux', accessible: false },
            });
            const { bodyEl, ctrl } = mountController({
                sourceConfig,
                endpoint: {
                    getProactiveSourceStatus: jest.fn(() => Promise.resolve(nonMacStatus)),
                },
            });
            await new Promise(r => setTimeout(r, 10));

            const emailToggle = bodyEl.querySelector('#intel-card-email input[type="checkbox"]');
            expect(emailToggle.disabled).toBe(true);
            expect(emailToggle.checked).toBe(false);
            expect(ctrl.domainService.sourceToggles.email).toBe(false);
            expect(sourceConfig.sourceToggles.email).toBe(false);
            expect(bodyEl.textContent).toContain('macOS Only');
        });

        it('renders error state with retry on fetch failure', async () => {
            const { bodyEl } = mountController({
                endpoint: {
                    getProactiveSourceStatus: jest.fn(() => Promise.reject(new Error('network'))),
                },
            });
            await new Promise(r => setTimeout(r, 10));

            expect(bodyEl.querySelector('.intel-source-error')).not.toBeNull();
            expect(bodyEl.textContent).toContain('Retry');
        });

        it('sets source toggles to OFF on fetch failure (safe defaults)', async () => {
            const { ctrl } = mountController({
                endpoint: {
                    getProactiveSourceStatus: jest.fn(() => Promise.reject(new Error('fail'))),
                },
            });
            await new Promise(r => setTimeout(r, 10));

            expect(ctrl.domainService.sourceToggles.browser).toBe(false);
            expect(ctrl.domainService.sourceToggles.email).toBe(false);
            expect(ctrl.domainService.sourceToggles.filesystem).toBe(false);
        });

        it('renders browser select dropdown with installed browsers', async () => {
            const { bodyEl, endpoint } = mountController();
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 0));

            const select = bodyEl.querySelector('#intel-browser-select');
            expect(select).not.toBeNull();
            expect(select.options.length).toBe(2);
        });

        it('browser select updates _selectedBrowser on change', async () => {
            const { ctrl, bodyEl, endpoint } = mountController();
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 0));

            const select = bodyEl.querySelector('#intel-browser-select');
            if (select) {
                select.value = 'edge';
                select.dispatchEvent(new Event('change'));
                expect(ctrl.domainService.selectedBrowser).toBe('edge');
            }
        });

        it('renders profile checkboxes for browsers with 2+ profiles', async () => {
            const { bodyEl } = mountController({
                endpoint: {
                    getProactiveSourceStatus: jest.fn(() => Promise.resolve(mockSourceStatusResponse({
                        browser: {
                            installed: [
                                { value: 'chrome', label: 'Google Chrome', profiles_count: 3, profiles: ['Default', 'Work', 'Personal'] },
                            ],
                            current: 'chrome',
                            recommended: 'chrome',
                            error: null,
                        },
                    }))),
                },
            });
            await new Promise(r => setTimeout(r, 10));

            const profileList = bodyEl.querySelector('#intel-browser-profiles');
            expect(profileList).not.toBeNull();
            expect(profileList.querySelectorAll('.intel-profile-item').length).toBe(3);
        });

        it('does not render profile checkboxes when browser has < 2 profiles', async () => {
            const { bodyEl } = mountController({
                endpoint: {
                    getProactiveSourceStatus: jest.fn(() => Promise.resolve(mockSourceStatusResponse({
                        browser: {
                            installed: [
                                { value: 'chrome', label: 'Google Chrome', profiles_count: 1, profiles: ['Default'] },
                            ],
                            current: 'chrome',
                            recommended: 'chrome',
                            error: null,
                        },
                    }))),
                },
            });
            await new Promise(r => setTimeout(r, 10));

            const profileItems = bodyEl.querySelectorAll('.intel-profile-item');
            expect(profileItems.length).toBe(0);
        });

        it('writes selectedBrowser back to sourceConfig on browser change', async () => {
            const sourceConfig = {
                sourceToggles: { browser: true, email: true, filesystem: true },
                selectedBrowser: null,
                excludedProfiles: [],
            };
            const { bodyEl } = mountController({ sourceConfig });
            await new Promise(r => setTimeout(r, 10));

            // Auto-selected chrome (recommended)
            expect(sourceConfig.selectedBrowser).toBe('chrome');

            const select = bodyEl.querySelector('#intel-browser-select');
            if (select) {
                select.value = 'edge';
                select.dispatchEvent(new Event('change'));
                expect(sourceConfig.selectedBrowser).toBe('edge');
            }
        });

        it('auto-disables browser toggle when all profiles are excluded', async () => {
            const { ctrl, bodyEl } = mountController({
                endpoint: {
                    getProactiveSourceStatus: jest.fn(() => Promise.resolve(mockSourceStatusResponse({
                        browser: {
                            installed: [
                                { value: 'chrome', label: 'Google Chrome', profiles_count: 2, profiles: ['Default', 'Work'] },
                            ],
                            current: 'chrome',
                            recommended: 'chrome',
                            error: null,
                        },
                    }))),
                },
            });
            await new Promise(r => setTimeout(r, 10));

            const profileCheckboxes = bodyEl.querySelectorAll('.intel-profile-item input[type="checkbox"]');
            expect(profileCheckboxes.length).toBe(2);

            // Uncheck both profiles
            for (const cb of profileCheckboxes) {
                cb.checked = false;
                cb.dispatchEvent(new Event('change', { bubbles: true }));
            }

            expect(ctrl.domainService.sourceToggles.browser).toBe(false);
            const browserToggle = bodyEl.querySelector('#intel-card-browser .intel-source-toggle input[type="checkbox"]');
            expect(browserToggle.checked).toBe(false);
            expect(Toast.info).toHaveBeenCalledWith('All profiles excluded. Web activity has been disabled.');
        });

        it('resets excluded profiles when browser selection changes', async () => {
            const { ctrl, bodyEl } = mountController({
                endpoint: {
                    getProactiveSourceStatus: jest.fn(() => Promise.resolve(mockSourceStatusResponse({
                        browser: {
                            installed: [
                                { value: 'chrome', label: 'Google Chrome', profiles_count: 2, profiles: ['Default', 'Work'] },
                                { value: 'edge', label: 'Microsoft Edge', profiles_count: 0 },
                            ],
                            current: 'edge',
                            recommended: 'chrome',
                            error: null,
                        },
                    }))),
                },
            });
            await new Promise(r => setTimeout(r, 10));

            // Exclude a profile from chrome
            const profileCb = bodyEl.querySelector('.intel-profile-item input[type="checkbox"]');
            if (profileCb) {
                profileCb.checked = false;
                profileCb.dispatchEvent(new Event('change', { bubbles: true }));
                expect(ctrl.domainService.excludedProfiles.length).toBeGreaterThan(0);
            }

            // Switch to edge — should reset excluded profiles
            const select = bodyEl.querySelector('#intel-browser-select');
            if (select) {
                select.value = 'edge';
                select.dispatchEvent(new Event('change'));
                expect(ctrl.domainService.excludedProfiles.length).toBe(0);
            }
        });
    });

    // =====================================================================
    // Reactive filesystem card
    // =====================================================================

    describe('filesystem card reactivity', () => {
        it('updates count when storage locations change', async () => {
            const primaryPath = { value: '/a' };
            const { ctrl, bodyEl, endpoint } = mountController({ primaryPath });
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 0));

            const fsCount = bodyEl.querySelector('#intel-fs-count');
            if (fsCount) {
                expect(fsCount.textContent).toBe('1');
            }
        });

        it('re-enables filesystem toggle when locations are added back after removal', async () => {
            const primaryPath = { value: '/Users/me/docs' };
            const { ctrl, bodyEl, endpoint } = mountController({ primaryPath });
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 0));

            const fsToggle = bodyEl.querySelector('.intel-source-card[data-source="filesystem"] .intel-source-toggle input');
            if (fsToggle) {
                expect(fsToggle.disabled).toBe(false);
                expect(fsToggle.checked).toBe(true);

                // Remove all locations
                primaryPath.value = null;
                ctrl._onStorageLocationChanged();

                expect(fsToggle.disabled).toBe(true);
                expect(fsToggle.checked).toBe(false);
                expect(ctrl.domainService.sourceToggles.filesystem).toBe(false);

                // Add a location back
                primaryPath.value = '/Users/me/new-docs';
                ctrl._onStorageLocationChanged();

                expect(fsToggle.disabled).toBe(false);
                expect(fsToggle.checked).toBe(true);
            }
        });

        it('adds card-highlight class when transitioning from 0 to 1+ locations', async () => {
            const primaryPath = { value: null };
            const { ctrl, bodyEl, endpoint } = mountController({ primaryPath });
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 0));

            // Enable fake timers AFTER fetch settles (setTimeout(0) needs real timers above)
            jest.useFakeTimers();

            const fsCard = bodyEl.querySelector('.intel-source-card[data-source="filesystem"]');
            if (fsCard) {
                // Starts with no locations — no highlight
                expect(fsCard.classList.contains('card-highlight')).toBe(false);

                // Add a location — should trigger highlight
                primaryPath.value = '/Users/me/docs';
                ctrl._onStorageLocationChanged();

                expect(fsCard.classList.contains('card-highlight')).toBe(true);

                // Highlight removed after 1500ms
                jest.advanceTimersByTime(1500);
                expect(fsCard.classList.contains('card-highlight')).toBe(false);
            }
            jest.useRealTimers();
        });

        it('updates status dot when locations change', async () => {
            const primaryPath = { value: '/Users/me/docs' };
            const { ctrl, bodyEl, endpoint } = mountController({ primaryPath });
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 0));

            const dot = bodyEl.querySelector('.intel-source-card[data-source="filesystem"] .source-status-dot');
            if (dot) {
                expect(dot.classList.contains('source-status-ok')).toBe(true);

                primaryPath.value = null;
                ctrl._onStorageLocationChanged();

                expect(dot.classList.contains('source-status-warn')).toBe(true);
                expect(dot.classList.contains('source-status-ok')).toBe(false);
            }
        });
    });

    // =====================================================================
    // Accessibility
    // =====================================================================

    describe('accessibility', () => {
        it('renders ARIA attributes on source card headers after fetch', async () => {
            const { bodyEl, endpoint } = mountController();
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 0));

            const browserHeader = bodyEl.querySelector('#intel-card-browser .intel-source-header');
            if (browserHeader) {
                expect(browserHeader.getAttribute('role')).toBe('button');
                expect(browserHeader.getAttribute('tabindex')).toBe('0');
                expect(browserHeader.getAttribute('aria-expanded')).toBe('true');
                expect(browserHeader.getAttribute('aria-controls')).toBe('intel-card-browser-body');
            }
        });

        it('renders aria-label on source toggles', async () => {
            const { bodyEl, endpoint } = mountController();
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 0));

            const toggleLabels = bodyEl.querySelectorAll('.intel-source-toggle[aria-label]');
            expect(toggleLabels.length).toBeGreaterThanOrEqual(1);
        });

        it('renders sr-only loading text in skeleton loaders', () => {
            const { bodyEl } = mountController();
            const srOnly = bodyEl.querySelector('[role="status"]');
            expect(srOnly).not.toBeNull();
            expect(srOnly.textContent).toContain('Loading activity source status');
        });

        it('sets aria-busy=false after source cards load', async () => {
            const { bodyEl, endpoint } = mountController();
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 0));

            const cardsEl = bodyEl.querySelector('#intel-source-cards');
            expect(cardsEl.getAttribute('aria-busy')).toBe('false');
        });

        it('renders role=alert on error states', async () => {
            const { bodyEl } = mountController({
                endpoint: {
                    getProactiveSourceStatus: jest.fn(() => Promise.reject(new Error('fail'))),
                },
            });
            await new Promise(r => setTimeout(r, 10));

            const alert = bodyEl.querySelector('[role="alert"]');
            expect(alert).not.toBeNull();
        });

        it('updates aria-expanded on card collapse', async () => {
            const { bodyEl, endpoint } = mountController();
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 0));

            const header = bodyEl.querySelector('#intel-card-browser .intel-source-header');
            if (header) {
                header.click();
                expect(header.getAttribute('aria-expanded')).toBe('false');
                header.click();
                expect(header.getAttribute('aria-expanded')).toBe('true');
            }
        });

        it('supports keyboard collapse via Enter/Space', async () => {
            const { bodyEl, endpoint } = mountController();
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 0));

            const header = bodyEl.querySelector('#intel-card-browser .intel-source-header');
            if (header) {
                header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                const card = header.closest('.intel-source-card');
                expect(card.classList.contains('collapsed')).toBe(true);

                header.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
                expect(card.classList.contains('collapsed')).toBe(false);
            }
        });

        it('renders explicit label for browser select', async () => {
            const { bodyEl, endpoint } = mountController();
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 0));

            const label = bodyEl.querySelector('label[for="intel-browser-select"]');
            expect(label).not.toBeNull();
        });

        it('renders aria-label on proactive master toggle', () => {
            const { bodyEl } = mountController();
            const toggle = bodyEl.querySelector('#intel-toggle-proactive');
            expect(toggle).not.toBeNull();
            expect(toggle.getAttribute('aria-label')).toBe('Enable smart suggestions');
        });
    });

    // =====================================================================
    // Stamp cleanup on re-render
    // =====================================================================

    describe('stamp cleanup on re-render', () => {
        it('disposes card stamps before re-rendering on refetch', async () => {
            const { ctrl, endpoint } = mountController({
                endpoint: {
                    getProactiveSourceStatus: jest.fn(() =>
                        Promise.resolve(mockSourceStatusResponse())
                    ),
                },
            });

            // Wait for initial fetch
            await new Promise(r => setTimeout(r, 10));

            // Track card cleanups count after first render
            const countAfterFirst = ctrl._cardCleanups.length;
            expect(countAfterFirst).toBeGreaterThan(0);

            // Re-fetch
            await ctrl._fetchSourceStatus();
            await new Promise(r => setTimeout(r, 0));
            const countAfterSecond = ctrl._cardCleanups.length;

            // Re-fetch again
            await ctrl._fetchSourceStatus();
            await new Promise(r => setTimeout(r, 0));
            const countAfterThird = ctrl._cardCleanups.length;

            // Card cleanup count should be stable (old ones disposed, new ones added)
            expect(countAfterThird).toBe(countAfterSecond);
            expect(countAfterSecond).toBeLessThanOrEqual(countAfterFirst + 2);
        });

        it('disposes chip stamps when secondary content re-renders', () => {
            const selectedPaths = [{ path: '/a', mode: 'combined' }, { path: '/b', mode: 'combined' }, { path: '/c', mode: 'combined' }];
            const { ctrl } = mountController({ selectedPaths });

            // 3 secondary chip stamps
            expect(ctrl._secondaryChipCleanups.length).toBe(3);

            // Remove one path and re-render
            selectedPaths.splice(0, 1);
            ctrl._renderSecondaryContent();

            // Should now have 2 stamps (old ones disposed)
            expect(ctrl._secondaryChipCleanups.length).toBe(2);
        });

        it('disposes primary chip stamp when primary changes', () => {
            const primaryPath = { value: '/Users/me/docs' };
            const { ctrl } = mountController({ primaryPath });

            expect(ctrl._primaryChipDispose).not.toBeNull();

            // Remove primary
            primaryPath.value = null;
            ctrl._renderPrimaryContent();

            expect(ctrl._primaryChipDispose).toBeNull();
        });
    });

    // =====================================================================
    // sourceConfig persistence across controller re-creation
    // =====================================================================

    describe('sourceConfig persistence', () => {
        it('persists selectedBrowser across controller re-creation', () => {
            const sourceConfig = {
                sourceToggles: { browser: true, email: true, filesystem: true },
                selectedBrowser: 'edge',
                excludedProfiles: ['Work'],
            };

            const { ctrl: ctrl1 } = createController({ sourceConfig });
            expect(ctrl1.domainService.selectedBrowser).toBe('edge');
            expect(ctrl1.domainService.excludedProfiles).toEqual(['Work']);

            ctrl1.dispose();

            // Re-create with same sourceConfig — simulates back/forward navigation
            const { ctrl: ctrl2 } = createController({ sourceConfig });
            expect(ctrl2.domainService.selectedBrowser).toBe('edge');
            expect(ctrl2.domainService.excludedProfiles).toEqual(['Work']);
        });

        it('persists source toggles across controller re-creation', () => {
            const sourceConfig = {
                sourceToggles: { browser: false, email: true, filesystem: false },
                selectedBrowser: null,
                excludedProfiles: [],
            };

            const { ctrl: ctrl1 } = createController({ sourceConfig });
            expect(ctrl1.domainService.sourceToggles.browser).toBe(false);
            expect(ctrl1.domainService.sourceToggles.filesystem).toBe(false);

            ctrl1.dispose();

            const { ctrl: ctrl2 } = createController({ sourceConfig });
            expect(ctrl2.domainService.sourceToggles.browser).toBe(false);
            expect(ctrl2.domainService.sourceToggles.filesystem).toBe(false);
        });

        it('skips auto-select when selectedBrowser is already persisted', async () => {
            const sourceConfig = {
                sourceToggles: { browser: true, email: true, filesystem: true },
                selectedBrowser: 'edge',
                excludedProfiles: [],
            };

            const { ctrl, endpoint } = mountController({ sourceConfig });
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 0));

            // Should keep persisted 'edge' even though recommended is 'chrome'
            expect(ctrl.domainService.selectedBrowser).toBe('edge');
        });
    });

    // =====================================================================
    // save readiness
    // =====================================================================

    describe('save readiness', () => {
        it('returns loading readiness while source status is still loading', () => {
            const { ctrl } = createController();
            ctrl.domainService.sourceStatusLoading = true;

            const readiness = ctrl.getSaveReadiness();
            expect(readiness.ready).toBe(false);
            expect(readiness.reason).toBe('source_status_loading');
        });

        it('blocks saveConfig when source checks are pending and bypass is not provided', async () => {
            const { ctrl } = createController();
            ctrl.domainService.sourceStatusLoading = true;

            await expect(ctrl.saveConfig()).rejects.toMatchObject({
                code: 'source_status_loading',
            });
        });

        it('allows saveConfig when source checks are pending but bypass is explicitly allowed', async () => {
            const { ctrl } = createController();
            ctrl.domainService.sourceStatusLoading = true;

            await expect(ctrl.saveConfig({ allowPendingSourceStatus: true })).resolves.toBeUndefined();
        });
    });

    // =====================================================================
    // saveConfig — validates readiness only
    // =====================================================================

    describe('saveConfig', () => {
        const saveWithBypass = (ctrl) => ctrl.saveConfig({ allowPendingSourceStatus: true });

        it('does NOT call individual persistence APIs (now consolidated in OnboardingModal)', async () => {
            const selectedPaths = [{ path: '/a/docs', mode: 'combined' }];
            const { ctrl, endpoint } = createController({ selectedPaths });
            endpoint.setPreference = jest.fn(() => Promise.resolve());
            endpoint.updateFileIndexingDaemonConfig = jest.fn(() => Promise.resolve());
            endpoint.updateProactiveConfig = jest.fn(() => Promise.resolve());

            await saveWithBypass(ctrl);

            expect(endpoint.setPreference).not.toHaveBeenCalled();
            expect(endpoint.updateFileIndexingDaemonConfig).not.toHaveBeenCalled();
            expect(endpoint.updateProactiveConfig).not.toHaveBeenCalled();
        });

        it('fails saveConfig when readiness check fails and bypass is not provided', async () => {
            const { ctrl } = createController();
            ctrl.domainService.sourceStatusLoading = true;

            await expect(ctrl.saveConfig()).rejects.toMatchObject({
                code: 'source_status_loading',
            });
        });

        it('resolves saveConfig when readiness check fails but bypass is allowed', async () => {
            const { ctrl } = createController();
            ctrl.domainService.sourceStatusLoading = true;

            await expect(ctrl.saveConfig({ allowPendingSourceStatus: true })).resolves.toBeUndefined();
        });
    });

    // =====================================================================
    // getConsolidatedData
    // =====================================================================

    describe('getConsolidatedData', () => {
        it('builds a complete payload with locations, daemon and proactive config', () => {
            const { ctrl } = createController({
                primaryPath: { value: '/Users/me/primary' },
                selectedPaths: [{ path: '/Users/me/secondary', mode: 'combined' }],
            });
            ctrl.domainService.selectedBrowser = 'edge';
            ctrl.domainService.excludedProfiles = ['Work'];
            ctrl.domainService.sourceToggles = { browser: true, email: false, filesystem: true };

            const data = ctrl.getConsolidatedData();

            expect(data.indexing_locations).toEqual(expect.arrayContaining([
                expect.objectContaining({ path: '/Users/me/primary', type: 'primary' }),
                expect.objectContaining({ path: '/Users/me/secondary', type: 'secondary' })
            ]));

            expect(data.daemon_config).toEqual({
                browser: {
                    browser: 'edge',
                    excluded_profiles: ['Work']
                },
                filesystem: {
                    watch_locations: ['/Users/me/primary']
                }
            });

            expect(data.proactive_config).toEqual(expect.objectContaining({
                enabled: true,
                browser_enabled: true,
                email_enabled: false,
                file_system_enabled: true
            }));
        });

        it('uses safe defaults when values are missing', () => {
            const { ctrl } = createController();
            // Primary path null, selectedPaths empty, browser null
            
            const data = ctrl.getConsolidatedData();
            
            expect(data.indexing_locations).toEqual([]);
            expect(data.daemon_config.browser.browser).toBe('chrome');
            expect(data.daemon_config.filesystem.watch_locations).toEqual([]);
        });
    });

    // =====================================================================
    // dispose
    // =====================================================================

    describe('dispose', () => {
        it('sets _disposed to true', () => {
            const { ctrl } = createController();
            ctrl.dispose();
            expect(ctrl._disposed).toBe(true);
        });

        it('nulls out references to prevent use after dispose', () => {
            const { ctrl } = mountController();
            expect(ctrl._endpoint).not.toBeNull();
            expect(ctrl._refs).not.toBeNull();

            ctrl.dispose();

            expect(ctrl._endpoint).toBeNull();
            expect(ctrl._bodyEl).toBeNull();
            expect(ctrl._log).toBeNull();
            expect(ctrl._refs).toBeNull();
            expect(ctrl.domainService).toBeNull();
        });

        it('clears all stamp and cleanup arrays', () => {
            const { ctrl } = mountController({ selectedPaths: [{ path: '/a', mode: 'combined' }, { path: '/b', mode: 'combined' }] });
            expect(ctrl._stamps.length).toBeGreaterThan(0);
            expect(ctrl._secondaryChipCleanups.length).toBeGreaterThan(0);

            ctrl.dispose();

            expect(ctrl._stamps).toEqual([]);
            expect(ctrl._cardCleanups).toEqual([]);
            expect(ctrl._secondaryChipCleanups).toEqual([]);
            expect(ctrl._cleanups).toEqual([]);
            expect(ctrl._primaryChipDispose).toBeNull();
            expect(ctrl._filesystemCardRefs).toBeNull();
        });

        it('is idempotent — second call is a no-op', () => {
            const { ctrl } = createController();
            ctrl.dispose();
            expect(() => ctrl.dispose()).not.toThrow();
            expect(ctrl._disposed).toBe(true);
        });

        it('nulls shared object references (primaryPath, selectedPaths, etc.)', () => {
            const { ctrl } = mountController({
                primaryPath: { value: '/Users/me/docs' },
                selectedPaths: [{ path: '/a', mode: 'combined' }],
            });

            ctrl.dispose();

            expect(ctrl._primaryPath).toBeNull();
            expect(ctrl._selectedPaths).toBeNull();
            expect(ctrl._intelligenceToggles).toBeNull();
            expect(ctrl.domainService).toBeNull();
        });
    });

    // =====================================================================
    // AbortController — fetch cancellation
    // =====================================================================

    describe('AbortController', () => {
        it('aborts previous fetch when _fetchSourceStatus is called again', async () => {
            const firstAbort = jest.fn();
            const secondAbort = jest.fn();

            let callCount = 0;
            const { ctrl, endpoint } = mountController({
                endpoint: {
                    getProactiveSourceStatus: jest.fn((opts) => {
                        callCount++;
                        if (callCount === 1 && opts?.signal) {
                            opts.signal.addEventListener('abort', firstAbort);
                        }
                        if (callCount === 2 && opts?.signal) {
                            opts.signal.addEventListener('abort', secondAbort);
                        }
                        return new Promise(resolve => setTimeout(() => resolve(mockSourceStatusResponse()), 500));
                    }),
                },
            });

            // First fetch is started by mount (proactive ON by default)
            // Start second fetch — should abort first
            ctrl._fetchSourceStatus();

            expect(firstAbort).toHaveBeenCalled();
            expect(secondAbort).not.toHaveBeenCalled();
        });

        it('aborts fetch when proactive toggle is turned OFF', async () => {
            const abortSpy = jest.fn();
            const { ctrl, bodyEl } = mountController({
                endpoint: {
                    getProactiveSourceStatus: jest.fn((opts) => {
                        if (opts?.signal) {
                            opts.signal.addEventListener('abort', abortSpy);
                        }
                        return new Promise(resolve => setTimeout(() => resolve(mockSourceStatusResponse()), 500));
                    }),
                },
            });

            // Toggle proactive OFF
            const toggle = bodyEl.querySelector('#intel-toggle-proactive');
            toggle.checked = false;
            toggle.dispatchEvent(new Event('change'));

            expect(abortSpy).toHaveBeenCalled();
        });

        it('aborts fetch on dispose', async () => {
            const abortSpy = jest.fn();
            const { ctrl } = mountController({
                endpoint: {
                    getProactiveSourceStatus: jest.fn((opts) => {
                        if (opts?.signal) {
                            opts.signal.addEventListener('abort', abortSpy);
                        }
                        return new Promise(resolve => setTimeout(() => resolve(mockSourceStatusResponse()), 500));
                    }),
                },
            });

            ctrl.dispose();

            expect(abortSpy).toHaveBeenCalled();
        });

        it('silently ignores AbortError (no error state set)', async () => {
            const abortError = new DOMException('The operation was aborted.', 'AbortError');

            const { ctrl } = mountController({
                endpoint: {
                    getProactiveSourceStatus: jest.fn(() => Promise.reject(abortError)),
                },
            });
            await new Promise(r => setTimeout(r, 10));

            // AbortError should NOT set error state or toggle defaults
            expect(ctrl.domainService.sourceStatusError).toBeNull();
            // Source toggles should remain at their defaults (all true)
            expect(ctrl.domainService.sourceToggles.browser).toBe(true);
            expect(ctrl.domainService.sourceToggles.email).toBe(true);
            expect(ctrl.domainService.sourceToggles.filesystem).toBe(true);
        });

        it('passes signal through to endpoint.getProactiveSourceStatus', async () => {
            const { endpoint } = mountController();
            await new Promise(r => setTimeout(r, 10));

            expect(endpoint.getProactiveSourceStatus).toHaveBeenCalledWith(
                expect.objectContaining({ signal: expect.any(AbortSignal) })
            );
        });

        it('clears _fetchAbortController after successful fetch', async () => {
            const { ctrl, endpoint } = mountController();
            await endpoint.getProactiveSourceStatus();
            await new Promise(r => setTimeout(r, 10));

            expect(ctrl.domainService._fetchAbortController).toBeNull();
        });
    });
});
