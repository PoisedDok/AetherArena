'use strict';

const mockLog = {
  info: () => {},
  warn: jest.fn(),
  error: jest.fn(),
  debug: () => {},
  trace: () => {},
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const ProactiveContextHandler = require(
  '../../../../src/renderer/chat/controllers/modules/ProactiveContextHandler'
);

function createHandler(overrides = {}) {
  const eventBus = { emit: jest.fn() };
  const handler = new ProactiveContextHandler({
    eventBus: overrides.eventBus || eventBus,
  });

  const savedMessage = { id: 'msg-saved', content: 'test' };
  const messageState = {
    saveMessage: jest.fn().mockResolvedValue(savedMessage),
    currentChatId: 'new-chat-id'
  };
  const messageView = { renderMessage: jest.fn(), clear: jest.fn() };
  const ipc = { send: jest.fn() };
  const messageOrchestrator = {
    createChat: jest.fn().mockResolvedValue('new-chat-id'),
    messageState,
    messageView,
    ipc
  };

  const deps = {
    initialized: true,
    modules: { messageOrchestrator },
    onQueue: jest.fn(),
  };

  return { handler, eventBus, deps, messageOrchestrator, messageState, messageView, savedMessage };
}

describe('ProactiveContextHandler', () => {
  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });

  describe('handle', () => {
    it('creates new chat with seed messages', async () => {
      const { handler, deps, messageOrchestrator, eventBus } = createHandler();

      await handler.handle({ initialMessage: 'You should check your email' }, deps);

      expect(messageOrchestrator.createChat).toHaveBeenCalledWith(
        'You should check your email',
        expect.objectContaining({
          seedMessages: expect.arrayContaining([
            expect.objectContaining({
              role: 'system',
              metadata: expect.objectContaining({ source: 'proactive_seed', hidden: true })
            }),
            expect.objectContaining({
              role: 'assistant',
              content: 'You should check your email',
              metadata: expect.objectContaining({ source: 'proactive', run_id: undefined })
            })
          ])
        })
      );
      expect(eventBus.emit).toHaveBeenCalledWith('chat:switched', { chatId: 'new-chat-id' });
    });

    it('queues when not initialized', async () => {
      const { handler, deps } = createHandler();
      deps.initialized = false;

      await handler.handle({ initialMessage: 'test' }, deps);

      expect(deps.onQueue).toHaveBeenCalledWith({ initialMessage: 'test' });
    });

    it('returns when initialMessage is missing', async () => {
      const { handler, deps, messageOrchestrator } = createHandler();

      await handler.handle({}, deps);

      expect(messageOrchestrator.createChat).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith('Proactive context called without initialMessage');
    });

    it('returns when data is null', async () => {
      const { handler, deps, messageOrchestrator } = createHandler();

      await handler.handle(null, deps);

      expect(messageOrchestrator.createChat).not.toHaveBeenCalled();
    });

    it('returns when required modules are missing', async () => {
      const { handler } = createHandler();
      const deps = { initialized: true, modules: {} };

      await handler.handle({ initialMessage: 'test' }, deps);

      expect(mockLog.error).toHaveBeenCalledWith('Required modules not available', expect.any(Object));
    });

    it('logs error when createChat fails', async () => {
      const { handler, deps, messageOrchestrator } = createHandler();
      messageOrchestrator.createChat.mockResolvedValue(null);

      await handler.handle({ initialMessage: 'test' }, deps);

      expect(mockLog.error).toHaveBeenCalledWith('Failed to hydrate proactive context', expect.objectContaining({
        error: expect.any(Error)
      }));
    });
  });

  describe('_buildMessageContent', () => {
    it('returns plain message when no context', () => {
      const { handler } = createHandler();
      expect(handler._buildMessageContent('Hello', null)).toBe('Hello');
    });

    it('ignores context payload and keeps recommendation text unchanged', () => {
      const { handler } = createHandler();
      const result = handler._buildMessageContent('Hello', {
        sources: [{ type: 'email', subject: 'Test', from: 'a@b.com' }],
        queries: ['q1'],
      });
      expect(result).toBe('Hello');
    });

    it('returns empty string for non-string initialMessage', () => {
      const { handler } = createHandler();
      expect(handler._buildMessageContent(undefined, { sources: [] })).toBe('');
      expect(handler._buildMessageContent(null, { queries: ['q1'] })).toBe('');
      expect(handler._buildMessageContent({ text: 'x' }, null)).toBe('');
    });
  });

  describe('dispose', () => {
    it('nulls eventBus', () => {
      const { handler } = createHandler();
      handler.dispose();
      expect(handler.eventBus).toBeNull();
    });
  });
});
