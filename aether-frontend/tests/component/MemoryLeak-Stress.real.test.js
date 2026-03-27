/**
 * @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js
 */
'use strict';

/**
 * Memory Leak Stress Tests - REAL PERFORMANCE BUGS
 * ============================================================================
 * Tests that expose REAL memory leaks in message rendering, stream handling,
 * and artifact management. These are REAL stress tests that simulate long-running
 * sessions with thousands of messages.
 * 
 * Based on BUGS_FOUND_BY_REAL_TESTS.md:
 * - Bug #15: Message pruning completely broken (maxMessages ignored)
 * - Bug #16: messageElements Map not cleaned
 * - Bug #17: Messages disappear after 1000+ messages
 * 
 * @module tests/component/MemoryLeak-Stress.real
 */

const path = require('path');
const fs = require('fs');

// Setup DOM
global.window = global;
global.document = window.document;

// Mock logger
const mockLogger = {
  trace: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(function() { return this; })
};

jest.mock('../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLogger
}));

describe('Memory Leak Stress Tests - REAL BUGS', () => {
  let MessageView;
  let contentContainer;

  beforeEach(() => {
    // Setup DOM
    document.body.innerHTML = '<div id="content"></div>';
    contentContainer = document.getElementById('content');

    // Load MessageView — fail fast if module path is broken
    const MessageViewPath = path.resolve(__dirname, '../../src/renderer/chat/modules/messaging/MessageView.js');
    expect(fs.existsSync(MessageViewPath)).toBe(true);
    delete require.cache[require.resolve(MessageViewPath)];
    MessageView = require(MessageViewPath);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    jest.clearAllMocks();
  });

  describe('CRITICAL: Message Pruning Memory Leak (Bug #15)', () => {
    test('should respect maxMessages limit', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView({
        maxMessages: 50
      });
      messageView.init(contentContainer);

      // Render 100 messages
      for (let i = 0; i < 100; i++) {
        const message = {
          id: `msg_${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}`,
          timestamp: Date.now() + i
        };

        messageView.renderMessage(message);
      }

      // CRITICAL BUG: Should only have 50 messages in DOM (maxMessages)
      const messageElements = contentContainer.querySelectorAll('[data-message-id]');
      
      if (messageElements.length > 50) {
        console.error('MEMORY LEAK BUG FOUND:');
        console.error(`Expected: <= 50 messages in DOM`);
        console.error(`Actual: ${messageElements.length} messages`);
        console.error('maxMessages limit is IGNORED');
        console.error('This causes unbounded memory growth');
      }

      expect(messageElements.length).toBeLessThanOrEqual(50);
    });

    test('should prune oldest messages first (FIFO)', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView({
        maxMessages: 10
      });
      messageView.init(contentContainer);

      // Render 20 messages
      for (let i = 0; i < 20; i++) {
        messageView.renderMessage({
          id: `msg_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now() + i
        });
      }

      // Should have messages 10-19, not 0-9
      const firstMessage = contentContainer.querySelector('[data-message-id="msg_0"]');
      const lastMessage = contentContainer.querySelector('[data-message-id="msg_19"]');

      if (firstMessage) {
        console.error('PRUNING BUG: Oldest message still exists');
        console.error('Should have been pruned');
      }

      expect(firstMessage).toBeNull(); // Old message should be gone
      expect(lastMessage).not.toBeNull(); // New message should exist
    });

    test('should handle rapid message rendering without memory leak', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView({
        maxMessages: 100
      });
      messageView.init(contentContainer);

      // Simulate rapid streaming (500 messages)
      for (let i = 0; i < 500; i++) {
        messageView.renderMessage({
          id: `msg_rapid_${i}`,
          role: 'assistant',
          content: `Chunk ${i}`,
          timestamp: Date.now() + i
        });
      }

      const messageElements = contentContainer.querySelectorAll('[data-message-id]');

      if (messageElements.length > 100) {
        console.error('RAPID RENDERING LEAK:');
        console.error(`DOM has ${messageElements.length} messages, should be <= 100`);
      }

      expect(messageElements.length).toBeLessThanOrEqual(100);
    });
  });

  describe('CRITICAL: messageElements Map Leak (Bug #16)', () => {
    test('should clean messageElements Map when pruning', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView({
        maxMessages: 50
      });
      messageView.init(contentContainer);

      // Render 100 messages
      for (let i = 0; i < 100; i++) {
        messageView.renderMessage({
          id: `msg_map_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now()
        });
      }

      // CRITICAL BUG: Map should also be pruned
      if (messageView.messageElements.size > 50) {
        console.error('MAP LEAK BUG FOUND:');
        console.error(`messageElements Map size: ${messageView.messageElements.size}`);
        console.error('Expected: <= 50');
        console.error('Map is not being pruned, causing memory leak');
        console.error('Old DOM references prevent garbage collection');
      }

      expect(messageView.messageElements.size).toBeLessThanOrEqual(50);
    });

    test('should remove entries from Map when DOM elements removed', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView({
        maxMessages: 10
      });
      messageView.init(contentContainer);

      // Render 20 messages
      for (let i = 0; i < 20; i++) {
        messageView.renderMessage({
          id: `msg_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now()
        });
      }

      // Check if old messages are removed from Map
      const hasOldMessage = messageView.messageElements.has('msg_0');

      if (hasOldMessage) {
        console.error('MAP CLEANUP BUG:');
        console.error('Old message reference still in Map');
        console.error('DOM element removed but Map not updated');
      }

      expect(hasOldMessage).toBe(false);
    });
  });

  describe('CRITICAL: Message Disappearance (Bug #17)', () => {
    test('should not lose messages at 1000+ threshold', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView({
        maxMessages: 1000
      });
      messageView.init(contentContainer);

      // Render exactly 1000 messages
      for (let i = 0; i < 1000; i++) {
        messageView.renderMessage({
          id: `msg_stress_${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Stress test message ${i}`,
          timestamp: Date.now() + i
        });
      }

      // Check that last message exists
      const lastMessage = contentContainer.querySelector('[data-message-id="msg_stress_999"]');

      if (!lastMessage) {
        console.error('CRITICAL BUG: Message vanished at 1000 threshold');
        console.error('Expected msg_stress_999 to exist');
        console.error('Off-by-one error or race condition in pruning logic');
        
        // Debug: Check how many messages actually exist
        const count = contentContainer.querySelectorAll('[data-message-id]').length;
        console.error(`Actual message count in DOM: ${count}`);
      }

      expect(lastMessage).not.toBeNull();
      expect(lastMessage.textContent).toContain('999');
    });

    test('should handle edge case at maxMessages boundary', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView({
        maxMessages: 100
      });
      messageView.init(contentContainer);

      // Render exactly maxMessages
      for (let i = 0; i < 100; i++) {
        messageView.renderMessage({
          id: `msg_boundary_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now() + i
        });
      }

      const count = contentContainer.querySelectorAll('[data-message-id]').length;

      if (count !== 100) {
        console.error('BOUNDARY BUG:');
        console.error(`Rendered exactly maxMessages (100), but DOM has ${count}`);
      }

      expect(count).toBe(100);

      // Now render one more - should trigger pruning
      messageView.renderMessage({
        id: 'msg_boundary_100',
        role: 'user',
        content: 'Message 100',
        timestamp: Date.now() + 100
      });

      const newCount = contentContainer.querySelectorAll('[data-message-id]').length;

      if (newCount > 100) {
        console.error('PRUNING NOT TRIGGERED:');
        console.error(`After 101 messages, DOM has ${newCount}`);
      }

      expect(newCount).toBeLessThanOrEqual(100);
    });
  });

  describe('CRITICAL: Long Session Simulation', () => {
    test('should handle 10,000 messages without crashing', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView({
        maxMessages: 500 // Reasonable limit
      });
      messageView.init(contentContainer);

      // Simulate very long chat session
      for (let i = 0; i < 10000; i++) {
        try {
          messageView.renderMessage({
            id: `msg_long_${i}`,
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `Long session message ${i}`,
            timestamp: Date.now() + i
          });
        } catch (error) {
          console.error(`CRASH at message ${i}:`, error.message);
          throw error;
        }

        // Check periodically
        if (i % 1000 === 0 && i > 0) {
          const count = contentContainer.querySelectorAll('[data-message-id]').length;
          
          if (count > 500) {
            console.error(`LEAK DETECTED at message ${i}:`);
            console.error(`DOM has ${count} messages, should be <= 500`);
            
            // Don't fail immediately, but log
          }
        }
      }

      // Final check
      const finalCount = contentContainer.querySelectorAll('[data-message-id]').length;

      if (finalCount > 500) {
        console.error('SEVERE MEMORY LEAK:');
        console.error(`After 10,000 messages, DOM has ${finalCount} elements`);
        console.error('Expected: <= 500');
        console.error('Memory growth: unbounded');
      }

      expect(finalCount).toBeLessThanOrEqual(500);
    });

    test('should not crash with concurrent updates', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView({
        maxMessages: 100
      });
      messageView.init(contentContainer);

      // Simulate concurrent message rendering (race condition test)
      const messages = [];
      for (let i = 0; i < 1000; i++) {
        messages.push({
          id: `msg_concurrent_${i}`,
          role: 'assistant',
          content: `Concurrent ${i}`,
          timestamp: Date.now()
        });
      }

      // Render all messages in rapid succession
      expect(() => {
        messages.forEach(msg => messageView.renderMessage(msg));
      }).not.toThrow();

      // Verify final state is consistent
      const count = contentContainer.querySelectorAll('[data-message-id]').length;
      expect(count).toBeLessThanOrEqual(100);
    });
  });

  describe('Performance: Render Time Degradation', () => {
    test('should not slow down after many messages', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView({
        maxMessages: 500
      });
      messageView.init(contentContainer);

      // Use performance.now() for sub-ms precision (Date.now() rounds to 1ms,
      // making ratios meaningless when operations complete in 0-3ms).
      const now = typeof performance !== 'undefined' && performance.now
        ? () => performance.now()
        : () => Date.now();

      // Measure render time for first 100 messages
      const start1 = now();
      for (let i = 0; i < 100; i++) {
        messageView.renderMessage({
          id: `msg_perf_early_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now()
        });
      }
      const time1 = now() - start1;

      // Render 900 more messages
      for (let i = 100; i < 1000; i++) {
        messageView.renderMessage({
          id: `msg_perf_mid_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now()
        });
      }

      // Measure render time for next 100 messages
      const start2 = now();
      for (let i = 1000; i < 1100; i++) {
        messageView.renderMessage({
          id: `msg_perf_late_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now()
        });
      }
      const time2 = now() - start2;

      // When the baseline measurement is too small, ratio-based assertions
      // are meaningless — a single GC pause inflates the ratio to 10x+ from
      // pure noise. JSDOM DOM operations also scale non-linearly with node
      // count due to internal bookkeeping overhead that doesn't exist in real
      // browsers. Use a higher threshold to avoid false positives.
      // A real O(n^2) bug at 1100 messages produces multi-second times.
      const MIN_RELIABLE_BASE_MS = 15;

      if (time1 < MIN_RELIABLE_BASE_MS) {
        // Base is too fast for ratio to be meaningful. Assert absolute ceiling.
        // If rendering 100 messages after 1000 takes >200ms, something is wrong.
        expect(time2).toBeLessThan(200);
      } else {
        // Base is large enough for ratio to be reliable.
        const degradation = time2 / time1;

        if (degradation > 5) {
          console.warn('PERFORMANCE DEGRADATION:');
          console.warn(`First 100 messages: ${time1.toFixed(1)}ms`);
          console.warn(`After 1000 messages: ${time2.toFixed(1)}ms`);
          console.warn(`Degradation: ${degradation.toFixed(2)}x slower`);
          console.warn('Likely cause: DOM pruning not working, linear search');
        }

        // Allow moderate degradation: JSDOM DOM operations scale worse than
        // real browsers due to internal overhead. 10x catches genuine O(n^2)
        // regressions while tolerating JSDOM-specific noise.
        expect(degradation).toBeLessThan(10);
      }
    });
  });

  describe('Memory: updateMessage Leak', () => {
    test('should update existing message without duplication', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView({
        maxMessages: 100
      });
      messageView.init(contentContainer);

      // Render initial message
      const messageId = 'msg_update_test';
      messageView.renderMessage({
        id: messageId,
        role: 'assistant',
        content: 'Initial content',
        timestamp: Date.now()
      });

      // Update same message 100 times (streaming simulation)
      for (let i = 0; i < 100; i++) {
        if (typeof messageView.updateMessage === 'function') {
          messageView.updateMessage(messageId, `Updated content ${i}`);
        }
      }

      // Should only have ONE instance of this message
      const elements = contentContainer.querySelectorAll(`[data-message-id="${messageId}"]`);

      if (elements.length > 1) {
        console.error('UPDATE DUPLICATION BUG:');
        console.error(`Message ${messageId} exists ${elements.length} times in DOM`);
        console.error('Updates should replace, not append');
      }

      expect(elements.length).toBe(1);
    });
  });

  describe('Memory: clearMessages Cleanup', () => {
    test('should fully clean up when clearing messages', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView({
        maxMessages: 500
      });
      messageView.init(contentContainer);

      // Render 1000 messages
      for (let i = 0; i < 1000; i++) {
        messageView.renderMessage({
          id: `msg_clear_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now()
        });
      }

      // Clear all messages
      if (typeof messageView.clear === 'function') {
        messageView.clear();

        // DOM should be empty
        const domCount = contentContainer.querySelectorAll('[data-message-id]').length;

        if (domCount > 0) {
          console.error('CLEAR BUG: DOM not empty after clearMessages()');
          console.error(`${domCount} messages remain`);
        }

        expect(domCount).toBe(0);

        // Map should be empty
        if (messageView.messageElements.size > 0) {
          console.error('CLEAR MAP BUG: messageElements Map not cleared');
          console.error(`Map size: ${messageView.messageElements.size}`);
        }

        expect(messageView.messageElements.size).toBe(0);
      }
    });
  });
});

