'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  })),
}));

jest.mock('../../../../src/renderer/shared/components/Toast', () => ({
  success: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  info: jest.fn(),
}));

const EventBusBridge = require('../../../../src/renderer/main/runtime/coordinators/EventBusBridge');
const { EventTypes } = require('../../../../src/core/events/EventTypes');
const Toast = require('../../../../src/renderer/shared/components/Toast');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createElement() {
  return document.createElement('span');
}

function createElements() {
  return {
    settingsStatus: createElement(),
    connectionStatus: createElement(),
  };
}

function createMockEventBus() {
  const handlers = new Map();
  return {
    on: jest.fn((event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      const unsub = jest.fn(() => {
        const arr = handlers.get(event);
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx >= 0) arr.splice(idx, 1);
        }
      });
      return unsub;
    }),
    emit: jest.fn((event, data) => {
      const arr = handlers.get(event);
      if (arr) arr.forEach(h => h(data));
    }),
    _handlers: handlers,
    _emit(event, data) {
      const arr = handlers.get(event);
      if (arr) arr.forEach(h => h(data));
    },
  };
}

function createMockAether() {
  return {
    chat: { open: jest.fn() },
    ipc: { send: jest.fn() },
    eventBus: { emit: jest.fn() },
  };
}

function createMockEndpoint() {
  return {
    getArtifact: jest.fn(),
  };
}

function createMockGuru(overrides = {}) {
  return {
    state: {
      activeChatId: 'chat-123',
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('EventBusBridge', () => {
  let bridge;

  beforeEach(() => {
    jest.useFakeTimers();

    const { createRendererLogger } = require('../../../../src/renderer/shared/utils/logger');
    createRendererLogger.mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
    });

    Toast.success.mockClear();
    Toast.error.mockClear();
    Toast.warning.mockClear();
    Toast.info.mockClear();

    delete window.sidebarRefreshChannel;
    delete window.endpoint;

    bridge = null;
  });

  afterEach(() => {
    if (bridge) {
      try { bridge.dispose(); } catch (_) { /* already disposed */ }
    }
    jest.useRealTimers();
    delete window.sidebarRefreshChannel;
    delete window.endpoint;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Constructor
  // ═══════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('creates instance with defaults', () => {
      bridge = new EventBusBridge();
      expect(bridge).toBeInstanceOf(EventBusBridge);
      expect(bridge.eventBus).toBeNull();
      expect(bridge.elements).toEqual({});
      expect(bridge.aether).toBeNull();
      expect(bridge.endpoint).toBeNull();
      expect(bridge.guru).toBeNull();
      expect(bridge.callbacks).toEqual({});
      expect(bridge._cleanup).toEqual([]);
      expect(bridge._statusMessageTimeout).toBeNull();
    });

    it('accepts all options', () => {
      const eventBus = createMockEventBus();
      const elements = createElements();
      const aether = createMockAether();
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      const callbacks = { openSettings: jest.fn() };

      bridge = new EventBusBridge({ eventBus, elements, aether, endpoint, guru, callbacks });
      expect(bridge.eventBus).toBe(eventBus);
      expect(bridge.elements).toBe(elements);
      expect(bridge.aether).toBe(aether);
      expect(bridge.endpoint).toBe(endpoint);
      expect(bridge.guru).toBe(guru);
      expect(bridge.callbacks).toBe(callbacks);
    });

    it('creates logger with name EventBusBridge', () => {
      const { createRendererLogger } = require('../../../../src/renderer/shared/utils/logger');
      bridge = new EventBusBridge();
      expect(createRendererLogger).toHaveBeenCalledWith('EventBusBridge');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // bind()
  // ═══════════════════════════════════════════════════════════════════════

  describe('bind()', () => {
    it('warns and returns early when no eventBus', () => {
      bridge = new EventBusBridge();
      bridge.bind();
      expect(bridge.log.warn).toHaveBeenCalledWith('EventBus unavailable; UI bridge disabled');
      expect(bridge._cleanup).toEqual([]);
    });

    it('registers event handlers and stores unsubscribers', () => {
      const eventBus = createMockEventBus();
      bridge = new EventBusBridge({ eventBus });
      bridge.bind();
      expect(eventBus.on).toHaveBeenCalled();
      expect(bridge._cleanup.length).toBeGreaterThan(0);
    });

    it('registers handler for SETTINGS_OPENED', () => {
      const eventBus = createMockEventBus();
      const openSettings = jest.fn();
      bridge = new EventBusBridge({ eventBus, callbacks: { openSettings } });
      bridge.bind();

      eventBus._emit(EventTypes.UI.SETTINGS_OPENED);
      expect(openSettings).toHaveBeenCalledTimes(1);
    });

    it('SETTINGS_OPENED is no-op when callback not provided', () => {
      const eventBus = createMockEventBus();
      bridge = new EventBusBridge({ eventBus, callbacks: {} });
      bridge.bind();

      // Should not crash
      eventBus._emit(EventTypes.UI.SETTINGS_OPENED);
    });

    it('registers handler for SETTINGS_CLOSED', () => {
      const eventBus = createMockEventBus();
      const closeSettings = jest.fn();
      bridge = new EventBusBridge({ eventBus, callbacks: { closeSettings } });
      bridge.bind();

      eventBus._emit(EventTypes.UI.SETTINGS_CLOSED);
      expect(closeSettings).toHaveBeenCalledTimes(1);
    });

    it('registers handler for TAB_CHANGED', () => {
      const eventBus = createMockEventBus();
      const switchSettingsTab = jest.fn();
      bridge = new EventBusBridge({ eventBus, callbacks: { switchSettingsTab } });
      bridge.bind();

      eventBus._emit(EventTypes.UI.TAB_CHANGED, { tab: 'models' });
      expect(switchSettingsTab).toHaveBeenCalledWith('models');
    });

    it('TAB_CHANGED is no-op when payload has no tab', () => {
      const eventBus = createMockEventBus();
      const switchSettingsTab = jest.fn();
      bridge = new EventBusBridge({ eventBus, callbacks: { switchSettingsTab } });
      bridge.bind();

      eventBus._emit(EventTypes.UI.TAB_CHANGED, {});
      expect(switchSettingsTab).not.toHaveBeenCalled();
    });

    it('TAB_CHANGED handles undefined payload', () => {
      const eventBus = createMockEventBus();
      const switchSettingsTab = jest.fn();
      bridge = new EventBusBridge({ eventBus, callbacks: { switchSettingsTab } });
      bridge.bind();

      eventBus._emit(EventTypes.UI.TAB_CHANGED, undefined);
      expect(switchSettingsTab).not.toHaveBeenCalled();
    });

    it('TAB_CHANGED with tab but no switchSettingsTab callback', () => {
      const eventBus = createMockEventBus();
      bridge = new EventBusBridge({ eventBus, callbacks: {} });
      bridge.bind();

      // Should not crash — payload.tab is truthy but callback is missing
      eventBus._emit(EventTypes.UI.TAB_CHANGED, { tab: 'models' });
    });

    it('SETTINGS_CLOSED is no-op when callback not provided', () => {
      const eventBus = createMockEventBus();
      bridge = new EventBusBridge({ eventBus, callbacks: {} });
      bridge.bind();

      // Should not crash
      eventBus._emit(EventTypes.UI.SETTINGS_CLOSED);
    });

    it('registers handler for NOTIFICATION', () => {
      const eventBus = createMockEventBus();
      const elements = createElements();
      bridge = new EventBusBridge({ eventBus, elements });
      bridge.bind();

      eventBus._emit(EventTypes.UI.NOTIFICATION, { message: 'test', type: 'success' });
      expect(Toast.success).toHaveBeenCalledWith('test', 3000);
    });

    it('NOTIFICATION handler uses default empty payload when emitted without data', () => {
      const eventBus = createMockEventBus();
      const elements = createElements();
      bridge = new EventBusBridge({ eventBus, elements });
      bridge.bind();

      // Emit without data — handler's default `payload = {}` should activate
      eventBus._emit(EventTypes.UI.NOTIFICATION, undefined);
      // No message in default payload — returns early
      expect(Toast.info).not.toHaveBeenCalled();
    });

    it('registers handler for CONNECTION.STATUS_CHANGED', () => {
      const eventBus = createMockEventBus();
      const elements = createElements();
      bridge = new EventBusBridge({ eventBus, elements });
      bridge.bind();

      eventBus._emit(EventTypes.CONNECTION.STATUS_CHANGED, { connected: true, previous: true });
      expect(elements.connectionStatus.textContent).toBe('ONLINE');
    });

    it('CONNECTION handler uses default empty payload when emitted without data', () => {
      const eventBus = createMockEventBus();
      const elements = createElements();
      bridge = new EventBusBridge({ eventBus, elements });
      bridge.bind();

      // Emit without data — handler's default `payload = {}` should activate
      eventBus._emit(EventTypes.CONNECTION.STATUS_CHANGED, undefined);
      expect(elements.connectionStatus.textContent).toBe('OFFLINE');
    });

    it('registers handler for STT_FINAL with sidebar refresh', () => {
      const eventBus = createMockEventBus();
      const guru = createMockGuru({ activeChatId: 'chat-abc' });
      const postMessage = jest.fn();
      window.sidebarRefreshChannel = { postMessage };
      bridge = new EventBusBridge({ eventBus, guru });
      bridge.bind();

      eventBus._emit(EventTypes.AUDIO.STT_FINAL, { text: 'hello' });
      expect(postMessage).toHaveBeenCalledWith({
        type: 'chat_message_added',
        chat_id: 'chat-abc',
      });
    });

    it('STT_FINAL skips when no sidebarRefreshChannel', () => {
      const eventBus = createMockEventBus();
      const guru = createMockGuru();
      bridge = new EventBusBridge({ eventBus, guru });
      bridge.bind();

      // Should not crash
      eventBus._emit(EventTypes.AUDIO.STT_FINAL, { text: 'hello' });
    });

    it('STT_FINAL skips when no data', () => {
      const eventBus = createMockEventBus();
      const guru = createMockGuru();
      window.sidebarRefreshChannel = { postMessage: jest.fn() };
      bridge = new EventBusBridge({ eventBus, guru });
      bridge.bind();

      eventBus._emit(EventTypes.AUDIO.STT_FINAL, null);
      expect(window.sidebarRefreshChannel.postMessage).not.toHaveBeenCalled();
    });

    it('STT_FINAL skips when no activeChatId', () => {
      const eventBus = createMockEventBus();
      const guru = createMockGuru({ activeChatId: null });
      const postMessage = jest.fn();
      window.sidebarRefreshChannel = { postMessage };
      bridge = new EventBusBridge({ eventBus, guru });
      bridge.bind();

      eventBus._emit(EventTypes.AUDIO.STT_FINAL, { text: 'hello' });
      expect(postMessage).not.toHaveBeenCalled();
    });

    it('handles modal:chat-new-requested', () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      bridge = new EventBusBridge({ eventBus, aether });
      bridge.bind();

      eventBus._emit('modal:chat-new-requested');
      expect(aether.ipc.send).toHaveBeenCalledWith('chat:new-requested');
    });

    it('modal:chat-new-requested is no-op without aether.chat', () => {
      const eventBus = createMockEventBus();
      bridge = new EventBusBridge({ eventBus, aether: {} });
      bridge.bind();

      // Should not crash
      eventBus._emit('modal:chat-new-requested');
    });

    it('modal:chat-new-requested skips ipc send when aether.ipc missing', () => {
      const eventBus = createMockEventBus();
      const aether = { chat: { open: jest.fn() } };
      bridge = new EventBusBridge({ eventBus, aether });
      bridge.bind();

      eventBus._emit('modal:chat-new-requested');
      // Should not throw and do nothing
    });

    it('handles modal:chat-open-requested', () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      bridge = new EventBusBridge({ eventBus, aether });
      bridge.bind();

      eventBus._emit('modal:chat-open-requested', { chatId: 'chat-456' });

      expect(aether.ipc.send).toHaveBeenCalledWith('chat:switch-to-chat', { chatId: 'chat-456' });
    });

    it('modal:chat-open-requested is no-op without chatId', () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      bridge = new EventBusBridge({ eventBus, aether });
      bridge.bind();

      eventBus._emit('modal:chat-open-requested', {});
      expect(aether.ipc.send).not.toHaveBeenCalled();
    });

    it('modal:chat-open-requested is no-op without aether.ipc', () => {
      const eventBus = createMockEventBus();
      bridge = new EventBusBridge({ eventBus, aether: {} });
      bridge.bind();

      eventBus._emit('modal:chat-open-requested', { chatId: 'x' });
    });

    it('handles proactive:open-chat', () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      bridge = new EventBusBridge({ eventBus, aether });
      bridge.bind();

      const payload = { initialMessage: 'hello', runId: '123' };
      eventBus._emit('proactive:open-chat', payload);

      expect(aether.ipc.send).toHaveBeenCalledWith('chat:proactive-context', {
        initialMessage: 'hello',
        runId: '123',
        isProactive: true,
      });
    });

    it('proactive:open-chat is no-op without aether.ipc', () => {
      const eventBus = createMockEventBus();
      bridge = new EventBusBridge({ eventBus, aether: {} });
      bridge.bind();

      eventBus._emit('proactive:open-chat', { initialMessage: 'hello' });
    });

    it('handles modal:artifact-edit-requested', () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      bridge = new EventBusBridge({ eventBus, aether });
      bridge.bind();

      eventBus._emit('modal:artifact-edit-requested', { artifactId: 'art-1' });
      expect(bridge.log.warn).toHaveBeenCalledWith(
        'Artifact edit not yet implemented',
        { artifactId: 'art-1' }
      );
    });

    it('modal:artifact-edit-requested is no-op without artifactId', () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      bridge = new EventBusBridge({ eventBus, aether });
      bridge.bind();

      eventBus._emit('modal:artifact-edit-requested', {});
      expect(bridge.log.warn).not.toHaveBeenCalledWith(
        'Artifact edit not yet implemented',
        expect.anything()
      );
    });

    it('handles modal:artifact-view-requested (html format)', async () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      const endpoint = createMockEndpoint();
      endpoint.getArtifact.mockResolvedValue({
        type: 'html',
        content: '<h1>Hello</h1>',
      });
      bridge = new EventBusBridge({ eventBus, aether, endpoint });
      bridge.bind();

      eventBus._emit('modal:artifact-view-requested', { artifactId: 'art-1' });
      await Promise.resolve();
      await Promise.resolve();

      expect(aether.ipc.send).toHaveBeenCalledWith('artifacts:switch-tab', 'output');
      expect(aether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', {
        output: '<h1>Hello</h1>',
        format: 'html',
      });
    });

    it('handles modal:artifact-view-requested (markdown format)', async () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      const endpoint = createMockEndpoint();
      endpoint.getArtifact.mockResolvedValue({
        type: 'markdown',
        content: '# Hello',
      });
      bridge = new EventBusBridge({ eventBus, aether, endpoint });
      bridge.bind();

      eventBus._emit('modal:artifact-view-requested', { artifactId: 'art-2' });
      await Promise.resolve();
      await Promise.resolve();

      expect(aether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', {
        output: '# Hello',
        format: 'markdown',
      });
    });

    it('handles modal:artifact-view-requested (json format)', async () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      const endpoint = createMockEndpoint();
      endpoint.getArtifact.mockResolvedValue({
        type: 'json',
        content: '{"key":"value"}',
      });
      bridge = new EventBusBridge({ eventBus, aether, endpoint });
      bridge.bind();

      eventBus._emit('modal:artifact-view-requested', { artifactId: 'art-3' });
      await Promise.resolve();
      await Promise.resolve();

      expect(aether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', {
        output: '{"key":"value"}',
        format: 'json',
      });
    });

    it('handles modal:artifact-view-requested (text format by default)', async () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      const endpoint = createMockEndpoint();
      endpoint.getArtifact.mockResolvedValue({
        type: 'code',
        content: 'console.log("hi")',
      });
      bridge = new EventBusBridge({ eventBus, aether, endpoint });
      bridge.bind();

      eventBus._emit('modal:artifact-view-requested', { artifactId: 'art-4' });
      await Promise.resolve();
      await Promise.resolve();

      expect(aether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', {
        output: 'console.log("hi")',
        format: 'text',
      });
    });

    it('detects html by content prefix when type is not html', async () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      const endpoint = createMockEndpoint();
      endpoint.getArtifact.mockResolvedValue({
        type: 'text',
        content: '<div>Hello</div>',
      });
      bridge = new EventBusBridge({ eventBus, aether, endpoint });
      bridge.bind();

      eventBus._emit('modal:artifact-view-requested', { artifactId: 'art-5' });
      await Promise.resolve();
      await Promise.resolve();

      expect(aether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', {
        output: '<div>Hello</div>',
        format: 'html',
      });
    });

    it('detects markdown by filename extension', async () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      const endpoint = createMockEndpoint();
      endpoint.getArtifact.mockResolvedValue({
        type: 'text',
        content: '# Hello',
        filename: 'readme.md',
      });
      bridge = new EventBusBridge({ eventBus, aether, endpoint });
      bridge.bind();

      eventBus._emit('modal:artifact-view-requested', { artifactId: 'art-6' });
      await Promise.resolve();
      await Promise.resolve();

      expect(aether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', {
        output: '# Hello',
        format: 'markdown',
      });
    });

    it('detects json by filename extension', async () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      const endpoint = createMockEndpoint();
      endpoint.getArtifact.mockResolvedValue({
        type: 'text',
        content: '{}',
        filename: 'data.json',
      });
      bridge = new EventBusBridge({ eventBus, aether, endpoint });
      bridge.bind();

      eventBus._emit('modal:artifact-view-requested', { artifactId: 'art-7' });
      await Promise.resolve();
      await Promise.resolve();

      expect(aether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', {
        output: '{}',
        format: 'json',
      });
    });

    it('handles artifact not found', async () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      const endpoint = createMockEndpoint();
      endpoint.getArtifact.mockResolvedValue(null);
      bridge = new EventBusBridge({ eventBus, aether, endpoint });
      bridge.bind();

      eventBus._emit('modal:artifact-view-requested', { artifactId: 'missing' });
      await Promise.resolve();
      await Promise.resolve();

      expect(bridge.log.error).toHaveBeenCalledWith('Artifact not found:', 'missing');
      expect(aether.ipc.send).not.toHaveBeenCalledWith('artifacts:ensure-visible');
    });

    it('handles artifact view error', async () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      const endpoint = createMockEndpoint();
      endpoint.getArtifact.mockRejectedValue(new Error('network'));
      bridge = new EventBusBridge({ eventBus, aether, endpoint });
      bridge.bind();

      eventBus._emit('modal:artifact-view-requested', { artifactId: 'art-err' });
      await Promise.resolve();
      await Promise.resolve();

      expect(bridge.log.error).toHaveBeenCalledWith('Failed to load artifact:', expect.any(Error));
    });

    it('artifact view is no-op without artifactId', () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      const endpoint = createMockEndpoint();
      bridge = new EventBusBridge({ eventBus, aether, endpoint });
      bridge.bind();

      eventBus._emit('modal:artifact-view-requested', {});
      expect(endpoint.getArtifact).not.toHaveBeenCalled();
    });

    it('artifact with empty content sends empty string', async () => {
      const eventBus = createMockEventBus();
      const aether = createMockAether();
      const endpoint = createMockEndpoint();
      endpoint.getArtifact.mockResolvedValue({ type: 'text', content: null });
      bridge = new EventBusBridge({ eventBus, aether, endpoint });
      bridge.bind();

      eventBus._emit('modal:artifact-view-requested', { artifactId: 'art-empty' });
      await Promise.resolve();
      await Promise.resolve();

      expect(aether.ipc.send).toHaveBeenCalledWith('artifacts:load-output', {
        output: '',
        format: 'text',
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _displayUiNotification()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_displayUiNotification()', () => {
    it('returns early when no message', () => {
      const elements = createElements();
      bridge = new EventBusBridge({ elements });

      bridge._displayUiNotification({});
      expect(elements.settingsStatus.textContent).toBe('');
      expect(Toast.info).not.toHaveBeenCalled();
    });

    it('updates status element text and class', () => {
      const elements = createElements();
      bridge = new EventBusBridge({ elements });

      bridge._displayUiNotification({ message: 'saved', type: 'success' });
      expect(elements.settingsStatus.textContent).toBe('saved');
      expect(elements.settingsStatus.className).toBe('status-message status-success');
    });

    it('defaults type to info', () => {
      const elements = createElements();
      bridge = new EventBusBridge({ elements });

      bridge._displayUiNotification({ message: 'note' });
      expect(elements.settingsStatus.className).toBe('status-message status-info');
      expect(Toast.info).toHaveBeenCalledWith('note', 3000);
    });

    it('defaults duration to 3000', () => {
      bridge = new EventBusBridge({ elements: createElements() });
      bridge._displayUiNotification({ message: 'test' });
      expect(Toast.info).toHaveBeenCalledWith('test', 3000);
    });

    it('accepts custom duration', () => {
      bridge = new EventBusBridge({ elements: createElements() });
      bridge._displayUiNotification({ message: 'test', duration: 5000 });
      expect(Toast.info).toHaveBeenCalledWith('test', 5000);
    });

    it('clears status after duration', () => {
      const elements = createElements();
      bridge = new EventBusBridge({ elements });

      bridge._displayUiNotification({ message: 'temp', duration: 2000 });
      expect(elements.settingsStatus.textContent).toBe('temp');

      jest.advanceTimersByTime(2000);
      expect(elements.settingsStatus.textContent).toBe('');
      expect(elements.settingsStatus.className).toBe('status-message');
    });

    it('does not set timeout when duration is 0', () => {
      const elements = createElements();
      bridge = new EventBusBridge({ elements });

      bridge._displayUiNotification({ message: 'persistent', duration: 0 });
      expect(elements.settingsStatus.textContent).toBe('persistent');

      jest.advanceTimersByTime(10000);
      // Still there
      expect(elements.settingsStatus.textContent).toBe('persistent');
    });

    it('clears previous timeout on new notification', () => {
      const elements = createElements();
      bridge = new EventBusBridge({ elements });

      bridge._displayUiNotification({ message: 'first', duration: 5000 });
      bridge._displayUiNotification({ message: 'second', duration: 3000 });

      expect(elements.settingsStatus.textContent).toBe('second');
      // After 3s, second notification clears
      jest.advanceTimersByTime(3000);
      expect(elements.settingsStatus.textContent).toBe('');
    });

    it('calls Toast.success for success type', () => {
      bridge = new EventBusBridge({ elements: {} });
      bridge._displayUiNotification({ message: 'ok', type: 'success', duration: 1000 });
      expect(Toast.success).toHaveBeenCalledWith('ok', 1000);
    });

    it('calls Toast.error for error type', () => {
      bridge = new EventBusBridge({ elements: {} });
      bridge._displayUiNotification({ message: 'fail', type: 'error' });
      expect(Toast.error).toHaveBeenCalledWith('fail', 3000);
    });

    it('calls Toast.warning for warning type', () => {
      bridge = new EventBusBridge({ elements: {} });
      bridge._displayUiNotification({ message: 'warn', type: 'warning' });
      expect(Toast.warning).toHaveBeenCalledWith('warn', 3000);
    });

    it('calls Toast.info for unknown type', () => {
      bridge = new EventBusBridge({ elements: {} });
      bridge._displayUiNotification({ message: 'note', type: 'custom' });
      expect(Toast.info).toHaveBeenCalledWith('note', 3000);
    });

    it('handles missing settingsStatus element', () => {
      bridge = new EventBusBridge({ elements: {} });
      bridge._displayUiNotification({ message: 'test', type: 'success' });
      // No crash, Toast still called
      expect(Toast.success).toHaveBeenCalled();
    });

    it('handles call with no arguments (default payload)', () => {
      bridge = new EventBusBridge({ elements: createElements() });
      // Should not crash, returns early since no message
      bridge._displayUiNotification();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // _updateConnectionIndicator()
  // ═══════════════════════════════════════════════════════════════════════

  describe('_updateConnectionIndicator()', () => {
    it('shows ONLINE when connected', () => {
      const elements = createElements();
      bridge = new EventBusBridge({ elements });

      bridge._updateConnectionIndicator({ connected: true, previous: true });
      expect(elements.connectionStatus.textContent).toBe('ONLINE');
    });

    it('shows OFFLINE when disconnected', () => {
      const elements = createElements();
      bridge = new EventBusBridge({ elements });

      bridge._updateConnectionIndicator({ connected: false, previous: false });
      expect(elements.connectionStatus.textContent).toBe('OFFLINE');
    });

    it('uses details.state when available', () => {
      const elements = createElements();
      bridge = new EventBusBridge({ elements });

      bridge._updateConnectionIndicator({
        connected: true,
        details: { state: 'reconnecting' },
      });
      expect(elements.connectionStatus.textContent).toBe('RECONNECTING');
    });

    it('shows toast on connection restored', () => {
      const elements = createElements();
      bridge = new EventBusBridge({ elements });

      bridge._updateConnectionIndicator({ connected: true, previous: false });
      expect(Toast.success).toHaveBeenCalledWith('Backend connection restored');
    });

    it('shows toast on connection lost', () => {
      const elements = createElements();
      bridge = new EventBusBridge({ elements });

      bridge._updateConnectionIndicator({ connected: false, previous: true });
      expect(Toast.error).toHaveBeenCalledWith('Backend connection lost. Check Docker services.');
    });

    it('shows toast for connected with no previous field (undefined is falsy)', () => {
      const elements = createElements();
      bridge = new EventBusBridge({ elements });

      // When previous is undefined, !undefined = true, so toast fires
      bridge._updateConnectionIndicator({ connected: true });
      expect(Toast.success).toHaveBeenCalledWith('Backend connection restored');
    });

    it('no toast for initial disconnected state (no previous)', () => {
      const elements = createElements();
      bridge = new EventBusBridge({ elements });

      bridge._updateConnectionIndicator({ connected: false });
      expect(Toast.error).not.toHaveBeenCalled();
    });

    it('returns early when no connectionStatus element', () => {
      bridge = new EventBusBridge({ elements: {} });
      // Should not crash
      bridge._updateConnectionIndicator({ connected: true });
    });

    it('handles call with no arguments (default data)', () => {
      const elements = createElements();
      bridge = new EventBusBridge({ elements });
      // Should not crash — data defaults to {}
      bridge._updateConnectionIndicator();
      expect(elements.connectionStatus.textContent).toBe('OFFLINE');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // unbind()
  // ═══════════════════════════════════════════════════════════════════════

  describe('unbind()', () => {
    it('calls all unsubscribe functions', () => {
      const eventBus = createMockEventBus();
      bridge = new EventBusBridge({ eventBus });
      bridge.bind();

      const cleanupCount = bridge._cleanup.length;
      expect(cleanupCount).toBeGreaterThan(0);

      bridge.unbind();
      expect(bridge._cleanup).toEqual([]);
    });

    it('clears status message timeout', () => {
      const elements = createElements();
      bridge = new EventBusBridge({ elements });
      bridge._displayUiNotification({ message: 'test', duration: 5000 });

      expect(bridge._statusMessageTimeout).not.toBeNull();
      bridge.unbind();
      expect(bridge._statusMessageTimeout).toBeNull();
    });

    it('handles non-function entries in cleanup gracefully', () => {
      bridge = new EventBusBridge();
      bridge._cleanup = [null, undefined, 'string', jest.fn()];

      expect(() => bridge.unbind()).not.toThrow();
      expect(bridge._cleanup).toEqual([]);
    });

    it('logs error when unsubscribe throws', () => {
      bridge = new EventBusBridge();
      bridge._cleanup = [
        () => { throw new Error('cleanup fail'); },
      ];

      bridge.unbind();
      expect(bridge.log.error).toHaveBeenCalledWith(
        'Failed to cleanup UI bridge listener:',
        expect.any(Error)
      );
    });

    it('is safe to call twice', () => {
      const eventBus = createMockEventBus();
      bridge = new EventBusBridge({ eventBus });
      bridge.bind();
      bridge.unbind();
      expect(() => bridge.unbind()).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // dispose()
  // ═══════════════════════════════════════════════════════════════════════

  describe('dispose()', () => {
    it('calls unbind and nulls references', () => {
      const eventBus = createMockEventBus();
      const elements = createElements();
      const aether = createMockAether();
      const endpoint = createMockEndpoint();
      const guru = createMockGuru();
      bridge = new EventBusBridge({ eventBus, elements, aether, endpoint, guru, callbacks: { openSettings: jest.fn() } });
      bridge.bind();

      bridge.dispose();

      expect(bridge.eventBus).toBeNull();
      expect(bridge.elements).toEqual({});
      expect(bridge.aether).toBeNull();
      expect(bridge.endpoint).toBeNull();
      expect(bridge.guru).toBeNull();
      expect(bridge.callbacks).toEqual({});
      expect(bridge._cleanup).toEqual([]);
    });

    it('is safe to call twice', () => {
      bridge = new EventBusBridge();
      bridge.dispose();
      expect(() => bridge.dispose()).not.toThrow();
    });

    // Quantitative: N unsubscribers created = M unsubscribers called
    it('lifecycle: N cleanup functions = M cleanup calls', () => {
      const eventBus = createMockEventBus();
      bridge = new EventBusBridge({ eventBus });
      bridge.bind();

      const cleanups = [...bridge._cleanup];
      const N = cleanups.length;
      expect(N).toBeGreaterThan(0);

      bridge.dispose();

      const M = cleanups.filter(fn => typeof fn === 'function' && fn.mock?.calls?.length > 0).length;
      expect(M).toBe(N);
    });
  });
});
