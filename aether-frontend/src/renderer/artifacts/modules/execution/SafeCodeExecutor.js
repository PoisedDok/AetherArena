'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController.executeCode(), CodeViewer 'Execute' button --- {artifact_types.code_artifact.code, string}
 * Processing: Create isolated Web Worker from Blob, send code to worker, capture console logs, enforce timeout (5-30s), serialize result, handle errors --- {2 jobs: JOB_ROUTE_BY_TYPE, JOB_VALIDATE_SCHEMA}
 * Outgoing: Promise<{success, result, logs, executionTime}> → ArtifactsController → OutputViewer --- {execution_result, json}
 * 
 * @.security eval() audit: JUSTIFIED
 * The eval() call on line ~247 runs INSIDE an isolated Web Worker blob. Mitigations:
 *   1. Web Worker has ZERO access to DOM, window, document, or parent scope
 *   2. Console is overridden (captured via postMessage, no real console access)
 *   3. Timeout enforcement (default 5s, max 30s) prevents infinite loops
 *   4. Worker.terminate() is called on completion, timeout, or error (no lingering)
 *   5. 'use strict' mode enforced inside the execution IIFE
 *   6. Result serialized via JSON round-trip (no object reference leaks)
 * This is the standard sandboxed execution pattern for running AI-generated code artifacts.
 * 
 * 
 * @module renderer/artifacts/modules/execution/SafeCodeExecutor
 */

const { freeze } = Object;
const { createRendererLogger } = require('../../../shared/utils/logger');
const _log = createRendererLogger('SafeCodeExecutor');

// Executor configuration
const CONFIG = freeze({
  DEFAULT_TIMEOUT: 5000, // 5 seconds
  MAX_TIMEOUT: 30000, // 30 seconds
});

class SafeCodeExecutor {
  /**
   * Create safe code executor
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.log = _log;
    this.timeout = Math.min(options.timeout || CONFIG.DEFAULT_TIMEOUT, CONFIG.MAX_TIMEOUT);
    this.worker = null;
    this.pendingExecution = null;
    this._isDisposed = false;
  }

  /**
   * Execute JavaScript code safely in a Web Worker
   * @param {string} code - JavaScript code to execute
   * @param {Object} options - Execution options
   * @returns {Promise<Object>} Execution result
   */
  async executeJavaScript(code, options = {}) {
    if (this._isDisposed) {
      return {
        success: false,
        error: 'Executor is disposed',
        logs: [],
        executionTime: 0,
      };
    }

    // Cancel any previous execution: clears its timeout, terminates its worker,
    // and resolves its promise with a cancellation error to prevent resource
    // cross-contamination (old timeout would terminate the new worker)
    this._cancelPendingExecution();

    const executionTimeout = Math.min(options.timeout || this.timeout, CONFIG.MAX_TIMEOUT);

    return new Promise((resolve) => {
      const logs = [];
      const startTime = Date.now();

      // Create worker from inline code
      const workerCode = this._createWorkerCode();
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);

      try {
        this.worker = new Worker(workerUrl);

        // Timeout handler
        const timeoutId = setTimeout(() => {
          if (this.worker) {
            this.worker.terminate();
            this.worker = null;
          }
          this.pendingExecution = null;
          URL.revokeObjectURL(workerUrl);
          
          resolve({
            success: false,
            error: `Execution timeout after ${executionTimeout}ms`,
            logs,
            executionTime: Date.now() - startTime,
          });
        }, executionTimeout);

        // Track for cancellation by subsequent executeJavaScript calls
        this.pendingExecution = { resolve, timeoutId, workerUrl, logs, startTime };

        // Message handler
        this.worker.onmessage = (event) => {
          const { type, data } = event.data;

          if (type === 'log') {
            // Log messages do NOT clear the timeout — timeout must remain
            // active to enforce execution time limits even when logs arrive
            logs.push(data);
          } else if (type === 'result') {
            clearTimeout(timeoutId);
            this.worker.terminate();
            this.worker = null;
            this.pendingExecution = null;
            URL.revokeObjectURL(workerUrl);
            
            resolve({
              success: true,
              result: data.result,
              logs,
              executionTime: Date.now() - startTime,
            });
          } else if (type === 'error') {
            clearTimeout(timeoutId);
            this.worker.terminate();
            this.worker = null;
            this.pendingExecution = null;
            URL.revokeObjectURL(workerUrl);
            
            resolve({
              success: false,
              error: data.message,
              stack: data.stack,
              logs,
              executionTime: Date.now() - startTime,
            });
          }
        };

        // Error handler
        this.worker.onerror = (error) => {
          clearTimeout(timeoutId);
          this.worker.terminate();
          this.worker = null;
          this.pendingExecution = null;
          URL.revokeObjectURL(workerUrl);
          
          resolve({
            success: false,
            error: error.message || 'Worker error',
            logs,
            executionTime: Date.now() - startTime,
          });
        };

        // Send code to worker
        this.worker.postMessage({ type: 'execute', code });

      } catch (error) {
        this.pendingExecution = null;
        URL.revokeObjectURL(workerUrl);
        resolve({
          success: false,
          error: `Failed to create worker: ${error.message}`,
          logs,
          executionTime: Date.now() - startTime,
        });
      }
    });
  }

  /**
   * Terminate active worker
   */
  terminate() {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch (error) {
        this.log.error('[SafeCodeExecutor] Failed to terminate worker:', error);
      }
      this.worker = null;
    }
  }

  /**
   * Dispose executor — cancels any pending execution and terminates the worker
   */
  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this._cancelPendingExecution();
  }

  /**
   * Cancel a pending execution (used when a new execution supersedes the current one).
   * Clears the timeout, terminates the worker, revokes the Blob URL, and resolves
   * the pending promise with a cancellation error.
   * @private
   */
  _cancelPendingExecution() {
    if (this.pendingExecution) {
      clearTimeout(this.pendingExecution.timeoutId);
      const { resolve, workerUrl, logs, startTime } = this.pendingExecution;
      this.pendingExecution = null;
      this.terminate();
      URL.revokeObjectURL(workerUrl);
      resolve({
        success: false,
        error: 'Execution cancelled: superseded by new execution',
        logs: logs || [],
        executionTime: Date.now() - (startTime || Date.now()),
      });
    } else {
      this.terminate();
    }
  }

  /**
   * Create the Web Worker code as a string
   * @returns {string} Worker code
   * @private
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
    
    logs.push('ERROR: ' + message);
    self.postMessage({ type: 'log', data: 'ERROR: ' + message });
  },
  
  warn: (...args) => {
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
    
    logs.push('WARN: ' + message);
    self.postMessage({ type: 'log', data: 'WARN: ' + message });
  },
  
  info: (...args) => {
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
    
    logs.push('INFO: ' + message);
    self.postMessage({ type: 'log', data: 'INFO: ' + message });
  },
};

// Listen for execute message
self.addEventListener('message', (event) => {
  const { type, code } = event.data;
  
  if (type === 'execute') {
    try {
      // Execute code in isolated scope
      const result = (function() {
        'use strict';
        ${'' /* User code will be executed here */}
        return eval(code);
      })();
      
      // Serialize result
      let serializedResult;
      try {
        serializedResult = JSON.parse(JSON.stringify(result));
      } catch (e) {
        serializedResult = String(result);
      }
      
      // Send result
      self.postMessage({
        type: 'result',
        data: {
          result: serializedResult,
          logs,
        },
      });
      
    } catch (error) {
      // Send error
      self.postMessage({
        type: 'error',
        data: {
          message: error.message || 'Execution error',
          stack: error.stack || '',
        },
      });
    }
  }
});
`;
  }
}

// Export
module.exports = SafeCodeExecutor;

if (typeof window !== 'undefined') {
  window.SafeCodeExecutor = SafeCodeExecutor;
  _log.debug('[SafeCodeExecutor] SafeCodeExecutor loaded');
}
