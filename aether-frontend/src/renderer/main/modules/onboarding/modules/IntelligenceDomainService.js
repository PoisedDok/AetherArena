'use strict';

class IntelligenceDomainService {
    constructor({ primaryPath, selectedPaths, intelligenceToggles, sourceConfig, endpoint, log }) {
        this._primaryPath = primaryPath;
        this._selectedPaths = selectedPaths;
        this._intelligenceToggles = intelligenceToggles;
        this._sourceConfig = sourceConfig;
        this._sourceToggles = sourceConfig.sourceToggles;
        this._endpoint = endpoint;
        this._log = log;

        this.sourceStatus = null;
        this.sourceStatusError = null;
        this.sourceStatusLoading = false;
        this._fetchAbortController = null;
    }

    get selectedBrowser() { return this._sourceConfig.selectedBrowser; }
    set selectedBrowser(val) { this._sourceConfig.selectedBrowser = val; }
    get excludedProfiles() { return this._sourceConfig.excludedProfiles; }
    set excludedProfiles(val) { this._sourceConfig.excludedProfiles = val; }
    get sourceToggles() { return this._sourceToggles; }
    set sourceToggles(val) { this._sourceToggles = val; }

    getLocationCount() {
        let count = 0;
        if (this._primaryPath.value) count++;
        count += this._selectedPaths.length;
        return count;
    }

    async fetchSourceStatus() {
        this.abortFetch();

        const controller = new AbortController();
        this._fetchAbortController = controller;

        this.sourceStatusLoading = true;
        this.sourceStatusError = null;

        try {
            const status = await this._endpoint.getProactiveSourceStatus({ signal: controller.signal });
            this.sourceStatus = status;
            this.sourceStatusLoading = false;

            if (!this.selectedBrowser) {
                if (status.browser?.recommended) {
                    this.selectedBrowser = status.browser.recommended;
                } else if (status.browser?.installed?.length > 0) {
                    this.selectedBrowser = status.browser.installed[0].value;
                }
            }
            return status;
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            this.sourceStatusLoading = false;
            this.sourceStatusError = err.message || 'Unknown error';
            this._log.warn('[IntelligenceDomainService] Source status fetch failed:', err);

            // Safe defaults on error
            this._sourceToggles.browser = false;
            this._sourceToggles.email = false;
            this._sourceToggles.filesystem = false;

            throw err;
        } finally {
            if (this._fetchAbortController === controller) {
                this._fetchAbortController = null;
            }
        }
    }

    abortFetch() {
        if (this._fetchAbortController) {
            this._fetchAbortController.abort();
            this._fetchAbortController = null;
        }
        this.sourceStatusLoading = false;
    }

    computeDaemonStates({ hasLocations } = {}) {
        const proactive = this._intelligenceToggles?.proactiveMaster === true;
        const resolvedHasLocations = typeof hasLocations === 'boolean'
            ? hasLocations
            : this.getLocationCount() > 0;

        const browserEnabled = proactive && this._sourceToggles.browser;
        const emailEnabled = proactive && this._sourceToggles.email;
        const fileSystemEnabled = proactive && this._sourceToggles.filesystem && resolvedHasLocations;
        const queryGenerationEnabled = proactive && (browserEnabled || emailEnabled || fileSystemEnabled);
        const fileIndexingEnabled = proactive && resolvedHasLocations;

        return {
            proactive,
            hasLocations: resolvedHasLocations,
            browserEnabled,
            emailEnabled,
            fileSystemEnabled,
            queryGenerationEnabled,
            fileIndexingEnabled,
        };
    }

    getConsolidatedData() {
        const proactive = this._intelligenceToggles.proactiveMaster;

        const locationEntries = [];
        if (this._primaryPath.value) {
            const dirName = this._primaryPath.value.split('/').filter(Boolean).pop() || 'primary';
            locationEntries.push({ path: this._primaryPath.value, name: dirName, type: 'primary', index_mode: this._primaryPath.mode || 'combined' });
        }
        for (const pathObj of this._selectedPaths) {
            const dirName = pathObj.path.split('/').filter(Boolean).pop() || 'unnamed';
            locationEntries.push({ path: pathObj.path, name: dirName, type: 'secondary', index_mode: pathObj.mode || 'combined' });
        }

        const primaryWatchPaths = locationEntries
            .filter(entry => entry.type === 'primary')
            .map(entry => entry.path);

        const daemonStates = this.computeDaemonStates({ hasLocations: locationEntries.length > 0 });

        return {
            indexing_locations: locationEntries,
            daemon_config: {
                browser: {
                    browser: this.selectedBrowser || 'chrome',
                    excluded_profiles: this.excludedProfiles.length > 0
                        ? [...this.excludedProfiles] : undefined
                },
                filesystem: {
                    watch_locations: primaryWatchPaths
                },
            },
            proactive_config: {
                enabled: proactive,
                browser_enabled: daemonStates.browserEnabled,
                email_enabled: daemonStates.emailEnabled,
                file_system_enabled: daemonStates.fileSystemEnabled,
                query_generation_enabled: daemonStates.queryGenerationEnabled,
                file_indexing_enabled: daemonStates.fileIndexingEnabled,
            }
        };
    }

    getSaveReadiness() {
        const proactive = this._intelligenceToggles?.proactiveMaster === true;
        if (!proactive) {
            return { ready: true, reason: null };
        }

        if (this.sourceStatusLoading) {
            return {
                ready: false,
                reason: 'source_status_loading',
                message: 'Checking activity access. Please wait a moment or finish anyway.'
            };
        }

        if (!this.sourceStatus && !this.sourceStatusError) {
            return {
                ready: false,
                reason: 'source_status_pending',
                message: 'Activity checks are not ready yet. Please wait a moment or finish anyway.'
            };
        }

        return { ready: true, reason: null };
    }

    dispose() {
        this.abortFetch();
        this._primaryPath = null;
        this._selectedPaths = null;
        this._intelligenceToggles = null;
        this._sourceConfig = null;
        this._sourceToggles = null;
        this._endpoint = null;
        this._log = null;
        this.sourceStatus = null;
    }
}

module.exports = IntelligenceDomainService;