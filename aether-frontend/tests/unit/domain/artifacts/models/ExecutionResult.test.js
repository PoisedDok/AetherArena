'use strict';

const { ExecutionResult } = require('../../../../../src/domain/artifacts/models/ExecutionResult');

describe('ExecutionResult Domain Model', () => {
  describe('Constructor', () => {
    it('should create with defaults', () => {
      const r = new ExecutionResult();
      expect(r.success).toBe(false);
      expect(r.completed).toBe(false);
      expect(r.result).toBeNull();
      expect(r.logs).toEqual([]);
      expect(r.error).toBeNull();
      expect(r.stack).toBeNull();
      expect(r.executionTime).toBe(0);
      expect(r.timeout).toBe(false);
      expect(r.executorType).toBe('worker');
      expect(typeof r.timestamp).toBe('number');
    });

    it('should be frozen (immutable)', () => {
      const r = new ExecutionResult({ success: true });
      expect(() => { r.success = false; }).toThrow();
    });

    it('should deep copy logs array', () => {
      const logs = ['log1'];
      const r = new ExecutionResult({ logs });
      logs.push('log2');
      expect(r.logs).toEqual(['log1']);
    });

    it('should accept all fields', () => {
      const r = new ExecutionResult({
        success: true, completed: true, result: 42,
        logs: ['a', 'b'], error: 'err', stack: 'trace',
        executionTime: 100, timeout: false,
        artifactId: 'art-1', executorType: 'sandbox'
      });
      expect(r.success).toBe(true);
      expect(r.result).toBe(42);
      expect(r.logs).toEqual(['a', 'b']);
      expect(r.artifactId).toBe('art-1');
      expect(r.executorType).toBe('sandbox');
    });
  });

  describe('Status checks', () => {
    it('isSuccess: true when success and no error', () => {
      expect(new ExecutionResult({ success: true }).isSuccess()).toBe(true);
      expect(new ExecutionResult({ success: true, error: 'oops' }).isSuccess()).toBe(false);
      expect(new ExecutionResult({ success: false }).isSuccess()).toBe(false);
    });

    it('hasError: true when error present', () => {
      expect(new ExecutionResult({ error: 'fail' }).hasError()).toBe(true);
      expect(new ExecutionResult().hasError()).toBe(false);
    });

    it('isTimeout: true when timeout flag set', () => {
      expect(new ExecutionResult({ timeout: true }).isTimeout()).toBe(true);
      expect(new ExecutionResult().isTimeout()).toBe(false);
    });

    it('hasOutput: true when result or logs exist', () => {
      expect(new ExecutionResult({ result: 42 }).hasOutput()).toBe(true);
      expect(new ExecutionResult({ logs: ['x'] }).hasOutput()).toBe(true);
      expect(new ExecutionResult().hasOutput()).toBe(false);
    });
  });

  describe('Output formatting', () => {
    it('should format error message', () => {
      const r = new ExecutionResult({ error: 'TypeError', stack: 'at line 1' });
      const msg = r.getErrorMessage();
      expect(msg).toContain('TypeError');
      expect(msg).toContain('Stack trace:');
      expect(msg).toContain('at line 1');
    });

    it('should return null error message when no error', () => {
      expect(new ExecutionResult().getErrorMessage()).toBeNull();
    });

    it('should format error without stack', () => {
      const r = new ExecutionResult({ error: 'oops' });
      expect(r.getErrorMessage()).toBe('oops');
    });

    it('should format logs as string', () => {
      const r = new ExecutionResult({ logs: ['line1', 'line2'] });
      expect(r.getLogsString()).toBe('line1\nline2');
    });
  });

  describe('Summary', () => {
    it('should report timeout', () => {
      const r = new ExecutionResult({ timeout: true, executionTime: 5000 });
      expect(r.getSummary()).toContain('timeout');
      expect(r.getSummary()).toContain('5000ms');
    });

    it('should report error', () => {
      const r = new ExecutionResult({ error: 'fail' });
      expect(r.getSummary()).toContain('failed');
    });

    it('should report success', () => {
      const r = new ExecutionResult({ success: true, executionTime: 100 });
      expect(r.getSummary()).toContain('completed');
      expect(r.getSummary()).toContain('100ms');
    });

    it('should report pending', () => {
      expect(new ExecutionResult().getSummary()).toContain('pending');
    });
  });

  describe('Serialization', () => {
    it('should round-trip through toJSON/fromJSON', () => {
      const original = new ExecutionResult({
        success: true, completed: true, result: 'ok',
        logs: ['a'], executionTime: 50, artifactId: 'art-1'
      });
      const restored = ExecutionResult.fromJSON(original.toJSON());
      expect(restored.success).toBe(true);
      expect(restored.result).toBe('ok');
      expect(restored.logs).toEqual(['a']);
      expect(restored.artifactId).toBe('art-1');
    });

    it('should deep copy logs in toJSON', () => {
      const r = new ExecutionResult({ logs: ['x'] });
      const json = r.toJSON();
      json.logs.push('y');
      expect(r.logs).toEqual(['x']);
    });
  });

  describe('Factory methods', () => {
    it('should create success result', () => {
      const r = ExecutionResult.success('output', ['log1'], 42);
      expect(r.success).toBe(true);
      expect(r.completed).toBe(true);
      expect(r.result).toBe('output');
      expect(r.logs).toEqual(['log1']);
      expect(r.executionTime).toBe(42);
    });

    it('should create error result from string', () => {
      const r = ExecutionResult.error('bad input', 'stack trace', ['log'], 10);
      expect(r.success).toBe(false);
      expect(r.completed).toBe(true);
      expect(r.error).toBe('bad input');
      expect(r.stack).toBe('stack trace');
    });

    it('should create error result from Error object', () => {
      const err = new Error('fail');
      const r = ExecutionResult.error(err);
      expect(r.error).toBe('fail');
      expect(r.stack).toBe(err.stack);
    });

    it('should create timeout result', () => {
      const r = ExecutionResult.timeout(5000, ['partial log']);
      expect(r.success).toBe(false);
      expect(r.completed).toBe(true);
      expect(r.timeout).toBe(true);
      expect(r.executionTime).toBe(5000);
      expect(r.error).toContain('5000ms');
    });

    it('should create pending result', () => {
      const r = ExecutionResult.pending();
      expect(r.success).toBe(false);
      expect(r.completed).toBe(false);
      expect(r.error).toBeNull();
    });
  });
});
