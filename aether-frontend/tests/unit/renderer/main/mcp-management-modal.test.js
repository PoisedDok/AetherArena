/** @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js */

'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const mockToast = { info: jest.fn(), error: jest.fn(), success: jest.fn(), warning: jest.fn() };
jest.mock('../../../../src/renderer/shared/components/Toast', () => mockToast);

const mockConfirmDialog = { confirm: jest.fn() };
jest.mock('../../../../src/renderer/shared/components/ConfirmDialog', () => mockConfirmDialog);

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => ({ endpoint: null }),
}));

const MCPManagementModal = require('../../../../src/renderer/main/modules/mcp-management/MCPManagementModal');
const McpUtils = require('../../../../src/renderer/main/modules/mcp-management/internal/McpUtils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(overrides = {}) {
  return {
    server_id: 'srv-1',
    name: 'test_server',
    display_name: 'Test Server',
    description: 'A test server',
    server_type: 'local',
    status: 'running',
    enabled: true,
    tools_count: 3,
    last_health_check: new Date().toISOString(),
    config: { command: 'node', args: ['server.js'], sandbox: false },
    auto_start: false,
    ...overrides,
  };
}

function makeEndpoint(overrides = {}) {
  return {
    listMcpServers: jest.fn().mockResolvedValue({ data: [] }),
    registerMcpServer: jest.fn().mockResolvedValue({ success: true }),
    updateMcpServer: jest.fn().mockResolvedValue({ success: true }),
    deleteMcpServer: jest.fn().mockResolvedValue({ success: true }),
    getMcpServerTools: jest.fn().mockResolvedValue({ data: [] }),
    ...overrides,
  };
}

function createModal(overrides = {}) {
  const endpoint = overrides.endpoint || makeEndpoint();
  const modal = new MCPManagementModal({ endpoint, ...overrides });
  modal.isOpen = true;
  return { modal, endpoint };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCPManagementModal', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    // Clean up any modals left in DOM
    document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    test('initializes with correct defaults', () => {
      const { modal } = createModal();
      expect(modal.id).toBe('mcp-management-modal');
      expect(modal.title).toBe('MCP Servers');
      expect(modal.servers).toEqual([]);
      expect(modal.isRegistering).toBe(false);
      expect(modal.editingServerId).toBeNull();
      expect(modal._listeners).toEqual([]);
      expect(modal._subModalEl).toBeNull();
    });

    test('stores endpoint reference', () => {
      const endpoint = makeEndpoint();
      const { modal } = createModal({ endpoint });
      expect(modal.endpoint).toBe(endpoint);
    });

    test('stores eventBus reference', () => {
      const eventBus = { on: jest.fn(), emit: jest.fn() };
      const { modal } = createModal({ eventBus });
      expect(modal.eventBus).toBe(eventBus);
    });
  });

  // -----------------------------------------------------------------------
  // _renderContent()
  // -----------------------------------------------------------------------

  describe('_renderContent()', () => {
    test('shows empty state when endpoint is null', async () => {
      const modal = new MCPManagementModal({});
      modal.endpoint = null;
      modal.bodyEl = document.createElement('div');
      await modal._renderContent();
      expect(modal.bodyEl.innerHTML).toContain('Endpoint not initialized');
    });

    test('shows skeleton then renders servers', async () => {
      const servers = [makeServer()];
      const endpoint = makeEndpoint({
        listMcpServers: jest.fn().mockResolvedValue({ data: servers }),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.isOpen = true;

      await modal._renderContent();

      expect(endpoint.listMcpServers).toHaveBeenCalledWith(false);
      expect(modal.servers).toEqual(servers);
      
      // Select My Servers tab first
      const tabs = modal.bodyEl.querySelectorAll('.modal-tab');
      if (tabs.length > 0) {
        expect(tabs).toHaveLength(2);
        
        // Mock the fetch call for discover so we don't hit the network
        global.fetch = jest.fn(() => Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ servers: [] })
        }));
        
        // Click discover tab
        tabs[1].click();
        expect(modal.activeTab).toBe('discover');
        
        // Click back to my servers tab
        tabs[0].click();
      }
      
      expect(modal.bodyEl.querySelector('.mcp-server-list')).not.toBeNull();

      modal.bodyEl.remove();
      if (global.fetch) global.fetch.mockRestore();
    });

    test('shows error state on fetch failure', async () => {
      const endpoint = makeEndpoint({
        listMcpServers: jest.fn().mockRejectedValue(new Error('Network error')),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      document.body.appendChild(modal.bodyEl);
      modal.isOpen = true;

      await modal._renderContent();

      expect(modal.bodyEl.innerHTML).toContain('Failed to Load');
      expect(modal.bodyEl.innerHTML).toContain('Network error');

      modal.bodyEl.remove();
    });

    test('escapes error message in HTML', async () => {
      const endpoint = makeEndpoint({
        listMcpServers: jest.fn().mockRejectedValue(new Error('<script>alert(1)</script>')),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');

      await modal._renderContent();

      expect(modal.bodyEl.innerHTML).not.toContain('<script>');
    });
  });

  // -----------------------------------------------------------------------
  // _renderServerList()
  // -----------------------------------------------------------------------

  describe('_renderServerList()', () => {
    test('renders empty state when no servers', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      modal.stateController.servers = [];
      modal._renderServerList();
      expect(modal.bodyEl.innerHTML).toContain('No MCP Servers');
    });

    test('renders cards for each server', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      modal.stateController.servers = [makeServer({ server_id: 'a' }), makeServer({ server_id: 'b' })];
      modal._renderServerList();
      expect(modal.bodyEl.querySelectorAll('.mcp-server-card')).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // _createServerCard()
  // -----------------------------------------------------------------------

  describe('_createServerCard()', () => {
    test('creates card with server name as textContent (not innerHTML)', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ display_name: '<b>XSS</b>' }));
      // Server name should be set via textContent, so <b> should appear as text, not as element
      expect(card.querySelector('.modal-card-title').textContent).toContain('<b>XSS</b>');
      expect(card.querySelector('.modal-card-title b')).toBeNull();
    });

    test('renders correct status indicator for running enabled server', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ enabled: true, status: 'running' }));
      const indicator = card.querySelector('.status-indicator');
      expect(indicator.title).toBe('running');
    });

    test('renders disabled indicator for disabled server', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ enabled: false }));
      const indicator = card.querySelector('.status-indicator');
      expect(indicator.title).toBe('disabled');
    });

    test('renders error indicator', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ enabled: true, status: 'error' }));
      expect(card.querySelector('.status-indicator').title).toBe('error');
    });

    test('renders warning indicator for enabled but not running', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ enabled: true, status: 'stopped' }));
      expect(card.querySelector('.status-indicator').title).toBe('stopped');
    });

    test('tracks 4 listeners (toggle, tools, edit, delete)', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      modal.renderers._listeners = [];
      modal._createServerCard(makeServer());
      expect(modal.renderers._listeners).toHaveLength(4);
    });

    test('includes description when present', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ description: 'My description' }));
      expect(card.querySelector('.modal-card-description').textContent).toBe('My description');
    });

    test('omits description when absent', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ description: '' }));
      expect(card.querySelector('.modal-card-description')).toBeNull();
    });

    test('shows tools count and server type in meta', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ tools_count: 5, server_type: 'remote' }));
      const meta = card.querySelector('.modal-card-meta').textContent;
      expect(meta).toContain('Remote');
      expect(meta).toContain('5 tools');
    });
  });

  // -----------------------------------------------------------------------
  // _handleRegisterClick()
  // -----------------------------------------------------------------------

  describe('_handleRegisterClick()', () => {
    test('sets isRegistering and clears editingServerId', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      modal.editingServerId = 'srv-1';

      // Stub render to prevent DOM ops
      modal.renderers.render = jest.fn();
      modal._handleRegisterClick();

      expect(modal.isRegistering).toBe(true);
      expect(modal.editingServerId).toBeNull();
      expect(modal.renderers.render).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _handleEdit()
  // -----------------------------------------------------------------------

  describe('_handleEdit()', () => {
    test('sets editingServerId and clears isRegistering', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      modal.isRegistering = true;
      modal.renderers.render = jest.fn();

      modal._handleEdit('srv-42');

      expect(modal.editingServerId).toBe('srv-42');
      expect(modal.isRegistering).toBe(false);
      expect(modal.renderers.render).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _renderRegistrationForm()
  // -----------------------------------------------------------------------

  describe('_renderRegistrationForm()', () => {
    test('renders registration form with empty fields', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      document.body.appendChild(modal.bodyEl);
      modal.isRegistering = true;

      modal._renderRegistrationForm();

      expect(document.getElementById('mcp-name')).not.toBeNull();
      expect(document.getElementById('mcp-command')).not.toBeNull();
      expect(document.getElementById('submit-btn').textContent).toBe('Register & Start');

      modal.bodyEl.remove();
    });

    test('renders edit form with pre-filled fields', () => {
      const server = makeServer({
        server_id: 'srv-1',
        name: 'my_server',
        display_name: 'My Server',
        description: 'A server',
        config: { command: 'python', args: ['-m', 'server'], env: { KEY: 'val' } },
      });
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      document.body.appendChild(modal.bodyEl);
      modal.editingServerId = 'srv-1';
      modal.servers = [server];

      modal._renderRegistrationForm();

      expect(document.getElementById('mcp-name').value).toBe('my_server');
      expect(document.getElementById('mcp-name').disabled).toBe(true); // Name is immutable in edit mode
      expect(document.getElementById('mcp-command').value).toBe('python');
      expect(document.getElementById('submit-btn').textContent).toBe('Update Server');

      modal.bodyEl.remove();
    });
  });

  // -----------------------------------------------------------------------
  // _collectFormData()
  // -----------------------------------------------------------------------

  describe('_collectFormData()', () => {
    function setupForm(modal, overrides = {}) {
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.stateController.isRegistering = true;
      modal._renderRegistrationForm();

      // Fill in required fields
      if (overrides.name !== undefined) document.getElementById('mcp-name').value = overrides.name;
      if (overrides.command !== undefined) document.getElementById('mcp-command').value = overrides.command;
      if (overrides.url !== undefined) document.getElementById('mcp-url').value = overrides.url;
      if (overrides.serverType) {
        const radio = document.querySelector(`input[name="server-type"][value="${overrides.serverType}"]`);
        if (radio) radio.checked = true;
      }
    }

    afterEach(() => {
      document.querySelectorAll('[class*="mcp-"]').forEach(el => el.remove());
    });

    test('returns null when name is empty (registration)', () => {
      const { modal } = createModal();
      setupForm(modal, { name: '', command: 'node' });
      const result = modal._collectFormData();
      expect(result).toBeNull();
      expect(mockToast.warning).toHaveBeenCalledWith(expect.stringContaining('name'));
      modal.bodyEl.remove();
    });

    test('returns null when command is empty for local server', () => {
      const { modal } = createModal();
      setupForm(modal, { name: 'test', command: '' });
      const result = modal._collectFormData();
      expect(result).toBeNull();
      expect(mockToast.warning).toHaveBeenCalledWith(expect.stringContaining('Command'));
      modal.bodyEl.remove();
    });

    test('collects valid local server data', () => {
      const { modal } = createModal();
      setupForm(modal, { name: 'my_server', command: 'node' });
      const result = modal._collectFormData();
      expect(result).not.toBeNull();
      expect(result.name).toBe('my_server');
      expect(result.config.command).toBe('node');
      expect(result.server_type).toBe('local');
      modal.bodyEl.remove();
    });

    test('returns null when URL is empty for remote server', () => {
      const { modal } = createModal();
      setupForm(modal, { name: 'test', serverType: 'remote', url: '' });
      const result = modal._collectFormData();
      expect(result).toBeNull();
      expect(mockToast.warning).toHaveBeenCalledWith(expect.stringContaining('URL'));
      modal.bodyEl.remove();
    });

    test('parses environment variables', () => {
      const { modal } = createModal();
      setupForm(modal, { name: 'test', command: 'node' });
      document.getElementById('mcp-env').value = 'KEY1=value1\nKEY2=a=b';
      const result = modal._collectFormData();
      expect(result.config.env).toEqual({ KEY1: 'value1', KEY2: 'a=b' });
      modal.bodyEl.remove();
    });

    test('parses space-separated args', () => {
      const { modal } = createModal();
      setupForm(modal, { name: 'test', command: 'node' });
      document.getElementById('mcp-args').value = '-m server --port 8080';
      const result = modal._collectFormData();
      expect(result.config.args).toEqual(['-m', 'server', '--port', '8080']);
      modal.bodyEl.remove();
    });
  });

  // -----------------------------------------------------------------------
  // _handleRegisterSubmit()
  // -----------------------------------------------------------------------

  describe('_handleRegisterSubmit()', () => {
    test('calls registerMcpServer and refreshes on success', async () => {
      const endpoint = makeEndpoint({
        listMcpServers: jest.fn().mockResolvedValue({ data: [] }),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.stateController.isRegistering = true;
      modal._renderRegistrationForm();

      document.getElementById('mcp-name').value = 'test';
      document.getElementById('mcp-command').value = 'node';

      await modal._handleRegisterSubmit();

      expect(endpoint.registerMcpServer).toHaveBeenCalled();
      expect(modal.stateController.isRegistering).toBe(false);

      modal.bodyEl.remove();
    });

    test('shows toast on registration failure', async () => {
      const endpoint = makeEndpoint({
        registerMcpServer: jest.fn().mockRejectedValue(new Error('Duplicate')),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.stateController.isRegistering = true;
      modal._renderRegistrationForm();

      document.getElementById('mcp-name').value = 'test';
      document.getElementById('mcp-command').value = 'node';
      mockToast.error.mockClear();

      await modal._handleRegisterSubmit();

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Duplicate'));
      const submitBtn = document.getElementById('submit-btn');
      expect(submitBtn.disabled).toBe(false);

      modal.bodyEl.remove();
    });
  });

  // -----------------------------------------------------------------------
  // _handleUpdateSubmit()
  // -----------------------------------------------------------------------

  describe('_handleUpdateSubmit()', () => {
    test('calls updateMcpServer and refreshes on success', async () => {
      const server = makeServer({ server_id: 'srv-1' });
      const endpoint = makeEndpoint({
        listMcpServers: jest.fn().mockResolvedValue({ data: [server] }),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.stateController.editingServerId = 'srv-1';
      modal.stateController.servers = [server];
      modal._renderRegistrationForm();

      document.getElementById('mcp-command').value = 'python';

      await modal._handleUpdateSubmit();

      expect(endpoint.updateMcpServer).toHaveBeenCalledWith('srv-1', expect.objectContaining({
        config: expect.any(Object),
      }));
      expect(modal.editingServerId).toBeNull();

      modal.bodyEl.remove();
    });
  });

  // -----------------------------------------------------------------------
  // _handleToggleEnabled()
  // -----------------------------------------------------------------------

  describe('_handleToggleEnabled()', () => {
    test('performs optimistic update then API call', async () => {
      const servers = [makeServer({ server_id: 'srv-1', enabled: true })];
      const endpoint = makeEndpoint({
        listMcpServers: jest.fn().mockResolvedValue({ data: servers }),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      modal.servers = servers;

      await modal._handleToggleEnabled('srv-1', 'Test', false);

      expect(endpoint.updateMcpServer).toHaveBeenCalledWith('srv-1', { enabled: false, auto_start: false });
    });

    test('reverts on API error', async () => {
      const servers = [makeServer({ server_id: 'srv-1', enabled: true })];
      const endpoint = makeEndpoint({
        updateMcpServer: jest.fn().mockRejectedValue(new Error('fail')),
        listMcpServers: jest.fn().mockResolvedValue({ data: servers }),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      modal.servers = servers;
      mockToast.error.mockClear();

      await modal._handleToggleEnabled('srv-1', 'Test', false);

      expect(mockToast.error).toHaveBeenCalled();
      // _renderContent is called to revert -- verifies the revert path
      expect(endpoint.listMcpServers).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _handleViewTools()
  // -----------------------------------------------------------------------

  describe('_handleViewTools()', () => {
    test('creates tools sub-modal', async () => {
      const tools = [{ name: 'read_file', description: 'Read a file' }];
      const endpoint = makeEndpoint({
        getMcpServerTools: jest.fn().mockResolvedValue({ data: tools }),
      });
      const { modal } = createModal({ endpoint });
      modal.servers = [makeServer({ server_id: 'srv-1' })];

      await modal._handleViewTools('srv-1');

      expect(modal._subModalEl).not.toBeNull();
      expect(document.body.contains(modal._subModalEl)).toBe(true);
      expect(modal._subModalEl.querySelector('.tool-name').textContent).toBe('read_file');

      // Cleanup
      modal._subModalEl.remove();
    });

    test('shows empty state when no tools', async () => {
      const endpoint = makeEndpoint({
        getMcpServerTools: jest.fn().mockResolvedValue({ data: [] }),
      });
      const { modal } = createModal({ endpoint });
      modal.servers = [makeServer({ server_id: 'srv-1' })];

      await modal._handleViewTools('srv-1');

      expect(modal._subModalEl.innerHTML).toContain('No tools available');

      modal._subModalEl.remove();
    });

    test('escapes tool names in sub-modal', async () => {
      const tools = [{ name: '<img onerror=alert(1) src=x>', description: 'bad' }];
      const endpoint = makeEndpoint({
        getMcpServerTools: jest.fn().mockResolvedValue({ data: tools }),
      });
      const { modal } = createModal({ endpoint });
      modal.servers = [makeServer({ server_id: 'srv-1' })];

      await modal._handleViewTools('srv-1');

      expect(modal._subModalEl.querySelector('img')).toBeNull();
      modal._subModalEl.remove();
    });

    test('shows error toast on failure', async () => {
      const endpoint = makeEndpoint({
        getMcpServerTools: jest.fn().mockRejectedValue(new Error('timeout')),
      });
      const { modal } = createModal({ endpoint });
      mockToast.error.mockClear();

      await modal._handleViewTools('srv-1');

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('timeout'));
    });
  });

  // -----------------------------------------------------------------------
  // _handleDelete()
  // -----------------------------------------------------------------------

  describe('_handleDelete()', () => {
    test('deletes server when confirmed', async () => {
      mockConfirmDialog.confirm.mockResolvedValue(true);
      const endpoint = makeEndpoint({
        listMcpServers: jest.fn().mockResolvedValue({ data: [] }),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');

      await modal._handleDelete('srv-1', 'Test Server');

      expect(endpoint.deleteMcpServer).toHaveBeenCalledWith('srv-1');
    });

    test('does nothing when cancelled', async () => {
      mockConfirmDialog.confirm.mockResolvedValue(false);
      const endpoint = makeEndpoint();
      const { modal } = createModal({ endpoint });

      await modal._handleDelete('srv-1', 'Test Server');

      expect(endpoint.deleteMcpServer).not.toHaveBeenCalled();
    });

    test('shows error toast on delete failure', async () => {
      mockConfirmDialog.confirm.mockResolvedValue(true);
      const endpoint = makeEndpoint({
        deleteMcpServer: jest.fn().mockRejectedValue(new Error('not found')),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      mockToast.error.mockClear();

      await modal._handleDelete('srv-1', 'Test Server');

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });
  });

  // -----------------------------------------------------------------------
  // McpUtils.formatDate()
  // -----------------------------------------------------------------------

  describe('McpUtils.formatDate()', () => {
    test('returns "Just now" for recent dates', () => {
      expect(McpUtils.formatDate(new Date().toISOString())).toBe('Just now');
    });

    test('returns minutes for recent past', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
      expect(McpUtils.formatDate(fiveMinAgo)).toBe('5 mins ago');
    });

    test('returns hours for same day', () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 3600000).toISOString();
      expect(McpUtils.formatDate(threeHoursAgo)).toBe('3 hrs ago');
    });

    test('returns days for same week', () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
      expect(McpUtils.formatDate(twoDaysAgo)).toBe('2 days ago');
    });
  });

  // -----------------------------------------------------------------------
  // McpUtils.escapeHtml()
  // -----------------------------------------------------------------------

  describe('McpUtils.escapeHtml()', () => {
    test('escapes HTML entities', () => {
      expect(McpUtils.escapeHtml('<script>alert(1)</script>')).not.toContain('<script>');
    });

    test('returns empty string for null', () => {
      expect(McpUtils.escapeHtml(null)).toBe('');
    });

    test('returns empty string for non-string', () => {
      expect(McpUtils.escapeHtml(123)).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // _trackListener / _clearListeners
  // -----------------------------------------------------------------------

  describe('_trackListener / _clearListeners', () => {
    test('tracks and clears listeners', () => {
      const { modal } = createModal();
      const el = document.createElement('button');
      const handler = jest.fn();
      const removeSpy = jest.spyOn(el, 'removeEventListener');

      modal._trackListener(el, 'click', handler);
      expect(modal._listeners).toHaveLength(1);

      modal._clearListeners();
      expect(removeSpy).toHaveBeenCalledWith('click', handler, undefined);
      expect(modal._listeners).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // _cleanup()
  // -----------------------------------------------------------------------

  describe('_cleanup()', () => {
    test('clears listeners, sub-modal, and state', () => {
      const { modal } = createModal();
      const el = document.createElement('button');
      modal._trackListener(el, 'click', jest.fn());
      modal.servers = [makeServer()];
      modal.isRegistering = true;
      modal.editingServerId = 'srv-1';

      const subModal = document.createElement('div');
      document.body.appendChild(subModal);
      modal._subModalEl = subModal;

      modal._cleanup();

      expect(modal._listeners).toHaveLength(0);
      expect(modal._subModalEl).toBeNull();
      expect(modal.servers).toEqual([]);
      expect(modal.isRegistering).toBe(false);
      expect(modal.editingServerId).toBeNull();
      expect(document.body.contains(subModal)).toBe(false);
    });

    test('handles null sub-modal gracefully', () => {
      const { modal } = createModal();
      modal._subModalEl = null;
      expect(() => modal._cleanup()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // _renderUI() integration — line 110 branch
  // -----------------------------------------------------------------------

  describe('_renderUI() integration', () => {
    test('renders registration form when isRegistering is true', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.isRegistering = true;

      modal._renderUI();

      expect(document.getElementById('mcp-name')).not.toBeNull();
      expect(document.getElementById('submit-btn').textContent).toBe('Register & Start');

      modal.bodyEl.remove();
    });

    test('renders registration form when editingServerId is set', () => {
      const server = makeServer({ server_id: 'srv-1' });
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.editingServerId = 'srv-1';
      modal.servers = [server];

      modal._renderUI();

      expect(document.getElementById('submit-btn').textContent).toBe('Update Server');
      expect(document.getElementById('mcp-name').disabled).toBe(true);

      modal.bodyEl.remove();
    });

    test('renders server list when not registering', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      modal.isRegistering = false;
      modal.editingServerId = null;
      modal.servers = [makeServer()];

      modal._renderUI();

      expect(modal.bodyEl.querySelector('#btn-add-mcp')).not.toBeNull();
      expect(modal.bodyEl.querySelector('.mcp-server-list')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Server card button clicks — lines 237-269
  // -----------------------------------------------------------------------

  describe('server card button click handlers', () => {
    test('toggle button calls _handleToggleEnabled', async () => {
      const server = makeServer({ server_id: 'srv-1', enabled: true });
      const endpoint = makeEndpoint({
        listMcpServers: jest.fn().mockResolvedValue({ data: [server] }),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      modal.stateController.servers = [server];
      modal.renderers._listeners = [];

      const spy = jest.spyOn(modal, '_handleToggleEnabled').mockResolvedValue();
      modal.renderers.callbacks.onToggleServer = spy;

      const card = modal._createServerCard(server);
      modal.bodyEl.appendChild(card);

      const toggleEl = card.querySelector('.aether-switch');
      toggleEl.click();

      expect(spy).toHaveBeenCalledWith('srv-1', 'test_server', false);
    });

    test('tools button calls _handleViewTools', () => {
      const server = makeServer({ server_id: 'srv-1' });
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      document.body.appendChild(modal.bodyEl);
      modal.renderers.containerEl = modal.bodyEl;
      modal.renderers._listeners = [];

      const spy = jest.spyOn(modal, '_handleViewTools').mockImplementation(() => {});
      modal.renderers.callbacks.onViewToolsClick = spy;

      const card = modal._createServerCard(server);
      modal.bodyEl.appendChild(card);
      const buttons = card.querySelectorAll('.modal-action-btn');
      const toolsBtn = buttons[0];
      
      toolsBtn.click();

      expect(spy).toHaveBeenCalledWith('srv-1', 'Test Server');
      modal.bodyEl.remove();
    });

    test('edit button calls _handleEdit', () => {
      const server = makeServer({ server_id: 'srv-1' });
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      document.body.appendChild(modal.bodyEl);
      modal.renderers.containerEl = modal.bodyEl;
      modal.renderers._listeners = [];

      const spy = jest.spyOn(modal, '_handleEdit').mockImplementation(() => {});
      modal.renderers.callbacks.onEditClick = spy;

      const card = modal._createServerCard(server);
      modal.bodyEl.appendChild(card);
      const buttons = card.querySelectorAll('.modal-action-btn');
      const editBtn = buttons[1];

      editBtn.click();

      expect(spy).toHaveBeenCalledWith('srv-1');
      modal.bodyEl.remove();
    });

    test('delete button calls _handleDelete', () => {
      const server = makeServer({ server_id: 'srv-1' });
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      document.body.appendChild(modal.bodyEl);
      modal.renderers.containerEl = modal.bodyEl;
      modal.renderers._listeners = [];

      const spy = jest.spyOn(modal, '_handleDelete').mockResolvedValue();
      modal.renderers.callbacks.onDeleteClick = spy;

      const card = modal._createServerCard(server);
      modal.bodyEl.appendChild(card);
      const buttons = card.querySelectorAll('.modal-action-btn.danger');
      const deleteBtn = buttons[0];

      deleteBtn.click();

      expect(spy).toHaveBeenCalledWith('srv-1', 'Test Server');
      modal.bodyEl.remove();
    });

    test('toggle button uses server.id fallback when server_id is absent', () => {
      const server = makeServer({ server_id: undefined, id: 'fallback-id' });
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      document.body.appendChild(modal.bodyEl);
      modal.renderers.containerEl = modal.bodyEl;
      modal.renderers._listeners = [];

      const spy = jest.spyOn(modal, '_handleToggleEnabled').mockResolvedValue();
      modal.renderers.callbacks.onToggleServer = spy;

      const card = modal._createServerCard(server);
      modal.bodyEl.appendChild(card);
      const toggleEl = card.querySelector('.aether-switch');
      toggleEl.click();

      expect(spy).toHaveBeenCalledWith('fallback-id', 'test_server', false);
      modal.bodyEl.remove();
    });
  });

  // -----------------------------------------------------------------------
  // _setupFormListeners() — lines 454-476
  // -----------------------------------------------------------------------

  describe('_setupFormListeners()', () => {
    test('radio button toggles local/remote config visibility', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      document.body.appendChild(modal.bodyEl);
      modal.isRegistering = true;
      modal._renderRegistrationForm();

      const remoteRadio = document.querySelector('input[name="server-type"][value="remote"]');
      const localRadio = document.querySelector('input[name="server-type"][value="local"]');
      const localConfig = document.getElementById('local-config');
      const remoteConfig = document.getElementById('remote-config');

      // Switch to remote
      remoteRadio.checked = true;
      remoteRadio.dispatchEvent(new Event('change'));
      expect(localConfig.style.display).toBe('none');
      expect(remoteConfig.style.display).toBe('block');

      // Switch back to local
      localRadio.checked = true;
      localRadio.dispatchEvent(new Event('change'));
      expect(localConfig.style.display).toBe('block');
      expect(remoteConfig.style.display).toBe('none');

      modal.bodyEl.remove();
    });

    test('cancel button resets state and re-renders', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.isRegistering = true;
      modal._renderRegistrationForm();

      const renderSpy = jest.spyOn(modal.renderers, 'render').mockImplementation(() => {});
      document.getElementById('cancel-btn').click();

      expect(modal.isRegistering).toBe(false);
      expect(modal.editingServerId).toBeNull();
      expect(renderSpy).toHaveBeenCalled();

      modal.bodyEl.remove();
    });

    test('submit button calls _handleRegisterSubmit when not editing', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      document.body.appendChild(modal.bodyEl);
      modal.isRegistering = true;
      modal.editingServerId = null;
      modal._renderRegistrationForm();

      const spy = jest.spyOn(modal, '_handleRegisterSubmit').mockResolvedValue();
      document.getElementById('submit-btn').click();

      expect(spy).toHaveBeenCalled();

      modal.bodyEl.remove();
    });

    test('submit button calls _handleUpdateSubmit when editing', () => {
      const server = makeServer({ server_id: 'srv-1' });
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      document.body.appendChild(modal.bodyEl);
      modal.editingServerId = 'srv-1';
      modal.servers = [server];
      modal._renderRegistrationForm();

      const spy = jest.spyOn(modal, '_handleUpdateSubmit').mockResolvedValue();
      document.getElementById('submit-btn').click();

      expect(spy).toHaveBeenCalled();

      modal.bodyEl.remove();
    });
  });

  // -----------------------------------------------------------------------
  // Validation failure paths — lines 499, 530
  // -----------------------------------------------------------------------

  describe('register/update validation failure', () => {
    test('_handleRegisterSubmit returns early when form data is invalid', async () => {
      const endpoint = makeEndpoint();
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.stateController.isRegistering = true;
      modal._renderRegistrationForm();

      // Leave name empty → validation failure
      document.getElementById('mcp-name').value = '';
      document.getElementById('mcp-command').value = 'node';

      await modal._handleRegisterSubmit();

      expect(endpoint.registerMcpServer).not.toHaveBeenCalled();

      modal.bodyEl.remove();
    });

    test('_handleUpdateSubmit returns early when form data is invalid', async () => {
      const server = makeServer({ server_id: 'srv-1', server_type: 'local' });
      const endpoint = makeEndpoint();
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.stateController.editingServerId = 'srv-1';
      modal.stateController.servers = [server];
      modal._renderRegistrationForm();

      // Clear the command field → validation failure for local type
      document.getElementById('mcp-command').value = '';

      await modal._handleUpdateSubmit();

      expect(endpoint.updateMcpServer).not.toHaveBeenCalled();

      modal.bodyEl.remove();
    });
  });

  // -----------------------------------------------------------------------
  // _handleUpdateSubmit error path — lines 553-559
  // -----------------------------------------------------------------------

  describe('_handleUpdateSubmit() error handling', () => {
    test('shows toast and re-enables button on failure', async () => {
      const server = makeServer({ server_id: 'srv-1' });
      const endpoint = makeEndpoint({
        updateMcpServer: jest.fn().mockRejectedValue(new Error('Server error')),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.stateController.editingServerId = 'srv-1';
      modal.stateController.servers = [server];
      modal._renderRegistrationForm();

      document.getElementById('mcp-command').value = 'python';
      mockToast.error.mockClear();

      await modal._handleUpdateSubmit();

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('Server error'));
      const submitBtn = document.getElementById('submit-btn');
      expect(submitBtn.disabled).toBe(false);
      expect(submitBtn.textContent).toBe('Update Server');

      modal.bodyEl.remove();
    });

    test('handles missing submitBtn in error path gracefully', async () => {
      const server = makeServer({ server_id: 'srv-1' });
      const endpoint = makeEndpoint({
        updateMcpServer: jest.fn().mockImplementation(async () => {
          // Simulate DOM being cleared during the async API call
          const btn = document.getElementById('submit-btn');
          if (btn) btn.remove();
          throw new Error('fail');
        }),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.stateController.editingServerId = 'srv-1';
      modal.stateController.servers = [server];
      modal._renderRegistrationForm();

      document.getElementById('mcp-command').value = 'python';

      mockToast.error.mockClear();
      await modal._handleUpdateSubmit();

      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('fail'));
      // Button should be gone — the if(submitBtn) guard prevented the crash
      expect(document.getElementById('submit-btn')).toBeNull();

      modal.bodyEl.remove();
    });
  });

  // -----------------------------------------------------------------------
  // _collectFormData() — remote server + API key — lines 631-633
  // -----------------------------------------------------------------------

  describe('_collectFormData() remote server', () => {
    test('collects remote server data with API key', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.isRegistering = true;
      modal._renderRegistrationForm();

      document.getElementById('mcp-name').value = 'remote_server';
      const remoteRadio = document.querySelector('input[name="server-type"][value="remote"]');
      remoteRadio.checked = true;
      document.getElementById('mcp-url').value = 'https://example.com/mcp';
      document.getElementById('mcp-api-key').value = 'secret-key-123';

      const result = modal._collectFormData();
      expect(result).not.toBeNull();
      expect(result.server_type).toBe('remote');
      expect(result.config.url).toBe('https://example.com/mcp');
      expect(result.config.api_key).toBe('secret-key-123');

      modal.bodyEl.remove();
    });

    test('omits API key when empty', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.isRegistering = true;
      modal._renderRegistrationForm();

      document.getElementById('mcp-name').value = 'remote_server';
      const remoteRadio = document.querySelector('input[name="server-type"][value="remote"]');
      remoteRadio.checked = true;
      document.getElementById('mcp-url').value = 'https://example.com/mcp';
      document.getElementById('mcp-api-key').value = '';

      const result = modal._collectFormData();
      expect(result.config.api_key).toBeUndefined();

      modal.bodyEl.remove();
    });

    test('collects resource limits when provided', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.isRegistering = true;
      modal._renderRegistrationForm();

      document.getElementById('mcp-name').value = 'test';
      document.getElementById('mcp-command').value = 'node';
      document.getElementById('mcp-max-memory').value = '512';
      document.getElementById('mcp-max-cpu').value = '80';
      document.getElementById('mcp-max-time').value = '300';

      const result = modal._collectFormData();
      expect(result.resource_limits.max_memory_mb).toBe(512);
      expect(result.resource_limits.max_cpu_percent).toBe(80);
      expect(result.resource_limits.max_execution_time_seconds).toBe(300);

      modal.bodyEl.remove();
    });

    test('skips name validation when editing', () => {
      const server = makeServer({ server_id: 'srv-1', name: 'existing' });
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      document.body.appendChild(modal.bodyEl);
      modal.editingServerId = 'srv-1';
      modal.servers = [server];
      modal._renderRegistrationForm();

      // Name is disabled in edit mode — leave empty, should not fail
      document.getElementById('mcp-command').value = 'python';

      const result = modal._collectFormData();
      expect(result).not.toBeNull();

      modal.bodyEl.remove();
    });
  });

  // -----------------------------------------------------------------------
  // _handleToggleEnabled() card replacement — lines 662-663
  // -----------------------------------------------------------------------

  describe('_handleToggleEnabled() card replacement', () => {
    test('replaces card in DOM via optimistic update', async () => {
      const server = makeServer({ server_id: 'srv-1', enabled: true });
      const endpoint = makeEndpoint({
        listMcpServers: jest.fn().mockResolvedValue({ data: [{ ...server, enabled: false }] }),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      document.body.appendChild(modal.bodyEl);
      modal.servers = [server];

      // Create and append a card with data-server-id
      const card = modal._createServerCard(server);
      modal.bodyEl.appendChild(card);

      await modal._handleToggleEnabled('srv-1', 'Test Server', false);

      expect(endpoint.updateMcpServer).toHaveBeenCalledWith('srv-1', { enabled: false, auto_start: false });
      modal.bodyEl.remove();
    });

    test('handles server not found in list gracefully', async () => {
      const endpoint = makeEndpoint({
        listMcpServers: jest.fn().mockResolvedValue({ data: [] }),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      modal.servers = [];

      await modal._handleToggleEnabled('nonexistent', 'Ghost', true);

      expect(endpoint.updateMcpServer).toHaveBeenCalledWith('nonexistent', { enabled: true, auto_start: true });
    });
  });

  // -----------------------------------------------------------------------
  // _handleViewTools() sub-modal lifecycle — lines 726, 735-738, 745
  // -----------------------------------------------------------------------

  describe('_handleViewTools() sub-modal lifecycle', () => {
    test('replaces existing sub-modal when opening new one', async () => {
      const tools = [{ name: 'tool_a', description: 'A' }];
      const endpoint = makeEndpoint({
        getMcpServerTools: jest.fn().mockResolvedValue({ data: tools }),
      });
      const { modal } = createModal({ endpoint });
      modal.servers = [makeServer({ server_id: 'srv-1' }), makeServer({ server_id: 'srv-2' })];

      // Open first sub-modal
      await modal._handleViewTools('srv-1');
      const firstSubModal = modal._subModalEl;
      expect(document.body.contains(firstSubModal)).toBe(true);

      // Open second sub-modal — should replace the first
      await modal._handleViewTools('srv-2');
      expect(document.body.contains(firstSubModal)).toBe(false);
      expect(modal._subModalEl).not.toBe(firstSubModal);

      // Cleanup
      if (modal._subModalEl) modal._subModalEl.remove();
    });

    test('close button removes sub-modal', async () => {
      jest.useFakeTimers();
      const tools = [{ name: 'tool_a', description: 'A' }];
      const endpoint = makeEndpoint({
        getMcpServerTools: jest.fn().mockResolvedValue({ data: tools }),
      });
      const { modal } = createModal({ endpoint });
      modal.servers = [makeServer({ server_id: 'srv-1' })];

      await modal._handleViewTools('srv-1');
      const subModal = modal._subModalEl;
      expect(subModal).not.toBeNull();

      const closeBtn = subModal.querySelector('.modal-close');
      closeBtn.click();

      // Class removed immediately
      expect(subModal.classList.contains('is-visible')).toBe(false);

      // DOM removal after timeout
      jest.advanceTimersByTime(300);
      expect(document.body.contains(subModal)).toBe(false);
      expect(modal._subModalEl).toBeNull();

      jest.useRealTimers();
    });

    test('footer close button removes sub-modal', async () => {
      jest.useFakeTimers();
      const tools = [{ name: 'tool_a', description: 'A' }];
      const endpoint = makeEndpoint({
        getMcpServerTools: jest.fn().mockResolvedValue({ data: tools }),
      });
      const { modal } = createModal({ endpoint });
      modal.servers = [makeServer({ server_id: 'srv-1' })];

      await modal._handleViewTools('srv-1');
      const subModal = modal._subModalEl;

      const footerBtn = subModal.querySelector('#close-tools-modal');
      footerBtn.click();

      jest.advanceTimersByTime(300);
      expect(document.body.contains(subModal)).toBe(false);

      jest.useRealTimers();
    });

    test('overlay click closes sub-modal', async () => {
      jest.useFakeTimers();
      const tools = [{ name: 'tool_a', description: 'A' }];
      const endpoint = makeEndpoint({
        getMcpServerTools: jest.fn().mockResolvedValue({ data: tools }),
      });
      const { modal } = createModal({ endpoint });
      modal.servers = [makeServer({ server_id: 'srv-1' })];

      await modal._handleViewTools('srv-1');
      const subModal = modal._subModalEl;

      // Click on the overlay itself (not a child)
      subModal.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      jest.advanceTimersByTime(300);
      expect(document.body.contains(subModal)).toBe(false);

      jest.useRealTimers();
    });

    test('overlay click on child does NOT close sub-modal', async () => {
      jest.useFakeTimers();
      const tools = [{ name: 'tool_a', description: 'A' }];
      const endpoint = makeEndpoint({
        getMcpServerTools: jest.fn().mockResolvedValue({ data: tools }),
      });
      const { modal } = createModal({ endpoint });
      modal.servers = [makeServer({ server_id: 'srv-1' })];

      await modal._handleViewTools('srv-1');
      const subModal = modal._subModalEl;

      // Click on a child element — should NOT close
      const panel = subModal.querySelector('.modal-panel');
      panel.click();

      jest.advanceTimersByTime(300);
      expect(document.body.contains(subModal)).toBe(true);

      jest.useRealTimers();
      subModal.remove();
    });

    test('uses raw response when data field is absent', async () => {
      const tools = [{ name: 'raw_tool', description: 'Raw' }];
      const endpoint = makeEndpoint({
        getMcpServerTools: jest.fn().mockResolvedValue(tools),
      });
      const { modal } = createModal({ endpoint });
      modal.servers = [makeServer({ server_id: 'srv-1' })];

      await modal._handleViewTools('srv-1');

      expect(modal._subModalEl.querySelector('.tool-name').textContent).toBe('raw_tool');
      modal._subModalEl.remove();
    });

    test('uses server name fallback when server not found', async () => {
      const endpoint = makeEndpoint({
        getMcpServerTools: jest.fn().mockResolvedValue({ data: [] }),
      });
      const { modal } = createModal({ endpoint });
      modal.servers = [];

      await modal._handleViewTools('nonexistent');

      expect(modal._subModalEl.querySelector('.modal-title').textContent).toContain('Unknown Server');
      modal._subModalEl.remove();
    });
  });

  // -----------------------------------------------------------------------
  // _formatDate() — line 806: > 7 days
  // -----------------------------------------------------------------------

  describe('_formatDate() edge cases', () => {
    test('returns formatted date for > 7 days ago', () => {
      const { modal } = createModal();
      const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
      const result = modal._formatDate(tenDaysAgo);
      // Should return something like "Feb 1" — a localized short date
      expect(result).toMatch(/[A-Z][a-z]{2} \d{1,2}/);
    });

    test('returns singular "min" for exactly 1 minute', () => {
      const { modal } = createModal();
      const oneMinAgo = new Date(Date.now() - 1 * 60000).toISOString();
      expect(modal._formatDate(oneMinAgo)).toBe('1 min ago');
    });

    test('returns singular "hr" for exactly 1 hour', () => {
      const { modal } = createModal();
      const oneHourAgo = new Date(Date.now() - 1 * 3600000).toISOString();
      expect(modal._formatDate(oneHourAgo)).toBe('1 hr ago');
    });

    test('returns singular "day" for exactly 1 day', () => {
      const { modal } = createModal();
      const oneDayAgo = new Date(Date.now() - 1 * 86400000).toISOString();
      expect(modal._formatDate(oneDayAgo)).toBe('1 day ago');
    });
  });

  // -----------------------------------------------------------------------
  // _renderContent() — response without data field
  // -----------------------------------------------------------------------

  describe('_renderContent() response fallback', () => {
    test('uses raw response when data field is absent', async () => {
      const servers = [makeServer()];
      const endpoint = makeEndpoint({
        listMcpServers: jest.fn().mockResolvedValue(servers),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      document.body.appendChild(modal.bodyEl);
      modal.isOpen = true;

      await modal._renderContent();

      expect(modal.servers).toEqual(servers);

      modal.bodyEl.remove();
    });

    test('handles error without message property', async () => {
      const endpoint = makeEndpoint({
        listMcpServers: jest.fn().mockRejectedValue({}),
      });
      const { modal } = createModal({ endpoint });
      modal.bodyEl = document.createElement('div');
      document.body.appendChild(modal.bodyEl);
      modal.isOpen = true;

      await modal._renderContent();

      expect(modal.bodyEl.innerHTML).toContain('Failed to Load');

      modal.bodyEl.remove();
    });
  });

  // -----------------------------------------------------------------------
  // Full UI button integration — exercises inline arrow callbacks
  // -----------------------------------------------------------------------

  describe('full UI button integration', () => {
    let uiBodyEl;

    afterEach(() => {
      if (uiBodyEl && uiBodyEl.parentNode) uiBodyEl.remove();
    });

    test('toggle click fires through full render path', () => {
      const server = makeServer({ server_id: 'srv-1', enabled: true });
      const endpoint = makeEndpoint({
        listMcpServers: jest.fn().mockResolvedValue({ data: [server] }),
      });
      const { modal } = createModal({ endpoint });
      uiBodyEl = document.createElement('div');
      modal.bodyEl = uiBodyEl;
      modal.renderers.containerEl = uiBodyEl;
      document.body.appendChild(uiBodyEl);
      modal.servers = [server];

      const spy = jest.spyOn(modal, '_handleToggleEnabled').mockResolvedValue();
      modal.renderers.callbacks.onToggleServer = spy;

      modal._renderUI();

      const card = uiBodyEl.querySelector('.mcp-server-card');
      const toggle = card.querySelector('.aether-switch');
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(spy).toHaveBeenCalledWith('srv-1', 'test_server', false);
    });

    test('tools click fires through full render path', () => {
      const server = makeServer({ server_id: 'srv-1' });
      const { modal } = createModal();
      uiBodyEl = document.createElement('div');
      modal.bodyEl = uiBodyEl;
      modal.renderers.containerEl = uiBodyEl;
      document.body.appendChild(uiBodyEl);
      modal.servers = [server];

      const spy = jest.spyOn(modal, '_handleViewTools').mockResolvedValue();
      modal.renderers.callbacks.onViewToolsClick = spy;

      modal._renderUI();

      const btns = uiBodyEl.querySelectorAll('.modal-action-btn');
      btns[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(spy).toHaveBeenCalledWith('srv-1', 'Test Server');
    });

    test('edit click fires through full render path', () => {
      const server = makeServer({ server_id: 'srv-1' });
      const { modal } = createModal();
      uiBodyEl = document.createElement('div');
      modal.bodyEl = uiBodyEl;
      modal.renderers.containerEl = uiBodyEl;
      document.body.appendChild(uiBodyEl);
      modal.servers = [server];

      const spy = jest.spyOn(modal, '_handleEdit').mockImplementation(() => {});
      modal.renderers.callbacks.onEditClick = spy;

      modal._renderUI();

      const btns = uiBodyEl.querySelectorAll('.modal-action-btn');
      btns[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(spy).toHaveBeenCalledWith('srv-1');
    });

    test('delete click fires through full render path', () => {
      const server = makeServer({ server_id: 'srv-1' });
      const { modal } = createModal();
      uiBodyEl = document.createElement('div');
      modal.bodyEl = uiBodyEl;
      modal.renderers.containerEl = uiBodyEl;
      document.body.appendChild(uiBodyEl);
      modal.servers = [server];

      const spy = jest.spyOn(modal, '_handleDelete').mockResolvedValue();
      modal.renderers.callbacks.onDeleteClick = spy;

      modal._renderUI();

      const btn = uiBodyEl.querySelector('.modal-action-btn.danger');
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(spy).toHaveBeenCalledWith('srv-1', 'Test Server');
    });

    test('register button fires _handleRegisterClick', () => {
      const { modal } = createModal();
      uiBodyEl = document.createElement('div');
      modal.bodyEl = uiBodyEl;
      modal.renderers.containerEl = uiBodyEl;
      document.body.appendChild(uiBodyEl);
      modal.servers = [];

      const spy = jest.spyOn(modal, '_handleRegisterClick').mockImplementation(() => {});
      modal.renderers.callbacks.onRegisterClick = spy;

      modal._renderUI();

      const regBtn = uiBodyEl.querySelector('#btn-add-mcp');
      regBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(spy).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // _createServerCard() — status text branches
  // -----------------------------------------------------------------------

  describe('_createServerCard() status text', () => {
    test('shows (disabled) text for disabled server', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ enabled: false }));
      const statusText = card.querySelector('.status-text');
      expect(statusText.textContent).toBe(' (disabled)');
    });

    test('shows (stopped) text for enabled non-running server', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ enabled: true, status: 'stopped' }));
      const statusText = card.querySelector('.status-text');
      expect(statusText.textContent).toBe(' (stopped)');
    });

    test('shows empty status text for enabled running server', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ enabled: true, status: 'running' }));
      const statusText = card.querySelector('.status-text');
      expect(statusText.textContent).toBe('');
    });

    test('defaults status to "stopped" when status is undefined', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ enabled: true, status: undefined }));
      const indicator = card.querySelector('.status-indicator');
      expect(indicator.title).toBe('stopped');
      const statusText = card.querySelector('.status-text');
      expect(statusText.textContent).toBe(' (stopped)');
    });

    test('uses server.name when display_name is absent', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ display_name: '', name: 'raw_name' }));
      expect(card.querySelector('.modal-card-title').textContent).toContain('raw_name');
    });

    test('shows "Never" for last_health_check when absent', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ last_health_check: null }));
      expect(card.querySelector('.modal-card-meta').textContent).toContain('Never');
    });

    test('defaults server_type to "local" when absent', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ server_type: undefined }));
      expect(card.querySelector('.modal-card-meta').textContent).toContain('Local');
    });

    test('defaults tools_count to 0 when absent', () => {
      const { modal } = createModal();
      modal.bodyEl = document.createElement('div');
      modal.renderers.containerEl = modal.bodyEl;
      const card = modal._createServerCard(makeServer({ tools_count: undefined }));
      expect(card.querySelector('.modal-card-meta').textContent).toContain('0 tools');
    });
  });

  // -----------------------------------------------------------------------
  // _renderRegistrationForm() — edit form with various config shapes
  // -----------------------------------------------------------------------

  describe('_renderRegistrationForm() edit form variants', () => {
    let formBodyEl;

    afterEach(() => {
      if (formBodyEl && formBodyEl.parentNode) formBodyEl.remove();
      // Remove any orphaned form containers to prevent ID collisions
      document.querySelectorAll('.mcp-registration-form').forEach(el => {
        if (el.parentNode) el.parentNode.remove();
      });
    });

    test('handles server with remote config', () => {
      const server = makeServer({
        server_id: 'srv-1',
        server_type: 'remote',
        config: { url: 'https://remote.example.com', api_key: 'key123' },
      });
      const { modal } = createModal();
      formBodyEl = document.createElement('div');
      modal.bodyEl = formBodyEl;
      modal.renderers.containerEl = formBodyEl;
      document.body.appendChild(formBodyEl);
      modal.editingServerId = 'srv-1';
      modal.servers = [server];

      modal._renderRegistrationForm();

      expect(document.getElementById('mcp-url').value).toBe('https://remote.example.com');
      expect(document.getElementById('mcp-api-key').value).toBe('key123');
    });

    test('handles server with string args instead of array', () => {
      const server = makeServer({
        server_id: 'srv-1',
        config: { command: 'python', args: 'single-arg' },
      });
      const { modal } = createModal();
      formBodyEl = document.createElement('div');
      modal.bodyEl = formBodyEl;
      modal.renderers.containerEl = formBodyEl;
      document.body.appendChild(formBodyEl);
      modal.editingServerId = 'srv-1';
      modal.servers = [server];

      modal._renderRegistrationForm();

      expect(document.getElementById('mcp-args').value).toBe('single-arg');
    });

    test('handles server with advanced settings', () => {
      const server = makeServer({
        server_id: 'srv-1',
        config: { command: 'node' },
        sandbox_enabled: true,
        resource_limits: { max_memory_mb: 1024, max_cpu_percent: 90, max_execution_time_seconds: 600 },
        auto_start: true,
        enabled: false,
      });
      const { modal } = createModal();
      formBodyEl = document.createElement('div');
      modal.bodyEl = formBodyEl;
      modal.renderers.containerEl = formBodyEl;
      document.body.appendChild(formBodyEl);
      modal.editingServerId = 'srv-1';
      modal.servers = [server];

      modal._renderRegistrationForm();

      expect(document.getElementById('mcp-sandbox').checked).toBe(true);
      expect(document.getElementById('mcp-auto-start').checked).toBe(true);
      expect(document.getElementById('mcp-enabled').checked).toBe(false);
      expect(document.getElementById('mcp-max-memory').value).toBe('1024');
      expect(document.getElementById('mcp-max-cpu').value).toBe('90');
      expect(document.getElementById('mcp-max-time').value).toBe('600');
    });

    test('handles editing server not found in list', () => {
      const { modal } = createModal();
      formBodyEl = document.createElement('div');
      modal.bodyEl = formBodyEl;
      modal.renderers.containerEl = formBodyEl;
      document.body.appendChild(formBodyEl);
      modal.editingServerId = 'nonexistent';
      modal.servers = [];

      modal._renderRegistrationForm();

      // Server not found → all escaped values are empty strings, but HTML value attribute is still set
      expect(document.getElementById('submit-btn').textContent).toBe('Update Server');
    });
  });

  // -----------------------------------------------------------------------
  // _collectFormData() — env variable edge cases
  // -----------------------------------------------------------------------

  describe('_collectFormData() env parsing edge cases', () => {
    let envBodyEl;

    afterEach(() => {
      if (envBodyEl && envBodyEl.parentNode) envBodyEl.remove();
      document.querySelectorAll('.mcp-registration-form').forEach(el => {
        if (el.parentNode) el.parentNode.remove();
      });
    });

    test('skips env lines without = separator', () => {
      const { modal } = createModal();
      envBodyEl = document.createElement('div');
      modal.bodyEl = envBodyEl;
      modal.renderers.containerEl = envBodyEl;
      document.body.appendChild(envBodyEl);
      modal.isRegistering = true;
      modal._renderRegistrationForm();

      document.getElementById('mcp-name').value = 'test';
      document.getElementById('mcp-command').value = 'node';
      document.getElementById('mcp-env').value = 'VALID=value\nINVALID_NO_EQUALS';

      const result = modal._collectFormData();
      expect(result.config.env).toEqual({ VALID: 'value' });
    });

    test('omits args when empty', () => {
      const { modal } = createModal();
      envBodyEl = document.createElement('div');
      modal.bodyEl = envBodyEl;
      modal.renderers.containerEl = envBodyEl;
      document.body.appendChild(envBodyEl);
      modal.isRegistering = true;
      modal._renderRegistrationForm();

      document.getElementById('mcp-name').value = 'test';
      document.getElementById('mcp-command').value = 'node';
      document.getElementById('mcp-args').value = '';

      const result = modal._collectFormData();
      expect(result.config.args).toBeUndefined();
    });

    test('includes auto_start and enabled flags', () => {
      const { modal } = createModal();
      envBodyEl = document.createElement('div');
      modal.bodyEl = envBodyEl;
      modal.renderers.containerEl = envBodyEl;
      document.body.appendChild(envBodyEl);
      modal.isRegistering = true;
      modal._renderRegistrationForm();

      document.getElementById('mcp-name').value = 'test';
      document.getElementById('mcp-command').value = 'node';
      document.getElementById('mcp-auto-start').checked = true;
      document.getElementById('mcp-enabled').checked = false;

      const result = modal._collectFormData();
      expect(result.auto_start).toBe(true);
      expect(result.enabled).toBe(false);
    });

    test('uses name as display_name fallback', () => {
      const { modal } = createModal();
      envBodyEl = document.createElement('div');
      modal.bodyEl = envBodyEl;
      modal.renderers.containerEl = envBodyEl;
      document.body.appendChild(envBodyEl);
      modal.isRegistering = true;
      modal._renderRegistrationForm();

      document.getElementById('mcp-name').value = 'my_server';
      document.getElementById('mcp-display-name').value = '';
      document.getElementById('mcp-command').value = 'node';

      const result = modal._collectFormData();
      expect(result.display_name).toBe('my_server');
    });
  });
});
