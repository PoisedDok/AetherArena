'use strict';

/**
Incoming: ArtifactMessageRouter (message.content with media payloads) --- {string|object, json}
Processing: Parse JSON-like media payloads, classify videos vs images --- {2 jobs: JOB_FILTER_DATA, JOB_PARSE_JSON}
Outgoing: Structured media payload or null --- {object|null, json}

ARCHITECTURAL NOTE: Pure function. No state, no I/O. Tolerates Python-style JSON.
*/

/**
 * MediaPayloadExtractor
 * 
 * Pure utility for extracting and parsing media payloads from message content.
 * Handles:
 * - JSON parsing with Python-style booleans (True/False/None)
 * - Single quotes in JSON
 * - Array classification (videos vs images)
 * - Code fence unwrapping
 * 
 * ARCHITECTURE:
 * - Domain utility (pure functions, no state)
 * - Tolerant parsing: handles backend Python → JSON edge cases
 * - Returns null if not media (no exceptions for non-media content)
 * 
 * @module domain/artifacts/utils/MediaPayloadExtractor
 */

/**
 * Extract media payload from message content
 * 
 * @param {Object} message - Message object
 * @param {string|Object} message.content - Message content (string or object)
 * @returns {Object|null} Media payload { videos: [], images: [] } or null
 */
function extractMediaPayload(message) {
  if (!message) {
    return null;
  }
  
  const text = typeof message.content === 'string' ? String(message.content).trim() : '';
  const rawObj = (message && typeof message.content === 'object') ? message.content : null;

  // Quick heuristic: does content look like media?
  const maybeMediaString = text && (
    text.includes('"videos"') || text.includes("'videos'") ||
    text.includes('"images"') || text.includes("'images'")
  );

  if (!maybeMediaString && !rawObj) {
    return null;
  }

  let payload = null;

  // Case 1: Content is already an object
  if (rawObj) {
    payload = rawObj;
  } 
  // Case 2: Content is JSON-like string
  else if (maybeMediaString && (text.startsWith('{') || text.startsWith('['))) {
    // Strip code fence if present
    let candidate = text;
    const fence = candidate.match(/^```(?:json|js|javascript)?\n([\s\S]*?)\n```\s*$/i);
    if (fence) {
      candidate = fence[1].trim();
    }
    
    const parsed = parseJsonLike(candidate);
    if (parsed) {
      if (Array.isArray(parsed)) {
        payload = classifyArray(parsed) || null;
      } else {
        payload = parsed;
      }
    }
  }

  return payload;
}

/**
 * Parse JSON-like string with Python-style syntax
 * Tolerates: True/False/None, single quotes
 * 
 * @param {string} str - JSON-like string
 * @returns {Object|Array|null} Parsed object/array or null
 * @private
 */
function parseJsonLike(str) {
  try { 
    return JSON.parse(str); 
  } catch (_) {
    try {
      // Python → JSON transformations
      const fixed = str
        .replace(/\bTrue\b/g, 'true')
        .replace(/\bFalse\b/g, 'false')
        .replace(/\bNone\b/g, 'null')
        .replace(/'([^']*)'\s*:/g, '"$1":')  // Single quote keys
        .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"');  // Single quote values
      return JSON.parse(fixed);
    } catch (_) { 
      return null; 
    }
  }
}

/**
 * Classify array as videos or images
 * 
 * @param {Array} arr - Array of media objects
 * @returns {Object|null} { videos: [] } or { images: [] } or null
 * @private
 */
function classifyArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    return null;
  }
  
  const videoCount = arr.filter(looksLikeVideo).length;
  const imageCount = arr.filter(looksLikeImage).length;
  
  if (videoCount === 0 && imageCount === 0) {
    return null;
  }
  
  // Return as videos if more videos than images, otherwise images
  return videoCount >= imageCount ? { videos: arr } : { images: arr };
}

/**
 * Check if object looks like a video
 * 
 * @param {*} obj - Object to check
 * @returns {boolean}
 * @private
 */
function looksLikeVideo(obj) {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  
  return Boolean(
    obj.iframe_src || 
    (obj.url && /(youtube|youtu\.be|vimeo|dailymotion|\.mp4|\.webm)/i.test(String(obj.url)))
  );
}

/**
 * Check if object looks like an image
 * 
 * @param {*} obj - Object to check
 * @returns {boolean}
 * @private
 */
function looksLikeImage(obj) {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  
  return Boolean(
    obj.img_src || 
    obj.image || 
    obj.thumbnail || 
    obj.thumbnail_src ||
    (obj.url && /\.(png|jpe?g|gif|webp|svg)$/i.test(String(obj.url)))
  );
}

module.exports = {
  extractMediaPayload,
  // Export internals for testing
  parseJsonLike,
  classifyArray,
  looksLikeVideo,
  looksLikeImage
};
