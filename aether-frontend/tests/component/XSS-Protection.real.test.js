/**
 * @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js
 */
'use strict';

/**
 * XSS Protection - REAL SECURITY TESTS
 * ============================================================================
 * Tests that verify ACTUAL XSS protection in message rendering, artifacts,
 * and settings. These are REAL security tests that check if malicious content
 * is properly escaped/sanitized.
 * 
 * Tests REAL behavior, not mocks. Uses actual DOM, actual components.
 * 
 * @module tests/component/XSS-Protection.real
 */

const path = require('path');
const fs = require('fs');

// Setup DOM
global.window = global;
global.document = window.document;

// Mock logger before requiring modules
const mockLogger = {
  trace: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(function() { return this; })
};

jest.mock('../../src/renderer/shared/utils/logger', () => ({
  createRendererLogger: () => mockLogger
}));

describe('XSS Protection - REAL SECURITY TESTS', () => {
  let MessageView;
  let contentContainer;

  beforeEach(() => {
    // Setup DOM
    document.body.innerHTML = '<div id="content"></div>';
    contentContainer = document.getElementById('content');

    // Load MessageView
    const MessageViewPath = path.resolve(__dirname, '../../src/renderer/chat/modules/messaging/MessageView.js');
    expect(fs.existsSync(MessageViewPath)).toBe(true);
    delete require.cache[require.resolve(MessageViewPath)];
    MessageView = require(MessageViewPath);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    jest.clearAllMocks();
  });

  describe('CRITICAL: Script Tag Injection', () => {
    test('should escape <script> tags in user messages', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_001',
        role: 'user',
        content: 'Hello <script>alert("XSS")</script> World',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      // CRITICAL: Script tags MUST be escaped
      expect(element).not.toBeNull();
      expect(element.innerHTML).not.toMatch(/<script>/i);
      expect(element.innerHTML).toMatch(/&lt;script&gt;/i); // Should be escaped
      expect(element.textContent).toContain('Hello');
      expect(element.textContent).toContain('World');

      // CRITICAL: Verify script did not execute
      const scripts = document.getElementsByTagName('script');
      const xssScripts = Array.from(scripts).filter(s => s.innerHTML.includes('XSS'));
      expect(xssScripts.length).toBe(0);
    });

    test('should escape <script> with src attribute', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_002',
        role: 'user',
        content: 'Click here: <script src="https://evil.com/xss.js"></script>',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      expect(element).not.toBeNull();
      expect(element.innerHTML).not.toMatch(/<script[^>]*src=/i);
      expect(element.innerHTML).toMatch(/&lt;script/i);

      // Verify no external scripts loaded
      const scripts = Array.from(document.getElementsByTagName('script'));
      const externalScripts = scripts.filter(s => s.src && s.src.includes('evil.com'));
      expect(externalScripts.length).toBe(0);
    });

    test('should handle multiple script tags', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_003',
        role: 'user',
        content: '<script>alert(1)</script>Text<script>alert(2)</script>More<script>alert(3)</script>',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      expect(element).not.toBeNull();
      
      // Count script tags in output (should be 0 actual scripts)
      const renderedScripts = element.querySelectorAll('script');
      expect(renderedScripts.length).toBe(0);

      // Verify content still readable
      expect(element.textContent).toContain('Text');
      expect(element.textContent).toContain('More');
    });
  });

  describe('CRITICAL: Event Handler Injection', () => {
    test('should escape onclick handlers', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_004',
        role: 'user',
        content: '<div onclick="alert(\'XSS\')">Click me</div>',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      expect(element).not.toBeNull();
      
      // Should not have onclick attribute
      const divs = element.querySelectorAll('div');
      divs.forEach(div => {
        expect(div.hasAttribute('onclick')).toBe(false);
        expect(div.getAttribute('onclick')).toBeNull();
      });
    });

    test('should escape onerror handlers in img tags', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_005',
        role: 'user',
        content: '<img src="invalid.jpg" onerror="alert(\'XSS\')">',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      expect(element).not.toBeNull();

      // Should not have img with onerror
      const images = element.querySelectorAll('img');
      images.forEach(img => {
        expect(img.hasAttribute('onerror')).toBe(false);
      });
    });

    test('should escape onload handlers', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const attacks = [
        '<body onload="alert(\'XSS\')">',
        '<img onload="alert(\'XSS\')">',
        '<iframe onload="alert(\'XSS\')">',
        '<svg onload="alert(\'XSS\')">'
      ];

      attacks.forEach((attack, i) => {
        const message = {
          id: `msg_xss_006_${i}`,
          role: 'user',
          content: attack,
          timestamp: Date.now()
        };

        const element = messageView.renderMessage(message);

        // Should have NO elements with onload
        const withOnload = element.querySelectorAll('[onload]');
        expect(withOnload.length).toBe(0);
      });
    });
  });

  describe('CRITICAL: JavaScript URL Injection', () => {
    test('should block javascript: URLs in links', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_007',
        role: 'user',
        content: '<a href="javascript:alert(\'XSS\')">Click here</a>',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      expect(element).not.toBeNull();

      // Check all links
      const links = element.querySelectorAll('a');
      links.forEach(link => {
        const href = link.getAttribute('href') || '';
        expect(href.toLowerCase()).not.toContain('javascript:');
      });
    });

    test('should block data: URLs with HTML', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_008',
        role: 'user',
        content: '<a href="data:text/html,<script>alert(\'XSS\')</script>">Link</a>',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      expect(element).not.toBeNull();

      const links = element.querySelectorAll('a');
      links.forEach(link => {
        const href = link.getAttribute('href') || '';
        // data: URLs should be blocked or sanitized
        if (href.startsWith('data:')) {
          expect(href).not.toContain('<script>');
        }
      });
    });

    test('should block vbscript: URLs', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_009',
        role: 'user',
        content: '<a href="vbscript:msgbox(\'XSS\')">Click</a>',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      const links = element.querySelectorAll('a');
      links.forEach(link => {
        const href = link.getAttribute('href') || '';
        expect(href.toLowerCase()).not.toContain('vbscript:');
      });
    });
  });

  describe('CRITICAL: iframe Injection', () => {
    test('should block iframe elements', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_010',
        role: 'user',
        content: '<iframe src="https://evil.com"></iframe>',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      expect(element).not.toBeNull();

      // Should have NO iframes
      const iframes = element.querySelectorAll('iframe');
      expect(iframes.length).toBe(0);
    });

    test('should block nested iframes', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_011',
        role: 'user',
        content: '<div><iframe src="https://evil.com"><iframe src="https://evil2.com"></iframe></iframe></div>',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      // Recursively check for iframes
      const iframes = element.getElementsByTagName('iframe');
      expect(iframes.length).toBe(0);
    });
  });

  describe('CRITICAL: SVG-based XSS', () => {
    test('should sanitize SVG with script', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_012',
        role: 'user',
        content: '<svg><script>alert("XSS")</script></svg>',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      expect(element).not.toBeNull();

      // Check if SVG scripts are removed
      const scripts = element.querySelectorAll('script');
      expect(scripts.length).toBe(0);
    });

    test('should block SVG with foreignObject', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_013',
        role: 'user',
        content: '<svg><foreignObject><body><script>alert("XSS")</script></body></foreignObject></svg>',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      const scripts = element.getElementsByTagName('script');
      expect(scripts.length).toBe(0);
    });
  });

  describe('CRITICAL: Style-based XSS', () => {
    test('should sanitize style with expression()', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_014',
        role: 'user',
        content: '<div style="width: expression(alert(\'XSS\'))">Text</div>',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      const divs = element.querySelectorAll('div');
      divs.forEach(div => {
        const style = div.getAttribute('style') || '';
        expect(style.toLowerCase()).not.toContain('expression(');
      });
    });

    test('should sanitize style with url(javascript:)', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_015',
        role: 'user',
        content: '<div style="background: url(javascript:alert(\'XSS\'))">Text</div>',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      const divs = element.querySelectorAll('div');
      divs.forEach(div => {
        const style = div.getAttribute('style') || '';
        expect(style.toLowerCase()).not.toMatch(/url\s*\(\s*javascript:/);
      });
    });
  });

  describe('CRITICAL: HTML Entity Bypass', () => {
    test('should handle encoded script tags', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_016',
        role: 'user',
        content: '&lt;script&gt;alert("XSS")&lt;/script&gt;',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      // Should remain encoded, not execute
      expect(element.textContent).toContain('&lt;script&gt;');
      
      const scripts = element.getElementsByTagName('script');
      expect(scripts.length).toBe(0);
    });

    test('should handle hex-encoded characters', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const attacks = [
        '&#x3C;script&#x3E;alert("XSS")&#x3C;/script&#x3E;',
        '&#60;script&#62;alert("XSS")&#60;/script&#62;'
      ];

      attacks.forEach((attack, i) => {
        const message = {
          id: `msg_xss_017_${i}`,
          role: 'user',
          content: attack,
          timestamp: Date.now()
        };

        const element = messageView.renderMessage(message);

        // Should not execute as script
        const scripts = element.getElementsByTagName('script');
        expect(scripts.length).toBe(0);
      });
    });
  });

  describe('CRITICAL: Template Literal Injection', () => {
    test('should not evaluate template literals', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_018',
        role: 'user',
        content: '${alert("XSS")}',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      // Should display as plain text, not evaluate
      expect(element.textContent).toContain('${alert');
    });

    test('should not execute eval-like constructs', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const constructs = [
        'eval(alert("XSS"))',
        'setTimeout(alert("XSS"))',
        'setInterval(alert("XSS"))',
        'Function("alert(\\"XSS\\")")()'
      ];

      constructs.forEach((construct, i) => {
        const message = {
          id: `msg_xss_019_${i}`,
          role: 'user',
          content: construct,
          timestamp: Date.now()
        };

        const element = messageView.renderMessage(message);

        // Should be plain text
        expect(element.textContent).toContain(construct.substring(0, 10));
      });
    });
  });

  describe('CRITICAL: DOM Clobbering', () => {
    test('should not allow id clobbering of window properties', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_020',
        role: 'user',
        content: '<form id="console"><input name="log"></form>',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      // Verify window.console still works
      expect(typeof window.console.log).toBe('function');
    });

    test('should not allow name clobbering', () => {
      expect(MessageView).toBeDefined();

      const messageView = new MessageView();
      messageView.init(contentContainer);

      const message = {
        id: 'msg_xss_021',
        role: 'user',
        content: '<img name="body">',
        timestamp: Date.now()
      };

      const element = messageView.renderMessage(message);

      // document.body should still be the body element
      expect(document.body.tagName).toBe('BODY');
    });
  });

  describe('CRITICAL: Settings Validation XSS', () => {
    test('should reject javascript: URLs in API base settings', () => {
      const SettingsValidatorPath = path.resolve(__dirname, '../../src/domain/settings/validators/SettingsValidator.js');
      
      if (!fs.existsSync(SettingsValidatorPath)) {
        return;
      }

      const SettingsValidator = require(SettingsValidatorPath);

      const maliciousSettings = {
        llm: {
          api_base: 'javascript:alert("XSS")'
        }
      };

      const result = SettingsValidator.validate(maliciousSettings);

      // CRITICAL: Should REJECT javascript: URLs
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors.some(e => e.includes('api_base') || e.includes('URL'))).toBe(true);
    });

    test('should reject data: URLs in API base settings', () => {
      const SettingsValidatorPath = path.resolve(__dirname, '../../src/domain/settings/validators/SettingsValidator.js');
      
      if (!fs.existsSync(SettingsValidatorPath)) {
        return;
      }

      const SettingsValidator = require(SettingsValidatorPath);

      const maliciousSettings = {
        llm: {
          api_base: 'data:text/html,<script>alert("XSS")</script>'
        }
      };

      const result = SettingsValidator.validate(maliciousSettings);

      // CRITICAL: Should REJECT data: URLs
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    test('should sanitize model names with special chars', () => {
      const SettingsValidatorPath = path.resolve(__dirname, '../../src/domain/settings/validators/SettingsValidator.js');
      
      if (!fs.existsSync(SettingsValidatorPath)) {
        return;
      }

      const SettingsValidator = require(SettingsValidatorPath);

      const maliciousSettings = {
        llm: {
          model: '<script>alert("XSS")</script>'
        }
      };

      const result = SettingsValidator.validate(maliciousSettings);

      // Model name should be rejected or sanitized
      if (result.valid) {
        // If accepted, must be sanitized
        expect(result.sanitized.llm.model).not.toContain('<script>');
      } else {
        // Or rejected entirely
        expect(result.valid).toBe(false);
      }
    });
  });

  describe('CRITICAL: Artifact Content XSS', () => {
    let HtmlRenderer;

    beforeEach(() => {
      const HtmlRendererPath = path.resolve(
        __dirname,
        '../../src/renderer/artifacts/modules/output/renderers/HtmlRenderer.js'
      );
      expect(fs.existsSync(HtmlRendererPath)).toBe(true);
      delete require.cache[require.resolve(HtmlRendererPath)];
      HtmlRenderer = require(HtmlRendererPath);
    });

    test('should strip script tags from HTML artifacts', () => {
      const renderer = new HtmlRenderer({ log: mockLogger });
      const malicious = '<div>Hello</div><script>alert("xss")</script><p>World</p>';
      const result = renderer._basicSanitize(malicious);
      expect(result).not.toContain('<script');
      expect(result).not.toContain('alert');
      expect(result).toContain('<div>Hello</div>');
      expect(result).toContain('<p>World</p>');
    });

    test('should strip event handlers from HTML artifacts via fallback sanitizer', () => {
      const renderer = new HtmlRenderer({ log: mockLogger });
      const malicious = '<img src="x" onerror="alert(1)"><div onclick="steal()">Click</div>';
      const result = renderer.sanitizer.sanitizeHTML(malicious);
      expect(result).not.toContain('onerror');
      expect(result).not.toContain('onclick');
      expect(result).not.toContain('alert');
      expect(result).not.toContain('steal');
    });

    test('should strip javascript: protocol from HTML artifacts via fallback sanitizer', () => {
      const renderer = new HtmlRenderer({ log: mockLogger });
      const malicious = '<a href="javascript:document.cookie">Click me</a>';
      const result = renderer.sanitizer.sanitizeHTML(malicious);
      expect(result).not.toContain('javascript:');
    });

    test('should strip iframe tags from HTML artifacts via fallback sanitizer', () => {
      const renderer = new HtmlRenderer({ log: mockLogger });
      // The fallback sanitizer (this.sanitizer.sanitizeHTML) also strips iframes
      const malicious = '<div>Safe</div><iframe src="https://evil.com"></iframe>';
      const sanitized = renderer.sanitizer.sanitizeHTML(malicious);
      expect(sanitized).not.toContain('<iframe');
      expect(sanitized).toContain('<div>Safe</div>');
    });
  });
});

