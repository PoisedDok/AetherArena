'use strict';

/**
 * ApiClient Unit Tests
 * Tests the core ApiClient with proper fetch mocks
 */

const { ApiClient, ApiError, TimeoutError, CircuitBreakerError } = require('../../../../src/core/communication/ApiClient');

// Helper to create proper fetch response mocks
function createFetchResponse(data, options = {}) {
  const {
    ok = true,
    status = 200,
    statusText = 'OK',
    contentType = 'application/json',
  } = options;

  return Promise.resolve({
    ok,
    status,
    statusText,
    headers: {
      get: (name) => {
        if (name.toLowerCase() === 'content-type') return contentType;
        return null;
      }
    },
    json: async () => (typeof data === 'string' ? JSON.parse(data) : data),
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  });
}

describe('ApiClient', () => {
  let client;
  let originalFetch;

  beforeEach(() => {
    client = new ApiClient({
      baseURL: 'http://localhost:8765',
      timeout: 5000,
      retries: 2,
      retryDelay: 100,
    });

    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('Configuration', () => {
    test('should accept configuration options', () => {
      expect(client.baseURL).toBe('http://localhost:8765');
      expect(client.timeout).toBe(5000);
      expect(client.retries).toBe(2);
    });

    test('should use defaults for missing config', () => {
      const defaultClient = new ApiClient({});
      expect(defaultClient.timeout).toBeDefined();
      expect(defaultClient.retries).toBeDefined();
    });

    test('should initialize without errors', () => {
      expect(() => {
        new ApiClient({ baseURL: 'http://localhost:8000' });
      }).not.toThrow();
    });
  });

  describe('GET requests', () => {
    test('should make successful GET request', async () => {
      global.fetch = jest.fn(() => createFetchResponse({ success: true }));

      const result = await client.get('/test');

      expect(global.fetch).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    test('should handle GET request with query params', async () => {
      global.fetch = jest.fn(() => createFetchResponse({ results: [] }));

      await client.get('/test', { params: { foo: 'bar', baz: 123 } });

      expect(global.fetch).toHaveBeenCalled();
    });

    test('should throw ApiError on non-ok response', async () => {
      global.fetch = jest.fn(() => createFetchResponse(
        { error: 'Not found' },
        { ok: false, status: 404, statusText: 'Not Found' }
      ));

      await expect(client.get('/test')).rejects.toThrow();
    });
  });

  describe('POST requests', () => {
    test('should make successful POST request with JSON body', async () => {
      global.fetch = jest.fn(() => createFetchResponse({ success: true }));

      const body = { key: 'value' };
      await client.post('/test', { body });

      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe('Retry Logic', () => {
    test('should retry failed requests', async () => {
      let callCount = 0;
      global.fetch = jest.fn(() => {
        callCount++;
        if (callCount < 2) {
          return Promise.reject(new Error('Network error'));
        }
        return createFetchResponse({ success: true });
      });

      const result = await client.get('/test');

      expect(callCount).toBe(2);
      expect(result).toEqual({ success: true });
    });

    test('should respect retry limit', async () => {
      global.fetch = jest.fn(() => Promise.reject(new Error('Network error')));

      await expect(client.get('/test')).rejects.toThrow();

      // Initial attempt + 2 retries = 3 total calls
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('Timeout Handling', () => {
    test('should timeout long requests', async () => {
      const timeoutClient = new ApiClient({
        baseURL: 'http://localhost:8765',
        timeout: 100,
      });

      global.fetch = jest.fn((url, options) => {
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            resolve(createFetchResponse({ success: true }));
          }, 500);
          
          // Listen for abort signal
          if (options && options.signal) {
            options.signal.addEventListener('abort', () => {
              clearTimeout(timeoutId);
              const abortError = new Error('The operation was aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          }
        });
      });

      await expect(timeoutClient.get('/test')).rejects.toThrow();
    });
  });

  describe('Circuit Breaker', () => {
    test('should open circuit after threshold failures', async () => {
      global.fetch = jest.fn(() => Promise.reject(new Error('Network error')));

      const breakerClient = new ApiClient({
        baseURL: 'http://localhost:8765',
        retries: 0,
        circuitBreaker: true,
        circuitBreakerOptions: {
          threshold: 3,
          volumeThreshold: 1,
        },
      });

      // Make requests to trigger circuit breaker
      for (let i = 0; i < 5; i++) {
        try {
          await breakerClient.get('/test');
        } catch (e) {
          // Expected to fail
        }
      }

      // Circuit should be open now
      const cbState = breakerClient.getCircuitBreakerState();
      expect(['OPEN', 'HALF_OPEN']).toContain(cbState.state);
    });
  });

  describe('AbortSignal', () => {
    test('should support request cancellation', async () => {
      const controller = new AbortController();

      global.fetch = jest.fn(() => {
        return new Promise((_, reject) => {
          setTimeout(() => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          }, 100);
        });
      });

      const promise = client.get('/test', { signal: controller.signal });

      controller.abort();

      await expect(promise).rejects.toThrow();
    });
  });

  describe('Rate Limiting', () => {
    test('should enforce rate limits when enabled', async () => {
      const rateLimitedClient = new ApiClient({
        baseURL: 'http://localhost:8765',
        rateLimiter: true,
        rateLimiterOptions: {
          limits: {
            api: {
              tokensPerSecond: 2,
              burstCapacity: 2,
            },
          },
        },
      });

      global.fetch = jest.fn(() => createFetchResponse({ success: true }));

      // Should succeed for first 2 requests
      await rateLimitedClient.get('/test');
      await rateLimitedClient.get('/test');

      // Third request should be rate limited
      await expect(rateLimitedClient.get('/test')).rejects.toThrow();
    });
  });

  describe('Request Interceptors', () => {
    test('should call request interceptors', async () => {
      const interceptor = jest.fn((config) => {
        config.headers['X-Custom'] = 'value';
        return config;
      });

      client.addRequestInterceptor(interceptor);

      global.fetch = jest.fn(() => createFetchResponse({ success: true }));

      await client.get('/test');

      expect(interceptor).toHaveBeenCalled();
    });
  });

  describe('Response Interceptors', () => {
    test('should call response interceptors', async () => {
      const interceptor = jest.fn((response) => {
        response.intercepted = true;
        return response;
      });

      client.addResponseInterceptor(interceptor);

      global.fetch = jest.fn(() => createFetchResponse({ success: true }));

      await client.get('/test');

      expect(interceptor).toHaveBeenCalled();
    });
  });
});
