'use strict';

/**
 * @.architecture
 * Incoming: Endpoint facade, OnboardingModal, ServiceStatusMonitor --- {method_call, javascript_api}
 * Processing: Dispatch health-check HTTP requests --- {1 job: JOB_HTTP_REQUEST}
 * Outgoing: ApiClient.get() -> /v1/health, /v1/settings/health, /v1/services/status --- {http_request, json}
 *
 * @module core/communication/api/HealthApi
 */

const BaseApi = require('./BaseApi');

class HealthApi extends BaseApi {
  /**
   * Get backend health status.
   * @returns {Promise<Object>}
   */
  async getHealth() {
    return this._request('GET', '/v1/health');
  }

  /**
   * Get settings subsystem health.
   * @returns {Promise<Object>}
   */
  async getSettingsHealth() {
    return this._request('GET', '/v1/settings/health');
  }

  /**
   * Get external services status.
   * @returns {Promise<Object>}
   */
  async getServicesStatus() {
    return this._request('GET', '/v1/services/status');
  }

  /**
   * Get setup/onboarding status.
   * Returns { current_phase, total_progress, ... }.
   * Works in degraded mode (no Supabase required).
   * @returns {Promise<Object>}
   */
  async getSetupStatus() {
    return this._request('GET', '/v1/setup/status');
  }

  /**
   * Get setup requirements (Docker, venvs, models, images).
   * @returns {Promise<Object>}
   */
  async getSetupRequirements() {
    return this._request('GET', '/v1/setup/requirements');
  }

  /**
   * Start onboarding setup process.
   * @returns {Promise<Object>}
   */
  async startSetup() {
    return this._request('POST', '/v1/setup/start', { timeout: 120000 });
  }

  /**
   * Finalize setup by initializing backend services.
   * @returns {Promise<Object>}
   */
  async finalizeSetup() {
    return this._request('POST', '/v1/setup/finalize', { timeout: 120000 });
  }

  /**
   * Get orchestration state.
   * @returns {Promise<Object>}
   */
  async getOrchestrationState() {
    return this._request('GET', '/v1/setup/orchestration-state');
  }

  /**
   * Execute an orchestration command.
   * @param {string} command - The command string.
   * @returns {Promise<Object>}
   */
  async executeOrchestrationCommand(command) {
    return this._request('POST', '/v1/setup/orchestration-command', { body: { command }, timeout: 10000 });
  }

  /**
   * Get onboarding UI state.
   * @returns {Promise<Object>}
   */
  async getOnboardingState() {
    return this._request('GET', '/v1/setup/onboarding-state');
  }

  /**
   * Save onboarding UI state.
   * @param {Object} payload - The onboarding UI state payload.
   * @returns {Promise<Object>}
   */
  async saveOnboardingState(payload) {
    return this._request('POST', '/v1/setup/onboarding-state', { body: payload, timeout: 10000 });
  }

  /**
   * Submit consolidated onboarding data for persistence.
   * Works in degraded mode (writes to local JSON file).
   * @param {Object} payload - Consolidated onboarding data
   * @param {Object} [options] - Additional request options (e.g., signal)
   * @returns {Promise<Object>}
   */
  async completeOnboarding(payload, options = {}) {
    return this._request('POST', '/v1/setup/complete', { body: payload, timeout: 30000, ...options });
  }
}

module.exports = HealthApi;
