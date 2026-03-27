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

const { EventTypes } = require('../../../../src/core/events/EventTypes');
const StreamProcessor = require(
  '../../../../src/renderer/chat/controllers/modules/StreamProcessor'
);

function createEventBus() {
  return { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
}

function createProcessor(overrides = {}) {
  const eventBus = createEventBus();
  const chatWindow = { show: jest.fn() };
  const onProcessingComplete = jest.fn();
  const ipcSend = jest.fn();
  const aether = {
    ipc: { send: ipcSend },
    artifacts: { streamReady: jest.fn() },
  };

  const processor = new StreamProcessor({
    eventBus,
    aether: overrides.aether === null ? null : (overrides.aether || aether),
    getChatWindow: overrides.getChatWindow || (() => chatWindow),
    onProcessingComplete,
  });

  return { processor, eventBus, chatWindow, onProcessingComplete, aether, ipcSend };
}

describe('StreamProcessor', () => {
  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });

  // =========================================================================
  // constructor
  // =========================================================================

  describe('constructor', () => {
    it('throws when eventBus is not provided', () => {
      expect(() => new StreamProcessor({})).toThrow('eventBus is REQUIRED');
    });

    it('initializes currentStreamingMessageId to null', () => {
      const { processor } = createProcessor();
      expect(processor.currentStreamingMessageId).toBeNull();
    });
  });

  // =========================================================================
  // handleAssistantStream
  // =========================================================================

  describe('handleAssistantStream', () => {
    it('emits enriched payload with messageId from payload.messageId', () => {
      const { processor, eventBus } = createProcessor();

      processor.handleAssistantStream({ messageId: 'msg-1', content: 'hello' });

      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.ASSISTANT_STREAM,
        expect.objectContaining({ messageId: 'msg-1', content: 'hello' })
      );
      expect(processor.currentStreamingMessageId).toBe('msg-1');
    });

    it('falls back to requestId when messageId is absent', () => {
      const { processor, eventBus } = createProcessor();

      processor.handleAssistantStream({ requestId: 'req-1', content: 'data' });

      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.ASSISTANT_STREAM,
        expect.objectContaining({ messageId: 'req-1' })
      );
    });

    it('falls back to correlationId', () => {
      const { processor, eventBus } = createProcessor();

      processor.handleAssistantStream({ correlationId: 'cor-1' });

      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.ASSISTANT_STREAM,
        expect.objectContaining({ messageId: 'cor-1' })
      );
    });

    it('uses previously stored messageId when payload has none', () => {
      const { processor, eventBus } = createProcessor();

      // First call sets messageId
      processor.handleAssistantStream({ messageId: 'msg-prev', content: 'a' });
      // Second call has no messageId
      processor.handleAssistantStream({ content: 'b' });

      const secondCall = eventBus.emit.mock.calls[1];
      expect(secondCall[1].messageId).toBe('msg-prev');
    });

    it('ignores null payload', () => {
      const { processor, eventBus } = createProcessor();
      processor.handleAssistantStream(null);
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalled();
    });

    it('ignores non-object payload', () => {
      const { processor, eventBus } = createProcessor();
      processor.handleAssistantStream('string');
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // handleRequestComplete
  // =========================================================================

  describe('handleRequestComplete', () => {
    it('resets currentStreamingMessageId and calls onProcessingComplete', () => {
      const { processor, onProcessingComplete, eventBus } = createProcessor();
      processor.currentStreamingMessageId = 'msg-active';

      processor.handleRequestComplete({ status: 'done' });

      expect(processor.currentStreamingMessageId).toBeNull();
      expect(onProcessingComplete).toHaveBeenCalled();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.REQUEST_COMPLETE,
        expect.objectContaining({ status: 'done', timestamp: expect.any(Number) })
      );
    });

    it('preserves all original data fields in emitted payload', () => {
      const { processor, eventBus } = createProcessor();

      processor.handleRequestComplete({ status: 'done', requestId: 'req-1', usage: { tokens: 100 } });

      const emitted = eventBus.emit.mock.calls[0][1];
      expect(emitted.status).toBe('done');
      expect(emitted.requestId).toBe('req-1');
      expect(emitted.usage).toEqual({ tokens: 100 });
      expect(typeof emitted.timestamp).toBe('number');
    });
  });

  // =========================================================================
  // handleEnsureVisible
  // =========================================================================

  describe('handleEnsureVisible', () => {
    it('shows chat window and emits WINDOW_OPENED', () => {
      const { processor, chatWindow, eventBus } = createProcessor();

      processor.handleEnsureVisible();

      expect(chatWindow.show).toHaveBeenCalled();
      expect(eventBus.emit).toHaveBeenCalledWith(
        EventTypes.CHAT.WINDOW_OPENED,
        expect.objectContaining({ window: 'chat' })
      );
    });

    it('does not crash when chatWindow is null', () => {
      const { processor } = createProcessor({ getChatWindow: () => null });
      expect(() => processor.handleEnsureVisible()).not.toThrow();
    });
  });

  // =========================================================================
  // handleArtifactStream
  // =========================================================================

  describe('handleArtifactStream', () => {
    it('forwards data.data to artifacts window via aether.artifacts.streamReady', () => {
      const { processor, aether } = createProcessor();

      processor.handleArtifactStream({ data: { id: 'art-1', content: 'chunk' } });

      expect(aether.artifacts.streamReady).toHaveBeenCalledWith({ id: 'art-1', content: 'chunk' });
    });

    it('forwards raw data when no .data property exists', () => {
      const { processor, aether } = createProcessor();

      processor.handleArtifactStream({ id: 'art-2', content: 'raw-chunk' });

      // data?.data is undefined → falls back to data itself
      expect(aether.artifacts.streamReady).toHaveBeenCalledWith({ id: 'art-2', content: 'raw-chunk' });
    });

    it('logs error when artifacts API is unavailable', () => {
      const { processor } = createProcessor({ aether: {} });
      processor.handleArtifactStream({ data: {} });
      expect(mockLog.error).toHaveBeenCalledWith('Artifacts window API unavailable');
    });
  });

  // =========================================================================
  // handleTrailNodeClicked
  // =========================================================================

  describe('handleTrailNodeClicked', () => {
    it('sends IPC show-artifact for write phase', () => {
      const { processor, ipcSend } = createProcessor();

      processor.handleTrailNodeClicked({ artifactId: 'art-1', phase: 'write' });

      expect(ipcSend).toHaveBeenCalledWith('artifacts:show-artifact', { artifactId: 'art-1', tab: 'code' });
    });

    it('maps execute phase to output tab', () => {
      const { processor, ipcSend } = createProcessor();
      processor.handleTrailNodeClicked({ artifactId: 'art-1', phase: 'execute' });
      expect(ipcSend).toHaveBeenCalledWith('artifacts:show-artifact', { artifactId: 'art-1', tab: 'output' });
    });

    it('maps output phase to output tab', () => {
      const { processor, ipcSend } = createProcessor();
      processor.handleTrailNodeClicked({ artifactId: 'art-1', phase: 'output' });
      expect(ipcSend).toHaveBeenCalledWith('artifacts:show-artifact', { artifactId: 'art-1', tab: 'output' });
    });

    it('uses artifactType=code to determine tab when phase is unknown', () => {
      const { processor, ipcSend } = createProcessor();
      processor.handleTrailNodeClicked({ artifactId: 'art-1', phase: 'unknown', artifactType: 'code' });
      expect(ipcSend).toHaveBeenCalledWith('artifacts:show-artifact', { artifactId: 'art-1', tab: 'code' });
    });

    it('defaults to output tab when phase and artifactType are unknown', () => {
      const { processor, ipcSend } = createProcessor();
      processor.handleTrailNodeClicked({ artifactId: 'art-1' });
      expect(ipcSend).toHaveBeenCalledWith('artifacts:show-artifact', { artifactId: 'art-1', tab: 'output' });
    });

    it('ignores empty artifactId', () => {
      const { processor, ipcSend } = createProcessor();
      processor.handleTrailNodeClicked({ artifactId: '' });
      expect(ipcSend).not.toHaveBeenCalled();
    });

    it('ignores whitespace-only artifactId', () => {
      const { processor, ipcSend } = createProcessor();
      processor.handleTrailNodeClicked({ artifactId: '   ' });
      expect(ipcSend).not.toHaveBeenCalled();
    });

    it('trims artifactId', () => {
      const { processor, ipcSend } = createProcessor();
      processor.handleTrailNodeClicked({ artifactId: '  art-trimmed  ', phase: 'write' });
      expect(ipcSend).toHaveBeenCalledWith('artifacts:show-artifact', { artifactId: 'art-trimmed', tab: 'code' });
    });

    it('warns when IPC is unavailable', () => {
      const { processor } = createProcessor({ aether: {} });
      processor.handleTrailNodeClicked({ artifactId: 'art-1' });
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('IPC unavailable'),
        expect.any(Object)
      );
    });
  });

  // =========================================================================
  // resetStreamState
  // =========================================================================

  describe('resetStreamState', () => {
    it('resets currentStreamingMessageId', () => {
      const { processor } = createProcessor();
      processor.currentStreamingMessageId = 'active';
      processor.resetStreamState();
      expect(processor.currentStreamingMessageId).toBeNull();
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('nulls all references', () => {
      const { processor } = createProcessor();
      processor.dispose();
      expect(processor.currentStreamingMessageId).toBeNull();
      expect(processor.eventBus).toBeNull();
      expect(processor.aether).toBeNull();
      expect(processor.getChatWindow).toBeNull();
      expect(processor.onProcessingComplete).toBeNull();
    });
  });
});
