/**
 * @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js
 */
'use strict';

/**
 * CodeViewer Safety Tests - REAL NULL/UNDEFINED BUGS
 * ============================================================================
 * Tests that expose REAL bugs in CodeViewer when handling null, undefined,
 * empty, and malformed inputs. Based on BUGS_FOUND_BY_REAL_TESTS.md Bug #24-25.
 * 
 * These tests verify defensive programming and proper error handling.
 * 
 * @module tests/component/CodeViewer-Safety.real
 */

const path = require('path');
const fs = require('fs');

// Setup DOM
global.window = global;
global.document = window.document;

// Mock logger
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

describe('CodeViewer Safety Tests - REAL BUGS', () => {
  let CodeViewer;
  let container;
  let mockEventBus;
  let mockController;
  let createCodeViewer;

  function getRenderedCode(containerEl) {
    if (!containerEl) return '';
    const codeEl =
      containerEl.querySelector('.code-display code') ||
      containerEl.querySelector('.code-editor code') ||
      containerEl.querySelector('code');
    if (!codeEl) return '';
    return codeEl.textContent || codeEl.innerHTML || '';
  }

  beforeEach(() => {
    // Setup DOM
    document.body.innerHTML = `
      <div id="code-container">
        <pre id="code-display"></pre>
        <div id="code-info"></div>
      </div>
    `;
    container = document.getElementById('code-container');

    // Load CodeViewer
    const CodeViewerPath = path.resolve(__dirname, '../../src/renderer/artifacts/modules/code/CodeViewer.js');
    expect(fs.existsSync(CodeViewerPath)).toBe(true);
    delete require.cache[require.resolve(CodeViewerPath)];
    CodeViewer = require(CodeViewerPath);

    mockEventBus = {
      emit: jest.fn(),
      on: jest.fn(() => () => {}),
      off: jest.fn(),
    };

    mockController = {
      // Minimal controller surface used by CodeViewer (defensive for future changes)
      onExecuteRequested: jest.fn(),
      onExportRequested: jest.fn(),
      onCopyRequested: jest.fn(),
    };

    createCodeViewer = () => new CodeViewer({ container, controller: mockController, eventBus: mockEventBus });

    jest.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('CRITICAL: Null Code Handling (Bug #24)', () => {
    test('should handle null code without crashing', () => {
      if (!CodeViewer) {
        console.warn('CodeViewer not found, skipping test');
        return;
      }

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      // CRITICAL: Should NOT crash with null code
      expect(() => {
        codeViewer.loadCode(null, 'javascript', 'test.js');
      }).not.toThrow();

      // Should handle gracefully (empty or placeholder)
      const content = getRenderedCode(container);
      
      // Should either be empty or have placeholder text
      expect(content).toBeDefined();
      
      // Should NOT contain "null" string
      expect(content).not.toBe('null');
    });

    test('should handle undefined code without crashing', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      expect(() => {
        codeViewer.loadCode(undefined, 'python', 'test.py');
      }).not.toThrow();

      const content = getRenderedCode(container);
      expect(content).not.toBe('undefined');
    });

    test('should not call .length on null code', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      // This should NOT throw TypeError: Cannot read properties of null (reading 'length')
      expect(() => {
        codeViewer.loadCode(null, 'javascript', 'null-test.js');
      }).not.toThrow(/Cannot read propert(y|ies) of null/);
    });

    test('should handle empty string code', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      expect(() => {
        codeViewer.loadCode('', 'javascript', 'empty.js');
      }).not.toThrow();

      // Should show empty or placeholder
      const content = getRenderedCode(container);
      expect(content).toBeDefined();
    });

    test('should handle whitespace-only code', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      expect(() => {
        codeViewer.loadCode('   \n\n\t\t   ', 'javascript', 'whitespace.js');
      }).not.toThrow();
    });
  });

  describe('CRITICAL: Null Language Handling (Bug #25)', () => {
    test('should default to text when language is null', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      expect(() => {
        codeViewer.loadCode('console.log("test");', null, 'test.js');
      }).not.toThrow();

      // Should apply default language (likely 'text')
      // Check if code is still rendered
      const content = getRenderedCode(container);
      expect(content).toContain('console.log');
    });

    test('should handle undefined language', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      expect(() => {
        codeViewer.loadCode('print("test")', undefined, 'test.py');
      }).not.toThrow();
    });

    test('should handle empty string language', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      expect(() => {
        codeViewer.loadCode('code', '', 'test.txt');
      }).not.toThrow();
    });

    test('should handle invalid language gracefully', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      const invalidLanguages = [
        'notareallanguage',
        'javascript123',
        'py thon', // space
        'java\nscript', // newline
        '<script>alert(1)</script>'
      ];

      invalidLanguages.forEach(lang => {
        expect(() => {
          codeViewer.loadCode('test code', lang, 'test.txt');
        }).not.toThrow();
      });
    });
  });

  describe('CRITICAL: Null Filename Handling', () => {
    test('should handle null filename', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      expect(() => {
        codeViewer.loadCode('code', 'javascript', null);
      }).not.toThrow();

      // Should use default filename (e.g., 'untitled')
      const info = document.getElementById('code-info');
      if (info) {
        const text = info.textContent || info.innerHTML;
        // Should not show "null"
        expect(text).not.toContain('null');
      }
    });

    test('should handle undefined filename', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      expect(() => {
        codeViewer.loadCode('code', 'python', undefined);
      }).not.toThrow();
    });

    test('should handle empty filename', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      expect(() => {
        codeViewer.loadCode('code', 'python', '');
      }).not.toThrow();
    });
  });

  describe('CRITICAL: Type Safety', () => {
    test('should handle number as code', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      expect(() => {
        codeViewer.loadCode(12345, 'javascript', 'number.js');
      }).not.toThrow();

      // Should convert to string
      const content = getRenderedCode(container);
      expect(content).toContain('12345');
    });

    test('should handle boolean as code', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      expect(() => {
        codeViewer.loadCode(true, 'javascript', 'bool.js');
      }).not.toThrow();
    });

    test('should handle object as code', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      expect(() => {
        codeViewer.loadCode({ foo: 'bar' }, 'javascript', 'obj.js');
      }).not.toThrow();

      // Should stringify object
      const content = getRenderedCode(container);
      // Should show object representation
      expect(content.length).toBeGreaterThan(0);
    });

    test('should handle array as code', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      expect(() => {
        codeViewer.loadCode(['line1', 'line2'], 'javascript', 'array.js');
      }).not.toThrow();
    });
  });

  describe('CRITICAL: Large Code Handling', () => {
    test('should handle very large code without crashing', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      // Generate 1MB of code
      const largeCode = 'x = 1\n'.repeat(100000); // ~600KB

      expect(() => {
        codeViewer.loadCode(largeCode, 'python', 'large.py');
      }).not.toThrow();
    });

    test('should handle extremely long line without crashing', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      // 100K character line
      const longLine = 'a'.repeat(100000);

      expect(() => {
        codeViewer.loadCode(longLine, 'text', 'long-line.txt');
      }).not.toThrow();
    });
  });

  describe('CRITICAL: Special Characters Handling', () => {
    test('should handle code with null bytes', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      const codeWithNull = 'line1\x00line2\x00line3';

      expect(() => {
        codeViewer.loadCode(codeWithNull, 'text', 'nullbytes.txt');
      }).not.toThrow();
    });

    test('should handle all Unicode characters', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      const unicode = '日本語 中文 العربية 🚀 💻 emoji';

      expect(() => {
        codeViewer.loadCode(unicode, 'text', 'unicode.txt');
      }).not.toThrow();

      const content = getRenderedCode(container);
      // Should preserve Unicode
      expect(content).toContain('🚀');
    });

    test('should handle code with dangerous HTML', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      const htmlCode = '<script>alert("XSS")</script><img src=x onerror=alert(1)>';

      expect(() => {
        codeViewer.loadCode(htmlCode, 'html', 'dangerous.html');
      }).not.toThrow();

      // Code should be escaped, not executed
      const scripts = document.getElementsByTagName('script');
      const xssScripts = Array.from(scripts).filter(s => s.innerHTML.includes('XSS'));
      expect(xssScripts.length).toBe(0);
    });
  });

  describe('CRITICAL: Multiple Load Handling', () => {
    test('should handle rapid successive loads', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      // Load 100 different code snippets rapidly
      for (let i = 0; i < 100; i++) {
        expect(() => {
          codeViewer.loadCode(`code ${i}`, 'javascript', `file${i}.js`);
        }).not.toThrow();
      }

      // Should show last code
      const content = getRenderedCode(container);
      expect(content).toContain('99');
    });

    test('should handle loading null after valid code', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      // Load valid code
      codeViewer.loadCode('valid code', 'javascript', 'valid.js');

      // Then load null
      expect(() => {
        codeViewer.loadCode(null, 'javascript', 'null.js');
      }).not.toThrow();
    });
  });

  describe('Memory: Cleanup', () => {
    test('should not leak memory with large code loads', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      // Load 10 large files
      for (let i = 0; i < 10; i++) {
        const largeCode = `code ${i}\n`.repeat(10000);
        codeViewer.loadCode(largeCode, 'javascript', `large${i}.js`);
      }

      // Should only have one code displayed (last one)
      const content = getRenderedCode(container);
      
      // Should contain latest code
      expect(content).toContain('9');
      
      // Should NOT contain all 10 files concatenated
      const lineCount = content.split('\n').length;
      expect(lineCount).toBeLessThan(100000); // Not 10000 * 10
    });

    test('should properly dispose', () => {
      expect(CodeViewer).toBeDefined();

      const codeViewer = createCodeViewer();
      if (codeViewer.init) codeViewer.init(container);

      codeViewer.loadCode('test code', 'javascript', 'test.js');

      if (typeof codeViewer.dispose === 'function') {
        expect(() => {
          codeViewer.dispose();
        }).not.toThrow();
      }
    });
  });
});

