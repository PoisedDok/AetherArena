'use strict';

// ---------------------------------------------------------------------------
// MessageParser.js — Comprehensive unit tests
// ---------------------------------------------------------------------------
// Source: src/renderer/chat/modules/messaging/utils/MessageParser.js (215 lines)
// Pure static utility. Zero dependencies. No DOM, no timers.
// Tests focus on deep assertions, boundary values, and contract enforcement.
// ---------------------------------------------------------------------------

const MessageParser = require('../../../../src/renderer/chat/modules/messaging/utils/MessageParser');

describe('MessageParser', () => {

  // =========================================================================
  // parse() — Field normalization
  // =========================================================================

  describe('parse() — field normalization', () => {
    it('returns normalized object with camelCase fields', () => {
      const payload = {
        role: 'assistant',
        type: 'message',
        content: 'Hello',
        start: true,
        end: false,
        format: 'text',
        request_id: 'req-123',
        artifact_id: 'art-456',
        node_id: 'node-789',
        subgroup_id: 'sg-001',
        sequence_in_chat: 5,
        message_id: 'msg-abc',
      };

      const result = MessageParser.parse(payload);

      expect(result).toEqual({
        role: 'assistant',
        type: 'message',
        content: 'Hello',
        start: true,
        end: false,
        format: 'text',
        requestId: 'req-123',
        artifactId: 'art-456',
        nodeId: 'node-789',
        subgroupId: 'sg-001',
        sequenceInChat: 5,
        messageId: 'msg-abc',
        raw: payload,
      });
    });

    it('converts start and end to booleans', () => {
      const result = MessageParser.parse({
        role: 'server',
        type: 'info',
        start: 1,
        end: 0,
      });

      expect(result.start).toBe(true);
      expect(result.end).toBe(false);
    });

    it('defaults optional fields to null when missing', () => {
      const result = MessageParser.parse({
        role: 'server',
        type: 'completion',
      });

      expect(result.requestId).toBeNull();
      expect(result.artifactId).toBeNull();
      expect(result.nodeId).toBeNull();
      expect(result.subgroupId).toBeNull();
      expect(result.sequenceInChat).toBeNull();
      expect(result.messageId).toBeNull();
      expect(result.content).toBeUndefined();
      expect(result.format).toBeUndefined();
    });

    it('preserves raw payload reference', () => {
      const payload = { role: 'server', type: 'info', extra: 'data' };
      const result = MessageParser.parse(payload);

      expect(result.raw).toBe(payload);
      expect(result.raw.extra).toBe('data');
    });

    it('handles start/end as falsy values correctly', () => {
      const result = MessageParser.parse({
        role: 'server',
        type: 'info',
        start: null,
        end: undefined,
      });

      expect(result.start).toBe(false);
      expect(result.end).toBe(false);
    });

    it('handles start/end as truthy non-boolean values', () => {
      const result = MessageParser.parse({
        role: 'server',
        type: 'info',
        start: 'yes',
        end: 1,
      });

      expect(result.start).toBe(true);
      expect(result.end).toBe(true);
    });
  });

  // =========================================================================
  // parse() — Contract violations
  // =========================================================================

  describe('parse() — contract violations', () => {
    it('throws on null payload', () => {
      expect(() => MessageParser.parse(null))
        .toThrow('[MessageParser] CONTRACT VIOLATION: Payload must be a non-null object');
    });

    it('throws on undefined payload', () => {
      expect(() => MessageParser.parse(undefined))
        .toThrow('[MessageParser] CONTRACT VIOLATION: Payload must be a non-null object');
    });

    it('throws on string payload', () => {
      expect(() => MessageParser.parse('hello'))
        .toThrow('[MessageParser] CONTRACT VIOLATION: Payload must be a non-null object');
    });

    it('throws on number payload', () => {
      expect(() => MessageParser.parse(42))
        .toThrow('[MessageParser] CONTRACT VIOLATION: Payload must be a non-null object');
    });

    it('throws on boolean payload', () => {
      expect(() => MessageParser.parse(true))
        .toThrow('[MessageParser] CONTRACT VIOLATION: Payload must be a non-null object');
    });

    it('throws when assistant stream message lacks request_id', () => {
      expect(() => MessageParser.parse({
        role: 'assistant',
        content: 'Hello',
      })).toThrow('[MessageParser] CONTRACT VIOLATION: Backend must provide request_id for stream messages');
    });

    it('throws when computer stream message lacks request_id', () => {
      expect(() => MessageParser.parse({
        role: 'computer',
        start: true,
        content: 'output',
      })).toThrow('[MessageParser] CONTRACT VIOLATION: Backend must provide request_id for stream messages');
    });

    it('throws when request_id is not a string', () => {
      expect(() => MessageParser.parse({
        role: 'assistant',
        content: 'Hello',
        request_id: 123,
      })).toThrow('[MessageParser] CONTRACT VIOLATION: Backend must provide request_id for stream messages');
    });

    it('does NOT throw for assistant.message_flushed without request_id', () => {
      const result = MessageParser.parse({
        role: 'assistant',
        type: 'assistant.message_flushed',
        content: 'flushed content',
      });

      expect(result.type).toBe('assistant.message_flushed');
      expect(result.requestId).toBeNull();
    });

    it('does NOT throw for non-stream messages without request_id', () => {
      // Server message — not a stream message
      const result = MessageParser.parse({
        role: 'server',
        type: 'completion',
      });

      expect(result.role).toBe('server');
    });

    it('does NOT throw for assistant without content/start/end', () => {
      // No content, start, or end → not a stream message → no request_id needed
      const result = MessageParser.parse({
        role: 'assistant',
        type: 'some_type',
      });

      expect(result.role).toBe('assistant');
    });

    it('error message includes payload keys for debugging', () => {
      try {
        MessageParser.parse({
          role: 'assistant',
          content: 'test',
          some_field: 'value',
        });
        // Should not reach here
        expect(true).toBe(false);
      } catch (e) {
        expect(e.message).toContain('role');
        expect(e.message).toContain('content');
        expect(e.message).toContain('some_field');
      }
    });

    it('accepts empty object (no role/type)', () => {
      // Empty object is valid — no stream message, no contract violation
      const result = MessageParser.parse({});
      expect(result.role).toBeUndefined();
      expect(result.type).toBeUndefined();
    });

    it('accepts array as payload (typeof array is object)', () => {
      // Arrays are objects in JS — parse should not throw on type check
      // but the result will have undefined fields
      const result = MessageParser.parse([]);
      expect(result.role).toBeUndefined();
    });
  });

  // =========================================================================
  // parse() — Stream message detection
  // =========================================================================

  describe('parse() — stream message detection', () => {
    it('detects assistant role with content as stream message', () => {
      // Should require request_id
      expect(() => MessageParser.parse({
        role: 'assistant',
        content: 'text',
      })).toThrow('request_id');
    });

    it('detects assistant role with start as stream message', () => {
      expect(() => MessageParser.parse({
        role: 'assistant',
        start: true,
      })).toThrow('request_id');
    });

    it('detects assistant role with end as stream message', () => {
      expect(() => MessageParser.parse({
        role: 'assistant',
        end: true,
      })).toThrow('request_id');
    });

    it('detects computer role with content as stream message', () => {
      expect(() => MessageParser.parse({
        role: 'computer',
        content: 'output',
      })).toThrow('request_id');
    });

    it('does NOT detect user role as stream message', () => {
      const result = MessageParser.parse({
        role: 'user',
        content: 'hello',
      });
      expect(result.role).toBe('user');
    });

    it('does NOT detect server role as stream message', () => {
      const result = MessageParser.parse({
        role: 'server',
        content: 'info',
      });
      expect(result.role).toBe('server');
    });
  });

  // =========================================================================
  // isArtifact()
  // =========================================================================

  describe('isArtifact()', () => {
    it('returns true for assistant code artifact', () => {
      expect(MessageParser.isArtifact({ role: 'assistant', type: 'code' })).toBe(true);
    });

    it('returns true for computer console artifact', () => {
      expect(MessageParser.isArtifact({ role: 'computer', type: 'console' })).toBe(true);
    });

    it('returns true for computer output artifact', () => {
      expect(MessageParser.isArtifact({ role: 'computer', type: 'output' })).toBe(true);
    });

    it('returns true for computer HTML artifact', () => {
      expect(MessageParser.isArtifact({
        role: 'computer', type: 'code', format: 'html',
      })).toBe(true);
    });

    it('returns false for computer code with non-html format', () => {
      expect(MessageParser.isArtifact({
        role: 'computer', type: 'code', format: 'python',
      })).toBe(false);
    });

    it('returns false for assistant message type', () => {
      expect(MessageParser.isArtifact({ role: 'assistant', type: 'message' })).toBe(false);
    });

    it('returns false for server role', () => {
      expect(MessageParser.isArtifact({ role: 'server', type: 'code' })).toBe(false);
    });

    it('returns false for user role', () => {
      expect(MessageParser.isArtifact({ role: 'user', type: 'code' })).toBe(false);
    });

    it('returns false for computer with message type', () => {
      expect(MessageParser.isArtifact({ role: 'computer', type: 'message' })).toBe(false);
    });
  });

  // =========================================================================
  // isAssistantMessage()
  // =========================================================================

  describe('isAssistantMessage()', () => {
    it('returns true for assistant + message type', () => {
      expect(MessageParser.isAssistantMessage({ role: 'assistant', type: 'message' })).toBe(true);
    });

    it('returns true for assistant + assistant.message_flushed type', () => {
      expect(MessageParser.isAssistantMessage({
        role: 'assistant', type: 'assistant.message_flushed',
      })).toBe(true);
    });

    it('returns false for assistant + code type', () => {
      expect(MessageParser.isAssistantMessage({ role: 'assistant', type: 'code' })).toBe(false);
    });

    it('returns false for computer + message type', () => {
      expect(MessageParser.isAssistantMessage({ role: 'computer', type: 'message' })).toBe(false);
    });

    it('returns false for server role', () => {
      expect(MessageParser.isAssistantMessage({ role: 'server', type: 'message' })).toBe(false);
    });
  });

  // =========================================================================
  // isHandsfreeEvent()
  // =========================================================================

  describe('isHandsfreeEvent()', () => {
    const handsfreeTypes = [
      'wake-word-detected',
      'sleep-word-detected',
      'stt-final',
      'stt-partial',
      'tts-queued',
      'tts-completed',
      'tts-audio',
      'tts-error',
      'interruption-detected',
    ];

    handsfreeTypes.forEach(type => {
      it(`returns true for assistant + ${type}`, () => {
        expect(MessageParser.isHandsfreeEvent({ role: 'assistant', type })).toBe(true);
      });
    });

    it('returns false for non-assistant role with handsfree type', () => {
      expect(MessageParser.isHandsfreeEvent({
        role: 'server', type: 'wake-word-detected',
      })).toBe(false);
    });

    it('returns false for assistant with non-handsfree type', () => {
      expect(MessageParser.isHandsfreeEvent({
        role: 'assistant', type: 'message',
      })).toBe(false);
    });

    it('returns false for unknown type', () => {
      expect(MessageParser.isHandsfreeEvent({
        role: 'assistant', type: 'unknown-event',
      })).toBe(false);
    });
  });

  // =========================================================================
  // isProactiveNotification()
  // =========================================================================

  describe('isProactiveNotification()', () => {
    it('returns true for proactive role', () => {
      expect(MessageParser.isProactiveNotification({
        role: 'proactive', type: 'anything',
      })).toBe(true);
    });

    it('returns true for type starting with proactive', () => {
      expect(MessageParser.isProactiveNotification({
        role: 'server', type: 'proactive.reminder',
      })).toBe(true);
    });

    it('returns true for type exactly proactive', () => {
      expect(MessageParser.isProactiveNotification({
        role: 'server', type: 'proactive',
      })).toBe(true);
    });

    it('returns false for non-proactive role and type', () => {
      expect(MessageParser.isProactiveNotification({
        role: 'assistant', type: 'message',
      })).toBe(false);
    });

    it('returns false when type is null', () => {
      expect(MessageParser.isProactiveNotification({
        role: 'server', type: null,
      })).toBe(false);
    });

    it('returns false when type contains but does not start with proactive', () => {
      expect(MessageParser.isProactiveNotification({
        role: 'server', type: 'not-proactive-thing',
      })).toBe(false);
    });
  });

  // =========================================================================
  // isTrailEvent()
  // =========================================================================

  describe('isTrailEvent()', () => {
    it('returns true for server + trail.* type', () => {
      expect(MessageParser.isTrailEvent({ role: 'server', type: 'trail.start' })).toBe(true);
    });

    it('returns true for server + trail.update type', () => {
      expect(MessageParser.isTrailEvent({ role: 'server', type: 'trail.update' })).toBe(true);
    });

    it('returns false for server + non-trail type', () => {
      expect(MessageParser.isTrailEvent({ role: 'server', type: 'completion' })).toBe(false);
    });

    it('returns false for non-server role', () => {
      expect(MessageParser.isTrailEvent({ role: 'assistant', type: 'trail.start' })).toBe(false);
    });

    it('returns false when type is null', () => {
      expect(MessageParser.isTrailEvent({ role: 'server', type: null })).toBe(false);
    });

    it('returns false when type is undefined', () => {
      expect(MessageParser.isTrailEvent({ role: 'server' })).toBe(false);
    });

    it('returns false for type that is just trail without dot', () => {
      expect(MessageParser.isTrailEvent({ role: 'server', type: 'trail' })).toBe(false);
    });
  });

  // =========================================================================
  // isControlMessage()
  // =========================================================================

  describe('isControlMessage()', () => {
    it('returns true for server + completion', () => {
      expect(MessageParser.isControlMessage({ role: 'server', type: 'completion' })).toBe(true);
    });

    it('returns true for server + stopped', () => {
      expect(MessageParser.isControlMessage({ role: 'server', type: 'stopped' })).toBe(true);
    });

    it('returns true for server + context_reset_ack', () => {
      expect(MessageParser.isControlMessage({ role: 'server', type: 'context_reset_ack' })).toBe(true);
    });

    it('returns true for server + info', () => {
      expect(MessageParser.isControlMessage({ role: 'server', type: 'info' })).toBe(true);
    });

    it('returns true for server + path', () => {
      expect(MessageParser.isControlMessage({ role: 'server', type: 'path' })).toBe(true);
    });

    it('returns true for system role (any type)', () => {
      expect(MessageParser.isControlMessage({ role: 'system', type: 'anything' })).toBe(true);
    });

    it('returns true for system role with null type', () => {
      expect(MessageParser.isControlMessage({ role: 'system', type: null })).toBe(true);
    });

    it('returns true for type starting with system.', () => {
      expect(MessageParser.isControlMessage({ role: 'server', type: 'system.init' })).toBe(true);
    });

    it('returns true for type exactly error', () => {
      expect(MessageParser.isControlMessage({ role: 'server', type: 'error' })).toBe(true);
    });

    it('returns true for error type with any role', () => {
      expect(MessageParser.isControlMessage({ role: 'assistant', type: 'error' })).toBe(true);
    });

    it('returns true for user.message_persisted', () => {
      expect(MessageParser.isControlMessage({ role: 'server', type: 'user.message_persisted' })).toBe(true);
    });

    it('returns false for assistant + message', () => {
      expect(MessageParser.isControlMessage({ role: 'assistant', type: 'message' })).toBe(false);
    });

    it('returns false for server + trail.start (trail, not control)', () => {
      expect(MessageParser.isControlMessage({ role: 'server', type: 'trail.start' })).toBe(false);
    });

    it('returns false for user role with non-control type', () => {
      expect(MessageParser.isControlMessage({ role: 'user', type: 'message' })).toBe(false);
    });

    it('returns false when type is non-string (number)', () => {
      expect(MessageParser.isControlMessage({ role: 'server', type: 42 })).toBe(false);
    });
  });

  // =========================================================================
  // getArtifactType()
  // =========================================================================

  describe('getArtifactType()', () => {
    it('returns code for assistant + code', () => {
      expect(MessageParser.getArtifactType({ role: 'assistant', type: 'code' })).toBe('code');
    });

    it('returns console for computer + console', () => {
      expect(MessageParser.getArtifactType({ role: 'computer', type: 'console' })).toBe('console');
    });

    it('returns console for computer + output', () => {
      expect(MessageParser.getArtifactType({ role: 'computer', type: 'output' })).toBe('console');
    });

    it('returns html for computer + code + html format', () => {
      expect(MessageParser.getArtifactType({
        role: 'computer', type: 'code', format: 'html',
      })).toBe('html');
    });

    it('returns null for non-artifact message', () => {
      expect(MessageParser.getArtifactType({ role: 'assistant', type: 'message' })).toBeNull();
    });

    it('returns null for computer + code + non-html format', () => {
      expect(MessageParser.getArtifactType({
        role: 'computer', type: 'code', format: 'python',
      })).toBeNull();
    });

    it('returns null for server role', () => {
      expect(MessageParser.getArtifactType({ role: 'server', type: 'code' })).toBeNull();
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('parse handles payload with extra unknown fields', () => {
      const result = MessageParser.parse({
        role: 'server',
        type: 'info',
        unknown_field: 'value',
        another: 42,
      });

      expect(result.role).toBe('server');
      expect(result.raw.unknown_field).toBe('value');
    });

    it('parse with content: 0 (falsy) does not trigger stream check', () => {
      // content: 0 is falsy, so isStreamMessage = false
      const result = MessageParser.parse({
        role: 'assistant',
        type: 'message',
        content: 0,
      });
      // Should not throw (no request_id needed since content is falsy)
      expect(result.content).toBe(0);
    });

    it('parse with content: empty string does not trigger stream check', () => {
      const result = MessageParser.parse({
        role: 'assistant',
        type: 'message',
        content: '',
      });
      expect(result.content).toBe('');
    });

    it('classifier methods return consistent results on same message', () => {
      const artifact = { role: 'assistant', type: 'code' };
      expect(MessageParser.isArtifact(artifact)).toBe(true);
      expect(MessageParser.isAssistantMessage(artifact)).toBe(false);
      expect(MessageParser.isControlMessage(artifact)).toBe(false);
      expect(MessageParser.isHandsfreeEvent(artifact)).toBe(false);
      expect(MessageParser.isProactiveNotification(artifact)).toBe(false);
      expect(MessageParser.isTrailEvent(artifact)).toBe(false);
      expect(MessageParser.getArtifactType(artifact)).toBe('code');
    });

    it('server completion is control but not trail', () => {
      const msg = { role: 'server', type: 'completion' };
      expect(MessageParser.isControlMessage(msg)).toBe(true);
      expect(MessageParser.isTrailEvent(msg)).toBe(false);
    });

    it('server trail.start is trail but not control', () => {
      const msg = { role: 'server', type: 'trail.start' };
      expect(MessageParser.isTrailEvent(msg)).toBe(true);
      expect(MessageParser.isControlMessage(msg)).toBe(false);
    });

    it('system.init is control but not proactive or trail', () => {
      const msg = { role: 'server', type: 'system.init' };
      expect(MessageParser.isControlMessage(msg)).toBe(true);
      expect(MessageParser.isProactiveNotification(msg)).toBe(false);
      expect(MessageParser.isTrailEvent(msg)).toBe(false);
    });
  });

  // =========================================================================
  // Module exports
  // =========================================================================

  describe('module exports', () => {
    it('exports MessageParser class', () => {
      expect(typeof MessageParser).toBe('function');
      expect(MessageParser.name).toBe('MessageParser');
    });
  });
});
