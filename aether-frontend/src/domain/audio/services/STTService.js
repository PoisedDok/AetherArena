'use strict';

/**
 * @.architecture
 * 
 * Incoming: AudioManager method calls (processPartial/processFinal/getCurrentPartial/getFinalResult/getResults/getAllFinalResults/clearResults/clearAllResults/hasPartial/hasFinal/getConcatenatedText/getAverageConfidence/getStreamStatistics/getGlobalStatistics/getResultsMetadata/cleanup), stream IDs, transcribed text strings, options objects --- {method_calls, string | object}
 * Processing: Maintain 3 Maps (_results: streamId→STTResult[], _currentPartial: streamId→STTResult, _finalResults: streamId→STTResult), track _maxResultsPerStream=50, processPartial (validate via AudioValidator, create STTResult.createPartial(), store in _currentPartial, add to _results history), processFinal (validate via AudioValidator, create STTResult.createFinal(), delete from _currentPartial, store in _finalResults, add to _results history), getCurrentPartial/getFinalResult (get from Maps), getResults (get array from _results), getAllFinalResults (convert _finalResults to array), clearResults (delete from all 3 Maps), clearAllResults (clear all 3 Maps), hasPartial/hasFinal (Map.has()), getConcatenatedText (filter by isFinal if onlyFinal, map to getTrimmedText(), join with space), getAverageConfidence (filter by isFinal, reduce sum confidence, divide by length), getStreamStatistics (calculate 8 metrics: totalResults/finalResults/partialResults/hasCurrentPartial/hasFinalResult/averageConfidence/finalConfidence/concatenatedText/finalText), getGlobalStatistics (combine all Map keys into Set, iterate to calculate 6 metrics: activeStreams/streamsWithPartial/streamsWithFinal/totalResults/totalFinals/totalPartials), _addResult (get or create array, push result, trim if >maxResultsPerStream via shift), getResultsMetadata (map results to toJSON()), cleanup (clear all Maps) --- {11 jobs: JOB_GET_STATE, JOB_DISPOSE, JOB_CLEAR_STATE, JOB_GET_STATE, JOB_GET_STATE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_STRINGIFY_JSON, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return STTResult instances, arrays, metadata objects, statistics, concatenated text, confidence scores, booleans, AudioValidator method calls --- {STTResult | array | object | string | number | boolean, javascript_object}
 * 
 * 
 * @module domain/audio/services/STTService
 * 
 * STTService
 * Business logic for speech-to-text processing
 * 
 * Handles STT results, partial/final transcription, and confidence tracking
 * Pure business logic - no DOM dependencies
 */

const { STTResult } = require('../models/STTResult');
const { AudioValidator } = require('../validators/AudioValidator');

class STTService {
  constructor() {
    this._results = new Map(); // streamId -> STTResult[]
    this._currentPartial = new Map(); // streamId -> STTResult
    this._finalResults = new Map(); // streamId -> STTResult
    this._maxResultsPerStream = 50;
  }

  /**
   * Process partial STT result
   * @param {string} streamId - Stream identifier
   * @param {string} text - Transcribed text
   * @param {Object} options - Optional metadata
   * @returns {STTResult}
   */
  processPartial(streamId, text, options = {}) {
    const validation = AudioValidator.validateSTTData({
      text,
      isFinal: false,
      streamId,
    });
    if (!validation.valid) {
      throw new Error(`Invalid STT data: ${validation.errors.join(', ')}`);
    }

    const result = STTResult.createPartial(text, streamId, options);
    
    // Store as current partial
    this._currentPartial.set(streamId, result);
    
    // Add to results history
    this._addResult(streamId, result);
    
    return result;
  }

  /**
   * Process final STT result
   * @param {string} streamId - Stream identifier
   * @param {string} text - Transcribed text
   * @param {Object} options - Optional metadata
   * @returns {STTResult}
   */
  processFinal(streamId, text, options = {}) {
    const validation = AudioValidator.validateSTTData({
      text,
      isFinal: true,
      streamId,
    });
    if (!validation.valid) {
      throw new Error(`Invalid STT data: ${validation.errors.join(', ')}`);
    }

    const result = STTResult.createFinal(text, streamId, options);
    
    // Clear current partial
    this._currentPartial.delete(streamId);
    
    // Store as final result
    this._finalResults.set(streamId, result);
    
    // Add to results history
    this._addResult(streamId, result);
    
    return result;
  }

  /**
   * Get current partial result for stream
   * @param {string} streamId - Stream identifier
   * @returns {STTResult|null}
   */
  getCurrentPartial(streamId) {
    return this._currentPartial.get(streamId) || null;
  }

  /**
   * Get final result for stream
   * @param {string} streamId - Stream identifier
   * @returns {STTResult|null}
   */
  getFinalResult(streamId) {
    return this._finalResults.get(streamId) || null;
  }

  /**
   * Get all results for stream
   * @param {string} streamId - Stream identifier
   * @returns {STTResult[]}
   */
  getResults(streamId) {
    return this._results.get(streamId) || [];
  }

  /**
   * Get all final results across all streams
   * @returns {STTResult[]}
   */
  getAllFinalResults() {
    return Array.from(this._finalResults.values());
  }

  /**
   * Clear results for stream
   * @param {string} streamId - Stream identifier
   */
  clearResults(streamId) {
    this._results.delete(streamId);
    this._currentPartial.delete(streamId);
    this._finalResults.delete(streamId);
  }

  /**
   * Clear all results
   */
  clearAllResults() {
    this._results.clear();
    this._currentPartial.clear();
    this._finalResults.clear();
  }

  /**
   * Check if stream has partial result
   * @param {string} streamId - Stream identifier
   * @returns {boolean}
   */
  hasPartial(streamId) {
    return this._currentPartial.has(streamId);
  }

  /**
   * Check if stream has final result
   * @param {string} streamId - Stream identifier
   * @returns {boolean}
   */
  hasFinal(streamId) {
    return this._finalResults.has(streamId);
  }

  /**
   * Get concatenated text from all results for stream
   * @param {string} streamId - Stream identifier
   * @param {boolean} onlyFinal - Only include final results
   * @returns {string}
   */
  getConcatenatedText(streamId, onlyFinal = false) {
    const results = this.getResults(streamId);
    const filtered = onlyFinal ? results.filter(r => r.isFinal) : results;
    return filtered.map(r => r.getTrimmedText()).join(' ');
  }

  /**
   * Get average confidence for stream
   * @param {string} streamId - Stream identifier
   * @param {boolean} onlyFinal - Only include final results
   * @returns {number}
   */
  getAverageConfidence(streamId, onlyFinal = false) {
    const results = this.getResults(streamId);
    const filtered = onlyFinal ? results.filter(r => r.isFinal) : results;
    
    if (filtered.length === 0) {
      return 0;
    }

    const sum = filtered.reduce((acc, r) => acc + r.confidence, 0);
    return sum / filtered.length;
  }

  /**
   * Get statistics for stream
   * @param {string} streamId - Stream identifier
   * @returns {Object}
   */
  getStreamStatistics(streamId) {
    const results = this.getResults(streamId);
    const finals = results.filter(r => r.isFinal);
    const partials = results.filter(r => !r.isFinal);
    
    return {
      totalResults: results.length,
      finalResults: finals.length,
      partialResults: partials.length,
      hasCurrentPartial: this.hasPartial(streamId),
      hasFinalResult: this.hasFinal(streamId),
      averageConfidence: this.getAverageConfidence(streamId),
      finalConfidence: this.getAverageConfidence(streamId, true),
      concatenatedText: this.getConcatenatedText(streamId),
      finalText: this.getConcatenatedText(streamId, true),
    };
  }

  /**
   * Get global statistics
   * @returns {Object}
   */
  getGlobalStatistics() {
    const allStreamIds = new Set([
      ...this._results.keys(),
      ...this._currentPartial.keys(),
      ...this._finalResults.keys(),
    ]);

    let totalResults = 0;
    let totalFinals = 0;
    let totalPartials = 0;
    
    for (const streamId of allStreamIds) {
      const results = this.getResults(streamId);
      totalResults += results.length;
      totalFinals += results.filter(r => r.isFinal).length;
      totalPartials += results.filter(r => !r.isFinal).length;
    }

    return {
      activeStreams: allStreamIds.size,
      streamsWithPartial: this._currentPartial.size,
      streamsWithFinal: this._finalResults.size,
      totalResults,
      totalFinals,
      totalPartials,
    };
  }

  /**
   * Add result to history
   * @private
   * @param {string} streamId - Stream identifier
   * @param {STTResult} result - Result to add
   */
  _addResult(streamId, result) {
    if (!this._results.has(streamId)) {
      this._results.set(streamId, []);
    }

    const results = this._results.get(streamId);
    results.push(result);

    // Trim if too many results
    if (results.length > this._maxResultsPerStream) {
      results.shift();
    }
  }

  /**
   * Get results metadata
   * @param {string} streamId - Stream identifier
   * @returns {Object[]}
   */
  getResultsMetadata(streamId) {
    const results = this.getResults(streamId);
    return results.map(r => r.toJSON());
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    this._results.clear();
    this._currentPartial.clear();
    this._finalResults.clear();
  }
}

module.exports = { STTService };

