# Communication Layer

Production-ready communication infrastructure with retry, circuit breaker, rate limiting, and security features.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                       Endpoint                          │
│        (Unified Communication Interface)                │
├─────────────────────────┬───────────────────────────────┤
│   GuruConnection        │        ApiClient              │
│   (WebSocket)           │        (HTTP)                 │
├─────────────────────────┼───────────────────────────────┤
│ • Auto-reconnect        │ • Retry with backoff          │
│ • Ping/pong keepalive   │ • Circuit breaker             │
│ • Message queueing      │ • Rate limiting               │
│ • Health check          │ • Request/response hooks      │
│ • State management      │ • Timeout handling            │
└─────────────────────────┴───────────────────────────────┘
```

## Components

### GuruConnection (WebSocket)

Production WebSocket client with resilience features.

**Features:**
- Automatic reconnection with exponential backoff
- Ping/pong heartbeat for connection health monitoring
- Message queueing during disconnection
- Health check polling when backend is unavailable
- Event-driven architecture (EventEmitter)
- Proper cleanup and disposal

**Usage:**

```javascript
const GuruConnection = require('./GuruConnection');

const connection = new GuruConnection({
  url: 'ws://localhost:8000/ws',
  reconnectDelay: 2000,         // Base reconnect delay (ms)
  pingInterval: 30000,          // Ping interval (ms)
  healthInterval: 5000,         // Health check interval (ms)
  maxReconnectAttempts: Infinity,
  enableLogging: false
});

// Events
connection.on('open', () => console.log('Connected'));
connection.on('close', (event) => console.log('Closed', event.code));
connection.on('message', (data) => console.log('Message:', data));
connection.on('statusChange', (status) => console.log('Status:', status));

// Send message
connection.send({ type: 'message', content: 'Hello' });

// Send audio (binary)
connection.streamAudio(audioArrayBuffer);

// Statistics
const stats = connection.getStats();
console.log('Connected:', stats.connected);
console.log('Reconnect attempts:', stats.reconnectAttempts);
console.log('Queued messages:', stats.queuedMessages);

// Cleanup
connection.dispose();
```

**Connection States:**
- `idle` - Connected but no activity
- `listening` - Receiving audio input
- `thinking` - Processing request
- `speaking` - Generating/streaming response
- `waiting` - Disconnected, attempting reconnection
- `error` - Error state

**Reconnection Strategy:**
- Exponential backoff: `min(30s, delay * 2^(attempts-1))`
- Health check polling when backend is down
- Automatic retry on abnormal close (code !== 1000)
- Queue flushing on successful reconnection

### ApiClient (HTTP)

Production HTTP client with retry, circuit breaker, and rate limiting.

**Features:**
- Automatic retries with exponential backoff
- Circuit breaker to prevent cascade failures
- Client-side rate limiting
- Request/response interceptors
- Timeout handling with AbortSignal
- Type-safe error handling

**Usage:**

```javascript
const { ApiClient } = require('./ApiClient');

const client = new ApiClient({
  baseURL: 'http://localhost:8000',
  timeout: 12000,
  retries: 2,
  retryDelay: 500,
  retryStatusCodes: [408, 429, 500, 502, 503, 504],
  circuitBreaker: true,
  circuitBreakerOptions: {
    threshold: 5,              // Failures before opening
    timeout: 60000,            // Time before half-open (ms)
    volumeThreshold: 10        // Min requests before checking
  },
  rateLimiter: true,
  rateLimiterOptions: {
    limits: {
      api: {
        tokensPerSecond: 20,
        burstCapacity: 30
      }
    }
  },
  enableLogging: false
});

// Make requests
const data = await client.get('/api/users');
const created = await client.post('/api/users', { name: 'John' });
const updated = await client.put('/api/users/1', { name: 'Jane' });
await client.delete('/api/users/1');

// Add interceptors
client.addRequestInterceptor((config) => {
  config.headers['Authorization'] = 'Bearer token';
  return config;
});

client.addResponseInterceptor((response) => {
  return response.data;
});

// Circuit breaker control
const cbState = client.getCircuitBreakerState();
console.log('Circuit breaker state:', cbState.state); // CLOSED | OPEN | HALF_OPEN
client.resetCircuitBreaker();

// Rate limiter statistics
const rlStats = client.getRateLimiterStats();
console.log('Rate limited:', rlStats.rateLimited);
console.log('Total requests:', rlStats.totalRequests);
```

**Retry Strategy:**
- Retry on: timeouts, network errors, 408, 429, 500, 502, 503, 504
- Don't retry: 4xx (except 408, 429), successful responses
- Exponential backoff with jitter: `min(30s, delay * 2^(attempt-1) + jitter)`
- Max retries configurable per request

**Circuit Breaker:**
- `CLOSED` - Normal operation
- `OPEN` - Too many failures, reject all requests
- `HALF_OPEN` - Testing if backend recovered

**Rate Limiting:**
- Token bucket algorithm
- Per-endpoint tracking
- Configurable categories (api, heavy, streaming, control)
- Burst capacity support

### Endpoint (Unified Layer)

Single entry point for all communication.

**Features:**
- WebSocket via GuruConnection
- HTTP via ApiClient
- Unified statistics
- Proper disposal

**Usage:**

```javascript
const Endpoint = require('./Endpoint');

const endpoint = new Endpoint({
  WS_URL: 'ws://localhost:8000/ws',
  API_BASE_URL: 'http://localhost:8000',
  NODE_ENV: 'production'
});

// WebSocket methods
const requestId = endpoint.sendUserMessage('Hello', 'req-123');
endpoint.sendUserMessageWithImage('Text', base64Image, 'req-124');
endpoint.streamAudio(audioArrayBuffer);

endpoint.on('message', (data) => console.log(data));
endpoint.on('statusChange', (status) => console.log(status));

// HTTP methods
const health = await endpoint.getHealth();
const settings = await endpoint.getSettings();
await endpoint.setSettings({ theme: 'dark' });
const models = await endpoint.getModels();
await endpoint.stopGeneration();

// Statistics
const stats = endpoint.getStats();
console.log('WebSocket:', stats.websocket);
console.log('HTTP:', stats.http);

// Cleanup
endpoint.dispose();
```

## Error Handling

### ApiClient Errors

```javascript
const { ApiError, TimeoutError, CircuitBreakerError } = require('./ApiClient');

try {
  await client.get('/api/users');
} catch (error) {
  if (error.isApiError) {
    console.error('API Error:', error.status, error.body);
  } else if (error.isTimeoutError) {
    console.error('Timeout:', error.url);
  } else if (error.isCircuitBreakerError) {
    console.error('Circuit breaker open');
  }
}
```

### GuruConnection Events

```javascript
connection.on('error', (error) => {
  console.error('WebSocket error:', error);
});

connection.on('close', (event) => {
  if (event.code !== 1000) {
    console.warn('Abnormal close:', event.code, event.reason);
  }
});

connection.on('max_reconnect_attempts', () => {
  console.error('Max reconnection attempts reached');
});
```

## Security Integration

### Rate Limiting

```javascript
const { RateLimitError } = require('../security/RateLimiter');

try {
  await client.get('/api/heavy-operation', { rateCategory: 'heavy' });
} catch (error) {
  if (error.isRateLimitError) {
    console.warn('Rate limited, retry after:', error.retryAfter, 'ms');
  }
}
```

### Request Validation

```javascript
const { InputValidator } = require('../security/InputValidator');

const validator = new InputValidator();

// Validate before sending
try {
  validator.validateString(userInput, {
    maxLength: 10000,
    noXss: true,
    noSqlInjection: true
  });
  
  await client.post('/api/message', { content: userInput });
} catch (error) {
  console.error('Validation failed:', error.message);
}
```

## Testing

Comprehensive integration tests in `tests/integration/communication.test.js`:

```bash
npm test -- communication.test.js
```

**Test Coverage:**
- Basic requests (GET, POST, PUT, DELETE)
- Retry logic (timeouts, status codes)
- Circuit breaker (open, half-open, closed states)
- Rate limiting (burst, categories)
- WebSocket reconnection
- Message queueing
- Backend failure simulation
- Statistics tracking

## Configuration

### Production

```javascript
const endpoint = new Endpoint({
  WS_URL: process.env.WS_URL || 'wss://api.example.com/ws',
  API_BASE_URL: process.env.API_BASE_URL || 'https://api.example.com',
  NODE_ENV: 'production'
});

// More aggressive circuit breaker
endpoint.api.circuitBreaker.threshold = 3;
endpoint.api.circuitBreaker.timeout = 30000;

// Stricter rate limiting
endpoint.api.rateLimiter.limits.api.tokensPerSecond = 10;
```

### Development

```javascript
const endpoint = new Endpoint({
  WS_URL: 'ws://localhost:8000/ws',
  API_BASE_URL: 'http://localhost:8000',
  NODE_ENV: 'development'
});

// More permissive settings
endpoint.connection.enableLogging = true;
endpoint.api.enableLogging = true;
endpoint.api.circuitBreaker.threshold = 10;
```

## Performance

**Memory:**
- GuruConnection: ~50KB per instance
- ApiClient: ~30KB per instance
- Message queue: ~1KB per queued message

**CPU:**
- Ping timer: ~0.1% CPU (30s interval)
- Health check: ~0.1% CPU (5s interval when down)
- Token bucket refill: O(1) per request

**Network:**
- Ping size: ~50 bytes every 30s
- Health check: ~100 bytes every 5s (when down)
- Overhead per request: ~200 bytes (headers)

## Best Practices

1. **Always dispose connections:**
   ```javascript
   endpoint.dispose();
   ```

2. **Handle errors gracefully:**
   ```javascript
   endpoint.on('error', handleError);
   ```

3. **Use rate limit categories:**
   ```javascript
   await client.post('/api/upload', data, { rateCategory: 'heavy' });
   ```

4. **Monitor statistics:**
   ```javascript
   setInterval(() => {
     const stats = endpoint.getStats();
     console.log('Connection health:', stats);
   }, 60000);
   ```

5. **Test failure scenarios:**
   - Simulate network down
   - Test reconnection
   - Verify circuit breaker
   - Check rate limiting

## Troubleshooting

### WebSocket won't connect

```javascript
// Check URL
console.log('WS URL:', connection.url);

// Check reconnection attempts
const stats = connection.getStats();
console.log('Reconnect attempts:', stats.reconnectAttempts);

// Check health check
connection._startHealthCheck();
```

### Circuit breaker stuck open

```javascript
// Check state
const state = client.getCircuitBreakerState();
console.log('State:', state.state);
console.log('Failures:', state.failureCount);
console.log('Next attempt:', new Date(state.nextAttempt));

// Force reset
client.resetCircuitBreaker();
```

### Rate limiting too aggressive

```javascript
// Check stats
const stats = client.getRateLimiterStats();
console.log('Rate limited:', stats.rateLimited);
console.log('By endpoint:', stats.byEndpoint);

// Adjust limits
client.rateLimiter.limits.api.tokensPerSecond = 50;
client.rateLimiter.limits.api.burstCapacity = 100;

// Or disable temporarily
client.rateLimiter.disable();
```

## Dependencies

- `events` (Node.js EventEmitter)
- `../security/RateLimiter` - Client-side rate limiting

**Optional:**
- DOMPurify (for content sanitization)
- jsdom (for Node.js testing)

## License

Internal use only.

