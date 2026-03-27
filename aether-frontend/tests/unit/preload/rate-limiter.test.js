'use strict';

const {
  RateLimiter,
  TokenBucket,
  createRateLimiter,
  DEFAULT_LIMITS,
  CHANNEL_CATEGORIES,
} = require('../../../src/preload/common/rate-limiter');

// ============================================================================
// DEFAULT_LIMITS
// ============================================================================
describe('DEFAULT_LIMITS', () => {
  it('should be frozen', () => {
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LIMITS.high)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LIMITS.normal)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LIMITS.low)).toBe(true);
  });

  it('should define high/normal/low categories', () => {
    expect(DEFAULT_LIMITS.high).toBeDefined();
    expect(DEFAULT_LIMITS.normal).toBeDefined();
    expect(DEFAULT_LIMITS.low).toBeDefined();
  });

  it('high should have highest tokensPerInterval', () => {
    expect(DEFAULT_LIMITS.high.tokensPerInterval).toBeGreaterThan(DEFAULT_LIMITS.normal.tokensPerInterval);
    expect(DEFAULT_LIMITS.normal.tokensPerInterval).toBeGreaterThan(DEFAULT_LIMITS.low.tokensPerInterval);
  });

  it('each category should have tokensPerInterval, interval, burst', () => {
    for (const cat of ['high', 'normal', 'low']) {
      expect(DEFAULT_LIMITS[cat]).toHaveProperty('tokensPerInterval');
      expect(DEFAULT_LIMITS[cat]).toHaveProperty('interval');
      expect(DEFAULT_LIMITS[cat]).toHaveProperty('burst');
      expect(typeof DEFAULT_LIMITS[cat].tokensPerInterval).toBe('number');
      expect(typeof DEFAULT_LIMITS[cat].interval).toBe('number');
      expect(typeof DEFAULT_LIMITS[cat].burst).toBe('number');
    }
  });
});

// ============================================================================
// CHANNEL_CATEGORIES
// ============================================================================
describe('CHANNEL_CATEGORIES', () => {
  it('should be frozen', () => {
    expect(Object.isFrozen(CHANNEL_CATEGORIES)).toBe(true);
  });

  it('should assign high-frequency channels', () => {
    expect(CHANNEL_CATEGORIES['chat:assistant-stream']).toBe('high');
    expect(CHANNEL_CATEGORIES['artifacts:stream']).toBe('high');
  });

  it('should assign normal-frequency channels', () => {
    expect(CHANNEL_CATEGORIES['chat:send']).toBe('normal');
    expect(CHANNEL_CATEGORIES['chat:stop']).toBe('normal');
  });

  it('should assign low-frequency channels', () => {
    expect(CHANNEL_CATEGORIES['chat:window-control']).toBe('low');
    expect(CHANNEL_CATEGORIES['zoom-in']).toBe('low');
    expect(CHANNEL_CATEGORIES['zoom-out']).toBe('low');
  });

  it('all values should be high, normal, or low', () => {
    for (const val of Object.values(CHANNEL_CATEGORIES)) {
      expect(['high', 'normal', 'low']).toContain(val);
    }
  });
});

// ============================================================================
// TokenBucket
// ============================================================================
describe('TokenBucket', () => {
  it('should initialize with burst capacity', () => {
    const bucket = new TokenBucket({ tokensPerInterval: 10, interval: 1000, burst: 20 });
    expect(bucket.tokens).toBe(20);
    expect(bucket.tokensPerInterval).toBe(10);
    expect(bucket.interval).toBe(1000);
    expect(bucket.burst).toBe(20);
  });

  describe('tryConsume()', () => {
    it('should consume tokens when available', () => {
      const bucket = new TokenBucket({ tokensPerInterval: 10, interval: 1000, burst: 5 });
      expect(bucket.tryConsume()).toBe(true);
      expect(bucket.tokens).toBe(4);
    });

    it('should consume specified cost', () => {
      const bucket = new TokenBucket({ tokensPerInterval: 10, interval: 1000, burst: 5 });
      expect(bucket.tryConsume(3)).toBe(true);
      expect(bucket.tokens).toBe(2);
    });

    it('should return false when insufficient tokens', () => {
      const bucket = new TokenBucket({ tokensPerInterval: 10, interval: 1000, burst: 2 });
      expect(bucket.tryConsume(3)).toBe(false);
      expect(bucket.tokens).toBe(2); // unchanged
    });

    it('should deplete tokens to zero', () => {
      const bucket = new TokenBucket({ tokensPerInterval: 10, interval: 1000, burst: 3 });
      expect(bucket.tryConsume()).toBe(true); // 2 left
      expect(bucket.tryConsume()).toBe(true); // 1 left
      expect(bucket.tryConsume()).toBe(true); // 0 left
      expect(bucket.tryConsume()).toBe(false); // depleted
    });
  });

  describe('refill()', () => {
    it('should refill tokens after interval elapses', () => {
      const bucket = new TokenBucket({ tokensPerInterval: 10, interval: 100, burst: 20 });
      // Drain tokens
      bucket.tokens = 0;
      // Simulate time passage
      bucket.lastRefill = Date.now() - 200; // 2 intervals elapsed
      bucket.refill();
      expect(bucket.tokens).toBe(20); // 0 + 2*10 = 20, capped at burst
    });

    it('should not refill before interval elapses', () => {
      const bucket = new TokenBucket({ tokensPerInterval: 10, interval: 1000, burst: 20 });
      bucket.tokens = 5;
      bucket.lastRefill = Date.now(); // just now
      bucket.refill();
      expect(bucket.tokens).toBe(5); // unchanged
    });

    it('should cap tokens at burst limit', () => {
      const bucket = new TokenBucket({ tokensPerInterval: 100, interval: 100, burst: 15 });
      bucket.tokens = 10;
      bucket.lastRefill = Date.now() - 200;
      bucket.refill();
      expect(bucket.tokens).toBe(15); // capped at burst, not 10 + 200
    });
  });

  describe('getTokens()', () => {
    it('should return current token count after refill', () => {
      const bucket = new TokenBucket({ tokensPerInterval: 10, interval: 1000, burst: 20 });
      bucket.tokens = 5;
      bucket.lastRefill = Date.now(); // no refill needed
      expect(bucket.getTokens()).toBe(5);
    });

    it('should trigger refill before returning', () => {
      const bucket = new TokenBucket({ tokensPerInterval: 5, interval: 100, burst: 10 });
      bucket.tokens = 0;
      bucket.lastRefill = Date.now() - 200; // 2 intervals
      expect(bucket.getTokens()).toBe(10); // 0 + 2*5 = 10, capped at burst
    });
  });
});

// ============================================================================
// RateLimiter — constructor
// ============================================================================
describe('RateLimiter constructor', () => {
  it('should use defaults when no options provided', () => {
    const rl = new RateLimiter();
    expect(rl.enabled).toBe(true);
    expect(rl.onRateLimited).toBeNull();
    expect(rl.buckets).toBeInstanceOf(Map);
    expect(rl.buckets.size).toBe(0);
  });

  it('should accept custom limits', () => {
    const customLimits = { high: { tokensPerInterval: 200, interval: 500, burst: 300 } };
    const rl = new RateLimiter({ limits: customLimits });
    expect(rl.limits.high.tokensPerInterval).toBe(200);
    // Other categories preserved from defaults
    expect(rl.limits.normal).toBeDefined();
  });

  it('should accept custom categories', () => {
    const rl = new RateLimiter({ categories: { 'custom:ch': 'high' } });
    expect(rl.categories['custom:ch']).toBe('high');
    // Defaults preserved
    expect(rl.categories['chat:send']).toBe('normal');
  });

  it('should accept enabled=false', () => {
    const rl = new RateLimiter({ enabled: false });
    expect(rl.enabled).toBe(false);
  });

  it('should accept onRateLimited callback', () => {
    const cb = jest.fn();
    const rl = new RateLimiter({ onRateLimited: cb });
    expect(rl.onRateLimited).toBe(cb);
  });

  it('should initialize stats', () => {
    const rl = new RateLimiter();
    expect(rl.stats.totalCalls).toBe(0);
    expect(rl.stats.rateLimited).toBe(0);
    expect(rl.stats.byChannel).toBeInstanceOf(Map);
  });
});

// ============================================================================
// RateLimiter.check()
// ============================================================================
describe('RateLimiter.check()', () => {
  it('should allow calls when tokens available', () => {
    const rl = new RateLimiter();
    expect(rl.check('chat:send')).toBe(true);
  });

  it('should always return true when disabled', () => {
    const rl = new RateLimiter({ enabled: false });
    // Even after exhausting would-be tokens
    for (let i = 0; i < 100; i++) {
      expect(rl.check('chat:send')).toBe(true);
    }
    // Stats should NOT be updated
    expect(rl.stats.totalCalls).toBe(0);
  });

  it('should rate-limit after tokens exhausted', () => {
    const rl = new RateLimiter({
      limits: {
        normal: { tokensPerInterval: 1, interval: 60000, burst: 2 },
        high: DEFAULT_LIMITS.high,
        low: DEFAULT_LIMITS.low,
      },
    });
    expect(rl.check('chat:send')).toBe(true);  // 1 token left
    expect(rl.check('chat:send')).toBe(true);  // 0 tokens left
    expect(rl.check('chat:send')).toBe(false); // rate limited
  });

  it('should use the correct category bucket for channels', () => {
    const rl = new RateLimiter({
      limits: {
        high: { tokensPerInterval: 1, interval: 60000, burst: 1 },
        normal: { tokensPerInterval: 1, interval: 60000, burst: 100 },
        low: { tokensPerInterval: 1, interval: 60000, burst: 100 },
      },
    });
    // High-frequency channel with burst=1
    expect(rl.check('chat:assistant-stream')).toBe(true); // uses burst of 1
    expect(rl.check('chat:assistant-stream')).toBe(false); // exhausted
    // Normal channel still has tokens
    expect(rl.check('chat:send')).toBe(true);
  });

  it('should default uncategorized channels to "normal"', () => {
    const rl = new RateLimiter({
      limits: {
        high: DEFAULT_LIMITS.high,
        normal: { tokensPerInterval: 1, interval: 60000, burst: 1 },
        low: DEFAULT_LIMITS.low,
      },
    });
    expect(rl.check('unknown:channel')).toBe(true);  // uses normal, burst=1
    expect(rl.check('unknown:channel')).toBe(false); // exhausted
  });

  it('should call onRateLimited callback when rate-limited', () => {
    const cb = jest.fn();
    const rl = new RateLimiter({
      onRateLimited: cb,
      limits: {
        normal: { tokensPerInterval: 1, interval: 60000, burst: 1 },
        high: DEFAULT_LIMITS.high,
        low: DEFAULT_LIMITS.low,
      },
    });
    rl.check('chat:send'); // allowed
    rl.check('chat:send'); // rate limited — should call cb
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('chat:send', expect.objectContaining({
      tokens: expect.any(Number),
      burst: 1,
    }));
  });

  it('should NOT call onRateLimited when allowed', () => {
    const cb = jest.fn();
    const rl = new RateLimiter({ onRateLimited: cb });
    rl.check('chat:send');
    expect(cb).not.toHaveBeenCalled();
  });

  it('should update stats on each call', () => {
    const rl = new RateLimiter({
      limits: {
        normal: { tokensPerInterval: 1, interval: 60000, burst: 1 },
        high: DEFAULT_LIMITS.high,
        low: DEFAULT_LIMITS.low,
      },
    });
    rl.check('chat:send'); // allowed
    rl.check('chat:send'); // rate limited
    expect(rl.stats.totalCalls).toBe(2);
    expect(rl.stats.rateLimited).toBe(1);
  });

  it('should track per-channel stats', () => {
    const rl = new RateLimiter();
    rl.check('chat:send');
    rl.check('chat:send');
    rl.check('zoom-in');
    expect(rl.stats.byChannel.get('chat:send').total).toBe(2);
    expect(rl.stats.byChannel.get('zoom-in').total).toBe(1);
  });

  it('should accept cost parameter', () => {
    const rl = new RateLimiter({
      limits: {
        normal: { tokensPerInterval: 1, interval: 60000, burst: 5 },
        high: DEFAULT_LIMITS.high,
        low: DEFAULT_LIMITS.low,
      },
    });
    expect(rl.check('chat:send', 3)).toBe(true);  // 2 left
    expect(rl.check('chat:send', 3)).toBe(false); // not enough
  });
});

// ============================================================================
// RateLimiter.getTokens()
// ============================================================================
describe('RateLimiter.getTokens()', () => {
  it('should return token count for a channel', () => {
    const rl = new RateLimiter();
    const tokens = rl.getTokens('chat:send');
    expect(typeof tokens).toBe('number');
    expect(tokens).toBe(DEFAULT_LIMITS.normal.burst); // initial burst
  });

  it('should reflect consumed tokens', () => {
    const rl = new RateLimiter();
    const initial = rl.getTokens('chat:send');
    rl.check('chat:send');
    expect(rl.getTokens('chat:send')).toBe(initial - 1);
  });
});

// ============================================================================
// RateLimiter.getStats()
// ============================================================================
describe('RateLimiter.getStats()', () => {
  it('should return initial stats', () => {
    const rl = new RateLimiter();
    const stats = rl.getStats();
    expect(stats.totalCalls).toBe(0);
    expect(stats.rateLimited).toBe(0);
    expect(stats.rateLimitedPercent).toBe(0);
    expect(stats.byChannel).toEqual({});
  });

  it('should compute rateLimitedPercent', () => {
    const rl = new RateLimiter({
      limits: {
        normal: { tokensPerInterval: 1, interval: 60000, burst: 1 },
        high: DEFAULT_LIMITS.high,
        low: DEFAULT_LIMITS.low,
      },
    });
    rl.check('chat:send'); // allowed
    rl.check('chat:send'); // limited
    const stats = rl.getStats();
    expect(stats.rateLimitedPercent).toBe('50.00');
  });

  it('should convert byChannel Map to plain object', () => {
    const rl = new RateLimiter();
    rl.check('chat:send');
    const stats = rl.getStats();
    expect(typeof stats.byChannel).toBe('object');
    expect(stats.byChannel).not.toBeInstanceOf(Map);
    expect(stats.byChannel['chat:send']).toBeDefined();
    expect(stats.byChannel['chat:send'].total).toBe(1);
    expect(stats.byChannel['chat:send'].limited).toBe(0);
  });

  it('should include per-channel limitedPercent', () => {
    const rl = new RateLimiter({
      limits: {
        normal: { tokensPerInterval: 1, interval: 60000, burst: 2 },
        high: DEFAULT_LIMITS.high,
        low: DEFAULT_LIMITS.low,
      },
    });
    rl.check('chat:send'); // allowed
    rl.check('chat:send'); // allowed
    rl.check('chat:send'); // limited
    const stats = rl.getStats();
    expect(stats.byChannel['chat:send'].limitedPercent).toBe('33.33');
  });
});

// ============================================================================
// RateLimiter.resetStats()
// ============================================================================
describe('RateLimiter.resetStats()', () => {
  it('should reset all stats to initial state', () => {
    const rl = new RateLimiter();
    rl.check('chat:send');
    rl.check('chat:send');
    rl.resetStats();
    expect(rl.stats.totalCalls).toBe(0);
    expect(rl.stats.rateLimited).toBe(0);
    expect(rl.stats.byChannel.size).toBe(0);
  });

  it('should allow fresh accumulation after reset', () => {
    const rl = new RateLimiter();
    rl.check('chat:send');
    rl.resetStats();
    rl.check('zoom-in');
    expect(rl.stats.totalCalls).toBe(1);
    expect(rl.stats.byChannel.has('chat:send')).toBe(false);
    expect(rl.stats.byChannel.has('zoom-in')).toBe(true);
  });
});

// ============================================================================
// RateLimiter.enable() / disable()
// ============================================================================
describe('RateLimiter.enable() / disable()', () => {
  it('should disable rate limiting', () => {
    const rl = new RateLimiter({
      limits: {
        normal: { tokensPerInterval: 1, interval: 60000, burst: 1 },
        high: DEFAULT_LIMITS.high,
        low: DEFAULT_LIMITS.low,
      },
    });
    rl.check('chat:send'); // exhaust tokens
    rl.disable();
    expect(rl.check('chat:send')).toBe(true); // bypassed
    expect(rl.enabled).toBe(false);
  });

  it('should re-enable rate limiting', () => {
    const rl = new RateLimiter({
      limits: {
        normal: { tokensPerInterval: 1, interval: 60000, burst: 1 },
        high: DEFAULT_LIMITS.high,
        low: DEFAULT_LIMITS.low,
      },
    });
    rl.check('chat:send'); // exhaust tokens
    rl.disable();
    rl.enable();
    expect(rl.check('chat:send')).toBe(false); // enforced again, tokens still exhausted
    expect(rl.enabled).toBe(true);
  });
});

// ============================================================================
// RateLimiter.clear()
// ============================================================================
describe('RateLimiter.clear()', () => {
  it('should clear all buckets', () => {
    const rl = new RateLimiter();
    rl.check('chat:send');
    rl.check('zoom-in');
    expect(rl.buckets.size).toBe(2);
    rl.clear();
    expect(rl.buckets.size).toBe(0);
  });

  it('should create fresh buckets on next check', () => {
    const rl = new RateLimiter({
      limits: {
        normal: { tokensPerInterval: 1, interval: 60000, burst: 1 },
        high: DEFAULT_LIMITS.high,
        low: DEFAULT_LIMITS.low,
      },
    });
    rl.check('chat:send'); // exhaust
    expect(rl.check('chat:send')).toBe(false); // limited
    rl.clear();
    expect(rl.check('chat:send')).toBe(true); // fresh bucket
  });
});

// ============================================================================
// createRateLimiter()
// ============================================================================
describe('createRateLimiter()', () => {
  it('should return a RateLimiter instance', () => {
    expect(createRateLimiter()).toBeInstanceOf(RateLimiter);
  });

  it('should pass options through', () => {
    const rl = createRateLimiter({ enabled: false });
    expect(rl.enabled).toBe(false);
  });
});
