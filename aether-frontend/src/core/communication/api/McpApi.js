'use strict';

/**
 * @.architecture
 * Incoming: Endpoint facade, MCPManagementModal --- {method_call, javascript_api}
 * Processing: Dispatch MCP server management HTTP requests --- {2 jobs: JOB_HTTP_REQUEST, JOB_VALIDATE_SCHEMA}
 * Outgoing: ApiClient -> /v1/mcp/servers/* --- {http_request, json}
 *
 * @module core/communication/api/McpApi
 */

const BaseApi = require('./BaseApi');

class McpApi extends BaseApi {
  /**
   * List MCP servers.
   * @param {boolean} [enabledOnly=false] - Only return enabled servers
   * @returns {Promise<Array>}
   */
  async listMcpServers(enabledOnly = false) {
    return this._request('GET', '/v1/mcp/servers', { params: { enabled_only: enabledOnly } });
  }

  /**
   * Register new MCP server.
   * @param {Object} serverConfig - Server configuration
   * @returns {Promise<Object>}
   */
  async registerMcpServer(serverConfig) {
    return this._request('POST', '/v1/mcp/servers', { body: serverConfig });
  }

  /**
   * Update MCP server.
   * @param {string} serverId - Server UUID (REQUIRED)
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>}
   */
  async updateMcpServer(serverId, updates) {
    this._requireParam(serverId, 'serverId', 'updateMcpServer');
    const path = this._encodePath('/v1/mcp/servers/:id', { id: serverId });
    return this._request('PUT', path, { body: updates, logContext: { serverId } });
  }

  /**
   * Delete MCP server.
   * @param {string} serverId - Server UUID (REQUIRED)
   * @returns {Promise<void>}
   */
  async deleteMcpServer(serverId) {
    this._requireParam(serverId, 'serverId', 'deleteMcpServer');
    const path = this._encodePath('/v1/mcp/servers/:id', { id: serverId });
    try {
      await this._api.delete(path);
    } catch (error) {
      if (!error.isBackendUnavailableError) {
        this._log.error(`DELETE /v1/mcp/servers/${serverId} failed`, {
          error: error?.message || error,
          serverId
        });
      }
      throw error;
    }
  }

  /**
   * Start MCP server.
   * @param {string} serverName - Server name (REQUIRED)
   * @returns {Promise<Object>}
   */
  async startMcpServer(serverName) {
    this._requireParam(serverName, 'serverName', 'startMcpServer');
    return this._request('POST', '/v1/mcp/servers/start', {
      body: { name: serverName },
      logContext: { serverName }
    });
  }

  /**
   * Stop MCP server.
   * @param {string} serverName - Server name (REQUIRED)
   * @returns {Promise<Object>}
   */
  async stopMcpServer(serverName) {
    this._requireParam(serverName, 'serverName', 'stopMcpServer');
    return this._request('POST', '/v1/mcp/servers/stop', {
      body: { name: serverName },
      logContext: { serverName }
    });
  }

  /**
   * Test MCP server connectivity.
   * @param {string} serverId - Server UUID (REQUIRED)
   * @returns {Promise<Object>} Test results with diagnostics
   */
  async testMcpServer(serverId) {
    this._requireParam(serverId, 'serverId', 'testMcpServer');
    const path = this._encodePath('/v1/mcp/servers/:id/test', { id: serverId });
    return this._request('POST', path, { logContext: { serverId } });
  }

  /**
   * Get tools for MCP server.
   * @param {string} serverId - Server UUID (REQUIRED)
   * @returns {Promise<Array>}
   */
  async getMcpServerTools(serverId) {
    this._requireParam(serverId, 'serverId', 'getMcpServerTools');
    const path = this._encodePath('/v1/mcp/servers/:id/tools', { id: serverId });
    return this._request('GET', path, { logContext: { serverId } });
  }

  /**
   * Execute a tool on an MCP server.
   * @param {string} serverId - Server UUID (REQUIRED)
   * @param {string} toolName - Tool name (REQUIRED)
   * @param {Object} args - Tool arguments
   * @returns {Promise<Object>} Execution result
   */
  async executeMcpTool(serverId, toolName, args = {}) {
    this._requireParam(serverId, 'serverId', 'executeMcpTool');
    this._requireParam(toolName, 'toolName', 'executeMcpTool');
    const path = `/v1/mcp/servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}`;
    return this._request('POST', path, {
      body: { arguments: args },
      logContext: { serverId, toolName }
    });
  }

  /**
   * Get system dependencies.
   * @returns {Promise<Object>}
   */
  async getSystemDependencies() {
    return this._request('GET', '/v1/mcp/system/dependencies');
  }
}

module.exports = McpApi;
