'use strict';

const { ArtifactValidator } = require('../../../../../src/domain/artifacts/validators/ArtifactValidator');

describe('ArtifactValidator', () => {
  const validArtifact = {
    id: 'art-1', type: 'code', content: 'const x = 1;',
    timestamp: Date.now(), sourceMessageId: null, chatId: null, status: 'active'
  };

  describe('validate()', () => {
    it('should accept valid artifact', () => {
      const result = ArtifactValidator.validate(validArtifact);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should reject null/non-object', () => {
      expect(ArtifactValidator.validate(null).valid).toBe(false);
      expect(ArtifactValidator.validate('string').valid).toBe(false);
    });

    it('should require string id', () => {
      const result = ArtifactValidator.validate({ ...validArtifact, id: null });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('string id'))).toBe(true);
    });

    it('should require valid type', () => {
      const result = ArtifactValidator.validate({ ...validArtifact, type: 'invalid' });
      expect(result.valid).toBe(false);
    });

    it('should require string content', () => {
      const result = ArtifactValidator.validate({ ...validArtifact, content: 123 });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('content'))).toBe(true);
    });

    it('should require numeric timestamp', () => {
      const result = ArtifactValidator.validate({ ...validArtifact, timestamp: 'not-a-number' });
      expect(result.valid).toBe(false);
    });

    it('should validate sourceMessageId if present', () => {
      const result = ArtifactValidator.validate({
        ...validArtifact, sourceMessageId: 'invalid-id'
      });
      expect(result.valid).toBe(false);
    });

    it('should accept msg_ prefix for sourceMessageId', () => {
      const result = ArtifactValidator.validate({
        ...validArtifact, sourceMessageId: 'msg_12345_abc'
      });
      expect(result.valid).toBe(true);
    });

    it('should accept UUID for sourceMessageId', () => {
      const result = ArtifactValidator.validate({
        ...validArtifact, sourceMessageId: '550e8400-e29b-41d4-a716-446655440000'
      });
      expect(result.valid).toBe(true);
    });

    it('should validate chatId if present', () => {
      const result = ArtifactValidator.validate({
        ...validArtifact, chatId: 'not-a-uuid'
      });
      expect(result.valid).toBe(false);
    });

    it('should validate status if present', () => {
      const result = ArtifactValidator.validate({
        ...validArtifact, status: 'bogus'
      });
      expect(result.valid).toBe(false);
    });

    it('should accumulate multiple errors', () => {
      const result = ArtifactValidator.validate({
        id: null, type: 'bad', content: 123, timestamp: null
      });
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('isValidType()', () => {
    it('should accept valid types', () => {
      ['code', 'output', 'html', 'file', 'console'].forEach(t => {
        expect(ArtifactValidator.isValidType(t)).toBe(true);
      });
    });

    it('should be case insensitive', () => {
      expect(ArtifactValidator.isValidType('CODE')).toBe(true);
      expect(ArtifactValidator.isValidType('Html')).toBe(true);
    });

    it('should reject invalid types', () => {
      expect(ArtifactValidator.isValidType('image')).toBe(false);
      expect(ArtifactValidator.isValidType('')).toBe(false);
      expect(ArtifactValidator.isValidType(123)).toBe(false);
    });
  });

  describe('stream/persistence type helpers', () => {
    it('should normalize legacy stream aliases to canonical output', () => {
      expect(ArtifactValidator.normalizeStreamType('html')).toBe('output');
      expect(ArtifactValidator.normalizeStreamType('console')).toBe('output');
      expect(ArtifactValidator.normalizeStreamType('markdown')).toBe('output');
      expect(ArtifactValidator.normalizeStreamType('code')).toBe('code');
    });

    it('should validate persistence types separately from model types', () => {
      expect(ArtifactValidator.isValidPersistenceType('code')).toBe(true);
      expect(ArtifactValidator.isValidPersistenceType('output')).toBe(true);
      expect(ArtifactValidator.isValidPersistenceType('file')).toBe(true);
      expect(ArtifactValidator.isValidPersistenceType('html')).toBe(false);
      expect(ArtifactValidator.isValidPersistenceType('console')).toBe(false);
    });
  });

  describe('isValidStatus()', () => {
    it('should accept valid statuses', () => {
      ['streaming', 'active', 'archived', 'deleted'].forEach(s => {
        expect(ArtifactValidator.isValidStatus(s)).toBe(true);
      });
    });

    it('should reject invalid statuses', () => {
      expect(ArtifactValidator.isValidStatus('pending')).toBe(false);
    });
  });

  describe('isValidMessageId()', () => {
    it('should accept msg_ prefix', () => {
      expect(ArtifactValidator.isValidMessageId('msg_123')).toBe(true);
    });

    it('should accept UUID', () => {
      expect(ArtifactValidator.isValidMessageId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('should reject non-string', () => {
      expect(ArtifactValidator.isValidMessageId(123)).toBe(false);
    });

    it('should reject invalid format', () => {
      expect(ArtifactValidator.isValidMessageId('random-string')).toBe(false);
    });
  });

  describe('isValidChatId()', () => {
    it('should accept UUID', () => {
      expect(ArtifactValidator.isValidChatId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('should reject non-UUID', () => {
      expect(ArtifactValidator.isValidChatId('chat_123')).toBe(false);
      expect(ArtifactValidator.isValidChatId(123)).toBe(false);
    });
  });

  describe('validateContent()', () => {
    it('should accept valid content', () => {
      expect(ArtifactValidator.validateContent('hello').valid).toBe(true);
    });

    it('should reject non-string', () => {
      expect(ArtifactValidator.validateContent(123).valid).toBe(false);
    });

    it('should reject empty when not allowed', () => {
      expect(ArtifactValidator.validateContent('', { allowEmpty: false }).valid).toBe(false);
    });

    it('should allow empty by default', () => {
      expect(ArtifactValidator.validateContent('').valid).toBe(true);
    });

    it('should reject oversized content', () => {
      const big = 'x'.repeat(11 * 1024 * 1024);
      expect(ArtifactValidator.validateContent(big).valid).toBe(false);
    });

    it('should accept custom maxSize', () => {
      expect(ArtifactValidator.validateContent('hello', { maxSize: 3 }).valid).toBe(false);
    });
  });

  describe('validateForPersistence()', () => {
    it('should reject non-persistence artifact types', () => {
      const result = ArtifactValidator.validateForPersistence({
        chatId: '550e8400-e29b-41d4-a716-446655440000', content: 'x', type: 'html'
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('one of'))).toBe(true);
    });

    it('should require valid chatId UUID', () => {
      const result = ArtifactValidator.validateForPersistence({ chatId: 'not-uuid', content: 'x', type: 'code' });
      expect(result.valid).toBe(false);
    });

    it('should require non-empty content for non-output types', () => {
      const result = ArtifactValidator.validateForPersistence({
        chatId: '550e8400-e29b-41d4-a716-446655440000', content: '', type: 'code'
      });
      expect(result.valid).toBe(false);
    });

    it('should allow empty content for output type', () => {
      const result = ArtifactValidator.validateForPersistence({
        chatId: '550e8400-e29b-41d4-a716-446655440000', content: '', type: 'output'
      });
      expect(result.valid).toBe(true);
    });

    it('should require UUID for sourceMessageId if present', () => {
      const result = ArtifactValidator.validateForPersistence({
        chatId: '550e8400-e29b-41d4-a716-446655440000', content: 'x', type: 'code',
        sourceMessageId: 'msg_temp_id'
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('validateMetadata()', () => {
    it('should accept null/undefined', () => {
      expect(ArtifactValidator.validateMetadata(null).valid).toBe(true);
      expect(ArtifactValidator.validateMetadata(undefined).valid).toBe(true);
    });

    it('should accept valid objects', () => {
      expect(ArtifactValidator.validateMetadata({ key: 'val' }).valid).toBe(true);
    });

    it('should reject non-objects', () => {
      expect(ArtifactValidator.validateMetadata('string').valid).toBe(false);
    });

    it('should reject oversized metadata', () => {
      const big = { data: 'x'.repeat(101 * 1024) };
      expect(ArtifactValidator.validateMetadata(big).valid).toBe(false);
    });

    it('should reject non-JSON-serializable metadata (circular reference)', () => {
      const circular = { a: 1 };
      circular.self = circular;
      const result = ArtifactValidator.validateMetadata(circular);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Metadata must be JSON-serializable');
    });
  });

  describe('sanitizeContent()', () => {
    it('should preserve code and output', () => {
      expect(ArtifactValidator.sanitizeContent('<script>alert(1)</script>', 'code'))
        .toBe('<script>alert(1)</script>');
      expect(ArtifactValidator.sanitizeContent('<b>text</b>', 'output'))
        .toBe('<b>text</b>');
    });

    it('should strip scripts from html', () => {
      const result = ArtifactValidator.sanitizeContent(
        '<div>hello</div><script>alert(1)</script>', 'html'
      );
      expect(result).not.toContain('<script>');
      expect(result).toContain('<div>hello</div>');
    });

    it('should strip event handlers from html', () => {
      const result = ArtifactValidator.sanitizeContent(
        '<div onclick="alert(1)">click</div>', 'html'
      );
      expect(result).not.toContain('onclick');
    });

    it('should return empty string for non-string', () => {
      expect(ArtifactValidator.sanitizeContent(123, 'code')).toBe('');
    });

    it('should return content as-is for non-code/output/html types', () => {
      // Types like text, markdown, json — no special sanitization
      expect(ArtifactValidator.sanitizeContent('plain text', 'text')).toBe('plain text');
      expect(ArtifactValidator.sanitizeContent('# heading', 'markdown')).toBe('# heading');
      expect(ArtifactValidator.sanitizeContent('{"a":1}', 'json')).toBe('{"a":1}');
    });
  });

  describe('validateFileName()', () => {
    it('should accept valid filenames', () => {
      expect(ArtifactValidator.validateFileName('artifact.py').valid).toBe(true);
    });

    it('should reject empty/null', () => {
      expect(ArtifactValidator.validateFileName('').valid).toBe(false);
      expect(ArtifactValidator.validateFileName(null).valid).toBe(false);
    });

    it('should reject invalid characters', () => {
      expect(ArtifactValidator.validateFileName('file<name>.txt').valid).toBe(false);
    });

    it('should reject overly long names', () => {
      expect(ArtifactValidator.validateFileName('a'.repeat(256)).valid).toBe(false);
    });
  });

  describe('validateStreamData()', () => {
    it('should accept valid stream data', () => {
      const result = ArtifactValidator.validateStreamData({
        id: 'stream-1', kind: 'code',
        chatId: '550e8400-e29b-41d4-a716-446655440000'
      });
      expect(result.valid).toBe(true);
    });

    it('should reject null', () => {
      expect(ArtifactValidator.validateStreamData(null).valid).toBe(false);
    });

    it('should require id', () => {
      const result = ArtifactValidator.validateStreamData({
        kind: 'code', chatId: '550e8400-e29b-41d4-a716-446655440000'
      });
      expect(result.valid).toBe(false);
    });

    it('should validate role if present', () => {
      const result = ArtifactValidator.validateStreamData({
        id: 's1', kind: 'code',
        chatId: '550e8400-e29b-41d4-a716-446655440000',
        role: 'hacker'
      });
      expect(result.valid).toBe(false);
    });

    it('should accept legacy stream aliases normalized to output', () => {
      const result = ArtifactValidator.validateStreamData({
        id: 's1', kind: 'html',
        chatId: '550e8400-e29b-41d4-a716-446655440000'
      });
      expect(result.valid).toBe(true);
    });

    it('should reject file kind for stream contract', () => {
      const result = ArtifactValidator.validateStreamData({
        id: 's1', kind: 'file',
        chatId: '550e8400-e29b-41d4-a716-446655440000'
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('code, output'))).toBe(true);
    });

    it('should reject stream data with invalid kind/type', () => {
      const result = ArtifactValidator.validateStreamData({
        id: 's1', kind: 'nonexistent-type',
        chatId: '550e8400-e29b-41d4-a716-446655440000'
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('kind'))).toBe(true);
    });

    it('should reject stream data with invalid chatId (non-UUID)', () => {
      const result = ArtifactValidator.validateStreamData({
        id: 's1', kind: 'code',
        chatId: 'not-a-uuid'
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('chat UUID'))).toBe(true);
    });
  });
});
