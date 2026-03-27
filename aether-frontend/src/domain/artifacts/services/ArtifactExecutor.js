'use strict';

/**
 * @.architecture
 * Domain Service - Executes code artifacts safely
 * 
 * Incoming: ArtifactsOrchestrator.executeArtifact() (method call with artifact) --- {artifact_types.code, object}
 * Processing: Validate artifact type (MUST be 'code'), validate language support, delegate to SafeCodeExecutor, track execution state, store results, emit execution events --- {6 jobs: JOB_VALIDATE_SCHEMA, JOB_DELEGATE_TO_MODULE, JOB_UPDATE_STATE, JOB_EMIT_EVENT, JOB_TRACK_ENTITY, JOB_GET_STATE}
 * Outgoing: SafeCodeExecutor.execute(), EventBus.emit('artifacts:executed'), return ExecutionResult --- {execution_result, object}
 * 
 * CONTRACTS:
 * - artifact: REQUIRED (Artifact instance or object with type='code')
 * - artifact.content: REQUIRED (non-empty string)
 * - artifact.language: REQUIRED (supported language)
 * - codeExecutor: REQUIRED (SafeCodeExecutor instance)
 * - Fail-fast on missing dependencies or invalid artifacts
 * - NO fallbacks, strict validation
 * 
 * @module domain/artifacts/services/ArtifactExecutor
 */

const { createDomainLogger } = require('../../../core/utils/logger');

const artifactExecutorLogger = createDomainLogger('ArtifactExecutor');

class ArtifactExecutor {
  constructor(options = {}) {
    this.codeExecutor = options.codeExecutor;
    this.eventBus = options.eventBus;
    this.errorTracker = options.errorTracker;
    this.performanceMonitor = options.performanceMonitor;
    this.logger = options.logger || artifactExecutorLogger.child({ scope: 'instance' });
    
    // Validate required dependencies - FAIL FAST
    if (!this.codeExecutor) throw new Error('[ArtifactExecutor] SafeCodeExecutor is required');
    if (!this.eventBus) throw new Error('[ArtifactExecutor] EventBus is required');
    
    // Execution state tracking
    this.executionResults = new Map(); // artifactId -> ExecutionResult
    this.isExecuting = false;
    this.currentExecutionId = null;
    
    this.logger.info('ArtifactExecutor initialized');
  }
  
  /**
   * Execute code artifact
   * 
   * @param {Object} artifact - Artifact to execute (REQUIRED)
   * @param {string} artifact.id - Artifact ID (REQUIRED)
   * @param {string} artifact.type - Must be 'code' (REQUIRED)
   * @param {string} artifact.content - Code content (REQUIRED)
   * @param {string} artifact.language - Programming language (REQUIRED)
   * @param {Object} options - Execution options
   * @param {number} options.timeout - Execution timeout in ms (default: 30000)
   * @returns {Promise<Object>} Execution result
   */
  async execute(artifact, options = {}) {
    // STRICT CONTRACT VALIDATION - NO FALLBACKS
    if (!artifact) throw new Error('[ArtifactExecutor] Artifact is required');
    if (!artifact.id || typeof artifact.id !== 'string') {
      throw new Error('[ArtifactExecutor] artifact.id is required (string)');
    }
    if (artifact.type !== 'code') {
      throw new Error(`[ArtifactExecutor] Cannot execute non-code artifact: ${artifact.type}`);
    }
    if (!artifact.content || typeof artifact.content !== 'string') {
      throw new Error('[ArtifactExecutor] artifact.content is required (non-empty string)');
    }
    if (!artifact.language || typeof artifact.language !== 'string') {
      throw new Error('[ArtifactExecutor] artifact.language is required (string)');
    }
    
    const { timeout = 30000 } = options;
    const artifactId = artifact.id;
    
    // Check if already executing
    if (this.isExecuting) {
      throw new Error(`[ArtifactExecutor] Already executing artifact: ${this.currentExecutionId}`);
    }
    
    this.isExecuting = true;
    this.currentExecutionId = artifactId;
    
    const monitorKey = `execute:${artifactId}`;
    let monitorStarted = false;
    
    try {
      this.logger.info(`Executing artifact ${artifactId} (${artifact.language})`);
      
      // Start performance monitoring
      if (this.performanceMonitor) {
        this.performanceMonitor.start(monitorKey);
        monitorStarted = true;
      }
      
      // Execute code via SafeCodeExecutor
      const result = await this.codeExecutor.executeJavaScript(artifact.content, {
        language: artifact.language,
        timeout
      });
      
      // Store execution result
      this.executionResults.set(artifactId, {
        ...result,
        artifactId,
        language: artifact.language,
        executedAt: Date.now()
      });
      
      this.logger.info(`Artifact ${artifactId} executed successfully: ${result.success ? 'SUCCESS' : 'FAILURE'}`);
      
      // Emit execution event
      this.eventBus.emit('artifacts:executed', {
        artifactId,
        language: artifact.language,
        success: result.success,
        executionTime: result.executionTime || null
      });
      
      return result;
    } catch (error) {
      this.logger.error(`Artifact ${artifactId} execution failed:`, error);
      
      // Store error result
      const errorResult = {
        success: false,
        error: error.message,
        artifactId,
        language: artifact.language,
        executedAt: Date.now()
      };
      
      this.executionResults.set(artifactId, errorResult);
      
      // Emit failure event
      this.eventBus.emit('artifacts:execution-failed', {
        artifactId,
        language: artifact.language,
        error: error.message
      });
      
      if (this.errorTracker) {
        this.errorTracker.captureException(error, 'ArtifactExecutor.execute', {
          artifactId,
          language: artifact.language
        });
      }
      
      throw error;
    } finally {
      // Cleanup execution state
      this.isExecuting = false;
      this.currentExecutionId = null;
      
      // End performance monitoring
      if (this.performanceMonitor && monitorStarted) {
        this.performanceMonitor.end(monitorKey);
      }
    }
  }
  
  /**
   * Get execution result for artifact
   * 
   * @param {string} artifactId - Artifact ID
   * @returns {Object|null} Execution result or null if not found
   */
  getExecutionResult(artifactId) {
    if (!artifactId || typeof artifactId !== 'string') {
      throw new Error('[ArtifactExecutor] artifactId is required (string)');
    }
    
    return this.executionResults.get(artifactId) || null;
  }
  
  /**
   * Check if artifact has been executed
   * 
   * @param {string} artifactId - Artifact ID
   * @returns {boolean} True if artifact has execution result
   */
  hasExecutionResult(artifactId) {
    if (!artifactId || typeof artifactId !== 'string') {
      return false;
    }
    
    return this.executionResults.has(artifactId);
  }
  
  /**
   * Clear execution result for artifact
   * 
   * @param {string} artifactId - Artifact ID
   * @returns {boolean} True if result was cleared
   */
  clearExecutionResult(artifactId) {
    if (!artifactId || typeof artifactId !== 'string') {
      throw new Error('[ArtifactExecutor] artifactId is required (string)');
    }
    
    const existed = this.executionResults.has(artifactId);
    this.executionResults.delete(artifactId);
    
    if (existed) {
      this.logger.debug(`Cleared execution result for artifact ${artifactId}`);
    }
    
    return existed;
  }
  
  /**
   * Clear all execution results
   */
  clearAllResults() {
    const count = this.executionResults.size;
    this.executionResults.clear();
    
    this.logger.debug(`Cleared ${count} execution results`);
  }
  
  /**
   * Get execution statistics
   * 
   * @returns {Object} Execution statistics
   */
  getStats() {
    const results = Array.from(this.executionResults.values());
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    return {
      totalExecutions: results.length,
      successful,
      failed,
      successRate: results.length > 0 ? (successful / results.length) * 100 : 0,
      isExecuting: this.isExecuting,
      currentExecutionId: this.currentExecutionId,
      languages: [...new Set(results.map(r => r.language))],
      hasCodeExecutor: Boolean(this.codeExecutor),
      hasEventBus: Boolean(this.eventBus),
      hasErrorTracker: Boolean(this.errorTracker),
      hasPerformanceMonitor: Boolean(this.performanceMonitor)
    };
  }
}

module.exports = { ArtifactExecutor };
