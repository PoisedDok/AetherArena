'use strict';

/**
 * Domain & State Layer for MCP Management
 */
class McpStateController {
  constructor(endpoint, log) {
    this.endpoint = endpoint;
    this.log = log;

    // Core state
    this.servers = [];
    this.discoverServers = [];
    this.systemDependencies = null;
    
    // UI flow state
    this.isDiscoverLoading = false;
    this.discoverError = null;
    this.discoverSearchQuery = '';
    this.discoverCategory = 'all';
    this.isRegistering = false;
    this.editingServerId = null;
    this.activeTab = 'my-servers'; // 'my-servers' | 'discover'
    
    this._discoverPreFillData = null;
  }

  /**
   * Fetch user's registered servers
   */
  async fetchServers() {
    if (!this.endpoint) throw new Error('Endpoint not initialized');
    const response = await this.endpoint.listMcpServers(false);
    this.servers = response?.data || response || [];
    return this.servers;
  }

  /**
   * Fetch servers from the official registry
   */
  async fetchDiscoverServers() {
    this.isDiscoverLoading = true;
    this.discoverError = null;

    try {
      const [registryRes, depsRes] = await Promise.all([
        fetch('https://registry.modelcontextprotocol.io/v0.1/servers?limit=100').catch(e => { throw new Error(`Registry fetch failed: ${e.message}`); }),
        this.endpoint ? this.endpoint.getSystemDependencies().catch(e => { this.log.warn('Failed to fetch dependencies', e); return null; }) : Promise.resolve(null)
      ]);

      if (registryRes && !registryRes.ok) {
        throw new Error(`Failed to fetch from registry: ${registryRes.status}`);
      }
      
      const data = await registryRes.json();
      this.discoverServers = data.servers || [];
      this.systemDependencies = depsRes?.data || depsRes || null;
    } catch (err) {
      this.log.error('[McpStateController] Failed to fetch discover servers:', err);
      this.discoverError = err.message || 'Failed to load discover registry';
    } finally {
      this.isDiscoverLoading = false;
    }
  }

  /**
   * Get discover servers filtered by current state
   */
  getFilteredDiscoverServers() {
    return this.discoverServers.filter(item => {
      const server = item.server || {};
      
      let isKeyless = true;
      let isLocal = true;
      if (server.packages && server.packages.length > 0) {
        const pkg = server.packages[0];
        if (pkg.environmentVariables && pkg.environmentVariables.length > 0) {
          isKeyless = false;
        }
      } else if (server.remotes && server.remotes.length > 0) {
        isKeyless = false;
        isLocal = false;
      }
      
      if (this.discoverCategory === 'local' && !isLocal) return false;
      if (this.discoverCategory === 'remote' && isLocal) return false;
      if (this.discoverCategory === 'keyless' && !isKeyless) return false;
      
      if (this.discoverSearchQuery) {
        const q = this.discoverSearchQuery;
        const title = (server.title || '').toLowerCase();
        const name = (server.name || '').toLowerCase();
        const desc = (server.description || '').toLowerCase();
        if (!title.includes(q) && !name.includes(q) && !desc.includes(q)) {
          return false;
        }
      }
      
      return true;
    });
  }

  /**
   * Convert a registry server schema into local form data
   */
  prepareDiscoverInstall(server) {
    let command = '';
    let args = [];
    let env = {};
    let url = '';
    let isLocal = true;
    let isKeyless = false; 

    if (server.packages && server.packages.length > 0) {
      const pkg = server.packages[0];
      const identifier = pkg.identifier;
      
      switch (pkg.registryType) {
        case 'npm':
          command = 'npx';
          args = ['-y', identifier];
          break;
        case 'pypi':
          command = 'uvx';
          args = [identifier];
          break;
        case 'oci':
          command = 'docker';
          args = ['run', '-i', '--rm', identifier];
          break;
        default:
          command = pkg.registryType || 'unknown';
          args = [identifier];
      }

      if (pkg.environmentVariables) {
        pkg.environmentVariables.forEach(v => {
          env[v.name] = ''; 
          isKeyless = false;
        });
      }
    } else if (server.remotes && server.remotes.length > 0) {
      isLocal = false;
      const remote = server.remotes[0];
      url = remote.url;
      isKeyless = false; 
    }

    const serverName = (server.name?.split('/').pop() || server.name || 'unknown').replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();
    const displayName = server.title || server.name?.split('/').pop() || 'Unknown Server';
    
    return {
      name: serverName,
      display_name: displayName,
      description: server.description || '',
      server_type: isLocal ? 'local' : 'remote',
      config: isLocal ? { command, args, env } : { url },
      auto_start: true,
      enabled: true,
      sandbox_enabled: true,
      isFromDiscover: true,
      envVarsDesc: Object.keys(env),
      isKeyless,
      isLocal
    };
  }

  /**
   * Set prefill data for the registration form
   */
  setDiscoverPreFillData(data) {
    this._discoverPreFillData = data;
  }

  /**
   * Consume (get and clear) prefill data
   */
  consumeDiscoverPreFillData() {
    const data = this._discoverPreFillData;
    this._discoverPreFillData = null;
    return data;
  }

  /**
   * Toggle server enabled status
   */
  async toggleServerEnabled(serverId, newEnabledState) {
    const serverIndex = this.servers.findIndex(s => (s.server_id || s.id) === serverId);
    if (serverIndex >= 0) {
      this.servers[serverIndex].enabled = newEnabledState;
      this.servers[serverIndex].auto_start = newEnabledState; // tie auto_start to enabled state
    }
    
    await this.endpoint.updateMcpServer(serverId, {
      enabled: newEnabledState,
      auto_start: newEnabledState
    });
  }

  /**
   * Delete a server
   */
  async deleteServer(serverId) {
    await this.endpoint.deleteMcpServer(serverId);
  }

  /**
   * Get tools for a server
   */
  async getTools(serverId) {
    const response = await this.endpoint.getMcpServerTools(serverId);
    return response.data || response || [];
  }

  /**
   * Execute a tool on an MCP server
   */
  async executeTool(serverId, toolName, args = {}) {
    const response = await this.endpoint.executeMcpTool(serverId, toolName, args);
    return response.data || response;
  }

  /**
   * Register a new server
   */
  async registerServer(formData) {
    const server = await this.endpoint.registerMcpServer(formData);
    return server?.data || server;
  }

  /**
   * Update an existing server
   */
  async updateServer(serverId, updatePayload) {
    await this.endpoint.updateMcpServer(serverId, updatePayload);
  }

  /**
   * Reset state for unmounting
   */
  reset() {
    this.servers = [];
    this.isRegistering = false;
    this.editingServerId = null;
    this._discoverPreFillData = null;
  }
}

module.exports = McpStateController;
