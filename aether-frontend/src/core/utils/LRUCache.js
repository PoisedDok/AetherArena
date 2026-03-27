'use strict';

/**
 * @.architecture
 *
 * Incoming: Domain services needing bounded in-memory caching --- {string key, any value, number ttl}
 * Processing: get(), set(), has(), invalidate(), clear() --- {2 jobs: JOB_CACHE, JOB_EVICT}
 * Outgoing: Cached value or null --- {any}
 *
 * @module core/utils/LRUCache
 */
class LRUCache {
  constructor(maxSize = 50, ttlMs = 5 * 60 * 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check expiration
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  set(key, value) {
    // Remove if exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
    });
  }

  has(key) {
    return this.get(key) !== null;
  }

  invalidate(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }
}

module.exports = { LRUCache };
