'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

const { ArtifactMessageRouter } = require('../../../../../src/domain/artifacts/services/ArtifactMessageRouter');

describe('ArtifactMessageRouter', () => {
  let router;

  beforeEach(() => {
    router = new ArtifactMessageRouter({ enableLogging: true });
  });

  describe('route()', () => {
    it('throws on null/undefined message', () => {
      expect(() => router.route(null)).toThrow('CONTRACT VIOLATION');
      expect(() => router.route(undefined)).toThrow('CONTRACT VIOLATION');
    });

    it('throws on non-object message', () => {
      expect(() => router.route('string')).toThrow('CONTRACT VIOLATION');
    });

    // Route 1: assistant_code
    it('routes assistant:code to "assistant_code"', () => {
      const result = router.route({ role: 'assistant', type: 'code' });
      expect(result.route).toBe('assistant_code');
      expect(result.metadata.requiresCodeProcessing).toBe(true);
      expect(result.message).toEqual({ role: 'assistant', type: 'code' });
    });

    // Route 2: computer_output
    it('routes computer:output to "computer_output"', () => {
      const result = router.route({ role: 'computer', type: 'output' });
      expect(result.route).toBe('computer_output');
      expect(result.metadata.requiresOutputProcessing).toBe(true);
    });

    it('routes computer:console to "computer_output"', () => {
      const result = router.route({ role: 'computer', type: 'console' });
      expect(result.route).toBe('computer_output');
    });

    // HTML detection in computer output
    it('detects HTML format in computer output', () => {
      const result = router.route({ role: 'computer', type: 'output', format: 'html', content: '' });
      expect(result.metadata.forceHtml).toBe(true);
    });

    it('detects semantic search HTML heuristically', () => {
      const content = '<div class="semantic-search-header">Results</div>';
      const result = router.route({ role: 'computer', type: 'output', content });
      expect(result.metadata.forceHtml).toBe(true);
    });

    it('detects semantic search emoji heuristics', () => {
      const content = '🔍 Semantic Search Results for query';
      const result = router.route({ role: 'computer', type: 'output', content });
      expect(result.metadata.forceHtml).toBe(true);
    });

    it('sets forceHtml=false for plain text output', () => {
      const result = router.route({ role: 'computer', type: 'output', content: 'hello world' });
      expect(result.metadata.forceHtml).toBe(false);
    });

    // Recipient filtering
    it('filters non-user computer messages', () => {
      const result = router.route({ role: 'computer', type: 'output', recipient: 'assistant' });
      expect(result.route).toBe('filtered');
      expect(result.metadata.reason).toBe('non-user-recipient');
    });

    it('does NOT filter computer messages with recipient=user', () => {
      const result = router.route({ role: 'computer', type: 'output', recipient: 'user' });
      expect(result.route).toBe('computer_output');
    });

    it('does NOT filter non-computer messages with non-user recipient', () => {
      const result = router.route({ role: 'assistant', type: 'code', recipient: 'assistant' });
      expect(result.route).toBe('assistant_code');
    });

    // Route 3: media
    it('routes messages with video media payload to "media"', () => {
      const content = { videos: [{ url: 'https://youtube.com/watch?v=abc' }] };
      const result = router.route({ role: 'assistant', type: 'output', content });
      expect(result.route).toBe('media');
      expect(result.metadata.requiresMediaProcessing).toBe(true);
      expect(result.metadata.mediaPayload).toBeTruthy();
    });

    it('routes messages with image media payload to "media"', () => {
      const content = { images: [{ img_src: 'https://example.com/img.png' }] };
      const result = router.route({ role: 'assistant', type: 'output', content });
      expect(result.route).toBe('media');
    });

    // Route 4: unknown
    it('routes unrecognized message types to "unknown"', () => {
      const result = router.route({ role: 'user', type: 'text' });
      expect(result.route).toBe('unknown');
      expect(result.metadata.role).toBe('user');
      expect(result.metadata.type).toBe('text');
    });
  });

  describe('shouldProcess()', () => {
    it('returns true for processable routes', () => {
      expect(router.shouldProcess({ role: 'assistant', type: 'code' })).toBe(true);
      expect(router.shouldProcess({ role: 'computer', type: 'output' })).toBe(true);
    });

    it('returns false for filtered messages', () => {
      expect(router.shouldProcess({ role: 'computer', type: 'output', recipient: 'assistant' })).toBe(false);
    });

    it('returns false for unknown messages', () => {
      expect(router.shouldProcess({ role: 'user', type: 'text' })).toBe(false);
    });
  });

  describe('getRouteType()', () => {
    it('returns just the route string', () => {
      expect(router.getRouteType({ role: 'assistant', type: 'code' })).toBe('assistant_code');
      expect(router.getRouteType({ role: 'computer', type: 'output' })).toBe('computer_output');
    });
  });
});
