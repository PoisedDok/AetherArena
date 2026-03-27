'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createDomainLogger: () => ({ child: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) })
}));

const { ArtifactExecutor } = require('../../../../../src/domain/artifacts/services/ArtifactExecutor');

// --- Helpers ---

function createMockDeps(overrides = {}) {
  return {
    codeExecutor: {
      executeJavaScript: jest.fn().mockResolvedValue({ success: true, output: '42', executionTime: 15 })
    },
    eventBus: { emit: jest.fn() },
    errorTracker: { captureException: jest.fn() },
    performanceMonitor: { start: jest.fn(), end: jest.fn() },
    ...overrides
  };
}

function codeArtifact(overrides = {}) {
  return { id: 'art-001', type: 'code', content: 'console.log(42)', language: 'javascript', ...overrides };
}

describe('ArtifactExecutor', () => {
  describe('constructor', () => {
    it('throws when codeExecutor is missing', () => {
      expect(() => new ArtifactExecutor({ eventBus: { emit: jest.fn() } }))
        .toThrow('SafeCodeExecutor is required');
    });

    it('throws when eventBus is missing', () => {
      expect(() => new ArtifactExecutor({ codeExecutor: {} }))
        .toThrow('EventBus is required');
    });

    it('initializes with correct state', () => {
      const deps = createMockDeps();
      const exec = new ArtifactExecutor(deps);
      expect(exec.isExecuting).toBe(false);
      expect(exec.currentExecutionId).toBeNull();
    });
  });

  describe('execute()', () => {
    let executor, deps;

    beforeEach(() => {
      deps = createMockDeps();
      executor = new ArtifactExecutor(deps);
    });

    it('executes code artifact and returns result', async () => {
      const result = await executor.execute(codeArtifact());
      expect(result.success).toBe(true);
      expect(deps.codeExecutor.executeJavaScript).toHaveBeenCalledWith(
        'console.log(42)',
        { language: 'javascript', timeout: 30000 }
      );
    });

    it('emits artifacts:executed event on success', async () => {
      await executor.execute(codeArtifact());
      expect(deps.eventBus.emit).toHaveBeenCalledWith('artifacts:executed', expect.objectContaining({
        artifactId: 'art-001',
        language: 'javascript',
        success: true
      }));
    });

    it('stores execution result in results Map', async () => {
      await executor.execute(codeArtifact());
      const stored = executor.getExecutionResult('art-001');
      expect(stored).toBeTruthy();
      expect(stored.artifactId).toBe('art-001');
      expect(stored.executedAt).toBeGreaterThan(0);
    });

    it('passes custom timeout', async () => {
      await executor.execute(codeArtifact(), { timeout: 5000 });
      expect(deps.codeExecutor.executeJavaScript).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timeout: 5000 })
      );
    });

    it('starts/ends performance monitoring', async () => {
      await executor.execute(codeArtifact());
      expect(deps.performanceMonitor.start).toHaveBeenCalledWith('execute:art-001');
      expect(deps.performanceMonitor.end).toHaveBeenCalledWith('execute:art-001');
    });

    it('resets isExecuting after success', async () => {
      await executor.execute(codeArtifact());
      expect(executor.isExecuting).toBe(false);
      expect(executor.currentExecutionId).toBeNull();
    });

    // Error handling
    it('throws and emits failure event on execution error', async () => {
      deps.codeExecutor.executeJavaScript.mockRejectedValue(new Error('Sandbox error'));
      await expect(executor.execute(codeArtifact())).rejects.toThrow('Sandbox error');
      expect(deps.eventBus.emit).toHaveBeenCalledWith('artifacts:execution-failed', expect.objectContaining({
        artifactId: 'art-001',
        error: 'Sandbox error'
      }));
    });

    it('stores error result on failure', async () => {
      deps.codeExecutor.executeJavaScript.mockRejectedValue(new Error('fail'));
      await expect(executor.execute(codeArtifact())).rejects.toThrow();
      const result = executor.getExecutionResult('art-001');
      expect(result.success).toBe(false);
      expect(result.error).toBe('fail');
    });

    it('reports to errorTracker on failure', async () => {
      deps.codeExecutor.executeJavaScript.mockRejectedValue(new Error('fail'));
      await expect(executor.execute(codeArtifact())).rejects.toThrow();
      expect(deps.errorTracker.captureException).toHaveBeenCalled();
    });

    it('resets isExecuting after failure', async () => {
      deps.codeExecutor.executeJavaScript.mockRejectedValue(new Error('fail'));
      await expect(executor.execute(codeArtifact())).rejects.toThrow();
      expect(executor.isExecuting).toBe(false);
    });

    it('ends performance monitoring after failure', async () => {
      deps.codeExecutor.executeJavaScript.mockRejectedValue(new Error('fail'));
      await expect(executor.execute(codeArtifact())).rejects.toThrow();
      expect(deps.performanceMonitor.end).toHaveBeenCalledWith('execute:art-001');
    });

    // Validation
    it('throws on null artifact', async () => {
      await expect(executor.execute(null)).rejects.toThrow('Artifact is required');
    });

    it('throws on missing artifact.id', async () => {
      await expect(executor.execute({ type: 'code', content: 'x', language: 'js' })).rejects.toThrow('artifact.id is required');
    });

    it('throws on non-code artifact type', async () => {
      await expect(executor.execute(codeArtifact({ type: 'output' }))).rejects.toThrow('Cannot execute non-code');
    });

    it('throws on missing content', async () => {
      await expect(executor.execute(codeArtifact({ content: null }))).rejects.toThrow('artifact.content is required');
    });

    it('throws on missing language', async () => {
      await expect(executor.execute(codeArtifact({ language: null }))).rejects.toThrow('artifact.language is required');
    });

    it('throws when already executing', async () => {
      // Start a long execution
      deps.codeExecutor.executeJavaScript.mockReturnValue(new Promise(() => {})); // never resolves
      executor.execute(codeArtifact());
      // Try to execute again immediately
      await expect(executor.execute(codeArtifact({ id: 'art-002' }))).rejects.toThrow('Already executing');
    });
  });

  describe('getExecutionResult()', () => {
    it('returns null for non-existent artifact', () => {
      const exec = new ArtifactExecutor(createMockDeps());
      expect(exec.getExecutionResult('nonexistent')).toBeNull();
    });

    it('throws on invalid artifactId', () => {
      const exec = new ArtifactExecutor(createMockDeps());
      expect(() => exec.getExecutionResult(null)).toThrow('artifactId is required');
      expect(() => exec.getExecutionResult(42)).toThrow('artifactId is required');
    });
  });

  describe('hasExecutionResult()', () => {
    it('returns false for non-existent', () => {
      const exec = new ArtifactExecutor(createMockDeps());
      expect(exec.hasExecutionResult('nonexistent')).toBe(false);
    });

    it('returns false for invalid input', () => {
      const exec = new ArtifactExecutor(createMockDeps());
      expect(exec.hasExecutionResult(null)).toBe(false);
      expect(exec.hasExecutionResult(42)).toBe(false);
    });
  });

  describe('clearExecutionResult()', () => {
    it('clears existing result and returns true', async () => {
      const exec = new ArtifactExecutor(createMockDeps());
      await exec.execute(codeArtifact());
      expect(exec.clearExecutionResult('art-001')).toBe(true);
      expect(exec.hasExecutionResult('art-001')).toBe(false);
    });

    it('returns false for non-existent', () => {
      const exec = new ArtifactExecutor(createMockDeps());
      expect(exec.clearExecutionResult('nonexistent')).toBe(false);
    });

    it('throws on invalid input', () => {
      const exec = new ArtifactExecutor(createMockDeps());
      expect(() => exec.clearExecutionResult(null)).toThrow('artifactId is required');
    });
  });

  describe('clearAllResults()', () => {
    it('clears all stored results', async () => {
      const exec = new ArtifactExecutor(createMockDeps());
      await exec.execute(codeArtifact({ id: 'a1' }));
      await exec.execute(codeArtifact({ id: 'a2' }));
      exec.clearAllResults();
      expect(exec.hasExecutionResult('a1')).toBe(false);
      expect(exec.hasExecutionResult('a2')).toBe(false);
    });
  });

  describe('getStats()', () => {
    it('returns accurate statistics', async () => {
      const deps = createMockDeps();
      const exec = new ArtifactExecutor(deps);
      await exec.execute(codeArtifact({ id: 'a1' }));

      deps.codeExecutor.executeJavaScript.mockRejectedValue(new Error('fail'));
      await expect(exec.execute(codeArtifact({ id: 'a2' }))).rejects.toThrow();

      const stats = exec.getStats();
      expect(stats.totalExecutions).toBe(2);
      expect(stats.successful).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.successRate).toBe(50);
      expect(stats.isExecuting).toBe(false);
      expect(stats.languages).toContain('javascript');
      expect(stats.hasCodeExecutor).toBe(true);
      expect(stats.hasEventBus).toBe(true);
    });
  });
});
