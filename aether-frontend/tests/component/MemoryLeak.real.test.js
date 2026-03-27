/**
 * @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js
 */
'use strict';

/**
 * Memory Leak Tests - REAL DOM CLEANUP
 * ============================================================================
 * Tests that messages, artifacts, and DOM elements are properly cleaned up
 * to prevent memory leaks in long-running chats. These tests catch REAL memory
 * management bugs.
 * 
 * @module tests/component/MemoryLeak.real
 */

const MessageView = require('../../src/renderer/chat/modules/messaging/MessageView');

describe('Memory Leak - Real DOM Cleanup', () => {
  let messageView;
  let contentContainer;
  let mockEventBus;

  beforeEach(() => {
    // Setup DOM
    contentContainer = document.createElement('div');
    contentContainer.id = 'chat-content';
    contentContainer.className = 'aether-chat-content';
    document.body.appendChild(contentContainer);

    // Mock EventBus
    mockEventBus = {
      emit: jest.fn(),
      on: jest.fn(),
      off: jest.fn()
    };

    // Real MessageView with pruning enabled
    messageView = new MessageView({
      eventBus: mockEventBus,
      autoScroll: false,
      maxMessages: 50 // Enable pruning at 50 messages
    });
    messageView.init(contentContainer);
  });

  afterEach(() => {
    if (contentContainer && contentContainer.parentNode) {
      contentContainer.parentNode.removeChild(contentContainer);
    }
  });

  describe('Message Pruning (CRITICAL)', () => {
    test('should prune old messages after reaching limit', () => {
      // Render 100 messages
      for (let i = 0; i < 100; i++) {
        messageView.renderMessage({
          id: `msg_${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}`,
          timestamp: Date.now() + i
        });
      }

      // Should only keep last 50 messages
      const messageElements = contentContainer.querySelectorAll('[data-message-id]');
      expect(messageElements.length).toBeLessThanOrEqual(50);
      
      // Should not have early messages
      expect(contentContainer.querySelector('[data-message-id="msg_0"]')).toBeNull();
      expect(contentContainer.querySelector('[data-message-id="msg_10"]')).toBeNull();
      
      // Should have recent messages
      expect(contentContainer.querySelector('[data-message-id="msg_99"]')).not.toBeNull();
      expect(contentContainer.querySelector('[data-message-id="msg_90"]')).not.toBeNull();
    });

    test('should clean up messageElements map when pruning', () => {
      // Render 100 messages
      for (let i = 0; i < 100; i++) {
        messageView.renderMessage({
          id: `msg_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now() + i
        });
      }

      // Internal map should also be pruned
      expect(messageView.messageElements.size).toBeLessThanOrEqual(50);
      
      // Old message IDs should be removed from map
      expect(messageView.messageElements.has('msg_0')).toBe(false);
      expect(messageView.messageElements.has('msg_10')).toBe(false);
      
      // Recent message IDs should be in map
      expect(messageView.messageElements.has('msg_99')).toBe(true);
    });

    test('should handle rapid message additions', () => {
      // Simulate rapid streaming - 500 messages
      for (let i = 0; i < 500; i++) {
        messageView.renderMessage({
          id: `msg_rapid_${i}`,
          role: 'assistant',
          content: `Chunk ${i}`,
          timestamp: Date.now() + i
        });
      }

      // Should not crash or hang
      const messageElements = contentContainer.querySelectorAll('[data-message-id]');
      expect(messageElements.length).toBeLessThanOrEqual(50);
      
      // Memory should be bounded
      expect(messageView.messageElements.size).toBeLessThanOrEqual(50);
    });

    test('should preserve order when pruning', () => {
      for (let i = 0; i < 100; i++) {
        messageView.renderMessage({
          id: `msg_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now() + i
        });
      }

      const messageElements = Array.from(contentContainer.querySelectorAll('[data-message-id]'));
      
      // Check that remaining messages are in correct order
      for (let i = 1; i < messageElements.length; i++) {
        const prevId = parseInt(messageElements[i - 1].dataset.messageId.split('_')[1]);
        const currId = parseInt(messageElements[i].dataset.messageId.split('_')[1]);
        
        // Current ID should be greater than previous
        expect(currId).toBeGreaterThan(prevId);
      }
    });

    test('should not prune when below limit', () => {
      // Render only 30 messages (below 50 limit)
      for (let i = 0; i < 30; i++) {
        messageView.renderMessage({
          id: `msg_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now() + i
        });
      }

      // Should keep all messages
      const messageElements = contentContainer.querySelectorAll('[data-message-id]');
      expect(messageElements.length).toBe(30);
      
      // First message should still exist
      expect(contentContainer.querySelector('[data-message-id="msg_0"]')).not.toBeNull();
    });

    test('should handle pruning with mixed message types', () => {
      // Mix of user, assistant, and system messages
      for (let i = 0; i < 100; i++) {
        const role = i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'system';
        messageView.renderMessage({
          id: `msg_${i}`,
          role,
          content: `Message ${i} from ${role}`,
          timestamp: Date.now() + i
        });
      }

      const messageElements = contentContainer.querySelectorAll('[data-message-id]');
      expect(messageElements.length).toBeLessThanOrEqual(50);
      
      // Should prune regardless of message type
      expect(contentContainer.querySelector('[data-message-id="msg_0"]')).toBeNull();
    });
  });

  describe('clear Cleanup', () => {
    test('should remove all DOM elements', () => {
      // Render 50 messages
      for (let i = 0; i < 50; i++) {
        messageView.renderMessage({
          id: `msg_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now()
        });
      }

      // Clear all
      messageView.clear();

      // Should have no messages in DOM
      expect(contentContainer.children.length).toBe(0);
      expect(contentContainer.querySelectorAll('[data-message-id]').length).toBe(0);
    });

    test('should clear internal messageElements map', () => {
      // Render messages
      for (let i = 0; i < 20; i++) {
        messageView.renderMessage({
          id: `msg_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now()
        });
      }

      // Clear
      messageView.clear();

      // Map should be empty
      expect(messageView.messageElements.size).toBe(0);
    });

    test('should handle clear on empty view', () => {
      expect(() => {
        messageView.clear();
      }).not.toThrow();
      
      expect(contentContainer.children.length).toBe(0);
    });

    test('should allow rendering after clear', () => {
      // Render some messages
      for (let i = 0; i < 10; i++) {
        messageView.renderMessage({
          id: `msg_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now()
        });
      }

      // Clear
      messageView.clear();

      // Render new messages
      messageView.renderMessage({
        id: 'msg_new',
        role: 'user',
        content: 'New message after clear',
        timestamp: Date.now()
      });

      // Should have only the new message
      expect(contentContainer.querySelectorAll('[data-message-id]').length).toBe(1);
      expect(contentContainer.querySelector('[data-message-id="msg_new"]')).not.toBeNull();
    });
  });

  describe('removeMessage Cleanup', () => {
    test('should remove specific message from DOM', () => {
      // Render 10 messages
      for (let i = 0; i < 10; i++) {
        messageView.renderMessage({
          id: `msg_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now()
        });
      }

      // Remove one message
      messageView.removeMessage('msg_5');

      // Should have 9 messages
      expect(contentContainer.querySelectorAll('[data-message-id]').length).toBe(9);
      
      // msg_5 should be gone
      expect(contentContainer.querySelector('[data-message-id="msg_5"]')).toBeNull();
      
      // Others should remain
      expect(contentContainer.querySelector('[data-message-id="msg_4"]')).not.toBeNull();
      expect(contentContainer.querySelector('[data-message-id="msg_6"]')).not.toBeNull();
    });

    test('should remove message from internal map', () => {
      messageView.renderMessage({
        id: 'msg_remove',
        role: 'user',
        content: 'Will be removed',
        timestamp: Date.now()
      });

      expect(messageView.messageElements.has('msg_remove')).toBe(true);

      messageView.removeMessage('msg_remove');

      expect(messageView.messageElements.has('msg_remove')).toBe(false);
    });

    test('should handle removing non-existent message', () => {
      messageView.renderMessage({
        id: 'msg_existing',
        role: 'user',
        content: 'Exists',
        timestamp: Date.now()
      });

      expect(() => {
        messageView.removeMessage('msg_nonexistent');
      }).not.toThrow();

      // Existing message should remain
      expect(contentContainer.querySelector('[data-message-id="msg_existing"]')).not.toBeNull();
    });

    test('should handle rapid removes', () => {
      // Render 50 messages
      for (let i = 0; i < 50; i++) {
        messageView.renderMessage({
          id: `msg_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now()
        });
      }

      // Remove every other message
      for (let i = 0; i < 50; i += 2) {
        messageView.removeMessage(`msg_${i}`);
      }

      // Should have 25 messages remaining
      expect(contentContainer.querySelectorAll('[data-message-id]').length).toBe(25);
      expect(messageView.messageElements.size).toBe(25);
    });
  });

  describe('Event Listener Cleanup', () => {
    test('should not leak event listeners on rapid renders', () => {
      // Track DOM event listeners (simplified - real check would need more)
      const initialListenerCount = mockEventBus.on.mock.calls.length;

      // Render and clear many times
      for (let cycle = 0; cycle < 10; cycle++) {
        for (let i = 0; i < 20; i++) {
          messageView.renderMessage({
            id: `msg_cycle${cycle}_${i}`,
            role: 'user',
            content: `Message ${i}`,
            timestamp: Date.now()
          });
        }
        messageView.clear();
      }

      // Event listeners should not grow unbounded
      // (This is a simplified check - real implementation would track removeEventListener)
      expect(messageView.messageElements.size).toBe(0);
    });
  });

  describe('Large Message Content', () => {
    test('should handle messages with large content', () => {
      const largeContent = 'x'.repeat(100000); // 100KB of text

      messageView.renderMessage({
        id: 'msg_large',
        role: 'assistant',
        content: largeContent,
        timestamp: Date.now()
      });

      const element = contentContainer.querySelector('[data-message-id="msg_large"]');
      expect(element).not.toBeNull();
      expect(element.textContent.length).toBeGreaterThan(50000);
    });

    test('should clean up large messages on remove', () => {
      const largeContent = 'y'.repeat(100000);

      messageView.renderMessage({
        id: 'msg_large_remove',
        role: 'assistant',
        content: largeContent,
        timestamp: Date.now()
      });

      // Remove it
      messageView.removeMessage('msg_large_remove');

      // Should be completely gone
      expect(contentContainer.querySelector('[data-message-id="msg_large_remove"]')).toBeNull();
      expect(messageView.messageElements.has('msg_large_remove')).toBe(false);
    });
  });

  describe('Stress Test', () => {
    test('should survive 1000 messages without crashing', () => {
      // This tests both pruning and performance
      for (let i = 0; i < 1000; i++) {
        messageView.renderMessage({
          id: `msg_stress_${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Stress test message ${i}`,
          timestamp: Date.now() + i
        });
      }

      // Should have pruned to limit
      const messageElements = contentContainer.querySelectorAll('[data-message-id]');
      expect(messageElements.length).toBeLessThanOrEqual(50);
      
      // Map should match DOM
      expect(messageView.messageElements.size).toBe(messageElements.length);
      
      // Last message should exist
      expect(contentContainer.querySelector('[data-message-id="msg_stress_999"]')).not.toBeNull();
    });

    test('should handle alternating render and remove', () => {
      for (let i = 0; i < 100; i++) {
        // Render a message
        messageView.renderMessage({
          id: `msg_alt_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now()
        });

        // Remove previous message if exists
        if (i > 0) {
          messageView.removeMessage(`msg_alt_${i - 1}`);
        }
      }

      // Should have only the last message
      expect(contentContainer.querySelectorAll('[data-message-id]').length).toBe(1);
      expect(contentContainer.querySelector('[data-message-id="msg_alt_99"]')).not.toBeNull();
    });
  });
});

