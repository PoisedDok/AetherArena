'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
};

jest.mock('../../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: jest.fn(() => mockLogger),
}));

const { ModuleCoordinator } = require('../../../src/renderer/artifacts/services/ModuleCoordinator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockCodeViewer() {
  return { loadCode: jest.fn() };
}

function createMockOutputViewer() {
  return { loadOutput: jest.fn() };
}

function createMockFileManager() {
  return {
    addFile: jest.fn(),
    highlightArtifact: jest.fn(),
  };
}

function createAllModules() {
  return {
    codeViewer: createMockCodeViewer(),
    outputViewer: createMockOutputViewer(),
    fileManager: createMockFileManager(),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ModuleCoordinator', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // constructor
  // ═══════════════════════════════════════════════════════════════════════

  describe('constructor', () => {
    it('stores modules object', () => {
      const modules = createAllModules();
      const coord = new ModuleCoordinator(modules);
      expect(coord.modules).toBe(modules);
    });

    it('defaults to empty modules when no argument provided', () => {
      const coord = new ModuleCoordinator();
      expect(coord.modules).toEqual({});
    });

    it('accepts partial modules', () => {
      const coord = new ModuleCoordinator({ codeViewer: createMockCodeViewer() });
      expect(coord.modules.codeViewer).toBeDefined();
      expect(coord.modules.outputViewer).toBeUndefined();
      expect(coord.modules.fileManager).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // loadToViewer — routing + validation
  // ═══════════════════════════════════════════════════════════════════════

  describe('loadToViewer', () => {
    let coord;
    let modules;

    beforeEach(() => {
      modules = createAllModules();
      coord = new ModuleCoordinator(modules);
    });

    // --- input validation ---

    it('throws if artifact is null', () => {
      expect(() => coord.loadToViewer(null, { viewer: 'code' }))
        .toThrow('[ModuleCoordinator] Artifact must be an object');
    });

    it('throws if artifact is undefined', () => {
      expect(() => coord.loadToViewer(undefined, { viewer: 'code' }))
        .toThrow('[ModuleCoordinator] Artifact must be an object');
    });

    it('throws if artifact is a string', () => {
      expect(() => coord.loadToViewer('not-obj', { viewer: 'code' }))
        .toThrow('[ModuleCoordinator] Artifact must be an object');
    });

    it('throws if artifact is a number', () => {
      expect(() => coord.loadToViewer(42, { viewer: 'code' }))
        .toThrow('[ModuleCoordinator] Artifact must be an object');
    });

    it('throws if classification is null', () => {
      expect(() => coord.loadToViewer({ content: 'x' }, null))
        .toThrow('[ModuleCoordinator] Classification must be an object');
    });

    it('throws if classification is undefined', () => {
      expect(() => coord.loadToViewer({ content: 'x' }))
        .toThrow('[ModuleCoordinator] Classification must be an object');
    });

    it('throws if classification is a string', () => {
      expect(() => coord.loadToViewer({ content: 'x' }, 'code'))
        .toThrow('[ModuleCoordinator] Classification must be an object');
    });

    it('throws if classification has no viewer', () => {
      expect(() => coord.loadToViewer({ content: 'x' }, { format: 'text' }))
        .toThrow('[ModuleCoordinator] Classification must have a viewer');
    });

    it('throws if classification.viewer is empty string', () => {
      expect(() => coord.loadToViewer({ content: 'x' }, { viewer: '' }))
        .toThrow('[ModuleCoordinator] Classification must have a viewer');
    });

    // --- routing ---

    it('routes viewer=code to loadToCodeViewer', () => {
      const artifact = { content: 'fn main(){}', id: 'a1' };
      const result = coord.loadToViewer(artifact, { viewer: 'code' });
      expect(result).toBe(true);
      expect(modules.codeViewer.loadCode).toHaveBeenCalled();
    });

    it('routes viewer=Code (case-insensitive) to code viewer', () => {
      const artifact = { content: 'fn main(){}', id: 'a1' };
      coord.loadToViewer(artifact, { viewer: 'Code' });
      expect(modules.codeViewer.loadCode).toHaveBeenCalled();
    });

    it('routes viewer=files to loadToFileManager', () => {
      const artifact = { content: 'data', id: 'a1' };
      const result = coord.loadToViewer(artifact, { viewer: 'files' });
      expect(result).toBe(true);
      expect(modules.fileManager.addFile).toHaveBeenCalledWith(artifact);
    });

    it('routes viewer=FILES (case-insensitive) to file manager', () => {
      coord.loadToViewer({ content: 'data', id: 'a2' }, { viewer: 'FILES' });
      expect(modules.fileManager.addFile).toHaveBeenCalled();
    });

    it('routes viewer=output to loadToOutputViewer', () => {
      const artifact = { content: 'result', id: 'a1' };
      const result = coord.loadToViewer(artifact, { viewer: 'output' });
      expect(result).toBe(true);
      expect(modules.outputViewer.loadOutput).toHaveBeenCalled();
    });

    it('routes viewer=console to loadToOutputViewer', () => {
      coord.loadToViewer({ content: 'log', id: 'a1' }, { viewer: 'console' });
      expect(modules.outputViewer.loadOutput).toHaveBeenCalled();
    });

    it('routes unknown viewer to loadToOutputViewer (default case)', () => {
      coord.loadToViewer({ content: 'x', id: 'a1' }, { viewer: 'unknown' });
      expect(modules.outputViewer.loadOutput).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // loadToCodeViewer
  // ═══════════════════════════════════════════════════════════════════════

  describe('loadToCodeViewer', () => {
    it('returns false when codeViewer is not available', () => {
      const coord = new ModuleCoordinator({});
      const result = coord.loadToCodeViewer({ id: 'a1', content: 'x' }, {});
      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'codeViewer not available',
        expect.objectContaining({ artifactId: 'a1' })
      );
    });

    it('calls codeViewer.loadCode with correct arguments', () => {
      const cv = createMockCodeViewer();
      const coord = new ModuleCoordinator({ codeViewer: cv });
      const artifact = { content: 'console.log(1)', language: 'javascript', filename: 'test.js', id: 'a1' };
      const classification = { format: 'python', filename: 'alt.py' };

      const result = coord.loadToCodeViewer(artifact, classification);

      expect(result).toBe(true);
      expect(cv.loadCode).toHaveBeenCalledWith('console.log(1)', 'javascript', 'test.js', 'a1');
    });

    it('falls back to artifact.format for language', () => {
      const cv = createMockCodeViewer();
      const coord = new ModuleCoordinator({ codeViewer: cv });
      const artifact = { content: 'x', format: 'python', id: 'a1' };

      coord.loadToCodeViewer(artifact, {});

      expect(cv.loadCode).toHaveBeenCalledWith('x', 'python', 'untitled', 'a1');
    });

    it('falls back to classification.format for language', () => {
      const cv = createMockCodeViewer();
      const coord = new ModuleCoordinator({ codeViewer: cv });
      const artifact = { content: 'x', id: 'a1' };

      coord.loadToCodeViewer(artifact, { format: 'rust' });

      expect(cv.loadCode).toHaveBeenCalledWith('x', 'rust', 'untitled', 'a1');
    });

    it('falls back to text for language when nothing is provided', () => {
      const cv = createMockCodeViewer();
      const coord = new ModuleCoordinator({ codeViewer: cv });
      const artifact = { content: 'x', id: 'a1' };

      coord.loadToCodeViewer(artifact, {});

      expect(cv.loadCode).toHaveBeenCalledWith('x', 'text', 'untitled', 'a1');
    });

    it('falls back to classification.filename for filename', () => {
      const cv = createMockCodeViewer();
      const coord = new ModuleCoordinator({ codeViewer: cv });
      const artifact = { content: 'x', id: 'a1' };

      coord.loadToCodeViewer(artifact, { filename: 'from-class.js' });

      expect(cv.loadCode).toHaveBeenCalledWith('x', 'text', 'from-class.js', 'a1');
    });

    it('uses artifact.artifactId when artifact.id is not present', () => {
      const cv = createMockCodeViewer();
      const coord = new ModuleCoordinator({ codeViewer: cv });
      const artifact = { content: 'x', artifactId: 'fallback-id' };

      coord.loadToCodeViewer(artifact, {});

      expect(cv.loadCode).toHaveBeenCalledWith('x', 'text', 'untitled', 'fallback-id');
    });

    it('logs info with artifact details', () => {
      const cv = createMockCodeViewer();
      const coord = new ModuleCoordinator({ codeViewer: cv });
      coord.loadToCodeViewer({ content: 'abc', id: 'a1', language: 'go' }, { filename: 'main.go' });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Loading to codeViewer',
        expect.objectContaining({
          artifactId: 'a1',
          language: 'go',
          filename: 'main.go',
          contentLength: 3,
        })
      );
    });

    it('handles undefined content length gracefully', () => {
      const cv = createMockCodeViewer();
      const coord = new ModuleCoordinator({ codeViewer: cv });
      coord.loadToCodeViewer({ id: 'a1' }, {});

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Loading to codeViewer',
        expect.objectContaining({ contentLength: undefined })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // loadToOutputViewer
  // ═══════════════════════════════════════════════════════════════════════

  describe('loadToOutputViewer', () => {
    it('returns false when outputViewer is not available', () => {
      const coord = new ModuleCoordinator({});
      const result = coord.loadToOutputViewer({ id: 'a1', content: 'x' }, {});
      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'outputViewer not available (CRITICAL)',
        expect.objectContaining({ artifactId: 'a1' })
      );
    });

    it('calls outputViewer.loadOutput with correct arguments', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });
      const artifact = { content: 'result', id: 'a1' };

      const result = coord.loadToOutputViewer(artifact, { format: 'json' });

      expect(result).toBe(true);
      expect(ov.loadOutput).toHaveBeenCalledWith('result', 'json', 'a1');
    });

    it('prefers classification.content over artifact.content', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });
      const artifact = { content: 'original', id: 'a1' };

      coord.loadToOutputViewer(artifact, { content: 'override', format: 'text' });

      expect(ov.loadOutput).toHaveBeenCalledWith('override', 'text', 'a1');
    });

    it('uses artifact.content when classification.content is undefined', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });
      const artifact = { content: 'from-artifact', id: 'a1' };

      coord.loadToOutputViewer(artifact, {});

      expect(ov.loadOutput).toHaveBeenCalledWith('from-artifact', 'text', 'a1');
    });

    it('falls back to artifact.format', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });
      const artifact = { content: 'x', id: 'a1', format: 'markdown' };

      coord.loadToOutputViewer(artifact, {});

      expect(ov.loadOutput).toHaveBeenCalledWith('x', 'markdown', 'a1');
    });

    it('falls back to text when no format provided', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      coord.loadToOutputViewer({ content: 'x', id: 'a1' }, {});

      expect(ov.loadOutput).toHaveBeenCalledWith('x', 'text', 'a1');
    });

    it('uses artifact.artifactId when artifact.id is missing', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      coord.loadToOutputViewer({ content: 'x', artifactId: 'aid-1' }, {});

      expect(ov.loadOutput).toHaveBeenCalledWith('x', 'text', 'aid-1');
    });

    // --- HTML auto-detection ---

    it('auto-detects HTML when format is text and content starts with HTML tag', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      coord.loadToOutputViewer(
        { content: '<div>hello</div>', id: 'a1' },
        { format: 'text' }
      );

      expect(ov.loadOutput).toHaveBeenCalledWith('<div>hello</div>', 'html', 'a1');
    });

    it('auto-detects HTML for DOCTYPE', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      coord.loadToOutputViewer(
        { content: '<!DOCTYPE html><html></html>', id: 'a1' },
        { format: 'text' }
      );

      expect(ov.loadOutput).toHaveBeenCalledWith(
        '<!DOCTYPE html><html></html>', 'html', 'a1'
      );
    });

    it('auto-detects HTML for <html> tag', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      coord.loadToOutputViewer(
        { content: '<html><body>content</body></html>', id: 'a1' },
        { format: 'text' }
      );

      expect(ov.loadOutput).toHaveBeenCalledWith(
        '<html><body>content</body></html>', 'html', 'a1'
      );
    });

    it('auto-detects HTML for <p> tag', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      coord.loadToOutputViewer(
        { content: '<p>paragraph</p>', id: 'a1' },
        { format: 'text' }
      );

      expect(ov.loadOutput).toHaveBeenCalledWith('<p>paragraph</p>', 'html', 'a1');
    });

    it('auto-detects HTML for <table> tag', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      coord.loadToOutputViewer(
        { content: '<table><tr><td>cell</td></tr></table>', id: 'a1' },
        { format: 'text' }
      );

      expect(ov.loadOutput).toHaveBeenCalledWith(
        '<table><tr><td>cell</td></tr></table>', 'html', 'a1'
      );
    });

    it('does NOT auto-detect HTML for non-HTML tags', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      coord.loadToOutputViewer(
        { content: '<custom>tag</custom>', id: 'a1' },
        { format: 'text' }
      );

      expect(ov.loadOutput).toHaveBeenCalledWith('<custom>tag</custom>', 'text', 'a1');
    });

    it('does NOT auto-detect HTML when format is not text', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      coord.loadToOutputViewer(
        { content: '<div>hello</div>', id: 'a1' },
        { format: 'json' }
      );

      expect(ov.loadOutput).toHaveBeenCalledWith('<div>hello</div>', 'json', 'a1');
    });

    it('does NOT auto-detect HTML for empty trimmed content', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      coord.loadToOutputViewer(
        { content: '   ', id: 'a1' },
        { format: 'text' }
      );

      expect(ov.loadOutput).toHaveBeenCalledWith('   ', 'text', 'a1');
    });

    it('does NOT auto-detect HTML for non-string content', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });
      const objContent = { html: '<div>test</div>' };

      coord.loadToOutputViewer(
        { content: objContent, id: 'a1' },
        { format: 'text' }
      );

      expect(ov.loadOutput).toHaveBeenCalledWith(objContent, 'text', 'a1');
    });

    it('does NOT auto-detect HTML when content does not start with <', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      coord.loadToOutputViewer(
        { content: 'Hello <div>world</div>', id: 'a1' },
        { format: 'text' }
      );

      expect(ov.loadOutput).toHaveBeenCalledWith('Hello <div>world</div>', 'text', 'a1');
    });

    it('does NOT auto-detect HTML when no closing tag', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      // Starts with < but no </ and doesn't end with >
      coord.loadToOutputViewer(
        { content: '<broken tag incomplete', id: 'a1' },
        { format: 'text' }
      );

      expect(ov.loadOutput).toHaveBeenCalledWith('<broken tag incomplete', 'text', 'a1');
    });

    it('logs info when auto-detecting HTML', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      coord.loadToOutputViewer(
        { content: '<div>test</div>', id: 'a1' },
        { format: 'text' }
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Auto-detected HTML content, overriding format',
        expect.objectContaining({
          artifactId: 'a1',
          originalFormat: 'text',
          newFormat: 'html',
        })
      );
    });

    it('auto-detects HTML when format comes from artifact.format=text', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      coord.loadToOutputViewer(
        { content: '<div>hello</div>', id: 'a1', format: 'text' },
        {} // no classification.format -> falls to artifact.format in originalFormat log
      );

      expect(ov.loadOutput).toHaveBeenCalledWith('<div>hello</div>', 'html', 'a1');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Auto-detected HTML content, overriding format',
        expect.objectContaining({ originalFormat: 'text' })
      );
    });

    it('auto-detects HTML with originalFormat fallback to text when no format anywhere', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      // Both classification.format and artifact.format are undefined -> format = 'text' -> triggers auto-detect
      // originalFormat = undefined || undefined || 'text' -> 'text'
      coord.loadToOutputViewer(
        { content: '<div>hello</div>', id: 'a1' },
        {}
      );

      expect(ov.loadOutput).toHaveBeenCalledWith('<div>hello</div>', 'html', 'a1');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Auto-detected HTML content, overriding format',
        expect.objectContaining({ originalFormat: 'text' })
      );
    });

    it('logs loading info', () => {
      const ov = createMockOutputViewer();
      const coord = new ModuleCoordinator({ outputViewer: ov });

      coord.loadToOutputViewer(
        { content: 'data', id: 'a1', role: 'tool', type: 'output' },
        { format: 'text' }
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Loading to outputViewer',
        expect.objectContaining({
          artifactId: 'a1',
          format: 'text',
          contentLength: 4,
          role: 'tool',
          type: 'output',
        })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // loadToFileManager
  // ═══════════════════════════════════════════════════════════════════════

  describe('loadToFileManager', () => {
    it('returns false when fileManager is not available', () => {
      const coord = new ModuleCoordinator({});
      const result = coord.loadToFileManager({ id: 'a1' }, {});
      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'fileManager not available or addFile method missing',
        expect.objectContaining({ artifactId: 'a1' })
      );
    });

    it('returns false when fileManager exists but has no addFile method', () => {
      const coord = new ModuleCoordinator({ fileManager: {} });
      const result = coord.loadToFileManager({ id: 'a2' }, {});
      expect(result).toBe(false);
    });

    it('returns false when fileManager.addFile is not a function', () => {
      const coord = new ModuleCoordinator({ fileManager: { addFile: 'not-fn' } });
      const result = coord.loadToFileManager({ id: 'a3' }, {});
      expect(result).toBe(false);
    });

    it('calls fileManager.addFile with artifact', () => {
      const fm = createMockFileManager();
      const coord = new ModuleCoordinator({ fileManager: fm });
      const artifact = { id: 'a1', content: 'file content', filename: 'data.csv' };

      const result = coord.loadToFileManager(artifact, {});

      expect(result).toBe(true);
      expect(fm.addFile).toHaveBeenCalledWith(artifact);
    });

    it('logs info on successful load', () => {
      const fm = createMockFileManager();
      const coord = new ModuleCoordinator({ fileManager: fm });

      coord.loadToFileManager({ id: 'a1' }, {});

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Adding to fileManager',
        expect.objectContaining({ artifactId: 'a1' })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // highlightArtifact
  // ═══════════════════════════════════════════════════════════════════════

  describe('highlightArtifact', () => {
    it('returns false when fileManager is not available', () => {
      const coord = new ModuleCoordinator({});
      expect(coord.highlightArtifact('a1')).toBe(false);
    });

    it('returns false when fileManager has no highlightArtifact method', () => {
      const coord = new ModuleCoordinator({ fileManager: { addFile: jest.fn() } });
      expect(coord.highlightArtifact('a1')).toBe(false);
    });

    it('returns false when highlightArtifact is not a function', () => {
      const coord = new ModuleCoordinator({ fileManager: { highlightArtifact: 'not-fn' } });
      expect(coord.highlightArtifact('a1')).toBe(false);
    });

    it('calls fileManager.highlightArtifact and returns true', () => {
      const fm = createMockFileManager();
      const coord = new ModuleCoordinator({ fileManager: fm });

      const result = coord.highlightArtifact('a1');

      expect(result).toBe(true);
      expect(fm.highlightArtifact).toHaveBeenCalledWith('a1');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // isViewerAvailable
  // ═══════════════════════════════════════════════════════════════════════

  describe('isViewerAvailable', () => {
    it('returns true for code when codeViewer exists', () => {
      const coord = new ModuleCoordinator({ codeViewer: createMockCodeViewer() });
      expect(coord.isViewerAvailable('code')).toBe(true);
    });

    it('returns false for code when codeViewer is absent', () => {
      const coord = new ModuleCoordinator({});
      expect(coord.isViewerAvailable('code')).toBe(false);
    });

    it('returns true for output when outputViewer exists', () => {
      const coord = new ModuleCoordinator({ outputViewer: createMockOutputViewer() });
      expect(coord.isViewerAvailable('output')).toBe(true);
    });

    it('returns false for output when outputViewer is absent', () => {
      const coord = new ModuleCoordinator({});
      expect(coord.isViewerAvailable('output')).toBe(false);
    });

    it('returns true for console (alias for output)', () => {
      const coord = new ModuleCoordinator({ outputViewer: createMockOutputViewer() });
      expect(coord.isViewerAvailable('console')).toBe(true);
    });

    it('returns true for files when fileManager exists', () => {
      const coord = new ModuleCoordinator({ fileManager: createMockFileManager() });
      expect(coord.isViewerAvailable('files')).toBe(true);
    });

    it('returns false for files when fileManager is absent', () => {
      const coord = new ModuleCoordinator({});
      expect(coord.isViewerAvailable('files')).toBe(false);
    });

    it('returns false for unknown viewer name', () => {
      const coord = new ModuleCoordinator(createAllModules());
      expect(coord.isViewerAvailable('unknown')).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // getAvailableViewers
  // ═══════════════════════════════════════════════════════════════════════

  describe('getAvailableViewers', () => {
    it('returns all viewers when all modules present', () => {
      const coord = new ModuleCoordinator(createAllModules());
      expect(coord.getAvailableViewers()).toEqual(['code', 'output', 'files']);
    });

    it('returns empty when no modules', () => {
      const coord = new ModuleCoordinator({});
      expect(coord.getAvailableViewers()).toEqual([]);
    });

    it('returns only code when only codeViewer present', () => {
      const coord = new ModuleCoordinator({ codeViewer: createMockCodeViewer() });
      expect(coord.getAvailableViewers()).toEqual(['code']);
    });

    it('returns only output when only outputViewer present', () => {
      const coord = new ModuleCoordinator({ outputViewer: createMockOutputViewer() });
      expect(coord.getAvailableViewers()).toEqual(['output']);
    });

    it('returns only files when only fileManager present', () => {
      const coord = new ModuleCoordinator({ fileManager: createMockFileManager() });
      expect(coord.getAvailableViewers()).toEqual(['files']);
    });

    it('returns code and output without files', () => {
      const coord = new ModuleCoordinator({
        codeViewer: createMockCodeViewer(),
        outputViewer: createMockOutputViewer(),
      });
      expect(coord.getAvailableViewers()).toEqual(['code', 'output']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // updateModules
  // ═══════════════════════════════════════════════════════════════════════

  describe('updateModules', () => {
    it('merges new modules into existing', () => {
      const cv = createMockCodeViewer();
      const coord = new ModuleCoordinator({ codeViewer: cv });
      const ov = createMockOutputViewer();

      coord.updateModules({ outputViewer: ov });

      expect(coord.modules.codeViewer).toBe(cv);
      expect(coord.modules.outputViewer).toBe(ov);
    });

    it('replaces existing module', () => {
      const cv1 = createMockCodeViewer();
      const cv2 = createMockCodeViewer();
      const coord = new ModuleCoordinator({ codeViewer: cv1 });

      coord.updateModules({ codeViewer: cv2 });

      expect(coord.modules.codeViewer).toBe(cv2);
      expect(coord.modules.codeViewer).not.toBe(cv1);
    });

    it('does not remove modules not in update', () => {
      const modules = createAllModules();
      const coord = new ModuleCoordinator(modules);

      coord.updateModules({ codeViewer: createMockCodeViewer() });

      expect(coord.modules.outputViewer).toBe(modules.outputViewer);
      expect(coord.modules.fileManager).toBe(modules.fileManager);
    });
  });
});
