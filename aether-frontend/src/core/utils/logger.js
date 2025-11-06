'use strict';

/**
 * @.architecture
 * 
 * Incoming: All modules (.error/.warn/.info/.debug/.trace method calls) --- {log_types.log_entry, method_call}
 * Processing: Format log entry with timestamp, process type, PID, level, context, write to console (color-coded) and file (queued async), rotate logs when exceeding maxFileSize (10MB default, keep 5 files) --- {4 jobs: JOB_UPDATE_STATE, JOB_WRITE_FILE, JOB_UPDATE_STATE, JOB_WRITE_FILE}
 * Outgoing: Console output (STDOUT/STDERR), File system (userData/logs/aether.log) --- {log_types.formatted_log, string}
 * 
 * 
 * @module core/utils/logger
 * 
 * Production-Ready Rotating File Logger
 * ============================================================================
 * Provides structured logging with file rotation, log levels, and context.
 * 
 * Features:
 * - Log levels: ERROR, WARN, INFO, DEBUG, TRACE
 * - File rotation by size and count
 * - Console and file output
 * - Structured logging with timestamps
 * - Process-aware (main/renderer)
 * - Safe async write with queue
 * - Performance: lazy log file creation
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// ============================================================================
// Constants
// ============================================================================

const LOG_LEVELS = Object.freeze({
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
  TRACE: 4,
});

const LEVEL_NAMES = Object.freeze({
  0: 'ERROR',
  1: 'WARN',
  2: 'INFO',
  3: 'DEBUG',
  4: 'TRACE',
});

const LEVEL_COLORS = Object.freeze({
  ERROR: '\x1b[31m', // Red
  WARN: '\x1b[33m',  // Yellow
  INFO: '\x1b[36m',  // Cyan
  DEBUG: '\x1b[35m', // Magenta
  TRACE: '\x1b[90m', // Gray
});

const RESET_COLOR = '\x1b[0m';

// Default configuration
const DEFAULT_CONFIG = Object.freeze({
  level: LOG_LEVELS.INFO,
  console: true,
  file: true,
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 5,
  directory: null, // Auto-detect
  filename: 'aether.log',
});

// ============================================================================
// Logger Class
// ============================================================================

class Logger {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.writeQueue = [];
    this.isWriting = false;
    this.logFilePath = null;
    this.processType = this._detectProcessType();
    this.pid = process.pid;
    
    // Initialize log directory
    this._initializeLogDirectory();
    
    // Rotate logs on startup
    this._rotateLogs();
    
    // Write startup marker
    this._writeStartupMarker();
  }

  /**
   * Detect process type (main/renderer)
   */
  _detectProcessType() {
    try {
      if (process.type === 'browser') return 'main';
      if (process.type === 'renderer') return 'renderer';
      if (typeof window !== 'undefined') return 'renderer';
      return 'main';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Initialize log directory
   */
  _initializeLogDirectory() {
    try {
      let logDir = this.config.directory;
      
      if (!logDir) {
        // Auto-detect based on Electron userData path
        if (app && app.getPath) {
          const userDataPath = app.getPath('userData');
          logDir = path.join(userDataPath, 'logs');
        } else {
          // Fallback to current directory
          logDir = path.join(process.cwd(), 'logs');
        }
      }
      
      // Create directory if it doesn't exist
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true, mode: 0o755 });
      }
      
      this.logFilePath = path.join(logDir, this.config.filename);
      this.logDir = logDir;
    } catch (err) {
      console.error('[Logger] Failed to initialize log directory:', err);
      this.config.file = false; // Disable file logging
    }
  }

  /**
   * Write startup marker
   */
  _writeStartupMarker() {
    const marker = `\n${'='.repeat(80)}\n` +
      `[${new Date().toISOString()}] ${this.processType.toUpperCase()} PROCESS STARTED (PID: ${this.pid})\n` +
      `${'='.repeat(80)}\n`;
    
    if (this.config.file && this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, marker, 'utf8');
      } catch (err) {
        console.error('[Logger] Failed to write startup marker:', err);
      }
    }
  }

  /**
   * Rotate logs if current log exceeds max size
   */
  _rotateLogs() {
    if (!this.config.file || !this.logFilePath) return;
    
    try {
      // Check if current log file exists and its size
      if (fs.existsSync(this.logFilePath)) {
        const stats = fs.statSync(this.logFilePath);
        
        if (stats.size >= this.config.maxFileSize) {
          // Rotate existing logs
          this._performRotation();
        }
      }
    } catch (err) {
      console.error('[Logger] Log rotation failed:', err);
    }
  }

  /**
   * Perform log file rotation
   */
  _performRotation() {
    try {
      const basePath = this.logFilePath.replace(/\.log$/, '');
      
      // Shift existing rotated logs
      for (let i = this.config.maxFiles - 1; i >= 1; i--) {
        const currentPath = `${basePath}.${i}.log`;
        const nextPath = `${basePath}.${i + 1}.log`;
        
        if (fs.existsSync(currentPath)) {
          if (i === this.config.maxFiles - 1) {
            // Delete oldest log
            fs.unlinkSync(currentPath);
          } else {
            // Rename to next number
            fs.renameSync(currentPath, nextPath);
          }
        }
      }
      
      // Move current log to .1.log
      if (fs.existsSync(this.logFilePath)) {
        fs.renameSync(this.logFilePath, `${basePath}.1.log`);
      }
    } catch (err) {
      console.error('[Logger] Log rotation error:', err);
    }
  }

  /**
   * Format log entry
   */
  _formatEntry(level, message, context = {}) {
    const timestamp = new Date().toISOString();
    const levelName = LEVEL_NAMES[level];
    const contextStr = Object.keys(context).length > 0 
      ? ` ${JSON.stringify(context)}`
      : '';
    
    return `[${timestamp}] [${this.processType}:${this.pid}] [${levelName}] ${message}${contextStr}`;
  }

  /**
   * Format for console with colors
   */
  _formatConsole(level, message, context = {}) {
    const timestamp = new Date().toISOString();
    const levelName = LEVEL_NAMES[level];
    const color = LEVEL_COLORS[levelName] || '';
    const contextStr = Object.keys(context).length > 0
      ? ` ${JSON.stringify(context)}`
      : '';
    
    return `${color}[${timestamp}] [${levelName}]${RESET_COLOR} ${message}${contextStr}`;
  }

  /**
   * Write log entry to file (async, queued)
   */
  _writeToFile(entry) {
    if (!this.config.file || !this.logFilePath) return;
    
    this.writeQueue.push(entry + '\n');
    
    if (!this.isWriting) {
      this._processWriteQueue();
    }
  }

  /**
   * Process write queue
   */
  async _processWriteQueue() {
    if (this.writeQueue.length === 0) {
      this.isWriting = false;
      return;
    }
    
    this.isWriting = true;
    
    // Batch writes for performance
    const batch = this.writeQueue.splice(0, 100);
    const content = batch.join('');
    
    try {
      await fs.promises.appendFile(this.logFilePath, content, 'utf8');
      
      // Check if rotation needed after write
      const stats = await fs.promises.stat(this.logFilePath);
      if (stats.size >= this.config.maxFileSize) {
        this._rotateLogs();
      }
    } catch (err) {
      console.error('[Logger] File write error:', err);
    }
    
    // Continue processing queue
    setImmediate(() => this._processWriteQueue());
  }

  /**
   * Log at specific level
   */
  _log(level, message, context = {}) {
    // Check if level is enabled
    if (level > this.config.level) return;
    
    // Format entries
    const fileEntry = this._formatEntry(level, message, context);
    const consoleEntry = this._formatConsole(level, message, context);
    
    // Write to console
    if (this.config.console) {
      if (level === LOG_LEVELS.ERROR) {
        console.error(consoleEntry);
      } else if (level === LOG_LEVELS.WARN) {
        console.warn(consoleEntry);
      } else {
        console.log(consoleEntry);
      }
    }
    
    // Write to file
    this._writeToFile(fileEntry);
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Log error message
   */
  error(message, context = {}) {
    this._log(LOG_LEVELS.ERROR, message, context);
  }

  /**
   * Log warning message
   */
  warn(message, context = {}) {
    this._log(LOG_LEVELS.WARN, message, context);
  }

  /**
   * Log info message
   */
  info(message, context = {}) {
    this._log(LOG_LEVELS.INFO, message, context);
  }

  /**
   * Log debug message
   */
  debug(message, context = {}) {
    this._log(LOG_LEVELS.DEBUG, message, context);
  }

  /**
   * Log trace message
   */
  trace(message, context = {}) {
    this._log(LOG_LEVELS.TRACE, message, context);
  }

  /**
   * Set log level
   */
  setLevel(level) {
    if (typeof level === 'string') {
      this.config.level = LOG_LEVELS[level.toUpperCase()] ?? LOG_LEVELS.INFO;
    } else if (typeof level === 'number') {
      this.config.level = level;
    }
  }

  /**
   * Enable/disable console logging
   */
  setConsoleEnabled(enabled) {
    this.config.console = !!enabled;
  }

  /**
   * Enable/disable file logging
   */
  setFileEnabled(enabled) {
    this.config.file = !!enabled;
  }

  /**
   * Get log file path
   */
  getLogPath() {
    return this.logFilePath;
  }

  /**
   * Flush write queue (for graceful shutdown)
   */
  async flush() {
    // Wait for queue to empty
    while (this.writeQueue.length > 0 || this.isWriting) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  /**
   * Create child logger with context
   * Supports nested child loggers by returning an object with a child() method
   */
  child(defaultContext = {}) {
    const parentLogger = this;
    const childLogger = {
      error: (msg, ctx = {}) => parentLogger.error(msg, { ...defaultContext, ...ctx }),
      warn: (msg, ctx = {}) => parentLogger.warn(msg, { ...defaultContext, ...ctx }),
      info: (msg, ctx = {}) => parentLogger.info(msg, { ...defaultContext, ...ctx }),
      debug: (msg, ctx = {}) => parentLogger.debug(msg, { ...defaultContext, ...ctx }),
      trace: (msg, ctx = {}) => parentLogger.trace(msg, { ...defaultContext, ...ctx }),
      // Support nested child loggers
      child: (nestedContext = {}) => parentLogger.child({ ...defaultContext, ...nestedContext }),
    };
    return childLogger;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalLogger = null;

/**
 * Get or create global logger instance
 */
function getLogger(config = {}) {
  if (!globalLogger) {
    // Try to load config from unified config system
    try {
      const appConfig = require('../config');
      const logConfig = {
        level: LOG_LEVELS[appConfig.logging?.level?.toUpperCase()] ?? LOG_LEVELS.INFO,
        console: appConfig.logging?.console ?? true,
        file: appConfig.logging?.file ?? true,
        maxFileSize: appConfig.logging?.maxFileSize ?? DEFAULT_CONFIG.maxFileSize,
        maxFiles: appConfig.logging?.maxFiles ?? DEFAULT_CONFIG.maxFiles,
        ...config,
      };
      globalLogger = new Logger(logConfig);
    } catch {
      // Fallback to default config if unified config not available
      globalLogger = new Logger(config);
    }
  }
  return globalLogger;
}

/**
 * Create a new logger instance (not singleton)
 */
function createLogger(config = {}) {
  return new Logger(config);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  Logger,
  LOG_LEVELS,
  getLogger,
  createLogger,
  
  // Convenience exports
  logger: getLogger(),
};

