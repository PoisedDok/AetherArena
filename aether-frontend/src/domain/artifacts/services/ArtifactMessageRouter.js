'use strict';

/**
Incoming: ArtifactsStreamOrchestrator (LMC messages from backend) --- {websocket.stream_chunk, json}
Processing: Route by role+type, filter recipients, classify rendering --- {3 jobs: JOB_FILTER_DATA, JOB_ROUTE_BY_TYPE, JOB_VALIDATE_SCHEMA}
Outgoing: Routed message classification --- {object, javascript_api}

ARCHITECTURAL NOTE: Pure routing logic. No state, no I/O. Routes to handler strategies.
*/

const { extractMediaPayload } = require('../utils/MediaPayloadExtractor');
const { createLogger } = require('../../../core/utils/logger');

/**
 * ArtifactMessageRouter
 * 
 * Routes backend LMC messages to appropriate processing strategies.
 * Handles:
 * - Protocol routing by role+type
 * - Recipient filtering (user vs assistant)
 * - Media payload detection
 * - HTML rendering classification
 * 
 * ARCHITECTURE:
 * - Domain service (pure routing logic, no state/I/O)
 * - Returns route classification - caller decides action
 * - Fail-fast on contract violations
 * 
 * ROUTING TABLE:
 * - role:assistant + type:code → 'assistant_code'
 * - role:computer + type:output/console → 'computer_output'
 * - Media payloads → 'media'
 * - Non-user recipients → 'filtered'
 * - Unknown → 'unknown'
 * 
 * @module domain/artifacts/services/ArtifactMessageRouter
 */
class ArtifactMessageRouter {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging || false;
    this.log = createLogger({ component: 'ArtifactMessageRouter' });
  }

  /**
   * Route message to processing strategy
   * 
   * @param {Object} message - Backend LMC message
   * @returns {Object} Route classification { route, message, metadata }
   */
  route(message) {
    if (!message || typeof message !== 'object') {
      throw new Error('[ArtifactMessageRouter] CONTRACT VIOLATION: message must be object');
    }

    const { role, type, recipient } = message;

    // CRITICAL: Filter non-user-targeted computer messages BEFORE type routing
    // Open-interpreter sends artifacts with recipient="assistant" (internal logs)
    // and recipient="user" (actual output). Only process user-targeted messages.
    if (role === 'computer' && recipient && recipient !== 'user') {
      if (this.enableLogging) {
        this.log.debug('Filtering non-user message', {
          type,
          recipient,
          contentPreview: typeof message.content === 'string' 
            ? message.content.substring(0, 50) 
            : ''
        });
      }
      return { route: 'filtered', message, metadata: { reason: 'non-user-recipient' } };
    }

    // Route 1: Assistant code blocks
    if (role === 'assistant' && type === 'code') {
      return { 
        route: 'assistant_code', 
        message, 
        metadata: { requiresCodeProcessing: true } 
      };
    }

    // Route 2: Computer output (console transformed to output+format by backend)
    // See contracts/README.md: only code + output artifact types exist (formats are subtypes)
    if (role === 'computer' && (type === 'output' || type === 'console')) {
      // Check if content should be rendered as HTML
      const forceHtml = this._shouldRenderAsHtml(message.content, message.format);
      
      return { 
        route: 'computer_output', 
        message,
        metadata: { 
          forceHtml,
          requiresOutputProcessing: true
        }
      };
    }

    // Route 3: Media payloads (images/videos)
    const mediaPayload = extractMediaPayload(message);
    if (mediaPayload && (Array.isArray(mediaPayload.videos) || Array.isArray(mediaPayload.images))) {
      return {
        route: 'media',
        message,
        metadata: {
          mediaPayload,
          requiresMediaProcessing: true
        }
      };
    }

    // Route 4: Unknown/unhandled message types
    return {
      route: 'unknown',
      message,
      metadata: { role, type }
    };
  }

  /**
   * Check if content should be rendered as HTML
   * Detects semantic search results and other HTML content
   * 
   * @param {string} text - Message content
   * @param {string} currentFormat - Current format from message
   * @returns {boolean}
   * @private
   */
  _shouldRenderAsHtml(text, currentFormat) {
    if (currentFormat === 'html') {
      return true;
    }

    if (!text || typeof text !== 'string') {
      return false;
    }

    // Heuristics for semantic search HTML
    const looksSemanticHtml = text.includes('<div') && 
      (text.includes('semantic-search-header') || text.includes('tool-card'));
    
    const looksSemanticEmoji = /(🔍|🔎).*Semantic Search Results|🎯.*Best Matches|Semantic\s+Search\s+Results/i.test(text);
    
    const looksSemanticCodeFence = /```[\s\S]*?(semantic-search-header|tool-card)[\s\S]*?```/i.test(text) ||
      /```\s*html[\s\S]*?Semantic\s+Search\s+Results[\s\S]*?```/i.test(text);

    return looksSemanticHtml || looksSemanticEmoji || looksSemanticCodeFence;
  }

  /**
   * Check if message should be processed
   * Convenience method for filtering
   * 
   * @param {Object} message - Backend LMC message
   * @returns {boolean} True if message should be processed
   */
  shouldProcess(message) {
    const { route } = this.route(message);
    return route !== 'filtered' && route !== 'unknown';
  }

  /**
   * Get route type without full classification
   * Lightweight check
   * 
   * @param {Object} message - Backend LMC message
   * @returns {string} Route type
   */
  getRouteType(message) {
    return this.route(message).route;
  }
}

module.exports = { ArtifactMessageRouter };
