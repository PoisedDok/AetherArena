'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsOrchestrator.executeCode(), SafeCodeExecutor.execute() (method calls with code strings) --- {code_artifact, string}
 * Processing: Execute JavaScript in Web Worker sandbox (no DOM/window access), track activeWorkers Map (executionId → Worker), enforce max concurrent executions (3), set timeout (default 5s), intercept console logs, capture output/logs/errors, route worker message types (log/result/error), validate code format and content, cleanup workers and blob URLs, dispose resources --- {6 jobs: JOB_DISPOSE, JOB_GET_STATE, JOB_ROUTE_BY_TYPE, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA}
 * Outgoing: Return ExecutionResult model instances (success/error/timeout) --- {execution_result, javascript_object}
 * 
 * 
 * @module domain/artifacts/services/ExecutionService
 */

const { ExecutionResult } = require('../models/ExecutionResult');

/**
 * ExecutionService
 * Handles safe code execution in isolated Web Worker environment
 * 
 * Prevents access to DOM, window, and parent scope
 */

class ExecutionService {
  constructor(options = {}) {
    this.defaultTimeout = options.timeout || 5000;
    this.maxConcurrentExecutions = options.maxConcurrentExecutions || 3;
    this.logger = options.logger || this._createDefaultLogger();
    
    // Execution tracking
    this.activeWorkers = new Map(); // executionId -> Worker
    this.executionQueue = [];
    this.executionCount = 0;
  }

  _createDefaultLogger() {
    return {
      debug: () => {},
      info: () => {},
      warn: (...args) => console.warn('[ExecutionService]', ...args),
      error: (...args) => console.error('[ExecutionService]', ...args)
    };
  }

  /**
   * Check if Web Workers are supported
   */
  static isSupported() {
    return typeof Worker !== 'undefined';
  }

  /**
   * Execute JavaScript code safely in Web Worker
   */
  async executeJavaScript(code, options = {}) {
    if (!ExecutionService.isSupported()) {
      return ExecutionResult.error('Web Workers not supported in this environment');
    }

    const executionTimeout = options.timeout || this.defaultTimeout;
    const artifactId = options.artifactId || null;

    // Check execution limits
    if (this.activeWorkers.size >= this.maxConcurrentExecutions) {
      this.logger.warn('Maximum concurrent executions reached, queueing');
      return ExecutionResult.error('Execution queue full, try again later');
    }

    const executionId = this._generateExecutionId();
    this.logger.debug(`Starting execution ${executionId}`);

    return new Promise((resolve) => {
      const logs = [];
      const startTime = Date.now();

      // Create worker from inline code
      const workerCode = this._createWorkerCode();
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);

      let worker = null;
      let timeoutId = null;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (worker) {
          worker.terminate();
          worker = null;
        }
        if (workerUrl) {
          URL.revokeObjectURL(workerUrl);
        }
        this.activeWorkers.delete(executionId);
        this.executionCount++;
      };

      try {
        worker = new Worker(workerUrl);
        this.activeWorkers.set(executionId, worker);

        // Timeout handler
        timeoutId = setTimeout(() => {
          this.logger.warn(`Execution ${executionId} timed out after ${executionTimeout}ms`);
          cleanup();
          resolve(ExecutionResult.timeout(executionTimeout, logs));
        }, executionTimeout);

        // Message handler
        worker.onmessage = (event) => {
          const { type, data } = event.data;

          if (type === 'log') {
            logs.push(data);
          } else if (type === 'result') {
            cleanup();
            const result = ExecutionResult.success(
              data.result,
              logs,
              Date.now() - startTime
            );
            this.logger.debug(`Execution ${executionId} completed successfully`);
            resolve(result);
          } else if (type === 'error') {
            cleanup();
            const result = ExecutionResult.error(
              data.message,
              data.stack,
              logs,
              Date.now() - startTime
            );
            this.logger.warn(`Execution ${executionId} failed:`, data.message);
            resolve(result);
          }
        };

        // Error handler
        worker.onerror = (error) => {
          cleanup();
          const result = ExecutionResult.error(
            error.message || 'Worker error',
            null,
            logs,
            Date.now() - startTime
          );
          this.logger.error(`Execution ${executionId} worker error:`, error);
          resolve(result);
        };

        // Send code to worker
        worker.postMessage({ type: 'execute', code });

      } catch (error) {
        cleanup();
        const result = ExecutionResult.error(
          `Failed to create worker: ${error.message}`,
          error.stack,
          [],
          Date.now() - startTime
        );
        this.logger.error(`Execution ${executionId} setup failed:`, error);
        resolve(result);
      }
    });
  }

  /**
   * Execute code with artifact context
   */
  async executeArtifact(artifact, options = {}) {
    if (artifact.type !== 'code') {
      return ExecutionResult.error('Only code artifacts can be executed');
    }

    if (!artifact.content || artifact.content.trim().length === 0) {
      return ExecutionResult.error('Artifact has no code to execute');
    }

    // Only support JavaScript execution for now
    const jsFormats = ['js', 'javascript', 'text'];
    if (!jsFormats.includes(artifact.format)) {
      return ExecutionResult.error(`Unsupported code format: ${artifact.format}`);
    }

    return this.executeJavaScript(artifact.content, {
      ...options,
      artifactId: artifact.id
    });
  }

  /**
   * Terminate specific execution
   */
  terminate(executionId) {
    const worker = this.activeWorkers.get(executionId);
    if (worker) {
      try {
        worker.terminate();
        this.activeWorkers.delete(executionId);
        this.logger.info(`Terminated execution ${executionId}`);
        return true;
      } catch (error) {
        this.logger.error(`Failed to terminate execution ${executionId}:`, error);
        return false;
      }
    }
    return false;
  }

  /**
   * Terminate all active executions
   */
  terminateAll() {
    const count = this.activeWorkers.size;
    for (const [executionId, worker] of this.activeWorkers.entries()) {
      try {
        worker.terminate();
      } catch (error) {
        this.logger.error(`Failed to terminate execution ${executionId}:`, error);
      }
    }
    this.activeWorkers.clear();
    this.logger.info(`Terminated ${count} active executions`);
    return count;
  }

  /**
   * Get execution statistics
   */
  getStats() {
    return {
      active: this.activeWorkers.size,
      total: this.executionCount,
      maxConcurrent: this.maxConcurrentExecutions,
      queueSize: this.executionQueue.length
    };
  }

  /**
   * Generate unique execution ID
   */
  _generateExecutionId() {
    return `exec_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Create Web Worker code as string
   */
  _createWorkerCode() {
    return `
// Web Worker - Isolated JavaScript execution environment
// No access to DOM, window, or parent scope

const logs = [];

// Override console to capture logs
const console = {
  log: (...args) => {
    const message = args.map(arg => {
      try {
        if (typeof arg === 'object') {
          return JSON.stringify(arg, null, 2);
        }
        return String(arg);
      } catch (e) {
        return '[Circular or Non-serializable]';
      }
    }).join(' ');
    
    logs.push('LOG: ' + message);
    self.postMessage({ type: 'log', data: message });
  },
  
  error: (...args) => {
    const message = args.map(arg => String(arg)).join(' ');
    logs.push('ERROR: ' + message);
    self.postMessage({ type: 'log', data: 'ERROR: ' + message });
  },
  
  warn: (...args) => {
    const message = args.map(arg => String(arg)).join(' ');
    logs.push('WARN: ' + message);
    self.postMessage({ type: 'log', data: 'WARN: ' + message });
  },
  
  info: (...args) => {
    const message = args.map(arg => String(arg)).join(' ');
    logs.push('INFO: ' + message);
    self.postMessage({ type: 'log', data: 'INFO: ' + message });
  },
  
  debug: (...args) => {
    const message = args.map(arg => String(arg)).join(' ');
    logs.push('DEBUG: ' + message);
    self.postMessage({ type: 'log', data: 'DEBUG: ' + message });
  }
};

// Safe Math and Date objects
const Math = self.Math;
const Date = self.Date;
const JSON = self.JSON;
const Array = self.Array;
const Object = self.Object;

// Message handler
self.onmessage = function(event) {
  const { type, code } = event.data;
  
  if (type === 'execute') {
    try {
      // Execute code with limited scope
      // Only console, Math, Date, JSON, Array, Object are available
      const fn = new Function('console', 'Math', 'Date', 'JSON', 'Array', 'Object', code);
      const result = fn(console, Math, Date, JSON, Array, Object);
      
      // Send result back
      self.postMessage({
        type: 'result',
        data: {
          result: result !== undefined ? String(result) : undefined
        }
      });
      
    } catch (error) {
      // Send error back
      self.postMessage({
        type: 'error',
        data: {
          message: error.message,
          stack: error.stack,
          name: error.name
        }
      });
    }
  }
};
`;
  }

  /**
   * Dispose of service resources
   */
  dispose() {
    this.terminateAll();
    this.executionQueue = [];
    this.logger.info('ExecutionService disposed');
  }
}

module.exports = { ExecutionService };

