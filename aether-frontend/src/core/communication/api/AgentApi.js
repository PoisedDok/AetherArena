'use strict';

/**
 * @.architecture
 * Incoming: Endpoint facade, AgentsModal, AgentStateManager, SystemAgentPanel, ResearchDialog --- {method_call, javascript_api}
 * Processing: Dispatch agent management and research HTTP requests --- {2 jobs: JOB_HTTP_REQUEST, JOB_VALIDATE_SCHEMA}
 * Outgoing: ApiClient -> /v1/agent/*, /v1/search/research, /v1/status/research --- {http_request, json}
 *
 * @module core/communication/api/AgentApi
 */

const BaseApi = require('./BaseApi');

class AgentApi extends BaseApi {
  /**
   * List agent configurations.
   * @returns {Promise<Array>}
   */
  async listAgentConfigs() {
    return this._request('GET', '/v1/agent/configs');
  }

  /**
   * List system agents (alias for listAgentConfigs).
   * @returns {Promise<Array>}
   */
  async listSystemAgents() {
    return this._request('GET', '/v1/agent/configs');
  }

  /**
   * Update agent configuration.
   * @param {string} agentName - Agent name (REQUIRED)
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>}
   */
  async updateAgentConfig(agentName, updates) {
    this._requireParam(agentName, 'agentName', 'updateAgentConfig');
    const path = this._encodePath('/v1/agent/config/:name', { name: agentName });
    return this._request('PUT', path, { body: updates, logContext: { agentName } });
  }

  /**
   * List available agent models.
   * @returns {Promise<Object>}
   */
  async getAgentModels() {
    return this._request('GET', '/v1/agent/models');
  }

  /**
   * List agent templates.
   * @returns {Promise<Object>}
   */
  async getAgentTemplates() {
    return this._request('GET', '/v1/agent/templates');
  }

  /**
   * List agent jobs with optional filters.
   * @param {Object} [filters] - { agentName, status, onDemandOnly, limit, offset }
   * @returns {Promise<Object>}
   */
  async listAgentJobs(filters = {}) {
    const query = this._buildQuery(filters, {
      agentName: 'agent_name',
      status: 'status_filter',
      onDemandOnly: 'on_demand_only',
      limit: 'limit',
      offset: 'offset'
    });
    const path = this._pathWithQuery('/v1/agent/jobs', query);
    return this._request('GET', path, { logContext: { filters } });
  }

  /**
   * List unified agent history (pending jobs + outputs).
   * @param {Object} [filters] - { agentName, limit, offset }
   * @returns {Promise<Object>}
   */
  async listAgentHistory(filters = {}) {
    const query = this._buildQuery(filters, {
      agentName: 'agent_name',
      limit: 'limit',
      offset: 'offset'
    });
    const path = this._pathWithQuery('/v1/agent/history', query);
    return this._request('GET', path, { logContext: { filters } });
  }

  /**
   * Cancel a pending agent job.
   * @param {string} jobId - Job UUID (REQUIRED)
   * @returns {Promise<Object>}
   */
  async cancelAgentJob(jobId) {
    this._requireParam(jobId, 'jobId', 'cancelAgentJob');
    const path = this._encodePath('/v1/agent/stop/:id', { id: jobId });
    return this._request('POST', path, { logContext: { jobId } });
  }

  /**
   * Retry a failed agent job.
   * @param {string} jobId - Job UUID (REQUIRED)
   * @returns {Promise<Object>}
   */
  async retryAgentJob(jobId) {
    this._requireParam(jobId, 'jobId', 'retryAgentJob');
    const path = this._encodePath('/v1/agent/retry/:id', { id: jobId });
    return this._request('POST', path, { logContext: { jobId } });
  }

  /**
   * Delete a completed/failed/cancelled agent job.
   * @param {string} jobId - Job UUID (REQUIRED)
   * @returns {Promise<Object>}
   */
  async deleteAgentJob(jobId) {
    this._requireParam(jobId, 'jobId', 'deleteAgentJob');
    const path = this._encodePath('/v1/agent/delete/:id', { id: jobId });
    return this._request('DELETE', path, { logContext: { jobId } });
  }

  /**
   * Get research service status (available sources, backends).
   * @returns {Promise<Object>}
   */
  async getResearchStatus() {
    return this._request('GET', '/v1/status/research');
  }

  /**
   * Create an agent job (queued in database, processed async).
   * @param {Object} payload - { agent_name, entity_id, entity_type, metadata, priority }
   * @returns {Promise<Object>} { job_id, agent_name, status, created_at }
   */
  async createAgentJob(payload = {}) {
    if (!payload.agent_name) {
      throw new Error('[Endpoint] agent_name is required for createAgentJob');
    }
    return this._request('POST', '/v1/agent/start', { body: payload, logContext: { agentName: payload.agent_name } });
  }

  /**
   * Get agent job status.
   * @param {string} jobId - Job UUID (REQUIRED)
   * @returns {Promise<Object>}
   */
  async getAgentJobStatus(jobId) {
    this._requireParam(jobId, 'jobId', 'getAgentJobStatus');
    const path = this._encodePath('/v1/agent/status/:id', { id: jobId });
    return this._request('GET', path);
  }

  /**
   * Run research job (synchronous response with results).
   * DEPRECATED: Use createAgentJob() with agent_name='research' for async job-based approach.
   * @param {Object} payload - { query, ... }
   * @returns {Promise<Object>}
   */
  async runResearch(payload = {}) {
    this._requireString(payload.query, 'query', 'runResearch');
    return this._request('POST', '/v1/search/research', {
      body: payload,
      timeout: 600000,
      logContext: { queryLength: payload.query?.length }
    });
  }

  /**
   * List research history (persisted agent outputs).
   * @param {Object} [options] - { limit, offset }
   * @returns {Promise<Array>}
   */
  async listResearchHistory(options = {}) {
    const params = new URLSearchParams();
    params.append('agent_name', 'research');
    params.append('output_type', 'research');
    if (options.limit) params.append('limit', String(options.limit));
    if (options.offset) params.append('offset', String(options.offset));
    return this._request('GET', `/v1/agent/outputs?${params.toString()}`);
  }
}

module.exports = AgentApi;
