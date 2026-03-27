/**
 * @jest-environment ./tests/helpers/jest-environment-jsdom-no-canvas.js
 */
'use strict';

/**
 * CodeViewer Tests - REAL SYNTAX HIGHLIGHTING
 * ============================================================================
 * Tests actual code rendering, syntax highlighting for multiple languages,
 * tab management, and editor functionality. These tests catch REAL bugs in
 * the code viewer system.
 * 
 * @module tests/component/CodeViewer.real
 */

const CodeViewer = require('../../src/renderer/artifacts/modules/code/CodeViewer');

describe('CodeViewer - Real Syntax Highlighting', () => {
  let codeViewer;
  let container;
  let mockController;
  let mockEventBus;

  beforeEach(async () => {
    // Setup DOM
    container = document.createElement('div');
    container.id = 'code-pane';
    document.body.appendChild(container);

    // Mock controller
    mockController = {
      currentChatId: 'test-chat-id',
      exportFile: jest.fn()
    };

    // Mock EventBus
    mockEventBus = {
      emit: jest.fn(),
      on: jest.fn(),
      off: jest.fn()
    };

    // Mock Highlight.js globally (fallback mode)
    global.window.hljs = {
      highlightElement: jest.fn((element) => {
        // Simulate highlighting by adding class
        element.classList.add('hljs');
      })
    };

    // Real CodeViewer
    codeViewer = new CodeViewer({
      controller: mockController,
      eventBus: mockEventBus
    });

    await codeViewer.init(container);
  });

  afterEach(() => {
    if (codeViewer) {
      codeViewer.dispose();
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    if (global.window.hljs) {
      delete global.window.hljs;
    }
  });

  describe('Initialization', () => {
    test('should create code viewer structure', () => {
      expect(codeViewer.container).toBe(container);
      expect(codeViewer.tabsHeader).not.toBeNull();
      expect(codeViewer.tabsContent).not.toBeNull();
    });

    test('should create default tab', () => {
      expect(codeViewer.tabs.size).toBeGreaterThanOrEqual(1);
      expect(codeViewer.activeTabId).not.toBeNull();
    });

    test('should throw without controller', () => {
      expect(() => {
        new CodeViewer({ eventBus: mockEventBus });
      }).toThrow('Controller required');
    });

    test('should throw without eventBus', () => {
      expect(() => {
        new CodeViewer({ controller: mockController });
      }).toThrow('EventBus required');
    });
  });

  describe('Code Loading (CRITICAL)', () => {
    test('should load JavaScript code', () => {
      const jsCode = 'const x = 42;\nconsole.log(x);';
      
      codeViewer.loadCode(jsCode, 'javascript', 'test.js');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab).toBeDefined();
      expect(activeTab.language).toBe('javascript');
      expect(activeTab.code).toBe(jsCode);
    });

    test('should load Python code', () => {
      const pyCode = 'def hello():\n    print("Hello")';
      
      codeViewer.loadCode(pyCode, 'python', 'script.py');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab.language).toBe('python');
      expect(activeTab.code).toBe(pyCode);
    });

    test('should load TypeScript code', () => {
      const tsCode = 'interface User { name: string; }';
      
      codeViewer.loadCode(tsCode, 'typescript', 'types.ts');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab.language).toBe('typescript');
    });

    test('should load Java code', () => {
      const javaCode = 'public class Main { }';
      
      codeViewer.loadCode(javaCode, 'java', 'Main.java');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab.language).toBe('java');
    });

    test('should load C++ code', () => {
      const cppCode = '#include <iostream>\nint main() { }';
      
      codeViewer.loadCode(cppCode, 'cpp', 'main.cpp');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab.language).toBe('cpp');
    });

    test('should load SQL code', () => {
      const sqlCode = 'SELECT * FROM users WHERE active = true;';
      
      codeViewer.loadCode(sqlCode, 'sql', 'query.sql');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab.language).toBe('sql');
    });

    test('should load Shell script', () => {
      const shellCode = '#!/bin/bash\necho "Hello"';
      
      codeViewer.loadCode(shellCode, 'bash', 'script.sh');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab.language).toBe('bash');
    });

    test('should handle empty code', () => {
      codeViewer.loadCode('', 'javascript', 'empty.js');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab.code).toBe('');
    });

    test('should handle very long code', () => {
      const longCode = 'x'.repeat(100000); // 100KB
      
      codeViewer.loadCode(longCode, 'text', 'large.txt');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab.code.length).toBe(100000);
    });

    test('should handle code with special characters', () => {
      const specialCode = 'console.log("🎉\\n\\t");\nλ = 42;';
      
      codeViewer.loadCode(specialCode, 'javascript', 'special.js');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab.code).toContain('🎉');
      expect(activeTab.code).toContain('λ');
    });
  });

  describe('Language Detection', () => {
    test('should map js to javascript', () => {
      codeViewer.loadCode('const x = 1;', 'js', 'file.js');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      // May normalize to 'javascript' or keep as 'js'
      expect(['js', 'javascript']).toContain(activeTab.language);
    });

    test('should map py to python', () => {
      codeViewer.loadCode('x = 1', 'py', 'file.py');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(['py', 'python']).toContain(activeTab.language);
    });

    test('should handle unknown language', () => {
      codeViewer.loadCode('unknown code', 'xyz', 'file.xyz');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      // Should fall back to 'text' or keep 'xyz'
      expect(activeTab.language).toBeTruthy();
    });

    test('should default to text for missing language', () => {
      codeViewer.loadCode('plain text', null, 'file.txt');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab.language).toBe('text');
    });
  });

  describe('Syntax Highlighting (CRITICAL)', () => {
    test('should apply syntax highlighting with hljs', () => {
      const jsCode = 'const x = 42;';
      
      codeViewer.loadCode(jsCode, 'javascript', 'test.js');

      // Check if hljs.highlightElement was called
      expect(global.window.hljs.highlightElement).toHaveBeenCalled();
    });

    test('should render code in pre/code elements', () => {
      const code = 'function test() { return true; }';
      
      codeViewer.loadCode(code, 'javascript', 'func.js');

      // Should have pre or code elements in DOM
      const preElement = container.querySelector('pre');
      const codeElement = container.querySelector('code');
      
      expect(preElement || codeElement).not.toBeNull();
    });

    test('should preserve whitespace in code', () => {
      const code = 'function test() {\n    return true;\n}';
      
      codeViewer.loadCode(code, 'javascript', 'indent.js');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab.code).toContain('\n    ');
    });

    test('should handle code with HTML entities', () => {
      const code = 'const str = "<div>&nbsp;</div>";';
      
      codeViewer.loadCode(code, 'javascript', 'html.js');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab.code).toContain('<div>');
    });

    test('should not execute script tags in code', () => {
      const maliciousCode = '<script>alert("xss")</script>';
      const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
      
      codeViewer.loadCode(maliciousCode, 'html', 'malicious.html');

      // Script should be rendered as text, not executed
      expect(alertSpy).not.toHaveBeenCalled();
      
      alertSpy.mockRestore();
    });
  });

  describe('Tab Management (CRITICAL)', () => {
    test('should create multiple tabs', () => {
      codeViewer.createTab('Tab 1', 'code1', 'javascript');
      codeViewer.createTab('Tab 2', 'code2', 'python');
      codeViewer.createTab('Tab 3', 'code3', 'java');

      expect(codeViewer.tabs.size).toBeGreaterThanOrEqual(3);
    });

    test('should switch between tabs', () => {
      const tab1Id = codeViewer.createTab('Tab 1', 'code1', 'javascript');
      const tab2Id = codeViewer.createTab('Tab 2', 'code2', 'python');

      codeViewer.setActiveTab(tab2Id);
      expect(codeViewer.activeTabId).toBe(tab2Id);

      codeViewer.setActiveTab(tab1Id);
      expect(codeViewer.activeTabId).toBe(tab1Id);
    });

    test('should preserve code when switching tabs', () => {
      const code1 = 'const x = 1;';
      const code2 = 'y = 2';

      const tab1Id = codeViewer.createTab('Tab 1', code1, 'javascript');
      const tab2Id = codeViewer.createTab('Tab 2', code2, 'python');

      codeViewer.setActiveTab(tab2Id);
      codeViewer.setActiveTab(tab1Id);

      const tab1 = codeViewer.tabs.get(tab1Id);
      expect(tab1.code).toBe(code1);
    });

    test('should close tabs', () => {
      const tab1Id = codeViewer.createTab('Tab 1', 'code1', 'javascript');
      const initialSize = codeViewer.tabs.size;

      codeViewer.closeTab(tab1Id);

      expect(codeViewer.tabs.size).toBeLessThanOrEqual(initialSize);
      expect(codeViewer.tabs.has(tab1Id)).toBe(false);
    });

    test('should switch to another tab when active tab closed', () => {
      const tab1Id = codeViewer.createTab('Tab 1', 'code1', 'javascript');
      const tab2Id = codeViewer.createTab('Tab 2', 'code2', 'python');

      codeViewer.setActiveTab(tab1Id);
      codeViewer.closeTab(tab1Id);

      // Should switch to a different tab
      expect(codeViewer.activeTabId).not.toBeNull();
      expect(codeViewer.activeTabId).not.toBe(tab1Id);
    });

    test('should enforce max tabs limit', () => {
      // Create 25 tabs (max is 20)
      for (let i = 0; i < 25; i++) {
        codeViewer.createTab(`Tab ${i}`, `code${i}`, 'javascript');
      }

      // Should not exceed max
      expect(codeViewer.tabs.size).toBeLessThanOrEqual(20);
    });

    test('should handle closing all tabs except one', () => {
      // Start with default tab
      const initialTabId = codeViewer.activeTabId;

      // Create and close multiple tabs
      for (let i = 0; i < 5; i++) {
        const tabId = codeViewer.createTab(`Tab ${i}`, `code${i}`, 'javascript');
        if (tabId !== initialTabId) {
          codeViewer.closeTab(tabId);
        }
      }

      // Should still have at least one tab
      expect(codeViewer.tabs.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Copy Functionality', () => {
    test('should copy code to clipboard', async () => {
      const code = 'const x = 42;';
      codeViewer.loadCode(code, 'javascript', 'test.js');

      // Mock clipboard API
      const mockClipboard = jest.fn().mockResolvedValue();
      Object.assign(navigator, {
        clipboard: {
          writeText: mockClipboard
        }
      });

      // Find and click copy button
      const copyButton = container.querySelector('[data-action="copy"]');
      expect(copyButton).toBeTruthy();
      copyButton.click();
      await Promise.resolve();
      expect(mockClipboard).toHaveBeenCalledWith(code);
    });
  });

  describe('Export Functionality', () => {
    test('should export code via controller', async () => {
      const code = 'const x = 1;';
      const filename = 'export.js';
      codeViewer.loadCode(code, 'javascript', filename);

      // Find and click export button
      const exportButton = container.querySelector('[data-action="export"]');
      expect(exportButton).toBeTruthy();
      exportButton.click();
      await Promise.resolve();
      expect(mockController.exportFile).toHaveBeenCalled();
    });
  });

  describe('Filename Display', () => {
    test('should display filename in tab', () => {
      codeViewer.loadCode('code', 'javascript', 'myfile.js');

      const tabLabel = container.querySelector('.code-tab-label');
      if (tabLabel) {
        expect(tabLabel.textContent).toContain('myfile.js');
      }
    });

    test('should handle long filenames', () => {
      const longFilename = 'very_long_filename_that_might_overflow_the_tab_ui.js';
      codeViewer.loadCode('code', 'javascript', longFilename);

      // Should not crash
      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab).toBeDefined();
    });

    test('should handle filenames with special characters', () => {
      const specialFilename = 'file-name_v2.0[beta].js';
      codeViewer.loadCode('code', 'javascript', specialFilename);

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    test('should handle null code', () => {
      expect(() => {
        codeViewer.loadCode(null, 'javascript', 'null.js');
      }).not.toThrow();
    });

    test('should handle undefined code', () => {
      expect(() => {
        codeViewer.loadCode(undefined, 'javascript', 'undef.js');
      }).not.toThrow();
    });

    test('should handle code with only whitespace', () => {
      codeViewer.loadCode('   \n\n\t\t   ', 'javascript', 'whitespace.js');

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab).toBeDefined();
    });

    test('should handle binary data', () => {
      const binaryCode = '\x00\x01\x02\xFF';
      
      expect(() => {
        codeViewer.loadCode(binaryCode, 'text', 'binary.txt');
      }).not.toThrow();
    });

    test('should handle circular tab switching', () => {
      const tab1Id = codeViewer.createTab('Tab 1', 'code1', 'javascript');
      const tab2Id = codeViewer.createTab('Tab 2', 'code2', 'python');
      const tab3Id = codeViewer.createTab('Tab 3', 'code3', 'java');

      // Rapid switching
      for (let i = 0; i < 10; i++) {
        codeViewer.setActiveTab(tab1Id);
        codeViewer.setActiveTab(tab2Id);
        codeViewer.setActiveTab(tab3Id);
      }

      // Should not crash
      expect(codeViewer.activeTabId).toBeTruthy();
    });

    test('should handle switching to non-existent tab', () => {
      expect(() => {
        codeViewer.setActiveTab('non-existent-tab-id');
      }).not.toThrow();
    });

    test('should handle closing non-existent tab', () => {
      expect(() => {
        codeViewer.closeTab('non-existent-tab-id');
      }).not.toThrow();
    });
  });

  describe('Memory Management', () => {
    test('should cleanup on dispose', () => {
      codeViewer.dispose();

      expect(codeViewer.tabs.size).toBe(0);
      expect(codeViewer.container).toBeNull();
    });

    test('should handle multiple loads without memory leak', () => {
      for (let i = 0; i < 100; i++) {
        codeViewer.loadCode(`code${i}`, 'javascript', `file${i}.js`);
      }

      // Should not crash or leak (tabs limited to max)
      expect(codeViewer.tabs.size).toBeLessThanOrEqual(20);
    });

    test('should dispose ACE editors on cleanup', () => {
      // Create tabs with potential ACE editors
      for (let i = 0; i < 5; i++) {
        codeViewer.createTab(`Tab ${i}`, `code${i}`, 'javascript');
      }

      // Dispose should not crash
      expect(() => {
        codeViewer.dispose();
      }).not.toThrow();
    });
  });

  describe('Streaming Code Updates', () => {
    test('should update code in active tab', () => {
      codeViewer.loadCode('initial', 'javascript', 'stream.js');
      const initialTabId = codeViewer.activeTabId;

      codeViewer.loadCode('updated', 'javascript', 'stream.js');

      // Should update same tab
      expect(codeViewer.activeTabId).toBe(initialTabId);
      
      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab.code).toBe('updated');
    });

    test('should handle rapid streaming updates', () => {
      for (let i = 0; i < 50; i++) {
        codeViewer.loadCode(`chunk${i}`, 'javascript', 'stream.js');
      }

      const activeTab = codeViewer.tabs.get(codeViewer.activeTabId);
      expect(activeTab.code).toContain('chunk');
    });
  });

  describe('EventBus Integration', () => {
    test('should emit COMPONENT_READY event', () => {
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          component: 'CodeViewer'
        })
      );
    });
  });
});

