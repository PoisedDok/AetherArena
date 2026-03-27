'use strict';

const { ArtifactTransport } = require('../../../src/infrastructure/artifacts/ArtifactTransport');

// Helper: create a mock IPC adapter
function mockIpc() {
  return { send: jest.fn() };
}

// Helper: create a valid minimal streamData payload
function validPayload(overrides = {}) {
  return {
    artifact_id: 'art-abc123',
    requestId: 'req-xyz789',
    chatId: 'chat-1',
    role: 'assistant',
    type: 'code',
    content: 'console.log("hello")',
    executionGroup: 'exec-1',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('ArtifactTransport', () => {
  let ipc;
  let transport;

  beforeEach(() => {
    ipc = mockIpc();
    transport = new ArtifactTransport({ ipc });
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    it('throws if no IPC adapter provided', () => {
      expect(() => new ArtifactTransport()).toThrow('IPC adapter required');
      expect(() => new ArtifactTransport({})).toThrow('IPC adapter required');
    });

    it('accepts IPC adapter', () => {
      const t = new ArtifactTransport({ ipc });
      expect(t.ipc).toBe(ipc);
    });

    it('defaults enableLogging to false', () => {
      expect(transport.enableLogging).toBe(false);
    });

    it('accepts enableLogging option', () => {
      const t = new ArtifactTransport({ ipc, enableLogging: true });
      expect(t.enableLogging).toBe(true);
    });
  });

  // =========================================================================
  // sendToArtifacts — contract validation
  // =========================================================================
  describe('sendToArtifacts() — validation', () => {
    it('throws for null streamData', () => {
      expect(() => transport.sendToArtifacts(null)).toThrow('CONTRACT VIOLATION: streamData must be object');
    });

    it('throws for undefined streamData', () => {
      expect(() => transport.sendToArtifacts(undefined)).toThrow('CONTRACT VIOLATION: streamData must be object');
    });

    it('throws for non-object streamData', () => {
      expect(() => transport.sendToArtifacts('string')).toThrow('CONTRACT VIOLATION: streamData must be object');
      expect(() => transport.sendToArtifacts(123)).toThrow('CONTRACT VIOLATION: streamData must be object');
    });

    it('throws for missing artifact_id', () => {
      expect(() => transport.sendToArtifacts({ requestId: 'req-1' }))
        .toThrow('artifact_id required');
    });

    it('throws for non-string artifact_id', () => {
      expect(() => transport.sendToArtifacts({ artifact_id: 123, requestId: 'req-1' }))
        .toThrow('artifact_id required');
    });

    it('throws for missing requestId', () => {
      expect(() => transport.sendToArtifacts({ artifact_id: 'art-1' }))
        .toThrow('requestId required');
    });

    it('throws for non-string requestId', () => {
      expect(() => transport.sendToArtifacts({ artifact_id: 'art-1', requestId: 123 }))
        .toThrow('requestId required');
    });
  });

  // =========================================================================
  // sendToArtifacts — IPC payload transformation
  // =========================================================================
  describe('sendToArtifacts() — payload transformation', () => {
    it('sends transformed payload via IPC', () => {
      const data = validPayload({ format: 'js', language: 'javascript' });
      transport.sendToArtifacts(data);

      expect(ipc.send).toHaveBeenCalledTimes(1);
      expect(ipc.send).toHaveBeenCalledWith('artifacts:stream', expect.objectContaining({
        artifact_id: 'art-abc123',
        request_id: 'req-xyz789',
        chat_id: 'chat-1',
        role: 'assistant',
        type: 'code',
        content: 'console.log("hello")',
        execution_group: 'exec-1',
        format: 'js',
        language: 'javascript',
      }));
    });

    it('maps camelCase to snake_case correctly', () => {
      const data = validPayload({
        messageId: 'msg-1',
        parentId: 'parent-1',
        correlationId: 'corr-1',
      });
      transport.sendToArtifacts(data);

      const payload = ipc.send.mock.calls[0][1];
      expect(payload.message_id).toBe('msg-1');
      expect(payload.parent_id).toBe('parent-1');
      expect(payload.correlation_id).toBe('corr-1');
    });

    it('defaults optional fields to null/false/empty', () => {
      transport.sendToArtifacts(validPayload());

      const payload = ipc.send.mock.calls[0][1];
      expect(payload.format).toBeNull();
      expect(payload.language).toBeNull();
      expect(payload.message_id).toBeNull();
      expect(payload.parent_id).toBeNull();
      expect(payload.correlation_id).toBeNull();
      expect(payload.start).toBe(false);
      expect(payload.end).toBe(false);
      expect(payload.metadata).toEqual({});
    });

    it('includes start and end flags when set', () => {
      transport.sendToArtifacts(validPayload({ start: true, end: true }));

      const payload = ipc.send.mock.calls[0][1];
      expect(payload.start).toBe(true);
      expect(payload.end).toBe(true);
    });

    it('includes node_id in payload when present', () => {
      transport.sendToArtifacts(validPayload({ node_id: 'node-123' }));

      const payload = ipc.send.mock.calls[0][1];
      expect(payload.node_id).toBe('node-123');
    });

    it('includes subgroup_id in payload when present', () => {
      transport.sendToArtifacts(validPayload({ subgroup_id: 'sub-456' }));

      const payload = ipc.send.mock.calls[0][1];
      expect(payload.subgroup_id).toBe('sub-456');
    });

    it('omits node_id and subgroup_id when not present', () => {
      transport.sendToArtifacts(validPayload());

      const payload = ipc.send.mock.calls[0][1];
      expect(payload).not.toHaveProperty('node_id');
      expect(payload).not.toHaveProperty('subgroup_id');
    });
  });

  // =========================================================================
  // sendToArtifacts — trail linkage warnings
  // =========================================================================
  describe('sendToArtifacts() — trail linkage', () => {
    let loggingTransport;

    beforeEach(() => {
      loggingTransport = new ArtifactTransport({ ipc, enableLogging: true });
    });

    it('warns when computer:output missing node_id (with logging)', () => {
      const spy = jest.spyOn(loggingTransport.log, 'warn');
      const data = validPayload({ role: 'computer', type: 'output' });
      loggingTransport.sendToArtifacts(data);

      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('node_id missing'),
        expect.any(Object)
      );
      spy.mockRestore();
    });

    it('warns when computer:console missing subgroup_id (with logging)', () => {
      const spy = jest.spyOn(loggingTransport.log, 'warn');
      const data = validPayload({ role: 'computer', type: 'console', node_id: 'node-1' });
      loggingTransport.sendToArtifacts(data);

      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('subgroup_id missing'),
        expect.any(Object)
      );
      spy.mockRestore();
    });

    it('does not warn for assistant:code without trail metadata', () => {
      const spy = jest.spyOn(loggingTransport.log, 'warn');
      loggingTransport.sendToArtifacts(validPayload({ role: 'assistant', type: 'code' }));
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('does not warn when logging is disabled', () => {
      const spy = jest.spyOn(transport.log, 'warn');
      transport.sendToArtifacts(validPayload({ role: 'computer', type: 'output' }));
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('still sends IPC even when trail metadata missing', () => {
      transport.sendToArtifacts(validPayload({ role: 'computer', type: 'output' }));
      expect(ipc.send).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // sendToArtifacts — diagnostic logging
  // =========================================================================
  describe('sendToArtifacts() — diagnostic logging', () => {
    it('logs transport when enableLogging is true', () => {
      const loggingTransport = new ArtifactTransport({ ipc, enableLogging: true });
      const spy = jest.spyOn(loggingTransport.log, 'debug');
      loggingTransport.sendToArtifacts(validPayload());

      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('Sent to artifacts window'),
        expect.any(Object)
      );
      spy.mockRestore();
    });

    it('does not log transport when enableLogging is false', () => {
      const spy = jest.spyOn(transport.log, 'debug');
      transport.sendToArtifacts(validPayload());
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // =========================================================================
  // getStats
  // =========================================================================
  describe('getStats()', () => {
    it('returns hasIpc true when IPC is set', () => {
      expect(transport.getStats()).toEqual({ hasIpc: true });
    });

    it('returns hasIpc false when IPC is null (only possible via direct mutation)', () => {
      transport.ipc = null;
      expect(transport.getStats()).toEqual({ hasIpc: false });
    });
  });
});
