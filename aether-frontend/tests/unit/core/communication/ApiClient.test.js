'use strict';

/**
 * ApiClient Unit Tests
 * Tests the core ApiClient with proper fetch mocks
 */

const { ApiClient, ApiError, TimeoutError, CircuitBreakerError, BackendUnavailableError } = require('../../../../src/core/communication/ApiClient');

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
        new ApiClient({ baseURL: 'http://localhost:8765' });
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

      await expect(promise).rejects.toMatchObject({
        name: 'AbortError',
        isAbortError: true,
      });
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

  // ==========================================================================
  // REGRESSION: Signal Composition (Bug #2)
  // Previously, `config.signal || controller.signal` bypassed the internal
  // timeout when a user signal was provided.
  // ==========================================================================

  describe('Signal Composition (Regression)', () => {
    test('should timeout even when user provides an AbortSignal', async () => {
      const timeoutClient = new ApiClient({
        baseURL: 'http://localhost:8765',
        timeout: 50,
        retries: 0,
      });

      const userController = new AbortController();

      global.fetch = jest.fn((url, options) => {
        return new Promise((resolve, reject) => {
          const tid = setTimeout(() => resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { get: () => 'application/json' },
            text: async () => '{"slow":true}',
          }), 5000);

          // The signal should be the INTERNAL controller's signal (not user's)
          // because signals are now composed
          if (options && options.signal) {
            options.signal.addEventListener('abort', () => {
              clearTimeout(tid);
              const abortError = new Error('The operation was aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          }
        });
      });

      // User provides their own signal that is NOT aborted
      await expect(
        timeoutClient.get('/slow', { signal: userController.signal })
      ).rejects.toThrow(TimeoutError);

      // User's signal was not aborted — internal timeout triggered
      expect(userController.signal.aborted).toBe(false);
    });

    test('should respect user abort even with internal timeout present', async () => {
      const longTimeoutClient = new ApiClient({
        baseURL: 'http://localhost:8765',
        timeout: 60000,
        retries: 0,
      });

      const userController = new AbortController();

      global.fetch = jest.fn((url, options) => {
        return new Promise((resolve, reject) => {
          const tid = setTimeout(() => resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { get: () => 'application/json' },
            text: async () => '{"slow":true}',
          }), 5000);

          if (options && options.signal) {
            options.signal.addEventListener('abort', () => {
              clearTimeout(tid);
              const abortError = new Error('The operation was aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          }
        });
      });

      const promise = longTimeoutClient.get('/test', { signal: userController.signal });

      // User aborts immediately
      userController.abort();

      // User abort should remain AbortError (not TimeoutError)
      await expect(promise).rejects.toMatchObject({
        name: 'AbortError',
        isAbortError: true,
      });
    });

    test('should not classify user abort as TimeoutError', async () => {
      const longTimeoutClient = new ApiClient({
        baseURL: 'http://localhost:8765',
        timeout: 60000,
        retries: 0,
      });

      const userController = new AbortController();

      global.fetch = jest.fn((url, options) => {
        return new Promise((resolve, reject) => {
          const tid = setTimeout(() => resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { get: () => 'application/json' },
            text: async () => '{"slow":true}',
          }), 5000);

          options.signal.addEventListener('abort', () => {
            clearTimeout(tid);
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        });
      });

      const promise = longTimeoutClient.get('/test', { signal: userController.signal });
      userController.abort('User cancelled');

      await expect(promise).rejects.not.toBeInstanceOf(TimeoutError);
    });

    test('should handle already-aborted user signal', async () => {
      const userController = new AbortController();
      userController.abort(); // Pre-aborted

      global.fetch = jest.fn((url, options) => {
        return new Promise((resolve, reject) => {
          if (options && options.signal && options.signal.aborted) {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            reject(abortError);
            return;
          }
          resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { get: () => 'application/json' },
            text: async () => '{}',
          });
        });
      });

      await expect(
        client.get('/test', { signal: userController.signal })
      ).rejects.toThrow();
    });

    test('should always pass controller.signal to fetch, not user signal', async () => {
      const userController = new AbortController();

      global.fetch = jest.fn((url, options) => {
        // The signal passed to fetch should NOT be the user's signal
        expect(options.signal).not.toBe(userController.signal);
        // It should be an AbortSignal (the internal controller's)
        expect(options.signal).toBeInstanceOf(AbortSignal);

        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => 'application/json' },
          text: async () => '{"ok":true}',
        });
      });

      await client.get('/test', { signal: userController.signal });

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // REGRESSION: Malformed JSON Response (Bug #3)
  // Previously, response.json() consumed the stream; response.text() in the
  // catch would fail with "body used already".
  // ==========================================================================

  describe('Malformed JSON Response (Regression)', () => {
    test('should return raw text when JSON response contains invalid JSON', async () => {
      const malformedJson = '{"broken": true,}'; // Trailing comma = invalid JSON

      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name) => {
            if (name.toLowerCase() === 'content-type') return 'application/json';
            if (name.toLowerCase() === 'content-length') return String(malformedJson.length);
            return null;
          },
        },
        text: async () => malformedJson,
      }));

      const result = await client.get('/test');

      // Should fall through to raw text since JSON.parse fails
      expect(result).toBe(malformedJson);
    });

    test('should parse valid JSON response correctly', async () => {
      const validData = { status: 'ok', count: 42, items: ['a', 'b'] };

      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name) => {
            if (name.toLowerCase() === 'content-type') return 'application/json';
            return null;
          },
        },
        text: async () => JSON.stringify(validData),
      }));

      const result = await client.get('/test');

      expect(result).toEqual(validData);
    });

    test('should return plain text for non-JSON content types', async () => {
      const plainText = 'Hello, world!';

      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name) => {
            if (name.toLowerCase() === 'content-type') return 'text/plain';
            return null;
          },
        },
        text: async () => plainText,
      }));

      const result = await client.get('/test');

      expect(result).toBe(plainText);
    });

    test('should return null for 204 No Content', async () => {
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        status: 204,
        statusText: 'No Content',
        headers: {
          get: () => null,
        },
      }));

      const result = await client.get('/test');

      expect(result).toBeNull();
    });

    test('should not call response body methods more than once', async () => {
      const textFn = jest.fn(async () => '{"valid":true}');

      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name) => {
            if (name.toLowerCase() === 'content-type') return 'application/json';
            return null;
          },
        },
        text: textFn,
      }));

      await client.get('/test');

      // text() should be called exactly once — no double consumption
      expect(textFn).toHaveBeenCalledTimes(1);
    });

    test('should handle empty JSON body gracefully', async () => {
      global.fetch = jest.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name) => {
            if (name.toLowerCase() === 'content-type') return 'application/json';
            return null;
          },
        },
        text: async () => '',
      }));

      const result = await client.get('/test');

      // Empty string fails JSON.parse, should return empty string
      expect(result).toBe('');
    });
  });

  // ==========================================================================
  // Interceptor Management
  // ==========================================================================

  describe('Interceptor Removal', () => {
    test('should remove request interceptor', () => {
      const interceptor = jest.fn((config) => config);
      client.addRequestInterceptor(interceptor);

      expect(client.removeRequestInterceptor(interceptor)).toBe(true);
      expect(client.requestInterceptors).toHaveLength(0);
    });

    test('should return false when removing non-existent interceptor', () => {
      expect(client.removeRequestInterceptor(jest.fn())).toBe(false);
    });

    test('should remove response interceptor', () => {
      const interceptor = jest.fn((r) => r);
      client.addResponseInterceptor(interceptor);

      expect(client.removeResponseInterceptor(interceptor)).toBe(true);
      expect(client.responseInterceptors).toHaveLength(0);
    });

    test('should reject non-function interceptors', () => {
      expect(() => client.addRequestInterceptor('not a function')).toThrow(TypeError);
      expect(() => client.addResponseInterceptor(42)).toThrow(TypeError);
    });
  });

  // ==========================================================================
  // Dispose
  // ==========================================================================

  describe('Dispose', () => {
    test('should clear interceptors and reset state', () => {
      client.addRequestInterceptor((c) => c);
      client.addResponseInterceptor((r) => r);

      client.dispose();

      expect(client.requestInterceptors).toHaveLength(0);
      expect(client.responseInterceptors).toHaveLength(0);
    });

    test('should reset circuit breaker on dispose', () => {
      const cbClient = new ApiClient({
        baseURL: 'http://localhost:8765',
        circuitBreaker: true,
      });

      cbClient.dispose();

      const state = cbClient.getCircuitBreakerState();
      expect(state.state).toBe('CLOSED');
      expect(state.failureCount).toBe(0);
    });
  });

  // ==========================================================================
  // HTTP Methods
  // ==========================================================================

  describe('HTTP Methods', () => {
    test('PUT should send body', async () => {
      global.fetch = jest.fn(() => createFetchResponse({ updated: true }));

      const result = await client.put('/resource/1', { name: 'updated' });

      expect(result).toEqual({ updated: true });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('PATCH should send body', async () => {
      global.fetch = jest.fn(() => createFetchResponse({ patched: true }));

      const result = await client.patch('/resource/1', { field: 'value' });

      expect(result).toEqual({ patched: true });
    });

    test('DELETE should work without body', async () => {
      global.fetch = jest.fn(() => createFetchResponse({ deleted: true }));

      const result = await client.delete('/resource/1');

      expect(result).toEqual({ deleted: true });
    });
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  describe('Error Types', () => {
    test('ApiError should have status, body, and url', async () => {
      global.fetch = jest.fn(() => Promise.resolve({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        headers: {
          get: (name) => {
            if (name.toLowerCase() === 'content-type') return 'application/json';
            return null;
          },
        },
        text: async () => JSON.stringify({ detail: 'validation failed' }),
      }));

      const noRetryClient = new ApiClient({
        baseURL: 'http://localhost:8765',
        retries: 0,
      });

      try {
        await noRetryClient.get('/validate');
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect(error.status).toBe(422);
        expect(error.body).toEqual({ detail: 'validation failed' });
        expect(error.url).toBe('http://localhost:8765/validate');
        expect(error.isApiError).toBe(true);
      }
    });

    test('TimeoutError should have url', async () => {
      const err = new TimeoutError('timeout', 'http://example.com');
      expect(err.name).toBe('TimeoutError');
      expect(err.url).toBe('http://example.com');
      expect(err.isTimeoutError).toBe(true);
    });

    test('CircuitBreakerError should be identifiable', () => {
      const err = new CircuitBreakerError('open');
      expect(err.name).toBe('CircuitBreakerError');
      expect(err.isCircuitBreakerError).toBe(true);
    });
  });

  // ==========================================================================
  // Retry Behavior
  // ==========================================================================

  describe('Retry Behavior (Extended)', () => {
    test('should not retry POST by default', async () => {
      global.fetch = jest.fn(() => Promise.reject(new Error('Network error')));

      await expect(client.post('/test', { data: 1 })).rejects.toThrow();

      // POST is not idempotent — only 1 attempt
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('should retry POST when allowRetry is explicitly true', async () => {
      let callCount = 0;
      global.fetch = jest.fn(() => {
        callCount++;
        if (callCount < 2) return Promise.reject(new Error('Network error'));
        return createFetchResponse({ success: true });
      });

      const result = await client.post('/test', { data: 1 }, { allowRetry: true });

      expect(callCount).toBe(2);
      expect(result).toEqual({ success: true });
    });

    test('should retry on retryable status codes', async () => {
      let callCount = 0;
      global.fetch = jest.fn(() => {
        callCount++;
        if (callCount < 2) {
          return Promise.resolve({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            headers: { get: (name) => {
              if (name.toLowerCase() === 'content-type') return 'application/json';
              return null;
            }},
            text: async () => JSON.stringify({ error: 'unavailable' }),
          });
        }
        return createFetchResponse({ success: true });
      });

      const result = await client.get('/test');

      expect(callCount).toBe(2);
      expect(result).toEqual({ success: true });
    });
  });

  // ==========================================================================
  // Backend Availability Gate
  // ==========================================================================

  describe('Backend Availability Gate', () => {
    test('should default _backendAvailable to true', () => {
      expect(client.isBackendAvailable()).toBe(true);
    });

    test('setBackendAvailable(false) should set flag to false', () => {
      client.setBackendAvailable(false);
      expect(client.isBackendAvailable()).toBe(false);
    });

    test('setBackendAvailable(true) should restore flag to true', () => {
      client.setBackendAvailable(false);
      client.setBackendAvailable(true);
      expect(client.isBackendAvailable()).toBe(true);
    });

    test('request() should reject with BackendUnavailableError when backend unavailable', async () => {
      global.fetch = jest.fn(() => createFetchResponse({ success: true }));
      client.setBackendAvailable(false);

      await expect(client.request('GET', '/test')).rejects.toThrow(BackendUnavailableError);
      // No fetch call should have been made
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('BackendUnavailableError should have correct properties', async () => {
      client.setBackendAvailable(false);

      try {
        await client.request('GET', '/v1/health');
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BackendUnavailableError);
        expect(error.name).toBe('BackendUnavailableError');
        expect(error.isBackendUnavailableError).toBe(true);
        expect(error.url).toBe('http://localhost:8765/v1/health');
        expect(error.message).toContain('Backend unavailable');
      }
    });

    test('get() should suppress error logging for BackendUnavailableError', async () => {
      const loggingClient = new ApiClient({
        baseURL: 'http://localhost:8765',
        enableLogging: true,
      });
      loggingClient.setBackendAvailable(false);

      const logSpy = jest.spyOn(loggingClient.log, 'error');

      await expect(loggingClient.get('/test')).rejects.toThrow(BackendUnavailableError);
      expect(logSpy).not.toHaveBeenCalled();
    });

    test('post() should suppress error logging for BackendUnavailableError', async () => {
      const loggingClient = new ApiClient({
        baseURL: 'http://localhost:8765',
        enableLogging: true,
      });
      loggingClient.setBackendAvailable(false);

      const logSpy = jest.spyOn(loggingClient.log, 'error');

      await expect(loggingClient.post('/test', { data: 1 })).rejects.toThrow(BackendUnavailableError);
      expect(logSpy).not.toHaveBeenCalled();
    });

    test('should not bypass rate limiter or circuit breaker when backend unavailable', async () => {
      // The gate fires BEFORE rate limiter and circuit breaker
      global.fetch = jest.fn(() => createFetchResponse({ success: true }));
      client.setBackendAvailable(false);

      await expect(client.get('/test')).rejects.toThrow(BackendUnavailableError);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('should resume normal operation after setBackendAvailable(true)', async () => {
      global.fetch = jest.fn(() => createFetchResponse({ restored: true }));

      client.setBackendAvailable(false);
      await expect(client.get('/test')).rejects.toThrow(BackendUnavailableError);

      client.setBackendAvailable(true);
      const result = await client.get('/test');

      expect(result).toEqual({ restored: true });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('BackendUnavailableError should be exported from module', () => {
      expect(BackendUnavailableError).toBeDefined();
      expect(typeof BackendUnavailableError).toBe('function');
    });

    test('constructor should accept backendAvailable: false', () => {
      const c = new ApiClient({ baseURL: 'http://localhost:8765', backendAvailable: false });
      expect(c.isBackendAvailable()).toBe(false);
    });

    test('constructor should default backendAvailable to true when omitted', () => {
      const c = new ApiClient({ baseURL: 'http://localhost:8765' });
      expect(c.isBackendAvailable()).toBe(true);
    });

    test('constructor backendAvailable: false should cause immediate rejection', async () => {
      const c = new ApiClient({ baseURL: 'http://localhost:8765', backendAvailable: false });
      await expect(c.get('/test')).rejects.toThrow(BackendUnavailableError);
    });
  });
});
