/**
 * @.architecture
 *
 * Incoming: Renderer modules requesting scoped loggers, preload log bridge --- {event.custom, json}
 * Processing: Format structured messages, emit to console and preload log bridge --- {2 jobs: JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT}
 * Outgoing: Scoped logger instances (trace/debug/info/warn/error) --- {logging.logger, javascript_api}
 */

'use strict';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];
const { getAether } = require('../bridge/AetherBridge');

function serialize(args) {
  return args.map((arg) => {
    if (arg instanceof Error) {
      return arg.stack || arg.message;
    }
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg);
      } catch (_) {
        return '[unserializable]';
      }
    }
    return String(arg);
  }).join(' ');
}

function emit(level, component, context, args) {
  const timestamp = new Date().toISOString();
  const prefix = `[${component}]`;
  const message = serialize(args);
  const payload = {
    level,
    component,
    context,
    message,
    timestamp,
  };

  const aether = getAether();
  if (aether?.log?.send) {
    try {
      aether.log.send(JSON.stringify(payload));
    } catch (error) {
      console.warn('[RendererLogger] Failed to send log payload to main process:', error);
    }
  }

  const consoleFn = level === 'error'
    ? console.error
    : level === 'warn'
      ? console.warn
      : level === 'info'
        ? console.info
        : console.debug;

  consoleFn(`${prefix}`, ...args);
}

function createRendererLogger(component, baseContext = {}) {
  function log(level, ...args) {
    if (!LEVELS.includes(level)) {
      throw new Error(`[RendererLogger] Unsupported level: ${level}`);
    }
    emit(level, component, baseContext, args);
  }

  return {
    child(extraContext = {}) {
      return createRendererLogger(component, { ...baseContext, ...extraContext });
    },
    trace: (...args) => log('trace', ...args),
    debug: (...args) => log('debug', ...args),
    info: (...args) => log('info', ...args),
    warn: (...args) => log('warn', ...args),
    error: (...args) => log('error', ...args),
  };
}

module.exports = {
  createRendererLogger,
};
