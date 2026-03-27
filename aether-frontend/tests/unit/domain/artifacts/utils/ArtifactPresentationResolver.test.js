'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

const {
  resolveArtifactPresentation,
  sanitizeFormat,
  CODE_TYPES,
  OUTPUT_TYPES,
  FILE_TYPES
} = require('../../../../../src/domain/artifacts/utils/ArtifactPresentationResolver');

// --- Helpers ---
// Minimal streaming artifact that passes ArtifactNormalizer
function artifact(overrides = {}) {
  return {
    artifact_id: 'art-001',
    request_id: 'req-001',
    role: 'assistant',
    type: 'code',
    chat_id: 'chat-001',
    format: 'javascript',
    execution_group: 'eg-001',
    timestamp: Date.now(),
    content: 'x',
    ...overrides
  };
}

// --- Exported Sets ---

describe('Exported constants', () => {
  it('CODE_TYPES contains expected types', () => {
    expect(CODE_TYPES.has('code')).toBe(true);
    expect(CODE_TYPES.has('notebook')).toBe(true);
    expect(CODE_TYPES.has('script')).toBe(true);
    expect(CODE_TYPES.has('source')).toBe(true);
  });

  it('OUTPUT_TYPES contains expected types', () => {
    expect(OUTPUT_TYPES.has('output')).toBe(true);
    expect(OUTPUT_TYPES.has('html')).toBe(true);
    expect(OUTPUT_TYPES.has('json')).toBe(true);
    expect(OUTPUT_TYPES.has('image')).toBe(true);
  });

  it('FILE_TYPES contains expected types', () => {
    expect(FILE_TYPES.has('file')).toBe(true);
    expect(FILE_TYPES.has('archive')).toBe(true);
    expect(FILE_TYPES.has('dataset')).toBe(true);
  });
});

// --- resolveArtifactPresentation ---

describe('resolveArtifactPresentation', () => {
  describe('viewer routing', () => {
    it('routes assistant:code to "code" viewer', () => {
      const result = resolveArtifactPresentation(artifact({ role: 'assistant', type: 'code' }));
      expect(result.viewer).toBe('code');
      expect(result.role).toBe('assistant');
      expect(result.type).toBe('code');
    });

    it('routes computer:output to "output" viewer', () => {
      const result = resolveArtifactPresentation(
        artifact({ role: 'computer', type: 'output', format: 'text' })
      );
      expect(result.viewer).toBe('output');
    });

    it('routes file type to "files" viewer', () => {
      const result = resolveArtifactPresentation(
        artifact({ type: 'file', filename: 'data.csv' })
      );
      expect(result.viewer).toBe('files');
    });

    it('routes computer role to "output" viewer', () => {
      const result = resolveArtifactPresentation(
        artifact({ role: 'computer', type: 'code', format: 'python' })
      );
      expect(result.viewer).toBe('output');
    });

    it('forces output viewer with forceOutput context', () => {
      const result = resolveArtifactPresentation(
        artifact({ role: 'assistant', type: 'code' }),
        { forceOutput: true }
      );
      expect(result.viewer).toBe('output');
    });

    it('routes media formats to "output" viewer', () => {
      for (const format of ['image', 'video', 'audio', 'media']) {
        const result = resolveArtifactPresentation(
          artifact({ role: 'assistant', type: 'output', format })
        );
        expect(result.viewer).toBe('output');
      }
    });
  });

  describe('auto-switch behavior', () => {
    it('auto-switches for computer role', () => {
      const result = resolveArtifactPresentation(
        artifact({ role: 'computer', type: 'output', format: 'text' })
      );
      expect(result.shouldAutoSwitch).toBe(true);
    });

    it('auto-switches for execution origin', () => {
      const result = resolveArtifactPresentation(
        artifact({ role: 'assistant', type: 'output', format: 'text' }),
        { origin: 'execution' }
      );
      expect(result.shouldAutoSwitch).toBe(true);
    });

    it('auto-switches for stream final', () => {
      const result = resolveArtifactPresentation(
        artifact({ role: 'assistant', type: 'output', format: 'text' }),
        { origin: 'stream', isFinal: true }
      );
      expect(result.shouldAutoSwitch).toBe(true);
    });

    it('respects forceAutoSwitch=true', () => {
      const result = resolveArtifactPresentation(
        artifact({ role: 'assistant', type: 'code' }),
        { forceAutoSwitch: true, currentTab: 'output' }
      );
      expect(result.shouldAutoSwitch).toBe(true);
    });

    it('respects forceAutoSwitch=false', () => {
      const result = resolveArtifactPresentation(
        artifact({ role: 'computer', type: 'output', format: 'text' }),
        { forceAutoSwitch: false }
      );
      expect(result.shouldAutoSwitch).toBe(false);
    });

    it('does not auto-switch when currentTab matches', () => {
      const result = resolveArtifactPresentation(
        artifact({ role: 'assistant', type: 'code' }),
        { origin: 'manual', currentTab: 'code' }
      );
      expect(result.shouldAutoSwitch).toBe(false);
    });
  });

  describe('return structure', () => {
    it('includes all expected fields', () => {
      const result = resolveArtifactPresentation(artifact());
      expect(result).toHaveProperty('role');
      expect(result).toHaveProperty('type');
      expect(result).toHaveProperty('format');
      expect(result).toHaveProperty('viewer');
      expect(result).toHaveProperty('tab');
      expect(result).toHaveProperty('shouldAutoSwitch');
      expect(result).toHaveProperty('normalized');
      expect(result).toHaveProperty('content');
    });

    it('tab equals viewer', () => {
      const result = resolveArtifactPresentation(artifact());
      expect(result.tab).toBe(result.viewer);
    });
  });

  describe('error handling', () => {
    it('throws on invalid artifact (propagates normalizer error)', () => {
      expect(() => resolveArtifactPresentation(null)).toThrow();
    });
  });
});

// --- sanitizeFormat ---

describe('sanitizeFormat', () => {
  it('passes through supported formats', () => {
    expect(sanitizeFormat('text', 'code')).toBe('text');
    expect(sanitizeFormat('markdown', 'code')).toBe('markdown');
    expect(sanitizeFormat('html', 'code')).toBe('html');
    expect(sanitizeFormat('json', 'code')).toBe('json');
    expect(sanitizeFormat('image', 'code')).toBe('image');
  });

  it('resolves format aliases', () => {
    expect(sanitizeFormat('plain', 'code')).toBe('text');
    expect(sanitizeFormat('plaintext', 'code')).toBe('text');
    expect(sanitizeFormat('txt', 'code')).toBe('text');
    expect(sanitizeFormat('md', 'code')).toBe('markdown');
    expect(sanitizeFormat('htm', 'code')).toBe('html');
    expect(sanitizeFormat('svg', 'code')).toBe('image');
    expect(sanitizeFormat('png', 'code')).toBe('image');
    expect(sanitizeFormat('jpg', 'code')).toBe('image');
    expect(sanitizeFormat('csv', 'code')).toBe('text');
  });

  it('resolves MIME type aliases', () => {
    expect(sanitizeFormat('audio/mpeg', 'code')).toBe('audio');
    expect(sanitizeFormat('video/mp4', 'code')).toBe('video');
    expect(sanitizeFormat('application/json', 'code')).toBe('json');
  });

  it('uses substring matching for unrecognized formats', () => {
    expect(sanitizeFormat('x-markdown', 'code')).toBe('markdown');
    expect(sanitizeFormat('text/html', 'code')).toBe('html');
    expect(sanitizeFormat('data-json', 'code')).toBe('json');
    expect(sanitizeFormat('image/tiff', 'code')).toBe('image');
    expect(sanitizeFormat('video/avi', 'code')).toBe('video');
    expect(sanitizeFormat('audio/flac', 'code')).toBe('audio');
    expect(sanitizeFormat('plain-text', 'code')).toBe('text');
  });

  it('falls back to type-based format for OUTPUT_TYPES', () => {
    expect(sanitizeFormat(null, 'html')).toBe('html');
    expect(sanitizeFormat(null, 'markdown')).toBe('markdown');
    expect(sanitizeFormat(null, 'json')).toBe('json');
    expect(sanitizeFormat(null, 'image')).toBe('image');
    expect(sanitizeFormat(null, 'output')).toBe('text');
  });

  it('falls back to "text" for CODE_TYPES', () => {
    expect(sanitizeFormat(null, 'code')).toBe('text');
    expect(sanitizeFormat(null, 'script')).toBe('text');
  });

  it('defaults to "text" when everything fails', () => {
    expect(sanitizeFormat(null, null)).toBe('text');
    expect(sanitizeFormat(undefined, undefined)).toBe('text');
    expect(sanitizeFormat('', '')).toBe('text');
  });
});
