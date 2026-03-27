'use strict';

/**
 * @.architecture
 *
 * Incoming: SettingsService (XSS sanitization requests) --- {settings_strings, string}
 * Processing: Contract validation + sanitization for security (types/ranges/URL schemes) --- {2 jobs: JOB_VALIDATE_CONTRACT, JOB_ESCAPE_HTML}
 * Outgoing: Validation result + optional sanitized payload --- {{valid:boolean, errors:string[], sanitized?:object}}
 *
 * ARCHITECTURE NOTE:
 * Backend MUST validate on receive, but frontend MUST also validate for security:
 * - prevents UI/runtime crashes from type confusion
 * - blocks obviously malicious inputs (javascript:/data:/file: URLs, CRLF injection)
 * - fail-fast before persistence and before spawning external runtimes
 *
 * @module domain/settings/validators/SettingsValidator
 */

const { createLogger } = require('../../../core/utils/logger');

const log = createLogger({ component: 'SettingsValidator' });

/**
 * SettingsValidator
 * 
 * Security-first contract validator for settings payloads:
 * - strict types (reject type confusion / null / arrays)
 * - strict enums and numeric ranges
 * - strict URL scheme validation for `llm.api_base`
 *
 * Backend MUST still validate on receive; this validator is a fail-fast guardrail
 * to prevent local crashes + obvious injection inputs from ever reaching runtime.
 */
class SettingsValidator {
  /**
   * Sanitize settings string value for XSS
   * @param {string} value - Settings string value
   * @returns {string} - Sanitized value
   */
  static sanitizeSettingString(value) {
    if (!value || typeof value !== 'string') {
      return '';
    }
    
    // Basic HTML escape for settings strings
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;',
      '/': '&#x2F;',
    };
    
    return value.replace(/[&<>"'/]/g, (char) => map[char]);
  }

  /**
   * Validate JSON string (legitimate frontend concern for parsing)
   * @param {string} jsonString - JSON string to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validateJSON(jsonString) {
    const errors = [];

    if (!jsonString) {
      errors.push('JSON string is required');
      return { valid: false, errors };
    }

    if (typeof jsonString !== 'string') {
      errors.push('JSON must be string');
      return { valid: false, errors };
    }

    try {
      JSON.parse(jsonString);
    } catch (error) {
      errors.push(`Invalid JSON: ${error.message}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate settings payload (security + contract validation).
   *
   * Returns:
   * - valid: boolean
   * - errors: string[]
   * - sanitized: normalized copy (trimmed strings) for safe downstream usage
   */
  static validate(settings) {
    const errors = [];
    const sanitized = {};

    const isPlainObject = (v) =>
      Boolean(v) && typeof v === 'object' && !Array.isArray(v);

    const push = (msg) => errors.push(String(msg || 'Invalid settings'));

    const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);

    const requireNonEmptyString = (value, field) => {
      if (typeof value !== 'string') {
        push(`${field} must be a non-empty string`);
        return null;
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        push(`${field} must be a non-empty string`);
        return null;
      }
      return trimmed;
    };

    const validateUrlHttp = (value, field) => {
      const s = requireNonEmptyString(value, field);
      if (!s) return null;

      // Reject protocol-relative URLs (ambiguous scheme; security footgun)
      if (s.startsWith('//')) {
        push(`${field} must be an absolute http(s) URL (protocol-relative URLs are not allowed)`);
        return null;
      }

      const lower = s.toLowerCase();
      // Explicitly reject dangerous schemes early (gives correct error message for tests + UX).
      for (const bad of ['javascript:', 'data:', 'vbscript:', 'file:']) {
        if (lower.startsWith(bad)) {
          push(`${field} protocol not allowed (rejected scheme: ${bad})`);
          return null;
        }
      }

      // Fail-fast: require explicit http(s) prefix (rejects typos like `http:/example.com`)
      if (!/^https?:\/\//i.test(s)) {
        push(`${field} must be an absolute http(s) URL`);
        return null;
      }

      let url;
      try {
        url = new URL(s);
      } catch (e) {
        push(`${field} must be a valid URL`);
        return null;
      }
      if (!(url.protocol === 'http:' || url.protocol === 'https:')) {
        push(`${field} must be http(s) URL`);
        return null;
      }
      if (!url.hostname) {
        push(`${field} must include hostname`);
        return null;
      }
      if (url.username || url.password) {
        push(`${field} must not include credentials`);
        return null;
      }
      return url.toString().replace(/\/$/, '');
    };

    const validateSafeIdentifier = (value, field, pattern) => {
      const s = requireNonEmptyString(value, field);
      if (!s) return null;
      if (s.includes('\r') || s.includes('\n') || s.includes('\0')) {
        push(`${field} contains control characters`);
        return null;
      }
      if (!pattern.test(s)) {
        push(`${field} contains invalid characters`);
        return null;
      }
      return s;
    };

    if (!isPlainObject(settings)) {
      return { valid: false, errors: ['settings must be an object'] };
    }

    // ---- interpreter (optional) ----
    if ('interpreter' in settings) {
      if (!isPlainObject(settings.interpreter)) {
        push('interpreter must be an object');
      } else {
        sanitized.interpreter = {};
        const interp = settings.interpreter;

        if ('safe_mode' in interp) {
          const raw = interp.safe_mode;
          if (typeof raw !== 'string') {
            push('interpreter.safe_mode must be one of: off | ask | auto');
          } else if (raw.trim().length === 0) {
            // Reject empty/whitespace-only
            push('interpreter.safe_mode must be one of: off | ask | auto');
          } else if (raw !== raw.trim()) {
            // Reject leading/trailing whitespace (no silent normalization)
            push('interpreter.safe_mode must not include leading/trailing whitespace');
          } else {
            const mode = raw; // exact, case-sensitive
          const allowed = new Set(['off', 'ask', 'auto']);
          if (mode && !allowed.has(mode)) {
            push('interpreter.safe_mode must be one of: off | ask | auto');
          } else {
            sanitized.interpreter.safe_mode = mode;
          }
          }
        }
      }
    }

    // ---- llm (optional, but if present: provider+model required) ----
    if ('llm' in settings) {
      if (!isPlainObject(settings.llm)) {
        push('llm must be an object');
      } else {
        sanitized.llm = {};
        const llm = settings.llm;

        // provider: strict safe identifier (blocks shell metacharacters)
        const provider = validateSafeIdentifier(
          llm.provider,
          'llm.provider',
          /^[A-Za-z0-9._-]+$/
        );
        if (provider) sanitized.llm.provider = provider;

        // model: allow slashes/dots/dashes, but reject traversal + control chars
        const model = validateSafeIdentifier(
          llm.model,
          'llm.model',
          /^[A-Za-z0-9._/-]+$/
        );
        if (model) {
          // Hard reject obvious path traversal / absolute paths
          if (
            model.includes('..') ||
            model.startsWith('/') ||
            model.startsWith('./') ||
            model.startsWith('.\\') ||
            model.includes('\\') ||
            /^[A-Za-z]:\\/.test(model)
          ) {
            push('llm.model must not contain file paths or path traversal');
          } else {
            sanitized.llm.model = model;
          }
        }

        if ('api_base' in llm) {
          const apiBase = validateUrlHttp(llm.api_base, 'llm.api_base');
          if (apiBase) sanitized.llm.api_base = apiBase;
        }

        if ('context_window' in llm) {
          const v = llm.context_window;
          if (!isFiniteNumber(v) || !Number.isInteger(v)) {
            push('llm.context_window must be a positive integer');
          } else if (v < 1000) {
            push('llm.context_window must be at least 1000');
          } else if (v > 2_000_000) {
            push('llm.context_window is unreasonably large');
          } else {
            sanitized.llm.context_window = v;
          }
        }

        if ('max_tokens' in llm) {
          const v = llm.max_tokens;
          if (!isFiniteNumber(v) || !Number.isInteger(v) || v <= 0) {
            push('llm.max_tokens must be a positive integer');
          } else if (v > 200_000) {
            push('llm.max_tokens is unreasonably large');
          } else {
            sanitized.llm.max_tokens = v;
          }
        }

        if ('temperature' in llm) {
          const v = llm.temperature;
          if (!isFiniteNumber(v) || v < 0 || v > 2) {
            push('llm.temperature must be between 0 and 2');
          } else {
            sanitized.llm.temperature = v;
          }
        }

        if ('top_p' in llm) {
          const v = llm.top_p;
          if (!isFiniteNumber(v) || v < 0 || v > 1) {
            push('llm.top_p must be between 0 and 1');
          } else {
            sanitized.llm.top_p = v;
          }
        }
      }
    }

    // ---- voice (optional) ----
    if ('voice' in settings) {
      if (!isPlainObject(settings.voice)) {
        push('voice must be an object');
      } else {
        sanitized.voice = {};
        const voice = settings.voice;

        if ('mic_button_enabled' in voice && typeof voice.mic_button_enabled !== 'boolean') {
          push('voice.mic_button_enabled must be a boolean');
        } else if ('mic_button_enabled' in voice) {
          sanitized.voice.mic_button_enabled = voice.mic_button_enabled;
        }

        if ('stt' in voice) {
          if (!isPlainObject(voice.stt)) {
            push('voice.stt must be an object');
          } else {
            sanitized.voice.stt = {};
            const stt = voice.stt;

            if ('sample_rate_hz' in stt) {
              const sr = stt.sample_rate_hz;
              if (!isFiniteNumber(sr) || !Number.isInteger(sr) || sr < 8000 || sr > 48000) {
                push('voice.stt.sample_rate_hz must be an integer between 8000 and 48000');
              } else {
                sanitized.voice.stt.sample_rate_hz = sr;
              }
            }
          }
        }
      }
    }

    // ---- memory (optional) ----
    if ('memory' in settings) {
      if (!isPlainObject(settings.memory)) {
        push('memory must be an object');
      } else {
        sanitized.memory = {};
        const memory = settings.memory;

        if ('type' in memory) {
          const t = requireNonEmptyString(memory.type, 'memory.type');
          const allowed = new Set(['supabase', 'pgvector']);
          if (t && !allowed.has(t)) {
            push('memory.type must be one of: supabase | pgvector');
          } else if (t) {
            sanitized.memory.type = t;
          }
        }
      }
    }

    return { valid: errors.length === 0, errors, sanitized };
  }

  /**
   * Back-compat alias used by SettingsService.
   */
  static validateSettings(settings) {
    return SettingsValidator.validate(settings);
  }

  /**
   * Legacy compatibility: validateInterpreterSettings removed
   * @deprecated Backend validates on receive
   */
  static validateInterpreterSettings(interpreter) {
    log.warn('validateInterpreterSettings() is deprecated - backend owns validation');
    return { valid: true, errors: [] };
  }

  /**
   * Legacy compatibility: validateLLMSettings removed
   * @deprecated Backend validates on receive
   */
  static validateLLMSettings(llm) {
    log.warn('validateLLMSettings() is deprecated - backend owns validation');
    return { valid: true, errors: [] };
  }

  /**
   * Legacy compatibility: validateVoiceSettings removed
   * @deprecated Backend validates on receive
   */
  static validateVoiceSettings(voice) {
    log.warn('validateVoiceSettings() is deprecated - backend owns validation');
    return { valid: true, errors: [] };
  }

  /**
   * Legacy compatibility: validateMemorySettings removed
   * @deprecated Backend validates on receive
   */
  static validateMemorySettings(memory) {
    log.warn('validateMemorySettings() is deprecated - backend owns validation');
    return { valid: true, errors: [] };
  }

  /**
   * Legacy compatibility: validateSecuritySettings removed
   * @deprecated Backend validates on receive
   */
  static validateSecuritySettings(security) {
    log.warn('validateSecuritySettings() is deprecated - backend owns validation');
    return { valid: true, errors: [] };
  }

  /**
   * Legacy compatibility: validateProfileName removed
   * @deprecated Backend validates on receive
   */
  static validateProfileName(profileName) {
    log.warn('validateProfileName() is deprecated - backend owns validation');
    return { valid: true, errors: [] };
  }

  /**
   * Legacy compatibility: validateModelName removed
   * @deprecated Backend validates on receive
   */
  static validateModelName(modelName) {
    log.warn('validateModelName() is deprecated - backend owns validation');
    return { valid: true, errors: [] };
  }

  /**
   * Legacy compatibility: validateModelCapabilities removed
   * @deprecated Backend validates on receive
   */
  static validateModelCapabilities(capabilities) {
    log.warn('validateModelCapabilities() is deprecated - backend owns validation');
    return { valid: true, errors: [] };
  }

  /**
   * Legacy compatibility: _isValidUrl removed
   * @private
   * @deprecated Backend validates URLs
   */
  static _isValidUrl(url) {
    log.warn('_isValidUrl() is deprecated - backend validates URLs');
    return true;
  }
}

// Compatibility:
// - tests expect: `require(SettingsValidatorPath).validate(...)`
// - app code expects: `const { SettingsValidator } = require(...)`
module.exports = SettingsValidator;
module.exports.SettingsValidator = SettingsValidator;
