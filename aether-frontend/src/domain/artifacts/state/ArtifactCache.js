'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController (set/get/delete artifact operations) --- {artifact_types.*, object}
 * Processing: LRU cache management - track access order, evict least recently used entries, enforce size/count limits, maintain metadata --- {5 jobs: JOB_UPDATE_STATE, JOB_TRACK_ENTITY, JOB_EVICT_CACHE, JOB_VALIDATE_SCHEMA, JOB_MONITOR_PERFORMANCE}
 * Outgoing: Return cached artifacts or null --- {artifact_types.*, object | null}
 * 
 * ARCHITECTURE:
 * - Least Recently Used (LRU) cache eviction policy
 * - Bounded memory growth (max size + max entries)
 * - Prevents unbounded Map growth (original issue)
 * - Fast O(1) get/set/delete operations
 * - Automatic eviction on size/count limits
 * - Testable in isolation
 * 
 * SCALABILITY:
 * - Max entries: 1000 artifacts (configurable)
 * - Max size: 100MB total (configurable)
 * - LRU eviction prevents memory leaks
 * - Metrics for cache hit/miss tracking
 * 
 * @module domain/artifacts/state/ArtifactCache
 */

const { createLogger } = require('../../../core/utils/logger');
const { freeze } = Object;

// Default cache configuration
const DEFAULT_CONFIG = freeze({
  MAX_ENTRIES: 1000,          // Maximum number of artifacts
  MAX_TOTAL_SIZE: 100 * 1024 * 1024, // 100MB max total size
  MAX_ARTIFACT_SIZE: 50 * 1024 * 1024, // 50MB per artifact
  ENABLE_METRICS: true         // Enable cache metrics tracking
});

class ArtifactCache {
  /**
   * Create artifact cache
   * @param {Object} config - Cache configuration
   * @param {number} config.maxEntries - Maximum number of entries
   * @param {number} config.maxTotalSize - Maximum total size in bytes
   * @param {number} config.maxArtifactSize - Maximum size per artifact
   * @param {boolean} config.enableMetrics - Enable metrics tracking
   */
  constructor(config = {}) {
    this.config = {
      maxEntries: config.maxEntries || DEFAULT_CONFIG.MAX_ENTRIES,
      maxTotalSize: config.maxTotalSize || DEFAULT_CONFIG.MAX_TOTAL_SIZE,
      maxArtifactSize: config.maxArtifactSize || DEFAULT_CONFIG.MAX_ARTIFACT_SIZE,
      enableMetrics: config.enableMetrics !== undefined ? config.enableMetrics : DEFAULT_CONFIG.ENABLE_METRICS
    };
    this.log = createLogger({ component: 'ArtifactCache' });

    // Use Map for O(1) access (insertion order preserved)
    this.cache = new Map();
    
    // Track total size
    this.totalSize = 0;
    
    // Metrics
    this.metrics = {
      hits: 0,
      misses: 0,
      evictions: 0,
      sets: 0,
      deletes: 0,
      sizeEvictions: 0,
      countEvictions: 0
    };
  }

  /**
   * Get artifact from cache
   * @param {string} id - Artifact ID
   * @returns {Object|null} Artifact or null if not found
   */
  get(id) {
    if (!id || typeof id !== 'string') {
      throw new Error('[ArtifactCache] ID must be a non-empty string');
    }

    const entry = this.cache.get(id);
    
    if (entry) {
      // LRU: Move to end (most recently used)
      this.cache.delete(id);
      this.cache.set(id, entry);
      
      // Update metrics
      if (this.config.enableMetrics) {
        this.metrics.hits++;
      }
      
      // Update access metadata
      entry.lastAccessedAt = Date.now();
      entry.accessCount++;
      
      return entry.artifact;
    }
    
    // Cache miss
    if (this.config.enableMetrics) {
      this.metrics.misses++;
    }
    
    return null;
  }

  /**
   * Set artifact in cache
   * @param {string} id - Artifact ID
   * @param {Object} artifact - Artifact to cache
   * @returns {boolean} True if cached, false if rejected (too large)
   */
  set(id, artifact) {
    if (!id || typeof id !== 'string') {
      throw new Error('[ArtifactCache] ID must be a non-empty string');
    }

    if (!artifact || typeof artifact !== 'object') {
      throw new Error('[ArtifactCache] Artifact must be an object');
    }

    // Calculate artifact size
    const size = this._calculateSize(artifact);
    
    // Reject if single artifact exceeds max artifact size
    if (size > this.config.maxArtifactSize) {
      this.log.warn('Artifact exceeds max size, not caching', {
        id, size, maxArtifactSize: this.config.maxArtifactSize
      });
      return false;
    }

    // If artifact already exists, remove it first to update size
    if (this.cache.has(id)) {
      const existing = this.cache.get(id);
      this.totalSize -= existing.size;
      this.cache.delete(id);
    }

    // Evict entries if we're at capacity
    this._evictIfNeeded(size);

    // Create cache entry
    const entry = {
      artifact,
      size,
      cachedAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0
    };

    // Add to cache
    this.cache.set(id, entry);
    this.totalSize += size;

    // Update metrics
    if (this.config.enableMetrics) {
      this.metrics.sets++;
    }

    return true;
  }

  /**
   * Delete artifact from cache
   * @param {string} id - Artifact ID
   * @returns {boolean} True if deleted, false if not found
   */
  delete(id) {
    if (!id || typeof id !== 'string') {
      throw new Error('[ArtifactCache] ID must be a non-empty string');
    }

    const entry = this.cache.get(id);
    
    if (entry) {
      this.cache.delete(id);
      this.totalSize -= entry.size;
      
      // Update metrics
      if (this.config.enableMetrics) {
        this.metrics.deletes++;
      }
      
      return true;
    }
    
    return false;
  }

  /**
   * Check if artifact exists in cache
   * @param {string} id - Artifact ID
   * @returns {boolean} True if exists
   */
  has(id) {
    return this.cache.has(id);
  }

  /**
   * Clear entire cache
   */
  clear() {
    this.cache.clear();
    this.totalSize = 0;
  }

  /**
   * Get cache size (number of entries)
   * @returns {number} Number of cached artifacts
   */
  size() {
    return this.cache.size;
  }

  /**
   * Get total cached data size in bytes
   * @returns {number} Total size in bytes
   */
  getTotalSize() {
    return this.totalSize;
  }

  /**
   * Get cache metrics
   * @returns {Object} Metrics object
   */
  getMetrics() {
    const hitRate = this.metrics.hits + this.metrics.misses > 0
      ? (this.metrics.hits / (this.metrics.hits + this.metrics.misses) * 100).toFixed(2)
      : 0;

    return freeze({
      ...this.metrics,
      hitRate: `${hitRate}%`,
      currentEntries: this.cache.size,
      currentSize: this.totalSize,
      currentSizeMB: (this.totalSize / (1024 * 1024)).toFixed(2),
      maxEntries: this.config.maxEntries,
      maxSize: this.config.maxTotalSize,
      maxSizeMB: (this.config.maxTotalSize / (1024 * 1024)).toFixed(2),
      utilizationPercent: ((this.cache.size / this.config.maxEntries) * 100).toFixed(2)
    });
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      hits: 0,
      misses: 0,
      evictions: 0,
      sets: 0,
      deletes: 0,
      sizeEvictions: 0,
      countEvictions: 0
    };
  }

  /**
   * Get all artifact IDs (for iteration)
   * @returns {Array<string>} Array of artifact IDs
   */
  keys() {
    return Array.from(this.cache.keys());
  }

  /**
   * Get all artifacts (for iteration)
   * @returns {Array<Object>} Array of artifacts
   */
  values() {
    return Array.from(this.cache.values()).map(entry => entry.artifact);
  }

  /**
   * Get all entries with metadata
   * @returns {Array<Object>} Array of {id, artifact, metadata}
   */
  entries() {
    return Array.from(this.cache.entries()).map(([id, entry]) => ({
      id,
      artifact: entry.artifact,
      metadata: {
        size: entry.size,
        cachedAt: entry.cachedAt,
        lastAccessedAt: entry.lastAccessedAt,
        accessCount: entry.accessCount
      }
    }));
  }

  /**
   * Evict entries if needed (LRU policy)
   * @private
   */
  _evictIfNeeded(newEntrySize) {
    // Evict by count limit
    while (this.cache.size >= this.config.maxEntries && this.cache.size > 0) {
      this._evictLRU('count');
    }

    // Evict by size limit
    while (this.totalSize + newEntrySize > this.config.maxTotalSize && this.cache.size > 0) {
      this._evictLRU('size');
    }
  }

  /**
   * Evict least recently used entry
   * @private
   */
  _evictLRU(reason) {
    // Get first entry (least recently used, due to Map insertion order)
    const firstKey = this.cache.keys().next().value;
    
    if (firstKey) {
      const entry = this.cache.get(firstKey);
      this.cache.delete(firstKey);
      this.totalSize -= entry.size;
      
      // Update metrics
      if (this.config.enableMetrics) {
        this.metrics.evictions++;
        if (reason === 'size') {
          this.metrics.sizeEvictions++;
        } else if (reason === 'count') {
          this.metrics.countEvictions++;
        }
      }
    }
  }

  /**
   * Calculate artifact size (rough estimate)
   * @private
   */
  _calculateSize(artifact) {
    // Rough size estimation: JSON string length
    // This is an approximation, actual memory usage may vary
    try {
      return JSON.stringify(artifact).length;
    } catch (error) {
      // Fallback: assume average artifact size
      this.log.warn('Could not calculate size, using default', { error: error?.message });
      return 10 * 1024; // 10KB default
    }
  }

  /**
   * Get cache configuration
   * @returns {Object} Configuration object
   */
  getConfig() {
    return freeze({ ...this.config });
  }
}

// Export
module.exports = { 
  ArtifactCache,
  DEFAULT_CONFIG
};
