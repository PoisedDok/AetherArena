'use strict';

const { ArtifactIndexService } = require('../../../../../src/domain/artifacts/services/ArtifactIndexService');

describe('ArtifactIndexService', () => {
  let service;

  beforeEach(() => {
    service = new ArtifactIndexService();
  });

  describe('track()', () => {
    it('stores requestId → variantKey → artifactId mapping', () => {
      service.track('req-1', 'assistant:code', 'art-1');
      expect(service.find('req-1', 'assistant:code')).toBe('art-1');
    });

    it('supports multiple variants per request', () => {
      service.track('req-1', 'assistant:code', 'art-1');
      service.track('req-1', 'computer:output', 'art-2');

      expect(service.find('req-1', 'assistant:code')).toBe('art-1');
      expect(service.find('req-1', 'computer:output')).toBe('art-2');
    });

    it('overwrites existing variant', () => {
      service.track('req-1', 'assistant:code', 'art-1');
      service.track('req-1', 'assistant:code', 'art-2');
      expect(service.find('req-1', 'assistant:code')).toBe('art-2');
    });

    it('throws on empty requestId', () => {
      expect(() => service.track('', 'v', 'a')).toThrow('requestId');
      expect(() => service.track(null, 'v', 'a')).toThrow('requestId');
    });

    it('throws on empty variantKey', () => {
      expect(() => service.track('r', '', 'a')).toThrow('variantKey');
      expect(() => service.track('r', null, 'a')).toThrow('variantKey');
    });

    it('throws on empty artifactId', () => {
      expect(() => service.track('r', 'v', '')).toThrow('artifactId');
      expect(() => service.track('r', 'v', null)).toThrow('artifactId');
    });
  });

  describe('find()', () => {
    it('returns null for unknown requestId', () => {
      expect(service.find('unknown', 'assistant:code')).toBeNull();
    });

    it('returns null for unknown variantKey', () => {
      service.track('req-1', 'assistant:code', 'art-1');
      expect(service.find('req-1', 'computer:output')).toBeNull();
    });

    it('returns null for falsy params', () => {
      expect(service.find(null, 'v')).toBeNull();
      expect(service.find('r', null)).toBeNull();
      expect(service.find('', '')).toBeNull();
    });
  });

  describe('getVariants()', () => {
    it('returns null for unknown requestId', () => {
      expect(service.getVariants('unknown')).toBeNull();
    });

    it('returns null for falsy requestId', () => {
      expect(service.getVariants(null)).toBeNull();
      expect(service.getVariants('')).toBeNull();
    });

    it('returns variant Map for tracked request', () => {
      service.track('req-1', 'assistant:code', 'art-1');
      service.track('req-1', 'computer:output', 'art-2');

      const variants = service.getVariants('req-1');
      expect(variants).toBeInstanceOf(Map);
      expect(variants.size).toBe(2);
      expect(variants.get('assistant:code')).toBe('art-1');
    });
  });

  describe('has()', () => {
    it('returns false for untracked', () => {
      expect(service.has('unknown')).toBe(false);
    });

    it('returns true for tracked', () => {
      service.track('req-1', 'v', 'a');
      expect(service.has('req-1')).toBe(true);
    });
  });

  describe('remove()', () => {
    it('removes tracked request', () => {
      service.track('req-1', 'v', 'a');
      expect(service.remove('req-1')).toBe(true);
      expect(service.has('req-1')).toBe(false);
    });

    it('returns false for untracked', () => {
      expect(service.remove('unknown')).toBe(false);
    });
  });

  describe('clear()', () => {
    it('removes all entries', () => {
      service.track('req-1', 'v1', 'a1');
      service.track('req-2', 'v2', 'a2');
      service.clear();
      expect(service.size()).toBe(0);
    });
  });

  describe('size()', () => {
    it('returns 0 when empty', () => {
      expect(service.size()).toBe(0);
    });

    it('returns correct count', () => {
      service.track('req-1', 'v', 'a');
      service.track('req-2', 'v', 'a');
      expect(service.size()).toBe(2);
    });
  });

  describe('getRequestIds()', () => {
    it('returns empty array when empty', () => {
      expect(service.getRequestIds()).toEqual([]);
    });

    it('returns all tracked request IDs', () => {
      service.track('req-1', 'v', 'a');
      service.track('req-2', 'v', 'a');
      expect(service.getRequestIds()).toEqual(['req-1', 'req-2']);
    });
  });

  describe('getStats()', () => {
    it('returns zero stats when empty', () => {
      const stats = service.getStats();
      expect(stats.totalRequests).toBe(0);
      expect(stats.totalVariants).toBe(0);
      expect(stats.averageVariantsPerRequest).toBe(0);
    });

    it('calculates accurate stats', () => {
      service.track('req-1', 'v1', 'a1');
      service.track('req-1', 'v2', 'a2');
      service.track('req-2', 'v1', 'a3');

      const stats = service.getStats();
      expect(stats.totalRequests).toBe(2);
      expect(stats.totalVariants).toBe(3);
      expect(stats.averageVariantsPerRequest).toBe('1.50');
    });
  });
});
