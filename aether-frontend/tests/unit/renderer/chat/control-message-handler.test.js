'use strict';

// ---------------------------------------------------------------------------
// Mocks — plain functions survive resetMocks: true
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

const ControlMessageHandler = require(
  '../../../../src/renderer/chat/modules/messaging/handlers/ControlMessageHandler'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStreamHandler() {
  return { forceFinalize: jest.fn().mockResolvedValue(undefined) };
}

function createMessageState(messages = []) {
  return { messages: [...messages] };
}

function createMessageView() {
  const elements = new Map();
  return {
    renderMessage: jest.fn(),
    getMessageElement: jest.fn().mockImplementation((id) => elements.get(id) || null),
    messageElements: elements,
  };
}

function createHandler(overrides = {}) {
  const streamHandler = createStreamHandler();
  const messageState = createMessageState();
  const messageView = createMessageView();
  const onProcessingChange = jest.fn();
  const onStopModeChange = jest.fn();

  const handler = new ControlMessageHandler({
    streamHandler,
    messageState,
    messageView,
    onProcessingChange,
    onStopModeChange,
    ...overrides,
  });

  return {
    handler,
    streamHandler,
    messageState,
    messageView,
    onProcessingChange,
    onStopModeChange,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ControlMessageHandler', () => {
  beforeEach(() => {
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    test('throws when streamHandler is not provided', () => {
      expect(() => new ControlMessageHandler({})).toThrow(
        '[ControlMessageHandler] streamHandler is REQUIRED'
      );
    });

    test('throws when streamHandler is null', () => {
      expect(() => new ControlMessageHandler({ streamHandler: null })).toThrow(
        '[ControlMessageHandler] streamHandler is REQUIRED'
      );
    });

    test('succeeds with only streamHandler (other deps optional)', () => {
      const handler = new ControlMessageHandler({
        streamHandler: createStreamHandler(),
      });
      expect(handler.streamHandler).toBeTruthy();
      expect(handler.messageState).toBeNull();
      expect(handler.messageView).toBeNull();
      expect(handler.onProcessingChange).toBeNull();
      expect(handler.onStopModeChange).toBeNull();
    });

    test('stores all provided dependencies', () => {
      const deps = {
        streamHandler: createStreamHandler(),
        messageState: createMessageState(),
        messageView: createMessageView(),
        onProcessingChange: jest.fn(),
        onStopModeChange: jest.fn(),
      };
      const handler = new ControlMessageHandler(deps);
      expect(handler.streamHandler).toBe(deps.streamHandler);
      expect(handler.messageState).toBe(deps.messageState);
      expect(handler.messageView).toBe(deps.messageView);
      expect(handler.onProcessingChange).toBe(deps.onProcessingChange);
      expect(handler.onStopModeChange).toBe(deps.onStopModeChange);
    });
  });

  // =========================================================================
  // handleControl — completion
  // =========================================================================
  describe('handleControl — completion', () => {
    test('calls _finalizeRequest on type=completion', async () => {
      const { handler, streamHandler, onProcessingChange, onStopModeChange } = createHandler();

      await handler.handleControl({ type: 'completion', id: 'msg-1' });

      expect(onProcessingChange).toHaveBeenCalledWith(false);
      expect(onStopModeChange).toHaveBeenCalledWith(false);
      expect(streamHandler.forceFinalize).toHaveBeenCalledTimes(1);
    });

    test('logs info with messageId', async () => {
      const { handler } = createHandler();

      await handler.handleControl({ type: 'completion', id: 'req-42' });

      expect(mockLog.info).toHaveBeenCalledWith(
        'Request completion received',
        { messageId: 'req-42' }
      );
    });
  });

  // =========================================================================
  // handleControl — stopped
  // =========================================================================
  describe('handleControl — stopped', () => {
    test('calls _finalizeRequest on type=stopped', async () => {
      const { handler, streamHandler, onProcessingChange, onStopModeChange } = createHandler();

      await handler.handleControl({ type: 'stopped', id: 'msg-1' });

      expect(onProcessingChange).toHaveBeenCalledWith(false);
      expect(onStopModeChange).toHaveBeenCalledWith(false);
      expect(streamHandler.forceFinalize).toHaveBeenCalledTimes(1);
    });

    test('logs info with messageId', async () => {
      const { handler } = createHandler();

      await handler.handleControl({ type: 'stopped', id: 'stop-1' });

      expect(mockLog.info).toHaveBeenCalledWith(
        'Request stop confirmation received',
        { messageId: 'stop-1' }
      );
    });
  });

  // =========================================================================
  // handleControl — system.error
  // =========================================================================
  describe('handleControl — system.error', () => {
    test('handles system.error: logs error, renders, finalizes', async () => {
      const { handler, messageView, streamHandler } = createHandler();
      const raw = { content: 'Something broke', error_details: { category: 'connection' } };

      await handler.handleControl({ type: 'system.error', raw });

      expect(mockLog.error).toHaveBeenCalledWith(
        'Backend system error received via WebSocket',
        raw
      );
      expect(messageView.renderMessage).toHaveBeenCalledTimes(1);
      expect(streamHandler.forceFinalize).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // handleControl — system.* (other)
  // =========================================================================
  describe('handleControl — system.* messages', () => {
    test('routes non-error system.* to _handleSystemMessage', async () => {
      const { handler, messageView, streamHandler } = createHandler();
      const raw = { type: 'system.info', content: 'Info message' };

      await handler.handleControl({ type: 'system.info', raw });

      expect(messageView.renderMessage).toHaveBeenCalledTimes(1);
      expect(streamHandler.forceFinalize).not.toHaveBeenCalled();
    });

    test('system.debug routes to _handleSystemMessage', async () => {
      const { handler, messageView } = createHandler();

      await handler.handleControl({ type: 'system.debug', raw: { content: 'debug data' } });

      expect(messageView.renderMessage).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // handleControl — role=system / type=system / type=info
  // =========================================================================
  describe('handleControl — system role and info', () => {
    test('role=system routes to _handleSystemMessage', async () => {
      const { handler, messageView } = createHandler();

      await handler.handleControl({ role: 'system', type: 'notification', raw: { content: 'sys msg' } });

      expect(messageView.renderMessage).toHaveBeenCalledTimes(1);
    });

    test('type=system routes to _handleSystemMessage', async () => {
      const { handler, messageView } = createHandler();

      await handler.handleControl({ type: 'system', raw: { content: 'sys msg' } });

      expect(messageView.renderMessage).toHaveBeenCalledTimes(1);
    });

    test('type=info routes to _handleSystemMessage', async () => {
      const { handler, messageView } = createHandler();

      await handler.handleControl({ type: 'info', raw: { content: 'info msg' } });

      expect(messageView.renderMessage).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // handleControl — error
  // =========================================================================
  describe('handleControl — error', () => {
    test('handles type=error: logs, renders, finalizes', async () => {
      const { handler, messageView, streamHandler } = createHandler();
      const raw = { content: 'Error occurred', error_details: { category: 'unknown' } };

      await handler.handleControl({ type: 'error', raw });

      expect(mockLog.error).toHaveBeenCalledWith(
        'Backend error received via WebSocket',
        raw
      );
      expect(messageView.renderMessage).toHaveBeenCalledTimes(1);
      expect(streamHandler.forceFinalize).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // handleControl — context_reset_ack
  // =========================================================================
  describe('handleControl — context_reset_ack', () => {
    test('logs trace and returns (no finalization)', async () => {
      const { handler, streamHandler } = createHandler();

      await handler.handleControl({ type: 'context_reset_ack', id: 'ctx-1' });

      expect(mockLog.trace).toHaveBeenCalledWith(
        'Context reset acknowledged by backend',
        { messageId: 'ctx-1' }
      );
      expect(streamHandler.forceFinalize).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleControl — path
  // =========================================================================
  describe('handleControl — path', () => {
    test('logs trace and returns (no finalization)', async () => {
      const { handler, streamHandler } = createHandler();

      await handler.handleControl({ type: 'path', id: 'path-1' });

      expect(mockLog.trace).toHaveBeenCalledWith(
        'Path information received from backend',
        { messageId: 'path-1' }
      );
      expect(streamHandler.forceFinalize).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleControl — user.message_persisted
  // =========================================================================
  describe('handleControl — user.message_persisted', () => {
    test('updates existing message in state by correlation_id', async () => {
      const existingMsg = { id: 'frontend-uuid', correlation_id: 'corr-1', role: 'user' };
      const customState = createMessageState([existingMsg]);
      const { handler } = createHandler({ messageState: customState });

      await handler.handleControl({
        type: 'user.message_persisted',
        messageId: 'backend-uuid-123',
        raw: { correlation_id: 'corr-1', chat_id: 'chat-1', sequence_in_chat: 5 },
      });

      expect(customState.messages[0].id).toBe('backend-uuid-123');
      expect(customState.messages[0].backend_id).toBe('backend-uuid-123');
      expect(customState.messages[0].sequence_in_chat).toBe(5);
    });

    test('updates DOM element for pre-existing messages', async () => {
      const existingMsg = { id: 'frontend-uuid', correlation_id: 'corr-1' };
      const messageView = createMessageView();
      const el = { dataset: {} };
      messageView.messageElements.set('frontend-uuid', el);
      messageView.getMessageElement.mockReturnValue(el);

      const { handler } = createHandler({
        messageState: createMessageState([existingMsg]),
        messageView,
      });

      await handler.handleControl({
        type: 'user.message_persisted',
        messageId: 'backend-uuid',
        raw: { correlation_id: 'corr-1', sequence_in_chat: 3 },
      });

      expect(el.dataset.messageId).toBe('backend-uuid');
      expect(el.dataset.backendId).toBe('backend-uuid');
      expect(el.dataset.sequence).toBe(3);
      expect(messageView.messageElements.has('backend-uuid')).toBe(true);
      expect(messageView.messageElements.has('frontend-uuid')).toBe(false);
    });

    test('creates handsfree message when not found and is_handsfree', async () => {
      const customView = createMessageView();
      const customState = createMessageState([]);
      const { handler } = createHandler({
        messageState: customState,
        messageView: customView,
      });

      await handler.handleControl({
        type: 'user.message_persisted',
        messageId: 'backend-uuid',
        raw: {
          correlation_id: 'hf-corr-1',
          content: 'Hey assistant',
          is_handsfree: true,
          chat_id: 'chat-1',
          sequence_in_chat: 7,
        },
      });

      expect(customState.messages).toHaveLength(1);
      expect(customState.messages[0]).toEqual(expect.objectContaining({
        id: 'backend-uuid',
        backend_id: 'backend-uuid',
        correlation_id: 'hf-corr-1',
        role: 'user',
        content: 'Hey assistant',
        chat_id: 'chat-1',
        sequence_in_chat: 7,
        isHandsfree: true,
      }));
      expect(customView.renderMessage).toHaveBeenCalledTimes(1);
    });

    test('warns when messageId is missing', async () => {
      const { handler } = createHandler();

      await handler.handleControl({
        type: 'user.message_persisted',
        messageId: null,
        raw: { correlation_id: 'corr-1' },
      });

      expect(mockLog.warn).toHaveBeenCalledWith(
        'Invalid user.message_persisted payload - missing messageId',
        expect.objectContaining({ messageId: null })
      );
    });

    test('warns when messageId is undefined', async () => {
      const { handler } = createHandler();

      await handler.handleControl({
        type: 'user.message_persisted',
        raw: { correlation_id: 'corr-1' },
      });

      expect(mockLog.warn).toHaveBeenCalledWith(
        'Invalid user.message_persisted payload - missing messageId',
        expect.objectContaining({ messageId: undefined })
      );
    });

    test('warns when message not found and not handsfree', async () => {
      const { handler } = createHandler({
        messageState: createMessageState([]),
      });

      await handler.handleControl({
        type: 'user.message_persisted',
        messageId: 'backend-uuid',
        raw: { correlation_id: 'unknown-corr' },
      });

      expect(mockLog.warn).toHaveBeenCalledWith(
        'Could not find message to update',
        { correlation_id: 'unknown-corr', hasContent: false }
      );
    });

    test('does NOT update DOM for handsfree messages', async () => {
      const messageView = createMessageView();
      const el = { dataset: {} };
      messageView.messageElements.set('hf-corr', el);
      messageView.getMessageElement.mockReturnValue(el);

      const { handler } = createHandler({
        messageState: createMessageState([]),
        messageView,
      });

      await handler.handleControl({
        type: 'user.message_persisted',
        messageId: 'backend-uuid',
        raw: { correlation_id: 'hf-corr', content: 'voice msg', is_handsfree: true },
      });

      // DOM update should NOT happen for handsfree (raw.is_handsfree)
      expect(el.dataset.messageId).toBeUndefined();
    });

    test('handles missing correlation_id (logs debug)', async () => {
      const { handler } = createHandler();

      await handler.handleControl({
        type: 'user.message_persisted',
        messageId: 'backend-uuid',
        raw: { sequence_in_chat: 1 },
      });

      expect(mockLog.debug).toHaveBeenCalledWith(
        'User message persisted (handsfree)',
        expect.objectContaining({ backendId: 'backend-uuid' })
      );
    });

    test('handles sequence_in_chat on DOM element', async () => {
      const existingMsg = { id: 'fe-uuid', correlation_id: 'corr-1' };
      const messageView = createMessageView();
      const el = { dataset: {} };
      messageView.messageElements.set('fe-uuid', el);
      messageView.getMessageElement.mockReturnValue(el);

      const { handler } = createHandler({
        messageState: createMessageState([existingMsg]),
        messageView,
      });

      await handler.handleControl({
        type: 'user.message_persisted',
        messageId: 'be-uuid',
        raw: { correlation_id: 'corr-1', sequence_in_chat: 10 },
      });

      expect(el.dataset.sequence).toBe(10);
    });

    test('skips DOM sequence update when sequence_in_chat is undefined', async () => {
      const existingMsg = { id: 'fe-uuid', correlation_id: 'corr-1' };
      const messageView = createMessageView();
      const el = { dataset: {} };
      messageView.messageElements.set('fe-uuid', el);
      messageView.getMessageElement.mockReturnValue(el);

      const { handler } = createHandler({
        messageState: createMessageState([existingMsg]),
        messageView,
      });

      await handler.handleControl({
        type: 'user.message_persisted',
        messageId: 'be-uuid',
        raw: { correlation_id: 'corr-1' },
      });

      expect(el.dataset.sequence).toBeUndefined();
    });
  });

  // =========================================================================
  // handleControl — unknown type
  // =========================================================================
  describe('handleControl — unknown type', () => {
    test('logs warn for unrecognized type', async () => {
      const { handler } = createHandler();

      await handler.handleControl({ type: 'unknown_type_xyz' });

      expect(mockLog.warn).toHaveBeenCalledWith(
        'Unknown control message type',
        { type: 'unknown_type_xyz' }
      );
    });
  });

  // =========================================================================
  // _handleErrorMessage()
  // =========================================================================
  describe('_handleErrorMessage', () => {
    test('extracts content as user message', async () => {
      const { handler, messageView } = createHandler();

      await handler._handleErrorMessage({
        raw: { content: 'Custom error content' },
      });

      const rendered = messageView.renderMessage.mock.calls[0][0];
      expect(rendered.content).toContain('Custom error content');
    });

    test('falls back to raw.message when content is missing', async () => {
      const { handler, messageView } = createHandler();

      await handler._handleErrorMessage({
        raw: { message: 'Fallback message' },
      });

      const rendered = messageView.renderMessage.mock.calls[0][0];
      expect(rendered.content).toContain('Fallback message');
    });

    test('falls back to raw.data.message', async () => {
      const { handler, messageView } = createHandler();

      await handler._handleErrorMessage({
        raw: { data: { message: 'Deep fallback' } },
      });

      const rendered = messageView.renderMessage.mock.calls[0][0];
      expect(rendered.content).toContain('Deep fallback');
    });

    test('uses default message when no content found', async () => {
      const { handler, messageView } = createHandler();

      await handler._handleErrorMessage({ raw: {} });

      const rendered = messageView.renderMessage.mock.calls[0][0];
      expect(rendered.content).toContain('An error occurred while processing your request.');
    });

    test('renders with role=system and type=error', async () => {
      const { handler, messageView } = createHandler();

      await handler._handleErrorMessage({
        raw: { content: 'err', error_details: { category: 'rate_limit' } },
      });

      const rendered = messageView.renderMessage.mock.calls[0][0];
      expect(rendered.role).toBe('system');
      expect(rendered.type).toBe('error');
      expect(rendered.error_category).toBe('rate_limit');
    });

    test('does not render when messageView is null', async () => {
      const handler = new ControlMessageHandler({
        streamHandler: createStreamHandler(),
      });

      // Should not throw
      await expect(handler._handleErrorMessage({ raw: {} })).resolves.toBeUndefined();
    });

    test('includes suggestions in formatted error', async () => {
      const { handler, messageView } = createHandler();

      await handler._handleErrorMessage({
        raw: {
          content: 'Rate limited',
          error_details: {
            category: 'rate_limit',
            suggestions: ['Wait 30 seconds', 'Try a different model'],
          },
        },
      });

      const content = messageView.renderMessage.mock.calls[0][0].content;
      expect(content).toContain('Wait 30 seconds');
      expect(content).toContain('Try a different model');
    });

    test('includes technical details in formatted error', async () => {
      const { handler, messageView } = createHandler();

      await handler._handleErrorMessage({
        raw: {
          content: 'Error',
          error_details: {
            category: 'model_error',
            technical_details: 'HTTP 503 from OpenAI',
          },
        },
      });

      const content = messageView.renderMessage.mock.calls[0][0].content;
      expect(content).toContain('HTTP 503 from OpenAI');
    });
  });

  // =========================================================================
  // _handleSystemMessage()
  // =========================================================================
  describe('_handleSystemMessage', () => {
    test('renders system message via messageView', async () => {
      const { handler, messageView } = createHandler();

      await handler._handleSystemMessage({
        raw: { type: 'system.info', content: 'System update' },
      });

      const rendered = messageView.renderMessage.mock.calls[0][0];
      expect(rendered.role).toBe('system');
      expect(rendered.type).toBe('system.info');
      expect(rendered.content).toBe('System update');
    });

    test('falls back to raw.message when content is missing', async () => {
      const { handler, messageView } = createHandler();

      await handler._handleSystemMessage({
        raw: { message: 'Fallback sys msg' },
      });

      const rendered = messageView.renderMessage.mock.calls[0][0];
      expect(rendered.content).toBe('Fallback sys msg');
    });

    test('falls back to default when no content or message', async () => {
      const { handler, messageView } = createHandler();

      await handler._handleSystemMessage({ raw: {} });

      const rendered = messageView.renderMessage.mock.calls[0][0];
      expect(rendered.content).toBe('System notification received.');
    });

    test('does not render when messageView is null', async () => {
      const handler = new ControlMessageHandler({
        streamHandler: createStreamHandler(),
      });

      await expect(handler._handleSystemMessage({ raw: {} })).resolves.toBeUndefined();
    });

    test('uses type "system" when raw.type is missing', async () => {
      const { handler, messageView } = createHandler();

      await handler._handleSystemMessage({ raw: { content: 'msg' } });

      expect(messageView.renderMessage.mock.calls[0][0].type).toBe('system');
    });
  });

  // =========================================================================
  // _formatErrorMessage()
  // =========================================================================
  describe('_formatErrorMessage', () => {
    test('includes user message', () => {
      const { handler } = createHandler();

      const result = handler._formatErrorMessage('Error text', 'unknown', null, []);

      expect(result).toContain('Error text');
    });

    test('includes category icon', () => {
      const { handler } = createHandler();

      const result = handler._formatErrorMessage('msg', 'rate_limit', null, []);

      expect(result).toContain('Provider Error');
    });

    test('includes technical details when provided', () => {
      const { handler } = createHandler();

      const result = handler._formatErrorMessage('msg', 'unknown', 'HTTP 500', []);

      expect(result).toContain('**Technical Details:** HTTP 500');
    });

    test('omits technical details when null', () => {
      const { handler } = createHandler();

      const result = handler._formatErrorMessage('msg', 'unknown', null, []);

      expect(result).not.toContain('Technical Details');
    });

    test('includes suggestions list', () => {
      const { handler } = createHandler();

      const result = handler._formatErrorMessage('msg', 'unknown', null, [
        'Try again',
        'Check your API key',
      ]);

      expect(result).toContain('**Suggestions:**');
      expect(result).toContain('- Try again');
      expect(result).toContain('- Check your API key');
    });

    test('omits suggestions when empty array', () => {
      const { handler } = createHandler();

      const result = handler._formatErrorMessage('msg', 'unknown', null, []);

      expect(result).not.toContain('Suggestions');
    });

    test('omits suggestions when null', () => {
      const { handler } = createHandler();

      const result = handler._formatErrorMessage('msg', 'unknown', null, null);

      expect(result).not.toContain('Suggestions');
    });
  });

  // =========================================================================
  // _getCategoryIcon()
  // =========================================================================
  describe('_getCategoryIcon', () => {
    const iconCases = [
      ['context_length', '📏'],
      ['authentication', '🔑'],
      ['rate_limit', '⏱️'],
      ['connection', '🔌'],
      ['model_error', '🤖'],
      ['invalid_request', '❌'],
      ['unknown', '⚠️'],
    ];

    test.each(iconCases)('returns correct icon for category "%s"', (category, expectedIcon) => {
      const { handler } = createHandler();
      expect(handler._getCategoryIcon(category)).toBe(expectedIcon);
    });

    test('returns unknown icon for unrecognized category', () => {
      const { handler } = createHandler();
      expect(handler._getCategoryIcon('something_else')).toBe('⚠️');
    });

    test('returns unknown icon for null category', () => {
      const { handler } = createHandler();
      expect(handler._getCategoryIcon(null)).toBe('⚠️');
    });
  });

  // =========================================================================
  // _finalizeRequest()
  // =========================================================================
  describe('_finalizeRequest', () => {
    test('calls onProcessingChange(false)', async () => {
      const { handler, onProcessingChange } = createHandler();

      await handler._finalizeRequest();

      expect(onProcessingChange).toHaveBeenCalledWith(false);
    });

    test('calls onStopModeChange(false)', async () => {
      const { handler, onStopModeChange } = createHandler();

      await handler._finalizeRequest();

      expect(onStopModeChange).toHaveBeenCalledWith(false);
    });

    test('calls streamHandler.forceFinalize', async () => {
      const { handler, streamHandler } = createHandler();

      await handler._finalizeRequest();

      expect(streamHandler.forceFinalize).toHaveBeenCalledTimes(1);
    });

    test('works when callbacks are null', async () => {
      const handler = new ControlMessageHandler({
        streamHandler: createStreamHandler(),
      });

      await expect(handler._finalizeRequest()).resolves.toBeUndefined();
    });

    test('works when streamHandler is null (after dispose)', async () => {
      const { handler } = createHandler();
      handler.streamHandler = null;

      await expect(handler._finalizeRequest()).resolves.toBeUndefined();
    });

    test('logs trace after finalization', async () => {
      const { handler } = createHandler();

      await handler._finalizeRequest();

      expect(mockLog.trace).toHaveBeenCalledWith('Request finalized');
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================
  describe('dispose', () => {
    test('nulls streamHandler', () => {
      const { handler } = createHandler();

      handler.dispose();

      expect(handler.streamHandler).toBeNull();
    });

    test('nulls callbacks', () => {
      const { handler } = createHandler();

      handler.dispose();

      expect(handler.onProcessingChange).toBeNull();
      expect(handler.onStopModeChange).toBeNull();
    });

    test('can be called multiple times', () => {
      const { handler } = createHandler();

      expect(() => {
        handler.dispose();
        handler.dispose();
      }).not.toThrow();
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================
  describe('module exports', () => {
    test('exports ControlMessageHandler constructor', () => {
      expect(typeof ControlMessageHandler).toBe('function');
    });

    test('instances have expected methods', () => {
      const { handler } = createHandler();
      expect(typeof handler.handleControl).toBe('function');
      expect(typeof handler.dispose).toBe('function');
    });
  });

  // =========================================================================
  // BUG REGRESSIONS (CMH-1, CMH-2)
  // =========================================================================
  describe('bug regressions', () => {
    test('[CMH-1] constructor initializes _isDisposed to false', () => {
      const { handler } = createHandler();
      expect(handler._isDisposed).toBe(false);
    });

    test('[CMH-1] handleControl is no-op after dispose', async () => {
      const { handler } = createHandler();
      handler.dispose();

      // Should not crash — streamHandler is null post-dispose
      await expect(handler.handleControl({
        type: 'completion', id: 'msg-1',
      })).resolves.toBeUndefined();
    });

    test('[CMH-1] handleControl ignores error type after dispose', async () => {
      const { handler } = createHandler();
      handler.dispose();

      await expect(handler.handleControl({
        type: 'error', id: 'msg-1', raw: { message: 'fail' },
      })).resolves.toBeUndefined();
    });

    test('[CMH-2] dispose nulls messageState and messageView', () => {
      const { handler } = createHandler();
      expect(handler.messageState).not.toBeNull();
      expect(handler.messageView).not.toBeNull();

      handler.dispose();
      expect(handler.messageState).toBeNull();
      expect(handler.messageView).toBeNull();
    });

    test('[CMH-1] dispose is idempotent (double-dispose safe)', () => {
      const { handler } = createHandler();
      handler.dispose();
      expect(() => handler.dispose()).not.toThrow();
      expect(handler._isDisposed).toBe(true);
    });
  });
});
