'use strict';

/**
 * @.architecture
 * 
 * Incoming: ArtifactsController.executeCode(), CodeViewer 'Execute' button --- {artifact_types.code_artifact.code, string}
 * Processing: Create isolated Web Worker from Blob, send code to worker, capture console logs, enforce timeout (5-30s), serialize result, handle errors --- {3 jobs: JOB_ROUTE_BY_TYPE, JOB_VALIDATE_SCHEMA, JOB_UPDATE_STATE}
 * Outgoing: Promise<{success, result, logs, executionTime}> → ArtifactsController → OutputViewer --- {execution_result, json}
 * 
 * 
 * @module renderer/artifacts/modules/execution/SafeCodeExecutor
 */

const { freeze } = Object;

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
    this.timeout = Math.min(options.timeout || CONFIG.DEFAULT_TIMEOUT, CONFIG.MAX_TIMEOUT);
    this.worker = null;
    this.pendingExecution = null;
  }

  /**
   * Execute JavaScript code safely in a Web Worker
   * @param {string} code - JavaScript code to execute
   * @param {Object} options - Execution options
   * @returns {Promise<Object>} Execution result
   */
  async executeJavaScript(code, options = {}) {
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
          URL.revokeObjectURL(workerUrl);
          
          resolve({
            success: false,
            error: `Execution timeout after ${executionTimeout}ms`,
            logs,
            executionTime: Date.now() - startTime,
          });
        }, executionTimeout);

        // Message handler
        this.worker.onmessage = (event) => {
          clearTimeout(timeoutId);
          
          const { type, data } = event.data;

          if (type === 'log') {
            logs.push(data);
          } else if (type === 'result') {
            this.worker.terminate();
            this.worker = null;
            URL.revokeObjectURL(workerUrl);
            
            resolve({
              success: true,
              result: data.result,
              logs,
              executionTime: Date.now() - startTime,
            });
          } else if (type === 'error') {
            this.worker.terminate();
            this.worker = null;
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
        console.error('[SafeCodeExecutor] Failed to terminate worker:', error);
      }
      this.worker = null;
    }
  }

  /**
   * Dispose executor
   */
  dispose() {
    this.terminate();
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
  console.log('📦 SafeCodeExecutor loaded');
}

