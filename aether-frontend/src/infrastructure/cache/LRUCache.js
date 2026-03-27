'use strict';

/**
 * Simple LRU (Least Recently Used) cache
 * 
 * For single-user desktop app - no persistence needed.
 * Auto-expires entries after TTL.
 * 
 * @.architecture
 * Incoming: domain/chat/services/ChatService.js --- {string key, any value, number ttl}
 * Processing: get(), set(), has(), invalidate(), clear() --- {2 jobs: JOB_CACHE, JOB_EVICT}
 * Outgoing: domain/chat/services/ChatService.js --- {cached value or null}
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
            timestamp: Date.now()
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
