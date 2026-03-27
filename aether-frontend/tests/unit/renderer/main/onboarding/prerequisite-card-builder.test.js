'use strict';

// ---------------------------------------------------------------------------
// PrerequisiteCardBuilder — Unit tests
// ---------------------------------------------------------------------------
// Tests the stateless card builder functions and platform detection.
// ---------------------------------------------------------------------------

const CardBuilder = require(
    '../../../../../src/renderer/main/modules/onboarding/modules/PrerequisiteCardBuilder'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseHtml(htmlString) {
    const container = document.createElement('div');
    container.innerHTML = htmlString.trim();
    return container;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('PrerequisiteCardBuilder', () => {
    // =========================================================================
    // Exports
    // =========================================================================

    describe('exports', () => {
        it('exports detectPlatform as an async function', () => {
            expect(typeof CardBuilder.detectPlatform).toBe('function');
        });

        it('exports buildDockerNotInstalledCard', () => {
            expect(typeof CardBuilder.buildDockerNotInstalledCard).toBe('function');
        });

        it('exports buildDockerNotRunningCard', () => {
            expect(typeof CardBuilder.buildDockerNotRunningCard).toBe('function');
        });

        it('exports buildPythonNotInstalledCard', () => {
            expect(typeof CardBuilder.buildPythonNotInstalledCard).toBe('function');
        });

        it('exports exactly 4 functions', () => {
            expect(Object.keys(CardBuilder).length).toBe(4);
        });
    });

    // =========================================================================
    // detectPlatform
    // =========================================================================

    describe('detectPlatform', () => {
        afterEach(() => {
            delete global.window.aether;
        });

        it('returns mac/arm64 when Electron IPC reports darwin/arm64', async () => {
            global.window.aether = {
                system: {
                    getStats: jest.fn().mockResolvedValue({
                        system: { platform: 'darwin', arch: 'arm64' },
                    }),
                },
            };

            const result = await CardBuilder.detectPlatform();
            expect(result).toEqual({ os: 'mac', arch: 'arm64' });
        });

        it('returns windows/x64 when Electron IPC reports win32/x64', async () => {
            global.window.aether = {
                system: {
                    getStats: jest.fn().mockResolvedValue({
                        system: { platform: 'win32', arch: 'x64' },
                    }),
                },
            };

            const result = await CardBuilder.detectPlatform();
            expect(result).toEqual({ os: 'windows', arch: 'x64' });
        });

        it('returns linux/x64 when Electron IPC reports linux/x86_64', async () => {
            global.window.aether = {
                system: {
                    getStats: jest.fn().mockResolvedValue({
                        system: { platform: 'linux', arch: 'x86_64' },
                    }),
                },
            };

            const result = await CardBuilder.detectPlatform();
            expect(result).toEqual({ os: 'linux', arch: 'x64' });
        });

        it('falls back to navigator when IPC throws', async () => {
            global.window.aether = {
                system: {
                    getStats: jest.fn().mockRejectedValue(new Error('IPC dead')),
                },
            };

            // jsdom navigator defaults — should return linux/x64 as a safe fallback
            const result = await CardBuilder.detectPlatform();
            expect(result).toHaveProperty('os');
            expect(result).toHaveProperty('arch');
            expect(['mac', 'windows', 'linux']).toContain(result.os);
            expect(['arm64', 'x64']).toContain(result.arch);
        });

        it('falls back to navigator when aether object is absent', async () => {
            // No aether object at all
            const result = await CardBuilder.detectPlatform();
            expect(result).toHaveProperty('os');
            expect(result).toHaveProperty('arch');
        });

        it('maps unknown platform to linux', async () => {
            global.window.aether = {
                system: {
                    getStats: jest.fn().mockResolvedValue({
                        system: { platform: 'freebsd', arch: 'x64' },
                    }),
                },
            };

            const result = await CardBuilder.detectPlatform();
            expect(result.os).toBe('linux');
        });
    });

    // =========================================================================
    // buildDockerNotInstalledCard
    // =========================================================================

    describe('buildDockerNotInstalledCard', () => {
        it('returns card HTML with Docker Desktop Needed heading', () => {
            const html = CardBuilder.buildDockerNotInstalledCard({ os: 'mac', arch: 'arm64' });
            const dom = parseHtml(html);
            expect(dom.querySelector('.prereq-card--docker')).not.toBeNull();
            expect(dom.textContent).toContain('Docker Desktop Needed');
        });

        it('uses Apple Silicon download URL for mac/arm64', () => {
            const html = CardBuilder.buildDockerNotInstalledCard({ os: 'mac', arch: 'arm64' });
            expect(html).toContain('arm64/Docker.dmg');
            expect(html).toContain('Apple Silicon');
        });

        it('uses Intel download URL for mac/x64', () => {
            const html = CardBuilder.buildDockerNotInstalledCard({ os: 'mac', arch: 'x64' });
            expect(html).toContain('amd64/Docker.dmg');
            expect(html).toContain('Intel');
        });

        it('uses Windows installer URL for windows', () => {
            const html = CardBuilder.buildDockerNotInstalledCard({ os: 'windows', arch: 'x64' });
            expect(html).toContain('Docker%20Desktop%20Installer.exe');
        });

        it('uses Docker Engine docs URL for linux', () => {
            const html = CardBuilder.buildDockerNotInstalledCard({ os: 'linux', arch: 'x64' });
            expect(html).toContain('docs.docker.com/engine/install');
        });

        it('contains 3 step elements', () => {
            const html = CardBuilder.buildDockerNotInstalledCard({ os: 'mac', arch: 'arm64' });
            const dom = parseHtml(html);
            expect(dom.querySelectorAll('.prereq-step').length).toBe(3);
        });

        it('contains time estimate badge', () => {
            const html = CardBuilder.buildDockerNotInstalledCard({ os: 'mac', arch: 'arm64' });
            expect(html).toContain('prereq-time-est');
            expect(html).toContain('600 MB');
        });

        it('contains hint text with Retry mention', () => {
            const html = CardBuilder.buildDockerNotInstalledCard({ os: 'mac', arch: 'arm64' });
            expect(html).toContain('Retry');
            expect(html).toContain('prereq-hint');
        });

        it('falls back to linux info for unknown OS', () => {
            const html = CardBuilder.buildDockerNotInstalledCard({ os: 'freebsd', arch: 'x64' });
            expect(html).toContain('docs.docker.com/engine/install');
        });
    });

    // =========================================================================
    // buildDockerNotRunningCard
    // =========================================================================

    describe('buildDockerNotRunningCard', () => {
        it('returns card HTML for mac with Applications folder instruction', () => {
            const html = CardBuilder.buildDockerNotRunningCard({ os: 'mac', arch: 'arm64' });
            const dom = parseHtml(html);
            expect(dom.querySelector('.prereq-card--docker-stopped')).not.toBeNull();
            expect(dom.textContent).toContain('Start Docker Desktop');
            expect(html).toContain('Applications');
        });

        it('returns card HTML for windows with Start Menu instruction', () => {
            const html = CardBuilder.buildDockerNotRunningCard({ os: 'windows', arch: 'x64' });
            expect(html).toContain('Start Menu');
        });

        it('returns card HTML for linux with systemctl command', () => {
            const html = CardBuilder.buildDockerNotRunningCard({ os: 'linux', arch: 'x64' });
            expect(html).toContain('sudo systemctl start docker');
        });

        it('contains time estimate badge', () => {
            const html = CardBuilder.buildDockerNotRunningCard({ os: 'mac', arch: 'arm64' });
            expect(html).toContain('prereq-time-est');
        });

        it('falls back to linux for unknown OS', () => {
            const html = CardBuilder.buildDockerNotRunningCard({ os: 'haiku', arch: 'x64' });
            expect(html).toContain('systemctl');
        });
    });

    // =========================================================================
    // buildPythonNotInstalledCard
    // =========================================================================

    describe('buildPythonNotInstalledCard', () => {
        it('returns card HTML with Python 3 Needed heading', () => {
            const html = CardBuilder.buildPythonNotInstalledCard({ os: 'mac', arch: 'arm64' });
            const dom = parseHtml(html);
            expect(dom.querySelector('.prereq-card--python')).not.toBeNull();
            expect(dom.textContent).toContain('Python 3 Needed');
        });

        it('mac card recommends xcode-select', () => {
            const html = CardBuilder.buildPythonNotInstalledCard({ os: 'mac', arch: 'arm64' });
            expect(html).toContain('xcode-select --install');
        });

        it('windows card has download link to python.org', () => {
            const html = CardBuilder.buildPythonNotInstalledCard({ os: 'windows', arch: 'x64' });
            expect(html).toContain('python.org/downloads');
            expect(html).toContain('Add Python to PATH');
        });

        it('linux card shows apt and dnf commands', () => {
            const html = CardBuilder.buildPythonNotInstalledCard({ os: 'linux', arch: 'x64' });
            expect(html).toContain('sudo apt install python3');
            expect(html).toContain('sudo dnf install python3');
        });

        it('contains 3 step elements for mac', () => {
            const html = CardBuilder.buildPythonNotInstalledCard({ os: 'mac', arch: 'arm64' });
            const dom = parseHtml(html);
            expect(dom.querySelectorAll('.prereq-step').length).toBe(3);
        });

        it('contains time estimate badge', () => {
            const html = CardBuilder.buildPythonNotInstalledCard({ os: 'mac', arch: 'arm64' });
            expect(html).toContain('prereq-time-est');
            expect(html).toContain('200 MB');
        });

        it('falls back to linux for unknown OS', () => {
            const html = CardBuilder.buildPythonNotInstalledCard({ os: 'plan9', arch: 'x64' });
            expect(html).toContain('apt install python3');
        });
    });
});
