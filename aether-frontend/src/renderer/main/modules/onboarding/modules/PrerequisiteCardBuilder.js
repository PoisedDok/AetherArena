/**
 * @.architecture
 *
 * Incoming: SetupStepController --- {function_call}
 * Processing: Detect user platform, build HTML cards for missing prerequisites
 *             --- {JOB_DETECT_PLATFORM, JOB_BUILD_CARD}
 * Outgoing: HTML string --- {string}
 *
 * Stateless module: every exported function is pure (except detectPlatform which
 * reads platform info from Electron IPC or navigator heuristics).
 * Zero coupling to controller state.
 *
 * @module renderer/main/modules/onboarding/modules/PrerequisiteCardBuilder
 */

'use strict';

/**
 * Detect user platform for prerequisite install guidance.
 * Primary: Electron main process via window.aether.system.getStats()
 *   (returns os.platform() + os.arch() from Node — reliable on all platforms).
 * Fallback: navigator.userAgent heuristics (unreliable for arch on Apple Silicon
 *   because Electron/Chrome report "Intel Mac OS X" regardless of actual CPU).
 * @returns {Promise<{ os: 'mac'|'windows'|'linux', arch: 'arm64'|'x64' }>}
 */
async function detectPlatform() {
    // Primary: Electron main process stats (reliable)
    try {
        const aether = typeof window !== 'undefined' ? window['aether'] : null;
        if (aether?.system?.getStats) {
            const stats = await aether.system.getStats();
            if (stats?.system?.platform && stats?.system?.arch) {
                const platformMap = { darwin: 'mac', win32: 'windows', linux: 'linux' };
                const os = platformMap[stats.system.platform] || 'linux';
                const arch = stats.system.arch === 'arm64' ? 'arm64' : 'x64';
                return { os, arch };
            }
        }
    } catch (_) {
        // IPC unavailable — fall through to navigator heuristics
    }

    // Fallback: navigator heuristics (unreliable for arch on Apple Silicon)
    const ua = navigator.userAgent || '';
    const plat = navigator.platform || '';

    let os = 'linux';
    if (/macintosh|mac os x/i.test(ua) || /^Mac/i.test(plat)) {
        os = 'mac';
    } else if (/windows|win32|win64/i.test(ua) || /^Win/i.test(plat)) {
        os = 'windows';
    }

    let arch = 'x64';
    if (/arm64|aarch64/i.test(ua)) {
        arch = 'arm64';
    }

    return { os, arch };
}

/**
 * Build Docker Not Installed card with platform-specific install steps.
 * @param {{ os: string, arch: string }} platform
 * @returns {string} HTML
 */
function buildDockerNotInstalledCard(platform) {
    const { os, arch } = platform;

    const dockerInfo = {
        mac: {
            url: arch === 'arm64'
                ? 'https://desktop.docker.com/mac/main/arm64/Docker.dmg'
                : 'https://desktop.docker.com/mac/main/amd64/Docker.dmg',
            chipLabel: arch === 'arm64' ? 'Apple Silicon' : 'Intel',
            fileLabel: '.dmg',
            explanation: 'Aether runs local AI services (database, search, embeddings) privately on your computer. Docker Desktop is the container platform that hosts them.',
            steps: [
                { text: `Download Docker Desktop for Mac (<strong>${arch === 'arm64' ? 'Apple Silicon' : 'Intel'}</strong>)`, hasLink: true },
                { text: 'Open the .dmg and drag Docker to <strong>Applications</strong>' },
                { text: 'Launch Docker Desktop from Applications and wait for it to start' },
            ],
            hint: 'Once Docker shows a green whale icon in your menu bar, click <strong>Retry</strong> below.',
            timeEstimate: 'Download is ~600 MB. Install + first launch typically takes 5\u201310 minutes.',
        },
        windows: {
            url: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
            chipLabel: '',
            fileLabel: '.exe',
            explanation: 'Aether runs local AI services (database, search, embeddings) privately on your computer. Docker Desktop is the container platform that hosts them.',
            steps: [
                { text: 'Download the Docker Desktop installer', hasLink: true },
                { text: 'Run the installer and follow the prompts (defaults are fine)' },
                { text: 'Restart your computer if prompted, then open Docker Desktop' },
            ],
            hint: 'Once Docker shows a whale icon in your system tray (bottom-right), click <strong>Retry</strong> below.',
            timeEstimate: 'Download is ~600 MB. Install + first launch typically takes 5\u201315 minutes. A restart may be required.',
        },
        linux: {
            url: 'https://docs.docker.com/engine/install/',
            chipLabel: '',
            fileLabel: '',
            explanation: 'Aether runs local AI services (database, search, embeddings) privately on your computer. Docker Engine is the container runtime that hosts them.',
            steps: [
                { text: 'Visit the Docker Engine install guide for your distribution', hasLink: true },
                { text: 'Follow the instructions for your distro (Ubuntu, Fedora, Debian, etc.)' },
                { text: 'After installing, run: <code class="prereq-command">sudo systemctl start docker</code>' },
            ],
            hint: 'Once Docker is running, click <strong>Retry</strong> below.',
            timeEstimate: 'Typically takes 5\u201310 minutes depending on your distribution.',
        },
    };

    const info = dockerInfo[os] || dockerInfo.linux;
    const stepsHtml = info.steps.map((step, i) => {
        const linkHtml = step.hasLink
            ? ` <a href="${info.url}" target="_blank" class="btn-premium-link btn-sm"><i class="fas fa-download"></i> Download${info.fileLabel ? ' ' + info.fileLabel : ''}</a>`
            : '';
        return `<div class="prereq-step"><span class="step-num">${i + 1}</span><span>${step.text}</span>${linkHtml}</div>`;
    }).join('');

    return `
        <div class="prereq-card prereq-card--docker">
            <div class="prereq-card-icon"><i class="fas fa-cube"></i></div>
            <div class="prereq-card-content">
                <strong>Docker Desktop Needed</strong>
                <p>${info.explanation}</p>
                <div class="prereq-steps">${stepsHtml}</div>
                <p class="prereq-time-est"><i class="fas fa-clock"></i> ${info.timeEstimate}</p>
                <p class="prereq-hint">${info.hint}</p>
            </div>
        </div>
    `;
}

/**
 * Build Docker Not Running card with platform-specific start instructions.
 * @param {{ os: string, arch: string }} platform
 * @returns {string} HTML
 */
function buildDockerNotRunningCard(platform) {
    const { os } = platform;

    const instructions = {
        mac: {
            text: 'Docker is installed but not running. Open it from your <strong>Applications</strong> folder or click the Docker icon in your menu bar.',
            hint: 'Wait for the whale icon to turn green, then click <strong>Retry</strong>.',
            timeEstimate: 'First launch can take 2\u20135 minutes while Docker sets up. Don\u2019t worry \u2014 we\u2019re checking automatically.',
        },
        windows: {
            text: 'Docker is installed but not running. Open it from the <strong>Start Menu</strong> or click the Docker icon in your system tray (bottom-right).',
            hint: 'Wait for the whale icon to appear in your system tray, then click <strong>Retry</strong>.',
            timeEstimate: 'First launch can take 2\u20135 minutes while Docker sets up. Don\u2019t worry \u2014 we\u2019re checking automatically.',
        },
        linux: {
            text: 'Docker is installed but the daemon is not running. Start it with: <code class="prereq-command">sudo systemctl start docker</code>',
            hint: 'Once the command completes, click <strong>Retry</strong>.',
            timeEstimate: 'The Docker service usually starts within a few seconds.',
        },
    };

    const info = instructions[os] || instructions.linux;

    return `
        <div class="prereq-card prereq-card--docker-stopped">
            <div class="prereq-card-icon"><i class="fas fa-play-circle"></i></div>
            <div class="prereq-card-content">
                <strong>Start Docker Desktop</strong>
                <p>${info.text}</p>
                <p class="prereq-time-est"><i class="fas fa-clock"></i> ${info.timeEstimate}</p>
                <p class="prereq-hint">${info.hint}</p>
            </div>
        </div>
    `;
}

/**
 * Build Python Not Installed card with platform-specific install steps.
 * @param {{ os: string, arch: string }} platform
 * @returns {string} HTML
 */
function buildPythonNotInstalledCard(platform) {
    const { os } = platform;

    const pythonInfo = {
        mac: {
            explanation: 'Aether uses Python to manage AI models and run setup tasks.',
            steps: [
                { text: 'Open <strong>Terminal</strong> (search "Terminal" in Spotlight)' },
                { text: 'Paste this command and press Enter: <code class="prereq-command">xcode-select --install</code>' },
                { text: 'A dialog will appear \u2014 click <strong>Install</strong> and wait for it to finish' },
            ],
            hint: 'This installs Apple\u2019s developer tools which include Python 3.',
            timeEstimate: 'The Xcode command line tools download is ~200 MB and takes about 5 minutes.',
        },
        windows: {
            explanation: 'Aether uses Python to manage AI models and run setup tasks.',
            steps: [
                { text: 'Download the Python installer', hasLink: true, url: 'https://www.python.org/downloads/' },
                { text: 'Run the installer \u2014 <strong>check "Add Python to PATH"</strong> at the bottom of the first screen' },
                { text: 'Click <strong>Install Now</strong> and wait for it to finish' },
            ],
            hint: 'After installation, you may need to restart Aether for it to detect Python.',
            timeEstimate: 'Download is ~30 MB. Installation takes about 2\u20133 minutes.',
        },
        linux: {
            explanation: 'Aether uses Python to manage AI models and run setup tasks.',
            steps: [
                { text: 'Open a terminal and run the install command for your distribution:' },
                { text: 'Ubuntu/Debian: <code class="prereq-command">sudo apt install python3 python3-venv</code>' },
                { text: 'Fedora/RHEL: <code class="prereq-command">sudo dnf install python3</code>' },
            ],
            hint: 'Most Linux distributions include Python 3 by default. If the above fails, check your distro\u2019s package manager.',
            timeEstimate: 'Usually completes in under a minute.',
        },
    };

    const info = pythonInfo[os] || pythonInfo.linux;
    const stepsHtml = info.steps.map((step, i) => {
        const linkHtml = step.hasLink && step.url
            ? ` <a href="${step.url}" target="_blank" class="btn-premium-link btn-sm"><i class="fas fa-download"></i> Download</a>`
            : '';
        return `<div class="prereq-step"><span class="step-num">${i + 1}</span><span>${step.text}</span>${linkHtml}</div>`;
    }).join('');

    return `
        <div class="prereq-card prereq-card--python">
            <div class="prereq-card-icon"><i class="fas fa-terminal"></i></div>
            <div class="prereq-card-content">
                <strong>Python 3 Needed</strong>
                <p>${info.explanation}</p>
                <div class="prereq-steps">${stepsHtml}</div>
                <p class="prereq-time-est"><i class="fas fa-clock"></i> ${info.timeEstimate}</p>
                <p class="prereq-hint">${info.hint}</p>
            </div>
        </div>
    `;
}

module.exports = {
    detectPlatform,
    buildDockerNotInstalledCard,
    buildDockerNotRunningCard,
    buildPythonNotInstalledCard,
};
