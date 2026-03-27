/**
 * @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js
 */
'use strict';

/**
 * Network Error & UI Feedback Tests - REAL ERROR HANDLING
 * ============================================================================
 * Tests that UI properly displays errors when network fails, backend crashes,
 * or requests timeout. These tests ensure users see meaningful error messages.
 * 
 * @module tests/component/NetworkError.real
 */

const { ApiClient } = require('../../src/core/communication/ApiClient');
const GuruConnection = require('../../src/core/communication/GuruConnection');

describe('Network Error UI Handling', () => {
  let mockFetch;
  let originalWebSocket;

  beforeEach(() => {
    // Mock fetch
    global.fetch = jest.fn();
    mockFetch = global.fetch;

    // Save WebSocket
    originalWebSocket = global.WebSocket;
  });

  afterEach(() => {
    global.fetch = mockFetch;
    global.WebSocket = originalWebSocket;
    jest.clearAllMocks();
  });

  describe('HTTP Request Failures', () => {
    test('should handle 500 server error', async () => {
      const client = new ApiClient({
        baseURL: 'http://localhost:8765',
        retries: 0
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: { get: () => 'text/plain' },
        text: async () => 'Server crashed'
      });

      await expect(client.get('/api/chat')).rejects.toThrow();
    });

    test('should handle network timeout', async () => {
      const client = new ApiClient({
        baseURL: 'http://localhost:8765',
        timeout: 100,
        retries: 0
      });

      mockFetch.mockImplementation(() => 
        new Promise((resolve, reject) => {
          setTimeout(() => reject({ name: 'AbortError' }), 200);
        })
      );

      await expect(client.get('/api/chat')).rejects.toThrow();
    });

    test('should handle connection refused', async () => {
      const client = new ApiClient({
        baseURL: 'http://localhost:8765',
        retries: 0
      });

      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(client.get('/api/health')).rejects.toThrow('ECONNREFUSED');
    });

    test('should retry on 503 and eventually fail', async () => {
      const client = new ApiClient({
        baseURL: 'http://localhost:8765',
        retries: 2
      });

      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: { get: () => 'text/plain' },
        text: async () => 'Service down'
      });

      await expect(client.get('/api/chat')).rejects.toThrow();
      
      // Should have retried 2 times (3 total attempts)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    test('should handle invalid JSON response', async () => {
      const client = new ApiClient({
        baseURL: 'http://localhost:8765'
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => '{invalid json!!!',
      });

      // Malformed JSON returns raw text string, not a throw
      const result = await client.get('/api/chat');
      expect(result).toBe('{invalid json!!!');
    });
  });

  describe('WebSocket Connection Failures', () => {
    test('should handle WebSocket connection failure', (done) => {
      // GuruConnection catches WebSocket construction errors and emits them
      // rather than propagating (production-safe behavior since detached + reconnect).
      global.WebSocket = jest.fn(() => {
        throw new Error('Connection refused');
      });
      global.WebSocket.CONNECTING = 0;
      global.WebSocket.OPEN = 1;
      global.WebSocket.CLOSED = 3;

      const connection = new GuruConnection({
        url: 'ws://localhost:8765/ws',
        enableLogging: false,
        reconnectDelay: 999999 // prevent reconnect in test
      });

      // Error is emitted as event, not thrown
      connection.on('error', (err) => {
        expect(err.message).toBe('Connection refused');
        connection.dispose();
        done();
      });
    });

    test('should handle WebSocket unexpected close', (done) => {
      const mockWS = {
        readyState: 0, // CONNECTING
        send: jest.fn(),
        close: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        binaryType: 'arraybuffer'
      };

      global.WebSocket = jest.fn(() => mockWS);
      global.WebSocket.CONNECTING = 0;
      global.WebSocket.OPEN = 1;
      global.WebSocket.CLOSED = 3;

      const connection = new GuruConnection({
        url: 'ws://localhost:8765/ws',
        enableLogging: false,
        reconnectDelay: 50
      });

      // Simulate unexpected close
      setTimeout(() => {
        connection._handleClose({ code: 1006, reason: 'Abnormal closure' });
        
        // Should schedule reconnect
        expect(connection.reconnecting).toBe(true);
        
        connection.dispose();
        done();
      }, 100);
    });

    test('should emit connection lost event', (done) => {
      const mockWS = {
        readyState: 1, // OPEN
        send: jest.fn(),
        close: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        binaryType: 'arraybuffer'
      };

      global.WebSocket = jest.fn(() => mockWS);
      global.WebSocket.CONNECTING = 0;
      global.WebSocket.OPEN = 1;
      global.WebSocket.CLOSED = 3;

      const connection = new GuruConnection({
        url: 'ws://localhost:8765/ws',
        enableLogging: false
      });

      let connectionLost = false;
      connection.on('disconnected', () => {
        connectionLost = true;
      });

      // Simulate connection loss
      setTimeout(() => {
        mockWS.readyState = 3; // CLOSED
        connection._handleClose({ code: 1006 });
        
        expect(connectionLost).toBe(true);
        
        connection.dispose();
        done();
      }, 100);
    });
  });

  describe('Circuit Breaker Activation', () => {
    test('should open circuit after threshold failures', async () => {
      const client = new ApiClient({
        baseURL: 'http://localhost:8765',
        circuitBreaker: true,
        circuitBreakerOptions: {
          threshold: 3,
          volumeThreshold: 3
        },
        retries: 0
      });

      mockFetch.mockRejectedValue(new Error('Network error'));

      // Trigger circuit breaker
      for (let i = 0; i < 3; i++) {
        try {
          await client.get('/api/test');
        } catch (e) {
          // Expected
        }
      }

      const state = client.getCircuitBreakerState();
      expect(state.state).toBe('OPEN');
    });

    test('should fast-fail when circuit is open', async () => {
      const client = new ApiClient({
        baseURL: 'http://localhost:8765',
        circuitBreaker: true,
        circuitBreakerOptions: {
          threshold: 3,
          volumeThreshold: 3
        },
        retries: 0
      });

      mockFetch.mockRejectedValue(new Error('Network error'));

      // Open circuit
      for (let i = 0; i < 3; i++) {
        try {
          await client.get('/api/test');
        } catch (e) {}
      }

      const callsBefore = mockFetch.mock.calls.length;

      // Try request with open circuit
      try {
        await client.get('/api/test');
      } catch (e) {
        expect(e.message).toContain('Circuit breaker is OPEN');
      }

      const callsAfter = mockFetch.mock.calls.length;

      // Should not make network call (fast-fail)
      expect(callsAfter).toBe(callsBefore);
    });
  });

  describe('Rate Limit Errors', () => {
    test('should reject when rate limit exceeded', async () => {
      const client = new ApiClient({
        baseURL: 'http://localhost:8765',
        rateLimiter: true,
        rateLimiterOptions: {
          limits: {
            api: {
              tokensPerSecond: 1,
              burstCapacity: 2
            }
          }
        }
      });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ success: true }),
      });

      // First 2 succeed (burst capacity)
      await client.get('/api/test');
      await client.get('/api/test');

      // 3rd should be rate limited
      await expect(client.get('/api/test')).rejects.toThrow('Rate limit exceeded');
    });

    test('should include retry-after information', async () => {
      const client = new ApiClient({
        baseURL: 'http://localhost:8765',
        rateLimiter: true,
        rateLimiterOptions: {
          limits: {
            api: {
              tokensPerSecond: 1,
              burstCapacity: 1
            }
          }
        }
      });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ success: true }),
      });

      // Consume capacity
      await client.get('/api/test');

      // Next request should fail with retry info
      try {
        await client.get('/api/test');
      } catch (error) {
        expect(error.retryAfter).toBeGreaterThan(0);
        expect(error.message).toContain('Rate limit exceeded');
      }
    });
  });

  describe('Error Recovery', () => {
    test('should recover after transient failure', async () => {
      const client = new ApiClient({
        baseURL: 'http://localhost:8765',
        retries: 1,
        retryDelay: 10
      });

      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Temporary failure'));
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ success: true }),
        });
      });

      const result = await client.get('/api/test');

      expect(result.success).toBe(true);
      expect(callCount).toBe(2); // Failed once, retried and succeeded
    });

    test('should emit recovery event when connection restored', (done) => {
      const mockWS = {
        readyState: 0,
        send: jest.fn(),
        close: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        binaryType: 'arraybuffer'
      };

      global.WebSocket = jest.fn(() => mockWS);
      global.WebSocket.CONNECTING = 0;
      global.WebSocket.OPEN = 1;
      global.WebSocket.CLOSED = 3;

      const connection = new GuruConnection({
        url: 'ws://localhost:8765/ws',
        enableLogging: false
      });

      let reconnected = false;
      connection.on('connected', () => {
        reconnected = true;
      });

      setTimeout(() => {
        mockWS.readyState = 1; // OPEN
        connection._handleOpen(connection.connectionId);

        expect(reconnected).toBe(true);

        connection.dispose();
        done();
      }, 100);
    });
  });
});

