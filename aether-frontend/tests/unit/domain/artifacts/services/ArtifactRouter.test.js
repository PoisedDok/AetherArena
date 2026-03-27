'use strict';

jest.mock('../../../../../src/core/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()
  })
}));

const { ArtifactRouter, VIEWERS, ROUTING_RULES } = require('../../../../../src/domain/artifacts/services/ArtifactRouter');

// --- Helpers ---
// Minimal valid artifact for ArtifactRouter
// Router validates: id|artifactId exists, content or type exists
// Then delegates to resolveArtifactPresentation which calls normalizeArtifactPayload
function artifact(overrides = {}) {
  return {
    id: 'art-001',
    artifact_id: 'art-001',
    artifactId: 'art-001',
    request_id: 'req-001',
    role: 'assistant',
    type: 'code',
    chat_id: 'chat-001',
    chatId: 'chat-001',
    format: 'javascript',
    execution_group: 'eg-001',
    timestamp: Date.now(),
    content: 'x',
    ...overrides
  };
}

describe('ArtifactRouter', () => {
  describe('VIEWERS constant', () => {
    it('contains expected viewer types', () => {
      expect(VIEWERS.CODE).toBe('code');
      expect(VIEWERS.OUTPUT).toBe('output');
      expect(VIEWERS.FILES).toBe('files');
    });
  });

  describe('ROUTING_RULES constant', () => {
    it('has force output origins', () => {
      expect(ROUTING_RULES.FORCE_OUTPUT_ORIGINS).toContain('execution');
      expect(ROUTING_RULES.FORCE_OUTPUT_ORIGINS).toContain('load-output');
    });

    it('has no auto-switch origins', () => {
      expect(ROUTING_RULES.NO_AUTO_SWITCH_ORIGINS).toContain('stream-chunk');
      expect(ROUTING_RULES.NO_AUTO_SWITCH_ORIGINS).toContain('background');
    });
  });

  describe('route()', () => {
    it('routes assistant:code to code viewer', () => {
      const result = ArtifactRouter.route(artifact());
      expect(result.viewer).toBe('code');
      expect(result.role).toBe('assistant');
      expect(result.type).toBe('code');
      expect(result.routingReason).toBeTruthy();
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('routes computer:output to output viewer', () => {
      const result = ArtifactRouter.route(artifact({ role: 'computer', type: 'output', format: 'text' }));
      expect(result.viewer).toBe('output');
    });

    it('routes file type to files viewer', () => {
      const result = ArtifactRouter.route(artifact({ type: 'file', filename: 'data.csv' }));
      expect(result.viewer).toBe('files');
    });

    it('returns frozen object', () => {
      const result = ArtifactRouter.route(artifact());
      expect(() => { result.extra = 'x'; }).toThrow();
    });

    it('includes origin and isFinal metadata', () => {
      const result = ArtifactRouter.route(artifact(), { origin: 'execution', isFinal: true });
      expect(result.origin).toBe('execution');
      expect(result.isFinal).toBe(true);
    });

    // Routing reason branches
    it('routing reason: forceAutoSwitch', () => {
      const result = ArtifactRouter.route(artifact(), { forceAutoSwitch: true });
      expect(result.routingReason).toBe('Forced auto-switch (forceAutoSwitch=true)');
    });

    it('routing reason: forceOutput', () => {
      const result = ArtifactRouter.route(artifact(), { forceOutput: true });
      expect(result.routingReason).toBe('Forced output viewer (forceOutput=true)');
      expect(result.viewer).toBe('output');
    });

    it('routing reason: execution origin (non-computer)', () => {
      // assistant:output routes to output viewer without being computer role
      const result = ArtifactRouter.route(
        artifact({ role: 'assistant', type: 'output', format: 'text' }),
        { origin: 'execution' }
      );
      expect(result.viewer).toBe('output');
      expect(result.routingReason).toBe('Execution result');
    });

    it('routing reason: load-output origin (non-computer)', () => {
      const result = ArtifactRouter.route(
        artifact({ role: 'assistant', type: 'output', format: 'text' }),
        { origin: 'load-output' }
      );
      expect(result.viewer).toBe('output');
      expect(result.routingReason).toBe('Output loading requested');
    });

    it('routing reason: isFinal (non-computer, non-execution)', () => {
      const result = ArtifactRouter.route(
        artifact({ role: 'assistant', type: 'output', format: 'text' }),
        { isFinal: true }
      );
      expect(result.viewer).toBe('output');
      expect(result.routingReason).toBe('Final artifact in stream');
    });

    it('routing reason: default output (no special flags)', () => {
      const result = ArtifactRouter.route(
        artifact({ role: 'assistant', type: 'output', format: 'text' })
      );
      expect(result.viewer).toBe('output');
      expect(result.routingReason).toContain('Output artifact');
      expect(result.routingReason).toContain('type=output');
    });

    // Validation
    it('throws on null artifact', () => {
      expect(() => ArtifactRouter.route(null)).toThrow('Artifact must be an object');
    });

    it('throws on artifact without id', () => {
      expect(() => ArtifactRouter.route({ content: 'x', type: 'code' })).toThrow('id or artifactId');
    });

    it('throws on artifact without content or type', () => {
      expect(() => ArtifactRouter.route({ id: 'a1' })).toThrow('content or type');
    });
  });

  describe('shouldAutoSwitch()', () => {
    it('returns true when forceAutoSwitch=true', () => {
      expect(ArtifactRouter.shouldAutoSwitch(artifact(), { forceAutoSwitch: true })).toBe(true);
    });

    it('returns false when autoSwitch=false', () => {
      expect(ArtifactRouter.shouldAutoSwitch(artifact({ role: 'computer' }), { autoSwitch: false })).toBe(false);
    });

    it('returns false for NO_AUTO_SWITCH_ORIGINS', () => {
      expect(ArtifactRouter.shouldAutoSwitch(artifact(), { origin: 'stream-chunk' })).toBe(false);
      expect(ArtifactRouter.shouldAutoSwitch(artifact(), { origin: 'background' })).toBe(false);
    });

    it('returns true for AUTO_SWITCH_ORIGINS', () => {
      expect(ArtifactRouter.shouldAutoSwitch(artifact(), { origin: 'execution' })).toBe(true);
      expect(ArtifactRouter.shouldAutoSwitch(artifact(), { origin: 'file' })).toBe(true);
    });

    it('returns true for isFinal=true', () => {
      expect(ArtifactRouter.shouldAutoSwitch(artifact(), { isFinal: true })).toBe(true);
    });

    it('returns true for computer role', () => {
      expect(ArtifactRouter.shouldAutoSwitch(artifact({ role: 'computer' }))).toBe(true);
    });

    it('returns false for invalid artifact', () => {
      expect(ArtifactRouter.shouldAutoSwitch(null)).toBe(false);
    });

    it('defaults to false for assistant with no special flags', () => {
      expect(ArtifactRouter.shouldAutoSwitch(artifact())).toBe(false);
    });
  });

  describe('getViewer()', () => {
    it('returns viewer string for valid artifact', () => {
      expect(ArtifactRouter.getViewer(artifact())).toBe('code');
      expect(ArtifactRouter.getViewer(artifact({ role: 'computer', type: 'output', format: 'text' }))).toBe('output');
    });
  });

  describe('isCodeArtifact()', () => {
    it('returns true for code artifacts', () => {
      expect(ArtifactRouter.isCodeArtifact(artifact())).toBe(true);
    });

    it('returns false for non-code artifacts', () => {
      expect(ArtifactRouter.isCodeArtifact(artifact({ role: 'computer', type: 'output', format: 'text' }))).toBe(false);
    });
  });

  describe('isOutputArtifact()', () => {
    it('returns true for output artifacts', () => {
      expect(ArtifactRouter.isOutputArtifact(artifact({ role: 'computer', type: 'output', format: 'text' }))).toBe(true);
    });
  });

  describe('isFileArtifact()', () => {
    it('returns true for file artifacts', () => {
      expect(ArtifactRouter.isFileArtifact(artifact({ type: 'file', filename: 'x.csv' }))).toBe(true);
    });
  });

  describe('getViewers()', () => {
    it('returns copy of VIEWERS', () => {
      const v = ArtifactRouter.getViewers();
      expect(v.CODE).toBe('code');
      v.CODE = 'changed';
      expect(VIEWERS.CODE).toBe('code'); // original unchanged
    });
  });

  describe('getRoutingRules()', () => {
    it('returns copy of ROUTING_RULES', () => {
      const r = ArtifactRouter.getRoutingRules();
      expect(r.FORCE_OUTPUT_ORIGINS).toBeTruthy();
    });
  });
});
