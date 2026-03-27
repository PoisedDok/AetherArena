'use strict';

const { buildFileCspPolicy, injectCspMeta } = require('../../../src/preload/common/csp-injector');

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse a CSP policy string into a Map of directive-name -> values[].
 * E.g. "default-src 'self'; script-src 'self'" -> Map { 'default-src' => ["'self'"], ... }
 */
function parseCsp(policyString) {
  const directives = new Map();
  for (const part of policyString.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [directive, ...values] = trimmed.split(/\s+/);
    directives.set(directive, values);
  }
  return directives;
}

// ============================================================================
// buildFileCspPolicy
// ============================================================================
describe('buildFileCspPolicy', () => {

  // --------------------------------------------------------------------------
  // Return type and format
  // --------------------------------------------------------------------------
  describe('return format', () => {
    it('returns a non-empty string', () => {
      const result = buildFileCspPolicy();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('directives are separated by "; "', () => {
      const result = buildFileCspPolicy();
      const parts = result.split('; ');
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(part).toMatch(/^[a-z-]+ /);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Directive structure with default (empty) config
  // --------------------------------------------------------------------------
  describe('directive structure with default config', () => {
    let directives;

    beforeEach(() => {
      directives = parseCsp(buildFileCspPolicy());
    });

    it('contains all 12 expected directives', () => {
      const expected = [
        'default-src', 'script-src', 'style-src', 'img-src', 'font-src',
        'connect-src', 'media-src', 'object-src', 'base-uri', 'form-action',
        'frame-src', 'worker-src',
      ];
      for (const d of expected) {
        expect(directives.has(d)).toBe(true);
      }
      expect(directives.size).toBe(expected.length);
    });

    it('default-src is self only', () => {
      expect(directives.get('default-src')).toEqual(["'self'"]);
    });

    it('script-src is self only — no unsafe-eval, no unsafe-inline', () => {
      const values = directives.get('script-src');
      expect(values).toEqual(["'self'"]);
      expect(values).not.toContain("'unsafe-eval'");
      expect(values).not.toContain("'unsafe-inline'");
    });

    it('style-src allows unsafe-inline (required for inline styles)', () => {
      expect(directives.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    });

    it('img-src allows self, data:, blob:', () => {
      expect(directives.get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
    });

    it('font-src allows self and data:', () => {
      expect(directives.get('font-src')).toEqual(["'self'", 'data:']);
    });

    it('connect-src has self, ws:, wss: only (no backend origins)', () => {
      expect(directives.get('connect-src')).toEqual(["'self'", 'ws:', 'wss:']);
    });

    it('media-src allows self and blob:', () => {
      expect(directives.get('media-src')).toEqual(["'self'", 'blob:']);
    });

    it('object-src is none', () => {
      expect(directives.get('object-src')).toEqual(["'none'"]);
    });

    it('base-uri is self', () => {
      expect(directives.get('base-uri')).toEqual(["'self'"]);
    });

    it('form-action is self', () => {
      expect(directives.get('form-action')).toEqual(["'self'"]);
    });

    it('frame-src allows self, blob:, data:, localhost/127.0.0.1 wildcard ports, app:, aether:, file:', () => {
      expect(directives.get('frame-src')).toEqual([
        "'self'", 'blob:', 'data:', 'http://localhost:*', 'http://127.0.0.1:*', 'app:', 'aether:', 'file:',
      ]);
    });

    it('worker-src allows self and blob:', () => {
      expect(directives.get('worker-src')).toEqual(["'self'", 'blob:']);
    });

    it('does NOT include frame-ancestors (ignored via meta in Chromium)', () => {
      expect(directives.has('frame-ancestors')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Config edge cases (empty / null / missing)
  // --------------------------------------------------------------------------
  describe('config edge cases', () => {
    it('handles undefined config (default parameter)', () => {
      expect(() => buildFileCspPolicy(undefined)).not.toThrow();
      const d = parseCsp(buildFileCspPolicy(undefined));
      expect(d.get('connect-src')).toEqual(["'self'", 'ws:', 'wss:']);
    });

    it('handles empty object', () => {
      expect(() => buildFileCspPolicy({})).not.toThrow();
      const d = parseCsp(buildFileCspPolicy({}));
      expect(d.get('connect-src')).toEqual(["'self'", 'ws:', 'wss:']);
    });

    it('handles null backend property', () => {
      expect(() => buildFileCspPolicy({ backend: null })).not.toThrow();
    });

    it('handles backend object with no URL properties', () => {
      expect(() => buildFileCspPolicy({ backend: {} })).not.toThrow();
    });

    it('handles backend.baseUrl = null', () => {
      expect(() => buildFileCspPolicy({ backend: { baseUrl: null } })).not.toThrow();
    });

    it('handles backend.baseUrl = empty string (falsy)', () => {
      expect(() => buildFileCspPolicy({ backend: { baseUrl: '' } })).not.toThrow();
      const d = parseCsp(buildFileCspPolicy({ backend: { baseUrl: '' } }));
      expect(d.get('connect-src')).toEqual(["'self'", 'ws:', 'wss:']);
    });

    it('handles backend.baseUrl = number (non-string, type guard)', () => {
      expect(() => buildFileCspPolicy({ backend: { baseUrl: 123 } })).not.toThrow();
      const d = parseCsp(buildFileCspPolicy({ backend: { baseUrl: 123 } }));
      expect(d.get('connect-src')).toEqual(["'self'", 'ws:', 'wss:']);
    });

    it('handles backend.wsUrl = undefined', () => {
      expect(() => buildFileCspPolicy({ backend: { wsUrl: undefined } })).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Backend baseUrl — origin extraction and loopback aliases
  // --------------------------------------------------------------------------
  describe('backend baseUrl', () => {
    it('extracts origin and includes in connect-src', () => {
      const d = parseCsp(buildFileCspPolicy({
        backend: { baseUrl: 'http://127.0.0.1:7090/v1' },
      }));
      expect(d.get('connect-src')).toContain('http://127.0.0.1:7090');
    });

    it('strips path from URL — only origin appears in policy', () => {
      const result = buildFileCspPolicy({
        backend: { baseUrl: 'http://127.0.0.1:7090/v1/some/deep/path' },
      });
      const connectSrc = parseCsp(result).get('connect-src');
      expect(connectSrc).toContain('http://127.0.0.1:7090');
      expect(connectSrc.some(v => v.includes('/v1'))).toBe(false);
    });

    it('loopback 127.0.0.1 adds localhost and [::1] aliases', () => {
      const connectSrc = parseCsp(buildFileCspPolicy({
        backend: { baseUrl: 'http://127.0.0.1:7090/v1' },
      })).get('connect-src');
      expect(connectSrc).toContain('http://127.0.0.1:7090');
      expect(connectSrc).toContain('http://localhost:7090');
      expect(connectSrc).toContain('http://[::1]:7090');
    });

    it('loopback localhost adds 127.0.0.1 and [::1] aliases', () => {
      const connectSrc = parseCsp(buildFileCspPolicy({
        backend: { baseUrl: 'http://localhost:7090/v1' },
      })).get('connect-src');
      expect(connectSrc).toContain('http://127.0.0.1:7090');
      expect(connectSrc).toContain('http://localhost:7090');
      expect(connectSrc).toContain('http://[::1]:7090');
    });

    it('loopback [::1] adds 127.0.0.1 and localhost aliases', () => {
      const connectSrc = parseCsp(buildFileCspPolicy({
        backend: { baseUrl: 'http://[::1]:7090/v1' },
      })).get('connect-src');
      expect(connectSrc).toContain('http://127.0.0.1:7090');
      expect(connectSrc).toContain('http://localhost:7090');
      expect(connectSrc).toContain('http://[::1]:7090');
    });

    it('preserves port in all loopback aliases', () => {
      const connectSrc = parseCsp(buildFileCspPolicy({
        backend: { baseUrl: 'http://127.0.0.1:9999' },
      })).get('connect-src');
      for (const alias of ['http://127.0.0.1:9999', 'http://localhost:9999', 'http://[::1]:9999']) {
        expect(connectSrc).toContain(alias);
      }
    });

    it('non-loopback URL gets no aliases — only its own origin', () => {
      const connectSrc = parseCsp(buildFileCspPolicy({
        backend: { baseUrl: 'https://api.example.com:8080/v1' },
      })).get('connect-src');
      expect(connectSrc).toContain('https://api.example.com:8080');
      expect(connectSrc.filter(v => v.includes('localhost')).length).toBe(0);
      expect(connectSrc.filter(v => v.includes('127.0.0.1')).length).toBe(0);
      expect(connectSrc.filter(v => v.includes('[::1]')).length).toBe(0);
    });

    it('URL without explicit port: aliases have no port suffix', () => {
      const connectSrc = parseCsp(buildFileCspPolicy({
        backend: { baseUrl: 'http://localhost/v1' },
      })).get('connect-src');
      expect(connectSrc).toContain('http://localhost');
      expect(connectSrc).toContain('http://127.0.0.1');
      expect(connectSrc).toContain('http://[::1]');
    });
  });

  // --------------------------------------------------------------------------
  // Backend wsUrl
  // --------------------------------------------------------------------------
  describe('backend wsUrl', () => {
    it('ws:// URL origin extracted and included in connect-src', () => {
      const connectSrc = parseCsp(buildFileCspPolicy({
        backend: { wsUrl: 'ws://127.0.0.1:7091/ws' },
      })).get('connect-src');
      expect(connectSrc).toContain('ws://127.0.0.1:7091');
    });

    it('wss:// URL origin extracted and included', () => {
      const connectSrc = parseCsp(buildFileCspPolicy({
        backend: { wsUrl: 'wss://localhost:7091/ws' },
      })).get('connect-src');
      expect(connectSrc).toContain('wss://localhost:7091');
    });

    it('loopback aliases work for ws:// URLs', () => {
      const connectSrc = parseCsp(buildFileCspPolicy({
        backend: { wsUrl: 'ws://127.0.0.1:7091/ws' },
      })).get('connect-src');
      expect(connectSrc).toContain('ws://127.0.0.1:7091');
      expect(connectSrc).toContain('ws://localhost:7091');
      expect(connectSrc).toContain('ws://[::1]:7091');
    });
  });

  // --------------------------------------------------------------------------
  // Both baseUrl and wsUrl present
  // --------------------------------------------------------------------------
  describe('both baseUrl and wsUrl', () => {
    it('includes origins from both in connect-src', () => {
      const connectSrc = parseCsp(buildFileCspPolicy({
        backend: {
          baseUrl: 'http://127.0.0.1:7090/v1',
          wsUrl: 'ws://127.0.0.1:7091/ws',
        },
      })).get('connect-src');
      expect(connectSrc).toContain('http://127.0.0.1:7090');
      expect(connectSrc).toContain('http://localhost:7090');
      expect(connectSrc).toContain('ws://127.0.0.1:7091');
      expect(connectSrc).toContain('ws://localhost:7091');
    });

    it('deduplicates when both URLs resolve to same origin', () => {
      const connectSrc = parseCsp(buildFileCspPolicy({
        backend: {
          baseUrl: 'http://127.0.0.1:7090',
          wsUrl: 'http://127.0.0.1:7090/ws',
        },
      })).get('connect-src');
      const count = connectSrc.filter(v => v === 'http://127.0.0.1:7090').length;
      expect(count).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Fail-fast on invalid URLs (architectural: no fallbacks, no recovery)
  // --------------------------------------------------------------------------
  describe('fail-fast on invalid URLs', () => {
    it('throws TypeError on invalid baseUrl string', () => {
      expect(() => buildFileCspPolicy({
        backend: { baseUrl: 'not-a-valid-url' },
      })).toThrow();
    });

    it('throws TypeError on invalid wsUrl string', () => {
      expect(() => buildFileCspPolicy({
        backend: { wsUrl: ':::invalid' },
      })).toThrow();
    });

    it('does NOT throw when URLs are falsy (null/undefined/empty)', () => {
      expect(() => buildFileCspPolicy({ backend: { baseUrl: null } })).not.toThrow();
      expect(() => buildFileCspPolicy({ backend: { baseUrl: undefined } })).not.toThrow();
      expect(() => buildFileCspPolicy({ backend: { baseUrl: '' } })).not.toThrow();
      expect(() => buildFileCspPolicy({ backend: { wsUrl: null } })).not.toThrow();
      expect(() => buildFileCspPolicy({ backend: { wsUrl: undefined } })).not.toThrow();
      expect(() => buildFileCspPolicy({ backend: { wsUrl: '' } })).not.toThrow();
    });
  });
});

// ============================================================================
// injectCspMeta
// ============================================================================
describe('injectCspMeta', () => {

  // Ensure every test starts with a clean, valid DOM state.
  beforeEach(() => {
    // MutationObserver tests may have removed head; restore it.
    if (!document.head) {
      const head = document.createElement('head');
      if (document.documentElement.firstChild) {
        document.documentElement.insertBefore(head, document.documentElement.firstChild);
      } else {
        document.documentElement.appendChild(head);
      }
    }
    document.head.innerHTML = '';
    if (document.body) {
      document.body.innerHTML = '';
    }
  });

  // --------------------------------------------------------------------------
  // Parameter validation
  // --------------------------------------------------------------------------
  describe('parameter validation', () => {
    it('throws if getConfigSnapshot is not a function', () => {
      expect(() => injectCspMeta({ getConfigSnapshot: 'not-a-function' }))
        .toThrow('[csp-injector] getConfigSnapshot function is required');
    });

    it('throws if getConfigSnapshot is undefined', () => {
      expect(() => injectCspMeta({}))
        .toThrow('[csp-injector] getConfigSnapshot function is required');
    });

    it('throws if getConfigSnapshot is null', () => {
      expect(() => injectCspMeta({ getConfigSnapshot: null }))
        .toThrow('[csp-injector] getConfigSnapshot function is required');
    });

    it('throws with Error instance containing module name', () => {
      let caught;
      try {
        injectCspMeta({ getConfigSnapshot: 42 });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toBe('[csp-injector] getConfigSnapshot function is required');
    });
  });

  // --------------------------------------------------------------------------
  // Normal injection (head available immediately)
  // --------------------------------------------------------------------------
  describe('normal injection', () => {
    const mockConfig = { backend: { baseUrl: 'http://127.0.0.1:7090/v1' } };
    let getConfigSnapshot;

    beforeEach(() => {
      getConfigSnapshot = jest.fn(() => mockConfig);
    });

    it('injects a meta tag into document.head', () => {
      injectCspMeta({ getConfigSnapshot });
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      expect(meta).not.toBeNull();
      expect(meta.parentNode).toBe(document.head);
    });

    it('meta tag has http-equiv="Content-Security-Policy"', () => {
      injectCspMeta({ getConfigSnapshot });
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      expect(meta.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    });

    it('meta tag content matches buildFileCspPolicy output exactly', () => {
      injectCspMeta({ getConfigSnapshot });
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      const expected = buildFileCspPolicy(mockConfig);
      expect(meta.getAttribute('content')).toBe(expected);
    });

    it('calls getConfigSnapshot exactly once per injection', () => {
      injectCspMeta({ getConfigSnapshot });
      expect(getConfigSnapshot).toHaveBeenCalledTimes(1);
    });

    it('meta tag is inserted before existing head children', () => {
      const existingLink = document.createElement('link');
      existingLink.rel = 'stylesheet';
      document.head.appendChild(existingLink);

      injectCspMeta({ getConfigSnapshot });

      expect(document.head.firstChild.tagName).toBe('META');
      expect(document.head.firstChild.getAttribute('http-equiv')).toBe('Content-Security-Policy');
      expect(document.head.childNodes[1]).toBe(existingLink);
    });

    it('meta tag is appended when head is empty', () => {
      injectCspMeta({ getConfigSnapshot });
      expect(document.head.children.length).toBe(1);
      expect(document.head.firstChild.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    });

    it('returns undefined on success', () => {
      const result = injectCspMeta({ getConfigSnapshot });
      expect(result).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Idempotency — removes existing CSP meta tags before injecting
  // --------------------------------------------------------------------------
  describe('idempotency', () => {
    const mockConfig = { backend: { baseUrl: 'http://127.0.0.1:7090/v1' } };
    let getConfigSnapshot;

    beforeEach(() => {
      getConfigSnapshot = jest.fn(() => mockConfig);
    });

    it('removes pre-existing Content-Security-Policy meta tag', () => {
      const oldMeta = document.createElement('meta');
      oldMeta.setAttribute('http-equiv', 'Content-Security-Policy');
      oldMeta.setAttribute('content', 'default-src none');
      document.head.appendChild(oldMeta);

      injectCspMeta({ getConfigSnapshot });

      const allCsp = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
      expect(allCsp.length).toBe(1);
      expect(allCsp[0].getAttribute('content')).not.toBe('default-src none');
      expect(allCsp[0].getAttribute('content')).toBe(buildFileCspPolicy(mockConfig));
    });

    it('removes Content-Security-Policy-Report-Only meta tag', () => {
      const reportMeta = document.createElement('meta');
      reportMeta.setAttribute('http-equiv', 'Content-Security-Policy-Report-Only');
      reportMeta.setAttribute('content', 'default-src *');
      document.head.appendChild(reportMeta);

      injectCspMeta({ getConfigSnapshot });

      expect(document.querySelectorAll(
        'meta[http-equiv="Content-Security-Policy-Report-Only"]'
      ).length).toBe(0);
    });

    it('calling twice results in exactly one CSP meta tag', () => {
      injectCspMeta({ getConfigSnapshot });
      injectCspMeta({ getConfigSnapshot });

      const allCsp = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
      expect(allCsp.length).toBe(1);
    });

    it('second injection uses fresh config snapshot', () => {
      const config1 = {};
      const config2 = { backend: { baseUrl: 'http://127.0.0.1:9999' } };
      const fn = jest.fn()
        .mockReturnValueOnce(config1)
        .mockReturnValueOnce(config2);

      injectCspMeta({ getConfigSnapshot: fn });
      injectCspMeta({ getConfigSnapshot: fn });

      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      expect(meta.getAttribute('content')).toBe(buildFileCspPolicy(config2));
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('removes multiple pre-existing CSP meta tags', () => {
      for (let i = 0; i < 3; i++) {
        const m = document.createElement('meta');
        m.setAttribute('http-equiv', 'Content-Security-Policy');
        m.setAttribute('content', `policy-${i}`);
        document.head.appendChild(m);
      }

      injectCspMeta({ getConfigSnapshot });

      const allCsp = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
      expect(allCsp.length).toBe(1);
      expect(allCsp[0].getAttribute('content')).toBe(buildFileCspPolicy(mockConfig));
    });
  });

  // --------------------------------------------------------------------------
  // MutationObserver fallback (head not available when injectCspMeta is called)
  // --------------------------------------------------------------------------
  describe('MutationObserver fallback', () => {
    it('defers injection when head is not available, injects when head appears', async () => {
      document.head.remove();

      const mockConfig = { backend: { baseUrl: 'http://127.0.0.1:7090/v1' } };
      const getConfigSnapshot = jest.fn(() => mockConfig);

      injectCspMeta({ getConfigSnapshot });

      // No head yet -> no injection, getConfigSnapshot not called
      expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')).toBeNull();
      expect(getConfigSnapshot).not.toHaveBeenCalled();

      // Re-add head — triggers MutationObserver
      const newHead = document.createElement('head');
      document.documentElement.appendChild(newHead);

      // Flush MutationObserver microtask queue
      await new Promise(resolve => setTimeout(resolve, 0));

      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      expect(meta).not.toBeNull();
      expect(meta.getAttribute('content')).toBe(buildFileCspPolicy(mockConfig));
      expect(getConfigSnapshot).toHaveBeenCalledTimes(1);
    });

    it('observer disconnects after successful injection', async () => {
      document.head.remove();

      const getConfigSnapshot = jest.fn(() => ({}));
      const disconnectSpy = jest.spyOn(MutationObserver.prototype, 'disconnect');

      injectCspMeta({ getConfigSnapshot });

      document.documentElement.appendChild(document.createElement('head'));
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(disconnectSpy).toHaveBeenCalled();
      disconnectSpy.mockRestore();
    });

    it('observer does not fire after disconnecting (no double injection)', async () => {
      document.head.remove();

      const getConfigSnapshot = jest.fn(() => ({}));

      injectCspMeta({ getConfigSnapshot });

      // Add head — observer fires and injects
      document.documentElement.appendChild(document.createElement('head'));
      await new Promise(resolve => setTimeout(resolve, 0));

      // Add another element — observer should be disconnected, no second call
      const div = document.createElement('div');
      document.documentElement.appendChild(div);
      await new Promise(resolve => setTimeout(resolve, 0));

      // getConfigSnapshot called exactly once (from the first observer fire)
      expect(getConfigSnapshot).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // document unavailable guard
  // --------------------------------------------------------------------------
  describe('document unavailable', () => {
    it('returns undefined without throwing when document is not defined', () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(global, 'document');
      try {
        // Temporarily remove document from global scope
        Object.defineProperty(global, 'document', {
          value: undefined,
          writable: true,
          configurable: true,
        });
        const result = injectCspMeta({ getConfigSnapshot: jest.fn() });
        expect(result).toBeUndefined();
      } finally {
        // Restore original document
        if (origDescriptor) {
          Object.defineProperty(global, 'document', origDescriptor);
        }
      }
    });
  });
});
