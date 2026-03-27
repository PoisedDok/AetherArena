'use strict';

const { shouldProcessChunk, parseStreamChunk } = require('../../../src/renderer/shared/messaging/streamUtils');

// ═══════════════════════════════════════════════════════════════════════════
// shouldProcessChunk
// ═══════════════════════════════════════════════════════════════════════════

describe('shouldProcessChunk', () => {
  describe('empty / falsy content', () => {
    it('returns process=false for empty string content', () => {
      const result = shouldProcessChunk({ content: '' });
      expect(result).toEqual({
        process: false,
        lastContent: '',
        lastTimestamp: 0,
      });
    });

    it('returns process=false for undefined content (default)', () => {
      const result = shouldProcessChunk({});
      expect(result).toEqual({
        process: false,
        lastContent: '',
        lastTimestamp: 0,
      });
    });

    it('preserves provided lastContent and lastTimestamp on empty content', () => {
      const result = shouldProcessChunk({
        content: '',
        lastContent: 'prev',
        lastTimestamp: 100,
      });
      expect(result).toEqual({
        process: false,
        lastContent: 'prev',
        lastTimestamp: 100,
      });
    });

    it('returns process=false for null-ish content (falsy)', () => {
      const result = shouldProcessChunk({ content: null });
      expect(result.process).toBe(false);
    });
  });

  describe('deduplication within time window', () => {
    it('rejects duplicate content within windowMs', () => {
      const now = 1000;
      const result = shouldProcessChunk({
        content: 'hello',
        lastContent: 'hello',
        lastTimestamp: 980,
        now,
        windowMs: 50,
      });
      expect(result.process).toBe(false);
      expect(result.lastContent).toBe('hello');
      expect(result.lastTimestamp).toBe(980);
    });

    it('accepts duplicate content after windowMs expires', () => {
      const now = 1000;
      const result = shouldProcessChunk({
        content: 'hello',
        lastContent: 'hello',
        lastTimestamp: 940,
        now,
        windowMs: 50,
      });
      expect(result.process).toBe(true);
      expect(result.lastContent).toBe('hello');
      expect(result.lastTimestamp).toBe(now);
    });

    it('accepts duplicate content at exact windowMs boundary', () => {
      const now = 1000;
      const result = shouldProcessChunk({
        content: 'hello',
        lastContent: 'hello',
        lastTimestamp: 950,
        now,
        windowMs: 50,
      });
      // timeDiff = 50, which is NOT < 50, so it should process
      expect(result.process).toBe(true);
    });
  });

  describe('different content within time window', () => {
    it('accepts different content within windowMs', () => {
      const now = 1000;
      const result = shouldProcessChunk({
        content: 'new chunk',
        lastContent: 'old chunk',
        lastTimestamp: 990,
        now,
        windowMs: 50,
      });
      expect(result.process).toBe(true);
      expect(result.lastContent).toBe('new chunk');
      expect(result.lastTimestamp).toBe(now);
    });
  });

  describe('new content (no prior state)', () => {
    it('processes first chunk with defaults', () => {
      const now = 5000;
      const result = shouldProcessChunk({
        content: 'first chunk',
        now,
      });
      expect(result.process).toBe(true);
      expect(result.lastContent).toBe('first chunk');
      expect(result.lastTimestamp).toBe(now);
    });

    it('processes when lastTimestamp is 0 (initial state)', () => {
      const now = 100;
      const result = shouldProcessChunk({
        content: 'data',
        lastContent: '',
        lastTimestamp: 0,
        now,
      });
      expect(result.process).toBe(true);
    });
  });

  describe('default parameter values', () => {
    it('uses windowMs=50 by default', () => {
      const now = 1000;
      // Same content, 49ms apart -> should deduplicate
      const result = shouldProcessChunk({
        content: 'x',
        lastContent: 'x',
        lastTimestamp: 951,
        now,
      });
      expect(result.process).toBe(false);
    });

    it('uses now=Date.now() by default (processes new content)', () => {
      const result = shouldProcessChunk({ content: 'data' });
      expect(result.process).toBe(true);
      expect(result.lastTimestamp).toBeGreaterThan(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseStreamChunk
// ═══════════════════════════════════════════════════════════════════════════

describe('parseStreamChunk', () => {
  describe('empty / no input', () => {
    it('returns empty result for no arguments', () => {
      const result = parseStreamChunk();
      expect(result).toEqual({
        visible: '',
        thinking: '',
        isInThinkingTag: false,
        state: { depth: 0, carry: '' },
      });
    });

    it('returns empty result for empty chunk', () => {
      const result = parseStreamChunk({ chunk: '' });
      expect(result).toEqual({
        visible: '',
        thinking: '',
        isInThinkingTag: false,
        state: { depth: 0, carry: '' },
      });
    });

    it('returns empty result for null chunk', () => {
      const result = parseStreamChunk({ chunk: null });
      expect(result.visible).toBe('');
      expect(result.thinking).toBe('');
    });
  });

  describe('plain text (no tags)', () => {
    it('puts all text into visible', () => {
      const result = parseStreamChunk({ chunk: 'Hello world' });
      expect(result.visible).toBe('Hello world');
      expect(result.thinking).toBe('');
      expect(result.isInThinkingTag).toBe(false);
    });

    it('handles text with special characters', () => {
      const result = parseStreamChunk({ chunk: 'a = b && c > d' });
      // The '>' is not a tag start, so treated literally
      expect(result.visible).toContain('a = b && c');
    });

    it('handles text with literal < that is not a tag', () => {
      const result = parseStreamChunk({ chunk: '3 < 5' });
      expect(result.visible).toBe('3 < 5');
    });
  });

  describe('<thinking> tag support', () => {
    it('routes content inside <thinking> to thinking output', () => {
      const result = parseStreamChunk({ chunk: '<thinking>deep thought</thinking>' });
      expect(result.visible).toBe('');
      expect(result.thinking).toBe('deep thought');
      expect(result.isInThinkingTag).toBe(false);
    });

    it('routes content before <thinking> to visible', () => {
      const result = parseStreamChunk({ chunk: 'before<thinking>inner</thinking>' });
      expect(result.visible).toBe('before');
      expect(result.thinking).toBe('inner');
    });

    it('routes content after </thinking> to visible', () => {
      const result = parseStreamChunk({ chunk: '<thinking>inner</thinking>after' });
      expect(result.visible).toBe('after');
      expect(result.thinking).toBe('inner');
    });

    it('handles mixed visible and thinking', () => {
      const result = parseStreamChunk({
        chunk: 'start<thinking>think</thinking>middle<thinking>more</thinking>end',
      });
      expect(result.visible).toBe('startmiddleend');
      expect(result.thinking).toBe('thinkmore');
    });

    it('sets isInThinkingTag=true when tag is opened but not closed', () => {
      const result = parseStreamChunk({ chunk: '<thinking>ongoing' });
      expect(result.thinking).toBe('ongoing');
      expect(result.isInThinkingTag).toBe(true);
      expect(result.state.depth).toBe(1);
    });
  });

  describe('<think> tag support', () => {
    it('routes content inside <think> to thinking output', () => {
      const result = parseStreamChunk({ chunk: '<think>deep thought</think>' });
      expect(result.visible).toBe('');
      expect(result.thinking).toBe('deep thought');
      expect(result.isInThinkingTag).toBe(false);
    });

    it('sets isInThinkingTag=true when <think> opened but not closed', () => {
      const result = parseStreamChunk({ chunk: '<think>ongoing' });
      expect(result.thinking).toBe('ongoing');
      expect(result.isInThinkingTag).toBe(true);
    });
  });

  describe('nesting support', () => {
    it('handles nested <thinking> tags with depth tracking', () => {
      const result = parseStreamChunk({
        chunk: '<thinking>outer<thinking>inner</thinking>still</thinking>',
      });
      expect(result.thinking).toBe('outerinnerstill');
      expect(result.isInThinkingTag).toBe(false);
      expect(result.state.depth).toBe(0);
    });

    it('handles partially nested closing tags', () => {
      const result = parseStreamChunk({
        chunk: '<thinking>outer<thinking>inner</thinking>',
      });
      // One open tag remains unclosed
      expect(result.isInThinkingTag).toBe(true);
      expect(result.state.depth).toBe(1);
    });

    it('depth never goes below 0 on extra close tags', () => {
      const result = parseStreamChunk({
        chunk: '</thinking></thinking>visible text',
      });
      expect(result.state.depth).toBe(0);
      expect(result.visible).toBe('visible text');
    });
  });

  describe('cross-chunk carry buffer', () => {
    it('carries partial tag at end of chunk', () => {
      const result1 = parseStreamChunk({ chunk: 'hello<thin' });
      expect(result1.visible).toBe('hello');
      expect(result1.state.carry).toBe('<thin');
    });

    it('completes tag from carry in next chunk', () => {
      const result1 = parseStreamChunk({ chunk: 'hello<thin' });
      const result2 = parseStreamChunk({ chunk: 'king>deep', state: result1.state });
      expect(result2.thinking).toBe('deep');
      expect(result2.isInThinkingTag).toBe(true);
    });

    it('carries partial closing tag', () => {
      const state = { depth: 1, carry: '' };
      const result = parseStreamChunk({ chunk: 'thought</thin', state });
      expect(result.thinking).toBe('thought');
      expect(result.state.carry).toBe('</thin');
    });

    it('completes closing tag from carry', () => {
      const state = { depth: 1, carry: '</thin' };
      const result = parseStreamChunk({ chunk: 'king>visible now', state });
      expect(result.visible).toBe('visible now');
      expect(result.isInThinkingTag).toBe(false);
      expect(result.state.depth).toBe(0);
    });

    it('handles carry of just "<"', () => {
      const result = parseStreamChunk({ chunk: 'text<' });
      expect(result.visible).toBe('text');
      expect(result.state.carry).toBe('<');
    });

    it('resolves carry "<" followed by non-tag content', () => {
      const state = { depth: 0, carry: '<' };
      const result = parseStreamChunk({ chunk: 'b>text', state });
      // "<b>" is not a recognized tag, so '<' is literal
      expect(result.visible).toContain('<');
      expect(result.visible).toContain('b>text');
    });

    it('handles multi-chunk streaming scenario end-to-end', () => {
      // Simulate realistic streaming: "Hello <thinking>I need to think</thinking> Done"
      const chunks = ['Hello ', '<think', 'ing>I need to think</thi', 'nking> Done'];
      let state = null;
      let visible = '';
      let thinking = '';

      for (const chunk of chunks) {
        const result = parseStreamChunk({ chunk, state });
        visible += result.visible;
        thinking += result.thinking;
        state = result.state;
      }

      expect(visible).toBe('Hello  Done');
      expect(thinking).toBe('I need to think');
      expect(state.depth).toBe(0);
      expect(state.carry).toBe('');
    });

    it('handles <think> tag split across chunks', () => {
      const result1 = parseStreamChunk({ chunk: 'pre<thi' });
      expect(result1.visible).toBe('pre');
      expect(result1.state.carry).toBe('<thi');

      const result2 = parseStreamChunk({ chunk: 'nk>inner</think>post', state: result1.state });
      expect(result2.thinking).toBe('inner');
      expect(result2.visible).toBe('post');
    });
  });

  describe('state handling', () => {
    it('initializes default state when state is null', () => {
      const result = parseStreamChunk({ chunk: 'text', state: null });
      expect(result.state).toEqual({ depth: 0, carry: '' });
    });

    it('initializes default state when state is undefined', () => {
      const result = parseStreamChunk({ chunk: 'text' });
      expect(result.state).toEqual({ depth: 0, carry: '' });
    });

    it('preserves depth from previous state', () => {
      const result = parseStreamChunk({
        chunk: 'still thinking',
        state: { depth: 1, carry: '' },
      });
      expect(result.thinking).toBe('still thinking');
      expect(result.isInThinkingTag).toBe(true);
    });

    it('handles non-object state gracefully', () => {
      const result = parseStreamChunk({ chunk: 'text', state: 'invalid' });
      expect(result.visible).toBe('text');
      expect(result.state.depth).toBe(0);
    });

    it('handles state with invalid depth type', () => {
      const result = parseStreamChunk({
        chunk: 'text',
        state: { depth: 'bad', carry: '' },
      });
      expect(result.state.depth).toBe(0);
      expect(result.visible).toBe('text');
    });

    it('handles state with invalid carry type', () => {
      const result = parseStreamChunk({
        chunk: 'text',
        state: { depth: 0, carry: 123 },
      });
      expect(result.visible).toBe('text');
      expect(result.state.carry).toBe('');
    });

    it('returns isInThinkingTag=true for empty chunk with positive depth', () => {
      const result = parseStreamChunk({
        chunk: '',
        state: { depth: 2, carry: '' },
      });
      expect(result.isInThinkingTag).toBe(true);
    });
  });

  describe('literal angle brackets', () => {
    it('treats non-tag < as literal in visible text', () => {
      const result = parseStreamChunk({ chunk: 'a < b' });
      expect(result.visible).toBe('a < b');
    });

    it('treats non-tag < as literal in thinking text', () => {
      const result = parseStreamChunk({
        chunk: 'a < b',
        state: { depth: 1, carry: '' },
      });
      expect(result.thinking).toBe('a < b');
    });

    it('handles multiple non-tag angle brackets', () => {
      const result = parseStreamChunk({ chunk: '1<2 and 3<4 and <not_a_tag>' });
      expect(result.visible).toContain('1<2');
      expect(result.visible).toContain('3<4');
    });
  });

  describe('isPrefixOfAnyTag edge cases', () => {
    it('does not carry forward if tail does not start with <', () => {
      const result = parseStreamChunk({ chunk: 'just text' });
      expect(result.state.carry).toBe('');
    });

    it('carries forward partial </think tag', () => {
      const result = parseStreamChunk({
        chunk: 'text</thi',
        state: { depth: 1, carry: '' },
      });
      expect(result.state.carry).toBe('</thi');
    });

    it('carries forward partial </ at end', () => {
      const result = parseStreamChunk({
        chunk: 'text</',
        state: { depth: 1, carry: '' },
      });
      expect(result.state.carry).toBe('</');
    });
  });

  describe('mixed tag types', () => {
    it('handles <think> open with </thinking> close', () => {
      const result = parseStreamChunk({ chunk: '<think>data</thinking>' });
      expect(result.thinking).toBe('data');
      expect(result.isInThinkingTag).toBe(false);
    });

    it('handles <thinking> open with </think> close', () => {
      const result = parseStreamChunk({ chunk: '<thinking>data</think>' });
      expect(result.thinking).toBe('data');
      expect(result.isInThinkingTag).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles empty thinking tags', () => {
      const result = parseStreamChunk({ chunk: '<thinking></thinking>' });
      expect(result.visible).toBe('');
      expect(result.thinking).toBe('');
      expect(result.isInThinkingTag).toBe(false);
    });

    it('handles consecutive thinking blocks', () => {
      const result = parseStreamChunk({
        chunk: '<thinking>a</thinking><thinking>b</thinking>',
      });
      expect(result.thinking).toBe('ab');
      expect(result.visible).toBe('');
    });

    it('handles very long content', () => {
      const longText = 'x'.repeat(10000);
      const result = parseStreamChunk({ chunk: `<thinking>${longText}</thinking>` });
      expect(result.thinking.length).toBe(10000);
    });

    it('handles chunk that is exactly a complete tag', () => {
      const result = parseStreamChunk({ chunk: '<thinking>' });
      expect(result.visible).toBe('');
      expect(result.thinking).toBe('');
      expect(result.isInThinkingTag).toBe(true);
    });

    it('handles chunk that is exactly a close tag', () => {
      const result = parseStreamChunk({
        chunk: '</thinking>',
        state: { depth: 1, carry: '' },
      });
      expect(result.isInThinkingTag).toBe(false);
    });
  });
});
