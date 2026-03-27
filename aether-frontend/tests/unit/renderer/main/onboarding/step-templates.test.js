'use strict';

// ---------------------------------------------------------------------------
// OnboardingStepTemplates.js — Unit tests
// ---------------------------------------------------------------------------
// Pure template functions — no mocks needed, jsdom environment.
//
// Post-consolidation: 4 exported functions (5-step flow, indexing step removed).
//   1. renderWelcome  — Brand hero, value props
//   2. renderLicense  — Terms + privacy merged
//   3. renderSetup    — 3-phase unified progress (checking/installing/verifying)
//   4. renderComplete — Restart activation message with success animation
// ---------------------------------------------------------------------------

const Templates = require('../../../../../src/renderer/main/modules/onboarding/modules/OnboardingStepTemplates');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseHtml(htmlStr) {
    const container = document.createElement('div');
    container.innerHTML = htmlStr.trim();
    return container;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('OnboardingStepTemplates', () => {

    // =========================================================================
    // Module exports
    // =========================================================================

    describe('exports', () => {
        const expected = [
            'renderWelcome',
            'renderLicense',
            'renderSetup',
            'renderComplete',
        ];

        it.each(expected)('exports %s as a function', (name) => {
            expect(typeof Templates[name]).toBe('function');
        });

        it('exports exactly 4 functions', () => {
            const fns = Object.keys(Templates).filter(k => typeof Templates[k] === 'function');
            expect(fns.length).toBe(4);
        });

        const removed = [
            'renderTerms',
            'renderPrivacy',
            'renderExternal',
            'renderPrerequisites',
            'renderAIModels',
            'renderDependencies',
            'renderRestartNotice',
            'renderIndexing',
        ];

        it.each(removed)('does NOT export removed function %s', (name) => {
            expect(Templates[name]).toBeUndefined();
        });
    });

    // =========================================================================
    // renderWelcome
    // =========================================================================

    describe('renderWelcome', () => {
        it('returns HTML with .onboarding-welcome root', () => {
            const dom = parseHtml(Templates.renderWelcome());
            expect(dom.querySelector('.onboarding-welcome')).not.toBeNull();
        });

        it('interpolates initialName into input value', () => {
            const dom = parseHtml(Templates.renderWelcome('John Doe'));
            const input = dom.querySelector('#onboarding-name');
            expect(input).not.toBeNull();
            expect(input.value).toBe('John Doe');
        });

        it('escapes initialName correctly', () => {
            const html = Templates.renderWelcome('<script>alert("xss")</script>');
            const dom = parseHtml(html);
            const input = dom.querySelector('#onboarding-name');
            expect(input).not.toBeNull();
            expect(input.value).toBe('<script>alert("xss")</script>');
            // check the raw HTML doesn't contain raw script tags, but rather encoded ones
            expect(html).not.toContain('<script>');
            expect(html).toContain('&lt;script&gt;');
        });

        it('contains 3 feature badges', () => {
            const dom = parseHtml(Templates.renderWelcome());
            expect(dom.querySelectorAll('.feature-badge').length).toBe(3);
        });

        it('contains hero section with glow-orb', () => {
            const dom = parseHtml(Templates.renderWelcome());
            expect(dom.querySelector('.glow-orb')).not.toBeNull();
        });

        it('contains wordmark with "A" accent, "ether" rest, and "Arena" product', () => {
            const dom = parseHtml(Templates.renderWelcome());
            expect(dom.querySelector('.welcome-wordmark')).not.toBeNull();
            expect(dom.querySelector('.wordmark-a')).not.toBeNull();
            expect(dom.querySelector('.wordmark-rest')).not.toBeNull();
            expect(dom.querySelector('.wordmark-product')).not.toBeNull();
            expect(dom.querySelector('.wordmark-a').textContent).toBe('A');
            expect(dom.querySelector('.wordmark-rest').textContent).toBe('ether');
            expect(dom.querySelector('.wordmark-product').textContent).toBe('Arena');
        });

        it('contains expected feature labels', () => {
            const html = Templates.renderWelcome();
            expect(html).toContain('Private by Default');
            expect(html).toContain('Runs on Your Machine');
            expect(html).toContain('Thinks Ahead');
        });

        it('contains tagline', () => {
            const dom = parseHtml(Templates.renderWelcome());
            const tagline = dom.querySelector('.welcome-tagline');
            expect(tagline).not.toBeNull();
            expect(tagline.textContent).toContain('private AI assistant');
        });
    });

    // =========================================================================
    // renderLicense (merged Terms + Privacy)
    // =========================================================================

    describe('renderLicense', () => {
        it('returns HTML with .onboarding-license root', () => {
            const dom = parseHtml(Templates.renderLicense());
            expect(dom.querySelector('.onboarding-license')).not.toBeNull();
        });

        it('contains accept-terms checkbox', () => {
            const dom = parseHtml(Templates.renderLicense());
            const checkbox = dom.querySelector('#accept-terms');
            expect(checkbox).not.toBeNull();
            expect(checkbox.type).toBe('checkbox');
        });

        it('checkbox is unchecked by default', () => {
            const dom = parseHtml(Templates.renderLicense());
            expect(dom.querySelector('#accept-terms').checked).toBe(false);
        });

        it('checkbox is checked when termsAccepted is true', () => {
            const dom = parseHtml(Templates.renderLicense(true));
            expect(dom.querySelector('#accept-terms').checked).toBe(true);
        });

        it('contains BUSL-1.1 header', () => {
            const html = Templates.renderLicense();
            expect(html).toContain('BUSINESS SOURCE LICENSE 1.1');
        });

        it('contains 3 bullet items', () => {
            const dom = parseHtml(Templates.renderLicense());
            expect(dom.querySelectorAll('.bullet-item').length).toBe(3);
        });

        it('contains terms section with scrollable area', () => {
            const dom = parseHtml(Templates.renderLicense());
            expect(dom.querySelector('.license-terms-section')).not.toBeNull();
            expect(dom.querySelector('.terms-scroll-area')).not.toBeNull();
        });

        it('contains privacy section with 3 highlights', () => {
            const dom = parseHtml(Templates.renderLicense());
            expect(dom.querySelector('.license-privacy-section')).not.toBeNull();
            expect(dom.querySelectorAll('.privacy-highlight').length).toBe(3);
        });

        it('third privacy highlight has warning class', () => {
            const dom = parseHtml(Templates.renderLicense());
            const highlights = dom.querySelectorAll('.privacy-highlight');
            expect(highlights[2].classList.contains('warning')).toBe(true);
        });

        it('contains privacy section title', () => {
            const html = Templates.renderLicense();
            expect(html).toContain('Privacy at a Glance');
        });

        it('references Krish Dokania as licensor', () => {
            const html = Templates.renderLicense();
            expect(html).toContain('Krish Dokania');
        });

        it('states correct change date (November 21, 2029) and change license (Apache 2.0)', () => {
            const html = Templates.renderLicense();
            expect(html).toContain('Apache License, Version 2.0');
            expect(html).toContain('November 21, 2029');
        });

        it('permitted use text matches LICENSE Additional Use Grant verbatim', () => {
            const html = Templates.renderLicense();
            // Must match LICENSE line 15 exactly — any deviation creates estoppel risk
            expect(html).toContain('non-commercial, personal, testing, and development purposes');
            // Must NOT contain prior inaccurate wording
            expect(html).not.toContain('internal evaluation');
            expect(html).not.toContain('personal productivity');
        });

        it('contains AI content disclaimer element', () => {
            const dom = parseHtml(Templates.renderLicense());
            const disclaimer = dom.querySelector('.terms-disclaimer');
            expect(disclaimer).not.toBeNull();
            expect(disclaimer.textContent).toContain('AI content disclaimer');
            expect(disclaimer.textContent).toContain('BUSL-1.1 license');
        });

        it('disclaimer appears between terms container and checkbox', () => {
            const dom = parseHtml(Templates.renderLicense());
            const termsSection = dom.querySelector('.license-terms-section');
            const children = Array.from(termsSection.children);
            const disclaimerIdx = children.findIndex(el => el.classList.contains('terms-disclaimer'));
            const checkboxIdx = children.findIndex(el => el.classList.contains('aether-toggle-premium'));
            const containerIdx = children.findIndex(el => el.classList.contains('terms-container'));
            expect(containerIdx).toBeLessThan(disclaimerIdx);
            expect(disclaimerIdx).toBeLessThan(checkboxIdx);
        });
    });

    // =========================================================================
    // renderSetup (3-phase unified progress)
    // =========================================================================

    describe('renderSetup', () => {
        it('returns HTML with .onboarding-setup root', () => {
            const dom = parseHtml(Templates.renderSetup());
            expect(dom.querySelector('.onboarding-setup')).not.toBeNull();
        });

        it('contains 3 phase containers (checking, installing, verifying)', () => {
            const dom = parseHtml(Templates.renderSetup());
            expect(dom.querySelector('#setup-phase-checking')).not.toBeNull();
            expect(dom.querySelector('#setup-phase-installing')).not.toBeNull();
            expect(dom.querySelector('#setup-phase-verifying')).not.toBeNull();
        });

        it('checking phase is visible initially; installing and verifying are hidden', () => {
            const dom = parseHtml(Templates.renderSetup());
            expect(dom.querySelector('#setup-phase-checking').classList.contains('hidden')).toBe(false);
            expect(dom.querySelector('#setup-phase-installing').classList.contains('hidden')).toBe(true);
            expect(dom.querySelector('#setup-phase-verifying').classList.contains('hidden')).toBe(true);
        });

        it('contains checking label and errors container', () => {
            const dom = parseHtml(Templates.renderSetup());
            expect(dom.querySelector('#setup-checking-label')).not.toBeNull();
            expect(dom.querySelector('#setup-prereq-errors')).not.toBeNull();
            expect(dom.querySelector('#setup-prereq-errors').classList.contains('hidden')).toBe(true);
        });

        it('contains empty actions container for dynamic buttons', () => {
            const dom = parseHtml(Templates.renderSetup());
            const actions = dom.querySelector('#setup-checking-actions');
            expect(actions).not.toBeNull();
            // No static skip button — buttons are created dynamically by controller
            expect(dom.querySelector('#skip-setup')).toBeNull();
        });

        it('contains setup overview banner with time estimate and window hints', () => {
            const dom = parseHtml(Templates.renderSetup());
            const banner = dom.querySelector('#setup-install-banner');
            expect(banner).not.toBeNull();
            const rows = banner.querySelectorAll('.install-banner-row');
            expect(rows.length).toBe(3);
            expect(rows[0].textContent).toContain('15');
            expect(rows[0].textContent).toContain('30 minutes');
            expect(rows[1].textContent).toContain('minimize');
            expect(rows[2].textContent).toContain('do not force-quit');
            expect(rows[2].classList.contains('install-banner-warning')).toBe(true);
        });

        it('contains phase hint element below main label, initially hidden', () => {
            const dom = parseHtml(Templates.renderSetup());
            const hint = dom.querySelector('#setup-phase-hint');
            expect(hint).not.toBeNull();
            expect(hint.classList.contains('hidden')).toBe(true);
            expect(hint.textContent).toBe('');
        });

        it('contains unified progress bar elements', () => {
            const dom = parseHtml(Templates.renderSetup());
            expect(dom.querySelector('#setup-phase-label')).not.toBeNull();
            expect(dom.querySelector('#setup-bar-fill')).not.toBeNull();
            expect(dom.querySelector('#setup-bar-percent')).not.toBeNull();
            expect(dom.querySelector('#setup-bar-percent').textContent).toBe('0%');
        });

        it('contains 6 phase dots with correct data-phase attributes', () => {
            const dom = parseHtml(Templates.renderSetup());
            const dots = dom.querySelectorAll('.setup-phase-dot');
            expect(dots.length).toBe(6);

            const phases = Array.from(dots).map(d => d.getAttribute('data-phase'));
            expect(phases).toEqual([
                'repositories',
                'python_packages',
                'oi_environment',
                'inference_environment',
                'ml_models',
                'docker_services',
            ]);
        });

        it('phase dot labels match updated terminology', () => {
            const dom = parseHtml(Templates.renderSetup());
            const labels = Array.from(dom.querySelectorAll('.phase-dot-label')).map(el => el.textContent);
            expect(labels).toEqual(['Verify', 'Packages', 'AI Runtime', 'Inference', 'Voice', 'Services']);
        });

        it('contains ETA display element', () => {
            const dom = parseHtml(Templates.renderSetup());
            expect(dom.querySelector('#setup-eta')).not.toBeNull();
        });

        it('contains detail panel toggle and collapsible panel', () => {
            const dom = parseHtml(Templates.renderSetup());
            expect(dom.querySelector('#setup-detail-btn')).not.toBeNull();
            expect(dom.querySelector('#setup-detail-panel')).not.toBeNull();
            expect(dom.querySelector('#setup-detail-panel').classList.contains('collapsed')).toBe(true);
        });

        it('detail toggle button has correct ARIA attributes', () => {
            const dom = parseHtml(Templates.renderSetup());
            const btn = dom.querySelector('#setup-detail-btn');
            expect(btn.getAttribute('aria-expanded')).toBe('false');
            expect(btn.getAttribute('aria-controls')).toBe('setup-detail-panel');
        });

        it('each phase dot has indicator and label elements', () => {
            const dom = parseHtml(Templates.renderSetup());
            const dots = dom.querySelectorAll('.setup-phase-dot');
            dots.forEach(dot => {
                expect(dot.querySelector('.phase-dot-indicator')).not.toBeNull();
                expect(dot.querySelector('.phase-dot-label')).not.toBeNull();
            });
        });

        it('contains elapsed time display area', () => {
            const dom = parseHtml(Templates.renderSetup());
            expect(dom.querySelector('#setup-elapsed')).not.toBeNull();
        });

        it('verifying phase contains spinner icon (finalize in progress) and label', () => {
            const dom = parseHtml(Templates.renderSetup());
            const verify = dom.querySelector('#setup-phase-verifying');
            expect(verify.querySelector('#setup-verify-icon-wrap')).not.toBeNull();
            expect(verify.querySelector('#setup-verify-label')).not.toBeNull();
            expect(verify.querySelector('#setup-verify-label').textContent).toContain('Connecting');
        });

        it('verifying phase contains actions container for retry buttons', () => {
            const dom = parseHtml(Templates.renderSetup());
            const verify = dom.querySelector('#setup-phase-verifying');
            expect(verify.querySelector('#setup-verify-actions')).not.toBeNull();
        });
    });

    // =========================================================================
    // renderComplete (replaces renderRestartNotice)
    // =========================================================================

    describe('renderComplete', () => {
        it('returns HTML with .onboarding-complete root', () => {
            const dom = parseHtml(Templates.renderComplete());
            expect(dom.querySelector('.onboarding-complete')).not.toBeNull();
        });

        it('contains restart and services activation message', () => {
            const html = Templates.renderComplete();
            expect(html).toContain('restart');
            expect(html).toContain('background services');
        });

        it('contains success icon wrapper', () => {
            const dom = parseHtml(Templates.renderComplete());
            expect(dom.querySelector('.complete-icon-wrapper')).not.toBeNull();
        });

        it('contains "You\'re All Set" heading', () => {
            const html = Templates.renderComplete();
            expect(html).toContain("You're All Set");
        });

        it('contains settings hint', () => {
            const dom = parseHtml(Templates.renderComplete());
            const hint = dom.querySelector('.complete-hint');
            expect(hint).not.toBeNull();
            expect(hint.textContent).toContain('Settings');
        });
    });
});
