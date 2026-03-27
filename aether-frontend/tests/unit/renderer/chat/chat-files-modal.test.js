'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const mockAether = {
  storage: {
    loadArtifacts: jest.fn(),
  },
  ipc: {
    send: jest.fn(),
  },
};

jest.mock('../../../../src/renderer/shared/bridge/AetherBridge', () => ({
  getAether: () => mockAether,
}));

// Mock Toast
jest.mock('../../../../src/renderer/shared/components/Toast', () => ({
  info: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
}));
const Toast = require('../../../../src/renderer/shared/components/Toast');

// Mock ConfirmDialog
jest.mock('../../../../src/renderer/shared/components/ConfirmDialog', () => ({
  confirm: jest.fn(),
}));
const ConfirmDialog = require('../../../../src/renderer/shared/components/ConfirmDialog');

// Mock EventTypes
jest.mock('../../../../src/core/events/EventTypes', () => ({
  EventTypes: {
    ARTIFACTS: {
      ARTIFACT_DELETED: 'artifacts:artifact-deleted',
    },
  },
  EventPriority: {},
}));

const ChatFilesModal = require(
  '../../../../src/renderer/chat/modals/ChatFilesModal'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEventBus() {
  return { on: jest.fn(), emit: jest.fn(), off: jest.fn() };
}

function createModal(overrides = {}) {
  const eventBus = overrides.eventBus || createEventBus();
  const modal = new ChatFilesModal({ eventBus, ...overrides });
  return { modal, eventBus };
}

function makeArtifact(overrides = {}) {
  return {
    id: 'art-1',
    artifact_id: 'art-1',
    title: 'test-file.txt',
    filename: 'test-file.txt',
    type: 'file',
    language: null,
    content: 'file content here',
    created_at: '2026-01-15T10:30:00Z',
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatFilesModal', () => {
  let modal;
  let eventBus;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
    mockAether.storage.loadArtifacts.mockReset();
    mockAether.ipc.send.mockReset();
    Toast.info.mockClear();
    Toast.error.mockClear();
    ConfirmDialog.confirm.mockReset();

    // Reset window.endpoint
    delete window.endpoint;
  });

  afterEach(() => {
    if (modal) {
      try { modal.destroy(); } catch (e) { /* noop */ }
      modal = null;
    }
    eventBus = null;
    jest.useRealTimers();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('extends BaseModal with correct id and title', () => {
      ({ modal, eventBus } = createModal());
      expect(modal.id).toBe('chat-files-modal');
      expect(modal.title).toBe('Chat Files');
    });

    it('initializes chatId to null', () => {
      ({ modal, eventBus } = createModal());
      expect(modal.chatId).toBeNull();
    });

    it('initializes artifacts as empty array', () => {
      ({ modal, eventBus } = createModal());
      expect(modal.artifacts).toEqual([]);
    });

    it('initializes _listeners as empty array', () => {
      ({ modal, eventBus } = createModal());
      expect(modal._listeners).toEqual([]);
    });

    it('stores eventBus reference', () => {
      const eb = createEventBus();
      ({ modal } = createModal({ eventBus: eb }));
      expect(modal.eventBus).toBe(eb);
    });

    it('uses injected aether over getAether()', () => {
      const customAether = { storage: { loadArtifacts: jest.fn() } };
      ({ modal } = createModal({ aether: customAether }));
      expect(modal.aether).toBe(customAether);
    });
  });

  // =========================================================================
  // open
  // =========================================================================

  describe('open', () => {
    beforeEach(() => {
      ({ modal, eventBus } = createModal());
    });

    it('warns and returns when chatId is null', async () => {
      await modal.open(null);
      expect(mockLog.warn).toHaveBeenCalledWith('No chatId provided');
      expect(modal.chatId).toBeNull();
    });

    it('warns and returns when chatId is empty', async () => {
      await modal.open('');
      expect(mockLog.warn).toHaveBeenCalledWith('No chatId provided');
    });

    it('sets chatId and calls super.open()', async () => {
      mockAether.storage.loadArtifacts.mockResolvedValue([]);
      await modal.open('chat-1');
      expect(modal.chatId).toBe('chat-1');
      expect(modal.isOpen).toBe(true);
    });

    it('loads and displays artifacts', async () => {
      const artifacts = [makeArtifact()];
      mockAether.storage.loadArtifacts.mockResolvedValue(artifacts);
      await modal.open('chat-1');
      expect(modal.artifacts).toEqual(artifacts);
    });
  });

  // =========================================================================
  // _renderContent
  // =========================================================================

  describe('_renderContent', () => {
    it('creates header with title and close button', async () => {
      ({ modal, eventBus } = createModal());
      mockAether.storage.loadArtifacts.mockResolvedValue([]);
      await modal.open('chat-1');

      const title = modal.headerEl.querySelector('.cm-section-title');
      expect(title.textContent).toBe('Chat Files');
    });

    it('close button calls close()', async () => {
      ({ modal, eventBus } = createModal());
      mockAether.storage.loadArtifacts.mockResolvedValue([]);
      await modal.open('chat-1');

      const closeBtn = modal.headerEl.querySelector('.cm-action-btn--close');
      const closeSpy = jest.spyOn(modal, 'close');
      closeBtn.click();
      expect(closeSpy).toHaveBeenCalled();
    });

    it('shows skeleton loading in body', async () => {
      ({ modal, eventBus } = createModal());
      let resolveLoad;
      mockAether.storage.loadArtifacts.mockReturnValue(new Promise(r => { resolveLoad = r; }));
      const openPromise = modal.open('chat-1');
      // While loading, body should have skeleton
      expect(modal.bodyEl.innerHTML).toContain('skeleton-container');
      resolveLoad([]);
      await openPromise;
    });
  });

  // =========================================================================
  // _loadArtifacts
  // =========================================================================

  describe('_loadArtifacts', () => {
    beforeEach(() => {
      ({ modal, eventBus } = createModal());
    });

    it('displays artifacts when array returned', async () => {
      const artifacts = [makeArtifact()];
      mockAether.storage.loadArtifacts.mockResolvedValue(artifacts);
      await modal.open('chat-1');
      expect(modal.bodyEl.querySelector('.cfm-item')).not.toBeNull();
    });

    it('shows empty state when empty array', async () => {
      mockAether.storage.loadArtifacts.mockResolvedValue([]);
      await modal.open('chat-1');
      expect(modal.bodyEl.innerHTML).toContain('No files found');
    });

    it('handles null response', async () => {
      mockAether.storage.loadArtifacts.mockResolvedValue(null);
      await modal.open('chat-1');
      expect(modal.artifacts).toEqual([]);
    });

    it('handles non-array response', async () => {
      mockAether.storage.loadArtifacts.mockResolvedValue('not-array');
      await modal.open('chat-1');
      expect(modal.artifacts).toEqual([]);
    });

    it('shows error state on API failure', async () => {
      mockAether.storage.loadArtifacts.mockRejectedValue(new Error('network'));
      await modal.open('chat-1');
      expect(mockLog.error).toHaveBeenCalledWith('failed to load artifacts', expect.objectContaining({
        chatId: 'chat-1',
      }));
      expect(modal.bodyEl.innerHTML).toContain('Failed to load files');
    });
  });

  // =========================================================================
  // _displayArtifacts (categorization)
  // =========================================================================

  describe('_displayArtifacts', () => {
    beforeEach(() => {
      ({ modal, eventBus } = createModal());
    });

    it('groups file-type artifacts under Attachments', async () => {
      const artifacts = [makeArtifact({ type: 'file' })];
      mockAether.storage.loadArtifacts.mockResolvedValue(artifacts);
      await modal.open('chat-1');

      const header = modal.bodyEl.querySelector('.cfm-category-header');
      expect(header.textContent).toContain('Attachments');
    });

    it('groups output-type artifacts under Outputs', async () => {
      const artifacts = [makeArtifact({ type: 'output', title: 'output.txt' })];
      mockAether.storage.loadArtifacts.mockResolvedValue(artifacts);
      await modal.open('chat-1');

      const header = modal.bodyEl.querySelector('.cfm-category-header');
      expect(header.textContent).toContain('Outputs');
    });

    it('handles all output type variants: console, html, text, markdown, json', async () => {
      const artifacts = [
        makeArtifact({ type: 'console', id: 'a1', title: 'console.log' }),
        makeArtifact({ type: 'html', id: 'a2', title: 'page.html' }),
        makeArtifact({ type: 'text', id: 'a3', title: 'note.txt' }),
        makeArtifact({ type: 'markdown', id: 'a4', title: 'readme.md' }),
        makeArtifact({ type: 'json', id: 'a5', title: 'data.json' }),
      ];
      mockAether.storage.loadArtifacts.mockResolvedValue(artifacts);
      await modal.open('chat-1');

      const items = modal.bodyEl.querySelectorAll('.cfm-item');
      expect(items.length).toBe(5);
    });

    it('shows empty when all artifacts are code type (excluded)', async () => {
      const artifacts = [makeArtifact({ type: 'code', title: 'app.js' })];
      mockAether.storage.loadArtifacts.mockResolvedValue(artifacts);
      await modal.open('chat-1');
      expect(modal.bodyEl.innerHTML).toContain('No files found');
    });

    it('shows both categories when mixed types', async () => {
      const artifacts = [
        makeArtifact({ type: 'file', id: 'a1' }),
        makeArtifact({ type: 'output', id: 'a2', title: 'out.txt' }),
      ];
      mockAether.storage.loadArtifacts.mockResolvedValue(artifacts);
      await modal.open('chat-1');

      const headers = modal.bodyEl.querySelectorAll('.cfm-category-header');
      expect(headers.length).toBe(2);
    });

    it('includes icon in category header when icon is truthy', async () => {
      const artifacts = [makeArtifact({ type: 'file' })];
      mockAether.storage.loadArtifacts.mockResolvedValue(artifacts);
      await modal.open('chat-1');

      // Call _renderCategory directly with a truthy icon to exercise the icon branch
      modal._renderCategory('Custom', [makeArtifact()], 'ICON');
      const headers = modal.bodyEl.querySelectorAll('.cfm-category-header');
      // Last header should have the icon prefix
      const lastHeader = headers[headers.length - 1];
      expect(lastHeader.textContent).toBe('ICON Custom (1)');
    });
  });

  // =========================================================================
  // _createArtifactItem
  // =========================================================================

  describe('_createArtifactItem', () => {
    beforeEach(() => {
      ({ modal, eventBus } = createModal());
    });

    it('displays title from artifact', async () => {
      const artifact = makeArtifact({ title: 'my-file.txt', filename: 'backup.txt' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      const filename = modal.bodyEl.querySelector('.cfm-filename');
      expect(filename.textContent).toBe('my-file.txt');
    });

    it('falls back to filename when title absent', async () => {
      const artifact = makeArtifact({ title: undefined, filename: 'backup.txt' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      const filename = modal.bodyEl.querySelector('.cfm-filename');
      expect(filename.textContent).toBe('backup.txt');
    });

    it('constructs name from type.language when both title and filename absent', async () => {
      const artifact = makeArtifact({ title: undefined, filename: undefined, type: 'output', language: 'python' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      const filename = modal.bodyEl.querySelector('.cfm-filename');
      expect(filename.textContent).toBe('output.python');
    });

    it('uses .txt extension when language is null', async () => {
      const artifact = makeArtifact({ title: undefined, filename: undefined, type: 'output', language: null });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      const filename = modal.bodyEl.querySelector('.cfm-filename');
      expect(filename.textContent).toBe('output.txt');
    });

    it('displays formatted size', async () => {
      const artifact = makeArtifact({ content: 'x'.repeat(2048) });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      const size = modal.bodyEl.querySelector('.cfm-size');
      expect(size.textContent).toBe('2.0 KB');
    });

    it('displays type tag', async () => {
      const artifact = makeArtifact({ type: 'file' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      const typeTag = modal.bodyEl.querySelector('.cfm-type-tag');
      expect(typeTag.textContent).toBe('file');
    });

    it('displays language when present', async () => {
      const artifact = makeArtifact({ type: 'output', language: 'javascript' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      const metaRow = modal.bodyEl.querySelector('.cfm-meta-row');
      expect(metaRow.textContent).toContain('javascript');
    });

    it('omits language element when language is null', async () => {
      const artifact = makeArtifact({ type: 'file', language: null });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      const metaRow = modal.bodyEl.querySelector('.cfm-meta-row');
      // Should have type tag and timestamp, but no separate language span
      const spans = metaRow.querySelectorAll('span');
      expect(spans.length).toBe(2); // type tag + timestamp
    });

    it('displays formatted timestamp', async () => {
      const artifact = makeArtifact({ created_at: '2026-01-15T10:30:00Z' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      const metaRow = modal.bodyEl.querySelector('.cfm-meta-row');
      // Should contain a date string
      expect(metaRow.textContent.length).toBeGreaterThan(5);
    });

    it('creates delete button with tracked listener', async () => {
      const artifact = makeArtifact();
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      const deleteBtn = modal.bodyEl.querySelector('.cfm-delete-btn');
      expect(deleteBtn).not.toBeNull();
      expect(deleteBtn.getAttribute('aria-label')).toBe('Delete artifact');
    });

    it('click on item opens artifact', async () => {
      const artifact = makeArtifact({ type: 'file' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      const item = modal.bodyEl.querySelector('.cfm-item');
      const spy = jest.spyOn(modal, '_openArtifact');
      item.click();
      expect(spy).toHaveBeenCalledWith(artifact);
    });
  });

  // =========================================================================
  // _openArtifact
  // =========================================================================

  describe('_openArtifact', () => {
    beforeEach(() => {
      ({ modal, eventBus } = createModal());
    });

    it('emits artifacts:open-file for file type', async () => {
      const artifact = makeArtifact({ type: 'file', id: 'art-1', title: 'test.txt' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      modal._openArtifact(artifact);
      expect(eventBus.emit).toHaveBeenCalledWith('artifacts:open-file', expect.objectContaining({
        artifactId: 'art-1',
        filename: 'test.txt',
        type: 'file',
      }));
    });

    it('closes modal after opening file type', async () => {
      const artifact = makeArtifact({ type: 'file' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      const closeSpy = jest.spyOn(modal, 'close');
      modal._openArtifact(artifact);
      expect(closeSpy).toHaveBeenCalled();
    });

    it('uses artifact_id as fallback when id absent', async () => {
      const artifact = makeArtifact({ id: undefined, artifact_id: 'fallback-id', type: 'file' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      modal._openArtifact(artifact);
      expect(eventBus.emit).toHaveBeenCalledWith('artifacts:open-file', expect.objectContaining({
        artifactId: 'fallback-id',
      }));
    });

    it('uses filename as displayName when title is absent', async () => {
      const artifact = makeArtifact({ type: 'file', title: undefined, filename: 'fallback.doc' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      modal._openArtifact(artifact);
      expect(mockLog.info).toHaveBeenCalledWith('opening artifact', expect.objectContaining({
        filename: 'fallback.doc',
      }));
    });

    it('warns when eventBus is null for file type', async () => {
      ({ modal } = createModal({ eventBus: null }));
      const artifact = makeArtifact({ type: 'file' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      modal._openArtifact(artifact);
      expect(mockLog.warn).toHaveBeenCalledWith('EventBus not available, cannot open file viewer');
    });

    it('sends IPC for non-file artifacts (output)', async () => {
      const artifact = makeArtifact({ type: 'output', content: 'console output' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      modal._openArtifact(artifact);
      expect(mockAether.ipc.send).toHaveBeenCalledWith('artifacts:switch-tab', 'output');
      expect(mockAether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', expect.objectContaining({
        output: 'console output',
        format: 'text',
      }));
    });

    it('detects html format', async () => {
      const artifact = makeArtifact({ type: 'html', content: '<div>hello</div>' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      modal._openArtifact(artifact);
      expect(mockAether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', expect.objectContaining({
        format: 'html',
      }));
    });

    it('detects html from content starting with <', async () => {
      const artifact = makeArtifact({ type: 'text', content: '<html>page</html>' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      modal._openArtifact(artifact);
      expect(mockAether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', expect.objectContaining({
        format: 'html',
      }));
    });

    it('detects markdown format from type', async () => {
      const artifact = makeArtifact({ type: 'markdown', title: 'readme.md' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      modal._openArtifact(artifact);
      expect(mockAether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', expect.objectContaining({
        format: 'markdown',
      }));
    });

    it('detects markdown format from filename extension', async () => {
      const artifact = makeArtifact({ type: 'text', title: 'notes.md' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      modal._openArtifact(artifact);
      expect(mockAether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', expect.objectContaining({
        format: 'markdown',
      }));
    });

    it('detects json format from type', async () => {
      const artifact = makeArtifact({ type: 'json', title: 'data.json' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      modal._openArtifact(artifact);
      expect(mockAether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', expect.objectContaining({
        format: 'json',
      }));
    });

    it('detects json format from filename extension', async () => {
      const artifact = makeArtifact({ type: 'text', title: 'config.json' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      modal._openArtifact(artifact);
      expect(mockAether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', expect.objectContaining({
        format: 'json',
      }));
    });

    it('defaults to text format for unknown types', async () => {
      const artifact = makeArtifact({ type: 'console', content: 'log output', title: 'output.log' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      modal._openArtifact(artifact);
      expect(mockAether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', expect.objectContaining({
        format: 'text',
      }));
    });

    it('handles empty content', async () => {
      const artifact = makeArtifact({ type: 'output', content: undefined });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      modal._openArtifact(artifact);
      expect(mockAether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', expect.objectContaining({
        output: '',
      }));
    });

    it('warns when IPC unavailable', async () => {
      ({ modal } = createModal({ aether: { storage: { loadArtifacts: jest.fn().mockResolvedValue([]) }, ipc: null } }));
      const artifact = makeArtifact({ type: 'output' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      modal._openArtifact(artifact);
      expect(mockLog.warn).toHaveBeenCalledWith('IPC unavailable; cannot open artifacts window', expect.any(Object));
    });

    it('closes modal after opening non-file artifact', async () => {
      const artifact = makeArtifact({ type: 'output' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      const closeSpy = jest.spyOn(modal, 'close');
      modal._openArtifact(artifact);
      expect(closeSpy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _handleDeleteArtifact
  // =========================================================================

  describe('_handleDeleteArtifact', () => {
    beforeEach(() => {
      ({ modal, eventBus } = createModal());
    });

    it('shows confirm dialog before deleting', async () => {
      ConfirmDialog.confirm.mockResolvedValue(false);
      const artifact = makeArtifact();
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      await modal._handleDeleteArtifact(artifact);
      expect(ConfirmDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Delete file',
        variant: 'danger',
      }));
    });

    it('does not delete when user cancels', async () => {
      ConfirmDialog.confirm.mockResolvedValue(false);
      const artifact = makeArtifact();
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      await modal._handleDeleteArtifact(artifact);
      // No delete attempt
      expect(Toast.info).not.toHaveBeenCalled();
    });

    it('deletes artifact when confirmed and endpoint available', async () => {
      const mockEndpoint = { deleteArtifact: jest.fn().mockResolvedValue(undefined) };
      ({ modal } = createModal({ endpoint: mockEndpoint }));
      ConfirmDialog.confirm.mockResolvedValue(true);
      const artifact = makeArtifact({ id: 'art-del' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      mockAether.storage.loadArtifacts.mockResolvedValue([]); // After delete
      await modal._handleDeleteArtifact(artifact);

      expect(mockEndpoint.deleteArtifact).toHaveBeenCalledWith('art-del');
      expect(Toast.info).toHaveBeenCalled();
    });

    it('emits ARTIFACT_DELETED event on success', async () => {
      const mockEndpoint = { deleteArtifact: jest.fn().mockResolvedValue(undefined) };
      ({ modal, eventBus } = createModal({ endpoint: mockEndpoint }));
      ConfirmDialog.confirm.mockResolvedValue(true);
      const artifact = makeArtifact({ id: 'art-del' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      mockAether.storage.loadArtifacts.mockResolvedValue([]);
      await modal._handleDeleteArtifact(artifact);

      expect(eventBus.emit).toHaveBeenCalledWith('artifacts:artifact-deleted', {
        chatId: 'chat-1',
        artifactId: 'art-del',
      });
    });

    it('skips event emission when eventBus is null on successful delete', async () => {
      const mockEndpoint = { deleteArtifact: jest.fn().mockResolvedValue(undefined) };
      ({ modal } = createModal({ eventBus: null, endpoint: mockEndpoint }));
      ConfirmDialog.confirm.mockResolvedValue(true);
      const artifact = makeArtifact({ id: 'art-no-bus' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      mockAether.storage.loadArtifacts.mockResolvedValue([]);
      await modal._handleDeleteArtifact(artifact);

      // Should succeed without throwing even with null eventBus
      expect(mockEndpoint.deleteArtifact).toHaveBeenCalledWith('art-no-bus');
      expect(Toast.info).toHaveBeenCalled();
    });

    it('shows error toast when endpoint unavailable', async () => {
      ({ modal } = createModal({ endpoint: null }));
      ConfirmDialog.confirm.mockResolvedValue(true);
      const artifact = makeArtifact();
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      await modal._handleDeleteArtifact(artifact);
      expect(Toast.error).toHaveBeenCalled();
      expect(mockLog.error).toHaveBeenCalledWith('Failed to delete artifact', expect.any(Object));
    });

    it('shows "Unknown error" when thrown value lacks .message', async () => {
      const mockEndpoint = { deleteArtifact: jest.fn().mockRejectedValue({ code: 500 }) };
      ({ modal } = createModal({ endpoint: mockEndpoint }));
      ConfirmDialog.confirm.mockResolvedValue(true);
      const artifact = makeArtifact();
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      await modal._handleDeleteArtifact(artifact);
      expect(Toast.error).toHaveBeenCalledWith('Failed to delete: Unknown error');
    });

    it('shows error toast on API failure', async () => {
      const mockEndpoint = { deleteArtifact: jest.fn().mockRejectedValue(new Error('server error')) };
      ({ modal } = createModal({ endpoint: mockEndpoint }));
      ConfirmDialog.confirm.mockResolvedValue(true);
      const artifact = makeArtifact();
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      await modal._handleDeleteArtifact(artifact);
      expect(Toast.error).toHaveBeenCalledWith(expect.stringContaining('server error'));
    });

    it('uses title as display name, falling back to filename then type', async () => {
      ConfirmDialog.confirm.mockResolvedValue(false);
      const artifact = makeArtifact({ title: undefined, filename: undefined, type: 'output' });
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      await modal._handleDeleteArtifact(artifact);
      expect(ConfirmDialog.confirm).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('output'),
      }));
    });

    it('delete button click stops propagation to prevent _openArtifact', async () => {
      const artifact = makeArtifact();
      mockAether.storage.loadArtifacts.mockResolvedValue([artifact]);
      await modal.open('chat-1');

      const openSpy = jest.spyOn(modal, '_openArtifact');
      const deleteBtn = modal.bodyEl.querySelector('.cfm-delete-btn');
      ConfirmDialog.confirm.mockResolvedValue(false);
      deleteBtn.click();
      // _openArtifact should NOT be called because stopPropagation
      expect(openSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // _formatSize
  // =========================================================================

  describe('_formatSize', () => {
    beforeEach(() => {
      ({ modal, eventBus } = createModal());
    });

    it('formats bytes', () => {
      expect(modal._formatSize(500)).toBe('500 B');
    });

    it('formats kilobytes', () => {
      expect(modal._formatSize(2048)).toBe('2.0 KB');
    });

    it('formats megabytes', () => {
      expect(modal._formatSize(1048576)).toBe('1.0 MB');
    });

    it('handles zero bytes', () => {
      expect(modal._formatSize(0)).toBe('0 B');
    });
  });

  // =========================================================================
  // _formatTimestamp
  // =========================================================================

  describe('_formatTimestamp', () => {
    beforeEach(() => {
      ({ modal, eventBus } = createModal());
    });

    it('returns empty string for null', () => {
      expect(modal._formatTimestamp(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(modal._formatTimestamp(undefined)).toBe('');
    });

    it('formats valid timestamp', () => {
      const result = modal._formatTimestamp('2026-01-15T10:30:00Z');
      expect(result.length).toBeGreaterThan(5);
    });
  });

  // =========================================================================
  // _trackListener / _cleanup
  // =========================================================================

  describe('_trackListener', () => {
    it('no-ops for null element', () => {
      ({ modal, eventBus } = createModal());
      modal._trackListener(null, 'click', jest.fn());
      expect(modal._listeners.length).toBe(0);
    });
  });

  describe('_cleanup', () => {
    it('removes all tracked listeners and resets state', async () => {
      ({ modal, eventBus } = createModal());
      mockAether.storage.loadArtifacts.mockResolvedValue([makeArtifact()]);
      await modal.open('chat-1');

      expect(modal._listeners.length).toBeGreaterThan(0);
      modal._cleanup();
      expect(modal._listeners).toEqual([]);
      expect(modal.chatId).toBeNull();
      expect(modal.artifacts).toEqual([]);
    });
  });

  // =========================================================================
  // _displayError
  // =========================================================================

  describe('_displayError', () => {
    it('renders error state', async () => {
      ({ modal, eventBus } = createModal());
      mockAether.storage.loadArtifacts.mockRejectedValue(new Error('fail'));
      await modal.open('chat-1');
      expect(modal.bodyEl.innerHTML).toContain('Failed to load files');
    });
  });
});
