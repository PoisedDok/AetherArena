/**
 * @.architecture
 *
 * Incoming: Endpoint API (listIndexes, listAgentJobs), settings (polling intervals) --- {api_types.response}
 * Processing: Poll badge counts on settings-driven intervals, compute running jobs --- {2 jobs: JOB_POLL, JOB_RENDER}
 * Outgoing: DOM badge text + visibility updates --- {dom_types.textContent, dom_types.classList}
 *
 * Extracted from MainApp.js to reduce god-object size.
 */

'use strict';

const { createRendererLogger } = require('../../../shared/utils/logger');

class MenuBadgeController {
  /**
   * @param {Object} options
   * @param {Object} options.endpoint - Endpoint instance
   * @param {Object} options.elements - Badge DOM elements { indexBadge, jobsBadge }
   */
  constructor(options = {}) {
    this.log = createRendererLogger('MenuBadgeController');
    this.endpoint = options.endpoint || null;
    this.elements = options.elements || {};

    this._isDisposed = false;
    this._timers = [];
    this._settings = null;
  }

  async initialize() {
    if (this._isDisposed) return;
    try {
      if (!this.endpoint) {
        this.log.warn('Endpoint not available for menu badges');
        return;
      }

      await this._loadSettings();
      await Promise.all([
        this._refreshIndexBadge(),
        this._refreshJobsBadge()
      ]);
      this._startPolling();
    } catch (error) {
      this.log.warn('Failed to initialize menu badges:', error);
    }
  }

  // ── Settings ───────────────────────────────────────────────

  async _loadSettings() {
    try {
      const settings = await this.endpoint.getSettings();
      if (!settings?.agents?.ui_polling) {
        throw new Error('Missing settings.agents.ui_polling for menu badges');
      }
      this._settings = settings;
    } catch (error) {
      this.log.warn('Failed to load badge polling settings:', error);
      throw error;
    }
  }

  // ── Polling ────────────────────────────────────────────────

  _startPolling() {
    this._stopPolling();

    const intervals = this._getPollingIntervals();

    if (intervals.index > 0) {
      this._timers.push(setInterval(() => {
        if (!document.hidden) this._refreshIndexBadge();
      }, intervals.index));
    }

    if (intervals.jobs > 0) {
      this._timers.push(setInterval(() => {
        if (!document.hidden) this._refreshJobsBadge();
      }, intervals.jobs));
    }
  }

  _stopPolling() {
    if (this._timers) {
      this._timers.forEach(timer => clearInterval(timer));
      this._timers = [];
    }
  }

  _getPollingIntervals() {
    const defaults = this._settings?.agents?.ui_polling;
    if (!defaults) {
      throw new Error('Missing settings.agents.ui_polling for badge polling');
    }
    const { index_health_poll_interval_ms: indexInterval, jobs_poll_interval_ms: jobsInterval } = defaults;
    if (indexInterval === undefined || jobsInterval === undefined) {
      throw new Error('Incomplete badge polling intervals in settings');
    }
    if (typeof indexInterval !== 'number' || typeof jobsInterval !== 'number') {
      throw new Error('Invalid badge polling interval types in settings');
    }
    return {
      index: indexInterval,
      jobs: jobsInterval
    };
  }

  // ── Badge Refreshers ───────────────────────────────────────

  async _refreshIndexBadge() {
    if (!this.elements.indexBadge || !this.endpoint) return;
    try {
      const response = await this.endpoint.listIndexes();
      const indexes = response?.indexes || response || [];
      this._setBadgeValue(this.elements.indexBadge, indexes.length);
    } catch (error) {
      this.log.warn('Failed to refresh index badge:', error);
    }
  }

  async _refreshJobsBadge() {
    if (!this.elements.jobsBadge || !this.endpoint) return;
    try {
      const response = await this.endpoint.listAgentJobs();
      const jobs = response?.jobs || response?.items || response || [];
      const runningCount = this._countRunningJobs(jobs);
      this._setBadgeValue(this.elements.jobsBadge, runningCount);
    } catch (error) {
      this.log.warn('Failed to refresh jobs badge:', error);
    }
  }

  // ── Counting Logic ─────────────────────────────────────────

  _countRunningJobs(jobs) {
    const activeStatuses = new Set(['running', 'processing', 'started', 'in_progress']);
    return (jobs || []).filter(job => activeStatuses.has(String(job?.status || '').toLowerCase())).length;
  }

  _setBadgeValue(element, value) {
    if (!element) return;
    const count = Number.isFinite(value) ? value : 0;
    if (count > 0) {
      element.textContent = String(count);
      element.classList.remove('is-hidden');
    } else {
      element.textContent = '';
      element.classList.add('is-hidden');
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this._stopPolling();
    this._settings = null;
    this.endpoint = null;
    this.elements = {};
  }
}

module.exports = MenuBadgeController;
