# Security Layer

Production-grade security infrastructure for frontend applications.

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                     Security Layer                        │
├──────────────┬──────────────┬──────────────┬──────────────┤
│ RateLimiter  │ CspManager   │ Sanitizer    │ InputValidator│
├──────────────┼──────────────┼──────────────┼──────────────┤
│ • Token      │ • Policy     │ • DOMPurify  │ • Type check │
│   bucket     │   management │   wrapper    │ • Length     │
│ • Per-       │ • Nonce gen  │ • Profiles   │ • Pattern    │
│   endpoint   │ • Violation  │ • URL valid  │ • XSS        │
│ • Burst      │   reporting  │ • Fallback   │ • SQL inj    │
│ • Stats      │ • Meta tags  │ • Stats      │ • Cmd inj    │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

## Components

### RateLimiter

Client-side rate limiting using token bucket algorithm.

**Features:**
- Per-endpoint rate limiting
- Configurable categories (api, heavy, streaming, control)
- Burst capacity
- Statistics tracking
- Enable/disable functionality

**Usage:**

```javascript
const { RateLimiter } = require('./RateLimiter');

const limiter = new RateLimiter({
  enabled: true,
  limits: {
    api: {
      tokensPerSecond: 20,
      burstCapacity: 30
    },
    heavy: {
      tokensPerSecond: 5,
      burstCapacity: 10
    }
  }
});

// Check rate limit (throws RateLimitError if exceeded)
try {
  limiter.check('/api/users', { category: 'api' });
  // Proceed with request
} catch (error) {
  if (error.isRateLimitError) {
    console.warn('Rate limited, retry after:', error.retryAfter, 'ms');
  }
}

// Try without throwing
const result = limiter.tryConsume('/api/upload', { category: 'heavy' });
if (!result.allowed) {
  console.warn('Rate limited, retry after:', result.retryAfter, 'ms');
}

// Get statistics
const stats = limiter.getStats();
console.log('Total requests:', stats.totalRequests);
console.log('Rate limited:', stats.rateLimited);
console.log('By endpoint:', stats.byEndpoint);
```

**Rate Limit Categories:**

| Category   | Tokens/Second | Burst Capacity | Use Case                |
|------------|---------------|----------------|-------------------------|
| streaming  | 100           | 150            | WebSocket messages      |
| api        | 20            | 30             | Normal API requests     |
| heavy      | 5             | 10             | File uploads, exports   |
| control    | 10            | 15             | Window/UI controls      |

### CspManager

Content Security Policy management for Electron renderers.

**Features:**
- Environment-specific policies (development vs production)
- Nonce generation for inline scripts
- CSP violation reporting
- Meta tag injection
- Policy validation

**Usage:**

```javascript
const { CspManager } = require('./CspManager');

const csp = new CspManager({
  environment: 'production',
  enabled: true,
  reportOnly: false,
  reportUri: '/api/csp-violations',
  directives: {
    'script-src': ["'self'", "'nonce-abc123'"],
    'connect-src': ["'self'", 'wss://api.example.com']
  }
});

// Generate nonce for inline scripts
const nonce = csp.generateNonce();
// <script nonce="abc123">...</script>

// Inject CSP meta tag
csp.injectMetaTag(document);

// Get policy
const policy = csp.buildPolicy();
console.log(policy);
// "default-src 'self'; script-src 'self' 'nonce-abc123'; ..."

// Get violations
const violations = csp.getViolations();
violations.forEach(v => {
  console.error('CSP violation:', v.blockedUri, v.effectiveDirective);
});

// Validate policy
const validation = csp.validate();
if (!validation.valid) {
  console.error('CSP errors:', validation.errors);
}
```

**Default Policies:**

**Production:**
```
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self' ws: wss:;
media-src 'self' blob:;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
```

**Development:**
```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: http: https:;
connect-src 'self' ws: wss: http: https:;
...
```

### Sanitizer

HTML sanitization using DOMPurify.

**Features:**
- Multiple sanitization profiles
- XSS prevention
- URL validation
- Custom hooks
- Fallback to HTML escaping
- Statistics tracking

**Usage:**

```javascript
const { Sanitizer } = require('./Sanitizer');

const sanitizer = new Sanitizer({
  defaultProfile: 'default'
});

// Sanitize HTML
const clean = sanitizer.sanitizeHTML('<p onclick="alert()">Test</p>', {
  profile: 'default'
});
// Result: <p>Test</p>

// Strict mode (text only)
const text = sanitizer.sanitizeHTML('<b>Bold</b>', {
  profile: 'strict'
});
// Result: Bold

// Permissive mode (rich content)
const rich = sanitizer.sanitizeHTML('<div data-id="1">Content</div>', {
  profile: 'permissive'
});
// Result: <div data-id="1">Content</div>

// Sanitize URL
const safeUrl = sanitizer.sanitizeURL('https://example.com');
const dangerousUrl = sanitizer.sanitizeURL('javascript:alert()');
// Result: null (blocked)

// Strip all HTML
const plainText = sanitizer.stripHTML('<p>Hello <b>world</b></p>');
// Result: Hello world

// Check if HTML is safe
const isSafe = sanitizer.isSafe('<p>Safe content</p>');
console.log(isSafe); // true

// Custom hooks
const custom = sanitizer.sanitizeHTML(html, {
  beforeSanitize: (node) => {
    // Transform node before sanitization
  },
  afterSanitize: (node) => {
    // Transform node after sanitization
  }
});
```

**Sanitization Profiles:**

| Profile      | Allowed Tags                          | Use Case            |
|--------------|---------------------------------------|---------------------|
| strict       | None (text only)                      | User input          |
| default      | p, strong, em, a, img, code, ul, etc. | Chat messages       |
| permissive   | +div, section, article, data-*, etc.  | Rich content        |

### InputValidator

Comprehensive input validation.

**Features:**
- Type validation
- Length constraints
- Pattern matching
- XSS detection
- SQL injection detection
- Command injection detection
- Prototype pollution prevention
- Object depth limiting

**Usage:**

```javascript
const { InputValidator } = require('./InputValidator');

const validator = new InputValidator({
  maxStringLength: 10000,
  maxArrayLength: 1000,
  maxObjectDepth: 10
});

// Validate string
try {
  validator.validateString(userInput, {
    minLength: 1,
    maxLength: 1000,
    noXss: true,
    noSqlInjection: true,
    noCommandInjection: true
  });
} catch (error) {
  console.error('Validation failed:', error.message);
}

// Validate number
validator.validateNumber(age, {
  min: 0,
  max: 150,
  integer: true,
  positive: true
});

// Validate email
validator.validateEmail('user@example.com');

// Validate URL
validator.validateURL('https://example.com', {
  protocols: ['https:'] // Only HTTPS allowed
});

// Validate object with schema
validator.validateObject(data, {
  required: ['name', 'email'],
  fields: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 100
    },
    email: {
      type: 'email'
    },
    age: {
      type: 'number',
      min: 0,
      max: 150,
      integer: true
    }
  }
});

// Validate array
validator.validateArray(items, {
  minLength: 1,
  maxLength: 100,
  elementSchema: {
    type: 'string',
    maxLength: 50
  }
});

// Get statistics
const stats = validator.getStats();
console.log('Total validations:', stats.totalValidations);
console.log('Failures:', stats.failures);
console.log('By type:', stats.byType);
```

**Security Checks:**

- **XSS**: Detects `<script>`, `javascript:`, `onerror=`, `eval()`, etc.
- **SQL Injection**: Detects `SELECT`, `INSERT`, `--`, `/*`, `'`, etc.
- **Command Injection**: Detects `;`, `|`, `$()`, backticks, etc.
- **Prototype Pollution**: Blocks `__proto__`, `constructor`, `prototype`

## Integration Examples

### With ApiClient

```javascript
const { ApiClient } = require('../communication/ApiClient');
const { InputValidator } = require('./InputValidator');

const client = new ApiClient({ ... });
const validator = new InputValidator();

// Validate before sending
try {
  validator.validateObject(data, {
    required: ['message'],
    fields: {
      message: {
        type: 'string',
        maxLength: 10000,
        noXss: true
      }
    }
  });
  
  await client.post('/api/messages', data);
} catch (error) {
  console.error('Validation failed:', error.message);
}
```

### With Chat Messages

```javascript
const { Sanitizer } = require('./Sanitizer');
const { InputValidator } = require('./InputValidator');

const sanitizer = new Sanitizer();
const validator = new InputValidator();

function processUserMessage(content) {
  // 1. Validate
  validator.validateString(content, {
    maxLength: 10000,
    noXss: true,
    noSqlInjection: true
  });
  
  // 2. Sanitize
  const clean = sanitizer.sanitizeHTML(content, {
    profile: 'default'
  });
  
  // 3. Send
  return clean;
}
```

### With Content Security Policy

```javascript
const { CspManager } = require('./CspManager');

const csp = new CspManager({
  environment: process.env.NODE_ENV,
  reportUri: '/api/csp-violations'
});

// Inject CSP on page load
document.addEventListener('DOMContentLoaded', () => {
  csp.injectMetaTag();
});

// Monitor violations
setInterval(() => {
  const violations = csp.getViolations();
  if (violations.length > 0) {
    console.warn('CSP violations detected:', violations.length);
  }
}, 60000);
```

## Error Handling

```javascript
const {
  RateLimitError,
  ValidationError
} = require('./index');

try {
  limiter.check('/api/users');
} catch (error) {
  if (error.isRateLimitError) {
    // Wait and retry
    setTimeout(() => retry(), error.retryAfter);
  }
}

try {
  validator.validateString(input);
} catch (error) {
  if (error.isValidationError) {
    console.error('Field:', error.field);
    console.error('Rule:', error.rule);
  }
}
```

## Testing

```javascript
const { RateLimiter, InputValidator, Sanitizer } = require('./index');

describe('Security Layer', () => {
  test('rate limiter enforces limits', () => {
    const limiter = new RateLimiter({
      limits: {
        api: { tokensPerSecond: 2, burstCapacity: 3 }
      }
    });
    
    limiter.check('/test'); // OK
    limiter.check('/test'); // OK
    limiter.check('/test'); // OK
    
    expect(() => limiter.check('/test')).toThrow(RateLimitError);
  });
  
  test('validator detects XSS', () => {
    const validator = new InputValidator();
    
    expect(() => {
      validator.validateString('<script>alert()</script>', {
        noXss: true
      });
    }).toThrow(ValidationError);
  });
  
  test('sanitizer removes dangerous content', () => {
    const sanitizer = new Sanitizer();
    
    const clean = sanitizer.sanitizeHTML('<script>alert()</script>');
    expect(clean).not.toContain('<script>');
  });
});
```

## Best Practices

1. **Always validate user input:**
   ```javascript
   validator.validateString(userInput, {
     noXss: true,
     noSqlInjection: true,
     maxLength: 10000
   });
   ```

2. **Sanitize HTML before rendering:**
   ```javascript
   const clean = sanitizer.sanitizeHTML(content, {
     profile: 'default'
   });
   element.innerHTML = clean;
   ```

3. **Enforce rate limits:**
   ```javascript
   limiter.check(endpoint, { category: 'api' });
   ```

4. **Use strict CSP in production:**
   ```javascript
   const csp = new CspManager({
     environment: 'production',
     reportUri: '/api/csp-violations'
   });
   ```

5. **Monitor security statistics:**
   ```javascript
   setInterval(() => {
     console.log('Rate limiter:', limiter.getStats());
     console.log('Validator:', validator.getStats());
     console.log('Sanitizer:', sanitizer.getStats());
   }, 300000); // Every 5 minutes
   ```

## Performance

**Memory:**
- RateLimiter: ~10KB + ~1KB per endpoint
- CspManager: ~5KB + violations
- Sanitizer: ~20KB (DOMPurify)
- InputValidator: ~8KB

**CPU:**
- Token bucket refill: O(1) per check
- Validation: O(n) where n = input length
- Sanitization: O(n) where n = HTML length
- CSP policy build: O(m) where m = directive count

## Troubleshooting

### Rate limiting too aggressive

```javascript
// Increase limits
limiter.limits.api.tokensPerSecond = 50;
limiter.limits.api.burstCapacity = 100;

// Or disable temporarily
limiter.disable();
```

### CSP violations

```javascript
// Check violations
const violations = csp.getViolations();
violations.forEach(v => {
  console.error('Blocked:', v.blockedUri);
  console.error('Directive:', v.effectiveDirective);
});

// Switch to report-only mode
csp.setReportOnly(true);
```

### Sanitizer too strict

```javascript
// Use permissive profile
const clean = sanitizer.sanitizeHTML(content, {
  profile: 'permissive'
});

// Or customize allowed tags
const clean = sanitizer.sanitizeHTML(content, {
  config: {
    ALLOWED_TAGS: ['p', 'b', 'i', 'u', 'custom-tag'],
    ALLOWED_ATTR: ['class', 'data-custom']
  }
});
```

## Dependencies

- `dompurify` (optional, for Sanitizer)
- `jsdom` (optional, for Node.js testing)

## License

Internal use only.

