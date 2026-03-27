// tests/unit/core/security/RateLimiter.test.js

const { RateLimiter, RateLimitError, TokenBucket } = require('../../../../src/core/security/RateLimiter');

describe('Token Bucket', () => {
  let bucket;
  
  beforeEach(() => {
    bucket = new TokenBucket({
      tokensPerSecond: 10,
      burstCapacity: 20,
    });
  });
  
  test('should initialize with full capacity', () => {
    expect(bucket.tokens).toBe(20);
    expect(bucket.tokensPerSecond).toBe(10);
    expect(bucket.burstCapacity).toBe(20);
  });
  
  test('should consume tokens successfully', () => {
    expect(bucket.tryConsume(5)).toBe(true);
    expect(bucket.getTokens()).toBeLessThan(20);
  });
  
  test('should reject when insufficient tokens', () => {
    expect(bucket.tryConsume(25)).toBe(false);
    expect(bucket.getTokens()).toBe(20);
  });
  
  test('should refill tokens over time', (done) => {
    bucket.tryConsume(15);
    const tokensAfter = bucket.getTokens();
    
    setTimeout(() => {
      expect(bucket.getTokens()).toBeGreaterThan(tokensAfter);
      done();
    }, 100);
  });
  
  test('should get retry time correctly', () => {
    bucket.tryConsume(20);
    const retryAfter = bucket.getRetryAfter();
    expect(retryAfter).toBeGreaterThan(0);
  });
  
  test('should return info object', () => {
    const info = bucket.getInfo();
    expect(info).toHaveProperty('tokens');
    expect(info).toHaveProperty('capacity');
    expect(info).toHaveProperty('rate');
    expect(info).toHaveProperty('retryAfter');
  });
});

describe('Rate Limiter', () => {
  let rateLimiter;
  
  beforeEach(() => {
    rateLimiter = new RateLimiter({
      enabled: true,
      limits: {
        test: {
          tokensPerSecond: 10,
          burstCapacity: 20,
        },
      },
    });
  });
  
  describe('Initialization', () => {
    test('should create instance with custom options', () => {
      expect(rateLimiter).toBeDefined();
      expect(rateLimiter.enabled).toBe(true);
      expect(rateLimiter.limits).toBeDefined();
    });
    
    test('should initialize with default limits', () => {
      const defaultLimiter = new RateLimiter();
      expect(defaultLimiter.enabled).toBe(true);
      expect(defaultLimiter.limits.api).toBeDefined();
      expect(defaultLimiter.limits.streaming).toBeDefined();
    });
    
    test('should initialize empty bucket map', () => {
      expect(rateLimiter.buckets.size).toBe(0);
    });
    
    test('should initialize statistics', () => {
      const stats = rateLimiter.getStats();
      expect(stats.totalRequests).toBe(0);
      expect(stats.rateLimited).toBe(0);
    });
  });
  
  describe('Rate Limiting with tryConsume', () => {
    test('should allow requests under limit', () => {
      const result = rateLimiter.tryConsume('endpoint-1', { category: 'test' });
      expect(result.allowed).toBe(true);
      expect(result.retryAfter).toBe(0);
    });
    
    test('should rate limit when over capacity', () => {
      // Consume all tokens
      for (let i = 0; i < 20; i++) {
        rateLimiter.tryConsume('endpoint-1', { category: 'test', cost: 1 });
      }
      
      const result = rateLimiter.tryConsume('endpoint-1', { category: 'test' });
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });
    
    test('should handle different categories', () => {
      const result1 = rateLimiter.tryConsume('endpoint-1', { category: 'api' });
      const result2 = rateLimiter.tryConsume('endpoint-1', { category: 'streaming' });
      
      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
    });
    
    test('should handle custom costs', () => {
      const result = rateLimiter.tryConsume('endpoint-1', { category: 'test', cost: 15 });
      expect(result.allowed).toBe(true);
      
      const result2 = rateLimiter.tryConsume('endpoint-1', { category: 'test', cost: 10 });
      expect(result2.allowed).toBe(false);
    });
    
    test('should track separate endpoints independently', () => {
      rateLimiter.tryConsume('endpoint-1', { category: 'test', cost: 15 });
      
      const result = rateLimiter.tryConsume('endpoint-2', { category: 'test', cost: 15 });
      expect(result.allowed).toBe(true);
    });
  });
  
  describe('Rate Limiting with check (throws)', () => {
    test('should not throw when under limit', () => {
      expect(() => {
        rateLimiter.check('endpoint-1', { category: 'test' });
      }).not.toThrow();
    });
    
    test('should throw RateLimitError when over limit', () => {
      for (let i = 0; i < 20; i++) {
        rateLimiter.check('endpoint-1', { category: 'test' });
      }
      
      expect(() => {
        rateLimiter.check('endpoint-1', { category: 'test' });
      }).toThrow(RateLimitError);
    });
    
    test('should throw error with retry information', () => {
      for (let i = 0; i < 20; i++) {
        rateLimiter.tryConsume('endpoint-1', { category: 'test' });
      }
      
      try {
        rateLimiter.check('endpoint-1', { category: 'test' });
        fail('Should have thrown');
      } catch (error) {
        expect(error.isRateLimitError).toBe(true);
        expect(error.retryAfter).toBeGreaterThan(0);
      }
    });
  });
  
  describe('Statistics', () => {
    test('should track total requests', () => {
      rateLimiter.tryConsume('endpoint-1');
      rateLimiter.tryConsume('endpoint-2');
      rateLimiter.tryConsume('endpoint-1');
      
      const stats = rateLimiter.getStats();
      expect(stats.totalRequests).toBe(3);
    });
    
    test('should track rate limited requests', () => {
      for (let i = 0; i < 25; i++) {
        rateLimiter.tryConsume('endpoint-1', { category: 'test' });
      }
      
      const stats = rateLimiter.getStats();
      expect(stats.rateLimited).toBeGreaterThan(0);
    });
    
    test('should track per-endpoint statistics', () => {
      rateLimiter.tryConsume('endpoint-1');
      rateLimiter.tryConsume('endpoint-1');
      rateLimiter.tryConsume('endpoint-2');
      
      const stats = rateLimiter.getStats();
      expect(stats.byEndpoint).toBeDefined();
    });
  });
  
  describe('Callbacks', () => {
    test('should call onRateLimited callback', () => {
      const onRateLimited = jest.fn();
      const limiter = new RateLimiter({
        enabled: true,
        limits: {
          test: {
            tokensPerSecond: 1,
            burstCapacity: 2,
          },
        },
        onRateLimited,
      });
      
      // Consume all tokens
      limiter.check('endpoint-1', { category: 'test', cost: 2 });
      
      // This should trigger rate limit and callback
      try {
        limiter.check('endpoint-1', { category: 'test', cost: 2 });
      } catch (e) {
        // Expected to throw
      }
      
      expect(onRateLimited).toHaveBeenCalled();
    });
    
    test('should call onRequestAllowed callback', (done) => {
      const onRequestAllowed = jest.fn();
      const limiter = new RateLimiter({
        enabled: true,
        onRequestAllowed,
      });
      
      limiter.check('endpoint-1');
      
      expect(onRequestAllowed).toHaveBeenCalled();
      done();
    });
  });
  
  describe('Endpoint Info', () => {
    test('should get info for specific endpoint', () => {
      rateLimiter.tryConsume('endpoint-1', { category: 'test' });
      
      const info = rateLimiter.getInfo('endpoint-1', 'test');
      expect(info).toBeDefined();
      expect(info.tokens).toBeDefined();
      expect(info.capacity).toBeDefined();
    });
    
    test('should create bucket if not exists', () => {
      const info = rateLimiter.getInfo('new-endpoint', 'test');
      expect(info).toBeDefined();
      expect(rateLimiter.buckets.has('new-endpoint')).toBe(true);
    });
  });
  
  describe('Reset and Cleanup', () => {
    test('should clear all buckets', () => {
      rateLimiter.tryConsume('endpoint-1');
      rateLimiter.tryConsume('endpoint-2');
      
      rateLimiter.clear();
      
      expect(rateLimiter.buckets.size).toBe(0);
    });
    
    test('should reset statistics', () => {
      rateLimiter.tryConsume('endpoint-1');
      rateLimiter.tryConsume('endpoint-2');
      
      rateLimiter.resetStats();
      
      const stats = rateLimiter.getStats();
      expect(stats.totalRequests).toBe(0);
      expect(stats.rateLimited).toBe(0);
    });
  });
  
  describe('Disable/Enable', () => {
    test('should allow all requests when disabled', () => {
      const disabledLimiter = new RateLimiter({ enabled: false });
      
      for (let i = 0; i < 100; i++) {
        const result = disabledLimiter.tryConsume('endpoint-1');
        expect(result.allowed).toBe(true);
      }
    });
    
    test('should not throw when disabled', () => {
      const disabledLimiter = new RateLimiter({ enabled: false });
      
      expect(() => {
        for (let i = 0; i < 100; i++) {
          disabledLimiter.check('endpoint-1');
        }
      }).not.toThrow();
    });
    
    test('should toggle enabled state', () => {
      rateLimiter.disable();
      expect(rateLimiter.isEnabled()).toBe(false);
      
      rateLimiter.enable();
      expect(rateLimiter.isEnabled()).toBe(true);
    });
  });
  
  describe('Edge Cases', () => {
    test('should handle empty endpoint name', () => {
      const result = rateLimiter.tryConsume('');
      expect(result.allowed).toBe(true);
    });
    
    test('should handle undefined category', () => {
      const result = rateLimiter.tryConsume('endpoint-1');
      expect(result.allowed).toBe(true);
    });
    
    test('should handle zero cost', () => {
      const result = rateLimiter.tryConsume('endpoint-1', { cost: 0 });
      expect(result.allowed).toBe(true);
    });
    
    test('should handle negative cost', () => {
      const result = rateLimiter.tryConsume('endpoint-1', { cost: -1 });
      expect(result.allowed).toBe(true);
    });
  });
});
