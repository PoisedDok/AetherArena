/**
 * @jest-environment node
 */
'use strict';

/**
 * SettingsValidator XSS Security Bug - REAL VULNERABILITY TEST
 * ============================================================================
 * This test demonstrates a REAL security vulnerability in SettingsValidator.
 * 
 * BUG: _isValidUrl() accepts javascript: and data: URLs because it only
 * uses `new URL()` which considers them valid protocols.
 * 
 * IMPACT: User can inject XSS through settings API base URL
 * SEVERITY: HIGH - XSS vulnerability
 * 
 * @module tests/component/SettingsValidator-XSS.REAL
 */

const { SettingsValidator } = require('../../src/domain/settings/validators/SettingsValidator');

describe('SettingsValidator XSS Vulnerability - REAL BUG', () => {
  describe('CRITICAL: javascript: URL Injection', () => {
    test('should REJECT javascript: URL (CURRENTLY FAILS - BUG EXISTS)', () => {
      const maliciousSettings = {
        llm: {
          api_base: 'javascript:alert(document.cookie)',
          provider: 'openai',
          model: 'gpt-4'
        }
      };

      const result = SettingsValidator.validateSettings(maliciousSettings);

      console.log('\n=== SECURITY TEST RESULT ===');
      console.log('Input: javascript:alert(document.cookie)');
      console.log('Valid:', result.valid);
      console.log('Errors:', result.errors);

      if (result.valid) {
        console.error('\n🚨 SECURITY BUG CONFIRMED:');
        console.error('javascript: URL ACCEPTED by validator');
        console.error('This is an XSS vulnerability!');
        console.error('\nVulnerable code: SettingsValidator._isValidUrl()');
        console.error('Uses: new URL() which accepts javascript: protocol');
        console.error('\nFix: Check protocol against whitelist (http, https only)');
      }

      // This SHOULD fail (reject malicious URL)
      // But currently PASSES (accepts it) - demonstrating the bug
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/api_base.*invalid|javascript.*not allowed|protocol.*not allowed/i),
        ])
      );
    });

    test('should REJECT data: URL (CURRENTLY FAILS - BUG EXISTS)', () => {
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

        const result = SettingsValidator.validateSettings(maliciousSettings);

        if (result.valid) {
          console.error(`\n🚨 SECURITY BUG #${i + 1}:`);
          console.error(`data: URL ACCEPTED: ${attack}`);
        }

        // Should reject but currently accepts - bug
        expect(result.valid).toBe(false);
      });
    });
  });

  describe('EDGE CASES: Other Malicious Protocols', () => {
    test('should REJECT file:// URLs', () => {
      const maliciousSettings = {
        llm: {
          api_base: 'file:///etc/passwd',
          provider: 'openai',
          model: 'gpt-4'
        }
      };

      const result = SettingsValidator.validateSettings(maliciousSettings);

      if (result.valid) {
        console.error('\n🚨 SECURITY BUG: file:// URL ACCEPTED');
      }

      expect(result.valid).toBe(false);
    });

    test('should REJECT vbscript: URLs', () => {
      const maliciousSettings = {
        llm: {
          api_base: 'vbscript:msgbox("XSS")',
          provider: 'openai',
          model: 'gpt-4'
        }
      };

      const result = SettingsValidator.validateSettings(maliciousSettings);

      if (result.valid) {
        console.error('\n🚨 SECURITY BUG: vbscript: URL ACCEPTED');
      }

      expect(result.valid).toBe(false);
    });
  });

  describe('VALID: Should ACCEPT legitimate URLs', () => {
    test('should ACCEPT https:// URLs', () => {
      const validSettings = {
        llm: {
          api_base: 'https://api.openai.com/v1',
          provider: 'openai',
          model: 'gpt-4'
        }
      };

      const result = SettingsValidator.validateSettings(validSettings);
      expect(result.valid).toBe(true);
    });

    test('should ACCEPT http:// URLs (local development)', () => {
      const validSettings = {
        llm: {
          api_base: 'http://localhost:8765',
          provider: 'openai',
          model: 'gpt-4'
        }
      };

      const result = SettingsValidator.validateSettings(validSettings);
      expect(result.valid).toBe(true);
    });
  });
});

/**
 * SECURITY FIX REQUIRED:
 * 
 * Replace in SettingsValidator.js:
 * 
 * static _isValidUrl(url) {
 *   try {
 *     new URL(url);
 *     return true;
 *   } catch (_) {
 *     return false;
 *   }
 * }
 * 
 * WITH:
 * 
 * static _isValidUrl(url) {
 *   try {
 *     const parsed = new URL(url);
 *     // Only allow http and https protocols
 *     const allowedProtocols = ['http:', 'https:'];
 *     if (!allowedProtocols.includes(parsed.protocol)) {
 *       return false;
 *     }
 *     return true;
 *   } catch (_) {
 *     return false;
 *   }
 * }
 */

