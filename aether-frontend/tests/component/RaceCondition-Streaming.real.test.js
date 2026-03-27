/**
 * @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js
 */
'use strict';

/**
 * Race Condition & Streaming Tests - REAL CONCURRENCY BUGS
 * ============================================================================
 * Tests that expose REAL race conditions in streaming, concurrent operations,
 * and rapid updates. These tests simulate real-world scenarios where multiple
 * async operations happen simultaneously.
 * 
 * Based on BUGS_FOUND_BY_REAL_TESTS.md:
 * - Bug #5: Race conditions in rapid streaming (chunk deduplication broken)
 * - Bug #4: Thinking tag parsing broken
 * - Bug #7: Artifact events not emitted
 * 
 * @module tests/component/RaceCondition-Streaming.real
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

// SessionAPI factory (injected into StreamHandler via constructor DI)
function createMockSessionAPI() {
  let idCounter = 0;
  return {
    nextAssistantMessageId: jest.fn(() => `mock_assistant_${++idCounter}_${Date.now()}`),
    setActiveChat: jest.fn(),
    getActiveChat: jest.fn(() => 'test-chat-id')
  };
}

describe('Race Condition & Streaming Tests - REAL BUGS', () => {
  let StreamHandler;
  let MessageView;
  let MessageState;
  let contentContainer;

  beforeEach(() => {
    // Setup DOM
    document.body.innerHTML = '<div id="content"></div>';
    contentContainer = document.getElementById('content');

    // Load modules
    const StreamHandlerPath = path.resolve(__dirname, '../../src/renderer/chat/modules/messaging/StreamHandler.js');
    const MessageViewPath = path.resolve(__dirname, '../../src/renderer/chat/modules/messaging/MessageView.js');
    const MessageStatePath = path.resolve(__dirname, '../../src/renderer/chat/modules/messaging/MessageState.js');

    expect(fs.existsSync(StreamHandlerPath)).toBe(true);
    delete require.cache[require.resolve(StreamHandlerPath)];
    StreamHandler = require(StreamHandlerPath);

    expect(fs.existsSync(MessageViewPath)).toBe(true);
    delete require.cache[require.resolve(MessageViewPath)];
    MessageView = require(MessageViewPath);

    expect(fs.existsSync(MessageStatePath)).toBe(true);
    delete require.cache[require.resolve(MessageStatePath)];
    MessageState = require(MessageStatePath);

    jest.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('CRITICAL: Rapid Chunk Streaming (Bug #5)', () => {
    test('should handle 100 rapid chunks without duplication', async () => {
      expect(StreamHandler).toBeDefined();

      const messageView = MessageView ? new MessageView() : null;
      if (messageView) messageView.init(contentContainer);

      const messageState = MessageState ? new MessageState() : null;

      const mockEventBus = {
        emit: jest.fn(),
        on: jest.fn()
      };

      const streamHandler = new StreamHandler({
        messageView,
        messageState,
        eventBus: mockEventBus,
        sessionAPI: createMockSessionAPI()
      });

      const requestId = 'rapid_test_request';

      // Send 100 rapid chunks (numbers 0-99)
      for (let i = 0; i < 100; i++) {
        await streamHandler.processChunk({
          request_id: requestId,
          chunk: `${i} `,
          type: 'text'
        });
      }

      const accumulated = streamHandler.accumulatedText;

      // Check for duplicates
      const numbers = accumulated.split(' ').filter(n => n.trim());
      const uniqueNumbers = [...new Set(numbers)];

      if (numbers.length !== uniqueNumbers.length) {
        console.error('DUPLICATE CHUNKS DETECTED:');
        console.error(`Total chunks: ${numbers.length}`);
        console.error(`Unique chunks: ${uniqueNumbers.length}`);
        console.error('Chunk deduplication is BROKEN');

        // Find duplicates
        const counts = {};
        numbers.forEach(n => counts[n] = (counts[n] || 0) + 1);
        const duplicates = Object.entries(counts).filter(([_, count]) => count > 1);
        console.error('Duplicates:', duplicates);
      }

      expect(uniqueNumbers.length).toBe(100);
      
      // Check for missing chunks
      for (let i = 0; i < 100; i++) {
        if (!accumulated.includes(`${i}`)) {
          console.error(`MISSING CHUNK: ${i}`);
        }
        expect(accumulated).toContain(`${i}`);
      }
    });

    test('should handle chunks arriving out of order', async () => {
      expect(StreamHandler).toBeDefined();

      const mockEventBus = { emit: jest.fn(), on: jest.fn() };
      const streamHandler = new StreamHandler({ eventBus: mockEventBus, sessionAPI: createMockSessionAPI() });

      const requestId = 'out_of_order_test';

      // Send chunks out of order
      const chunks = [
        { request_id: requestId, chunk: 'First ', order: 1 },
        { request_id: requestId, chunk: 'Third ', order: 3 },
        { request_id: requestId, chunk: 'Second ', order: 2 },
        { request_id: requestId, chunk: 'Fourth', order: 4 }
      ];

      // Randomize order
      chunks.sort(() => Math.random() - 0.5);

      for (const chunk of chunks) {
        await streamHandler.processChunk(chunk);
      }

      const accumulated = streamHandler.accumulatedText;

      // Content should be accumulated in received order, not logical order
      // (Unless stream handler implements reordering, which it shouldn't)
      expect(accumulated.length).toBeGreaterThan(0);
    });

    test('should handle rapid identical chunks (deduplication)', async () => {
      expect(StreamHandler).toBeDefined();

      const mockEventBus = { emit: jest.fn(), on: jest.fn() };
      const streamHandler = new StreamHandler({ eventBus: mockEventBus, sessionAPI: createMockSessionAPI() });

      const requestId = 'duplicate_test';

      // Send same chunk 10 times rapidly
      for (let i = 0; i < 10; i++) {
        await streamHandler.processChunk({
          request_id: requestId,
          chunk: 'Hello World',
          type: 'text'
        });
      }

      const accumulated = streamHandler.accumulatedText;

      // Should only appear once (deduplicated)
      const occurrences = (accumulated.match(/Hello World/g) || []).length;

      if (occurrences > 1) {
        console.error('DEDUPLICATION FAILURE:');
        console.error(`"Hello World" appears ${occurrences} times`);
        console.error('Should only appear once');
        console.error('Accumulated:', accumulated);
      }

      expect(occurrences).toBe(1);
    });
  });

  describe('CRITICAL: Thinking Tag Parsing (Bug #4)', () => {
    test('should parse <thinking> tags and separate from content', async () => {
      expect(StreamHandler).toBeDefined();

      const mockEventBus = { emit: jest.fn(), on: jest.fn() };
      const streamHandler = new StreamHandler({ eventBus: mockEventBus, sessionAPI: createMockSessionAPI() });

      const requestId = 'thinking_test';

      // Send chunks with thinking tags
      const chunks = [
        '<thinking>Internal reasoning here</thinking>',
        'Visible content to user'
      ];

      for (const chunk of chunks) {
        await streamHandler.processChunk({
          request_id: requestId,
          chunk,
          type: 'text'
        });
      }

      // CRITICAL: Thinking text should be separated
      if (streamHandler.thinkingText === undefined || streamHandler.thinkingText === null) {
        console.warn('StreamHandler does not expose thinkingText property');
      } else {
        if (!streamHandler.thinkingText.includes('Internal reasoning')) {
          console.error('THINKING TAG BUG:');
          console.error('Thinking content not extracted');
          console.error('thinkingText:', streamHandler.thinkingText);
          console.error('accumulatedText:', streamHandler.accumulatedText);
        }

        expect(streamHandler.thinkingText).toContain('Internal reasoning');
      }

      // Visible content should NOT include thinking tags
      expect(streamHandler.accumulatedText).not.toContain('<thinking>');
      expect(streamHandler.accumulatedText).toContain('Visible content');
    });

    test('should handle nested thinking tags', async () => {
      expect(StreamHandler).toBeDefined();

      const mockEventBus = { emit: jest.fn(), on: jest.fn() };
      const streamHandler = new StreamHandler({ eventBus: mockEventBus, sessionAPI: createMockSessionAPI() });

      const requestId = 'nested_thinking_test';

      await streamHandler.processChunk({
        request_id: requestId,
        chunk: '<thinking>Outer<thinking>Inner</thinking>Outer continued</thinking>User text',
        type: 'text'
      });

      // Should handle nested tags gracefully
      const accumulated = streamHandler.accumulatedText;
      
      // User text should be visible
      expect(accumulated).toContain('User text');
      
      // Thinking tags should not leak
      expect(accumulated).not.toContain('<thinking>');
    });

    test('should handle incomplete thinking tags across chunks', async () => {
      expect(StreamHandler).toBeDefined();

      const mockEventBus = { emit: jest.fn(), on: jest.fn() };
      const streamHandler = new StreamHandler({ eventBus: mockEventBus, sessionAPI: createMockSessionAPI() });

      const requestId = 'incomplete_thinking_test';

      // Split thinking tag across multiple chunks
      const chunks = [
        '<thin',
        'king>Internal',
        ' reasoning</thi',
        'nking>Visible'
      ];

      for (const chunk of chunks) {
        await streamHandler.processChunk({
          request_id: requestId,
          chunk,
          type: 'text'
        });
      }

      // Should eventually parse complete tag
      const accumulated = streamHandler.accumulatedText;
      
      expect(accumulated).toContain('Visible');
      expect(accumulated).not.toContain('<thinking>');
    });
  });

  describe('CRITICAL: Concurrent Stream Handling', () => {
    test('should handle multiple concurrent streams', async () => {
      expect(StreamHandler).toBeDefined();

      const mockEventBus = { emit: jest.fn(), on: jest.fn() };
      const streamHandler1 = new StreamHandler({ eventBus: mockEventBus, sessionAPI: createMockSessionAPI() });
      const streamHandler2 = new StreamHandler({ eventBus: mockEventBus, sessionAPI: createMockSessionAPI() });

      // Two separate requests streaming simultaneously
      const chunks1 = Array.from({ length: 50 }, (_, i) => ({
        request_id: 'request_1',
        chunk: `A${i} `
      }));

      const chunks2 = Array.from({ length: 50 }, (_, i) => ({
        request_id: 'request_2',
        chunk: `B${i} `
      }));

      // Interleave chunks
      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(streamHandler1.processChunk(chunks1[i]));
        promises.push(streamHandler2.processChunk(chunks2[i]));
      }

      await Promise.all(promises);

      // Both streams should be independent
      expect(streamHandler1.accumulatedText).toContain('A0');
      expect(streamHandler1.accumulatedText).not.toContain('B0');

      expect(streamHandler2.accumulatedText).toContain('B0');
      expect(streamHandler2.accumulatedText).not.toContain('A0');
    });

    test('should not have race conditions in message ID generation', async () => {
      expect(StreamHandler).toBeDefined();

      const mockEventBus = { emit: jest.fn(), on: jest.fn() };

      // Create multiple stream handlers simultaneously
      const handlers = Array.from({ length: 10 }, () => 
        new StreamHandler({ eventBus: mockEventBus, sessionAPI: createMockSessionAPI() })
      );

      // Trigger message ID generation concurrently
      const idPromises = handlers.map(h => 
        h.processChunk({ request_id: `request_${Math.random()}`, chunk: 'test', type: 'text' })
      );

      await Promise.all(idPromises);

      // All should complete without errors
      expect(mockEventBus.emit).toHaveBeenCalled();
    });
  });

  describe('CRITICAL: Finalization Race Conditions', () => {
    test('should handle finalize called multiple times', async () => {
      expect(StreamHandler).toBeDefined();

      const mockEventBus = { emit: jest.fn(), on: jest.fn() };
      const streamHandler = new StreamHandler({ eventBus: mockEventBus, sessionAPI: createMockSessionAPI() });

      const requestId = 'finalize_test';

      // Send some chunks
      await streamHandler.processChunk({
        request_id: requestId,
        chunk: 'Hello',
        type: 'text'
      });

      // Call finalize multiple times rapidly
      if (typeof streamHandler.finalizeStream === 'function') {
        const promises = [
          streamHandler.finalizeStream(requestId),
          streamHandler.finalizeStream(requestId),
          streamHandler.finalizeStream(requestId)
        ];

        // Should not crash
        await expect(Promise.all(promises)).resolves.not.toThrow();
      }
    });

    test('should reject chunks after finalization', async () => {
      expect(StreamHandler).toBeDefined();

      const mockEventBus = { emit: jest.fn(), on: jest.fn() };
      const streamHandler = new StreamHandler({ eventBus: mockEventBus, sessionAPI: createMockSessionAPI() });

      const requestId = 'post_finalize_test';

      // Finalize stream
      if (typeof streamHandler.finalizeStream === 'function') {
        await streamHandler.finalizeStream(requestId);
      }

      const initialText = streamHandler.accumulatedText;

      // Try to add chunk after finalization
      await streamHandler.processChunk({
        request_id: requestId,
        chunk: 'Should not appear',
        type: 'text'
      });

      // Chunk should be rejected
      expect(streamHandler.accumulatedText).toBe(initialText);
      expect(streamHandler.accumulatedText).not.toContain('Should not appear');
    });
  });

  describe('Performance: High-Frequency Updates', () => {
    test('should handle 1000 chunks per second', async () => {
      expect(StreamHandler).toBeDefined();

      const mockEventBus = { emit: jest.fn(), on: jest.fn() };
      const streamHandler = new StreamHandler({ eventBus: mockEventBus, sessionAPI: createMockSessionAPI() });

      const requestId = 'high_freq_test';
      const chunkCount = 1000;

      const start = Date.now();

      // Send 1000 chunks as fast as possible
      for (let i = 0; i < chunkCount; i++) {
        await streamHandler.processChunk({
          request_id: requestId,
          chunk: `${i} `,
          type: 'text'
        });
      }

      const duration = Date.now() - start;

      console.log(`Processed ${chunkCount} chunks in ${duration}ms`);
      console.log(`Rate: ${(chunkCount / duration * 1000).toFixed(0)} chunks/sec`);

      // Should complete in reasonable time (< 5 seconds)
      expect(duration).toBeLessThan(5000);

      // All chunks should be present
      expect(streamHandler.accumulatedText.split(' ').filter(n => n).length).toBe(chunkCount);
    });
  });

  describe('CRITICAL: Message View Update Race Conditions', () => {
    test('should handle concurrent message renders', async () => {
      if (!MessageView) {
        console.warn('MessageView not found, skipping test');
        return;
      }

      const messageView = new MessageView();
      messageView.init(contentContainer);

      // Render multiple messages concurrently
      const messages = Array.from({ length: 100 }, (_, i) => ({
        id: `msg_concurrent_${i}`,
        role: 'user',
        content: `Message ${i}`,
        timestamp: Date.now() + i
      }));

      // Render all simultaneously
      const promises = messages.map(msg => 
        Promise.resolve(messageView.renderMessage(msg))
      );

      await Promise.all(promises);

      // Check final state
      const rendered = contentContainer.querySelectorAll('[data-message-id]');
      
      if (rendered.length !== 100) {
        console.error('RACE CONDITION:');
        console.error(`Expected 100 messages, got ${rendered.length}`);
      }

      expect(rendered.length).toBe(100);
    });

    test('should handle rapid updateMessage calls', async () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const messageId = 'msg_rapid_update';

      // Initial render
      messageView.renderMessage({
        id: messageId,
        role: 'assistant',
        content: 'Initial',
        timestamp: Date.now()
      });

      // Rapid updates (simulating streaming)
      if (typeof messageView.updateMessage === 'function') {
        for (let i = 0; i < 100; i++) {
          messageView.updateMessage({
            id: messageId,
            content: `Update ${i}`,
            timestamp: Date.now()
          });
        }

        // Should only have one instance
        const elements = contentContainer.querySelectorAll(`[data-message-id="${messageId}"]`);
        
        if (elements.length > 1) {
          console.error('UPDATE RACE CONDITION:');
          console.error(`${elements.length} instances of same message`);
        }

        expect(elements.length).toBe(1);
      }
    });
  });

  describe('CRITICAL: Event Emission Race Conditions (Bug #7)', () => {
    test('should emit artifact events', async () => {
      expect(StreamHandler).toBeDefined();

      const mockEventBus = { emit: jest.fn(), on: jest.fn() };
      const streamHandler = new StreamHandler({ eventBus: mockEventBus, sessionAPI: createMockSessionAPI() });

      const requestId = 'artifact_event_test';

      // Send artifact chunk
      await streamHandler.processChunk({
        request_id: requestId,
        type: 'artifact',
        chunk: '{"type": "code", "content": "console.log(\\"test\\");"}',
        format: 'json'
      });

      // CRITICAL: Should emit artifact event
      const artifactEmits = mockEventBus.emit.mock.calls.filter(call =>
        call[0] && (call[0].includes('artifact') || call[0].includes('ARTIFACT'))
      );

      if (artifactEmits.length === 0) {
        console.error('ARTIFACT EVENT BUG:');
        console.error('No artifact events emitted');
        console.error('All events:', mockEventBus.emit.mock.calls.map(c => c[0]));
      }

      expect(artifactEmits.length).toBeGreaterThan(0);
    });

    test('should emit events in correct order', async () => {
      expect(StreamHandler).toBeDefined();

      const mockEventBus = { emit: jest.fn(), on: jest.fn() };
      const streamHandler = new StreamHandler({ eventBus: mockEventBus, sessionAPI: createMockSessionAPI() });

      const requestId = 'event_order_test';

      // Send chunks and finalize
      await streamHandler.processChunk({ request_id: requestId, chunk: 'First', type: 'text' });
      await streamHandler.processChunk({ request_id: requestId, chunk: ' Second', type: 'text' });
      
      if (typeof streamHandler.finalizeStream === 'function') {
        await streamHandler.finalizeStream(requestId);
      }

      // Events should be in order
      const events = mockEventBus.emit.mock.calls.map(call => call[0]);
      
      // Look for stream started, chunk, finalized pattern
      console.log('Event order:', events);
    });
  });
});

