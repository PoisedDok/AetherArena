/**
 * @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js
 */
'use strict';

/**
 * StreamHandler Component Tests - REAL STREAMING LOGIC
 * ============================================================================
 * Tests actual message streaming with chunk deduplication, partial updates,
 * thinking tag parsing, and race condition handling.
 * 
 * These tests catch REAL bugs in streaming infrastructure.
 * 
 * @module tests/component/StreamHandler.real
 */

const StreamHandler = require('../../src/renderer/chat/modules/messaging/StreamHandler');
const MessageView = require('../../src/renderer/chat/modules/messaging/MessageView');
const MessageState = require('../../src/renderer/chat/modules/messaging/MessageState');
const MarkdownRenderer = require('../../src/renderer/shared/messaging/MarkdownRenderer');
const SecuritySanitizer = require('../../src/renderer/shared/security/SecuritySanitizer');

describe('StreamHandler - Real Streaming Logic', () => {
  let streamHandler;
  let messageView;
  let messageState;
  let container;
  let mockEventBus;

  beforeEach(() => {
    // Create real DOM
    container = document.createElement('div');
    container.className = 'aether-chat-content';
    document.body.appendChild(container);

    // Mock EventBus
    mockEventBus = {
      emit: jest.fn(),
      on: jest.fn(),
      off: jest.fn()
    };

    // Real MessageView
    messageView = new MessageView({
      markdownRenderer: new MarkdownRenderer(),
      securitySanitizer: new SecuritySanitizer(),
      autoScroll: true
    });
    messageView.init(container);

    // Real MessageState
    messageState = new MessageState();

    // SessionAPI mock (StreamHandler requires sessionAPI.nextAssistantMessageId via DI)
    const mockSessionAPI = {
      nextAssistantMessageId: jest.fn(() => `msg_assistant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      setActiveChat: jest.fn(),
      getActiveChat: jest.fn(() => 'test-chat-id')
    };

    // Real StreamHandler with DI-injected sessionAPI
    streamHandler = new StreamHandler({
      messageView,
      messageState,
      eventBus: mockEventBus,
      sessionAPI: mockSessionAPI
    });

    streamHandler.init();
  });

  afterEach(() => {
    if (streamHandler && typeof streamHandler.dispose === 'function') {
      streamHandler.dispose();
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
  });

  describe('Chunk Processing', () => {
    test('should process first chunk and create message', async () => {
      const chunk = {
        request_id: 'req_001',
        chunk: 'Hello ',
        type: 'assistant-stream'
      };

      const processed = await streamHandler.processChunk(chunk);

      expect(processed).toBe(true);
      expect(streamHandler.accumulatedText).toBe('Hello ');
      streamHandler._flushViewUpdate();
      expect(container.textContent).toContain('Hello');
    });

    test('should accumulate multiple chunks', async () => {
      const chunks = [
        { request_id: 'req_002', chunk: 'The ' },
        { request_id: 'req_002', chunk: 'quick ' },
        { request_id: 'req_002', chunk: 'brown ' },
        { request_id: 'req_002', chunk: 'fox' }
      ];

      for (const chunk of chunks) {
        await streamHandler.processChunk(chunk);
      }

      expect(streamHandler.accumulatedText).toBe('The quick brown fox');
      streamHandler._flushViewUpdate();
      expect(container.textContent).toContain('The quick brown fox');
    });

    test('should deduplicate identical chunks arriving rapidly', async () => {
      // Simulate network sending duplicate chunks
      const chunk = {
        request_id: 'req_003',
        chunk: 'Duplicate '
      };

      await streamHandler.processChunk(chunk);
      await streamHandler.processChunk(chunk); // Duplicate
      await streamHandler.processChunk(chunk); // Duplicate

      // Should only process once
      expect(streamHandler.accumulatedText).toBe('Duplicate ');
      
      // Flush RAF-coalesced view update before DOM assertion
      streamHandler._flushViewUpdate();
      
      // Count occurrences in DOM
      const text = container.textContent;
      const count = (text.match(/Duplicate/g) || []).length;
      expect(count).toBe(1);
    });

    test('should reject chunk with camelCase requestId (contract enforcement)', async () => {
      const chunk = {
        requestId: 'req_alt_001',
        chunk: 'Alternative ID format',
        type: 'assistant-stream'
      };

      await expect(streamHandler.processChunk(chunk)).rejects.toThrow('request_id');
    });

    test('should reject chunk without request_id', async () => {
      const chunk = {
        // No request_id
        chunk: 'Orphan chunk',
        type: 'assistant-stream'
      };

      await expect(streamHandler.processChunk(chunk)).rejects.toThrow('request_id');
      expect(container.textContent).not.toContain('Orphan chunk');
    });

    test('should reject null/invalid chunks', async () => {
      await expect(streamHandler.processChunk(null)).rejects.toThrow();
      await expect(streamHandler.processChunk(undefined)).rejects.toThrow();
      await expect(streamHandler.processChunk('string')).rejects.toThrow();
      await expect(streamHandler.processChunk(123)).rejects.toThrow();
    });
  });

  describe('Thinking Tag Parsing', () => {
    test('should extract thinking content from tags', async () => {
      const chunks = [
        { request_id: 'req_think_001', chunk: '<thinking>Analyzing the problem...' },
        { request_id: 'req_think_001', chunk: '</thinking>Response: 42' }
      ];

      for (const chunk of chunks) {
        await streamHandler.processChunk(chunk);
      }

      // Thinking text should be extracted
      expect(streamHandler.thinkingText).toContain('Analyzing the problem');
      
      // Flush RAF-coalesced view update before DOM assertion
      streamHandler._flushViewUpdate();
      
      // Visible text should not contain thinking tags
      expect(container.textContent).not.toContain('<thinking>');
      expect(container.textContent).toContain('Response: 42');
    });

    test('should handle nested thinking tags', async () => {
      const chunk = {
        request_id: 'req_nested',
        chunk: '<thinking>Step 1<thinking>Sub-thought</thinking>Step 2</thinking>Answer'
      };

      await streamHandler.processChunk(chunk);

      // Should extract all thinking content
      expect(streamHandler.thinkingText).toBeTruthy();
      
      // Flush RAF-coalesced view update before DOM assertion
      streamHandler._flushViewUpdate();
      
      // Visible text should only show answer
      const visibleText = container.textContent;
      expect(visibleText).toContain('Answer');
      expect(visibleText).not.toContain('Step 1');
      expect(visibleText).not.toContain('Sub-thought');
    });

    test('should handle partial thinking tags across chunks', async () => {
      const chunks = [
        { request_id: 'req_partial', chunk: 'Start <thin' },
        { request_id: 'req_partial', chunk: 'king>Hidden content' },
        { request_id: 'req_partial', chunk: '</thinking> Visible' }
      ];

      for (const chunk of chunks) {
        await streamHandler.processChunk(chunk);
      }

      streamHandler._flushViewUpdate();
      expect(container.textContent).not.toContain('Hidden content');
      expect(container.textContent).toContain('Start');
      expect(container.textContent).toContain('Visible');
    });
  });

  describe('Stream Finalization', () => {
    test('should finalize stream when done=true', async () => {
      const chunks = [
        { request_id: 'req_final_001', chunk: 'Complete message' },
        { request_id: 'req_final_001', chunk: '', done: true }
      ];

      for (const chunk of chunks) {
        await streamHandler.processChunk(chunk);
      }

      // Should emit finalization event
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          requestId: 'req_final_001'
        })
      );
    });

    test('should prevent duplicate finalization', async () => {
      const finalChunk = {
        request_id: 'req_dup_final',
        chunk: '',
        done: true
      };

      await streamHandler.processChunk(finalChunk);
      const firstCallCount = mockEventBus.emit.mock.calls.length;

      // Try to finalize again
      await streamHandler.processChunk(finalChunk);
      const secondCallCount = mockEventBus.emit.mock.calls.length;

      // Should not emit duplicate finalization
      expect(secondCallCount).toBe(firstCallCount);
    });

    test('should persist final message content', async () => {
      const chunks = [
        { request_id: 'req_persist', chunk: 'Final content' },
        { request_id: 'req_persist', chunk: '', done: true }
      ];

      for (const chunk of chunks) {
        await streamHandler.processChunk(chunk);
      }

      // MessageState should have the message
      expect(messageState.messages.length).toBeGreaterThan(0);
    });
  });

  describe('Race Conditions', () => {
    test('should handle rapid chunks without corruption', async () => {
      const chunks = Array.from({ length: 50 }, (_, i) => ({
        request_id: 'req_race_001',
        chunk: `${i} `
      }));

      // Process all chunks rapidly
      await Promise.all(chunks.map(chunk => streamHandler.processChunk(chunk)));

      // All numbers should appear exactly once
      for (let i = 0; i < 50; i++) {
        const regex = new RegExp(`\\b${i}\\b`, 'g');
        const matches = streamHandler.accumulatedText.match(regex);
        expect(matches).toHaveLength(1);
      }
    });

    test('should handle concurrent streams (different requestIds)', async () => {
      const stream1Chunks = [
        { request_id: 'req_A', chunk: 'Stream A part 1' },
        { request_id: 'req_A', chunk: ' - part 2' }
      ];

      const stream2Chunks = [
        { request_id: 'req_B', chunk: 'Stream B part 1' },
        { request_id: 'req_B', chunk: ' - part 2' }
      ];

      // Interleave chunks from different streams
      await streamHandler.processChunk(stream1Chunks[0]);
      await streamHandler.processChunk(stream2Chunks[0]);
      await streamHandler.processChunk(stream1Chunks[1]);
      await streamHandler.processChunk(stream2Chunks[1]);

      // Only the last stream (req_B) should be active
      expect(streamHandler.currentRequestId).toBe('req_B');
    });
  });

  describe('Error Handling', () => {
    test('should handle malformed chunk data', async () => {
      const malformedChunks = [
        { request_id: 'req_mal', chunk: null },
        { request_id: 'req_mal', chunk: undefined },
        { request_id: 'req_mal', chunk: 123 },
        { request_id: 'req_mal', chunk: { nested: 'object' } }
      ];

      for (const chunk of malformedChunks) {
        // Behavior is defined by StreamHandler's contract.
        // - null/undefined chunks: ignored (resolves false)
        // - non-string chunks: rejected (fail-fast contract violation)
        if (chunk.chunk === null || chunk.chunk === undefined) {
          await expect(streamHandler.processChunk(chunk)).resolves.toBe(false);
        } else {
          await expect(streamHandler.processChunk(chunk)).rejects.toThrow();
        }
      }
    });

    test('should handle extremely long chunks', async () => {
      const hugeChunk = {
        request_id: 'req_huge',
        chunk: 'x'.repeat(1000000) // 1MB chunk
      };

      await streamHandler.processChunk(hugeChunk);

      expect(streamHandler.accumulatedText.length).toBe(1000000);
    });

    test('should handle special characters in chunks', async () => {
      const specialChunk = {
        request_id: 'req_special',
        chunk: 'Special: \n\r\t\0\u0000\u{1F600}' // newlines, tabs, null, emoji
      };

      await streamHandler.processChunk(specialChunk);

      expect(streamHandler.accumulatedText).toContain('Special');
    });
  });

  describe('Stream State Management', () => {
    test('should track current request ID', async () => {
      await streamHandler.processChunk({
        request_id: 'req_state_001',
        chunk: 'Test'
      });

      expect(streamHandler.currentRequestId).toBe('req_state_001');
    });

    test('should reset state when new request starts', async () => {
      // First request
      await streamHandler.processChunk({
        request_id: 'req_old',
        chunk: 'Old request'
      });

      const oldText = streamHandler.accumulatedText;

      // New request (should reset)
      await streamHandler.processChunk({
        request_id: 'req_new',
        chunk: 'New request'
      });

      expect(streamHandler.currentRequestId).toBe('req_new');
      expect(streamHandler.accumulatedText).not.toContain('Old request');
      expect(streamHandler.accumulatedText).toContain('New request');
    });

    test('should track message ID for updates', async () => {
      await streamHandler.processChunk({
        request_id: 'req_msg_id',
        chunk: 'Test message'
      });

      expect(streamHandler.currentMessageId).toBeTruthy();
      expect(streamHandler.persistedMessageIds.has('req_msg_id')).toBe(true);
    });
  });

  describe('Integration with MessageView', () => {
    test('should update DOM as chunks arrive', async () => {
      const chunks = [
        { request_id: 'req_dom_001', chunk: 'First ' },
        { request_id: 'req_dom_001', chunk: 'Second ' },
        { request_id: 'req_dom_001', chunk: 'Third' }
      ];

      for (const chunk of chunks) {
        await streamHandler.processChunk(chunk);
      }

      // Flush RAF-coalesced view update before DOM assertion
      streamHandler._flushViewUpdate();

      // DOM should contain all chunks
      expect(container.textContent).toContain('First Second Third');
    });

    test('should render markdown in streamed content', async () => {
      const chunks = [
        { request_id: 'req_md', chunk: '# Heading\n\n' },
        { request_id: 'req_md', chunk: '**Bold** text with `code`' }
      ];

      for (const chunk of chunks) {
        await streamHandler.processChunk(chunk);
      }

      // Flush RAF-coalesced view update before DOM assertion
      streamHandler._flushViewUpdate();

      // Should contain rendered markdown
      expect(container.textContent).toContain('Heading');
      expect(container.textContent).toContain('Bold');
      expect(container.textContent).toContain('code');
    });
  });

  describe('Artifact Streaming Events', () => {
    test('should emit artifact events when artifact chunks detected', async () => {
      const artifactChunk = {
        request_id: 'req_art',
        type: 'artifact',
        chunk: 'console.log("code");',
        artifact: {
          id: 'art_001',
          kind: 'code',
          language: 'javascript'
        }
      };

      await streamHandler.processChunk(artifactChunk);

      // Should emit artifact-related events
      const artifactEvents = mockEventBus.emit.mock.calls.filter(
        call => call[0].includes('artifact')
      );
      
      expect(artifactEvents.length).toBeGreaterThan(0);
    });
  });

  describe('Performance', () => {
    test('should handle 1000 rapid chunks without significant delay', async () => {
      const startTime = Date.now();

      const chunks = Array.from({ length: 1000 }, (_, i) => ({
        request_id: 'req_perf',
        chunk: `word${i} `
      }));

      for (const chunk of chunks) {
        await streamHandler.processChunk(chunk);
      }

      const duration = Date.now() - startTime;

      // Should process 1000 chunks in reasonable time.
      // 30s ceiling accounts for: dev machine load, CI variance, DOM overhead in JSDOM.
      // Real-world streaming handles ~100 chunks/second which is well within this budget.
      expect(duration).toBeLessThan(30000);
      expect(streamHandler.accumulatedText.split(' ').length).toBeGreaterThan(999);
    });

    test('should not leak memory with long-running stream', async () => {
      // Process many chunks
      for (let i = 0; i < 100; i++) {
        await streamHandler.processChunk({
          request_id: 'req_memory',
          chunk: `chunk${i} `
        });
      }

      // Internal state should not grow unbounded
      expect(streamHandler._lastChunkContent.length).toBeLessThan(1000);
    });
  });
});

