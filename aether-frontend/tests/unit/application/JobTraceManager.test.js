'use strict';

/**
 * JobTraceManager + JobTraceValidator Unit Tests
 * ============================================================================
 * Tests job tracing: validator contract enforcement, record lifecycle, history
 * management, context sanitization, extra validator chaining, event emission,
 * YAML registry loading, entry ID generation, and cleanup.
 *
 * Bug found and fixed during testing: fs, path, crypto were used but never
 * imported -- every call to record() would crash at runtime via _generateEntryId.
 *
 * @module tests/unit/application/JobTraceManager.test
 */

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  }),
}));

// Mock fs to prevent real filesystem access
jest.mock('fs', () => ({
  readFileSync: jest.fn(),
}));

const fs = require('fs');
const { JobTraceManager, JobTraceValidator } = require('../../../src/application/shared/JobTraceManager');

// ===========================================================================
// JobTraceValidator
// ===========================================================================
describe('JobTraceValidator', () => {
  // ---------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------
  describe('constructor', () => {
    it('accepts allowedJobTypes as array', () => {
      const v = new JobTraceValidator({ allowedJobTypes: ['JOB_A', 'JOB_B'] });
      expect(v.allowedJobTypes).toBeInstanceOf(Set);
      expect(v.allowedJobTypes.size).toBe(2);
      expect(v.allowedJobTypes.has('JOB_A')).toBe(true);
      expect(v.allowedJobTypes.has('JOB_B')).toBe(true);
    });

    it('accepts allowedJobTypes as Set', () => {
      const v = new JobTraceValidator({ allowedJobTypes: new Set(['JOB_X']) });
      expect(v.allowedJobTypes.has('JOB_X')).toBe(true);
    });

    it('normalizes job types to uppercase and trims whitespace', () => {
      const v = new JobTraceValidator({ allowedJobTypes: ['  job_a  ', 'Job_B'] });
      expect(v.allowedJobTypes.has('JOB_A')).toBe(true);
      expect(v.allowedJobTypes.has('JOB_B')).toBe(true);
    });

    it('defaults to empty Set when no types provided', () => {
      const v = new JobTraceValidator({});
      expect(v.allowedJobTypes.size).toBe(0);
    });

    it('defaults strict to true', () => {
      const v = new JobTraceValidator({});
      expect(v.strict).toBe(true);
    });

    it('respects strict=false', () => {
      const v = new JobTraceValidator({ strict: false });
      expect(v.strict).toBe(false);
    });

    it('handles non-array, non-Set allowedJobTypes gracefully', () => {
      const v = new JobTraceValidator({ allowedJobTypes: 'not-an-array' });
      expect(v.allowedJobTypes.size).toBe(0);
    });

    it('uses default options when called with no arguments', () => {
      const v = new JobTraceValidator();
      expect(v.allowedJobTypes.size).toBe(0);
      expect(v.strict).toBe(true);
    });
  });

  // ---------------------------------------------------------
  // validate()
  // ---------------------------------------------------------
  describe('validate()', () => {
    it('returns normalized (uppercase, trimmed) job type', () => {
      const v = new JobTraceValidator({ allowedJobTypes: ['job_emit_event'] });
      expect(v.validate('  job_emit_event  ')).toBe('JOB_EMIT_EVENT');
    });

    it('throws TypeError for empty string job type', () => {
      const v = new JobTraceValidator({});
      expect(() => v.validate('')).toThrow(TypeError);
      expect(() => v.validate('')).toThrow('non-empty jobType string');
    });

    it('throws TypeError for null job type', () => {
      const v = new JobTraceValidator({});
      expect(() => v.validate(null)).toThrow(TypeError);
    });

    it('throws TypeError for non-string job type', () => {
      const v = new JobTraceValidator({});
      expect(() => v.validate(123)).toThrow(TypeError);
    });

    it('throws TypeError for whitespace-only job type', () => {
      const v = new JobTraceValidator({});
      expect(() => v.validate('   ')).toThrow(TypeError);
    });

    it('throws TypeError when context is null', () => {
      const v = new JobTraceValidator({});
      expect(() => v.validate('JOB_A', null)).toThrow(TypeError);
      expect(() => v.validate('JOB_A', null)).toThrow('context to be an object');
    });

    it('throws TypeError when context is an array', () => {
      const v = new JobTraceValidator({});
      expect(() => v.validate('JOB_A', ['bad'])).toThrow(TypeError);
    });

    it('accepts valid context object', () => {
      const v = new JobTraceValidator({});
      expect(() => v.validate('JOB_A', { key: 'val' })).not.toThrow();
    });

    it('accepts undefined context (optional)', () => {
      const v = new JobTraceValidator({});
      expect(v.validate('JOB_A')).toBe('JOB_A');
    });

    it('rejects unknown job type in strict mode', () => {
      const v = new JobTraceValidator({
        allowedJobTypes: ['JOB_A'],
        strict: true,
      });
      expect(() => v.validate('JOB_UNKNOWN')).toThrow('unknown job type: JOB_UNKNOWN');
    });

    it('allows unknown job type when allowedJobTypes is empty (even in strict)', () => {
      const v = new JobTraceValidator({ strict: true });
      // Empty set = no restriction
      expect(v.validate('ANYTHING')).toBe('ANYTHING');
    });

    it('allows unknown job type in non-strict mode', () => {
      const v = new JobTraceValidator({
        allowedJobTypes: ['JOB_A'],
        strict: false,
      });
      expect(v.validate('JOB_UNKNOWN')).toBe('JOB_UNKNOWN');
    });
  });
});

// ===========================================================================
// JobTraceManager
// ===========================================================================
describe('JobTraceManager', () => {
  let manager;

  beforeEach(() => {
    fs.readFileSync.mockReset();
    // Provide explicit job types to avoid fs calls in constructor
    manager = new JobTraceManager({
      jobTypes: ['JOB_EMIT_EVENT', 'JOB_UPDATE_STATE', 'JOB_INITIALIZE', 'JOB_DISPOSE'],
      strict: true,
    });
  });

  afterEach(() => {
    manager = null;
  });

  // ---------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------
  describe('constructor', () => {
    it('uses default historyLimit of 500', () => {
      const m = new JobTraceManager({ jobTypes: [] });
      expect(m.historyLimit).toBe(500);
    });

    it('accepts custom historyLimit', () => {
      const m = new JobTraceManager({ historyLimit: 10, jobTypes: [] });
      expect(m.historyLimit).toBe(10);
    });

    it('rejects invalid historyLimit (non-integer, zero, negative)', () => {
      expect(new JobTraceManager({ historyLimit: 0, jobTypes: [] }).historyLimit).toBe(500);
      expect(new JobTraceManager({ historyLimit: -5, jobTypes: [] }).historyLimit).toBe(500);
      expect(new JobTraceManager({ historyLimit: 'abc', jobTypes: [] }).historyLimit).toBe(500);
      expect(new JobTraceManager({ historyLimit: 1.5, jobTypes: [] }).historyLimit).toBe(500);
    });

    it('stores eventBus reference', () => {
      const eventBus = { emit: jest.fn() };
      const m = new JobTraceManager({ eventBus, jobTypes: [] });
      expect(m.eventBus).toBe(eventBus);
    });

    it('defaults eventBus to null', () => {
      const m = new JobTraceManager({ jobTypes: [] });
      expect(m.eventBus).toBeNull();
    });

    it('accepts custom validator', () => {
      const v = new JobTraceValidator({ allowedJobTypes: ['X'] });
      const m = new JobTraceManager({ validator: v, jobTypes: [] });
      expect(m.validator).toBe(v);
    });

    it('creates default validator from jobTypes', () => {
      expect(manager.validator).toBeInstanceOf(JobTraceValidator);
    });

    it('initializes empty history and jobCounts', () => {
      expect(manager.history).toEqual([]);
      expect(manager.jobCounts.size).toBe(0);
    });

    it('initializes extraValidators as empty array when not provided', () => {
      expect(manager.extraValidators).toEqual([]);
    });

    it('accepts extraValidators array', () => {
      const v1 = jest.fn();
      const m = new JobTraceManager({ extraValidators: [v1], jobTypes: [] });
      expect(m.extraValidators).toEqual([v1]);
    });

    it('uses default options when called with no arguments', () => {
      fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      const m = new JobTraceManager();
      expect(m.historyLimit).toBe(500);
      expect(m.enableLogging).toBe(false);
      expect(m.eventBus).toBeNull();
      expect(m.registryPath).toBeNull();
    });
  });

  // ---------------------------------------------------------
  // record()
  // ---------------------------------------------------------
  describe('record()', () => {
    it('records a valid entry and returns it', () => {
      const entry = manager.record('JOB_EMIT_EVENT', { target: 'ui' });
      expect(entry.id).toBeDefined();
      expect(entry.id).toHaveLength(16); // SHA1 hex truncated to 16
      expect(entry.jobType).toBe('JOB_EMIT_EVENT');
      expect(entry.timestamp).toBeGreaterThan(0);
      expect(entry.context).toEqual({ target: 'ui' });
    });

    it('normalizes job type to uppercase', () => {
      const m = new JobTraceManager({ jobTypes: [], strict: false });
      const entry = m.record('job_custom');
      expect(entry.jobType).toBe('JOB_CUSTOM');
    });

    it('appends to history', () => {
      manager.record('JOB_EMIT_EVENT');
      manager.record('JOB_UPDATE_STATE');
      expect(manager.history).toHaveLength(2);
    });

    it('increments jobCounts per type', () => {
      manager.record('JOB_EMIT_EVENT');
      manager.record('JOB_EMIT_EVENT');
      manager.record('JOB_UPDATE_STATE');
      expect(manager.jobCounts.get('JOB_EMIT_EVENT')).toBe(2);
      expect(manager.jobCounts.get('JOB_UPDATE_STATE')).toBe(1);
    });

    it('throws on invalid job type (via validator)', () => {
      expect(() => manager.record('')).toThrow(TypeError);
      expect(() => manager.record(null)).toThrow(TypeError);
    });

    it('throws on unknown job type in strict mode', () => {
      expect(() => manager.record('JOB_UNKNOWN')).toThrow('unknown job type');
    });

    it('trims history when exceeding historyLimit', () => {
      const m = new JobTraceManager({ historyLimit: 3, jobTypes: [], strict: false });
      m.record('A');
      m.record('B');
      m.record('C');
      m.record('D');
      m.record('E');
      expect(m.history).toHaveLength(3);
      // Oldest entries removed
      expect(m.history[0].jobType).toBe('C');
      expect(m.history[2].jobType).toBe('E');
    });

    it('emits diagnostics:job-trace event when eventBus present', () => {
      const eventBus = { emit: jest.fn() };
      const m = new JobTraceManager({ eventBus, jobTypes: ['JOB_A'], strict: true });
      const entry = m.record('JOB_A');
      expect(eventBus.emit).toHaveBeenCalledWith('diagnostics:job-trace', entry);
    });

    it('does not throw when eventBus.emit fails', () => {
      const eventBus = { emit: jest.fn(() => { throw new Error('emit boom'); }) };
      const m = new JobTraceManager({ eventBus, jobTypes: ['JOB_A'] });
      expect(() => m.record('JOB_A')).not.toThrow();
    });

    it('does not emit when eventBus is null', () => {
      // Default manager has no eventBus
      expect(() => manager.record('JOB_EMIT_EVENT')).not.toThrow();
    });

    it('calls extra validators in order', () => {
      const callOrder = [];
      const v1 = jest.fn(() => callOrder.push('v1'));
      const v2 = jest.fn(() => callOrder.push('v2'));
      const m = new JobTraceManager({
        extraValidators: [v1, v2],
        jobTypes: ['JOB_A'],
      });
      m.record('JOB_A', { x: 1 });
      expect(v1).toHaveBeenCalledWith('JOB_A', { x: 1 });
      expect(v2).toHaveBeenCalledWith('JOB_A', { x: 1 });
      expect(callOrder).toEqual(['v1', 'v2']);
    });

    it('skips non-function extra validators without crashing', () => {
      const m = new JobTraceManager({
        extraValidators: ['not-a-fn', null, 42],
        jobTypes: ['JOB_A'],
      });
      expect(() => m.record('JOB_A')).not.toThrow();
    });
  });

  // ---------------------------------------------------------
  // Context sanitization
  // ---------------------------------------------------------
  describe('context sanitization', () => {
    it('strips undefined values from context', () => {
      const entry = manager.record('JOB_EMIT_EVENT', { a: 1, b: undefined });
      expect(entry.context).toEqual({ a: 1 });
      expect('b' in entry.context).toBe(false);
    });

    it('strips function values from context', () => {
      const entry = manager.record('JOB_EMIT_EVENT', { a: 1, fn: () => {} });
      expect(entry.context).toEqual({ a: 1 });
    });

    it('converts Error objects to {name, message}', () => {
      const err = new TypeError('bad input');
      const entry = manager.record('JOB_EMIT_EVENT', { error: err });
      expect(entry.context.error).toEqual({ name: 'TypeError', message: 'bad input' });
    });

    it('passes through normal values unchanged', () => {
      const entry = manager.record('JOB_EMIT_EVENT', {
        str: 'hello',
        num: 42,
        bool: true,
        arr: [1, 2],
        nested: { a: 1 },
      });
      expect(entry.context).toEqual({
        str: 'hello',
        num: 42,
        bool: true,
        arr: [1, 2],
        nested: { a: 1 },
      });
    });

    it('returns empty object for null context', () => {
      // record passes context to validator first, which rejects null
      // But _sanitizeContext itself handles null
      const m = new JobTraceManager({ jobTypes: [], strict: false });
      // Bypass validator by calling _sanitizeContext directly
      expect(m._sanitizeContext(null)).toEqual({});
      expect(m._sanitizeContext(undefined)).toEqual({});
      expect(m._sanitizeContext(42)).toEqual({});
    });

    it('returns empty object for empty context', () => {
      const entry = manager.record('JOB_EMIT_EVENT', {});
      expect(entry.context).toEqual({});
    });
  });

  // ---------------------------------------------------------
  // getHistory()
  // ---------------------------------------------------------
  describe('getHistory()', () => {
    beforeEach(() => {
      manager.record('JOB_EMIT_EVENT', { i: 1 });
      manager.record('JOB_UPDATE_STATE', { i: 2 });
      manager.record('JOB_INITIALIZE', { i: 3 });
    });

    it('returns all history when no limit', () => {
      expect(manager.getHistory()).toHaveLength(3);
    });

    it('returns all history for null limit', () => {
      expect(manager.getHistory(null)).toHaveLength(3);
    });

    it('returns last N entries for valid limit', () => {
      const result = manager.getHistory(2);
      expect(result).toHaveLength(2);
      expect(result[0].context.i).toBe(2);
      expect(result[1].context.i).toBe(3);
    });

    it('returns all when limit exceeds length', () => {
      expect(manager.getHistory(100)).toHaveLength(3);
    });

    it('returns copy (not reference)', () => {
      const h = manager.getHistory();
      h.push({ fake: true });
      expect(manager.getHistory()).toHaveLength(3);
    });

    it('returns full array for non-integer limit', () => {
      expect(manager.getHistory('abc')).toHaveLength(3);
      expect(manager.getHistory(1.5)).toHaveLength(3);
      expect(manager.getHistory(-1)).toHaveLength(3);
      expect(manager.getHistory(0)).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------
  // getStats()
  // ---------------------------------------------------------
  describe('getStats()', () => {
    it('returns zero stats initially', () => {
      const stats = manager.getStats();
      expect(stats.total).toBe(0);
      expect(stats.uniqueJobTypes).toBe(0);
      expect(stats.jobCounts).toEqual({});
    });

    it('reflects recorded entries', () => {
      manager.record('JOB_EMIT_EVENT');
      manager.record('JOB_EMIT_EVENT');
      manager.record('JOB_UPDATE_STATE');
      const stats = manager.getStats();
      expect(stats.total).toBe(3);
      expect(stats.uniqueJobTypes).toBe(2);
      expect(stats.jobCounts).toEqual({
        JOB_EMIT_EVENT: 2,
        JOB_UPDATE_STATE: 1,
      });
    });
  });

  // ---------------------------------------------------------
  // clear()
  // ---------------------------------------------------------
  describe('clear()', () => {
    it('empties history and jobCounts', () => {
      manager.record('JOB_EMIT_EVENT');
      manager.record('JOB_UPDATE_STATE');
      manager.clear();
      expect(manager.history).toEqual([]);
      expect(manager.jobCounts.size).toBe(0);
      expect(manager.getStats().total).toBe(0);
    });
  });

  // ---------------------------------------------------------
  // attachValidator()
  // ---------------------------------------------------------
  describe('attachValidator()', () => {
    it('adds function to extraValidators', () => {
      const v = jest.fn();
      manager.attachValidator(v);
      expect(manager.extraValidators).toContain(v);
    });

    it('attached validator is invoked on record()', () => {
      const v = jest.fn();
      manager.attachValidator(v);
      manager.record('JOB_EMIT_EVENT', { test: true });
      expect(v).toHaveBeenCalledWith('JOB_EMIT_EVENT', { test: true });
    });

    it('throws TypeError for non-function argument', () => {
      expect(() => manager.attachValidator('not-fn')).toThrow(TypeError);
      expect(() => manager.attachValidator(null)).toThrow(TypeError);
      expect(() => manager.attachValidator(123)).toThrow(TypeError);
    });
  });

  // ---------------------------------------------------------
  // _loadAllowedJobTypes (YAML registry)
  // ---------------------------------------------------------
  describe('_loadAllowedJobTypes()', () => {
    it('returns explicit job types when provided', () => {
      const m = new JobTraceManager({ jobTypes: ['job_a', 'job_b'] });
      expect(m.allowedJobTypes.has('JOB_A')).toBe(true);
      expect(m.allowedJobTypes.has('JOB_B')).toBe(true);
    });

    it('loads from YAML when no explicit types', () => {
      fs.readFileSync.mockReturnValue(`
catalog:
  category1:
    entries:
      - id: JOB_TEST
      - id: JOB_OTHER
`);
      const m = new JobTraceManager({});
      expect(m.allowedJobTypes.has('JOB_TEST')).toBe(true);
      expect(m.allowedJobTypes.has('JOB_OTHER')).toBe(true);
    });

    it('falls back to empty set when YAML read fails', () => {
      fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      const m = new JobTraceManager({});
      expect(m.allowedJobTypes.size).toBe(0);
    });

    it('falls back to empty set when YAML has no catalog', () => {
      fs.readFileSync.mockReturnValue('random: data');
      const m = new JobTraceManager({});
      expect(m.allowedJobTypes.size).toBe(0);
    });

    it('handles YAML with empty catalog categories', () => {
      fs.readFileSync.mockReturnValue(`
catalog:
  empty_category: null
  valid:
    entries:
      - id: JOB_FOUND
`);
      const m = new JobTraceManager({});
      expect(m.allowedJobTypes.has('JOB_FOUND')).toBe(true);
    });

    it('handles YAML with entries missing id', () => {
      fs.readFileSync.mockReturnValue(`
catalog:
  cat:
    entries:
      - name: no_id
      - id: JOB_HAS_ID
`);
      const m = new JobTraceManager({});
      expect(m.allowedJobTypes.has('JOB_HAS_ID')).toBe(true);
      expect(m.allowedJobTypes.size).toBe(1);
    });

    it('handles custom registryPath', () => {
      fs.readFileSync.mockReturnValue(`
catalog:
  cat:
    entries:
      - id: JOB_CUSTOM
`);
      const m = new JobTraceManager({ registryPath: '/custom/path.yaml' });
      expect(fs.readFileSync).toHaveBeenCalledWith('/custom/path.yaml', 'utf-8');
      expect(m.allowedJobTypes.has('JOB_CUSTOM')).toBe(true);
    });

    it('deduplicates cwdCandidate when it matches registryPath', () => {
      const pathMod = require('path');
      const cwdCandidate = pathMod.resolve(process.cwd(), 'Architecture', 'frontend_job_registry.yaml');
      fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      const m = new JobTraceManager({ registryPath: cwdCandidate });
      // _resolveRegistryCandidates should NOT add cwdCandidate twice
      const candidates = m._resolveRegistryCandidates();
      const cwdCount = candidates.filter(c => c === cwdCandidate).length;
      expect(cwdCount).toBe(1);
    });
  });

  // ---------------------------------------------------------
  // _generateEntryId
  // ---------------------------------------------------------
  describe('_generateEntryId()', () => {
    it('returns 16-character hex string', () => {
      const id = manager._generateEntryId('JOB_TEST');
      expect(id).toMatch(/^[a-f0-9]{16}$/);
    });

    it('generates unique IDs across calls', () => {
      const ids = new Set();
      for (let i = 0; i < 50; i++) {
        ids.add(manager._generateEntryId('JOB_TEST'));
      }
      // With timestamp + random, collisions are astronomically unlikely
      expect(ids.size).toBe(50);
    });
  });

  // ---------------------------------------------------------
  // Logging behavior
  // ---------------------------------------------------------
  describe('logging', () => {
    it('logs warnings and errors even when enableLogging is false', () => {
      const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };
      const m = new JobTraceManager({
        enableLogging: false,
        logger,
        jobTypes: ['JOB_A'],
      });
      // Force a warn-level log by failing YAML load
      // (constructor already attempted YAML load and logged)
      // Instead, test via eventBus emit failure
      const eventBus = { emit: jest.fn(() => { throw new Error('boom'); }) };
      m.eventBus = eventBus;
      m.record('JOB_A');
      expect(logger.warn).toHaveBeenCalled();
    });

    it('logs debug when enableLogging is true', () => {
      const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };
      const m = new JobTraceManager({
        enableLogging: true,
        logger,
        jobTypes: ['JOB_A'],
      });
      m.record('JOB_A');
      expect(logger.debug).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------
  // _createDefaultLogger and _log edge cases
  // ---------------------------------------------------------
  describe('_createDefaultLogger and _log edge cases', () => {
    it('default logger methods (debug, info, error) delegate to module _log', () => {
      // No custom logger → _createDefaultLogger used
      // enableLogging=true → _log calls through to logger methods
      // YAML success → _log('info', ...) fires default logger.info
      fs.readFileSync.mockReturnValue(`
catalog:
  cat:
    entries:
      - id: JOB_TEST_DEFAULT
`);
      const m = new JobTraceManager({ enableLogging: true });
      // Constructor YAML success: default logger.info (line 226) invoked
      // record() calls _log('debug', ...): default logger.debug (line 225) invoked
      m.record('JOB_TEST_DEFAULT');
      // Manually trigger error path (no source code path calls it)
      m._log('error', 'test error path');
      // default logger.error (line 228) invoked -- no throw
    });

    it('_log optional chaining handles missing logger method (enableLogging=false)', () => {
      const m = new JobTraceManager({
        enableLogging: false,
        logger: { debug: jest.fn() }, // missing warn, error, info
        jobTypes: ['JOB_A'],
      });
      // enableLogging=false + level='warn': tries this.logger.warn?.()
      // logger.warn is undefined → optional chaining = no-op
      expect(() => m._log('warn', 'missing method test')).not.toThrow();
    });

    it('_log skips call when logger method is not a function (enableLogging=true)', () => {
      const m = new JobTraceManager({
        enableLogging: true,
        logger: { warn: jest.fn() }, // missing debug, info, error
        jobTypes: ['JOB_A'],
      });
      // enableLogging=true + level='debug': typeof this.logger.debug === 'function' → false
      expect(() => m._log('debug', 'no debug method')).not.toThrow();
    });

    it('_log handles error level with enableLogging=false', () => {
      const logger = {
        debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
      };
      const m = new JobTraceManager({
        enableLogging: false, logger, jobTypes: ['JOB_A'],
      });
      m._log('error', 'error without logging');
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------
  // YAML parsing edge cases
  // ---------------------------------------------------------
  describe('YAML parsing edge cases', () => {
    it('handles YAML that parses to null (empty file)', () => {
      fs.readFileSync.mockReturnValue('');
      const m = new JobTraceManager({});
      expect(m.allowedJobTypes.size).toBe(0);
    });

    it('handles YAML with non-object catalog value', () => {
      fs.readFileSync.mockReturnValue('catalog: "just a string"');
      const m = new JobTraceManager({});
      expect(m.allowedJobTypes.size).toBe(0);
    });

    it('handles YAML with non-array entries', () => {
      fs.readFileSync.mockReturnValue(`
catalog:
  cat:
    entries: "not an array"
`);
      const m = new JobTraceManager({});
      expect(m.allowedJobTypes.size).toBe(0);
    });

    it('handles YAML with non-object entry items', () => {
      fs.readFileSync.mockReturnValue(`
catalog:
  cat:
    entries:
      - "just a string"
      - id: VALID_JOB
`);
      const m = new JobTraceManager({});
      expect(m.allowedJobTypes.has('VALID_JOB')).toBe(true);
      expect(m.allowedJobTypes.size).toBe(1);
    });

    it('handles YAML with empty string entry id', () => {
      fs.readFileSync.mockReturnValue(`
catalog:
  cat:
    entries:
      - id: ""
      - id: REAL_JOB
`);
      const m = new JobTraceManager({});
      expect(m.allowedJobTypes.has('REAL_JOB')).toBe(true);
      expect(m.allowedJobTypes.size).toBe(1);
    });

    it('handles YAML with non-string category value', () => {
      fs.readFileSync.mockReturnValue(`
catalog:
  stringCat: "not an object"
  realCat:
    entries:
      - id: JOB_OK
`);
      const m = new JobTraceManager({});
      expect(m.allowedJobTypes.has('JOB_OK')).toBe(true);
    });
  });

  // ---------------------------------------------------------
  // Full lifecycle integration
  // ---------------------------------------------------------
  describe('full lifecycle', () => {
    it('record -> getHistory -> getStats -> clear', () => {
      const eventBus = { emit: jest.fn() };
      const m = new JobTraceManager({
        eventBus,
        jobTypes: ['JOB_A', 'JOB_B'],
        historyLimit: 100,
      });

      // Record entries
      m.record('JOB_A', { phase: 'start' });
      m.record('JOB_B', { phase: 'middle' });
      m.record('JOB_A', { phase: 'end' });

      // Verify history
      const history = m.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0].jobType).toBe('JOB_A');
      expect(history[1].jobType).toBe('JOB_B');
      expect(history[2].jobType).toBe('JOB_A');

      // Verify stats
      const stats = m.getStats();
      expect(stats.total).toBe(3);
      expect(stats.uniqueJobTypes).toBe(2);
      expect(stats.jobCounts.JOB_A).toBe(2);
      expect(stats.jobCounts.JOB_B).toBe(1);

      // Verify events emitted
      expect(eventBus.emit).toHaveBeenCalledTimes(3);

      // Clear
      m.clear();
      expect(m.getStats().total).toBe(0);
      expect(m.getHistory()).toEqual([]);
    });

    it('history trimming under pressure', () => {
      const m = new JobTraceManager({
        historyLimit: 5,
        jobTypes: [],
        strict: false,
      });

      for (let i = 0; i < 20; i++) {
        m.record(`TYPE_${i}`);
      }

      expect(m.history).toHaveLength(5);
      // Should contain the last 5 entries
      expect(m.history[0].jobType).toBe('TYPE_15');
      expect(m.history[4].jobType).toBe('TYPE_19');

      // But jobCounts should reflect all 20 recordings
      const stats = m.getStats();
      expect(stats.uniqueJobTypes).toBe(20);
    });
  });
});
