'use strict';

/**
 * @.architecture
 * 
 * Incoming: STTService.handleTranscription(), WebSocket/HTTP STT responses (transcription data), fromJSON (JSON data) --- {stream_types.stt_result | json, object}
 * Processing: Initialize STT result model (id/text/isFinal/confidence/timestamp/streamId/metadata), factory createPartial (isFinal=false, confidence=0, id='stt-partial-timestamp-random'), factory createFinal (isFinal=true, confidence=1, id='stt-final-timestamp-random'), validate result (text length>0, isFinal boolean, confidence 0-1), getTrimmedText (trim whitespace), isEmpty (check trimmed length=0), calculate confidence percentage (0-100), check high confidence (threshold default 0.8), serialize to JSON (convert timestamp to ISO), deserialize from JSON (parse timestamp) --- {7 jobs: JOB_GET_STATE, JOB_GENERATE_SESSION_ID, JOB_GET_STATE, JOB_INITIALIZE, JOB_PARSE_JSON, JOB_STRINGIFY_JSON, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return STTResult instances, JSON representation, confidence metrics --- {STTResult | object | number | boolean, javascript_object}
 * 
 * 
 * @module domain/audio/models/STTResult
 * 
 * STTResult Model
 * Represents a speech-to-text transcription result
 * 
 * Manages STT transcription state and partial/final results
 */

class STTResult {
  /**
   * @param {Object} data - STT result data
   * @param {string} data.id - Result identifier
   * @param {string} data.text - Transcribed text
   * @param {boolean} data.isFinal - Whether result is final
   * @param {number} data.confidence - Confidence score (0-1)
   * @param {Date} data.timestamp - When result was received
   * @param {string} data.streamId - Associated audio stream ID
   * @param {Object|null} data.metadata - Additional metadata
   */
  constructor(data) {
    this.id = data.id || null;
    this.text = data.text || '';
    this.isFinal = data.isFinal || false;
    this.confidence = data.confidence || 0;
    this.timestamp = data.timestamp || new Date();
    this.streamId = data.streamId || null;
    this.metadata = data.metadata || null;
  }

  /**
   * Create partial STT result
   * @param {string} text - Transcribed text
   * @param {string} streamId - Stream identifier
   * @param {Object} options - Optional metadata
   * @returns {STTResult}
   */
  static createPartial(text, streamId, options = {}) {
    const id = options.id || `stt-partial-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return new STTResult({
      id,
      text,
      isFinal: false,
      confidence: options.confidence || 0,
      timestamp: new Date(),
      streamId,
      metadata: options.metadata || null,
    });
  }

  /**
   * Create final STT result
   * @param {string} text - Transcribed text
   * @param {string} streamId - Stream identifier
   * @param {Object} options - Optional metadata
   * @returns {STTResult}
   */
  static createFinal(text, streamId, options = {}) {
    const id = options.id || `stt-final-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return new STTResult({
      id,
      text,
      isFinal: true,
      confidence: options.confidence || 1,
      timestamp: new Date(),
      streamId,
      metadata: options.metadata || null,
    });
  }

  /**
   * Check if result is valid
   * @returns {boolean}
   */
  isValid() {
    return (
      this.text !== null &&
      this.text.length > 0 &&
      typeof this.isFinal === 'boolean' &&
      this.confidence >= 0 &&
      this.confidence <= 1
    );
  }

  /**
   * Get trimmed text
   * @returns {string}
   */
  getTrimmedText() {
    return this.text.trim();
  }

  /**
   * Check if text is empty
   * @returns {boolean}
   */
  isEmpty() {
    return this.getTrimmedText().length === 0;
  }

  /**
   * Get confidence percentage
   * @returns {number}
   */
  getConfidencePercent() {
    return Math.round(this.confidence * 100);
  }

  /**
   * Check if high confidence
   * @param {number} threshold - Confidence threshold (default 0.8)
   * @returns {boolean}
   */
  isHighConfidence(threshold = 0.8) {
    return this.confidence >= threshold;
  }

  /**
   * Convert to plain object
   * @returns {Object}
   */
  toJSON() {
    return {
      id: this.id,
      text: this.text,
      isFinal: this.isFinal,
      confidence: this.confidence,
      timestamp: this.timestamp?.toISOString() || null,
      streamId: this.streamId,
      metadata: this.metadata,
    };
  }

  /**
   * Create from plain object
   * @param {Object} json - Plain object
   * @returns {STTResult}
   */
  static fromJSON(json) {
    return new STTResult({
      id: json.id,
      text: json.text,
      isFinal: json.isFinal,
      confidence: json.confidence,
      timestamp: json.timestamp ? new Date(json.timestamp) : null,
      streamId: json.streamId,
      metadata: json.metadata,
    });
  }
}

module.exports = { STTResult };
