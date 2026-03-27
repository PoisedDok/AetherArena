'use strict';

/**
 * @.architecture
 * Incoming: Orchestrators._traceJob() --- {object, javascript_api}
 * Processing: Load job registry YAML, validate job types via JobTraceValidator.validate(), record entries with metadata, maintain bounded history, emit diagnostics events --- {6 jobs: JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_INITIALIZE, JOB_TRACK_ENTITY, JOB_VALIDATE_SCHEMA}
 * Outgoing: EventBus.emit('diagnostics:job-trace'), getStats()/getHistory() callers --- {object, javascript_api}
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YAML = require('yaml');
const { createRendererLogger } = require('../../renderer/shared/utils/logger');
const _log = createRendererLogger('JobTraceManager');

class JobTraceValidator {
  constructor(options = {}) {
    const jobTypes = Array.isArray(options.allowedJobTypes)
      ? options.allowedJobTypes
      : options.allowedJobTypes instanceof Set
        ? Array.from(options.allowedJobTypes)
        : [];

    this.allowedJobTypes = new Set(jobTypes.map((job) => job.trim().toUpperCase()));
    this.strict = options.strict !== false;
  }

  validate(jobType, context) {
    if (typeof jobType !== 'string' || jobType.trim().length === 0) {
      throw new TypeError('JobTraceValidator.validate expects a non-empty jobType string');
    }

    if (context !== undefined && (context === null || typeof context !== 'object' || Array.isArray(context))) {
      throw new TypeError('JobTraceValidator.validate expects context to be an object when provided');
    }

    const normalized = jobType.trim().toUpperCase();

    if (this.strict && this.allowedJobTypes.size > 0 && !this.allowedJobTypes.has(normalized)) {
      throw new Error(`JobTraceValidator.validate received unknown job type: ${normalized}`);
    }

    return normalized;
  }
}

class JobTraceManager {
  constructor(options = {}) {
    this.enableLogging = options.enableLogging || false;
    this.historyLimit = Number.isInteger(options.historyLimit) && options.historyLimit > 0
      ? options.historyLimit
      : 500;
    this.eventBus = options.eventBus || null;
    this.logger = options.logger || this._createDefaultLogger();
    this.registryPath = options.registryPath || null;
    this.extraValidators = Array.isArray(options.extraValidators) ? options.extraValidators : [];

    this.allowedJobTypes = this._loadAllowedJobTypes(options.jobTypes || null);
    this.validator = options.validator instanceof JobTraceValidator
      ? options.validator
      : new JobTraceValidator({ allowedJobTypes: this.allowedJobTypes, strict: options.strict !== false });

    this.history = [];
    this.jobCounts = new Map();
  }

  record(jobType, context = {}) {
    const normalizedType = this.validator.validate(jobType, context);
    const sanitizedContext = this._sanitizeContext(context);

    for (const validator of this.extraValidators) {
      if (typeof validator === 'function') {
        validator(normalizedType, sanitizedContext);
      }
    }

    const entry = {
      id: this._generateEntryId(normalizedType),
      jobType: normalizedType,
      timestamp: Date.now(),
      context: sanitizedContext
    };

    this.history.push(entry);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }

    this.jobCounts.set(normalizedType, (this.jobCounts.get(normalizedType) || 0) + 1);

    if (this.eventBus && typeof this.eventBus.emit === 'function') {
      try {
        this.eventBus.emit('diagnostics:job-trace', entry);
      } catch (eventError) {
        this._log('warn', 'JobTraceManager failed to emit diagnostics event', { eventError });
      }
    }

    this._log('debug', 'Job traced', { jobType: normalizedType, context: sanitizedContext });
    return entry;
  }

  getHistory(limit = null) {
    if (limit === null || !Number.isInteger(limit) || limit <= 0) {
      return [...this.history];
    }

    return this.history.slice(-limit);
  }

  getStats() {
    return {
      total: this.history.length,
      jobCounts: Object.fromEntries(this.jobCounts.entries()),
      uniqueJobTypes: this.jobCounts.size
    };
  }

  clear() {
    this.history = [];
    this.jobCounts.clear();
  }

  attachValidator(validator) {
    if (typeof validator !== 'function') {
      throw new TypeError('attachValidator expects a function');
    }
    this.extraValidators.push(validator);
  }

  _sanitizeContext(context) {
    if (!context || typeof context !== 'object') {
      return {};
    }

    const sanitized = {};
    for (const [key, value] of Object.entries(context)) {
      if (value === undefined || typeof value === 'function') {
        continue;
      }

      if (value instanceof Error) {
        sanitized[key] = {
          name: value.name,
          message: value.message
        };
        continue;
      }

      sanitized[key] = value;
    }
    return sanitized;
  }

  _loadAllowedJobTypes(explicitJobTypes) {
    if (Array.isArray(explicitJobTypes) && explicitJobTypes.length > 0) {
      return new Set(explicitJobTypes.map((job) => job.trim().toUpperCase()));
    }

    const candidates = this._resolveRegistryCandidates();

    for (const candidate of candidates) {
      try {
        const raw = fs.readFileSync(candidate, 'utf-8');
        const parsed = YAML.parse(raw);
        const catalog = parsed && typeof parsed === 'object' ? parsed.catalog : null;
        const allowed = new Set();

        if (catalog && typeof catalog === 'object') {
          for (const category of Object.values(catalog)) {
            if (!category || typeof category !== 'object') {
              continue;
            }

            const entries = Array.isArray(category.entries) ? category.entries : [];
            for (const entry of entries) {
              const id = entry && typeof entry === 'object' ? entry.id : null;
              if (typeof id === 'string' && id.trim().length > 0) {
                allowed.add(id.trim().toUpperCase());
              }
            }
          }
        }

        if (allowed.size > 0) {
          this._log('info', 'Job registry loaded', { path: candidate, totalJobs: allowed.size });
          return allowed;
        }
      } catch (error) {
        this._log('warn', 'Job registry load failed', { path: candidate, error: error.message });
      }
    }

    this._log('warn', 'Falling back to permissive job tracing (no registry loaded)');
    return new Set();
  }

  _resolveRegistryCandidates() {
    const candidates = [];

    if (this.registryPath) {
      candidates.push(this.registryPath);
    }

    const localCandidate = path.resolve(__dirname, '../../../..', 'Architecture', 'frontend_job_registry.yaml');
    candidates.push(localCandidate);

    const cwdCandidate = path.resolve(process.cwd(), 'Architecture', 'frontend_job_registry.yaml');
    if (!candidates.includes(cwdCandidate)) {
      candidates.push(cwdCandidate);
    }

    return candidates;
  }

  _generateEntryId(jobType) {
    const hash = crypto.createHash('sha1');
    hash.update(`${jobType}:${Date.now()}:${Math.random()}`);
    return hash.digest('hex').slice(0, 16);
  }

  _createDefaultLogger() {
    return {
      debug: (...args) => _log.debug('[JobTraceManager]', ...args),
      info: (...args) => _log.info('[JobTraceManager]', ...args),
      warn: (...args) => _log.warn('[JobTraceManager]', ...args),
      error: (...args) => _log.error('[JobTraceManager]', ...args)
    };
  }

  _log(level, message, meta = {}) {
    if (!this.enableLogging) {
      if (level === 'warn' || level === 'error') {
        this.logger[level]?.(`[JobTraceManager] ${message}`, meta);
      }
      return;
    }

    if (typeof this.logger[level] === 'function') {
      this.logger[level](`[JobTraceManager] ${message}`, meta);
    }
  }
}

module.exports = {
  JobTraceManager,
  JobTraceValidator
};
