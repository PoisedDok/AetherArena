'use strict';

/**
 * @.architecture
 * 
 * Incoming: SafeCodeExecutor.execute(), Web Worker postMessage() --- {execution_data, json}
 * Processing: Immutable execution result model - status (success/error/timeout), output (result/logs/error/stack), timing (executionTime), context (artifactId, executorType) --- {2 jobs: JOB_VALIDATE_SCHEMA, JOB_TRACK_ENTITY}
 * Outgoing: Export frozen ExecutionResult instance or JSON --- {execution_result_types.*, ExecutionResult}
 * 
 * 
 * @module domain/artifacts/models/ExecutionResult
 */

class ExecutionResult {
  constructor(data = {}) {
    // Execution status
    this.success = data.success === true;
    this.completed = data.completed === true;
    
    // Execution output
    this.result = data.result !== undefined ? data.result : null;
    this.logs = Array.isArray(data.logs) ? [...data.logs] : [];
    this.error = data.error || null;
    this.stack = data.stack || null;
    
    // Execution metadata
    this.executionTime = data.executionTime || 0;
    this.timestamp = data.timestamp || Date.now();
    this.timeout = data.timeout || false;
    
    // Context
    this.artifactId = data.artifactId || null;
    this.executorType = data.executorType || 'worker'; // 'worker' | 'sandbox' | 'iframe'
    
    Object.freeze(this);
  }

  /**
   * Check if execution was successful
   */
  isSuccess() {
    return this.success && !this.error;
  }

  /**
   * Check if execution had errors
   */
  hasError() {
    return this.error !== null;
  }

  /**
   * Check if execution timed out
   */
  isTimeout() {
    return this.timeout === true;
  }

  /**
   * Check if execution has output
   */
  hasOutput() {
    return this.result !== null || this.logs.length > 0;
  }

  /**
   * Get formatted error message
   */
  getErrorMessage() {
    if (!this.error) return null;
    
    let message = this.error;
    if (this.stack) {
      message += `\n\nStack trace:\n${this.stack}`;
    }
    return message;
  }

  /**
   * Get formatted logs as string
   */
  getLogsString() {
    return this.logs.join('\n');
  }

  /**
   * Get execution summary
   */
  getSummary() {
    if (this.isTimeout()) {
      return `Execution timeout after ${this.executionTime}ms`;
    }
    
    if (this.hasError()) {
      return `Execution failed: ${this.error}`;
    }
    
    if (this.isSuccess()) {
      return `Execution completed in ${this.executionTime}ms`;
    }
    
    return 'Execution pending';
  }

  /**
   * Serialize to plain object
   */
  toJSON() {
    return {
      success: this.success,
      completed: this.completed,
      result: this.result,
      logs: [...this.logs],
      error: this.error,
      stack: this.stack,
      executionTime: this.executionTime,
      timestamp: this.timestamp,
      timeout: this.timeout,
      artifactId: this.artifactId,
      executorType: this.executorType
    };
  }

  /**
   * Create execution result from JSON
   */
  static fromJSON(data) {
    return new ExecutionResult(data);
  }

  /**
   * Create success result
   */
  static success(result, logs = [], executionTime = 0) {
    return new ExecutionResult({
      success: true,
      completed: true,
      result,
      logs,
      executionTime,
      timestamp: Date.now()
    });
  }

  /**
   * Create error result
   */
  static error(error, stack = null, logs = [], executionTime = 0) {
    return new ExecutionResult({
      success: false,
      completed: true,
      error: typeof error === 'string' ? error : error.message,
      stack: stack || error.stack,
      logs,
      executionTime,
      timestamp: Date.now()
    });
  }

  /**
   * Create timeout result
   */
  static timeout(timeoutMs, logs = []) {
    return new ExecutionResult({
      success: false,
      completed: true,
      timeout: true,
      error: `Execution timeout after ${timeoutMs}ms`,
      logs,
      executionTime: timeoutMs,
      timestamp: Date.now()
    });
  }

  /**
   * Create pending result
   */
  static pending() {
    return new ExecutionResult({
      success: false,
      completed: false,
      timestamp: Date.now()
    });
  }
}

module.exports = { ExecutionResult };
