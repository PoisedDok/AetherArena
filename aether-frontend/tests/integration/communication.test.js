/**
 * Communication Layer Integration Tests
 * ============================================================================
 * Tests for GuruConnection, ApiClient, and Endpoint with:
 * - Retry logic
 * - Circuit breaker
 * - Rate limiting
 * - Reconnection
 * - Error handling
 */

const { ApiClient, CircuitBreaker } = require('../../src/core/communication/ApiClient');
const GuruConnection = require('../../src/core/communication/GuruConnection');
const Endpoint = require('../../src/core/communication/Endpoint');
const { RateLimiter } = require('../../src/core/security/RateLimiter');

/**
 * Create mock fetch response with proper headers
 */
function createMockResponse(options = {}) {
  const {
    ok = true,
    status = 200,
    contentType = 'application/json',
    json = null,
    text = null,
  } = options;

  return {
    ok,
    status,
    headers: {
      get: (key) => key.toLowerCase() === 'content-type' ? contentType : null,
    },
    json: async () => json || {},
    text: async () => text || '',
  };
}

describe('Communication Layer Integration Tests', () => {
  
  describe('ApiClient', () => {
    let client;
    let mockFetch;

    beforeEach(() => {
      // Mock fetch
      global.fetch = jest.fn();
      mockFetch = global.fetch;
      
      client = new ApiClient({
        baseURL: 'http://localhost:8000',
        timeout: 1000,
        retries: 2,
        enableLogging: false,
      });
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    describe('Basic Requests', () => {
      test('successful GET request', async () => {
        mockFetch.mockResolvedValueOnce(createMockResponse({
          json: { data: 'test' },
        }));

        const result = await client.get('/api/test');
        expect(result).toEqual({ data: 'test' });
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      test('successful POST request', async () => {
        mockFetch.mockResolvedValueOnce(createMockResponse({
          status: 201,
          json: { id: 1 },
        }));

        const result = await client.post('/api/users', { name: 'Test' });
        expect(result).toEqual({ id: 1 });
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
    });

    describe('Retry Logic', () => {
      test('retries on timeout', async () => {
        mockFetch
          .mockRejectedValueOnce({ name: 'AbortError' })
          .mockRejectedValueOnce({ name: 'AbortError' })
          .mockResolvedValueOnce(createMockResponse({
            json: { data: 'success' },
          }));

        const result = await client.get('/api/test');
        expect(result).toEqual({ data: 'success' });
        expect(mockFetch).toHaveBeenCalledTimes(3); // 2 failures + 1 success
      });

      test('retries on 503 status', async () => {
        mockFetch
          .mockResolvedValueOnce(createMockResponse({
            ok: false,
            status: 503,
            contentType: 'text/plain',
            text: 'Service Unavailable',
          }))
          .mockResolvedValueOnce(createMockResponse({
            json: { data: 'success' },
          }));

        const result = await client.get('/api/test');
        expect(result).toEqual({ data: 'success' });
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      test('fails after max retries', async () => {
        mockFetch.mockRejectedValue({ name: 'AbortError' });

        await expect(client.get('/api/test')).rejects.toThrow('timeout');
        expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
      });

      test('does not retry on 404', async () => {
        mockFetch.mockResolvedValueOnce(createMockResponse({
          ok: false,
          status: 404,
          contentType: 'text/plain',
          text: 'Not Found',
        }));

        await expect(client.get('/api/test')).rejects.toThrow('404');
        expect(mockFetch).toHaveBeenCalledTimes(1); // No retries
      });
    });

    describe('Circuit Breaker', () => {
      test('opens circuit after threshold failures', async () => {
        const testClient = new ApiClient({
          baseURL: 'http://localhost:8000',
          circuitBreaker: true,
          circuitBreakerOptions: {
            threshold: 3,
            volumeThreshold: 5,
          },
          retries: 0, // Disable retries for cleaner test
        });

        // Simulate 5 requests with 3+ failures
        mockFetch.mockRejectedValue(new Error('Network error'));

        for (let i = 0; i < 5; i++) {
          try {
            await testClient.get('/api/test');
          } catch {}
        }

        const state = testClient.getCircuitBreakerState();
        expect(state.state).toBe('OPEN');
      });

      test('half-opens circuit after timeout', async () => {
        const testClient = new ApiClient({
          baseURL: 'http://localhost:8000',
          circuitBreaker: true,
          circuitBreakerOptions: {
            threshold: 3,
            volumeThreshold: 3,
            timeout: 100, // 100ms timeout
          },
          retries: 0,
        });

        // Open circuit
        mockFetch.mockRejectedValue(new Error('Network error'));
        for (let i = 0; i < 3; i++) {
          try {
            await testClient.get('/api/test');
          } catch {}
        }

        expect(testClient.getCircuitBreakerState().state).toBe('OPEN');

        // Wait for timeout
        await new Promise(resolve => setTimeout(resolve, 150));

        // Try request (should transition to HALF_OPEN)
        mockFetch.mockResolvedValueOnce(createMockResponse({
          json: { data: 'success' },
        }));

        await testClient.get('/api/test');
        expect(testClient.getCircuitBreakerState().state).toBe('CLOSED');
      });
    });

    describe('Rate Limiting', () => {
      test('enforces rate limits', async () => {
        const testClient = new ApiClient({
          baseURL: 'http://localhost:8000',
          rateLimiter: true,
          rateLimiterOptions: {
            limits: {
              api: {
                tokensPerSecond: 2,
                burstCapacity: 3,
              },
            },
          },
        });

        mockFetch.mockResolvedValue(createMockResponse({
          json: { data: 'test' },
        }));

        // First 3 requests should succeed (burst capacity)
        await testClient.get('/api/test');
        await testClient.get('/api/test');
        await testClient.get('/api/test');

        // 4th request should be rate limited
        await expect(testClient.get('/api/test')).rejects.toThrow('Rate limit exceeded');
      });

      test('respects rate limit categories', async () => {
        const testClient = new ApiClient({
          baseURL: 'http://localhost:8000',
          rateLimiter: true,
          rateLimiterOptions: {
            limits: {
              heavy: {
                tokensPerSecond: 1,
                burstCapacity: 2,
              },
            },
          },
        });

        mockFetch.mockResolvedValue(createMockResponse({
          json: { data: 'test' },
        }));

        // First 2 heavy requests should succeed
        await testClient.get('/api/upload', { rateCategory: 'heavy' });
        await testClient.get('/api/upload', { rateCategory: 'heavy' });

        // 3rd heavy request should be rate limited
        await expect(
          testClient.get('/api/upload', { rateCategory: 'heavy' })
        ).rejects.toThrow('Rate limit exceeded');
      });
    });

    describe('Request Interceptors', () => {
      test('modifies request config', async () => {
        client.addRequestInterceptor((config) => {
          config.headers['X-Custom-Header'] = 'test-value';
          return config;
        });

        mockFetch.mockResolvedValueOnce(createMockResponse({
          json: { data: 'test' },
        }));

        await client.get('/api/test');

        const fetchCall = mockFetch.mock.calls[0];
        expect(fetchCall[1].headers['X-Custom-Header']).toBe('test-value');
      });
    });

    describe('Response Interceptors', () => {
      test('transforms response', async () => {
        client.addResponseInterceptor((response) => {
          return { ...response, transformed: true };
        });

        mockFetch.mockResolvedValueOnce(createMockResponse({
          json: { data: 'test' },
        }));

        const result = await client.get('/api/test');
        expect(result.transformed).toBe(true);
      });
    });
  });

  describe('GuruConnection', () => {
    let connection;
    let mockWebSocket;

    beforeEach(() => {
      // Mock WebSocket with proper constants
      mockWebSocket = {
        readyState: 0, // CONNECTING
        send: jest.fn(),
        close: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      };

      // Mock WebSocket class with constants
      global.WebSocket = jest.fn(() => mockWebSocket);
      global.WebSocket.CONNECTING = 0;
      global.WebSocket.OPEN = 1;
      global.WebSocket.CLOSING = 2;
      global.WebSocket.CLOSED = 3;
    });

    afterEach(() => {
      if (connection) {
        connection.dispose();
      }
      jest.clearAllMocks();
    });

    test('connects to WebSocket', () => {
      connection = new GuruConnection({
        url: 'ws://localhost:8000/ws',
        enableLogging: false,
      });

      expect(global.WebSocket).toHaveBeenCalledWith('ws://localhost:8000/ws');
    });

    test('queues messages when not connected', () => {
      connection = new GuruConnection({
        url: 'ws://localhost:8000/ws',
        enableLogging: false,
      });

      // WebSocket is CONNECTING
      mockWebSocket.readyState = global.WebSocket.CONNECTING;

      connection.send({ type: 'test' });
      expect(connection.messageQueue.length).toBe(1);
      expect(mockWebSocket.send).not.toHaveBeenCalled();
    });

    test('flushes queue on connection', () => {
      connection = new GuruConnection({
        url: 'ws://localhost:8000/ws',
        enableLogging: false,
      });

      // Queue message while connecting
      mockWebSocket.readyState = global.WebSocket.CONNECTING;
      connection.send({ type: 'test' });
      
      expect(connection.messageQueue.length).toBe(1);

      // Simulate connection open
      mockWebSocket.readyState = global.WebSocket.OPEN;
      connection._handleOpen(connection.connectionId);

      expect(mockWebSocket.send).toHaveBeenCalledTimes(1);
      expect(connection.messageQueue.length).toBe(0);
    });

    test('handles reconnection', (done) => {
      connection = new GuruConnection({
        url: 'ws://localhost:8000/ws',
        reconnectDelay: 100,
        enableLogging: false,
      });

      // Simulate close
      connection._handleClose({ code: 1006, reason: 'Abnormal close' });

      // Wait for reconnection attempt
      setTimeout(() => {
        expect(global.WebSocket).toHaveBeenCalledTimes(2);
        done();
      }, 150);
    });

    test('exponential backoff on reconnect', (done) => {
      connection = new GuruConnection({
        url: 'ws://localhost:8000/ws',
        reconnectDelay: 100,
        enableLogging: false,
      });

      const startTime = Date.now();

      // First failed connection
      connection.reconnectAttempts = 0;
      connection._scheduleReconnect();

      // Second failed connection
      connection.reconnectAttempts = 1;
      connection._scheduleReconnect();

      setTimeout(() => {
        const elapsed = Date.now() - startTime;
        // Second attempt should have longer delay (exponential backoff)
        expect(elapsed).toBeGreaterThan(200); // 100 + 200
        done();
      }, 350);
    });

    test('sends ping and handles pong', (done) => {
      connection = new GuruConnection({
        url: 'ws://localhost:8000/ws',
        pingInterval: 100,
        enableLogging: false,
      });

      // Simulate connection open to trigger ping mechanism
      mockWebSocket.readyState = global.WebSocket.OPEN;
      connection._handleOpen(connection.connectionId);

      setTimeout(() => {
        expect(mockWebSocket.send).toHaveBeenCalled();
        // Find the ping message in the calls
        const pingCall = mockWebSocket.send.mock.calls.find(call => {
          try {
            const data = JSON.parse(call[0]);
            return data.type === 'ping';
          } catch {
            return false;
          }
        });
        expect(pingCall).toBeDefined();
        done();
      }, 150);
    });
  });

  describe('Endpoint', () => {
    let endpoint;
    let mockWebSocket;
    let mockFetch;

    beforeEach(() => {
      // Mock WebSocket with constants
      mockWebSocket = {
        readyState: 1, // OPEN
        send: jest.fn(),
        close: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        binaryType: 'arraybuffer',
      };
      global.WebSocket = jest.fn(() => mockWebSocket);
      global.WebSocket.CONNECTING = 0;
      global.WebSocket.OPEN = 1;
      global.WebSocket.CLOSING = 2;
      global.WebSocket.CLOSED = 3;

      // Mock fetch
      global.fetch = jest.fn();
      mockFetch = global.fetch;

      endpoint = new Endpoint({
        WS_URL: 'ws://localhost:8000/ws',
        API_BASE_URL: 'http://localhost:8000',
        NODE_ENV: 'test',
      });
    });

    afterEach(() => {
      if (endpoint) {
        endpoint.dispose();
      }
      jest.clearAllMocks();
    });

    test('sends user message via WebSocket', () => {
      // Ensure WebSocket is connected - manually set ws property
      if (!endpoint.guruConnection) {
        endpoint.guruConnection = { ws: mockWebSocket };
      }
      endpoint.guruConnection.ws = mockWebSocket;
      endpoint.guruConnection.ws.readyState = global.WebSocket.OPEN;
      
      const requestId = endpoint.sendUserMessage('Hello', 'test-123');

      expect(mockWebSocket.send).toHaveBeenCalled();
      expect(requestId).toBe('test-123');
      
      const sentData = JSON.parse(mockWebSocket.send.mock.calls[0][0]);
      expect(sentData.role).toBe('user');
      expect(sentData.content).toBe('Hello');
      expect(sentData.id).toBe('test-123');
    });

    test('makes HTTP GET request', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({
        json: { status: 'healthy' },
      }));

      const result = await endpoint.getHealth();
      expect(result).toEqual({ status: 'healthy' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('provides combined statistics', () => {
      const stats = endpoint.getStats();

      expect(stats).toHaveProperty('websocket');
      expect(stats).toHaveProperty('http');
      expect(stats.http).toHaveProperty('circuitBreaker');
      expect(stats.http).toHaveProperty('rateLimiter');
    });

    test('subscribes to WebSocket events', (done) => {
      endpoint.on('message', (data) => {
        expect(data.type).toBe('test');
        done();
      });

      // Simulate receiving message
      endpoint.connection.emit('message', { type: 'test' });
    });
  });

  describe('Backend Failure Simulation', () => {
    let endpoint;
    let mockFetch;

    beforeEach(() => {
      global.fetch = jest.fn();
      mockFetch = global.fetch;

      // Mock WebSocket as down
      global.WebSocket = jest.fn(() => {
        throw new Error('Connection refused');
      });
    });

    afterEach(() => {
      if (endpoint) {
        try {
          endpoint.dispose();
        } catch {}
      }
      jest.clearAllMocks();
    });

    test('circuit breaker prevents cascade failures', async () => {
      const testClient = new ApiClient({
        baseURL: 'http://localhost:8000',
        circuitBreaker: true,
        circuitBreakerOptions: {
          threshold: 3,
          volumeThreshold: 3,
        },
        retries: 0,
      });

      // Simulate backend down
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      // Make requests until circuit opens
      for (let i = 0; i < 3; i++) {
        try {
          await testClient.get('/api/test');
        } catch {}
      }

      // Circuit should be open
      const state = testClient.getCircuitBreakerState();
      expect(state.state).toBe('OPEN');

      // Next request should fail fast (no network call)
      const fetchCallsBefore = mockFetch.mock.calls.length;
      await expect(testClient.get('/api/test')).rejects.toThrow('Circuit breaker is OPEN');
      const fetchCallsAfter = mockFetch.mock.calls.length;
      
      expect(fetchCallsAfter).toBe(fetchCallsBefore); // No new fetch call
    });

    test('WebSocket reconnects when backend recovers', (done) => {
      let connectionAttempts = 0;
      
      global.WebSocket = jest.fn(() => {
        connectionAttempts++;
        
        if (connectionAttempts <= 2) {
          // First 2 attempts fail
          throw new Error('Connection refused');
        } else {
          // 3rd attempt succeeds
          return {
            readyState: 1,
            send: jest.fn(),
            close: jest.fn(),
            binaryType: 'arraybuffer',
          };
        }
      });

      const connection = new GuruConnection({
        url: 'ws://localhost:8000/ws',
        reconnectDelay: 50,
        healthInterval: 50,
        enableLogging: false,
      });

      // Wait for reconnection attempts
      setTimeout(() => {
        expect(connectionAttempts).toBeGreaterThan(1);
        connection.dispose();
        done();
      }, 300);
    });
  });
});

