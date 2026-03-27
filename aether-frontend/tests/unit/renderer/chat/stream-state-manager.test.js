'use strict';

// ---------------------------------------------------------------------------
// Mocks — plain functions survive resetMocks: true
// ---------------------------------------------------------------------------

const mockLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: jest.fn(),
  trace: jest.fn(),
};
mockLog.child = () => mockLog;

jest.mock('../../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLog,
}));

const StreamStateManager = require(
  '../../../../src/renderer/chat/modules/messaging/stream/StreamStateManager'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createManager() {
  return new StreamStateManager();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamStateManager', () => {
  beforeEach(() => {
    mockLog.debug.mockClear();
    mockLog.trace.mockClear();
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    test('initializes with null requestId', () => {
      const mgr = createManager();
      expect(mgr.requestId).toBeNull();
    });

    test('initializes with null messageId', () => {
      const mgr = createManager();
      expect(mgr.messageId).toBeNull();
    });

    test('initializes with empty accumulatedText', () => {
      const mgr = createManager();
      expect(mgr.accumulatedText).toBe('');
    });

    test('initializes with empty thinkingText', () => {
      const mgr = createManager();
      expect(mgr.thinkingText).toBe('');
    });

    test('initializes with isInThinkingTag false', () => {
      const mgr = createManager();
      expect(mgr.isInThinkingTag).toBe(false);
    });

    test('initializes with empty lastChunkContent', () => {
      const mgr = createManager();
      expect(mgr.lastChunkContent).toBe('');
    });

    test('initializes with lastChunkTimestamp 0', () => {
      const mgr = createManager();
      expect(mgr.lastChunkTimestamp).toBe(0);
    });

    test('accepts empty options', () => {
      expect(() => new StreamStateManager({})).not.toThrow();
    });

    test('accepts no options', () => {
      expect(() => new StreamStateManager()).not.toThrow();
    });
  });

  // =========================================================================
  // startStream()
  // =========================================================================
  describe('startStream', () => {
    test('sets requestId and messageId', () => {
      const mgr = createManager();

      mgr.startStream('req-1', 'msg-1');

      expect(mgr.requestId).toBe('req-1');
      expect(mgr.messageId).toBe('msg-1');
    });

    test('clears accumulatedText', () => {
      const mgr = createManager();
      mgr.accumulatedText = 'leftover';

      mgr.startStream('req-1', 'msg-1');

      expect(mgr.accumulatedText).toBe('');
    });

    test('clears thinkingText', () => {
      const mgr = createManager();
      mgr.thinkingText = 'leftover thinking';

      mgr.startStream('req-1', 'msg-1');

      expect(mgr.thinkingText).toBe('');
    });

    test('resets isInThinkingTag to false', () => {
      const mgr = createManager();
      mgr.isInThinkingTag = true;

      mgr.startStream('req-1', 'msg-1');

      expect(mgr.isInThinkingTag).toBe(false);
    });

    test('clears deduplication state', () => {
      const mgr = createManager();
      mgr.lastChunkContent = 'old chunk';
      mgr.lastChunkTimestamp = 12345;

      mgr.startStream('req-1', 'msg-1');

      expect(mgr.lastChunkContent).toBe('');
      expect(mgr.lastChunkTimestamp).toBe(0);
    });

    test('logs debug with requestId and messageId', () => {
      const mgr = createManager();

      mgr.startStream('req-abc', 'msg-xyz');

      expect(mockLog.debug).toHaveBeenCalledWith(
        'Stream started',
        { requestId: 'req-abc', messageId: 'msg-xyz' }
      );
    });

    test('can be called multiple times (re-start)', () => {
      const mgr = createManager();

      mgr.startStream('req-1', 'msg-1');
      mgr.appendText('some text');

      mgr.startStream('req-2', 'msg-2');

      expect(mgr.requestId).toBe('req-2');
      expect(mgr.messageId).toBe('msg-2');
      expect(mgr.accumulatedText).toBe('');
    });
  });

  // =========================================================================
  // appendText()
  // =========================================================================
  describe('appendText', () => {
    test('appends text to accumulatedText', () => {
      const mgr = createManager();

      mgr.appendText('Hello ');
      mgr.appendText('world');

      expect(mgr.accumulatedText).toBe('Hello world');
    });

    test('handles single character appends', () => {
      const mgr = createManager();

      mgr.appendText('a');
      mgr.appendText('b');
      mgr.appendText('c');

      expect(mgr.accumulatedText).toBe('abc');
    });

    test('skips null text', () => {
      const mgr = createManager();
      mgr.appendText('start');

      mgr.appendText(null);

      expect(mgr.accumulatedText).toBe('start');
    });

    test('skips undefined text', () => {
      const mgr = createManager();
      mgr.appendText('start');

      mgr.appendText(undefined);

      expect(mgr.accumulatedText).toBe('start');
    });

    test('skips empty string (falsy guard)', () => {
      const mgr = createManager();
      mgr.appendText('start');

      mgr.appendText('');

      // '' is falsy, so the guard returns early
      // No-op anyway since '' + '' = ''
      expect(mgr.accumulatedText).toBe('start');
    });

    test('handles multiline text', () => {
      const mgr = createManager();

      mgr.appendText('line 1\n');
      mgr.appendText('line 2\n');

      expect(mgr.accumulatedText).toBe('line 1\nline 2\n');
    });

    test('handles special characters', () => {
      const mgr = createManager();

      mgr.appendText('```javascript\n');
      mgr.appendText('const x = "hello";\n');
      mgr.appendText('```\n');

      expect(mgr.accumulatedText).toBe('```javascript\nconst x = "hello";\n```\n');
    });

    test('handles large text accumulation', () => {
      const mgr = createManager();
      const chunk = 'x'.repeat(1000);

      for (let i = 0; i < 100; i++) {
        mgr.appendText(chunk);
      }

      expect(mgr.accumulatedText.length).toBe(100000);
    });
  });

  // =========================================================================
  // appendThinking()
  // =========================================================================
  describe('appendThinking', () => {
    test('appends text to thinkingText', () => {
      const mgr = createManager();

      mgr.appendThinking('Let me think...');
      mgr.appendThinking(' about this.');

      expect(mgr.thinkingText).toBe('Let me think... about this.');
    });

    test('skips null text', () => {
      const mgr = createManager();
      mgr.appendThinking('start');

      mgr.appendThinking(null);

      expect(mgr.thinkingText).toBe('start');
    });

    test('skips undefined text', () => {
      const mgr = createManager();
      mgr.appendThinking('start');

      mgr.appendThinking(undefined);

      expect(mgr.thinkingText).toBe('start');
    });

    test('skips empty string', () => {
      const mgr = createManager();
      mgr.appendThinking('start');

      mgr.appendThinking('');

      expect(mgr.thinkingText).toBe('start');
    });

    test('does not affect accumulatedText', () => {
      const mgr = createManager();
      mgr.appendText('visible');

      mgr.appendThinking('hidden thinking');

      expect(mgr.accumulatedText).toBe('visible');
      expect(mgr.thinkingText).toBe('hidden thinking');
    });
  });

  // =========================================================================
  // setThinkingTagState()
  // =========================================================================
  describe('setThinkingTagState', () => {
    test('sets isInThinkingTag to true', () => {
      const mgr = createManager();

      mgr.setThinkingTagState(true);

      expect(mgr.isInThinkingTag).toBe(true);
    });

    test('sets isInThinkingTag to false', () => {
      const mgr = createManager();
      mgr.isInThinkingTag = true;

      mgr.setThinkingTagState(false);

      expect(mgr.isInThinkingTag).toBe(false);
    });

    test('accepts truthy non-boolean values', () => {
      const mgr = createManager();

      mgr.setThinkingTagState(1);

      expect(mgr.isInThinkingTag).toBe(1);
    });

    test('accepts falsy non-boolean values', () => {
      const mgr = createManager();
      mgr.isInThinkingTag = true;

      mgr.setThinkingTagState(0);

      expect(mgr.isInThinkingTag).toBe(0);
    });
  });

  // =========================================================================
  // updateDeduplicationState()
  // =========================================================================
  describe('updateDeduplicationState', () => {
    test('stores content and timestamp', () => {
      const mgr = createManager();

      mgr.updateDeduplicationState('chunk data', 1234567890);

      expect(mgr.lastChunkContent).toBe('chunk data');
      expect(mgr.lastChunkTimestamp).toBe(1234567890);
    });

    test('overwrites previous dedup state', () => {
      const mgr = createManager();

      mgr.updateDeduplicationState('first', 100);
      mgr.updateDeduplicationState('second', 200);

      expect(mgr.lastChunkContent).toBe('second');
      expect(mgr.lastChunkTimestamp).toBe(200);
    });

    test('accepts null content', () => {
      const mgr = createManager();

      mgr.updateDeduplicationState(null, 100);

      expect(mgr.lastChunkContent).toBeNull();
    });

    test('accepts 0 timestamp', () => {
      const mgr = createManager();

      mgr.updateDeduplicationState('data', 0);

      expect(mgr.lastChunkTimestamp).toBe(0);
    });
  });

  // =========================================================================
  // Getters
  // =========================================================================
  describe('getters', () => {
    test('getAccumulatedText returns accumulatedText', () => {
      const mgr = createManager();
      mgr.appendText('hello');

      expect(mgr.getAccumulatedText()).toBe('hello');
    });

    test('getAccumulatedText returns empty string initially', () => {
      const mgr = createManager();
      expect(mgr.getAccumulatedText()).toBe('');
    });

    test('getThinkingText returns thinkingText', () => {
      const mgr = createManager();
      mgr.appendThinking('thinking...');

      expect(mgr.getThinkingText()).toBe('thinking...');
    });

    test('getThinkingText returns empty string initially', () => {
      const mgr = createManager();
      expect(mgr.getThinkingText()).toBe('');
    });

    test('getRequestId returns requestId', () => {
      const mgr = createManager();
      mgr.startStream('req-1', 'msg-1');

      expect(mgr.getRequestId()).toBe('req-1');
    });

    test('getRequestId returns null initially', () => {
      const mgr = createManager();
      expect(mgr.getRequestId()).toBeNull();
    });

    test('getMessageId returns messageId', () => {
      const mgr = createManager();
      mgr.startStream('req-1', 'msg-1');

      expect(mgr.getMessageId()).toBe('msg-1');
    });

    test('getMessageId returns null initially', () => {
      const mgr = createManager();
      expect(mgr.getMessageId()).toBeNull();
    });

    test('isThinkingTagOpen returns isInThinkingTag', () => {
      const mgr = createManager();

      expect(mgr.isThinkingTagOpen()).toBe(false);

      mgr.setThinkingTagState(true);

      expect(mgr.isThinkingTagOpen()).toBe(true);
    });

    test('getDeduplicationState returns lastContent and lastTimestamp', () => {
      const mgr = createManager();
      mgr.updateDeduplicationState('data', 999);

      const state = mgr.getDeduplicationState();

      expect(state).toEqual({ lastContent: 'data', lastTimestamp: 999 });
    });

    test('getDeduplicationState returns initial state', () => {
      const mgr = createManager();

      const state = mgr.getDeduplicationState();

      expect(state).toEqual({ lastContent: '', lastTimestamp: 0 });
    });
  });

  // =========================================================================
  // isStreaming()
  // =========================================================================
  describe('isStreaming', () => {
    test('returns false initially (no requestId)', () => {
      const mgr = createManager();
      expect(mgr.isStreaming()).toBe(false);
    });

    test('returns true after startStream', () => {
      const mgr = createManager();
      mgr.startStream('req-1', 'msg-1');

      expect(mgr.isStreaming()).toBe(true);
    });

    test('returns false after clear', () => {
      const mgr = createManager();
      mgr.startStream('req-1', 'msg-1');

      mgr.clear();

      expect(mgr.isStreaming()).toBe(false);
    });

    test('returns false after dispose', () => {
      const mgr = createManager();
      mgr.startStream('req-1', 'msg-1');

      mgr.dispose();

      expect(mgr.isStreaming()).toBe(false);
    });

    test('returns false if requestId is manually set to null', () => {
      const mgr = createManager();
      mgr.startStream('req-1', 'msg-1');
      mgr.requestId = null;

      expect(mgr.isStreaming()).toBe(false);
    });

    test('returns false if requestId is empty string', () => {
      const mgr = createManager();
      mgr.requestId = '';

      expect(mgr.isStreaming()).toBe(false);
    });

    test('returns false if requestId is 0', () => {
      const mgr = createManager();
      mgr.requestId = 0;

      expect(mgr.isStreaming()).toBe(false);
    });
  });

  // =========================================================================
  // clear()
  // =========================================================================
  describe('clear', () => {
    test('resets requestId to null', () => {
      const mgr = createManager();
      mgr.startStream('req-1', 'msg-1');

      mgr.clear();

      expect(mgr.requestId).toBeNull();
    });

    test('resets messageId to null', () => {
      const mgr = createManager();
      mgr.startStream('req-1', 'msg-1');

      mgr.clear();

      expect(mgr.messageId).toBeNull();
    });

    test('resets accumulatedText to empty string', () => {
      const mgr = createManager();
      mgr.appendText('some text');

      mgr.clear();

      expect(mgr.accumulatedText).toBe('');
    });

    test('resets thinkingText to empty string', () => {
      const mgr = createManager();
      mgr.appendThinking('thinking...');

      mgr.clear();

      expect(mgr.thinkingText).toBe('');
    });

    test('resets isInThinkingTag to false', () => {
      const mgr = createManager();
      mgr.setThinkingTagState(true);

      mgr.clear();

      expect(mgr.isInThinkingTag).toBe(false);
    });

    test('resets deduplication state', () => {
      const mgr = createManager();
      mgr.updateDeduplicationState('data', 999);

      mgr.clear();

      expect(mgr.lastChunkContent).toBe('');
      expect(mgr.lastChunkTimestamp).toBe(0);
    });

    test('logs trace on clear', () => {
      const mgr = createManager();

      mgr.clear();

      expect(mockLog.trace).toHaveBeenCalledWith('Stream state cleared');
    });

    test('can be called multiple times safely', () => {
      const mgr = createManager();

      expect(() => {
        mgr.clear();
        mgr.clear();
      }).not.toThrow();
    });

    test('can be called on fresh instance (nothing to clear)', () => {
      const mgr = createManager();

      expect(() => mgr.clear()).not.toThrow();

      expect(mgr.requestId).toBeNull();
      expect(mgr.accumulatedText).toBe('');
    });
  });

  // =========================================================================
  // dispose()
  // =========================================================================
  describe('dispose', () => {
    test('calls clear internally (resets all state)', () => {
      const mgr = createManager();
      mgr.startStream('req-1', 'msg-1');
      mgr.appendText('text');
      mgr.appendThinking('thinking');
      mgr.setThinkingTagState(true);
      mgr.updateDeduplicationState('chunk', 123);

      mgr.dispose();

      expect(mgr.requestId).toBeNull();
      expect(mgr.messageId).toBeNull();
      expect(mgr.accumulatedText).toBe('');
      expect(mgr.thinkingText).toBe('');
      expect(mgr.isInThinkingTag).toBe(false);
      expect(mgr.lastChunkContent).toBe('');
      expect(mgr.lastChunkTimestamp).toBe(0);
    });

    test('can be called multiple times safely', () => {
      const mgr = createManager();

      expect(() => {
        mgr.dispose();
        mgr.dispose();
      }).not.toThrow();
    });

    test('state remains clean after double dispose', () => {
      const mgr = createManager();
      mgr.startStream('req-1', 'msg-1');

      mgr.dispose();
      mgr.dispose();

      expect(mgr.isStreaming()).toBe(false);
    });
  });

  // =========================================================================
  // Lifecycle integration
  // =========================================================================
  describe('lifecycle integration', () => {
    test('full lifecycle: create → start → accumulate → clear → restart → dispose', () => {
      const mgr = createManager();

      // Phase 1: Not streaming
      expect(mgr.isStreaming()).toBe(false);
      expect(mgr.getAccumulatedText()).toBe('');

      // Phase 2: Start stream
      mgr.startStream('req-1', 'msg-1');
      expect(mgr.isStreaming()).toBe(true);
      expect(mgr.getRequestId()).toBe('req-1');
      expect(mgr.getMessageId()).toBe('msg-1');

      // Phase 3: Accumulate visible + thinking text
      mgr.appendText('Hello ');
      mgr.appendText('world');
      mgr.setThinkingTagState(true);
      mgr.appendThinking('I need to analyze this...');
      mgr.setThinkingTagState(false);

      expect(mgr.getAccumulatedText()).toBe('Hello world');
      expect(mgr.getThinkingText()).toBe('I need to analyze this...');
      expect(mgr.isThinkingTagOpen()).toBe(false);

      // Phase 4: Update dedup state
      mgr.updateDeduplicationState('world', Date.now());
      const dedup = mgr.getDeduplicationState();
      expect(dedup.lastContent).toBe('world');

      // Phase 5: Clear (stream ended)
      mgr.clear();
      expect(mgr.isStreaming()).toBe(false);
      expect(mgr.getAccumulatedText()).toBe('');
      expect(mgr.getThinkingText()).toBe('');

      // Phase 6: Restart with new stream
      mgr.startStream('req-2', 'msg-2');
      expect(mgr.isStreaming()).toBe(true);
      expect(mgr.getRequestId()).toBe('req-2');

      mgr.appendText('New response');
      expect(mgr.getAccumulatedText()).toBe('New response');

      // Phase 7: Dispose
      mgr.dispose();
      expect(mgr.isStreaming()).toBe(false);
      expect(mgr.getAccumulatedText()).toBe('');
    });

    test('interleaved visible and thinking text accumulation', () => {
      const mgr = createManager();
      mgr.startStream('req-1', 'msg-1');

      // Simulating: visible → thinking → visible → thinking
      mgr.appendText('Part 1. ');
      mgr.setThinkingTagState(true);
      mgr.appendThinking('Hmm, ');
      mgr.appendThinking('let me think...');
      mgr.setThinkingTagState(false);
      mgr.appendText('Part 2.');
      mgr.setThinkingTagState(true);
      mgr.appendThinking(' More thinking.');
      mgr.setThinkingTagState(false);

      expect(mgr.getAccumulatedText()).toBe('Part 1. Part 2.');
      expect(mgr.getThinkingText()).toBe('Hmm, let me think... More thinking.');
      expect(mgr.isThinkingTagOpen()).toBe(false);
    });

    test('startStream resets previous stream state completely', () => {
      const mgr = createManager();

      // First stream
      mgr.startStream('req-1', 'msg-1');
      mgr.appendText('Old response');
      mgr.appendThinking('Old thinking');
      mgr.setThinkingTagState(true);
      mgr.updateDeduplicationState('old', 100);

      // Second stream overwrites everything
      mgr.startStream('req-2', 'msg-2');

      expect(mgr.getRequestId()).toBe('req-2');
      expect(mgr.getMessageId()).toBe('msg-2');
      expect(mgr.getAccumulatedText()).toBe('');
      expect(mgr.getThinkingText()).toBe('');
      expect(mgr.isThinkingTagOpen()).toBe(false);
      expect(mgr.getDeduplicationState()).toEqual({ lastContent: '', lastTimestamp: 0 });
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================
  describe('module exports', () => {
    test('exports StreamStateManager constructor', () => {
      expect(typeof StreamStateManager).toBe('function');
    });

    test('instances have expected methods', () => {
      const mgr = createManager();
      expect(typeof mgr.startStream).toBe('function');
      expect(typeof mgr.appendText).toBe('function');
      expect(typeof mgr.appendThinking).toBe('function');
      expect(typeof mgr.setThinkingTagState).toBe('function');
      expect(typeof mgr.updateDeduplicationState).toBe('function');
      expect(typeof mgr.getAccumulatedText).toBe('function');
      expect(typeof mgr.getThinkingText).toBe('function');
      expect(typeof mgr.getRequestId).toBe('function');
      expect(typeof mgr.getMessageId).toBe('function');
      expect(typeof mgr.isThinkingTagOpen).toBe('function');
      expect(typeof mgr.getDeduplicationState).toBe('function');
      expect(typeof mgr.isStreaming).toBe('function');
      expect(typeof mgr.clear).toBe('function');
      expect(typeof mgr.dispose).toBe('function');
    });
  });
});
