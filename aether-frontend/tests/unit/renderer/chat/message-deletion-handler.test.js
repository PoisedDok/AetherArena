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

const MessageDeletionHandler = require(
  '../../../../src/renderer/chat/controllers/modules/MessageDeletionHandler'
);

function createDom() {
  // Create a minimal DOM structure with user message, trail container, and assistant message
  document.body.innerHTML = `
    <div id="content">
      <div class="chat-entry message" data-message-id="msg-user-1" data-role="user">User msg</div>
      <div class="chat-entry artifact-execution-trail-container">Trail</div>
      <div class="chat-entry message" data-message-id="msg-asst-1" data-role="assistant">Assistant msg</div>
      <div class="chat-entry message" data-message-id="msg-user-2" data-role="user">User msg 2</div>
    </div>
  `;
  return document.getElementById('content');
}

describe('MessageDeletionHandler', () => {
  let handler;

  beforeEach(() => {
    handler = new MessageDeletionHandler();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });

  describe('handleMessageDeleted', () => {
    it('delegates deletion to messageState and messageView', () => {
      const messageState = { removeMessageSequence: jest.fn() };
      const messageView = { removeMessageSequence: jest.fn(() => true) };
      const chatWindow = { refreshContextDisplay: jest.fn() };
      const deps = { messageState, messageView, chatWindow };

      handler.handleMessageDeleted({
        chatId: 'chat-1',
        messageId: 'msg-user-1',
        deletedMessages: 2,
        deletedArtifacts: 0,
      }, deps);

      expect(messageState.removeMessageSequence).toHaveBeenCalledWith('msg-user-1');
      expect(messageView.removeMessageSequence).toHaveBeenCalledWith('msg-user-1');
      expect(chatWindow.refreshContextDisplay).toHaveBeenCalled();
    });

    it('refreshes context display after deletion', () => {
      const refreshContextDisplay = jest.fn();
      const deps = {
        messageView: { removeMessageSequence: jest.fn() },
        chatWindow: { refreshContextDisplay },
      };

      handler.handleMessageDeleted({ chatId: 'c', messageId: 'msg-user-1' }, deps);

      expect(refreshContextDisplay).toHaveBeenCalled();
    });

    it('handles missing messageView gracefully', () => {
      expect(() => handler.handleMessageDeleted(
        { chatId: 'c', messageId: 'm' },
        { chatWindow: {} }
      )).not.toThrow();
    });

    it('handles missing chatWindow gracefully', () => {
      expect(() => handler.handleMessageDeleted(
        { chatId: 'c', messageId: 'msg-user-1' },
        { messageView: { removeMessageSequence: jest.fn() } }
      )).not.toThrow();
    });

    it('does nothing when messageId not found in DOM', () => {
      const messageView = { removeMessageSequence: jest.fn(() => false) };
      const deps = { messageView, chatWindow: {} };

      handler.handleMessageDeleted({ chatId: 'c', messageId: 'nonexistent' }, deps);

      expect(messageView.removeMessageSequence).toHaveBeenCalledWith('nonexistent');
    });

    it('handles message with no following assistant message', () => {
      const messageState = { removeMessageSequence: jest.fn() };
      const messageView = { removeMessageSequence: jest.fn(() => true) };
      const deps = { messageState, messageView, chatWindow: {} };

      handler.handleMessageDeleted({ chatId: 'c', messageId: 'last-user' }, deps);

      expect(messageView.removeMessageSequence).toHaveBeenCalledWith('last-user');
    });
  });

  describe('handleArtifactDeleted', () => {
    it('logs artifact deletion without DOM changes', () => {
      expect(() => handler.handleArtifactDeleted({
        chatId: 'c1',
        artifactId: 'art-1',
      })).not.toThrow();
    });
  });

  describe('dispose', () => {
    it('does not throw', () => {
      expect(() => handler.dispose()).not.toThrow();
    });
  });
});
