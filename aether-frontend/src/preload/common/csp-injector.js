'use strict';

/**
 * @.architecture
 *
 * Incoming: Renderer-safe config snapshot (renderer-config), preload execution (runs before renderer JS) --- {config_snapshot, object}
 * Processing: Build a CSP string for file:// renderers and inject as early as possible via <meta http-equiv="Content-Security-Policy"> --- {2 jobs: JOB_VALIDATE_SCHEMA, JOB_CREATE_DOM_ELEMENT}
 * Outgoing: Document <head> meta tag for CSP --- {csp_meta, HTMLElement}
 *
 * Purpose:
 * - Electron file:// pages do not receive HTTP response headers, so the only reliable CSP carrier is a meta tag.
 * - Injecting from preload avoids "no CSP set" warnings and removes invalid directives for meta delivery (e.g. frame-ancestors).
 *
 * Security:
 * - No unsafe-eval.
 * - No unsafe-inline for scripts (main renderer inline scripts must be externalized).
 */

function _toOrigin(urlString) {
  if (!urlString || typeof urlString !== 'string') return null;
  const u = new URL(urlString);
  return u.origin;
}

function _withLoopbackAliases(origin) {
  const out = new Set();
  if (!origin || typeof origin !== 'string') return out;
  out.add(origin);
  try {
    const u = new URL(origin);
    const port = u.port ? `:${u.port}` : '';
    // If it's loopback, include aliases with same port.
    // WHATWG URL spec: hostname for IPv6 includes brackets, e.g. "[::1]".
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]') {
      out.add(`${u.protocol}//127.0.0.1${port}`);
      out.add(`${u.protocol}//localhost${port}`);
      // NOTE: URL origin for IPv6 loopback is "http://[::1]:PORT"
      out.add(`${u.protocol}//[::1]${port}`);
    }
  } catch (_) {}
  return out;
}

function buildFileCspPolicy(configSnapshot = {}) {
  const backendBase = configSnapshot?.backend?.baseUrl || null;
  const backendWs = configSnapshot?.backend?.wsUrl || null;

  const allowedOrigins = new Set();
  for (const origin of _withLoopbackAliases(_toOrigin(backendBase))) allowedOrigins.add(origin);
  for (const origin of _withLoopbackAliases(_toOrigin(backendWs))) allowedOrigins.add(origin);

  // Minimal, renderer-safe CSP for Electron file://.
  // NOTE: frame-ancestors is intentionally omitted here (ignored via meta in Chromium; enforce via headers when applicable).
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", 'ws:', 'wss:', ...Array.from(allowedOrigins)],
    'media-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-src': ["'self'", 'blob:', 'data:', 'http://localhost:*', 'http://127.0.0.1:*', 'app:', 'aether:', 'file:'],
    'worker-src': ["'self'", 'blob:'],
  };

  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}

function injectCspMeta({ getConfigSnapshot }) {
  if (typeof document === 'undefined') return;
  if (typeof getConfigSnapshot !== 'function') {
    throw new Error('[csp-injector] getConfigSnapshot function is required');
  }

  const ensure = () => {
    const head = document.head || document.getElementsByTagName('head')[0];
    if (!head) return false;

    const policy = buildFileCspPolicy(getConfigSnapshot());

    // Remove existing CSP meta tags (idempotent, avoids duplicates).
    const existing = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"], meta[http-equiv="Content-Security-Policy-Report-Only"]');
    existing.forEach((el) => el.remove());

    const meta = document.createElement('meta');
    meta.setAttribute('http-equiv', 'Content-Security-Policy');
    meta.setAttribute('content', policy);

    // Place it first in <head> so it applies as early as possible.
    if (head.firstChild) head.insertBefore(meta, head.firstChild);
    else head.appendChild(meta);

    return true;
  };

  if (ensure()) return;

  // Head not ready yet; observe until it exists.
  const root = document.documentElement;
  if (!root) return;
  const observer = new MutationObserver(() => {
    if (ensure()) observer.disconnect();
  });
  observer.observe(root, { childList: true, subtree: true });
}

module.exports = {
  injectCspMeta,
  buildFileCspPolicy,
};

